/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-Workflow recursion protection (CI-38). Recursion is never allowed: a workflow, a Sub-Workflow or a ticket
 * template must not (directly or indirectly) call a Sub-Workflow that is already being executed.
 *
 * Two layers use this pure logic:
 * - the up-front check builds the "who calls whom" graph (workflow nodes -> Sub-Workflows, Sub-Workflow definitions ->
 *   nested Sub-Workflows, templates -> Call Sub-Workflow cards, run-ticket steps -> their templates) and rejects any
 *   cycle before a save or a run;
 * - the runtime guard carries a call chain through every Sub-Workflow invocation and stops the run on recursion or
 *   when the nesting is deeper than {@link MAX_SUB_WORKFLOW_CALL_DEPTH}.
 */

/** Maximum number of nested Sub-Workflow calls in one run (a user decision). */
export const MAX_SUB_WORKFLOW_CALL_DEPTH = 5;

export type SubWorkflowCallGraphNodeKind = 'workflow' | 'sub_workflow' | 'template';

/** One vertex of the call graph. */
export interface ISubWorkflowCallGraphNode {
	readonly kind: SubWorkflowCallGraphNodeKind;
	/** Workflow URI, canonical Sub-Workflow ticket ID, or template id. */
	readonly key: string;
	/** Human readable name used in error messages. */
	readonly label: string;
}

/** What the graph builder needs to know about a Sub-Workflow. */
export interface ISubWorkflowGraphDefinition {
	readonly id: string;
	readonly legacyId?: string;
	readonly name: string;
	readonly nodes: readonly unknown[];
	readonly nodeIds?: readonly string[];
	readonly sourceWorkflowUri?: string;
}

/** What the graph builder needs to know about a ticket template. */
export interface ITemplateGraphDefinition {
	readonly id: string;
	readonly name: string;
	readonly fields: readonly unknown[];
}

/** Looks up the definitions referenced while walking the graph. Implementations must never throw. */
export interface ISubWorkflowCallGraphResolver {
	/** By ticket ID or legacy `subwf_...` id. */
	resolveSubWorkflow(reference: string): Promise<ISubWorkflowGraphDefinition | undefined>;
	/** By ticket type (template id or name); optional, templates are skipped without it. */
	resolveTemplate?(ticketType: string): Promise<ITemplateGraphDefinition | undefined>;
}

