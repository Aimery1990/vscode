/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, generateSmartPythonVarName } from '../../entityPersistence/common/entityPersistence.js';

/**
 * Encapsulation as an "extract" refactor (CI-23): the selected nodes move into a new Sub-Workflow ticket (its own
 * canvas) and the parent canvas gets ONE node in their place, holding a Call Sub-Workflow step that references the new
 * ticket ID. Links crossing the selection border are rewired to that node, so the parent keeps its flow and no node
 * exists twice. This file is the pure graph rewrite; the editor creates the ticket and applies the result.
 */

export interface IExtractNodeLike {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	label?: string;
	pipeline?: unknown[];
}

export interface IExtractLinkLike {
	id: string;
	from: string;
	to: string;
	fromPort?: string;
	toPort?: string;
	label?: string;
	condition?: string;
	waypoints?: { x: number; y: number }[];
}

export interface IExtractFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ISubWorkflowExtraction<N extends IExtractNodeLike, L extends IExtractLinkLike> {
	readonly error?: undefined;
	/** Copies of the moved nodes, shifted so the sub-workflow canvas starts near its top-left corner. */
	readonly subNodes: N[];
	/** Copies of the links between moved nodes (same shift applied to their waypoints). */
	readonly subLinks: L[];
	/** The parent canvas after the rewrite: moved nodes removed, the call node at the place of the first moved one. */
	readonly parentNodes: N[];
	/** The parent links after the rewrite: internal links removed, border links rewired to the call node. */
	readonly parentLinks: L[];
	readonly callNode: N;
	/** Number of links that entered / left the selection (now ending / starting at the call node). */
	readonly incomingLinkCount: number;
	readonly outgoingLinkCount: number;
	/** Things the user should check after the rewrite (several entry points, branch conditions on exits). */
	readonly warnings: string[];
}

export interface ISubWorkflowExtractionError {
	readonly error: string;
}

