/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ITicketChangeRecord } from './ticketChangeLog.js';
import { findStatusOption, IStatusOption } from './ticketStatusPicker.js';

/*
 * Restoring a removed ticket (UI-19): pure logic.
 *
 * A restored ticket gets back the status it had right before it was (last) moved to a "Removed" category status,
 * read from its field change log (CI-50 `status` records: `old` → `new`; a coalesced entry keeps the first old value,
 * so `old` is still the status before the entry). It falls back to the lifecycle's initial status when no such
 * record exists, when the previous status was itself a removed status, or when it is no longer part of the ticket's
 * effective lifecycle (template statuses override the workspace lifecycle).
 */

export type TicketRestoreFallbackReason = 'no_record' | 'removed_status' | 'not_in_lifecycle';

export interface ITicketRestoreDecision {
	/** The status to restore to. */
	readonly status: string;
	/** `history`: the status before the removal; `initial`: the lifecycle's initial status (fallback). */
	readonly source: 'history' | 'initial';
	/** The status found in the change log (also set when it could not be used). */
	readonly previousStatus?: string;
	/** ISO time of the removal the previous status was taken from. */
	readonly removedAt?: string;
	readonly fallbackReason?: TicketRestoreFallbackReason;
}

export interface ITicketRestoreResult extends ITicketRestoreDecision {
	/** False when the ticket was not removed (nothing written). */
	readonly changed: boolean;
	/** The status the ticket had before the restore. */
	readonly fromStatus?: string;
}

/** The removal found in a change log: the latest change into a removed status. */
export interface ITicketRemovalRecord {
	/** The status before the removal (may itself be a removed status). */
	readonly previousStatus: string;
	readonly removedStatus: string;
	readonly at: string;
}

/** The `status` change records with an old and a new value, newest first (records without a time keep their order, last). */
export function statusChangeRecordsNewestFirst(records: readonly ITicketChangeRecord[]): ITicketChangeRecord[] {
	const time = (r: ITicketChangeRecord) => {
		const t = Date.parse(r.at);
		return isNaN(t) ? -Infinity : t;
	};
	return records
		.map((r, index) => ({ r, index }))
		.filter(({ r }) => r.field === 'status' && typeof r.old === 'string' && typeof r.new === 'string')
		.sort((a, b) => (time(b.r) - time(a.r)) || (a.index - b.index))
		.map(({ r }) => r);
}

/**
 * The latest change of `status` into a removed status. A change from one removed status to another (e.g. a lifecycle
 * rename) is skipped in favour of an older change from an active status; it is returned only when no such change
 * exists.
 */
export function findLatestRemoval(records: readonly ITicketChangeRecord[], isRemoved: (status: string) => boolean): ITicketRemovalRecord | undefined {
	let removedToRemoved: ITicketRemovalRecord | undefined;
	for (const r of statusChangeRecordsNewestFirst(records)) {
		const oldStatus = (r.old ?? '').trim();
		const newStatus = (r.new ?? '').trim();
		if (!newStatus || !isRemoved(newStatus) || !oldStatus) {
			continue;
		}
		const removal: ITicketRemovalRecord = { previousStatus: oldStatus, removedStatus: newStatus, at: r.at };
		if (!isRemoved(oldStatus)) {
			return removal;
		}
		removedToRemoved ??= removal;
	}
	return removedToRemoved;
}

/** The initial status of a lifecycle: its first Todo status, else its first non-removed status, else `fallback`. */
export function initialStatusOf(options: readonly IStatusOption[], fallback: string): string {
	return options.find(o => o.category === 'Todo')?.status
		?? options.find(o => o.category !== 'Removed')?.status
		?? fallback;
}

export interface ITicketRestoreLifecycle {
	/** The ticket's effective lifecycle (`resolveEffectiveStatusOptions`). */
	readonly options: readonly IStatusOption[];
	readonly isRemoved: (status: string) => boolean;
	/** Used when the lifecycle has no usable initial status. */
	readonly fallbackInitialStatus: string;
}

/** The status a removed ticket is restored to, from its status change records. */
export function resolveRestoreStatus(records: readonly ITicketChangeRecord[], lifecycle: ITicketRestoreLifecycle): ITicketRestoreDecision {
	const initial = initialStatusOf(lifecycle.options, lifecycle.fallbackInitialStatus);
	const removal = findLatestRemoval(records, lifecycle.isRemoved);
	if (!removal) {
		return { status: initial, source: 'initial', fallbackReason: 'no_record' };
	}
	const base = { previousStatus: removal.previousStatus, removedAt: removal.at };
	if (lifecycle.isRemoved(removal.previousStatus)) {
		return { status: initial, source: 'initial', fallbackReason: 'removed_status', ...base };
	}
	const option = findStatusOption(lifecycle.options, removal.previousStatus);
	if (!option || option.category === 'Removed') {
		return { status: initial, source: 'initial', fallbackReason: 'not_in_lifecycle', ...base };
	}
	return { status: option.status, source: 'history', ...base };
}

/** `Restored to In Progress`, `Restored 'Fix login' to Todo (no previous status found)`, ... */
export function describeRestoreDecision(decision: ITicketRestoreDecision, ticketName?: string): string {
	const text = ticketName ? `Restored '${ticketName}' to ${decision.status}` : `Restored to ${decision.status}`;
	switch (decision.fallbackReason) {
		case 'no_record':
			return `${text} (no previous status found)`;
		case 'removed_status':
			return `${text} (previous status '${decision.previousStatus}' is a removed status)`;
		case 'not_in_lifecycle':
			return `${text} (previous status '${decision.previousStatus}' is no longer in the lifecycle)`;
		default:
			return text;
	}
}