/** The workflow, template or Sub-Workflow the walk starts from (the one being saved or run). */
export type SubWorkflowCallGraphRoot =
	| { readonly kind: 'workflow'; readonly key: string; readonly label: string; readonly nodes: readonly unknown[] }
	| { readonly kind: 'template'; readonly key: string; readonly label: string; readonly fields: readonly unknown[] }
	| { readonly kind: 'sub_workflow'; readonly key: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimmed(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function pushUnique(list: string[], value: string): void {
	if (value && !list.includes(value)) {
		list.push(value);
	}
}

/** Sub-Workflow references (ticket IDs or legacy ids) of the enabled Call Sub-Workflow steps of workflow nodes. */
export function collectSubWorkflowRefsFromNodes(nodes: unknown): string[] {
	const refs: string[] = [];
	for (const node of Array.isArray(nodes) ? nodes : []) {
		const pipeline = isRecord(node) && Array.isArray(node.pipeline) ? node.pipeline : [];
		for (const step of pipeline) {
			if (!isRecord(step) || step.disabled === true || !isRecord(step.component)) {
				continue;
			}
			const comp = step.component;
			if (comp.type === 'sub_workflow' && comp.disabled !== true) {
				pushUnique(refs, trimmed(comp.subWorkflowId));
			}
		}
	}
	return refs;
}

/** Ticket types run by the enabled run-ticket steps of workflow nodes (only steps that name a type). */
export function collectRunTicketTypesFromNodes(nodes: unknown): string[] {
	const types: string[] = [];
	for (const node of Array.isArray(nodes) ? nodes : []) {
		const pipeline = isRecord(node) && Array.isArray(node.pipeline) ? node.pipeline : [];
		for (const step of pipeline) {
			if (!isRecord(step) || step.disabled === true) {
				continue;
			}
			if (step.type === 'run_ticket' || step.type === 'run_tickets') {
				pushUnique(types, trimmed(step.ticketType));
			}
			const comp = isRecord(step.component) ? step.component : undefined;
			if (comp && comp.type === 'run_tickets' && comp.disabled !== true) {
				pushUnique(types, trimmed(comp.wfTicketType));
			}
		}
	}
	return types;
}

/** Sub-Workflow references of the enabled Call Sub-Workflow cards of a template. */
export function collectSubWorkflowRefsFromFields(fields: unknown): string[] {
	const refs: string[] = [];
	for (const field of Array.isArray(fields) ? fields : []) {
		if (isRecord(field) && field.type === 'sub_workflow' && field.disabled !== true) {
			pushUnique(refs, trimmed(field.subWorkflowId));
		}
	}
	return refs;
}

/** Ticket types run by the enabled Run Tickets cards of a template (only cards that name a type). */
export function collectRunTicketTypesFromFields(fields: unknown): string[] {
	const types: string[] = [];
	for (const field of Array.isArray(fields) ? fields : []) {
		if (isRecord(field) && field.type === 'run_tickets' && field.disabled !== true) {
			pushUnique(types, trimmed(field.wfTicketType));
		}
	}
	return types;
}

/**
 * Maps every known Sub-Workflow reference (ticket ID and legacy `subwf_...` id) to its canonical ticket ID, so both
 * spellings of the same Sub-Workflow are one vertex / one call chain entry.
 */
export function buildSubWorkflowAliasMap(defs: readonly { id: string; legacyId?: string }[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const def of defs) {
		if (def && def.id) {
			map.set(def.id, def.id);
		}
	}
	for (const def of defs) {
		if (def && def.id && def.legacyId && !map.has(def.legacyId)) {
			map.set(def.legacyId, def.id);
		}
	}
	return map;
}

/** The canonical ticket ID of a Sub-Workflow reference (the reference itself, trimmed, when unknown). */
export function normalizeSubWorkflowReference(reference: string | undefined, aliases: ReadonlyMap<string, string>): string {
	const ref = (reference || '').trim();
	return aliases.get(ref) ?? ref;
}

/** `Name (ID)` for a Sub-Workflow, `Name` for a workflow, `Template 'Name'` for a template. */
export function describeCallGraphNode(kind: SubWorkflowCallGraphNodeKind | 'ticket', name: string | undefined, key: string): string {
	const cleanName = (name || '').trim();
	switch (kind) {
		case 'sub_workflow':
			return cleanName && cleanName !== key ? `${cleanName} (${key})` : key;
		case 'template':
			return `Template '${cleanName || key}'`;
		case 'ticket':
			return `Ticket ${cleanName && cleanName !== key ? `${cleanName} (${key})` : key}`;
		default:
			return cleanName || key;
	}
}

/** `A -> B -> A`. */
export function formatCallChain(chain: readonly { label: string }[]): string {
	return chain.map(c => c.label).join(' -> ');
}

function vertexId(kind: SubWorkflowCallGraphNodeKind, key: string): string {
	return `${kind}:${kind === 'template' ? key.toLowerCase() : key}`;
}

/** A directed "who calls whom" graph. */
export class SubWorkflowCallGraph {
	private readonly _nodes = new Map<string, ISubWorkflowCallGraphNode>();
	private readonly _edges = new Map<string, string[]>();

	/** Adds (or keeps) a vertex and returns its id. */
	addNode(node: ISubWorkflowCallGraphNode): string {
		const id = vertexId(node.kind, node.key);
		if (!this._nodes.has(id)) {
			this._nodes.set(id, node);
		}
		return id;
	}

	addEdge(fromId: string, toId: string): void {
		const list = this._edges.get(fromId) ?? [];
		if (!list.includes(toId)) {
			list.push(toId);
		}
		this._edges.set(fromId, list);
	}

	get size(): number {
		return this._nodes.size;
	}

	/**
	 * The first cycle reachable from `startId` (or from any vertex when omitted), as the chain of vertices with the
	 * first one repeated at the end (`A -> B -> A`, `A -> A` for self-recursion). `undefined` when there is none.
	 */
	findCycle(startId?: string): ISubWorkflowCallGraphNode[] | undefined {
		const state = new Map<string, 'active' | 'done'>();
		const stack: string[] = [];
		const visit = (id: string): string[] | undefined => {
			state.set(id, 'active');
			stack.push(id);
			for (const next of this._edges.get(id) ?? []) {
				const s = state.get(next);
				if (s === 'active') {
					return [...stack.slice(stack.indexOf(next)), next];
				}
				if (s === undefined) {
					const found = visit(next);
					if (found) {
						return found;
					}
				}
			}
			stack.pop();
			state.set(id, 'done');
			return undefined;
		};
		const starts = startId !== undefined ? [startId] : Array.from(this._nodes.keys());
		for (const id of starts) {
			if (!this._nodes.has(id) || state.has(id)) {
				continue;
			}
			const cycle = visit(id);
			if (cycle) {
				return cycle.map(v => this._nodes.get(v)!);
			}
		}
		return undefined;
	}
}

/** Upper bound of vertices one walk resolves, so a huge library can never hang a save. */
const MAX_GRAPH_VERTICES = 500;

/**
 * Walks the call graph from `root` through `resolver` and returns the first cycle reachable from it (see
 * {@link SubWorkflowCallGraph.findCycle}), or `undefined`. Unknown Sub-Workflows / templates are leaves. When `root` is
 * a workflow, Sub-Workflows encapsulated from that workflow are read from its (possibly unsaved) nodes, exactly as the
 * runtime does.
 */
export async function findSubWorkflowCallCycle(root: SubWorkflowCallGraphRoot, resolver: ISubWorkflowCallGraphResolver): Promise<ISubWorkflowCallGraphNode[] | undefined> {
	const graph = new SubWorkflowCallGraph();
	const subCache = new Map<string, ISubWorkflowGraphDefinition | null>();
	const templateCache = new Map<string, ITemplateGraphDefinition | null>();
	const expanded = new Set<string>();
	type Pending = { id: string; nodes?: readonly unknown[]; fields?: readonly unknown[] };
	const queue: Pending[] = [];

	const resolveSub = async (ref: string): Promise<ISubWorkflowGraphDefinition | undefined> => {
		if (!subCache.has(ref)) {
			let def: ISubWorkflowGraphDefinition | undefined;
			try {
				def = await resolver.resolveSubWorkflow(ref);
			} catch {
				def = undefined;
			}
			subCache.set(ref, def ?? null);
		}
		return subCache.get(ref) ?? undefined;
	};
	const resolveTemplate = async (type: string): Promise<ITemplateGraphDefinition | undefined> => {
		if (!resolver.resolveTemplate) {
			return undefined;
		}
		const key = type.toLowerCase();
		if (!templateCache.has(key)) {
			let def: ITemplateGraphDefinition | undefined;
			try {
				def = await resolver.resolveTemplate(type);
			} catch {
				def = undefined;
			}
			templateCache.set(key, def ?? null);
		}
		return templateCache.get(key) ?? undefined;
	};
	const rootWorkflow = root.kind === 'workflow' ? root : undefined;
	const nodesOfSub = (def: ISubWorkflowGraphDefinition): readonly unknown[] => {
		if (rootWorkflow && def.sourceWorkflowUri === rootWorkflow.key && def.nodeIds && def.nodeIds.length > 0) {
			const ids = new Set(def.nodeIds);
			const live = rootWorkflow.nodes.filter(n => isRecord(n) && typeof n.id === 'string' && ids.has(n.id));
			if (live.length > 0) {
				return live;
			}
		}
		return def.nodes;
	};
	const subVertex = async (ref: string): Promise<Pending | undefined> => {
		const def = await resolveSub(ref);
		if (!def) {
			// Unknown reference: a leaf (the runtime reports "not found")
			graph.addNode({ kind: 'sub_workflow', key: ref, label: describeCallGraphNode('sub_workflow', undefined, ref) });
			return undefined;
		}
		const id = graph.addNode({ kind: 'sub_workflow', key: def.id, label: describeCallGraphNode('sub_workflow', def.name, def.id) });
		return { id, nodes: nodesOfSub(def) };
	};
	const templateVertex = async (type: string): Promise<Pending | undefined> => {
		const def = await resolveTemplate(type);
		if (!def) {
			return undefined;
		}
		const id = graph.addNode({ kind: 'template', key: def.id, label: describeCallGraphNode('template', def.name, def.id) });
		return { id, fields: def.fields };
	};

	let rootId: string;
	if (root.kind === 'workflow') {
		rootId = graph.addNode({ kind: 'workflow', key: root.key, label: describeCallGraphNode('workflow', root.label, root.key) });
		queue.push({ id: rootId, nodes: root.nodes });
	} else if (root.kind === 'template') {
		rootId = graph.addNode({ kind: 'template', key: root.key, label: describeCallGraphNode('template', root.label, root.key) });
		queue.push({ id: rootId, fields: root.fields });
	} else {
		const first = await subVertex(root.key);
		if (!first) {
			return undefined;
		}
		rootId = first.id;
		queue.push(first);
	}

	while (queue.length > 0 && graph.size <= MAX_GRAPH_VERTICES) {
		const item = queue.shift()!;
		if (expanded.has(item.id)) {
			continue;
		}
		expanded.add(item.id);
		const subRefs = item.nodes ? collectSubWorkflowRefsFromNodes(item.nodes) : collectSubWorkflowRefsFromFields(item.fields);
		const ticketTypes = item.nodes ? collectRunTicketTypesFromNodes(item.nodes) : collectRunTicketTypesFromFields(item.fields);
		for (const ref of subRefs) {
			const next = await subVertex(ref);
			const toId = next?.id ?? vertexId('sub_workflow', ref);
			graph.addEdge(item.id, toId);
			if (next && !expanded.has(next.id)) {
				queue.push(next);
			}
		}
		for (const type of ticketTypes) {
			const next = await templateVertex(type);
			if (next) {
				graph.addEdge(item.id, next.id);
				if (!expanded.has(next.id)) {
					queue.push(next);
				}
			}
		}
	}
	return graph.findCycle(rootId);
}

/** Error of the up-front check (save / run start). */
export function formatSubWorkflowCycleError(cycle: readonly { label: string }[]): string {
	return `Sub-workflow call cycle: ${formatCallChain(cycle)}. Recursion is not allowed; remove one of these Call Sub-Workflow steps.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime call chain
// ---------------------------------------------------------------------------------------------------------------------

/** One entry of a runtime call chain. */
export interface ISubWorkflowCallFrame {
	readonly kind: 'workflow' | 'sub_workflow' | 'ticket';
	/** Workflow URI, canonical Sub-Workflow ticket ID, or ticket id. */
	readonly key: string;
	readonly label: string;
	/** Other ids of the same Sub-Workflow (its legacy `subwf_...` id). */
	readonly aliases?: readonly string[];
}

/** Shared by every frame of one top-level run: set once a guard stopped the run. */
export interface ISubWorkflowCallAbortState {
	error?: string;
}

/** The call chain an invocation carries: who called whom, from the top-level run down to the caller. */
export interface ISubWorkflowCallChain {
	readonly frames: readonly ISubWorkflowCallFrame[];
	/** The workflow run that made the call (for log forwarding); absent for a ticket run outside a workflow. */
	readonly parentRunId?: string;
	readonly abort: ISubWorkflowCallAbortState;
}

export function createSubWorkflowCallChain(root?: ISubWorkflowCallFrame, parentRunId?: string): ISubWorkflowCallChain {
	return { frames: root ? [root] : [], parentRunId, abort: {} };
}

/** A new chain with `frame` appended; the abort state stays shared with `chain`. */
export function extendSubWorkflowCallChain(chain: ISubWorkflowCallChain, frame: ISubWorkflowCallFrame, parentRunId?: string): ISubWorkflowCallChain {
	return { frames: [...chain.frames, frame], parentRunId: parentRunId ?? chain.parentRunId, abort: chain.abort };
}

/** The same chain (shared abort state), only with another calling run. */
export function withSubWorkflowCallParentRun(chain: ISubWorkflowCallChain, parentRunId: string | undefined): ISubWorkflowCallChain {
	return { frames: chain.frames, parentRunId, abort: chain.abort };
}

/** Number of nested Sub-Workflow calls on a chain. */
export function getSubWorkflowCallDepth(frames: readonly ISubWorkflowCallFrame[]): number {
	return frames.filter(f => f.kind === 'sub_workflow').length;
}

function sameCallTarget(a: ISubWorkflowCallFrame, b: ISubWorkflowCallFrame): boolean {
	if (a.kind !== b.kind || a.kind === 'ticket') {
		return false;
	}
	if (a.key === b.key) {
		return true;
	}
	if (a.kind !== 'sub_workflow') {
		return false;
	}
	const aIds = [a.key, ...(a.aliases ?? [])];
	const bIds = [b.key, ...(b.aliases ?? [])];
	return aIds.some(id => !!id && bIds.includes(id));
}

/**
 * Runtime guard: the error that stops the run when calling `next` after `frames` is recursion (the same Sub-Workflow, or
 * the same workflow, is already on the chain) or nests deeper than `maxDepth` Sub-Workflow calls. `undefined` = allowed.
 */
export function checkSubWorkflowCall(frames: readonly ISubWorkflowCallFrame[], next: ISubWorkflowCallFrame, maxDepth: number = MAX_SUB_WORKFLOW_CALL_DEPTH): string | undefined {
	const fullChain = [...frames, next];
	const repeatIndex = frames.findIndex(f => sameCallTarget(f, next));
	if (repeatIndex >= 0) {
		return `Sub-workflow recursion is not allowed: ${formatCallChain(fullChain.slice(repeatIndex))} (call chain: ${formatCallChain(fullChain)}). The run was stopped.`;
	}
	if (next.kind === 'sub_workflow' && getSubWorkflowCallDepth(fullChain) > maxDepth) {
		return `Sub-workflow nesting is too deep (more than ${maxDepth} levels): ${formatCallChain(fullChain)}. The run was stopped.`;
	}
	return undefined;
}

/** A frame for a Sub-Workflow call. */
export function subWorkflowCallFrame(def: { id: string; legacyId?: string; name: string }): ISubWorkflowCallFrame {
	return {
		kind: 'sub_workflow',
		key: def.id,
		label: describeCallGraphNode('sub_workflow', def.name, def.id),
		aliases: def.legacyId && def.legacyId !== def.id ? [def.legacyId] : undefined
	};
}

/** Case / separator insensitive template lookup by ticket type (template id or name), like the ticket runtime. */
export function findTemplateByTicketType<T extends { id: string; name: string }>(templates: readonly T[], ticketType: string): T | undefined {
	const lower = (ticketType || '').trim().toLowerCase();
	if (!lower) {
		return undefined;
	}
	const exact = templates.find(t => (t.id || '').toLowerCase() === lower || (t.name || '').toLowerCase() === lower);
	if (exact) {
		return exact;
	}
	const norm = lower.replace(/[-_\s]+/g, '_');
	return templates.find(t => (t.id || '').trim().toLowerCase().replace(/[-_\s]+/g, '_') === norm || (t.name || '').trim().toLowerCase().replace(/[-_\s]+/g, '_') === norm);
}
