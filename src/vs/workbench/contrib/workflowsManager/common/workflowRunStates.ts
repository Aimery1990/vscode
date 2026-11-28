/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, generateSmartPythonVarName } from '../../entityPersistence/common/entityPersistence.js';
import { getOutputSuffixes, getOutputVariableInfo } from '../../customModules/common/outputVariable.js';
import type { IWorkflowEngineOptions, IWorkflowExecutionRun, IWorkflowLinkExecutionState, IWorkflowNodeExecutionState } from './workflowExecutionModel.js';

/**
 * How a new workflow run starts (CI-57).
 *
 * - FRESH run: the toolbar Run / Full Speed / Step with nothing selected, a nested or programmatic run, or a run whose
 *   entry is a node without incoming links (e.g. Start). It starts with empty node states, link states and visited
 *   nodes, so nothing from an earlier run colors the canvas.
 * - PARTIAL run from node X ("Run Workflow From This Node", X has incoming links): X and every node REACHABLE from X
 *   over outgoing links (transitive closure: all branches below X, loop bodies, nodes reached through back-edges) are
 *   CLEARED. They start pending, are not visited, and lose the link states of the links leaving them. All other
 *   nodes (upstream / parallel work that may have cost many tokens) KEEP their earlier state, marked
 *   `carriedOverFromRunId` / `carriedOverFromRunNumber`.
 * - PARTIAL run of selected nodes ("Run Selected Nodes Only"): exactly the selected nodes are cleared (plus the links
 *   leaving them); everything else is kept.
 * The execution path of a new run always starts empty, so it only lists what this run executes.
 */
export function isPartialWorkflowRun(
	options: Pick<IWorkflowEngineOptions, 'entryNodeId' | 'selectedNodeIds'> | undefined,
	links: readonly IWorkflowRunLinkRef[] | undefined
): boolean {
	if (options?.selectedNodeIds && options.selectedNodeIds.length > 0) {
		return true;
	}
	const entryNodeId = options?.entryNodeId;
	if (!entryNodeId) {
		return false;
	}
	// Starting at an entry node (no incoming links, e.g. Start) is a full run from the beginning, not a resume
	return (links || []).some(l => l && l.to === entryNodeId);
}

export interface IWorkflowRunLinkRef {
	readonly from?: string;
	readonly to: string;
}

export interface IWorkflowRunNodeRef {
	readonly id: string;
	readonly label: string;
	readonly type?: string;
}

/** `startIds` and every node reachable from them over outgoing links (loops and back-edges included). */
export function nodesReachableFrom(startIds: Iterable<string>, links: readonly IWorkflowRunLinkRef[] | undefined): Set<string> {
	const out = new Map<string, string[]>();
	for (const l of links || []) {
		if (l && l.from && l.to) {
			const list = out.get(l.from);
			if (list) { list.push(l.to); } else { out.set(l.from, [l.to]); }
		}
	}
	const seen = new Set<string>();
	const stack = [...startIds].filter(Boolean);
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		for (const next of out.get(id) || []) {
			if (!seen.has(next)) {
				stack.push(next);
			}
		}
	}
	return seen;
}

/**
 * The nodes a new run clears (see the module comment). A fresh run clears every node: `undefined` is returned and
 * nothing is carried over.
 */
export function nodesClearedByRun(
	options: Pick<IWorkflowEngineOptions, 'entryNodeId' | 'selectedNodeIds'> | undefined,
	links: readonly IWorkflowRunLinkRef[] | undefined
): Set<string> | undefined {
	if (!isPartialWorkflowRun(options, links)) {
		return undefined;
	}
	if (options?.selectedNodeIds && options.selectedNodeIds.length > 0) {
		return new Set(options.selectedNodeIds.filter(Boolean));
	}
	return nodesReachableFrom([options!.entryNodeId!], links);
}

export interface IInitialWorkflowRunStates {
	nodeStates: Record<string, IWorkflowNodeExecutionState>;
	linkStates: Record<string, IWorkflowLinkExecutionState>;
	visitedNodeIds: string[];
}

function pendingNodeState(node: IWorkflowRunNodeRef): IWorkflowNodeExecutionState {
	return {
		nodeId: node.id,
		nodeLabel: node.label,
		nodeType: node.type,
		status: 'pending',
		executedTickets: []
	};
}

/**
 * The node states, link states and visited nodes a new run starts with.
 * `clearedNodeIds` undefined (fresh run): every node pending, no link states, nothing visited; `prior` is ignored.
 * Otherwise the cleared nodes start pending, are dropped from the visited nodes, and the link states of the links
 * leaving them are dropped; every other node keeps a deep copy of its state in `prior`, marked as carried over.
 */
