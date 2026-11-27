/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { collectFailingDescendants, describeFailingBelow, describeTicketFailure, detectTicketFailure, formatTicketLastRunRecord, isFailedRunStatus, isFailingResultValue, parseTicketLastRunRecord, parseWorkflowRunsHead, readTestResultField, ticketLastRunRecordFromSteps } from '../../common/ticketFailure.js';
import { ITicketSubtreeNode, ITicketSubtreeSummary } from '../../common/ticketSubtreeCount.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';

function n(label: string, category: CanonicalStatusCategory | undefined, children: ITicketSubtreeNode[] = [], failing?: string, removed = false): ITicketSubtreeNode {
	return { label, category, removed, children, failure: failing ? { reasons: [failing] } : undefined };
}

suite('ticketFailure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const none = new Set<CanonicalStatusCategory>();

	test('result field: indented Self Defined Data entries only, labels from the explicit list', () => {
		const md = [
			'- **Status**: Done',
			'### Self Defined Data (If any)',
			'- **Self Defined Data Value**:',
			'  - **Test Type**: Manual',
			'  - **Result**: "Fail"',
			'  - **Notes**: the Result was Fail'
		].join('\n');
		assert.deepStrictEqual(readTestResultField(md), { label: 'Result', value: 'Fail' });
		assert.deepStrictEqual(readTestResultField('  - **Test Result**: Failed\n'), { label: 'Test Result', value: 'Failed' });
		assert.strictEqual(readTestResultField('- **Result**: Fail\n'), undefined, 'top-level lines are not custom fields');
		assert.strictEqual(readTestResultField('  - **Results Summary**: Fail\n'), undefined);
		assert.deepStrictEqual(readTestResultField('\t- **result**: pass\r\n'), { label: 'Result', value: 'pass' });
	});

	test('failing values and statuses are case-insensitive', () => {
		assert.ok(isFailingResultValue('Fail'));
		assert.ok(isFailingResultValue('FAILED'));
		assert.ok(isFailingResultValue(' failure '));
		assert.ok(!isFailingResultValue('Pass'));
		assert.ok(!isFailingResultValue('Not Run'));
		assert.ok(!isFailingResultValue('Blocked'));
		assert.ok(!isFailingResultValue(undefined));
		assert.ok(isFailedRunStatus('Failed'));
		assert.ok(isFailedRunStatus(' failed'));
		assert.ok(!isFailedRunStatus('Completed'));
		assert.ok(!isFailedRunStatus('Todo'));
	});

	test('last run record: round trip, from step results, invalid input', () => {
		const at = new Date(2026, 10, 27, 17, 30, 5);
		const failed = ticketLastRunRecordFromSteps([
			{ status: 'success', fieldLabel: 'Fetch' },
			{ status: 'failed', fieldLabel: 'Git Push', error: 'remote rejected' },
			{ status: 'failed', fieldLabel: 'Later' }
		], at);
		assert.deepStrictEqual(failed, { status: 'Failed', at: at.toISOString(), failedStep: 'Git Push', error: 'remote rejected' });
		assert.deepStrictEqual(parseTicketLastRunRecord(formatTicketLastRunRecord(failed)), failed);
		assert.deepStrictEqual(ticketLastRunRecordFromSteps([{ status: 'success' }, { status: 'skipped' }], at), { status: 'Completed', at: at.toISOString() });
		assert.strictEqual(parseTicketLastRunRecord('{"status":"Weird","at":"x"}'), undefined);
		assert.strictEqual(parseTicketLastRunRecord('not json'), undefined);
		assert.strictEqual(parseTicketLastRunRecord(undefined), undefined);
	});

	test('workflow_runs.json head: newest run, top-level keys only', () => {
		const head = JSON.stringify([
			{ runId: 'r2', runNumber: 2, status: 'failed', startedAt: 100, updatedAt: 200, contextVariables: { status: 'completed' }, nodeStates: {} },
			{ runId: 'r1', runNumber: 1, status: 'completed', startedAt: 50 }
		], undefined, 2).slice(0, 4096);
		assert.deepStrictEqual(parseWorkflowRunsHead(head), { status: 'failed', runNumber: 2, at: 200 });
		const nestedFirst = '[{"runId":"r","contextVariables":{"status":"failed"},"status":"completed"}]';
		assert.strictEqual(parseWorkflowRunsHead(nestedFirst), undefined, 'a status inside a nested object is not the run status');
		assert.strictEqual(parseWorkflowRunsHead('[]'), undefined);
		assert.strictEqual(parseWorkflowRunsHead('{"status":"failed"}'), undefined);
	});

	test('detectTicketFailure: run, workflow and test result reasons; removed never fails', () => {
		const at = new Date(2026, 10, 27, 17, 30).toISOString();
		const run = detectTicketFailure({ status: 'Failed', removed: false, lastRun: { status: 'Failed', at, failedStep: 'Git Push' } });
		assert.deepStrictEqual(run, { reasons: [`Last run failed 2026-11-27 17:30 — component 'Git Push' failed`] });
		assert.deepStrictEqual(detectTicketFailure({ status: 'Failed', removed: false }), { reasons: ['Last run failed (Status: Failed)'] });
		// a later successful run rewrites Status to Completed: no failure even with an old record around
		assert.strictEqual(detectTicketFailure({ status: 'Completed', removed: false, lastRun: { status: 'Failed', at } }), undefined);
		assert.deepStrictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value: 'Fail' } }), { reasons: ['Test result: Fail'] });
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value: 'Pass' } }), undefined);
		assert.deepStrictEqual(detectTicketFailure({ removed: false, workflowRun: { status: 'failed', runNumber: 3 } }), { reasons: ['Last workflow run #3 failed'] });
		assert.strictEqual(detectTicketFailure({ removed: false, workflowRun: { status: 'completed' } }), undefined);
		assert.strictEqual(detectTicketFailure({ status: 'Removed', removed: true, resultField: { label: 'Result', value: 'Fail' } }), undefined);
		assert.strictEqual(describeTicketFailure({ reasons: ['A', 'B'] }), 'Failing:\n• A\n• B');
	});

	test('propagation: all levels, regardless of the status filter (flagged), removed sub-trees skipped', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [
				n('T-1 Epic', 'In Progress', [
					n('T-2 Story', 'Done', [n('T-3 Test', 'Done', [], 'Test result: Fail')]),
					n('T-4 Task', 'Todo', [], 'Last run failed')
				]),
				n('T-5 Gone', 'Removed', [n('T-6 Child', 'Todo', [], 'Test result: Fail')], undefined, true)
			]
		};
		const all = collectFailingDescendants(summary, none, false);
		assert.deepStrictEqual(all.failing.map(f => [f.label, f.hiddenByFilter]), [['T-3 Test', false], ['T-4 Task', false]]);
		// Done hidden: T-3 still propagates, flagged as hidden (its parent T-2 is Done too)
		const doneHidden = collectFailingDescendants(summary, new Set(['Done']), false);
		assert.deepStrictEqual(doneHidden.failing.map(f => [f.label, f.hiddenByFilter]), [['T-3 Test', true], ['T-4 Task', false]]);
		// show removed items: the removed branch's live child counts again
		assert.strictEqual(collectFailingDescendants(summary, none, true).failing.length, 3);
		// a sub-summary (T-2's own children) sees only its descendants
		assert.deepStrictEqual(collectFailingDescendants({ truncated: false, children: summary.children[0].children[0].children }, none, false).failing.map(f => f.label), ['T-3 Test']);
		assert.strictEqual(collectFailingDescendants({ truncated: false, children: [n('A', 'Todo')] }, none, false).failing.length, 0);
	});

	test('tooltip: count, first reason, hidden note, capped list', () => {
		assert.strictEqual(describeFailingBelow({ failing: [] }), undefined);
		assert.strictEqual(
			describeFailingBelow({ failing: [{ label: 'ANYAG-0123 Login', reasons: ['Test result: Fail'], hiddenByFilter: true }] }),
			'1 failing below:\n• ANYAG-0123 Login — Test result: Fail (hidden by status filter)'
		);
		const many = { failing: Array.from({ length: 7 }, (_, i) => ({ label: `T-${i}`, reasons: ['x'], hiddenByFilter: false })) };
		const text = describeFailingBelow(many)!;
		assert.ok(text.startsWith('7 failing below:\n'));
		assert.ok(text.includes('• T-4 — x'));
		assert.ok(!text.includes('T-5'));
		assert.ok(text.endsWith('… and 2 more'));
	});
});
