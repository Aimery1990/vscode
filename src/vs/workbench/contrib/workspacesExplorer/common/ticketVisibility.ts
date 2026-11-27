/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';

/**
 * "Hide Done & Removed tickets" filter of the Workspaces tree (UI-15).
 *
 * The toggle is stored as a boolean under {@link HIDE_FINISHED_TICKETS_STORAGE_KEY} (profile scope, user target);
 * default off. When on, tickets whose status category is Done or Removed are hidden together with their sub-tree.
 * Plain folders, files and tickets without a status are never hidden.
 */

export const HIDE_FINISHED_TICKETS_STORAGE_KEY = 'anyagent.workspacesExplorer.hideFinishedTickets';

export function isFinishedCategory(category: CanonicalStatusCategory | undefined): boolean {
	return category === 'Done' || category === 'Removed';
}

export interface IFinishedFilterResult<T> {
	readonly visible: T[];
	readonly hiddenCount: number;
}

/**
 * Splits `items` for the filter. `categoryOf` returns the status category of a ticket, or undefined for items that
 * are not tickets / have no status (always visible). With the filter off everything is visible.
 */
export function applyFinishedFilter<T>(items: readonly T[], hideFinished: boolean, categoryOf: (item: T) => CanonicalStatusCategory | undefined): IFinishedFilterResult<T> {
	if (!hideFinished) {
		return { visible: items.slice(), hiddenCount: 0 };
	}
	const visible: T[] = [];
	let hiddenCount = 0;
	for (const item of items) {
		if (isFinishedCategory(categoryOf(item))) {
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
	return `${hiddenCount} done / removed ticket${hiddenCount === 1 ? '' : 's'} hidden`;
}