export function buildInitialRunStates(
	nodes: readonly IWorkflowRunNodeRef[],
	clearedNodeIds: ReadonlySet<string> | undefined,
	prior: Pick<IWorkflowExecutionRun, 'runId' | 'runNumber' | 'nodeStates' | 'linkStates' | 'visitedNodeIds'> | undefined
): IInitialWorkflowRunStates {
	const source = clearedNodeIds ? prior : undefined;
	const cleared = clearedNodeIds || new Set<string>();
	const nodeStates: Record<string, IWorkflowNodeExecutionState> = {};
	for (const node of nodes) {
		if (!node) {
			continue;
		}
		const priorState = source?.nodeStates?.[node.id];
		if (priorState && !cleared.has(node.id)) {
			const copy: IWorkflowNodeExecutionState = JSON.parse(JSON.stringify(priorState));
			if (copy.status !== 'pending') {
				// A state carried over twice keeps the run it really comes from
				copy.carriedOverFromRunId = priorState.carriedOverFromRunId || source?.runId || undefined;
				copy.carriedOverFromRunNumber = priorState.carriedOverFromRunId ? priorState.carriedOverFromRunNumber : source?.runNumber;
			}
			nodeStates[node.id] = copy;
		} else {
			nodeStates[node.id] = pendingNodeState(node);
		}
	}
	const linkStates: Record<string, IWorkflowLinkExecutionState> = {};
	for (const [key, state] of Object.entries(source?.linkStates || {})) {
		if (state && !cleared.has(state.fromNodeId)) {
			linkStates[key] = JSON.parse(JSON.stringify(state));
		}
	}
	return {
		nodeStates,
		linkStates,
		visitedNodeIds: Array.isArray(source?.visitedNodeIds) ? source.visitedNodeIds.filter(id => !cleared.has(id)) : []
	};
}

/** The parts of a flowchart node that declare the variables it writes. */
export interface IWorkflowRunVariableNodeRef {
	readonly id: string;
	readonly label?: string;
	readonly outputVariable?: { readonly name?: string };
	readonly outputVariables?: readonly ({ readonly name?: string } | undefined)[];
	readonly pipeline?: readonly ({ readonly targetVariable?: string; readonly label?: string; readonly component?: ICustomField } | undefined)[];
}

const cleanName = (name: string | undefined) => (name || '').trim().replace(/^@/, '').trim();

/**
 * Context variable names a node DECLARES it writes: its node variables, the target variable of each pipeline step,
 * and the output variable of each component (with the dotted sub-fields / suffixed names its type publishes; a
 * Sub-Workflow component publishes under its output variable). Variables set by free Python code or published by a
 * Run Ticket step (ticket outputs, decisions) cannot be attributed and are not listed.
 */
export function nodeDeclaredVariableNames(node: IWorkflowRunVariableNodeRef): string[] {
	const names = new Set<string>();
	const add = (n: string | undefined) => {
		const c = cleanName(n);
		if (c) {
			names.add(c);
		}
	};
	add(node.outputVariable?.name);
	for (const v of node.outputVariables || []) {
		add(v?.name);
	}
	for (const step of node.pipeline || []) {
		if (!step) {
			continue;
		}
		add(step.targetVariable);
		const comp = step.component;
		if (!comp || !comp.type) {
			continue;
		}
		const base = comp.type === 'sub_workflow'
			? (cleanName(comp.outputVariableName) || generateSmartPythonVarName(comp.label || step.label || 'sub_workflow', 'sub_workflow'))
			: getOutputVariableInfo(comp)?.name;
		if (base) {
			add(base);
			for (const suffix of getOutputSuffixes(comp.type)) {
				add(base + suffix);
			}
		}
	}
	return [...names];
}

/**
 * Variables a partial run drops from the inherited context: those declared ONLY by cleared nodes (they are produced
 * again as the cleared nodes re-run; a loop counter restarts from its initial value). A name also declared by a kept
 * node is kept. Undeclared variables (free Python code, Run Ticket outputs) are all kept.
 */
export function variablesProducedOnlyByClearedNodes(nodes: readonly IWorkflowRunVariableNodeRef[], clearedNodeIds: ReadonlySet<string>): Set<string> {
	const byCleared = new Set<string>();
	const byKept = new Set<string>();
	for (const node of nodes) {
		if (!node) {
			continue;
		}
		const target = clearedNodeIds.has(node.id) ? byCleared : byKept;
		for (const name of nodeDeclaredVariableNames(node)) {
			target.add(name);
		}
	}
	return new Set([...byCleared].filter(n => !byKept.has(n)));
}

/** Removes `names` (and their dotted sub-keys, `name.x`) from a context object; returns the removed keys. Mutates `context`. */
export function dropContextVariables(context: Record<string, unknown>, names: ReadonlySet<string>): string[] {
	const dropped: string[] = [];
	if (names.size === 0) {
		return dropped;
	}
	for (const key of Object.keys(context)) {
		const k = cleanName(key);
		const dot = k.indexOf('.');
		if (names.has(k) || (dot > 0 && names.has(k.slice(0, dot)))) {
			delete context[key];
			dropped.push(key);
		}
	}
	return dropped;
}
