/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WORKFLOW_TICKET_COLOR } from '../../../entityPersistence/common/entityPersistence.js';
import { FREESTYLE_PROGRAMMATIC_CREATE_ERROR, getProgrammaticTicketTypeError, isFreestyleTicketType } from '../../common/freestyleTicket.js';
import { clashesWithSubWorkflowType, getSubWorkflowTemplateClashMessage, getSubWorkflowTicketVisual, isSubWorkflowTicketType } from '../../common/subWorkflowType.js';
import { clashesWithBuiltInTicketType, getTemplateCreateTypeError, getTemplateNameClashError, getTemplateNameClashMessage, isBuiltInTicketTypeName } from '../../common/templateNameClash.js';

suite('subWorkflowType and templateNameClash', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the sub_workflow type matches in every spelling and is not Freestyle', () => {
		for (const value of ['sub_workflow', 'Sub-Workflow', 'SUBWORKFLOW', 'sub workflow', ' Sub_Workflow ']) {
			assert.strictEqual(isSubWorkflowTicketType(value), true, value);
			assert.strictEqual(isBuiltInTicketTypeName(value), true, value);
			assert.strictEqual(isFreestyleTicketType(value), false, value);
		}
		for (const value of ['workflow', 'sub_workflows', 'sub', 'task', '', undefined, null]) {
			assert.strictEqual(isSubWorkflowTicketType(value), false, String(value));
		}
		assert.strictEqual(isBuiltInTicketTypeName('Freestyle'), true);
	});

	test('Sub-Workflow tickets look like workflows with a sub-workflow icon, whatever the spelling', () => {
		for (const value of ['sub_workflow', 'Sub Workflow', 'SUB-WORKFLOW']) {
			assert.deepStrictEqual(getSubWorkflowTicketVisual(value), { color: WORKFLOW_TICKET_COLOR, icon: Codicon.typeHierarchySub }, value);
		}
		for (const value of ['workflow', 'task', '', undefined, null]) {
			assert.strictEqual(getSubWorkflowTicketVisual(value), undefined, String(value));
		}
	});

	test('a template clashes when its id or name spells a built-in type', () => {
		assert.strictEqual(clashesWithSubWorkflowType({ id: 'x', name: 'Sub Workflow' }), true);
		assert.strictEqual(clashesWithSubWorkflowType({ id: 'free-style', name: 'X' }), false);
		assert.strictEqual(clashesWithBuiltInTicketType({ id: 'x', name: 'Sub Workflow' }), true);
		assert.strictEqual(clashesWithBuiltInTicketType({ id: 'free-style', name: 'X' }), true);
		assert.strictEqual(clashesWithBuiltInTicketType({ id: 'bug', name: 'Bug' }), false);
	});

	test('programs and AI may create sub_workflow tickets; only a clashing template is refused', () => {
		assert.strictEqual(getProgrammaticTicketTypeError('sub_workflow'), undefined);
		assert.strictEqual(getProgrammaticTicketTypeError('Sub-Workflow'), undefined);
		assert.ok(getTemplateCreateTypeError({ id: 'sub-workflow', name: 'My Flow' })?.includes('clashes with the built-in sub_workflow ticket type'));
		assert.ok(getTemplateCreateTypeError({ id: 'x', name: 'Sub Workflow' })?.includes('"Sub Workflow"'));
		assert.strictEqual(getTemplateCreateTypeError({ id: 'x', name: 'Freestyle' }), FREESTYLE_PROGRAMMATIC_CREATE_ERROR);
		assert.strictEqual(getTemplateCreateTypeError({ id: 'bug', name: 'Bug' }), undefined);
		assert.strictEqual(getTemplateCreateTypeError(undefined), undefined);
	});

	test('templates may not be created with or renamed to a built-in type name', () => {
		assert.ok(getTemplateNameClashError({ id: 'sub_workflow', name: 'Sub Workflow' })?.includes('clashes with the built-in sub_workflow'));
		assert.ok(getTemplateNameClashError({ id: 'bug', name: 'SubWorkflow' }, { id: 'bug', name: 'Bug' })?.includes('"SubWorkflow"'));
		assert.ok(getTemplateNameClashError({ id: 'freestyle', name: 'Freestyle' })?.includes('"Freestyle" is reserved for Freestyle tickets'));
		assert.strictEqual(getTemplateNameClashError({ id: 'flow', name: 'Flow' }), undefined);
		// A legacy template that already had the clashing identity can still be saved unchanged
		assert.strictEqual(getTemplateNameClashError({ id: 'sub-workflow', name: 'Sub Workflow' }, { id: 'Sub-Workflow', name: 'Sub Workflow' }), undefined);
		assert.ok(getTemplateNameClashMessage('sub-workflow').includes('clashes'));
		assert.ok(getTemplateNameClashMessage('Freestyle').includes('Freestyle tickets'));
		assert.ok(!getSubWorkflowTemplateClashMessage('x').toLowerCase().includes('reserved'));
	});
});
