/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { isSubtreeNodeVisible, ITicketSubtreeNode } from './ticketSubtreeCount.js';

/**
 * Status filter with ancestor paths (UI-35).
 *
 * The status filter of the Workspaces tree (UI-15 / UI-16) shows every ticket whose status category is selected, at
 * any depth, like the deep search (UI-21) shows its matches:
 * - `match`: the ticket's own category is selected; it is shown normally.
 * - `path`: the ticket does not match itself but has matching tickets below it; it is shown dimmed as path context
 *   (and auto-expanded) so the matches below stay reachable.
 * - `hidden`: neither the ticket nor anything below it matches; the whole branch is hidden.
 *
 * Whether matches exist below a ticket comes from the cached sub-tree summary (UI-17 / UI-21 scan), so collapsed and
 * not yet loaded branches are judged without expanding them. Removed tickets follow "show removed items" as before:
 * when that is off they and their sub-trees are not part of the tree at all.
 */

export type StatusFilterRole = 'match' | 'path' | 'hidden';

export interface IStatusFilterVerdict {
	readonly role: StatusFilterRole;
	/** Matching tickets below this ticket (all levels). */
	readonly matchingBelow: number;
	/** Tickets hidden with this branch: the ticket plus its descendants when `role` is `hidden`, otherwise 0. */
	readonly hiddenTickets: number;
}

function isExcluded(node: ITicketSubtreeNode, includeRemoved: boolean): boolean {
	return node.removed && !includeRemoved;
}

/** Whether the ticket's own status category passes the filter (tickets without a status always do). */
export function matchesStatusFilter(node: ITicketSubtreeNode, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): boolean {
	return isSubtreeNodeVisible(node, hidden, includeRemoved);
}

/** Matching tickets below `node` at any depth, regardless of whether the tickets between match. */
export function countMatchingBelow(node: ITicketSubtreeNode, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): number {
	return countMatchingIn(node.children, hidden, includeRemoved);
}

/** Matching tickets among `nodes` and their descendants (all levels). */
export function countMatchingIn(nodes: readonly ITicketSubtreeNode[], hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): number {
	let count = 0;
	for (const node of nodes) {
		if (isExcluded(node, includeRemoved)) {
			continue;
		}
		if (matchesStatusFilter(node, hidden, includeRemoved)) {
			count++;
		}
		count += countMatchingIn(node.children, hidden, includeRemoved);
	}
	return count;
}

/** The ticket plus all its descendants that are part of the tree (removed ones only with "show removed items"). */
export function countTicketsInBranch(node: ITicketSubtreeNode, includeRemoved: boolean): number {
	if (isExcluded(node, includeRemoved)) {
		return 0;
	}
	let count = 1;
	for (const child of node.children) {
		count += countTicketsInBranch(child, includeRemoved);
	}
	return count;
}

/**
 * Role of a ticket under the filter. `selfMatches` overrides the summary's own category when the caller knows a
 * fresher status (the tree row's); the descendants always come from the summary node.
 */
export function classifyStatusFilterNode(node: ITicketSubtreeNode, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean, selfMatches?: boolean): IStatusFilterVerdict {
	if (isExcluded(node, includeRemoved)) {
		return { role: 'hidden', matchingBelow: 0, hiddenTickets: 0 };
	}
	const matchingBelow = countMatchingBelow(node, hidden, includeRemoved);
	if (selfMatches ?? matchesStatusFilter(node, hidden, includeRemoved)) {
		return { role: 'match', matchingBelow, hiddenTickets: 0 };
	}
	if (matchingBelow > 0) {
		return { role: 'path', matchingBelow, hiddenTickets: 0 };
	}
	return { role: 'hidden', matchingBelow: 0, hiddenTickets: countTicketsInBranch(node, includeRemoved) };
}

export interface IStatusFilterPathResult<T> {
	/** The shown items, in their original order. */
	readonly visible: T[];
	/** Verdict per shown ticket; items that are not tickets / have no status have none (always shown). */
	readonly verdicts: Map<T, IStatusFilterVerdict>;
	/** Tickets hidden at this level: each hidden branch counts its ticket plus its descendants. */
	readonly hiddenCount: number;
}

/**
 * Splits one tree level for the filter. `categoryOf` returns an item's status category, or undefined for items that
 * are not tickets / have no status (always shown). `nodeOf` returns the item's node in the parent's sub-tree summary;
 * without one (summary not ready yet) only the item's own status decides, like before UI-35.
 * With nothing hidden every item is shown.
 */
export function applyStatusFilterWithPaths<T>(
	items: readonly T[],
	hidden: ReadonlySet<CanonicalStatusCategory>,
	includeRemoved: boolean,
	categoryOf: (item: T) => CanonicalStatusCategory | undefined,
	nodeOf: (item: T) => ITicketSubtreeNode | undefined
): IStatusFilterPathResult<T> {
	const verdicts = new Map<T, IStatusFilterVerdict>();
	if (hidden.size === 0) {
		return { visible: items.slice(), verdicts, hiddenCount: 0 };
	}
	const visible: T[] = [];
	let hiddenCount = 0;
	for (const item of items) {
		const category = categoryOf(item);
		if (!category) {
			visible.push(item);
			continue;
		}
		const selfMatches = !hidden.has(category);
		const node = nodeOf(item);
		const verdict: IStatusFilterVerdict = node
			? classifyStatusFilterNode(node, hidden, includeRemoved, selfMatches)
			: selfMatches ? { role: 'match', matchingBelow: 0, hiddenTickets: 0 } : { role: 'hidden', matchingBelow: 0, hiddenTickets: 1 };
		if (verdict.role === 'hidden') {
			// an excluded removed node still occupies a row only when the scan listed it; count it as one
			hiddenCount += Math.max(1, verdict.hiddenTickets);
		} else {
			visible.push(item);
			verdicts.set(item, verdict);
		}
	}
	return { visible, verdicts, hiddenCount };
}

/** Tooltip of a path-context row: "Status Todo — shown because 12 tickets below match the filter". */
export function describeFilterPathRow(status: string | undefined, matchingBelow: number): string {
	const what = `${matchingBelow} ticket${matchingBelow === 1 ? '' : 's'} below ${matchingBelow === 1 ? 'matches' : 'match'}`;
	return `Status ${status || '(none)'} — shown because ${what} the filter`;
}
