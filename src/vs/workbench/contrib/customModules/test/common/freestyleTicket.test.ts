/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomModule } from '../../../entityPersistence/common/entityPersistence.js';
import {
	FREESTYLE_PROGRAMMATIC_CREATE_ERROR,
	FREESTYLE_TICKET_TYPE,
	createDefaultFreestyleSchema,
	isLegacyFreestyleDesignerModuleId,
	getFreestyleSchemaUri,
	getProgrammaticTicketTypeError,
	getReservedFreestyleTemplateNameError,
	isFreestyleTicketType,
	isReservedFreestyleName,
	isReservedFreestyleTemplate,
	normalizeReservedTypeName,
	normalizeFreestyleSchema,
	parseFreestyleSchema,
	serializeFreestyleSchema
} from '../../common/freestyleTicket.js';

suite('freestyleTicket', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes the freestyle type case-insensitively', () => {
		assert.strictEqual(isFreestyleTicketType('freestyle'), true);
		assert.strictEqual(isFreestyleTicketType(' Freestyle '), true);
		assert.strictEqual(isFreestyleTicketType('task'), false);
		assert.strictEqual(isFreestyleTicketType(undefined), false);
	});

	test('stores the structure inside the ticket folder', () => {
		const ticketUri = URI.file('/ws/NEOWO-0007');
		assert.strictEqual(getFreestyleSchemaUri(ticketUri).path, '/ws/NEOWO-0007/.agents/freestyle_schema.json');
		assert.strictEqual(isLegacyFreestyleDesignerModuleId(`freestyle-ticket::${ticketUri.toString()}`), true);
		assert.strictEqual(isLegacyFreestyleDesignerModuleId('bug'), false);
	});

	test('default structure has a Title and a Description', () => {
		const mod = createDefaultFreestyleSchema();
		assert.strictEqual(mod.id, FREESTYLE_TICKET_TYPE);
		assert.deepStrictEqual(mod.fields?.map(f => [f.id, f.type]), [['title', 'text'], ['description', 'textarea']]);
	});

	test('serialize / parse round-trips components, including multi-line code', () => {
		const mod = createDefaultFreestyleSchema();
		mod.fields!.push({ id: 'python_1', label: 'Script', type: 'python', pythonCode: 'print("a: b")\n# done\n' });
		const parsed = parseFreestyleSchema(serializeFreestyleSchema(mod));
		assert.ok(parsed);
		assert.deepStrictEqual(parsed.fields?.map(f => f.id), ['title', 'description', 'python_1']);
		assert.strictEqual(parsed.fields?.[2].pythonCode, 'print("a: b")\n# done\n');
	});

	test('serialize drops runtime-only component state', () => {
		const mod = createDefaultFreestyleSchema();
		mod.fields!.push({ id: 'python_1', label: 'Script', type: 'python', pythonOutput: 'out', debugPromptOutput: 'x' });
		const text = serializeFreestyleSchema(mod);
		assert.ok(!text.includes('pythonOutput'));
		assert.ok(!text.includes('debugPromptOutput'));
	});

	test('normalize forces identity, puts Title first and de-duplicates ids', () => {
		const raw = {
			id: 'something-else',
			name: 'Other',
			storageScope: 'global',
			fields: [
				{ id: 'notes', label: 'Notes', type: 'textarea' },
				{ id: 'title', label: 'Title', type: 'text' },
				{ id: 'notes', label: 'Notes 2', type: 'text' },
				'not a component',
				{ id: 'no_type', label: 'Broken' }
			]
		};
		const mod = normalizeFreestyleSchema(raw) as ICustomModule;
		assert.strictEqual(mod.id, FREESTYLE_TICKET_TYPE);
		assert.strictEqual(mod.storageScope, undefined);
		assert.deepStrictEqual(mod.fields?.map(f => f.id), ['title', 'notes', 'notes_2']);
	});

	test('normalize adds a Title when the structure has none (e.g. user removed everything)', () => {
		const mod = normalizeFreestyleSchema({ fields: [] }) as ICustomModule;
		assert.deepStrictEqual(mod.fields?.map(f => f.id), ['title']);
	});

	test('invalid content is rejected', () => {
		assert.strictEqual(parseFreestyleSchema('not json'), undefined);
		assert.strictEqual(parseFreestyleSchema('[1, 2]'), undefined);
		assert.strictEqual(parseFreestyleSchema('{"id": "x"}'), undefined);
	});

	test('legacy component types are renamed', () => {
		const mod = normalizeFreestyleSchema({ fields: [{ id: 'r', label: 'Output', type: 'result' }] }) as ICustomModule;
		assert.strictEqual(mod.fields?.[1].type, 'output');
	});

	test('reserved name matching ignores case, spaces, hyphens and underscores', () => {
		for (const value of ['freestyle', 'Freestyle', 'FREESTYLE', 'Free Style', 'free-style', 'free_style', ' Free - Style ', 'FREE__STYLE', 'free\tstyle']) {
			assert.strictEqual(isReservedFreestyleName(value), true, value);
			assert.strictEqual(isFreestyleTicketType(value), true, value);
		}
		for (const value of ['freestyles', 'free style 2', 'free.style', 'style', 'task', '', undefined, null]) {
			assert.strictEqual(isReservedFreestyleName(value), false, String(value));
		}
		assert.strictEqual(normalizeReservedTypeName('Free - Style_X'), 'freestylex');
	});

	test('a template is reserved when its id or its name matches', () => {
		assert.strictEqual(isReservedFreestyleTemplate({ id: 'free-style', name: 'My Template' }), true);
		assert.strictEqual(isReservedFreestyleTemplate({ id: 'my_template', name: 'Free Style' }), true);
		assert.strictEqual(isReservedFreestyleTemplate({ id: 'bug', name: 'Bug' }), false);
		assert.strictEqual(isReservedFreestyleTemplate(undefined), false);
	});

	test('creating or renaming a template to the reserved name is refused', () => {
		assert.ok(getReservedFreestyleTemplateNameError({ id: 'freestyle', name: 'Freestyle' })?.includes('"Freestyle" is reserved'));
		assert.ok(getReservedFreestyleTemplateNameError({ id: 'custom', name: 'FREE_STYLE' })?.includes('"FREE_STYLE"'));
		assert.ok(getReservedFreestyleTemplateNameError({ id: 'free-style', name: 'Something' })?.includes('"free-style"'));
		// Renaming an existing template into the reserved name
		assert.ok(getReservedFreestyleTemplateNameError({ id: 'bug', name: 'Free Style' }, { id: 'bug', name: 'Bug' }));
		// Normal names are fine
		assert.strictEqual(getReservedFreestyleTemplateNameError({ id: 'bug', name: 'Bug' }), undefined);
		assert.strictEqual(getReservedFreestyleTemplateNameError({ id: 'bug', name: 'Bug Fix' }, { id: 'bug', name: 'Bug' }), undefined);
	});

	test('a legacy template that already uses the reserved name can still be saved unchanged', () => {
		assert.strictEqual(getReservedFreestyleTemplateNameError({ id: 'free-style', name: 'Free Style' }, { id: 'Free-Style', name: 'Free Style' }), undefined);
		// ...but not renamed to another reserved spelling
		assert.ok(getReservedFreestyleTemplateNameError({ id: 'free-style', name: 'FREESTYLE' }, { id: 'free-style', name: 'Free Style' }));
	});

	test('programmatic ticket creation refuses the Freestyle type', () => {
		assert.strictEqual(getProgrammaticTicketTypeError('Freestyle'), FREESTYLE_PROGRAMMATIC_CREATE_ERROR);
		assert.strictEqual(getProgrammaticTicketTypeError('free-style'), FREESTYLE_PROGRAMMATIC_CREATE_ERROR);
		assert.strictEqual(getProgrammaticTicketTypeError('Task'), undefined);
		assert.strictEqual(getProgrammaticTicketTypeError(undefined), undefined);
	});
});
