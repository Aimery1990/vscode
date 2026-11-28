/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyTestResult, collectFailingDescendants, countFailing, describeBlockedBelow, describeFailingBelow, describeFailingFraction, describeProblemsBelow, describeTestResult, describeTicketFailure, detectTicketFailure, dismissTicketRunFailure, formatTicketLastRunRecord, isDismissedRunFailure, isFailedRunStatus, isFailingResultValue, lastRunOutcome, parseTicketLastRunRecord, parseWorkflowRunsHead, readTestResultField, ticketLastRunRecordFromSteps } from '../../common/ticketFailure.js';
import { countSubtree, describeChildCountPill, ITicketSubtreeNode, ITicketSubtreeSummary } from '../../common/ticketSubtreeCount.js';
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
		assert.deepStrictEqual(run, { reasons: [`Last run failed (2026-11-27 17:30) — component 'Git Push' failed`], runFailure: true });
		assert.deepStrictEqual(detectTicketFailure({ status: 'Failed', removed: false }), { reasons: ['Last run failed (Status: Failed)'], runFailure: true });
		// CI-58: the last_run.json record is the signal, whatever the status (a failed run may set Blocked, or nothing)
		assert.deepStrictEqual(detectTicketFailure({ status: 'Blocked', removed: false, lastRun: { status: 'Failed', at } }), { reasons: ['Last run failed (2026-11-27 17:30) — the status (Blocked) does not clear it; run again or Clear Failure Mark'], runFailure: true });
		assert.deepStrictEqual(detectTicketFailure({ removed: false, lastRun: { status: 'Failed', at, failedStep: 'Py' } }), { reasons: [`Last run failed (2026-11-27 17:30) — component 'Py' failed`], runFailure: true });
		// a later successful run clears it, also a legacy Status Failed
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, lastRun: { status: 'Completed', at } }), undefined);
		assert.strictEqual(detectTicketFailure({ status: 'Failed', removed: false, lastRun: { status: 'Completed', at } }), undefined);
		assert.deepStrictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value: 'Fail' } }), { reasons: ['Test result: Fail'] });
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value: 'Pass' } }), undefined);
		assert.deepStrictEqual(detectTicketFailure({ removed: false, workflowRun: { status: 'failed', runNumber: 3 } }), { reasons: ['Last workflow run #3 failed'] });
		assert.strictEqual(detectTicketFailure({ removed: false, workflowRun: { status: 'completed' } }), undefined);
		assert.strictEqual(detectTicketFailure({ status: 'Removed', removed: true, resultField: { label: 'Result', value: 'Fail' } }), undefined);
		assert.strictEqual(describeTicketFailure({ reasons: ['A', 'B'] }), 'Failing:\n• A\n• B');
	});

	test('UI-20 rework: the red mark follows the latest run outcome, not the status', () => {
		const at = new Date(2026, 10, 28, 0, 12).toISOString();
		const failedRun = { status: 'Failed' as const, at, failedStep: 'Python' };
		// failed run + manual Done -> still failing, the reason says why and how to clear it
		const done = detectTicketFailure({ status: 'Done', removed: false, lastRun: failedRun });
		assert.deepStrictEqual(done, {
			reasons: [`Last run failed (2026-11-28 00:12) — component 'Python' failed — the status (Done) does not clear it; run again or Clear Failure Mark`],
			runFailure: true
		});
		// any other manual status too (even Completed set by hand)
		assert.ok(detectTicketFailure({ status: 'Todo', removed: false, lastRun: failedRun })?.runFailure);
		assert.ok(detectTicketFailure({ status: 'Completed', removed: false, lastRun: failedRun }));
		assert.ok(detectTicketFailure({ removed: false, lastRun: failedRun }));
		// a later successful run clears it
		const later = new Date(2026, 10, 28, 1, 0);
		assert.strictEqual(detectTicketFailure({ status: 'Completed', removed: false, lastRun: ticketLastRunRecordFromSteps([{ status: 'success' }], later) }), undefined);
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, lastRun: ticketLastRunRecordFromSteps([{ status: 'success' }], later) }), undefined);
		// a dismissal clears it, also the Status Failed written by that run
		const dismissed = dismissTicketRunFailure(failedRun, later);
		assert.deepStrictEqual(dismissed, { ...failedRun, dismissedAt: later.toISOString(), dismissedBy: 'User' });
		assert.ok(isDismissedRunFailure(dismissed));
		assert.deepStrictEqual(parseTicketLastRunRecord(formatTicketLastRunRecord(dismissed)), dismissed);
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, lastRun: dismissed }), undefined);
		assert.strictEqual(detectTicketFailure({ status: 'Failed', removed: false, lastRun: dismissed }), undefined);
		// a new failed run after the dismissal writes a fresh record -> failing again
		const again = ticketLastRunRecordFromSteps([{ status: 'failed', fieldLabel: 'Python', error: 'boom' }], new Date(2026, 10, 28, 2, 0));
		assert.ok(!isDismissedRunFailure(again));
		assert.ok(detectTicketFailure({ status: 'Failed', removed: false, lastRun: again })?.runFailure);
		assert.ok(detectTicketFailure({ status: 'Done', removed: false, lastRun: again })?.runFailure);
		// no record (run before UI-20): dismissing creates a failed record that is already dismissed
		const legacy = dismissTicketRunFailure(undefined, later);
		assert.deepStrictEqual(legacy, { status: 'Failed', at: later.toISOString(), dismissedAt: later.toISOString(), dismissedBy: 'User' });
		assert.strictEqual(detectTicketFailure({ status: 'Failed', removed: false, lastRun: legacy }), undefined);
		// a legacy Status Failed is cleared by a later completed run (CI-58: runs no longer write the Status)
		assert.strictEqual(detectTicketFailure({ status: 'Failed', removed: false, lastRun: { status: 'Completed', at } }), undefined);
		// a Test Case with Result Fail stays red whatever its status, until the Result changes; dismissing a run does not clear it
		const tc = detectTicketFailure({ status: 'Done', removed: false, lastRun: dismissed, resultField: { label: 'Result', value: 'Fail' } });
		assert.deepStrictEqual(tc, { reasons: ['Test result: Fail'] });
		assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value: 'Pass' } }), undefined);
		// removed tickets never fail
		assert.strictEqual(detectTicketFailure({ status: 'Removed', removed: true, lastRun: failedRun }), undefined);
	});

	test('a run stopped by a person (CI-25 Stop this run) is Stopped: not red, no outcome for dependents', () => {
		const at = new Date(2026, 10, 28, 3, 0);
		// the gate's step "failed" because the wait was cancelled, but the person stopped the run
		const steps = [{ status: 'success', fieldLabel: 'Fetch' }, { status: 'failed', fieldLabel: 'Approve', error: `Stopped: the run was stopped while 'Approve' was waiting for a decision.` }];
		const stopped = ticketLastRunRecordFromSteps(steps, at, true);
		assert.deepStrictEqual(stopped, { status: 'Stopped', at: at.toISOString() });
		assert.deepStrictEqual(parseTicketLastRunRecord(formatTicketLastRunRecord(stopped)), stopped);
		assert.strictEqual(ticketLastRunRecordFromSteps(steps, at).status, 'Failed', 'without the stop flag the same steps are a failure');
		assert.strictEqual(detectTicketFailure({ status: 'In Progress', removed: false, lastRun: stopped }), undefined);
		assert.strictEqual(detectTicketFailure({ removed: false, lastRun: stopped }), undefined);
		// dependents: no outcome from a stopped run; Completed / Failed (dismissed or not) map as before
		assert.strictEqual(lastRunOutcome(stopped), undefined);
		assert.strictEqual(lastRunOutcome({ status: 'Completed', at: at.toISOString() }), 'success');
		assert.strictEqual(lastRunOutcome({ status: 'Failed', at: at.toISOString() }), 'failed');
		assert.strictEqual(lastRunOutcome(dismissTicketRunFailure({ status: 'Failed', at: at.toISOString() }, at)), 'failed');
		assert.strictEqual(lastRunOutcome(undefined), undefined);
		// a legacy Status Failed is not cleared by a stop (only a completed run clears it)
		assert.ok(detectTicketFailure({ status: 'Failed', removed: false, lastRun: stopped }));
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

	function b(label: string, children: ITicketSubtreeNode[] = [], failing?: string, status = 'Blocked'): ITicketSubtreeNode {
		return { ...n(label, 'Blocked', children, failing), status };
	}

	test('UI-34: blocked-only sub-tree counts as a problem (not a failure)', () => {
		const summary: ITicketSubtreeSummary = { truncated: false, children: [n('T-1 Epic', 'In Progress', [b('T-2 Waiting', [], undefined, 'Waiting on vendor'), n('T-3 Task', 'Todo')]), n('T-4 Task', 'Done')] };
		const counts = countSubtree(summary, none, false);
		const problems = countFailing(summary, none, false);
		assert.deepStrictEqual(problems, { all: 1, allHidden: 0, direct: 1, directHidden: 0, allBlocked: 1, directBlocked: 1 });
		assert.deepStrictEqual(describeFailingFraction(problems, 'all', counts), { numerator: '1', denominator: '4', summary: '1 with problems of 4 tickets (All Levels): 1 blocked' });
		const collected = collectFailingDescendants(summary, none, false);
		assert.strictEqual(collected.failing.length, 0);
		assert.strictEqual(describeFailingBelow(collected), undefined);
		assert.strictEqual(describeBlockedBelow(collected), '1 blocked below:\n• T-2 Waiting — Status: Waiting on vendor');
		assert.strictEqual(describeProblemsBelow(collected), '1 blocked below:\n• T-2 Waiting — Status: Waiting on vendor');
		// the blocked ticket's own sub-tree: nothing below it is a problem
		assert.strictEqual(countFailing({ truncated: false, children: summary.children[0].children[0].children }, none, false).all, 0);
	});

	test('UI-34: a ticket both failing and blocked counts once (as failing); tooltip split and lists', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [b('T-1 Both', [], 'Last run failed'), b('T-2 Blocked'), n('T-3 Fail', 'Todo', [], 'Test result: Fail'), n('T-4 Ok', 'Todo')]
		};
		const problems = countFailing(summary, none, false);
		assert.deepStrictEqual(problems, { all: 3, allHidden: 0, direct: 3, directHidden: 0, allBlocked: 1, directBlocked: 1 });
		const counts = countSubtree(summary, none, false);
		assert.strictEqual(describeFailingFraction(problems, 'all', counts)!.summary, '3 with problems of 4 tickets (All Levels): 2 failing, 1 blocked');
		const text = describeProblemsBelow(collectFailingDescendants(summary, none, false))!;
		assert.strictEqual(text, '2 failing below:\n• T-1 Both — Last run failed\n• T-3 Fail — Test result: Fail\n\n2 blocked below:\n• T-1 Both — Status: Blocked\n• T-2 Blocked — Status: Blocked');
		// the blocked list is capped like the failing one
		const many = { failing: [], blocked: Array.from({ length: 7 }, (_, i) => ({ label: `B-${i}`, status: 'Blocked', hiddenByFilter: false })) };
		const blockedText = describeBlockedBelow(many)!;
		assert.ok(blockedText.startsWith('7 blocked below:\n'));
		assert.ok(blockedText.includes('B-4') && !blockedText.includes('B-5'));
		assert.ok(blockedText.endsWith('… and 2 more'));
	});

	test('UI-34: blocked tickets hidden by the status filter still count, in the denominator too', () => {
		const blockedHidden = new Set<CanonicalStatusCategory>(['Blocked']);
		const summary: ITicketSubtreeSummary = { truncated: false, children: [n('V1', 'Todo'), n('V2', 'Todo'), b('H1', [b('H2')]), n('F', 'Todo', [], 'x')] };
		const counts = countSubtree(summary, blockedHidden, false);
		assert.strictEqual(counts.visible, 3);
		const problems = countFailing(summary, blockedHidden, false);
		// H1 hidden, H2 hidden through H1: both count
		assert.deepStrictEqual(problems, { all: 3, allHidden: 2, direct: 2, directHidden: 1, allBlocked: 2, directBlocked: 1 });
		assert.deepStrictEqual(describeFailingFraction(problems, 'all', counts), { numerator: '3', denominator: '5', summary: '3 with problems of 5 tickets (All Levels): 1 failing, 2 blocked · 2 of them hidden by the status filter' });
		assert.deepStrictEqual(collectFailingDescendants(summary, blockedHidden, false).blocked!.map(x => [x.label, x.hiddenByFilter]), [['H1', true], ['H2', true]]);
		// every child hidden and blocked: 1/1, never 1/0
		const only: ITicketSubtreeSummary = { truncated: false, children: [b('H')] };
		const f = describeFailingFraction(countFailing(only, blockedHidden, false), 'direct', countSubtree(only, blockedHidden, false))!;
		assert.deepStrictEqual([f.numerator, f.denominator], ['1', '1']);
	});

	test('UI-34: Direct mode counts a child once when it or anything below it has a problem', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [
				n('C-1', 'In Progress', [b('G-1'), n('G-2', 'Todo', [], 'x')]), // failing below: counts as failing
				n('C-2', 'In Progress', [n('G-3', 'Todo', [b('GG-1')])]), // blocked only, two levels down
				n('C-3', 'Todo', [n('G-4', 'Todo')]) // fine
			]
		};
		const problems = countFailing(summary, none, false);
		assert.deepStrictEqual(problems, { all: 3, allHidden: 0, direct: 2, directHidden: 0, allBlocked: 2, directBlocked: 1 });
		const counts = countSubtree(summary, none, false);
		assert.deepStrictEqual(describeFailingFraction(problems, 'direct', counts), { numerator: '2', denominator: '3', summary: '2 with problems of 3 tickets (Direct Children: a child counts when it or a ticket below it fails or is blocked): 1 failing, 1 blocked' });
		assert.strictEqual(describeFailingFraction(problems, 'off', counts), undefined);
	});

	test('UI-34: removed tickets are never problems', () => {
		const removedBlocked: ITicketSubtreeNode = { ...b('R-1'), removed: true };
		const summary: ITicketSubtreeSummary = { truncated: false, children: [removedBlocked, n('R-2', 'Removed', [b('R-3')], undefined, true), n('OK', 'Todo')] };
		assert.deepStrictEqual(countFailing(summary, none, false), { all: 0, allHidden: 0, direct: 0, directHidden: 0, allBlocked: 0, directBlocked: 0 });
		assert.strictEqual(describeProblemsBelow(collectFailingDescendants(summary, none, false)), undefined);
		// "show removed items": the removed ticket itself still does not count, its live blocked child does
		assert.deepStrictEqual(countFailing(summary, none, true), { all: 1, allHidden: 0, direct: 1, directHidden: 0, allBlocked: 1, directBlocked: 1 });
	});

	test('UI-35: a failing ticket below a non-matching ancestor is not hidden by the filter', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [n('T-1 Job', 'Todo', [n('T-2 Story', 'Todo', [n('T-3 Test', 'Done', [], 'Test result: Fail')])])]
		};
		const onlyDone = new Set<CanonicalStatusCategory>(['Todo', 'In Progress', 'Blocked', 'Removed']);
		assert.deepStrictEqual(collectFailingDescendants(summary, onlyDone, false).failing.map(f => [f.label, f.hiddenByFilter]), [['T-3 Test', false]]);
		// the direct child T-1 fails through T-3 but is itself filtered out (shown only as path context)
		assert.deepStrictEqual(countFailing(summary, onlyDone, false), { all: 1, allHidden: 0, direct: 1, directHidden: 1, allBlocked: 0, directBlocked: 0 });
		const counts = countSubtree(summary, onlyDone, false);
		assert.strictEqual(counts.visible, 1);
		assert.deepStrictEqual(describeFailingFraction(countFailing(summary, onlyDone, false), 'all', counts)?.denominator, '1');
	});

	test('UI-32: failing / total fraction in the count pill, same count mode as the pill', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [
				n('T-1 Epic', 'In Progress', [
					n('T-2 Story', 'Done', [n('T-3 Test', 'Done', [], 'Test result: Fail')]),
					n('T-4 Task', 'Todo', [], 'Last run failed')
				]),
				n('T-7 Task', 'Todo', [n('T-8 Sub', 'Todo')]),
				n('T-9 Failing', 'Done', [], 'Last run failed'),
				n('T-5 Gone', 'Removed', [n('T-6 Child', 'Todo', [], 'Test result: Fail')], undefined, true)
			]
		};
		// all levels: T-3, T-4, T-9; direct children: T-1 (through T-3 / T-4) and T-9
		assert.deepStrictEqual(countFailing(summary, none, false), { all: 3, allHidden: 0, direct: 2, directHidden: 0, allBlocked: 0, directBlocked: 0 });
		// Done hidden: failures still count (like the propagation), the hidden ones separately
		assert.deepStrictEqual(countFailing(summary, new Set(['Done']), false), { all: 3, allHidden: 2, direct: 2, directHidden: 1, allBlocked: 0, directBlocked: 0 });
		// show removed items: the removed branch counts again
		assert.deepStrictEqual(countFailing(summary, none, true), { all: 4, allHidden: 0, direct: 3, directHidden: 0, allBlocked: 0, directBlocked: 0 });
		assert.deepStrictEqual(countFailing({ truncated: false, children: [n('A', 'Todo', [n('B', 'Todo')])] }, none, false), { all: 0, allHidden: 0, direct: 0, directHidden: 0, allBlocked: 0, directBlocked: 0 });

		const counts = countSubtree(summary, none, false);
		const allPill = describeChildCountPill(counts, 'all')!;
		const directPill = describeChildCountPill(counts, 'direct')!;
		assert.strictEqual(allPill.text, '7');
		assert.strictEqual(directPill.text, '3');
		const failing = countFailing(summary, none, false);
		assert.deepStrictEqual(describeFailingFraction(failing, 'all', counts), { numerator: '3', denominator: '7', summary: '3 failing of 7 tickets (All Levels)' });
		assert.deepStrictEqual(describeFailingFraction(failing, 'direct', counts), { numerator: '2', denominator: '3', summary: '2 failing of 3 tickets (Direct Children: a child counts when it or a ticket below it fails)' });
		// off: no pill, the tree keeps the red dot
		assert.strictEqual(describeFailingFraction(failing, 'off', counts), undefined);
		// nothing failing: just the total
		assert.strictEqual(describeFailingFraction({ all: 0, allHidden: 0, direct: 0, directHidden: 0 }, 'all', counts), undefined);
		// Done hidden: the denominator is the visible tickets (T-1, T-4, T-7, T-8) plus the hidden failing ones (T-3, T-9);
		// the hidden, not failing T-2 is not counted
		const doneHidden = new Set<CanonicalStatusCategory>(['Done']);
		const hiddenCounts = countSubtree(summary, doneHidden, false);
		assert.strictEqual(hiddenCounts.visible, 4);
		assert.deepStrictEqual(describeFailingFraction(countFailing(summary, doneHidden, false), 'all', hiddenCounts), { numerator: '3', denominator: '6', summary: '3 failing of 6 tickets (All Levels) · 2 of them hidden by the status filter' });
		assert.deepStrictEqual(describeFailingFraction(countFailing(summary, doneHidden, false), 'direct', hiddenCounts), { numerator: '2', denominator: '3', summary: '2 failing of 3 tickets (Direct Children: a child counts when it or a ticket below it fails) · 1 of them hidden by the status filter' });
		// PM example: 1 visible, 2 hidden failing -> 2/3; the numerator never exceeds the denominator
		const pm: ITicketSubtreeSummary = { truncated: false, children: [n('V', 'Todo'), n('H1', 'Done', [], 'x'), n('H2', 'Done', [], 'y')] };
		const pmFraction = describeFailingFraction(countFailing(pm, doneHidden, false), 'all', countSubtree(pm, doneHidden, false))!;
		assert.deepStrictEqual([pmFraction.numerator, pmFraction.denominator], ['2', '3']);
		// all hidden, all failing: 2/2, not 2/0
		const allHidden: ITicketSubtreeSummary = { truncated: false, children: [n('H1', 'Done', [], 'x'), n('H2', 'Done', [], 'y')] };
		const ah = describeFailingFraction(countFailing(allHidden, doneHidden, false), 'all', countSubtree(allHidden, doneHidden, false))!;
		assert.deepStrictEqual([ah.numerator, ah.denominator], ['2', '2']);
		// a capped scan keeps the '+'
		assert.strictEqual(describeFailingFraction({ all: 1, allHidden: 0, direct: 1, directHidden: 0 }, 'all', { visible: 56, total: 56, directVisible: 3, directTotal: 3, truncated: true })!.summary, '1 failing of 56+ tickets (All Levels)');
	});

	test('UI-23: test result classification and tooltips', () => {
		assert.strictEqual(classifyTestResult('Pass'), 'passed');
		assert.strictEqual(classifyTestResult(' "PASSED" '), 'passed');
		assert.strictEqual(classifyTestResult('Fail'), 'failed');
		assert.strictEqual(classifyTestResult('failure'), 'failed');
		assert.strictEqual(classifyTestResult('Blocked'), 'blocked');
		assert.strictEqual(classifyTestResult('Not Run'), 'notRun');
		assert.strictEqual(classifyTestResult(''), 'notRun');
		assert.strictEqual(classifyTestResult(undefined), 'notRun');
		assert.strictEqual(describeTestResult('passed'), 'Test result: Passed');
		assert.strictEqual(describeTestResult('failed'), 'Test result: Failed');
		assert.strictEqual(describeTestResult('notRun'), 'Test result: Not run');
		assert.strictEqual(describeTestResult('blocked'), 'Test result: Blocked');
		// every value that classifies as failed also makes the ticket fail (one red marker, propagated)
		for (const v of ['Fail', 'FAILED', 'failure']) {
			assert.strictEqual(classifyTestResult(v) === 'failed', isFailingResultValue(v));
			assert.ok(detectTicketFailure({ removed: false, resultField: { label: 'Result', value: v } }));
		}
	});

	test('UI-23: pass / not run / blocked never propagate', () => {
		for (const value of ['Pass', 'Not Run', '', 'Blocked']) {
			assert.strictEqual(detectTicketFailure({ status: 'Done', removed: false, resultField: { label: 'Result', value } }), undefined);
		}
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [n('T-1 Suite', 'In Progress', [n('T-2 Passing test', 'Done'), n('T-3 Not run test', 'Todo')])]
		};
		assert.strictEqual(collectFailingDescendants(summary, none, false).failing.length, 0);
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
