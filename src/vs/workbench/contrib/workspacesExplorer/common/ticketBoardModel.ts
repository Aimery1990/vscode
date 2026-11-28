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

export interface IBuildTicketBoardOptions {
	readonly showRemoved: boolean;
	/** Default true. When false, status columns without cards are left out (and categories left without columns). */
	readonly showEmptyStatuses?: boolean;
}

export function buildTicketBoard<T extends IBoardItemLike>(items: readonly T[], lifecycle: IWorkspaceLifecycleLike, options: IBuildTicketBoardOptions): ITicketBoard<T> {
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
		const allColumns: IBoardStatusColumn<T>[] = statuses.map(status => ({ status, cards: buckets.get(status.toLowerCase()) ?? [], droppable: true }));
		const columns = options.showEmptyStatuses === false ? allColumns.filter(c => c.cards.length > 0) : allColumns;
		if (columns.length === 0 && options.showEmptyStatuses === false) {
			continue;
		}
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

// ---------------------------------------------------------------------------------------------------------------
// Filtering and card text (board redesign)
// ---------------------------------------------------------------------------------------------------------------

export interface IBoardFilterableCard {
	readonly ticketId: string;
	readonly title?: string;
	readonly labels: readonly string[];
}

export interface IBoardFilter {
	/** Matches the title or the ticket ID (case-insensitive substring); blank = no filter. */
	readonly query?: string;
	/** Keeps cards with at least one of these labels (case-insensitive); empty = no filter. */
	readonly labels?: readonly string[];
}

export function isBoardFilterActive(filter: IBoardFilter): boolean {
	return !!(filter.query ?? '').trim() || (filter.labels?.length ?? 0) > 0;
}

export function filterBoardCards<T extends IBoardFilterableCard>(cards: readonly T[], filter: IBoardFilter): T[] {
	const q = (filter.query ?? '').trim().toLowerCase();
	const wanted = (filter.labels ?? []).map(l => l.trim().toLowerCase()).filter(l => !!l);
	return cards.filter(card => {
		if (q && !card.ticketId.toLowerCase().includes(q) && !(card.title ?? '').toLowerCase().includes(q)) {
			return false;
		}
		if (wanted.length > 0 && !card.labels.some(l => wanted.includes(l.trim().toLowerCase()))) {
			return false;
		}
		return true;
	});
}

/** Every label used by the cards, then the defined ones not used, case-insensitively unique (first spelling wins). */
export function collectBoardLabels(cards: readonly IBoardFilterableCard[], defined: readonly string[] = []): string[] {
	const result: string[] = [];
	for (const name of [...cards.flatMap(c => c.labels), ...defined]) {
		const trimmed = name.trim();
		if (trimmed && !result.some(r => sameText(r, trimmed))) {
			result.push(trimmed);
		}
	}
	return result;
}

/** Done / total of a ticket's direct children (removed children are not counted). */
export function countSubtasks(children: readonly { readonly category?: CanonicalStatusCategory; readonly removed: boolean }[]): { readonly done: number; readonly total: number } {
	let done = 0;
	let total = 0;
	for (const child of children) {
		if (child.removed || child.category === 'Removed') {
			continue;
		}
		total++;
		if (child.category === 'Done') {
			done++;
		}
	}
	return { done, total };
}

export type BoardPriorityTone = 'high' | 'muted';

/** "High priority" etc.; Very High / High are highlighted, the rest muted. Missing -> Medium. */
export function describeBoardPriority(priority: string | undefined): { readonly text: string; readonly tone: BoardPriorityTone } {
	const raw = (priority ?? '').trim();
	const level = !raw || raw.toLowerCase() === 'none' ? 'Medium' : raw;
	const lower = level.toLowerCase();
	return { text: `${level} priority`, tone: lower === 'high' || lower === 'very high' ? 'high' : 'muted' };
}

export type BoardCardMetaKind = 'runFailed' | 'testFailed' | 'testPassed' | 'testNotRun' | 'subtasks' | 'none';

/** The left footer text of a card: a failure first, else the test result, else "d / n subtasks". */
export function describeBoardCardMeta(card: { readonly failure?: unknown; readonly testResult?: BoardTestResult; readonly subtasks: { readonly done: number; readonly total: number } }): { readonly kind: BoardCardMetaKind; readonly text: string } {
	if (card.failure || card.testResult === 'failed') {
		return card.testResult === 'failed' ? { kind: 'testFailed', text: 'Test failed' } : { kind: 'runFailed', text: 'Run failed' };
	}
	if (card.testResult === 'passed') {
		return { kind: 'testPassed', text: 'Test passed' };
	}
	if (card.testResult === 'notRun') {
		return { kind: 'testNotRun', text: 'Not run' };
	}
	if (card.subtasks.total > 0) {
		return { kind: 'subtasks', text: `${card.subtasks.done} / ${card.subtasks.total} subtask${card.subtasks.total === 1 ? '' : 's'}` };
	}
	return { kind: 'none', text: '' };
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** The value of a ticket.md metadata field that names an agent, or undefined for empty / None. */
export function cleanAgentName(raw: string | undefined): string | undefined {
	const v = (raw ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
	return v && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'n/a' ? v : undefined;
}
