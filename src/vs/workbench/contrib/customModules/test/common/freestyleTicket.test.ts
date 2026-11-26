/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomModule } from '../../../entityPersistence/common/entityPersistence.js';
import {
	FREESTYLE_TICKET_TYPE,
	createDefaultFreestyleSchema,
	getFreestyleDesignerModuleId,
	getFreestyleSchemaUri,
	isFreestyleTicketType,
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
		assert.ok(getFreestyleDesignerModuleId(ticketUri).endsWith(ticketUri.toString()));
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
});
