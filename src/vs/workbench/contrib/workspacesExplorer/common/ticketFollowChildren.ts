/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { readTopLevelMetadata } from './workspaceLifecycle.js';
import { classifyTestResult } from './ticketFailure.js';
import { DependencyEvaluation, FOLLOW_DEPENDENCIES_FIELD_KEY, IOutcomeRecord, removeTicketLinkSectionLine, setTicketLinkSectionLine } from './ticketDependencies.js';

/**
 * Follow Children (CI-62): a ticket's direct child tickets count as implicit dependencies, next to its explicit
 * Depends On (CI-59). When a child's Status or Result changes, the parent is re-evaluated:
 * - all counted children and dependencies succeeded (at least one) → the parent's "on successful run" status
 *   (CI-58, default Done), Result Pass for a test-case parent;
 * - any failed → its "on failed run" status (default Blocked), Result Fail;
 * - otherwise → no change.
 *
 * A child's outcome: a test case (it has a Result field) follows its Result (Pass / Fail; anything else is
 * unfinished); any other child follows its status category (Done → success; Blocked or the UI-20 failing marker →
 * failure; Todo / In Progress → unfinished). Removed children are ignored. Explicit Depends On entries keep the CI-59
 * run-outcome semantics, except that a test-case dependency's Pass / Fail Result counts first.
 *
 * Independent from Parent (CI-64): a child with `- **Independent from Parent**: Yes` (e.g. a test fixture under a test
 * case) is cut off from its parent's evaluation: it never blocks the parent's completion and its failure never makes
 * the parent fail. Explicit Depends On entries are not affected (a ticket listed explicitly still counts).
 *
 * Guard against surprising mass changes: a failure that only comes from children is not applied while most of the
 * counted children are unfinished.
 *
 * This module is the pure part.
 */

/** Per-ticket switch, `On` (default when missing) / `Off`, stored next to "Update Status From Dependencies". */
export const FOLLOW_CHILDREN_FIELD_KEY = 'Follow Children';

/** Ticket types that never change automatically (workspace root tickets). */
export const NEVER_FOLLOWING_TICKET_TYPES: readonly string[] = ['workspace'];

/** Whether the ticket follows its children (missing / anything but off / false / no / 0 → true). */
export function readFollowChildren(ticketMd: string): boolean {
	return isFollowOn(readTopLevelMetadata(ticketMd, FOLLOW_CHILDREN_FIELD_KEY));
}

/** Whether a stored switch value means On (missing → On). */
export function isFollowOn(value: string | undefined): boolean {
	return !['off', 'false', 'no', '0'].includes((value || '').trim().toLowerCase());
}

/** Writes the switch, after "Update Status From Dependencies" (else Depends On, Linked By, Link To). */
export function setFollowChildrenLine(ticketMd: string, follow: boolean): string {
	return setTicketLinkSectionLine(ticketMd, FOLLOW_CHILDREN_FIELD_KEY, follow ? 'On' : 'Off', [FOLLOW_DEPENDENCIES_FIELD_KEY, 'Depends On', 'Linked By', 'Link To']);
}

/** Per-ticket flag (CI-64), `Yes` / absent (or `No`, default): the ticket does not count toward its parent. */
export const INDEPENDENT_FROM_PARENT_FIELD_KEY = 'Independent from Parent';

/** Whether a stored flag value means Yes (missing → No). */
export function isIndependentValue(value: string | undefined): boolean {
	return ['yes', 'on', 'true', '1'].includes((value || '').trim().toLowerCase());
}

/** Whether the ticket is independent from its parent (CI-64). */
export function readIndependentFromParent(ticketMd: string): boolean {
	return isIndependentValue(readTopLevelMetadata(ticketMd, INDEPENDENT_FROM_PARENT_FIELD_KEY));
}

/**
 * Writes the flag: `Yes` after the Follow Children / Depends On block (else Linked By, Link To, the end); turning it
 * off removes the line (absent = No), so the ticket.md is back to what it was.
 */
export function setIndependentFromParentLine(ticketMd: string, independent: boolean): string {
	return independent
		? setTicketLinkSectionLine(ticketMd, INDEPENDENT_FROM_PARENT_FIELD_KEY, 'Yes', [FOLLOW_CHILDREN_FIELD_KEY, FOLLOW_DEPENDENCIES_FIELD_KEY, 'Depends On', 'Linked By', 'Link To'])
		: removeTicketLinkSectionLine(ticketMd, INDEPENDENT_FROM_PARENT_FIELD_KEY);
}

export type FollowedOutcome = 'success' | 'failed' | 'unfinished';

export interface IChildOutcomeInput {
	/** The Result field value; undefined when the child is not a test case (has no Result field). */
	readonly resultValue?: string;
	/** Category of the child's status. */
	readonly statusCategory?: CanonicalStatusCategory;
	/** The UI-20 failing marker (a failed last run, not cleared). */
	readonly failing?: boolean;
	/** Independent from Parent (CI-64): the child does not count toward its parent. */
	readonly independent?: boolean;
}

