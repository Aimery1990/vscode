/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findTemplateField, getTemplateFields, parseTemplateYaml } from '../../common/templateYaml.js';

const TEMPLATE_YAML = [
	'id: job',
	'name: Job',
	'fields:',
	'  - id: number_1',
	'    label: Expected Salary',
	'    type: number',
	'    min: 0',
	'    max: 500000',
	'    precision: 2',
	'  - id: table_1',
	'    label: Candidates (Top 10)',
	'    type: table',
	'    tableDbEngine: none',
	'    tableDbTableName: candidates',
	'    tableColumns:',
	'      - id: col_1',
	'        name: name',
	'        dataType: TEXT',
	'  - id: result_1',
	'    label: Output',
	'    type: result',
	'statuses:',
	'  - id: todo',
	'    label: Todo',
].join('\n');

suite('templateYaml', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseTemplateYaml returns a plain object whose fields can be read', () => {
		const template = parseTemplateYaml(TEMPLATE_YAML);
		const fields = getTemplateFields(template);
		assert.deepStrictEqual(fields.map(f => f.id), ['number_1', 'table_1', 'result_1']);
		assert.deepStrictEqual(
			{ min: fields[0].min, max: fields[0].max, precision: fields[0].precision },
			{ min: 0, max: 500000, precision: 2 }
		);
		assert.strictEqual(fields[1].tableDbEngine, 'none');
		assert.deepStrictEqual(fields[1].tableColumns, [{ id: 'col_1', name: 'name', dataType: 'TEXT' }]);
	});

	test('parseTemplateYaml renames legacy component types', () => {
		const fields = getTemplateFields(parseTemplateYaml(TEMPLATE_YAML));
		assert.strictEqual(fields[2].type, 'output');
	});

	test('getTemplateFields tolerates missing / malformed templates', () => {
		assert.deepStrictEqual(getTemplateFields(null), []);
		assert.deepStrictEqual(getTemplateFields(undefined), []);
		assert.deepStrictEqual(getTemplateFields([]), []);
		assert.deepStrictEqual(getTemplateFields({ fields: 'nope' }), []);
		assert.deepStrictEqual(getTemplateFields(parseTemplateYaml('id: empty')), []);
	});

	test('findTemplateField matches by label first, then id', () => {
		const fields = getTemplateFields(parseTemplateYaml(TEMPLATE_YAML));
		assert.strictEqual(findTemplateField(fields, 'Expected Salary')?.id, 'number_1');
		assert.strictEqual(findTemplateField(fields, 'number_1')?.label, 'Expected Salary');
		assert.strictEqual(findTemplateField(fields, 'expected salary'), undefined);
		assert.strictEqual(findTemplateField(fields, 'expected salary', { ignoreCase: true })?.id, 'number_1');
		assert.strictEqual(findTemplateField(fields, 'TABLE_1', { type: 'table', ignoreCase: true })?.label, 'Candidates (Top 10)');
		assert.strictEqual(findTemplateField(fields, 'Expected Salary', { type: 'table' }), undefined);
		assert.strictEqual(findTemplateField(fields, '  '), undefined);
	});
});
