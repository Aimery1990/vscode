/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readTopLevelMetadata } from './workspaceLifecycle.js';

/**
 * Depends On (CI-59): a ticket can declare the tickets it depends on (`- **Depends On**: ANYAG-0120, ANYAG-0122` in
 * ticket.md, next to Link To / Linked By). When a depended-on ticket gets a new run outcome, every ticket depending on
 * it is re-evaluated:
 * - all dependencies' latest outcomes succeeded → the dependent's "on successful run" status (CI-58, default Done);
 * - any dependency's latest outcome failed → its "on failed run" status (default Blocked), even when it was Done;
 * - otherwise (some dependency never ran) → no change.
 * A test-case style Result field becomes Pass / Fail as well. A dependency-driven change is itself an outcome (a
 * "derived" one) for the tickets depending on that ticket, so chains propagate (cycle-safe, depth-limited).
 *
 * This module is the pure part: the ticket.md lines, outcomes and the evaluation / propagation logic.
 */

export const DEPENDS_ON_FIELD_KEY = 'Depends On';
/** Per-ticket switch, `On` (default when missing) / `Off`. */
export const FOLLOW_DEPENDENCIES_FIELD_KEY = 'Update Status From Dependencies';
/** File of a derived outcome (a dependency-driven change), next to last_run.json. */
export const DEPENDENCY_OUTCOME_FILE_NAME = 'dependency_outcome.json';
/** How many dependency levels a single outcome propagates through. */
export const MAX_DEPENDENCY_DEPTH = 8;

const TICKET_ID_RE = /[A-Za-z][A-Za-z0-9]*-\d+/g;

