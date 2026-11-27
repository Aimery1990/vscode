/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractTicketFields, locateTicketFieldSpans, planTicketFieldChange, replaceTicketFieldValues } from '../../common/ticketChangeLog.js';
import {
	formatTicketFieldReference, isExternalizableTicketField, isLongTicketText, LONG_TEXT_MIN_BYTES, parseTicketFieldReference,
	sanitizeTicketFieldKey, shouldExternalizeTicketField, utf8ByteLength
} from '../../common/ticketFieldStore.js';
import {
	applyTicketFieldReferences, collectTicketFieldReferences, planTicketFieldExternalization, resolveTicketFieldReferencesInContent
} from '../../common/ticketFieldReferences.js';

const SHA = 'ab'.repeat(32);
const LONG = 'x'.repeat(LONG_TEXT_MIN_BYTES + 1);

const TICKET_MD = [
	'# T-1', '', '## Overview', '', '- **Workspace ID**: WS-0000', '- **Ticket ID**: WS-0001', '',
	'### Self Defined Data (If any)', '- **Self Defined Data Value**:',
	`  - **Raw Code**: ${LONG}`,
	'  - **Notes**: line one',
	'    continued',
	'',
	'  - **Ticket Labels**: ' + 'y'.repeat(LONG_TEXT_MIN_BYTES + 5),
	'', '- **Status**: Todo', '- **Priority**: Medium', ''
].join('\n');

