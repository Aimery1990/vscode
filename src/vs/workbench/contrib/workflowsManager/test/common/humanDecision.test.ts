/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getComponentSpec } from '../../../customModules/common/componentRegistry.js';
import {
	BUTTON_GROUP_OUTPUT_FIELDS, IHumanDecision, PendingHumanDecisions, buildHumanDecision, describeDecisionPrompt, matchDecisionButton,
	normalizeDecisionButtons, parseButtonGroupValue, publishButtonGroupOutputs, ticketKeyOf
} from '../../common/humanDecision.js';

const BUTTONS = normalizeDecisionButtons([
	{ id: 'btn_ok', label: 'Approve', targetStatus: 'Done' },
	{ id: 'btn_no', label: 'Reject', targetStatus: 'Blocked' },
	{ id: 'btn_later', label: 'Later' }
]);

suite('humanDecision (CI-25)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buttons: defaults and normalization', () => {
		assert.deepStrictEqual(normalizeDecisionButtons(undefined).map(b => b.label), ['Approve', 'Reject']);
		assert.deepStrictEqual(normalizeDecisionButtons([{ id: '', label: ' Go ' }]), [{ id: 'btn_1', label: 'Go' }]);
		assert.strictEqual(BUTTONS[0].targetStatus, 'Done');
		assert.strictEqual(BUTTONS[2].targetStatus, undefined);
	});

	test('matching an input to a button', () => {
		assert.strictEqual(matchDecisionButton(BUTTONS, 'approve')?.id, 'btn_ok');
		assert.strictEqual(matchDecisionButton(BUTTONS, 'btn_no')?.label, 'Reject');
		assert.strictEqual(matchDecisionButton(BUTTONS, { label: 'Later' })?.id, 'btn_later');
		assert.strictEqual(matchDecisionButton(BUTTONS, { buttonId: '', label: 'Reject' })?.id, 'btn_no');
		assert.strictEqual(matchDecisionButton(BUTTONS, { approved: true })?.label, 'Approve');
		assert.strictEqual(matchDecisionButton(BUTTONS, { approved: false })?.label, 'Later');
		assert.strictEqual(matchDecisionButton(BUTTONS, 'Maybe'), undefined);
		assert.strictEqual(matchDecisionButton(BUTTONS, null), undefined);
		assert.strictEqual(matchDecisionButton(BUTTONS, { comment: 'x' }), undefined);
	});

	test('outputs: clicked label plus id / label / at / by', () => {
		const decision = buildHumanDecision(BUTTONS[0], 'User', new Date('2026-11-27T10:00:00.000Z'));
		assert.deepStrictEqual(decision, { buttonId: 'btn_ok', label: 'Approve', at: '2026-11-27T10:00:00.000Z', by: 'User', targetStatus: 'Done' });
		const ctx: Record<string, unknown> = {};
		assert.strictEqual(publishButtonGroupOutputs(ctx, 'Review Step', decision), 'Approve');
		assert.strictEqual(ctx['Review Step'], 'Approve');
		assert.strictEqual(ctx['review_step'], 'Approve');
		assert.strictEqual(ctx['Review Step.id'], 'btn_ok');
		assert.strictEqual(ctx['review_step.by'], 'User');
		assert.strictEqual(ctx['Review Step.at'], '2026-11-27T10:00:00.000Z');
		assert.deepStrictEqual(ctx['review_step_result'], { id: 'btn_ok', label: 'Approve', at: '2026-11-27T10:00:00.000Z', by: 'User' });
		const outputs = getComponentSpec('button_group')!.outputs.map(o => o.name);
		for (const field of BUTTON_GROUP_OUTPUT_FIELDS) {
			assert.ok(outputs.includes(`{Label.${field}}`), field);
		}
		assert.ok(outputs.includes('{var}'));
	});

	test('stored value round trip', () => {
		const decision = buildHumanDecision(BUTTONS[1], 'User');
		assert.deepStrictEqual(parseButtonGroupValue(JSON.stringify(decision)), decision);
		assert.strictEqual(parseButtonGroupValue(''), undefined);
		assert.strictEqual(parseButtonGroupValue('Approve'), undefined);
		assert.strictEqual(parseButtonGroupValue({ label: 'x' }), undefined);
	});

	test('pending decisions: wait, resolve, cancel', async () => {
		let changes = 0;
		const pending = new PendingHumanDecisions(() => changes++);
		const a = pending.add({ fieldId: 'review', fieldLabel: 'Review', buttons: BUTTONS, ticketUri: 'file:///ws/T-1/.agents/ticket.md', ticketId: 'T-1', workflowRunId: 'run1', workflowNodeId: 'n1' });
		const b = pending.add({ fieldId: 'gate', fieldLabel: 'Gate', buttons: BUTTONS, workflowRunId: 'run2', workflowNodeId: 'n2' });
		assert.strictEqual(changes, 2);
		assert.match(a.entry.prompt, /Ticket T-1 is waiting for your decision: Review \(Approve \/ Reject \/ Later\)/);

		// Found from the ticket page (folder URI or ticket id) and from the workflow run
		assert.strictEqual(pending.findForTicketField({ uri: 'file:///ws/T-1' }, { label: 'review' })?.id, a.entry.id);
		assert.strictEqual(pending.findForTicketField({ ticketId: 't-1' }, { id: 'review' })?.id, a.entry.id);
		assert.strictEqual(pending.findForTicketField({ ticketId: 'T-2' }, { id: 'review' }), undefined);
		assert.strictEqual(pending.findForWorkflowRun('run2')?.id, b.entry.id);

		// An input that names no button keeps waiting
		assert.strictEqual(pending.resolve(a.entry.id, 'Maybe'), undefined);
		assert.ok(pending.get(a.entry.id));

		const decided = pending.resolve(a.entry.id, { label: 'Reject' }, 'User');
		assert.strictEqual(decided?.label, 'Reject');
		const result: IHumanDecision | undefined = await a.promise;
		assert.strictEqual(result?.buttonId, 'btn_no');
		assert.strictEqual(result?.targetStatus, 'Blocked');
		assert.strictEqual(pending.get(a.entry.id), undefined);

		pending.cancel(b.entry.id);
		assert.strictEqual(await b.promise, undefined);
		assert.deepStrictEqual(pending.list(), []);
		// Resolving after the end does nothing
		assert.strictEqual(pending.resolve(b.entry.id, 'Approve'), undefined);
	});

	test('prompt text and ticket keys', () => {
		assert.match(describeDecisionPrompt({ fieldId: 'g', fieldLabel: 'Gate', buttons: BUTTONS, workflowNodeLabel: 'Deploy' }), /^Workflow node 'Deploy' is waiting/);
		assert.strictEqual(ticketKeyOf('file:///ws/T-1/.agents/ticket.md'), ticketKeyOf('file:///ws/T-1/'));
		assert.strictEqual(ticketKeyOf('file:///ws/T-1/ticket.md'), 'file:///ws/t-1');
	});
});
