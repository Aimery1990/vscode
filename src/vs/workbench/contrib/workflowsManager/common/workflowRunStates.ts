/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { IWorkflowEngineOptions, IWorkflowExecutionRun, IWorkflowLinkExecutionState, IWorkflowNodeExecutionState } from './workflowExecutionModel.js';

/**
 * How a new workflow run starts (CI-57).
 *
 * - A FRESH run (the toolbar Run / Full Speed / Step with nothing selected, a nested or programmatic run, or a run whose
 *   entry is a node without incoming links such as Start) starts with empty node states, link states and visited nodes:
 *   nothing from an earlier run may color the canvas.
 * - A PARTIAL run ("Run Workflow From This Node" on a node that has incoming links, or "Run Selected Nodes Only")
 *   intentionally keeps the earlier run's results for the nodes it does not re-run, so the downstream nodes still have
 *   the upstream values. Every node state copied that way carries `carriedOverFromRunId`, which the canvas shows
 *   distinctly; it is cleared as soon as the node runs again in the new run.
 */
export function isPartialWorkflowRun(
	options: Pick<IWorkflowEngineOptions, 'entryNodeId' | 'selectedNodeIds'> | undefined,
	links: readonly { readonly to: string }[] | undefined
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

export interface IWorkflowRunNodeRef {
	readonly id: string;
	readonly label: string;
	readonly type?: string;
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
 * Fresh run: every node pending, no link states, nothing visited -- `prior` is ignored.
 * Partial run: the nodes in `resetNodeIds` start pending; every other node keeps (a deep copy of) its state in `prior`,
 * marked with `carriedOverFromRunId`; the prior link states and visited nodes are kept too.
 */
export function buildInitialRunStates(
	nodes: readonly IWorkflowRunNodeRef[],
	isPartialRun: boolean,
	resetNodeIds: ReadonlySet<string>,
	prior: Pick<IWorkflowExecutionRun, 'runId' | 'nodeStates' | 'linkStates' | 'visitedNodeIds'> | undefined
): IInitialWorkflowRunStates {
	const source = isPartialRun ? prior : undefined;
	const nodeStates: Record<string, IWorkflowNodeExecutionState> = {};
	for (const node of nodes) {
		if (!node) {
			continue;
		}
		const priorState = source?.nodeStates?.[node.id];
		if (priorState && !resetNodeIds.has(node.id)) {
			const copy: IWorkflowNodeExecutionState = JSON.parse(JSON.stringify(priorState));
			if (copy.status !== 'pending') {
				copy.carriedOverFromRunId = priorState.carriedOverFromRunId || source?.runId || undefined;
			}
			nodeStates[node.id] = copy;
		} else {
			nodeStates[node.id] = pendingNodeState(node);
		}
	}
	return {
		nodeStates,
		linkStates: source?.linkStates ? JSON.parse(JSON.stringify(source.linkStates)) : {},
		visitedNodeIds: Array.isArray(source?.visitedNodeIds) ? [...source.visitedNodeIds] : []
	};
}