/** Default size of the call node that replaces the selection. */
export const SUB_WORKFLOW_CALL_NODE_WIDTH = 220;
export const SUB_WORKFLOW_CALL_NODE_HEIGHT = 90;
/** Where the moved nodes start on the sub-workflow's own canvas. */
export const SUB_WORKFLOW_CANVAS_ORIGIN = { x: 80, y: 80 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

/** The bounding box of the given nodes; `undefined` for none. */
export function getNodesFrame(nodes: readonly IExtractNodeLike[]): IExtractFrame | undefined {
	if (nodes.length === 0) {
		return undefined;
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + (n.width || 0));
		maxY = Math.max(maxY, n.y + (n.height || 0));
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The frame of the call node: default size, centered on the selection's bounding box. */
export function getCallNodeFrame(selectionFrame: IExtractFrame): IExtractFrame {
	const width = SUB_WORKFLOW_CALL_NODE_WIDTH;
	const height = SUB_WORKFLOW_CALL_NODE_HEIGHT;
	return {
		x: Math.max(0, Math.round(selectionFrame.x + selectionFrame.width / 2 - width / 2)),
		y: Math.max(0, Math.round(selectionFrame.y + selectionFrame.height / 2 - height / 2)),
		width,
		height
	};
}

function withoutKeys<T extends object>(value: T, keys: readonly string[]): T {
	const copy = clone(value);
	for (const key of keys) {
		Reflect.deleteProperty(copy, key);
	}
	return copy;
}

function linkKey(link: IExtractLinkLike): string {
	return JSON.stringify([link.from, link.to, link.label ?? '', link.condition ?? '']);
}

/**
 * Rewrites the canvas for "extract into a Sub-Workflow". `makeCallNode` builds the replacement node for the given frame
 * (centered on the selection). Border links keep their id, style, label and condition; the end that touched the
 * selection now touches the call node (its port and waypoints are dropped, the editor routes them again). Duplicates
 * that would only differ by the removed geometry are merged. Returns an error for an empty or unknown selection.
 */
export function extractSubWorkflowFromCanvas<N extends IExtractNodeLike, L extends IExtractLinkLike>(
	nodes: readonly N[],
	links: readonly L[],
	selectedIds: Iterable<string>,
	makeCallNode: (frame: IExtractFrame) => N
): ISubWorkflowExtraction<N, L> | ISubWorkflowExtractionError {
	const wanted = new Set(selectedIds);
	const moved = nodes.filter(n => wanted.has(n.id));
	if (moved.length === 0) {
		return { error: 'Select at least one node to encapsulate as a Sub-Workflow.' };
	}
	const movedIds = new Set(moved.map(n => n.id));
	const frame = getNodesFrame(moved)!;
	const callNode = makeCallNode(getCallNodeFrame(frame));
	if (nodes.some(n => n.id === callNode.id)) {
		return { error: `The call node id '${callNode.id}' is already used on the canvas.` };
	}

	// Sub-workflow canvas: moved nodes and their internal links, shifted to the origin
	const dx = SUB_WORKFLOW_CANVAS_ORIGIN.x - frame.x;
	const dy = SUB_WORKFLOW_CANVAS_ORIGIN.y - frame.y;
	const subNodes = moved.map(n => {
		const copy = clone(n);
		copy.x = Math.round(n.x + dx);
		copy.y = Math.round(n.y + dy);
		return copy;
	});
	const subLinks: L[] = [];
	const parentLinks: L[] = [];
	const seenParentLinks = new Set<string>();
	const entryTargets = new Set<string>();
	const exitSources = new Set<string>();
	let incomingLinkCount = 0;
	let outgoingLinkCount = 0;
	let conditionalExits = 0;
	const pushParent = (link: L) => {
		const key = linkKey(link);
		if (!seenParentLinks.has(key)) {
			seenParentLinks.add(key);
			parentLinks.push(link);
		}
	};
	for (const link of links) {
		const fromInside = movedIds.has(link.from);
		const toInside = movedIds.has(link.to);
		if (fromInside && toInside) {
			const copy = clone(link);
			if (Array.isArray(copy.waypoints)) {
				copy.waypoints = copy.waypoints.map(p => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
			}
			subLinks.push(copy);
		} else if (toInside) {
			incomingLinkCount++;
			entryTargets.add(link.to);
			const rewired = withoutKeys(link, ['toPort', 'waypoints']);
			rewired.to = callNode.id;
			pushParent(rewired);
		} else if (fromInside) {
			outgoingLinkCount++;
			exitSources.add(link.from);
			if ((link.label || '').trim() || (link.condition || '').trim()) {
				conditionalExits++;
			}
			const rewired = withoutKeys(link, ['fromPort', 'waypoints']);
			rewired.from = callNode.id;
			pushParent(rewired);
		} else {
			pushParent(link);
		}
	}

	// Parent canvas: the call node takes the place (in z-order) of the first moved node
	const parentNodes: N[] = [];
	let placed = false;
	for (const n of nodes) {
		if (!movedIds.has(n.id)) {
			parentNodes.push(n);
		} else if (!placed) {
			parentNodes.push(callNode);
			placed = true;
		}
	}

	const warnings: string[] = [];
	if (entryTargets.size > 1) {
		warnings.push(`Links entered ${entryTargets.size} different selected nodes; they now all enter the call node, and the Sub-Workflow runs from its single start node.`);
	}
	if (conditionalExits > 0) {
		warnings.push(`${conditionalExits} outgoing link(s) had a label / condition; they now leave the call node and are evaluated after the Sub-Workflow returns.`);
	} else if (exitSources.size > 1) {
		warnings.push(`Links left ${exitSources.size} different selected nodes; they now all leave the call node.`);
	}
	return { subNodes, subLinks, parentNodes, parentLinks, callNode, incomingLinkCount, outgoingLinkCount, warnings };
}

/** Variable names a node may set: Inputs parameters, step targets, component output variables, node variables. */
function collectNodeVariableNames(node: unknown, into: Set<string>, includeInputs: boolean): void {
	if (!isRecord(node)) {
		return;
	}
	const add = (v: unknown) => {
		if (typeof v === 'string') {
			const name = v.trim().replace(/^@/, '');
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				into.add(name);
			}
		}
	};
	if (isRecord(node.outputVariable)) {
		add(node.outputVariable.name);
	}
	for (const v of Array.isArray(node.outputVariables) ? node.outputVariables : []) {
		if (isRecord(v)) {
			add(v.name);
		}
	}
	for (const step of Array.isArray(node.pipeline) ? node.pipeline : []) {
		if (!isRecord(step)) {
			continue;
		}
		const comp = isRecord(step.component) ? step.component : undefined;
		if (comp?.type === 'parameters') {
			if (includeInputs) {
				for (const p of Array.isArray(comp.parameters) ? comp.parameters : []) {
					if (isRecord(p)) {
						add(p.name);
					}
				}
			}
			continue;
		}
		add(step.targetVariable);
		if (comp) {
			add(comp.outputVariableName);
		}
	}
}

/** Every variable name the given nodes may set (including the names of their Inputs parameters). */
export function collectCanvasVariableNames(nodes: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const n of nodes) {
		collectNodeVariableNames(n, names, true);
	}
	return names;
}

/**
 * Input bindings of the call step: each Sub-Workflow input is bound to the parent variable of the same name (`{name}`)
 * when the remaining parent canvas sets one; otherwise it stays empty and the Sub-Workflow default is used.
 */
export function buildExtractInputBindings(inputs: readonly { name: string }[], parentVariables: ReadonlySet<string>): Record<string, string> {
	const bindings: Record<string, string> = {};
	for (const input of inputs) {
		bindings[input.name] = parentVariables.has(input.name) ? `{${input.name}}` : '';
	}
	return bindings;
}

/**
 * Variables set inside the moved nodes (not their Inputs) that the remaining parent nodes still mention. After the
 * extract they only exist inside the Sub-Workflow, so the parent gets them through the call step's result instead.
 */
export function findVariablesUsedOutsideSelection(movedNodes: readonly unknown[], remainingNodes: readonly unknown[]): string[] {
	const produced = new Set<string>();
	for (const n of movedNodes) {
		collectNodeVariableNames(n, produced, false);
	}
	if (produced.size === 0) {
		return [];
	}
	const remainingSet = new Set<string>();
	for (const n of remainingNodes) {
		collectNodeVariableNames(n, remainingSet, true);
	}
	const text = remainingNodes.map(n => isRecord(n) ? JSON.stringify(n.pipeline ?? []) : '').join('\n');
	const used: string[] = [];
	for (const name of produced) {
		if (name.length < 3 || remainingSet.has(name)) {
			continue;
		}
		if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) {
			used.push(name);
		}
	}
	return used.sort();
}

