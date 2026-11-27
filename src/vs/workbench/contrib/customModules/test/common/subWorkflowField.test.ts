/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomField } from '../../../entityPersistence/common/entityPersistence.js';
import { applySubWorkflowContractToField, describeSelectedSubWorkflow } from '../../common/subWorkflowField.js';

suite('subWorkflowField (CI-38)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const contract = {
		id: 'FINDJ-0042',
		name: 'Fetch Jobs',
		sourceWorkflowUri: 'file:///ws/findj',
		inputs: [{ name: 'query', defaultValue: 'AI' }, { name: 'limit', defaultValue: '10' }],
		outputs: [{ label: 'Jobs', varName: 'jobs', defaultFormat: 'json' }]
	};

	test('links a card and copies inputs / read-only outputs', () => {
		const field: ICustomField = { id: 'call', label: 'Call', type: 'sub_workflow', subWorkflowId: '', subWorkflowInputs: {} };
		applySubWorkflowContractToField(field, contract);
		assert.strictEqual(field.subWorkflowId, 'FINDJ-0042');
		assert.strictEqual(field.subWorkflowName, 'Fetch Jobs');
		assert.strictEqual(field.subWorkflowSourceUri, 'file:///ws/findj');
		assert.deepStrictEqual(field.subWorkflowInputs, { query: '', limit: '' });
		assert.deepStrictEqual(field.subWorkflowInputDefs, [{ name: 'query', label: undefined, defaultValue: 'AI' }, { name: 'limit', label: undefined, defaultValue: '10' }]);
		assert.deepStrictEqual(field.subWorkflowOutputDefs, [{ label: 'Jobs', varName: 'jobs', defaultFormat: 'json' }]);
		assert.strictEqual(describeSelectedSubWorkflow(field), 'Fetch Jobs (FINDJ-0042)');
	});

	test('refresh keeps bindings of the same sub-workflow; switching drops them', () => {
		const field: ICustomField = { id: 'call', label: 'Call', type: 'sub_workflow', subWorkflowId: 'FINDJ-0042', subWorkflowInputs: { query: '{keyword}', gone: 'x' } };
		applySubWorkflowContractToField(field, contract);
		assert.deepStrictEqual(field.subWorkflowInputs, { query: '{keyword}', limit: '' });
		applySubWorkflowContractToField(field, { ...contract, id: 'FINDJ-0043', name: 'Other' });
		assert.deepStrictEqual(field.subWorkflowInputs, { query: '', limit: '' });
	});

	test('describes an unselected card as undefined', () => {
		assert.strictEqual(describeSelectedSubWorkflow({ subWorkflowId: ' ' }), undefined);
		assert.strictEqual(describeSelectedSubWorkflow({ subWorkflowId: 'SW-1' }), 'SW-1');
	});
});