/** A child's outcome for its parent; 'ignored' for a Removed child or one independent from its parent (CI-64). */
export function childOutcome(input: IChildOutcomeInput): FollowedOutcome | 'ignored' {
	if (input.statusCategory === 'Removed' || input.independent) {
		return 'ignored';
	}
	if (input.resultValue !== undefined) {
		const state = classifyTestResult(input.resultValue);
		return state === 'passed' ? 'success' : state === 'failed' ? 'failed' : 'unfinished';
	}
	if (input.failing || input.statusCategory === 'Blocked') {
		return 'failed';
	}
	return input.statusCategory === 'Done' ? 'success' : 'unfinished';
}

/**
 * An explicit dependency's outcome: a test case's Pass / Fail Result first, else its latest run outcome (CI-59),
 * else unfinished (never ran).
 */
export function explicitDependencyOutcome(run: IOutcomeRecord | undefined, resultValue?: string): FollowedOutcome {
	if (resultValue !== undefined) {
		const state = classifyTestResult(resultValue);
		if (state === 'passed') {
			return 'success';
		}
		if (state === 'failed') {
			return 'failed';
		}
	}
	return run ? run.status : 'unfinished';
}

export interface IFollowedState {
	readonly id: string;
	readonly outcome: FollowedOutcome;
}

function list(ids: readonly string[]): string {
	return ids.join(', ');
}

/**
 * The combined outcome of a ticket's counted children and explicit dependencies (already filtered: no Removed
 * children; empty lists when a switch is off). Summaries read like "All 2 children passed (ANYAG-0162, ANYAG-0163)".
 */
export function evaluateFollowedTickets(children: readonly IFollowedState[], dependencies: readonly IFollowedState[]): DependencyEvaluation {
	const total = children.length + dependencies.length;
	if (total === 0) {
		return { result: 'none', summary: 'no children or dependencies' };
	}
	const failedChildren = children.filter(c => c.outcome === 'failed').map(c => c.id);
	const failedDeps = dependencies.filter(d => d.outcome === 'failed').map(d => d.id);
	const unfinishedChildren = children.filter(c => c.outcome === 'unfinished').map(c => c.id);
	const unfinishedDeps = dependencies.filter(d => d.outcome === 'unfinished').map(d => d.id);
	if (failedChildren.length > 0 || failedDeps.length > 0) {
		const parts: string[] = [];
		if (failedChildren.length > 0) {
			parts.push(failedChildren.length === 1 ? `Child ${failedChildren[0]} failed` : `Children ${list(failedChildren)} failed`);
		}
		if (failedDeps.length > 0) {
			parts.push(`Depends On ${list(failedDeps)}: last run failed`);
		}
		// guard: never act on children's failures while most of them are unfinished (a dependency failure still counts)
		if (failedDeps.length === 0 && unfinishedChildren.length * 2 > children.length) {
			return { result: 'pending', neverRanIds: [...unfinishedChildren, ...unfinishedDeps], summary: `${parts.join('; ')}, but ${unfinishedChildren.length} of ${children.length} children are unfinished` };
		}
		return { result: 'failed', failedIds: [...failedChildren, ...failedDeps], summary: parts.join('; ') };
	}
	const unfinished = [...unfinishedChildren, ...unfinishedDeps];
	if (unfinished.length > 0) {
		return { result: 'pending', neverRanIds: unfinished, summary: `${list(unfinished)} unfinished` };
	}
	const childIds = children.map(c => c.id);
	const depIds = dependencies.map(d => d.id);
	if (depIds.length === 0) {
		return { result: 'success', summary: childIds.length === 1 ? `Child ${childIds[0]} passed` : `All ${childIds.length} children passed (${list(childIds)})` };
	}
	if (childIds.length === 0) {
		return { result: 'success', summary: `All ${depIds.length} dependenc${depIds.length === 1 ? 'y' : 'ies'} succeeded (${list(depIds)})` };
	}
	return { result: 'success', summary: `All ${total} passed (children ${list(childIds)}; Depends On ${list(depIds)})` };
}

/** Whether a ticket may change automatically at all: not a workspace root ticket, not Removed. */
export function canFollow(ticketType: string | undefined, statusCategory: CanonicalStatusCategory | undefined): boolean {
	return !NEVER_FOLLOWING_TICKET_TYPES.includes((ticketType || '').trim().toLowerCase()) && statusCategory !== 'Removed';
}

/**
 * The tickets to re-evaluate after `changedId` changed: its parent (when it follows children, checked when it is
 * evaluated) and, when its Result changed, the tickets depending on it explicitly (a test-case dependency's Result
 * counts). A plain status change of an explicit dependency is not an outcome (CI-59 follows runs).
 */
export function followersAfterTicketChange(changedId: string, parentOf: ReadonlyMap<string, string>, dependents: ReadonlyMap<string, readonly string[]>, resultChanged: boolean): string[] {
	const out: string[] = [];
	const parent = parentOf.get(changedId);
	if (parent) {
		out.push(parent);
	}
	if (resultChanged) {
		for (const id of dependents.get(changedId) ?? []) {
			if (!out.includes(id)) {
				out.push(id);
			}
		}
	}
	return out;
}

/** The propagation graph: ticket → its explicit dependents and its parent. */
export function buildFollowersIndex(dependents: ReadonlyMap<string, readonly string[]>, parentOf: ReadonlyMap<string, string>): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const [id, list] of dependents) {
		index.set(id, [...list]);
	}
	for (const [child, parent] of parentOf) {
		const l = index.get(child) ?? [];
		if (!l.includes(parent)) {
			l.push(parent);
		}
		index.set(child, l);
	}
	return index;
}
