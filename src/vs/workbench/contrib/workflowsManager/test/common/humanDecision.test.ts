/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getComponentSpec } from '../../../customModules/common/componentRegistry.js';
import {
	BUTTON_GROUP_OUTPUT_FIELDS, DEFAULT_WAITING_PROMPT, IHumanDecision, PendingHumanDecisions, buildHumanDecision, describeDecisionPrompt, matchDecisionButton,
	normalizeDecisionButtons, parseButtonGroupValue, publishButtonGroupOutputs, publishTicketDecisionsToWorkflow, resolveWaitingPrompt, ticketDecisionAliasPrefix, ticketKeyOf
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

	test('ticket run inside a workflow node: decisions published unprefixed and with a ticket alias', () => {
		const approve = buildHumanDecision(BUTTONS[0], 'User', new Date('2026-11-27T10:00:00.000Z'));
		const reject = buildHumanDecision(BUTTONS[1], 'AI', new Date('2026-11-27T11:00:00.000Z'));
		// What a ticket run with a 'Review' gate (step details = decision + buttons) followed by a Python step returns
		const steps = [
			{ fieldLabel: 'Title', fieldType: 'text', status: 'success', details: { value: 'x' } },
			{ fieldLabel: 'Review', fieldType: 'button_group', status: 'success', details: { ...approve, buttons: ['Approve', 'Reject'] } },
			{ fieldLabel: 'Review Result', fieldType: 'python', status: 'success', details: { output: 'Approve' } }
		];
		const ctx: Record<string, unknown> = { 'ANYAG-0121.review': 'Approve', review: 'stale value' };
		assert.deepStrictEqual(publishTicketDecisionsToWorkflow(ctx, 'ANYAG-0121', steps), ['Review']);
		assert.strictEqual(ctx['review'], 'Approve', 'latest decision overwrites an existing unprefixed variable');
		assert.strictEqual(ctx['Review'], 'Approve');
		assert.strictEqual(ctx['Review.by'], 'User');
		assert.deepStrictEqual(ctx['review_result'], { id: 'btn_ok', label: 'Approve', at: '2026-11-27T10:00:00.000Z', by: 'User' });
		assert.strictEqual(ctx['ANYAG_0121_review'], 'Approve');
		assert.deepStrictEqual(ctx['ANYAG_0121_review_result'], ctx['review_result']);
		assert.strictEqual(ctx['ANYAG-0121.review'], 'Approve', 'prefixed variables are kept');

		// A later ticket run deciding the same gate wins; skipped / failed gates and non-decisions publish nothing
		const later = [
			{ fieldLabel: 'Review', fieldType: 'button_group', status: 'success', details: { ...reject } },
			{ fieldLabel: 'Other', fieldType: 'button_group', status: 'failed', details: { ...approve } },
			{ fieldLabel: 'Bad', fieldType: 'button_group', status: 'success', details: { label: 'no button id' } }
		];
		assert.deepStrictEqual(publishTicketDecisionsToWorkflow(ctx, 'ANYAG-0122', later), ['Review']);
		assert.strictEqual(ctx['review'], 'Reject');
		assert.strictEqual(ctx['ANYAG_0122_review'], 'Reject');
		assert.strictEqual(ctx['ANYAG_0121_review'], 'Approve');
		assert.strictEqual(ctx['other'], undefined);
		assert.strictEqual(ctx['bad'], undefined);

		// Without a ticket ID only the unprefixed outputs are published
		const noId: Record<string, unknown> = {};
		assert.deepStrictEqual(publishTicketDecisionsToWorkflow(noId, undefined, steps), ['Review']);
		assert.deepStrictEqual(Object.keys(noId).filter(k => k.includes('ANYAG')), []);
		assert.deepStrictEqual(publishTicketDecisionsToWorkflow(noId, 'X-1', undefined), []);
		assert.strictEqual(ticketDecisionAliasPrefix('ANYAG-0121'), 'ANYAG_0121_');
		assert.strictEqual(ticketDecisionAliasPrefix('9-A'), '_9_A_');
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
		assert.strictEqual(a.entry.prompt, 'Ticket T-1 - Review: Waiting for your decision (Approve / Reject / Later)');
		assert.strictEqual(a.entry.waitingText, 'Waiting for your decision');

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

	test('waiting prompt: default, {variables}, empty after resolution', () => {
		const vars: Record<string, string> = { version: '2.1', empty: '' };
		const resolve = (text: string) => text.replace(/\{([^{}]+)\}/g, (m, k) => vars[k] ?? m);
		assert.strictEqual(resolveWaitingPrompt(undefined), DEFAULT_WAITING_PROMPT);
		assert.strictEqual(resolveWaitingPrompt('   '), 'Waiting for your decision');
		assert.strictEqual(resolveWaitingPrompt('Approve the release of {version}?', resolve), 'Approve the release of 2.1?');
		assert.strictEqual(resolveWaitingPrompt('{missing} ok?', resolve), '{missing} ok?');
		assert.strictEqual(resolveWaitingPrompt('{empty}', resolve), DEFAULT_WAITING_PROMPT);
		const pending = new PendingHumanDecisions();
		const { entry } = pending.add({ fieldId: 'r', fieldLabel: 'Review', buttons: BUTTONS, waitingPrompt: resolveWaitingPrompt('Release {version}?', resolve) });
		assert.strictEqual(entry.waitingText, 'Release 2.1?');
		pending.cancel(entry.id);
	});

	test('stop this run: ends the run, then cancels the wait', async () => {
		const calls: string[] = [];
		const pending = new PendingHumanDecisions();
		const a = pending.add({ fieldId: 'r', fieldLabel: 'Review', buttons: BUTTONS, workflowRunId: 'run1' }, Date.now(), () => calls.push('stop run1'));
		pending.stopRun(a.entry.id);
		assert.deepStrictEqual(calls, ['stop run1']);
		assert.strictEqual(await a.promise, undefined);
		assert.strictEqual(pending.get(a.entry.id), undefined);
		// Without a run to stop (a ticket run on its own) the wait is still cancelled, which fails the step
		const b = pending.add({ fieldId: 'r', fieldLabel: 'Review', buttons: BUTTONS });
		pending.stopRun(b.entry.id);
		assert.strictEqual(await b.promise, undefined);
		// A failing stop callback still cancels the wait
		const c = pending.add({ fieldId: 'r', fieldLabel: 'Review', buttons: BUTTONS }, Date.now(), () => { throw new Error('boom'); });
		assert.throws(() => pending.stopRun(c.entry.id));
		assert.strictEqual(await c.promise, undefined);
	});

	test('prompt text and ticket keys', () => {
		assert.strictEqual(describeDecisionPrompt({ fieldId: 'g', fieldLabel: 'Gate', buttons: BUTTONS, workflowNodeLabel: 'Deploy', waitingPrompt: 'Ship v2?' }), `Workflow node 'Deploy' - Gate: Ship v2? (Approve / Reject / Later)`);
		assert.strictEqual(ticketKeyOf('file:///ws/T-1/.agents/ticket.md'), ticketKeyOf('file:///ws/T-1/'));
		assert.strictEqual(ticketKeyOf('file:///ws/T-1/ticket.md'), 'file:///ws/t-1');
	});
});
