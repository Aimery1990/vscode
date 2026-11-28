/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IWorkflowEngineOptions, IWorkflowExecutionRun } from '../../common/workflowExecutionModel.js';
import { buildInitialRunStates, isPartialWorkflowRun } from '../../common/workflowRunStates.js';

// Workflow ANYAG-0122: Start -> run_review_ticket -> (@review == 'Approve') branch_approve / (@review == 'Reject') branch_reject
const NODES = [
	{ id: 'start', label: 'Start', type: 'circle' },
	{ id: 'run_review_ticket', label: '运行审核 ticket', type: 'round-rect' },
	{ id: 'branch_approve', label: '分支 A：通过', type: 'round-rect' },
	{ id: 'branch_reject', label: '分支 B：拒绝', type: 'round-rect' }
];
const LINKS = [
	{ id: 'link_start', from: 'start', to: 'run_review_ticket' },
	{ id: 'link_approve', from: 'run_review_ticket', to: 'branch_approve', label: `@review == 'Approve'` },
	{ id: 'link_reject', from: 'run_review_ticket', to: 'branch_reject', label: `@review == 'Reject'` }
];

/** Initializes a run the way WorkflowExecutionService.executeWorkflow does, then "executes" it along `review`. */
function simulateRun(runId: string, startedAt: number, review: 'Approve' | 'Reject', options: IWorkflowEngineOptions, prior?: IWorkflowExecutionRun): IWorkflowExecutionRun {
	const partial = isPartialWorkflowRun(options, LINKS);
	const resetSet = new Set<string>(options.selectedNodeIds?.length ? options.selectedNodeIds : (options.entryNodeId ? [options.entryNodeId] : []));
	const init = buildInitialRunStates(NODES, partial, resetSet, prior);
	const run: IWorkflowExecutionRun = {
		runId, workflowUri: 'file:///ws/ANYAG-0122', workflowName: 'ANYAG-0122', status: 'running', mode: 'standard', startedAt, updatedAt: startedAt,
		contextVariables: {}, executionPath: [], logs: [], ...init
	};
	const taken = review === 'Approve' ? 'branch_approve' : 'branch_reject';
	let t = startedAt;
	for (const nodeId of ['start', 'run_review_ticket', taken]) {
		if (!run.visitedNodeIds.includes(nodeId)) {
			run.visitedNodeIds.push(nodeId);
		}
		const ns = run.nodeStates[nodeId];
		ns.status = 'success';
		ns.startedAt = ++t;
		ns.carriedOverFromRunId = undefined;
	}
	for (const l of LINKS) {
		const passed = l.id === 'link_start' || l.to === taken;
		run.linkStates![l.id] = { linkId: l.id, fromNodeId: l.from, toNodeId: l.to, status: passed ? 'passed' : 'rejected', evaluationResult: passed };
	}
	run.status = 'completed';
	return run;
}

suite('workflowRunStates (CI-57)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a run started from Start is a fresh run; from a node with incoming links or with selected nodes it is partial', () => {
		assert.strictEqual(isPartialWorkflowRun(undefined, LINKS), false);
		assert.strictEqual(isPartialWorkflowRun({}, LINKS), false);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'start' }, LINKS), false);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'branch_approve' }, LINKS), true);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'start', selectedNodeIds: ['start'] }, LINKS), true);
	});

	for (const options of [{ entryNodeId: 'start' }, {}] as IWorkflowEngineOptions[]) {
		test(`run 1 Reject then run 2 Approve: run 2 has only the approve branch (${options.entryNodeId ? 'toolbar Run, entry = Start' : 'no entry node'})`, () => {
			const run1 = simulateRun('run_1', 1000, 'Reject', options);
			assert.deepStrictEqual(run1.visitedNodeIds, ['start', 'run_review_ticket', 'branch_reject']);

			const run2 = simulateRun('run_2', 2000, 'Approve', options, run1);
			assert.deepStrictEqual(run2.visitedNodeIds, ['start', 'run_review_ticket', 'branch_approve']);
			assert.strictEqual(run2.nodeStates.branch_reject.status, 'pending');
			assert.strictEqual(run2.nodeStates.branch_reject.startedAt, undefined);
			assert.strictEqual(run2.nodeStates.branch_approve.status, 'success');
			assert.strictEqual(run2.linkStates!.link_reject.status, 'rejected');
			assert.ok(Object.values(run2.nodeStates).every(ns => !ns.carriedOverFromRunId));
			// run 1's record is untouched
			assert.strictEqual(run1.nodeStates.branch_reject.status, 'success');
			assert.strictEqual(run1.nodeStates.branch_approve.status, 'pending');
		});
	}

	test('a fresh run starts with empty states even when the prior run is passed', () => {
		const run1 = simulateRun('run_1', 1000, 'Reject', {});
		const init = buildInitialRunStates(NODES, false, new Set(), run1);
		assert.deepStrictEqual(init.visitedNodeIds, []);
		assert.deepStrictEqual(init.linkStates, {});
		assert.ok(Object.values(init.nodeStates).every(ns => ns.status === 'pending'));
	});

	test('run from a mid-workflow node keeps earlier results, marked as carried over; the entry node is reset', () => {
		const run1 = simulateRun('run_1', 1000, 'Reject', {});
		const options: IWorkflowEngineOptions = { entryNodeId: 'run_review_ticket' };
		assert.strictEqual(isPartialWorkflowRun(options, LINKS), true);
		const init = buildInitialRunStates(NODES, true, new Set(['run_review_ticket']), run1);
		assert.strictEqual(init.nodeStates.start.status, 'success');
		assert.strictEqual(init.nodeStates.start.carriedOverFromRunId, 'run_1');
		assert.strictEqual(init.nodeStates.branch_reject.carriedOverFromRunId, 'run_1');
		assert.strictEqual(init.nodeStates.run_review_ticket.status, 'pending');
		assert.strictEqual(init.nodeStates.run_review_ticket.carriedOverFromRunId, undefined);
		assert.strictEqual(init.nodeStates.branch_approve.carriedOverFromRunId, undefined, 'a pending node is not marked');
		assert.deepStrictEqual(init.visitedNodeIds, ['start', 'run_review_ticket', 'branch_reject']);
		assert.strictEqual(init.linkStates.link_reject.status, 'passed');
		// deep copies: the earlier run is not modified
		init.nodeStates.start.status = 'failed';
		assert.strictEqual(run1.nodeStates.start.status, 'success');
		assert.strictEqual(run1.nodeStates.start.carriedOverFromRunId, undefined);
	});

	test('a state carried over twice keeps the run it really comes from', () => {
		const run1 = simulateRun('run_1', 1000, 'Reject', {});
		const partial1 = buildInitialRunStates(NODES, true, new Set(['branch_approve']), run1);
		const run2 = { runId: 'run_2', ...partial1 };
		const partial2 = buildInitialRunStates(NODES, true, new Set(['branch_approve']), run2);
		assert.strictEqual(partial2.nodeStates.branch_reject.carriedOverFromRunId, 'run_1');
	});
});
