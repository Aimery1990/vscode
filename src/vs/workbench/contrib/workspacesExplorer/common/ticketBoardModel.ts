/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { STATUS_CATEGORIES } from './workspaceLifecycle.js';
import { IWorkspaceLifecycleLike } from './ticketStatusPicker.js';

/**
 * Board (kanban) view of a ticket's direct child tickets (UI-25): the pure grouping.
 *
 * - One group per canonical category in canonical order (Todo, In Progress, Done, Blocked, then Removed only when
 *   `showRemoved`). The category capsule of the strip spans the group.
 * - Inside a group, one status column (its own rectangle) per lifecycle status of that category, lifecycle order.
 *   A group with exactly one status named like the category shows no status header (the capsule says it all).
 * - A group's width weight is its number of status columns (at least 1).
 * - A child whose status is missing or not part of the lifecycle goes to a trailing "Other" group.
 * - Removed children (`removed`, or status in the Removed category) are left out unless `showRemoved`.
 * Cards keep their input order inside a column.
 */

export const OTHER_BOARD_GROUP = 'Other';

export type BoardGroupKind = CanonicalStatusCategory | typeof OTHER_BOARD_GROUP;

export interface IBoardItemLike {
	readonly status?: string;
	/** Hidden unless "show removed" (same rule as the tree's scan). */
	readonly removed?: boolean;
}

export interface IBoardStatusColumn<T> {
	/** The lifecycle spelling of the status; for the Other group, "Other". */
	readonly status: string;
	readonly cards: readonly T[];
	/** False when the column is a drop target only by status (Other: not a drop target). */
	readonly droppable: boolean;
}

export interface IBoardGroup<T> {
	readonly kind: BoardGroupKind;
	readonly columns: readonly IBoardStatusColumn<T>[];
	/** False when the group has one status named like its category (no redundant status header). */
	readonly showStatusHeaders: boolean;
	/** Number of cards in the group. */
	readonly count: number;
	/** flex-grow of the group: its number of status columns (at least 1). */
	readonly weight: number;
}

export interface ITicketBoard<T> {
	readonly groups: readonly IBoardGroup<T>[];
	/** Children left out because they are removed and "show removed" is off. */
	readonly hiddenRemovedCount: number;
	readonly total: number;
}

function sameText(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The lifecycle statuses grouped by category (lifecycle order, duplicates dropped case-insensitively). */
export function groupLifecycleStatuses(lifecycle: IWorkspaceLifecycleLike): { [cat in CanonicalStatusCategory]: string[] } {
	const map: { [cat in CanonicalStatusCategory]: string[] } = { 'Todo': [], 'In Progress': [], 'Done': [], 'Blocked': [], 'Removed': [] };
	const seen: string[] = [];
	for (const raw of lifecycle.statuses) {
		const status = raw.trim();
		if (!status || seen.some(s => sameText(s, status))) {
			continue;
		}
		seen.push(status);
		map[lifecycle.getCategory(status)].push(status);
	}
	return map;
}

export function buildTicketBoard<T extends IBoardItemLike>(items: readonly T[], lifecycle: IWorkspaceLifecycleLike, options: { readonly showRemoved: boolean }): ITicketBoard<T> {
	const byCategory = groupLifecycleStatuses(lifecycle);
	const buckets = new Map<string, T[]>();
	const other: T[] = [];
	let hiddenRemovedCount = 0;
	for (const item of items) {
		const status = (item.status ?? '').trim();
		let category: CanonicalStatusCategory | undefined;
		let column: string | undefined;
		for (const cat of STATUS_CATEGORIES) {
			const match = byCategory[cat].find(s => sameText(s, status));
			if (match) {
				category = cat;
				column = match;
				break;
			}
		}
		if (!options.showRemoved && (item.removed || category === 'Removed')) {
			hiddenRemovedCount++;
			continue;
		}
		if (!column) {
			other.push(item);
			continue;
		}
		const key = column.toLowerCase();
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(item);
		} else {
			buckets.set(key, [item]);
		}
	}

	const groups: IBoardGroup<T>[] = [];
	for (const cat of STATUS_CATEGORIES) {
		if (cat === 'Removed' && !options.showRemoved) {
			continue;
		}
		const statuses = byCategory[cat];
		const columns: IBoardStatusColumn<T>[] = statuses.map(status => ({ status, cards: buckets.get(status.toLowerCase()) ?? [], droppable: true }));
		groups.push({
			kind: cat,
			columns,
			showStatusHeaders: !(columns.length === 1 && sameText(columns[0].status, cat)),
			count: columns.reduce((n, c) => n + c.cards.length, 0),
			weight: Math.max(1, columns.length)
		});
	}
	if (other.length > 0) {
		groups.push({
			kind: OTHER_BOARD_GROUP,
			columns: [{ status: OTHER_BOARD_GROUP, cards: other, droppable: false }],
			showStatusHeaders: false,
			count: other.length,
			weight: 1
		});
	}
	return { groups, hiddenRemovedCount, total: items.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Card details
// ---------------------------------------------------------------------------------------------------------------

/** Test result shown on a card of a ticket with a Result field. */
export type BoardTestResult = 'passed' | 'failed' | 'notRun';

/**
 * Classifies a Result field value for the card mark: Pass -> check, Fail -> error, anything else (Not Run, Blocked, empty) -> circle.
 * (Same value sets as UI-23's `classifyTestResult`; once both are merged this can delegate to it.)
 */
export function classifyBoardTestResult(value: string | undefined): BoardTestResult {
	const v = (value ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim().toLowerCase();
	if (v === 'fail' || v === 'failed' || v === 'failure') {
		return 'failed';
	}
	if (v === 'pass' || v === 'passed' || v === 'success') {
		return 'passed';
	}
	return 'notRun';
}

// ---------------------------------------------------------------------------------------------------------------
// Remembered mode
// ---------------------------------------------------------------------------------------------------------------

export type TicketPageMode = 'details' | 'board';

/** Most tickets remembered in Board mode; the oldest entries are dropped beyond this. */
export const MAX_REMEMBERED_BOARD_TICKETS = 500;

/** Parses the stored list of ticket keys in Board mode (unknown shapes -> empty). */
export function parseBoardModeKeys(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
	} catch {
		return [];
	}
}

/** The list after setting `key` to `mode` (Board keys are moved to the end; capped at the newest entries). */
export function updateBoardModeKeys(keys: readonly string[], key: string, mode: TicketPageMode, cap = MAX_REMEMBERED_BOARD_TICKETS): string[] {
	const next = keys.filter(k => k !== key);
	if (mode === 'board') {
		next.push(key);
	}
	return next.length > cap ? next.slice(next.length - cap) : next;
}