export interface ISubWorkflowCallNodeParams {
	nodeId: string;
	stepId: string;
	componentId: string;
	frame: IExtractFrame;
	subWorkflow: {
		id: string;
		name: string;
		sourceWorkflowUri?: string;
		inputs: readonly { name: string; label?: string; defaultValue?: string }[];
		outputs: readonly { label: string; varName: string; defaultFormat?: string }[];
	};
	inputBindings: Record<string, string>;
}

/** The node that replaces the selection: one Call Sub-Workflow step referencing the new ticket ID. */
export function buildSubWorkflowCallNode(params: ISubWorkflowCallNodeParams): IExtractNodeLike & { type: 'round-rect'; pipeline: { id: string; type: 'component'; label: string; component: ICustomField }[] } {
	const sub = params.subWorkflow;
	const component: ICustomField = {
		id: params.componentId,
		label: sub.name,
		type: 'sub_workflow',
		required: false,
		outputVariableName: generateSmartPythonVarName(sub.name, 'sub_workflow'),
		subWorkflowId: sub.id,
		subWorkflowName: sub.name,
		subWorkflowSourceUri: sub.sourceWorkflowUri,
		subWorkflowInputs: { ...params.inputBindings },
		subWorkflowInputDefs: sub.inputs.map(i => ({ name: i.name, label: i.label, defaultValue: i.defaultValue })),
		subWorkflowOutputDefs: sub.outputs.map(o => ({ label: o.label, varName: o.varName, defaultFormat: o.defaultFormat }))
	};
	return {
		id: params.nodeId,
		type: 'round-rect',
		x: params.frame.x,
		y: params.frame.y,
		width: params.frame.width,
		height: params.frame.height,
		label: sub.name,
		pipeline: [{ id: params.stepId, type: 'component', label: sub.name, component }]
	};
}
