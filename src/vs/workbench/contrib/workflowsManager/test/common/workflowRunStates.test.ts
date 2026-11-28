/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ICustomField } from '../../../entityPersistence/common/entityPersistence.js';
import type { IWorkflowEngineOptions, IWorkflowExecutionRun } from '../../common/workflowExecutionModel.js';
import {
	buildInitialRunStates, dropContextVariables, isPartialWorkflowRun, nodeDeclaredVariableNames, nodesClearedByRun, nodesReachableFrom,
	variablesProducedOnlyByClearedNodes
} from '../../common/workflowRunStates.js';

interface ITestLink { id: string; from: string; to: string; label?: string }
const node = (id: string) => ({ id, label: id, type: 'round-rect' });
const link = (from: string, to: string): ITestLink => ({ id: `${from}_${to}`, from, to });
const sorted = (s: Iterable<string> | undefined) => [...(s || [])].sort();

/** A completed run where every node in `ran` succeeded and every link leaving a node in `ran` was evaluated. */
function completedRun(runId: string, runNumber: number, nodeIds: string[], links: ITestLink[], ran: string[]): IWorkflowExecutionRun {
	const run: IWorkflowExecutionRun = {
		runId, runNumber, workflowUri: 'file:///ws/wf', workflowName: 'wf', status: 'completed', mode: 'standard', startedAt: runNumber * 1000, updatedAt: runNumber * 1000,
		contextVariables: {}, executionPath: [], logs: [], visitedNodeIds: [...ran], linkStates: {}, nodeStates: {}
	};
	for (const id of nodeIds) {
		run.nodeStates[id] = { nodeId: id, nodeLabel: id, status: ran.includes(id) ? 'success' : 'pending', startedAt: ran.includes(id) ? runNumber * 1000 + 1 : undefined, executedTickets: [] };
	}
	for (const l of links) {
		if (ran.includes(l.from)) {
			run.linkStates![l.id] = { linkId: l.id, fromNodeId: l.from, toNodeId: l.to, status: ran.includes(l.to) ? 'passed' : 'rejected' };
		}
	}
	return run;
}

/** The states a new run starts with, the way WorkflowExecutionService.executeWorkflow initializes them. */
function startRun(nodeIds: string[], links: ITestLink[], options: IWorkflowEngineOptions, prior?: IWorkflowExecutionRun) {
	const cleared = nodesClearedByRun(options, links);
	return { cleared, ...buildInitialRunStates(nodeIds.map(node), cleared, prior) };
}

/** Asserts that exactly `clearedIds` are pending/unvisited and all other nodes keep the prior state, marked with its run. */
function assertClearedAndKept(init: ReturnType<typeof startRun>, prior: IWorkflowExecutionRun, clearedIds: string[]) {
	assert.deepStrictEqual(sorted(init.cleared), sorted(clearedIds));
	for (const [id, ns] of Object.entries(init.nodeStates)) {
		if (clearedIds.includes(id)) {
			assert.strictEqual(ns.status, 'pending', `${id} is cleared`);
			assert.strictEqual(ns.startedAt, undefined, `${id} has no start time`);
			assert.strictEqual(ns.carriedOverFromRunId, undefined, `${id} is not marked`);
			assert.ok(!init.visitedNodeIds.includes(id), `${id} is not visited`);
		} else {
			const was = prior.nodeStates[id];
			assert.strictEqual(ns.status, was.status, `${id} keeps its status`);
			assert.strictEqual(ns.startedAt, was.startedAt, `${id} keeps its start time`);
			if (was.status !== 'pending') {
				assert.strictEqual(ns.carriedOverFromRunId, prior.runId, `${id} is marked carried over`);
				assert.strictEqual(ns.carriedOverFromRunNumber, prior.runNumber, `${id} shows "From run #${prior.runNumber}"`);
				assert.ok(init.visitedNodeIds.includes(id), `${id} stays visited`);
			}
		}
	}
	for (const ls of Object.values(init.linkStates)) {
		assert.ok(!clearedIds.includes(ls.fromNodeId), `link state leaving cleared node ${ls.fromNodeId} is dropped`);
	}
	for (const ls of Object.values(prior.linkStates || {})) {
		if (!clearedIds.includes(ls.fromNodeId)) {
			assert.ok(Object.values(init.linkStates).some(k => k.linkId === ls.linkId), `link state ${ls.linkId} is kept`);
		}
	}
}

