/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pinned workspaces in the "Managed Workspaces" panel (UI-11).
 *
 * Pins are stored as a JSON array of `{ id, pinnedAt }` under {@link WORKSPACE_PINS_STORAGE_KEY}
 * (profile scope, user target). `id` is the canonical workspace id used by the panel
 * (lower-cased fsPath for file URIs), `pinnedAt` is the pin time in epoch milliseconds.
 */

export const WORKSPACE_PINS_STORAGE_KEY = 'anyagent.workspacesExplorer.pinnedWorkspaces';

export interface IWorkspacePin {
	readonly id: string;
	readonly pinnedAt: number;
}

/** Parses the stored value; anything malformed is dropped, duplicates keep the earliest pin. */
export function parseWorkspacePins(raw: string | undefined): IWorkspacePin[] {
	if (!raw) {
		return [];
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) {
		return [];
	}
	const byId = new Map<string, IWorkspacePin>();
	for (const entry of data) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const { id, pinnedAt } = entry as { id?: unknown; pinnedAt?: unknown };
		if (typeof id !== 'string' || !id || typeof pinnedAt !== 'number' || !Number.isFinite(pinnedAt)) {
			continue;
		}
		const existing = byId.get(id);
		if (!existing || pinnedAt < existing.pinnedAt) {
			byId.set(id, { id, pinnedAt });
		}
	}
	return sortPins(Array.from(byId.values()));
}

export function serializeWorkspacePins(pins: readonly IWorkspacePin[]): string {
	return JSON.stringify(sortPins(pins).map(p => ({ id: p.id, pinnedAt: p.pinnedAt })));
}

export function isWorkspacePinned(pins: readonly IWorkspacePin[], id: string): boolean {
	return pins.some(p => p.id === id);
}

/** Adds a pin (no-op when already pinned, so the original pin time is kept). */
export function pinWorkspace(pins: readonly IWorkspacePin[], id: string, now: number): IWorkspacePin[] {
	if (isWorkspacePinned(pins, id)) {
		return sortPins(pins);
	}
	return sortPins([...pins, { id, pinnedAt: now }]);
}

export function unpinWorkspace(pins: readonly IWorkspacePin[], id: string): IWorkspacePin[] {
	return sortPins(pins.filter(p => p.id !== id));
}

/**
 * Orders items with pinned ones first (earliest pin on top), followed by the unpinned items in their
 * original relative order. Pins whose id matches no item are ignored. The input is not modified.
 */
export function orderByPins<T>(items: readonly T[], pins: readonly IWorkspacePin[], getId: (item: T) => string): T[] {
	if (pins.length === 0) {
		return items.slice();
	}
	const pinRank = new Map<string, number>();
	sortPins(pins).forEach((p, index) => pinRank.set(p.id, index));
	const pinned: { item: T; rank: number }[] = [];
	const unpinned: T[] = [];
	for (const item of items) {
		const rank = pinRank.get(getId(item));
		if (rank === undefined) {
			unpinned.push(item);
		} else {
			pinned.push({ item, rank });
		}
	}
	pinned.sort((a, b) => a.rank - b.rank);
	return [...pinned.map(p => p.item), ...unpinned];
}

function sortPins(pins: readonly IWorkspacePin[]): IWorkspacePin[] {
	// Array.prototype.sort is stable, so equal timestamps keep their stored order.
	return pins.slice().sort((a, b) => a.pinnedAt - b.pinnedAt);
}