/** The ticket IDs of a Depends On value ("ANYAG-0120, ANYAG-0122", "None", ...): upper case, unique, in order. */
export function parseDependsOn(value: string | undefined): string[] {
	if (!value || /^\s*none\s*$/i.test(value)) {
		return [];
	}
	const ids: string[] = [];
	for (const m of value.match(TICKET_ID_RE) ?? []) {
		const id = m.toUpperCase();
		if (!ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids;
}

/** The Depends On IDs of a ticket.md text. */
export function readDependsOn(ticketMd: string): string[] {
	return parseDependsOn(readTopLevelMetadata(ticketMd, DEPENDS_ON_FIELD_KEY));
}

/** Whether the ticket follows its dependencies (missing / anything but off / false / no → true). */
export function readFollowDependencies(ticketMd: string): boolean {
	const v = (readTopLevelMetadata(ticketMd, FOLLOW_DEPENDENCIES_FIELD_KEY) || '').trim().toLowerCase();
	return !['off', 'false', 'no', '0'].includes(v);
}

/**
 * Sets a top-level `- **Key**: value` line of ticket.md: replaces the first one, else inserts it after the Depends On
 * line (else Linked By, else Link To, else at the end).
 */
export function setTicketLinkSectionLine(ticketMd: string, key: string, value: string, anchorKeys: readonly string[] = ['Depends On', 'Linked By', 'Link To']): string {
	const eol = ticketMd.includes('\r\n') ? '\r\n' : '\n';
	const lines = ticketMd.split(/\r?\n/);
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:`);
	const line = `- **${key}**: ${value}`;
	const idx = lines.findIndex(l => re.test(l));
	if (idx !== -1) {
		lines[idx] = line;
		return lines.join(eol);
	}
	const anchorIdx = anchorKeys.map(k => new RegExp(`^-\\s*\\*\\*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:`)).map(r => lines.findIndex(l => r.test(l))).find(i => i !== -1);
	if (anchorIdx !== undefined) {
		lines.splice(anchorIdx + 1, 0, line);
		return lines.join(eol);
	}
	const trimmedEnd = ticketMd.replace(/\s+$/, '');
	return `${trimmedEnd}${eol}${line}${eol}`;
}

/** Removes every top-level `- **Key**:` line of ticket.md (unchanged when there is none). */
export function removeTicketLinkSectionLine(ticketMd: string, key: string): string {
	const eol = ticketMd.includes('\r\n') ? '\r\n' : '\n';
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:`);
	const lines = ticketMd.split(/\r?\n/);
	const kept = lines.filter(l => !re.test(l));
	return kept.length === lines.length ? ticketMd : kept.join(eol);
}

/** Writes the Depends On list ("None" when empty). */
export function setDependsOnLine(ticketMd: string, ids: readonly string[]): string {
	return setTicketLinkSectionLine(ticketMd, DEPENDS_ON_FIELD_KEY, ids.length > 0 ? ids.join(', ') : 'None');
}

/** Writes the per-ticket switch. */
export function setFollowDependenciesLine(ticketMd: string, follow: boolean): string {
	return setTicketLinkSectionLine(ticketMd, FOLLOW_DEPENDENCIES_FIELD_KEY, follow ? 'On' : 'Off');
}

// ---------------------------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------------------------

export type DependencyOutcomeStatus = 'success' | 'failed';

/** One outcome record of a ticket: its own run (last_run.json / workflow_runs.json) or a derived one. */
export interface IOutcomeRecord {
	readonly status: DependencyOutcomeStatus;
	/** Epoch ms. */
	readonly at: number;
	readonly source: 'run' | 'workflow' | 'derived';
}

/** `.agents/dependency_outcome.json`. */
export interface IDerivedOutcomeFile {
	readonly status: 'Completed' | 'Failed';
	readonly at: string;
	/** The dependency whose outcome caused it. */
	readonly from?: string;
}

export function parseDerivedOutcome(text: string): IOutcomeRecord | undefined {
	try {
		const raw = JSON.parse(text);
		const at = typeof raw?.at === 'string' ? Date.parse(raw.at) : NaN;
		if ((raw?.status === 'Completed' || raw?.status === 'Failed') && !isNaN(at)) {
			return { status: raw.status === 'Completed' ? 'success' : 'failed', at, source: 'derived' };
		}
	} catch {
		// not a record
	}
	return undefined;
}

export function serializeDerivedOutcome(status: DependencyOutcomeStatus, at: Date, from: string): string {
	const file: IDerivedOutcomeFile = { status: status === 'success' ? 'Completed' : 'Failed', at: at.toISOString(), from };
	return JSON.stringify(file, null, '\t') + '\n';
}

/** The latest of a ticket's outcome records (own run, workflow run, derived), or undefined when it never ran. */
export function latestOutcome(records: readonly (IOutcomeRecord | undefined)[]): IOutcomeRecord | undefined {
	let best: IOutcomeRecord | undefined;
	for (const r of records) {
		if (r && !isNaN(r.at) && (!best || r.at >= best.at)) {
			best = r;
		}
	}
	return best;
}

/** A workflow run status (workflow_runs.json) as an outcome: completed / failed count, anything else does not. */
export function workflowRunOutcome(status: string | undefined, at: number | undefined): IOutcomeRecord | undefined {
	const s = (status || '').toLowerCase();
	if ((s !== 'completed' && s !== 'failed') || at === undefined) {
		return undefined;
	}
	return { status: s === 'completed' ? 'success' : 'failed', at, source: 'workflow' };
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------

export interface IDependencyState {
	readonly id: string;
	/** Latest outcome, undefined: never ran (or not found). */
	readonly outcome: IOutcomeRecord | undefined;
}

export type DependencyEvaluation =
	| { readonly result: 'success'; readonly summary: string }
	| { readonly result: 'failed'; readonly failedIds: readonly string[]; readonly summary: string }
	| { readonly result: 'pending'; readonly neverRanIds: readonly string[]; readonly summary: string }
	| { readonly result: 'none'; readonly summary: string };

/**
 * The combined outcome of a ticket's dependencies: any latest failure → failed; else any never run → pending (no
 * change); else success. No dependencies → none.
 */
export function evaluateDependencies(deps: readonly IDependencyState[]): DependencyEvaluation {
	if (deps.length === 0) {
		return { result: 'none', summary: 'no dependencies' };
	}
	const failed = deps.filter(d => d.outcome?.status === 'failed').map(d => d.id);
	if (failed.length > 0) {
		return { result: 'failed', failedIds: failed, summary: `${failed.join(', ')}: last run failed` };
	}
	const neverRan = deps.filter(d => !d.outcome).map(d => d.id);
	if (neverRan.length > 0) {
		return { result: 'pending', neverRanIds: neverRan, summary: `${neverRan.join(', ')} never ran` };
	}
	return { result: 'success', summary: `all ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} succeeded` };
}

/** Result field value for an evaluation ('Pass' / 'Fail'), or undefined when it stays. */
export function resultValueFor(evaluation: DependencyEvaluation): 'Pass' | 'Fail' | undefined {
	return evaluation.result === 'success' ? 'Pass' : evaluation.result === 'failed' ? 'Fail' : undefined;
}

/** Reverse index: dependency ID → IDs of the tickets that depend on it (upper case). */
export function buildDependentsIndex(dependsOn: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const [ticketId, deps] of dependsOn) {
		for (const dep of deps) {
			const list = index.get(dep) ?? [];
			if (!list.includes(ticketId)) {
				list.push(ticketId);
			}
			index.set(dep, list);
		}
	}
	return index;
}

/** One step of a propagation: re-evaluate `ticketId` because `triggerId` got a new (own or derived) outcome. */
export interface IPropagationStep {
	readonly ticketId: string;
	readonly triggerId: string;
	readonly depth: number;
}

/**
 * Walks the dependents of `startId` breadth-first. `visit` re-evaluates one dependent and returns whether its own
 * (derived) outcome changed, in which case its dependents are visited too. Every ticket is evaluated at most once
 * (cycles end there, including back at `startId`), and at most `maxDepth` levels deep. `firstLevel` (CI-62) replaces
 * the first level (e.g. only the parent of a ticket whose Status changed). Returns the steps in order.
 */
export async function propagateDependencies(
	startId: string,
	dependents: ReadonlyMap<string, readonly string[]>,
	visit: (step: IPropagationStep) => Promise<boolean>,
	maxDepth: number = MAX_DEPENDENCY_DEPTH,
	firstLevel?: readonly string[]
): Promise<IPropagationStep[]> {
	const done: IPropagationStep[] = [];
	const seen = new Set<string>([startId.toUpperCase()]);
	let frontier: IPropagationStep[] = (firstLevel ?? dependents.get(startId.toUpperCase()) ?? []).map(id => ({ ticketId: id.toUpperCase(), triggerId: startId.toUpperCase(), depth: 1 }));
	while (frontier.length > 0) {
		const next: IPropagationStep[] = [];
		for (const step of frontier) {
			if (seen.has(step.ticketId) || step.depth > maxDepth) {
				continue;
			}
			seen.add(step.ticketId);
			done.push(step);
			if (await visit(step)) {
				for (const id of dependents.get(step.ticketId) ?? []) {
					next.push({ ticketId: id, triggerId: step.ticketId, depth: step.depth + 1 });
				}
			}
		}
		frontier = next;
	}
	return done;
}

const RESULT_LINE_RE = /^(\s{1,3}-\s*\*\*(?:Result|Test Result)\*\*:\s?)(.*)$/i;

/** The value of the test result field (`  - **Result**: …`), or undefined when the ticket has none. */
export function readResultFieldValue(ticketMd: string): string | undefined {
	for (const line of ticketMd.split(/\r?\n/)) {
		const m = RESULT_LINE_RE.exec(line);
		if (m) {
			return m[2].trim();
		}
	}
	return undefined;
}

/** Sets the test result field (first `  - **Result**:` / `Test Result` value line); unchanged when there is none. */
export function setResultFieldValue(ticketMd: string, value: string): string {
	const eol = ticketMd.includes('\r\n') ? '\r\n' : '\n';
	const lines = ticketMd.split(/\r?\n/);
	const idx = lines.findIndex(l => RESULT_LINE_RE.test(l));
	if (idx === -1) {
		return ticketMd;
	}
	lines[idx] = lines[idx].replace(RESULT_LINE_RE, (_, prefix) => `${prefix}${value}`);
	return lines.join(eol);
}
