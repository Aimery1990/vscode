/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { STATUS_CATEGORIES } from './workspaceLifecycle.js';

/**
 * Status-category filter of the Workspaces tree (UI-15, multi-select since UI-16).
 *
 * The set of hidden canonical categories is stored as a JSON array under {@link HIDDEN_STATUS_CATEGORIES_STORAGE_KEY}
 * (profile scope, user target); default: nothing hidden. Tickets whose status maps to a hidden category are hidden
 * together with their sub-tree (custom statuses go by their mapped category). Plain folders, files and tickets
 * without a status are never hidden.
 *
 * The UI-15 boolean "Hide Done & Removed tickets" ({@link LEGACY_HIDE_FINISHED_TICKETS_STORAGE_KEY}) is migrated once:
 * when it was on, the filter starts with Done + Removed hidden.
 */

export const HIDDEN_STATUS_CATEGORIES_STORAGE_KEY = 'anyagent.workspacesExplorer.hiddenStatusCategories';
export const LEGACY_HIDE_FINISHED_TICKETS_STORAGE_KEY = 'anyagent.workspacesExplorer.hideFinishedTickets';

/** The "Hide Done & Removed" preset. */
export const FINISHED_CATEGORIES: readonly CanonicalStatusCategory[] = ['Done', 'Removed'];

/** Parses the stored JSON array; unknown / malformed entries are dropped. Undefined or invalid input → nothing hidden. */
export function parseHiddenCategories(raw: string | undefined): Set<CanonicalStatusCategory> {
	const result = new Set<CanonicalStatusCategory>();
	if (!raw) {
		return result;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (typeof entry === 'string' && (STATUS_CATEGORIES as readonly string[]).includes(entry)) {
					result.add(entry as CanonicalStatusCategory);
				}
			}
		}
	} catch {
		// ignore, treat as nothing hidden
	}
	return result;
}

/** Serializes in canonical category order, so equal sets give equal strings. */
export function serializeHiddenCategories(hidden: ReadonlySet<CanonicalStatusCategory>): string {
	return JSON.stringify(STATUS_CATEGORIES.filter(c => hidden.has(c)));
}

/**
 * Initial hidden set: the stored set when present, otherwise derived from the legacy boolean
 * (on → Done + Removed hidden, off / missing → nothing hidden).
 */
export function resolveHiddenCategories(raw: string | undefined, legacyHideFinished: boolean | undefined): Set<CanonicalStatusCategory> {
	if (raw !== undefined) {
		return parseHiddenCategories(raw);
	}
	return new Set(legacyHideFinished ? FINISHED_CATEGORIES : []);
}

/** Returns a new set with `category` toggled. */
export function toggleHiddenCategory(hidden: ReadonlySet<CanonicalStatusCategory>, category: CanonicalStatusCategory): Set<CanonicalStatusCategory> {
	const next = new Set(hidden);
	if (next.has(category)) {
		next.delete(category);
	} else {
		next.add(category);
	}
	return next;
}

export interface IStatusFilterResult<T> {
	readonly visible: T[];
	readonly hiddenCount: number;
}

/**
 * Splits `items` for the filter. `categoryOf` returns the status category of a ticket, or undefined for items that
 * are not tickets / have no status (always visible). With an empty hidden set everything is visible.
 */
export function applyStatusFilter<T>(items: readonly T[], hidden: ReadonlySet<CanonicalStatusCategory>, categoryOf: (item: T) => CanonicalStatusCategory | undefined): IStatusFilterResult<T> {
	if (hidden.size === 0) {
		return { visible: items.slice(), hiddenCount: 0 };
	}
	const visible: T[] = [];
	let hiddenCount = 0;
	for (const item of items) {
		const category = categoryOf(item);
		if (category && hidden.has(category)) {
			hiddenCount++;
		} else {
			visible.push(item);
		}
	}
	return { visible, hiddenCount };
}

/** The muted line shown under a parent's children when some were hidden, or undefined when none. */
export function describeHiddenTickets(hiddenCount: number): string | undefined {
	if (hiddenCount <= 0) {
		return undefined;
	}
	return `${hiddenCount} ticket${hiddenCount === 1 ? '' : 's'} hidden by status filter`;
}

/** Tooltip of the filter button. */
export function describeStatusFilter(hidden: ReadonlySet<CanonicalStatusCategory>): string {
	const names = STATUS_CATEGORIES.filter(c => hidden.has(c));
	return names.length ? `Filter by status (hiding: ${names.join(', ')})` : 'Filter by status';
}
