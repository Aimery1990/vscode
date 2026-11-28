/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { CanonicalStatusCategory } from './workspacesExplorer.js';

/**
 * Descendant-ticket counts shown as a small pill after a ticket's title in the Workspaces tree (UI-17).
 *
 * The service scans a ticket folder's sub-tree once into an {@link ITicketSubtreeSummary} (only ticket folders, each
 * with its status category and whether it counts as removed) and caches it. Counting for the current status filter
 * is then a pure in-memory walk, so filter changes need no rescan. Since UI-35 the filter counts the matching tickets
 * at any depth, like the tree shows them (non-matching ancestors of a match stay visible as path context but are not
 * counted).
 *
 * The count mode (all levels / direct children / off) is one global choice for the tree, stored as a string under
 * {@link CHILD_COUNT_MODE_STORAGE_KEY} (profile scope, user target); default: all levels.
 */

export interface ITicketSubtreeNode {
	/** The ticket's status category; undefined when it has no status (never hidden by the status filter). */
	readonly category?: CanonicalStatusCategory;
	/** Hidden unless "show removed items" is on (same rule as the tree's scan). */
	readonly removed: boolean;
	readonly children: readonly ITicketSubtreeNode[];
	/** "ANYAG-0123 Title" (UI-20: names the ticket in its ancestors' failure tooltips). */
	readonly label?: string;
	/** Set when the ticket itself is failing (UI-20, see `ticketFailure.ts`). */
	readonly failure?: { readonly reasons: readonly string[] };
	/** UI-21 (ticket search index): the ticket folder and its ticket.md / README metadata. */
	readonly resource?: URI;
	readonly ticketId?: string;
	readonly title?: string;
	readonly type?: string;
	readonly status?: string;
}

export interface ITicketSubtreeSummary {
	/** The direct child tickets of the summarized folder. */
	readonly children: readonly ITicketSubtreeNode[];
	/** True when the scan stopped at the depth or size cap; the counts are then lower bounds. */
	readonly truncated: boolean;
}

export interface ITicketSubtreeCounts {
	/** Descendants (all levels) matching the status filter (UI-35: at any depth). */
	readonly visible: number;
	/** Descendants (all levels) before the status filter (removed tickets still follow "show removed items"). */
	readonly total: number;
	/** Direct children matching the status filter. */
	readonly directVisible: number;
	readonly directTotal: number;
	readonly truncated: boolean;
}

export type ChildCountMode = 'all' | 'direct' | 'off';

export const CHILD_COUNT_MODE_STORAGE_KEY = 'anyagent.workspacesExplorer.childCountMode';
export const DEFAULT_CHILD_COUNT_MODE: ChildCountMode = 'all';

export const CHILD_COUNT_MODES: readonly { readonly mode: ChildCountMode; readonly label: string }[] = [
	{ mode: 'all', label: 'All Levels' },
	{ mode: 'direct', label: 'Direct Children' },
	{ mode: 'off', label: 'Off' }
];

/** Unknown / missing values fall back to the default (all levels). */
export function parseChildCountMode(raw: string | undefined): ChildCountMode {
	return raw === 'all' || raw === 'direct' || raw === 'off' ? raw : DEFAULT_CHILD_COUNT_MODE;
}

export function isSubtreeNodeVisible(node: ITicketSubtreeNode, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): boolean {
	if (node.removed && !includeRemoved) {
		return false;
	}
	return !(node.category && hidden.has(node.category));
}

/**
 * Matching descendants at any depth (UI-35): a child counts when its own category passes the filter, and its sub-tree
 * is always walked (a non-matching ticket no longer hides the matches below it). Removed tickets are skipped with
 * their sub-tree unless "show removed items" is on, like in the tree's scan.
 */
function countVisible(children: readonly ITicketSubtreeNode[], hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): number {
	let count = 0;
	for (const child of children) {
		if (child.removed && !includeRemoved) {
			continue;
		}
		if (isSubtreeNodeVisible(child, hidden, includeRemoved)) {
			count++;
		}
		count += countVisible(child.children, hidden, includeRemoved);
	}
	return count;
}

function countDirect(children: readonly ITicketSubtreeNode[], hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): number {
	let count = 0;
	for (const child of children) {
		if (isSubtreeNodeVisible(child, hidden, includeRemoved)) {
			count++;
		}
	}
	return count;
}

const NOTHING_HIDDEN: ReadonlySet<CanonicalStatusCategory> = new Set();

export function countSubtree(summary: ITicketSubtreeSummary, hidden: ReadonlySet<CanonicalStatusCategory>, includeRemoved: boolean): ITicketSubtreeCounts {
	const total = countVisible(summary.children, NOTHING_HIDDEN, includeRemoved);
	const directTotal = countDirect(summary.children, NOTHING_HIDDEN, includeRemoved);
	return {
		visible: hidden.size === 0 ? total : countVisible(summary.children, hidden, includeRemoved),
		total,
		directVisible: hidden.size === 0 ? directTotal : countDirect(summary.children, hidden, includeRemoved),
		directTotal,
		truncated: summary.truncated
	};
}

export interface IChildCountPill {
	readonly text: string;
	readonly tooltip: string;
}

/**
 * Pill text and tooltip for `mode`, or undefined when there is nothing to show (mode off, or no child tickets at all
 * for the chosen mode before the filter). A pill showing 0 means every child ticket is hidden by the filter.
 */
export function describeChildCountPill(counts: ITicketSubtreeCounts, mode: ChildCountMode): IChildCountPill | undefined {
	if (mode === 'off') {
		return undefined;
	}
	const relevantTotal = mode === 'all' ? counts.total : counts.directTotal;
	if (relevantTotal <= 0) {
		return undefined;
	}
	const plus = counts.truncated ? '+' : '';
	const value = mode === 'all' ? counts.visible : counts.directVisible;
	const allPart = `All levels: ${counts.visible}${plus} visible (${counts.total}${plus} before filter)`;
	const directPart = `Direct children: ${counts.directVisible} visible (${counts.directTotal})`;
	const modeText = mode === 'all' ? 'All levels' : 'Direct children';
	const ordered = mode === 'all' ? `${allPart} · ${directPart}` : `${directPart} · ${allPart}`;
	return {
		text: mode === 'all' ? `${value}${plus}` : `${value}`,
		tooltip: `Child tickets (${modeText}): ${ordered}${counts.truncated ? ' · scan capped, counts are lower bounds' : ''}`
	};
}