// Workflow ANYAG-0122: Start -> run_review_ticket -> (@review == 'Approve') branch_approve / (@review == 'Reject') branch_reject
const NODES_0122 = ['start', 'run_review_ticket', 'branch_approve', 'branch_reject'];
const LINKS_0122: ITestLink[] = [
	{ id: 'link_start', from: 'start', to: 'run_review_ticket' },
	{ id: 'link_approve', from: 'run_review_ticket', to: 'branch_approve', label: `@review == 'Approve'` },
	{ id: 'link_reject', from: 'run_review_ticket', to: 'branch_reject', label: `@review == 'Reject'` }
];

// start -> A -> fork -> (B -> C <-> D) | E
const NODES_LOOP = ['start', 'A', 'fork', 'B', 'C', 'D', 'E'];
const LINKS_LOOP = [link('start', 'A'), link('A', 'fork'), link('fork', 'B'), link('B', 'C'), link('C', 'D'), link('D', 'C'), link('fork', 'E')];

suite('workflowRunStates (CI-57)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a run started from Start is a fresh run; from a node with incoming links or with selected nodes it is partial', () => {
		assert.strictEqual(isPartialWorkflowRun(undefined, LINKS_0122), false);
		assert.strictEqual(isPartialWorkflowRun({}, LINKS_0122), false);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'start' }, LINKS_0122), false);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'branch_approve' }, LINKS_0122), true);
		assert.strictEqual(isPartialWorkflowRun({ entryNodeId: 'start', selectedNodeIds: ['start'] }, LINKS_0122), true);
		assert.strictEqual(nodesClearedByRun({ entryNodeId: 'start' }, LINKS_0122), undefined, 'a fresh run clears everything');
	});

	for (const options of [{ entryNodeId: 'start' }, {}] as IWorkflowEngineOptions[]) {
		test(`run 1 Reject then run 2 Approve: run 2 has only the approve branch (${options.entryNodeId ? 'toolbar Run, entry = Start' : 'no entry node'})`, () => {
			const run1 = completedRun('run_1', 1, NODES_0122, LINKS_0122, ['start', 'run_review_ticket', 'branch_reject']);
			const init = startRun(NODES_0122, LINKS_0122, options, run1);
			const visited: string[] = init.visitedNodeIds;
			assert.strictEqual(visited.length, 0);
			assert.deepStrictEqual(init.linkStates, {});
			assert.ok(Object.values(init.nodeStates).every(ns => ns.status === 'pending' && !ns.carriedOverFromRunId));
			// run 2 takes the approve branch
			for (const id of ['start', 'run_review_ticket', 'branch_approve']) {
				visited.push(id);
				init.nodeStates[id].status = 'success';
			}
			assert.deepStrictEqual(init.visitedNodeIds, ['start', 'run_review_ticket', 'branch_approve']);
			assert.strictEqual(init.nodeStates.branch_reject.status, 'pending');
			assert.strictEqual(run1.nodeStates.branch_reject.status, 'success', 'run 1 is untouched');
		});
	}

	test('long chain: a run from the middle clears that node and everything after it, keeps everything before it', () => {
		const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
		const links = ids.slice(1).map((id, i) => link(ids[i], id));
		const prior = completedRun('run_7', 7, ids, links, ids);
		const init = startRun(ids, links, { entryNodeId: 'n5' }, prior);
		assertClearedAndKept(init, prior, ids.slice(5));
		assert.deepStrictEqual(init.visitedNodeIds, ids.slice(0, 5));
	});

	test('fork with a loop on one branch: a full run from Start clears everything', () => {
		const prior = completedRun('run_1', 1, NODES_LOOP, LINKS_LOOP, NODES_LOOP);
		const init = startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'start' }, prior);
		assert.strictEqual(init.cleared, undefined);
		assert.ok(Object.values(init.nodeStates).every(ns => ns.status === 'pending'));
	});

	test('run from a node inside the loop: the loop body is cleared; A, fork, B and E are kept', () => {
		const prior = completedRun('run_3', 3, NODES_LOOP, LINKS_LOOP, NODES_LOOP);
		const init = startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'C' }, prior);
		assertClearedAndKept(init, prior, ['C', 'D']);
		// the same from D (the loop's other node): C is reachable through the back-edge
		assertClearedAndKept(startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'D' }, prior), prior, ['C', 'D']);
	});

	test('run from the fork: both branches below are cleared, even the one this run will not take', () => {
		const prior = completedRun('run_2', 2, NODES_LOOP, LINKS_LOOP, ['start', 'A', 'fork', 'E']);
		const init = startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'fork' }, prior);
		assertClearedAndKept(init, prior, ['fork', 'B', 'C', 'D', 'E']);
		assert.deepStrictEqual(sorted(init.visitedNodeIds), ['A', 'start']);
		assert.deepStrictEqual(Object.keys(init.linkStates).sort(), ['A_fork', 'start_A']);
	});

	test('a node upstream of the entry node but reachable through a back-edge is cleared', () => {
		// start -> P -> Q -> R, R -> P (back-edge), R -> end
		const ids = ['start', 'P', 'Q', 'R', 'end'];
		const links = [link('start', 'P'), link('P', 'Q'), link('Q', 'R'), link('R', 'P'), link('R', 'end')];
		assert.deepStrictEqual(sorted(nodesReachableFrom(['Q'], links)), ['P', 'Q', 'R', 'end']);
		const prior = completedRun('run_4', 4, ids, links, ids);
		assertClearedAndKept(startRun(ids, links, { entryNodeId: 'Q' }, prior), prior, ['P', 'Q', 'R', 'end']);
	});

	test('Run Selected Nodes Only clears exactly the selected nodes and the links leaving them', () => {
		const prior = completedRun('run_5', 5, NODES_LOOP, LINKS_LOOP, NODES_LOOP);
		const init = startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'B', selectedNodeIds: ['B', 'E'] }, prior);
		assertClearedAndKept(init, prior, ['B', 'E']);
		assert.strictEqual(init.nodeStates.C.status, 'success', 'downstream of a selected node is kept');
	});

	test('a state carried over twice keeps the run it really comes from', () => {
		const run1 = completedRun('run_1', 1, NODES_LOOP, LINKS_LOOP, NODES_LOOP);
		const first = startRun(NODES_LOOP, LINKS_LOOP, { entryNodeId: 'C' }, run1);
		const run2 = { runId: 'run_2', runNumber: 2, nodeStates: first.nodeStates, linkStates: first.linkStates, visitedNodeIds: first.visitedNodeIds };
		const second = buildInitialRunStates(NODES_LOOP.map(node), new Set(['C', 'D']), run2);
		assert.strictEqual(second.nodeStates.A.carriedOverFromRunId, 'run_1');
		assert.strictEqual(second.nodeStates.A.carriedOverFromRunNumber, 1);
		// deep copies: the earlier run is not modified
		second.nodeStates.A.status = 'failed';
		assert.strictEqual(run1.nodeStates.A.status, 'success');
		assert.strictEqual(run1.nodeStates.A.carriedOverFromRunId, undefined);
	});

	test('variables: those declared only by cleared nodes are dropped; kept nodes\' and undeclared ones are kept', () => {
		const comp = (f: Partial<ICustomField>) => ({ id: f.id || 'c', label: f.label || 'c', type: f.type || 'text', ...f }) as ICustomField;
		const nodes = [
			{ id: 'A', label: 'A', outputVariables: [{ name: '@jd_list' }] },
			{ id: 'B', label: 'B', pipeline: [{ targetVariable: 'shared' }] },
			{ id: 'C', label: 'C', outputVariables: [{ name: 'i' }], pipeline: [{ targetVariable: 'shared' }, { component: comp({ type: 'python', label: 'Score', outputVariableName: 'score' }) }] },
			{ id: 'D', label: 'D', pipeline: [{ targetVariable: '@summary' }] }
		];
		assert.ok(nodeDeclaredVariableNames(nodes[2]).includes('score'));
		const drop = variablesProducedOnlyByClearedNodes(nodes, new Set(['C', 'D']));
		assert.deepStrictEqual(sorted(drop).filter(n => !n.startsWith('score')), ['i', 'summary']);
		assert.ok(drop.has('score'));
		const ctx: Record<string, unknown> = { jd_list: [1], shared: 's', i: 3, score: 9, 'score.stdout': 'x', summary: 'old', '@summary': 'old', from_python: 1 };
		dropContextVariables(ctx, drop);
		assert.deepStrictEqual(Object.keys(ctx).sort(), ['from_python', 'jd_list', 'shared']);
	});
});