suite('ticketFieldReferences (CI-51)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reference format: serialize / strict parse', () => {
		const ref = formatTicketFieldReference({ fieldKey: 'raw_code', sha256: SHA.toUpperCase(), chars: 4000 });
		assert.strictEqual(ref, `@file(.agents/fields/raw_code.txt) sha256:${SHA} chars:4000`);
		assert.deepStrictEqual(parseTicketFieldReference(`  ${ref}  `), { path: '.agents/fields/raw_code.txt', fieldKey: 'raw_code', sha256: SHA, chars: 4000 });
		for (const bad of [
			`see @file(.agents/fields/raw_code.txt) sha256:${SHA} chars:4000`,
			`${ref} extra`,
			`@file(.agents/fields/raw_code.txt) sha256:${SHA.slice(1)} chars:4000`,
			`@file(.agents/fields/../secret.txt) sha256:${SHA} chars:4000`,
			`@file(.agents/fields/Raw Code.txt) sha256:${SHA} chars:4000`,
			`@file(.agents/fields/raw_code.txt)  sha256:${SHA} chars:4000`,
			`@file(.agents/fields/raw_code.txt) sha256:${SHA} chars:01`,
			'@file(notes.txt)', 'plain text', ''
		]) {
			assert.strictEqual(parseTicketFieldReference(bad), undefined, bad);
		}
	});

	test('threshold is in UTF-8 bytes and shared with the change log', () => {
		assert.strictEqual(LONG_TEXT_MIN_BYTES, 3072);
		assert.strictEqual(utf8ByteLength('aé你😀'), 1 + 2 + 3 + 4);
		assert.strictEqual(isLongTicketText('a'.repeat(3072)), false);
		assert.strictEqual(isLongTicketText('a'.repeat(3073)), true);
		assert.strictEqual(isLongTicketText('你'.repeat(1024)), false); // 3072 bytes
		assert.strictEqual(isLongTicketText('你'.repeat(1025)), true);
		// change log: short on both sides → inline; one long side → long (blob / diff, with versions)
		const actor = { kind: 'User' as const };
		const at = new Date(2026, 10, 27, 10, 0, 0);
		assert.strictEqual(planTicketFieldChange({ field: 'description', label: 'Description', source: 'README.md', oldValue: 'a', newValue: '你'.repeat(1024) }, actor, at).record.kind, 'inline');
		const long = planTicketFieldChange({ field: 'description', label: 'Description', source: 'README.md', oldValue: 'a', newValue: '你'.repeat(1025) }, actor, at);
		assert.strictEqual(long.record.kind, 'diff');
		assert.ok(long.blobs.new);
	});

	test('which fields are externalized', () => {
		assert.strictEqual(isExternalizableTicketField('title'), false);
		assert.strictEqual(isExternalizableTicketField('status'), false);
		assert.strictEqual(isExternalizableTicketField('description'), true);
		assert.strictEqual(isExternalizableTicketField('ticket_prompt'), true);
		assert.strictEqual(isExternalizableTicketField('custom:Raw Code'), true);
		assert.strictEqual(isExternalizableTicketField('custom:Ticket Labels'), false);
		assert.strictEqual(shouldExternalizeTicketField('title', LONG), false);
		assert.strictEqual(shouldExternalizeTicketField('description', LONG), true);
		assert.strictEqual(shouldExternalizeTicketField('description', 'short'), false);
		assert.strictEqual(shouldExternalizeTicketField('description', formatTicketFieldReference({ fieldKey: 'd', sha256: SHA, chars: 1 })), false);
		assert.strictEqual(sanitizeTicketFieldKey('custom:Description'), 'custom_description');
		assert.strictEqual(sanitizeTicketFieldKey('custom:Raw Code'), 'raw_code');
	});

	test('spans locate exactly the extracted values; replacing round trips', () => {
		const spans = locateTicketFieldSpans('ticket.md', TICKET_MD);
		const extracted = extractTicketFields('ticket.md', TICKET_MD);
		assert.deepStrictEqual(spans.map(s => [s.id, s.value]), [...extracted.values()].map(v => [v.id, v.value]));
		const notes = spans.find(s => s.id === 'custom:Notes')!;
		assert.strictEqual(notes.value, 'line one\n    continued');
		assert.strictEqual(notes.prefix, '  - **Notes**: ');
		assert.strictEqual(notes.endLine - notes.startLine, 2);
		assert.strictEqual(replaceTicketFieldValues('ticket.md', TICKET_MD, () => undefined), TICKET_MD);
		const swapped = replaceTicketFieldValues('ticket.md', TICKET_MD, s => s.id === 'custom:Notes' ? 'REF' : undefined);
		assert.ok(swapped.includes('  - **Notes**: REF\n\n  - **Ticket Labels**'));
		const back = replaceTicketFieldValues('ticket.md', swapped, s => s.id === 'custom:Notes' ? notes.value : undefined);
		assert.strictEqual(back, TICKET_MD);
	});

	test('write splitting plan, references and resolving', () => {
		const claimed = new Map<string, string>([['raw_code', 'README.md:description']]);
		const plan = planTicketFieldExternalization('ticket.md', TICKET_MD, claimed);
		assert.deepStrictEqual(plan.map(p => [p.fieldId, p.fieldKey, p.value.length]), [['custom:Raw Code', 'raw_code_2', LONG.length]]);
		const ref = formatTicketFieldReference({ fieldKey: 'raw_code_2', sha256: SHA, chars: LONG.length });
		const split = applyTicketFieldReferences('ticket.md', TICKET_MD, new Map([['custom:Raw Code', ref]]));
		assert.ok(!split.includes(LONG));
		assert.ok(split.includes(`  - **Raw Code**: ${ref}\n  - **Notes**: line one`));
		assert.deepStrictEqual(collectTicketFieldReferences('ticket.md', split).map(r => [r.fieldId, r.ref.path]), [['custom:Raw Code', '.agents/fields/raw_code_2.txt']]);
		assert.strictEqual(resolveTicketFieldReferencesInContent('ticket.md', split, new Map([['.agents/fields/raw_code_2.txt', LONG]])), TICKET_MD);
		// unknown file: the reference stays
		assert.strictEqual(resolveTicketFieldReferencesInContent('ticket.md', split, new Map()), split);
		// the previous key of a field is reused
		const again = planTicketFieldExternalization('ticket.md', TICKET_MD, new Map(), new Map([['custom:Raw Code', 'raw_code_2']]));
		assert.strictEqual(again[0].fieldKey, 'raw_code_2');
	});

	test('multi-line README description is externalized and restored', () => {
		const desc = Array.from({ length: 200 }, (_, i) => `Line ${i} of the description.`).join('\n');
		const readme = `# T\n\n- **Title**: Hello\n- **Description**: ${desc}\n\n- **Parent Path**: .\n`;
		const plan = planTicketFieldExternalization('README.md', readme, new Map());
		assert.deepStrictEqual(plan.map(p => [p.fieldId, p.fieldKey]), [['description', 'description']]);
		const ref = formatTicketFieldReference({ fieldKey: 'description', sha256: SHA, chars: desc.length });
		const split = applyTicketFieldReferences('README.md', readme, new Map([['description', ref]]));
		assert.strictEqual(split, `# T\n\n- **Title**: Hello\n- **Description**: ${ref}\n\n- **Parent Path**: .\n`);
		assert.strictEqual(resolveTicketFieldReferencesInContent('README.md', split, new Map([['.agents/fields/description.txt', desc]])), readme);
	});
});
