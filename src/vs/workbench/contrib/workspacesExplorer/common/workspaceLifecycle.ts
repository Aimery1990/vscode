/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { parseTicketLabels, serializeTicketLabels, TICKET_LABELS_FIELD_KEY } from './ticketLabels.js';

/**
 * Workspace status lifecycle editing (UI-14) and the `ticket.md` metadata line helpers shared with ticket labels (UI-13).
 *
 * The workspace root `ticket.md` keeps `Ticket Statuses`, `Status Mapping`, `Removed Status` (and `Ticket Labels`)
 * twice: as top-level lines in "Profile Data" and as `  - **Key**: value` entries of "Self Defined Data Value".
 */

export const STATUS_CATEGORIES: readonly CanonicalStatusCategory[] = ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'];

export const TICKET_STATUSES_KEY = 'Ticket Statuses';
export const STATUS_MAPPING_KEY = 'Status Mapping';
export const REMOVED_STATUS_KEY = 'Removed Status';

/** Statuses grouped by their canonical category (the create / edit dialog's matrix). */
export type StatusCategoryMap = { [cat in CanonicalStatusCategory]: string[] };

export interface IWorkspaceLifecycleConfig {
	statuses: string[];
	mapping: { [status: string]: CanonicalStatusCategory };
	initialStatus: string;
	removedStatus: string;
}

export function createEmptyCategoryMap(): StatusCategoryMap {
	return { 'Todo': [], 'In Progress': [], 'Done': [], 'Blocked': [], 'Removed': [] };
}

export function createDefaultCategoryMap(): StatusCategoryMap {
	return { 'Todo': ['Todo'], 'In Progress': ['In Progress'], 'Done': ['Done'], 'Blocked': ['Blocked'], 'Removed': ['Removed'] };
}

export function cloneCategoryMap(map: StatusCategoryMap): StatusCategoryMap {
	const result = createEmptyCategoryMap();
	for (const cat of STATUS_CATEGORIES) {
		result[cat] = [...map[cat]];
	}
	return result;
}

/**
 * Groups a lifecycle into the matrix. Statuses keep their order inside a category; the removed status is put first
 * in "Removed" (the dialog saves the first "Removed" status as the removed status). Unknown categories fall back to "Todo".
 */
export function categoryMapFromLifecycle(statuses: readonly string[], mapping: { readonly [status: string]: string }, removedStatus?: string): StatusCategoryMap {
	const map = createEmptyCategoryMap();
	for (const st of statuses) {
		const raw = mapping[st];
		const cat = (STATUS_CATEGORIES as readonly string[]).includes(raw) ? raw as CanonicalStatusCategory : 'Todo';
		if (!map[cat].includes(st)) {
			map[cat].push(st);
		}
	}
	if (removedStatus) {
		const idx = map['Removed'].findIndex(s => s.toLowerCase() === removedStatus.toLowerCase());
		if (idx > 0) {
			const [rem] = map['Removed'].splice(idx, 1);
			map['Removed'].unshift(rem);
		}
	}
	return map;
}

/** The lifecycle the matrix describes (same rules the create dialog always used). */
export function lifecycleFromCategoryMap(map: StatusCategoryMap): IWorkspaceLifecycleConfig {
	const statuses: string[] = [];
	const mapping: { [status: string]: CanonicalStatusCategory } = {};
	for (const cat of STATUS_CATEGORIES) {
		for (const st of map[cat]) {
			if (!statuses.includes(st)) {
				statuses.push(st);
			}
			mapping[st] = cat;
		}
	}
	return {
		statuses,
		mapping,
		initialStatus: map['Todo'][0] || statuses[0] || 'Todo',
		removedStatus: map['Removed'][0] || 'Removed'
	};
}

/** Problems that block saving a matrix (empty lifecycle, no Removed status). */
export function validateCategoryMap(map: StatusCategoryMap): string | undefined {
	const config = lifecycleFromCategoryMap(map);
	if (config.statuses.length === 0) {
		return 'Add at least one status.';
	}
	if (map['Removed'].length === 0) {
		return 'The "Removed" category needs at least one status.';
	}
	return undefined;
}

export interface IStatusUsage {
	readonly status: string;
	readonly count: number;
}

export interface IStatusMigrationPlan {
	/** Renamed statuses (old -> new) that tickets still use; they are migrated automatically. */
	readonly renames: { readonly [oldStatus: string]: string };
	/** Statuses removed from the lifecycle that tickets still use, with the number of tickets. */
	readonly removedInUse: readonly IStatusUsage[];
}

function findCaseInsensitive(list: readonly string[], value: string): string | undefined {
	return list.find(s => s.toLowerCase() === value.toLowerCase());
}

/**
 * What happens to tickets when the lifecycle changes from `oldStatuses` to `newStatuses`.
 *
 * - `renames` (old -> new, as made in the editor) whose new name is in the new lifecycle migrate automatically.
 * - Any other status of the old lifecycle that is gone and still used (per `usage`, status -> ticket count) is reported
 *   in `removedInUse`; the user picks a replacement or cancels.
 * Statuses used by tickets that were not part of the old lifecycle are left alone.
 */
export function planStatusMigration(
	oldStatuses: readonly string[],
	newStatuses: readonly string[],
	renames: { readonly [oldStatus: string]: string },
	usage: { readonly [status: string]: number }
): IStatusMigrationPlan {
	const usageOf = (status: string): number => {
		let total = 0;
		for (const [st, count] of Object.entries(usage)) {
			if (st.toLowerCase() === status.toLowerCase()) {
				total += count;
			}
		}
		return total;
	};
	const effectiveRenames: { [oldStatus: string]: string } = {};
	const removedInUse: IStatusUsage[] = [];
	for (const oldSt of oldStatuses) {
		if (findCaseInsensitive(newStatuses, oldSt) && !Object.keys(renames).some(r => r.toLowerCase() === oldSt.toLowerCase())) {
			continue;
		}
		const renameKey = Object.keys(renames).find(r => r.toLowerCase() === oldSt.toLowerCase());
		const renamedTo = renameKey !== undefined ? findCaseInsensitive(newStatuses, renames[renameKey]) : undefined;
		const count = usageOf(oldSt);
		if (renamedTo) {
			if (renamedTo !== oldSt && count > 0) {
				effectiveRenames[oldSt] = renamedTo;
			}
			continue;
		}
		if (findCaseInsensitive(newStatuses, oldSt)) {
			continue;
		}
		if (count > 0) {
			removedInUse.push({ status: oldSt, count });
		}
	}
	return { renames: effectiveRenames, removedInUse };
}

/**
 * The status changes to apply to tickets: the plan's renames plus every removed status in use mapped to `replacement`.
 * Keys are matched case-insensitively by {@link migrateStatus}.
 */
export function buildStatusMigration(plan: IStatusMigrationPlan, replacement?: string): { [oldStatus: string]: string } {
	const result: { [oldStatus: string]: string } = { ...plan.renames };
	if (replacement) {
		for (const item of plan.removedInUse) {
			result[item.status] = replacement;
		}
	}
	return result;
}

/** The new status of a ticket under a migration (case-insensitive), or undefined when it does not change. */
export function migrateStatus(status: string | undefined, migration: { readonly [oldStatus: string]: string }): string | undefined {
	if (!status) {
		return undefined;
	}
	const key = Object.keys(migration).find(k => k.toLowerCase() === status.trim().toLowerCase());
	if (key === undefined || migration[key] === status) {
		return undefined;
	}
	return migration[key];
}

/** Records a rename in the editor's rename map, following chains (a -> b, then b -> c gives a -> c). */
export function recordStatusRename(renames: { [original: string]: string }, from: string, to: string): void {
	const original = Object.keys(renames).find(k => renames[k] === from);
	if (original !== undefined) {
		if (original === to) {
			delete renames[original];
		} else {
			renames[original] = to;
		}
	} else if (from !== to) {
		renames[from] = to;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// ticket.md metadata lines
// ---------------------------------------------------------------------------------------------------------------

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metadataLineRegex(key: string, indented: boolean): RegExp {
	return new RegExp(`^${indented ? '\\s+' : ''}-\\s*\\*\\*${escapeRegExp(key)}\\*\\*:\\s*(.*)$`, 'i');
}

/** The value of the first top-level `- **key**: value` line (case-insensitive key), or undefined. */
export function readTopLevelMetadata(text: string, key: string): string | undefined {
	const re = metadataLineRegex(key, false);
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(re);
		if (m) {
			return m[1].trim();
		}
	}
	return undefined;
}

/**
 * Sets a workspace lifecycle metadata entry in both places of a workspace `ticket.md`: the top-level line in
 * "Profile Data" and the `  - **key**:` entry of "Self Defined Data Value". Existing lines are replaced in place
 * (all of them); a missing line is added (Profile Data: after the other lifecycle lines, before "Last Updated At").
 */
export function upsertWorkspaceMetadata(text: string, key: string, value: string): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const topRe = metadataLineRegex(key, false);
	const nestedRe = metadataLineRegex(key, true);
	let hasTop = false;
	let hasNested = false;
	for (let i = 0; i < lines.length; i++) {
		if (topRe.test(lines[i])) {
			lines[i] = `- **${key}**: ${value}`;
			hasTop = true;
		} else if (nestedRe.test(lines[i])) {
			const indent = lines[i].match(/^\s+/)?.[0] ?? '  ';
			lines[i] = `${indent}- **${key}**: ${value}`;
			hasNested = true;
		}
	}

	if (!hasTop) {
		insertProfileLine(lines, `- **${key}**: ${value}`);
	}
	if (!hasNested) {
		insertSelfDefinedEntry(lines, `  - **${key}**: ${value}`);
	}
	return lines.join(eol);
}

function insertProfileLine(lines: string[], newLine: string): void {
	const profileIdx = lines.findIndex(l => /^###\s+Profile Data/i.test(l));
	if (profileIdx === -1) {
		// No Profile Data section: put it right after the Overview list (before the first "###"), else at the end
		const firstSection = lines.findIndex(l => /^###\s/.test(l));
		if (firstSection === -1) {
			lines.push(newLine);
		} else {
			lines.splice(firstSection, 0, newLine);
		}
		return;
	}
	let end = profileIdx + 1;
	while (end < lines.length && /^-\s*\*\*/.test(lines[end])) {
		end++;
	}
	const lifecycleKeys = [TICKET_STATUSES_KEY, STATUS_MAPPING_KEY, REMOVED_STATUS_KEY, 'Ticket Labels'].map(k => k.toLowerCase());
	let insertAt = -1;
	for (let i = profileIdx + 1; i < end; i++) {
		const m = lines[i].match(/^-\s*\*\*([^*]+)\*\*:/);
		if (m && lifecycleKeys.includes(m[1].trim().toLowerCase())) {
			insertAt = i + 1;
		}
	}
	if (insertAt === -1) {
		const lastUpdated = lines.findIndex((l, i) => i > profileIdx && i < end && /^-\s*\*\*Last Updated At\*\*:/i.test(l));
		insertAt = lastUpdated !== -1 ? lastUpdated : end;
	}
	lines.splice(insertAt, 0, newLine);
}

function insertSelfDefinedEntry(lines: string[], newEntry: string): void {
	const valueIdx = lines.findIndex(l => /^-\s*\*\*Self Defined Data Value\*\*:/i.test(l));
	if (valueIdx === -1) {
		return;
	}
	const rest = lines[valueIdx].replace(/^-\s*\*\*Self Defined Data Value\*\*:/i, '').trim();
	if (rest && rest.toLowerCase() !== 'none') {
		// An inline value that is not a list: leave it alone
		return;
	}
	lines[valueIdx] = '- **Self Defined Data Value**:';
	let insertAt = valueIdx + 1;
	while (insertAt < lines.length && /^\s+\S/.test(lines[insertAt])) {
		insertAt++;
	}
	lines.splice(insertAt, 0, newEntry);
}

/**
 * Replaces the top-level `- **Status**:` line of a ticket.md (the ticket's own status; indented custom fields named
 * "Status" are not touched). Returns undefined when the ticket has no such line.
 */
export function setTicketStatusLine(text: string, status: string): string | undefined {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const idx = lines.findIndex(l => /^-\s*\*\*Status\*\*:/i.test(l));
	if (idx === -1) {
		return undefined;
	}
	lines[idx] = `- **Status**: ${status}`;
	return lines.join(eol);
}

/** The ticket's own status (first top-level `- **Status**:` line). */
export function readTicketStatus(text: string): string | undefined {
	const v = readTopLevelMetadata(text, 'Status');
	return v ? v : undefined;
}

/** The ticket's labels (top-level `- **Labels**:` line). */
export function readTicketLabels(text: string): string[] {
	return parseTicketLabels(readTopLevelMetadata(text, TICKET_LABELS_FIELD_KEY));
}

/**
 * Writes the ticket's labels into its ticket.md: replaces the top-level `- **Labels**:` line, or adds one after
 * `- **Priority**:` (else after `- **Status**:`, else at the end).
 */
export function setTicketLabelsLine(text: string, labels: readonly string[]): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const newLine = `- **${TICKET_LABELS_FIELD_KEY}**: ${serializeTicketLabels(labels)}`;
	const existing = lines.findIndex(l => metadataLineRegex(TICKET_LABELS_FIELD_KEY, false).test(l));
	if (existing !== -1) {
		lines[existing] = newLine;
		return lines.join(eol);
	}
	let anchor = lines.findIndex(l => /^-\s*\*\*Priority\*\*:/i.test(l));
	if (anchor === -1) {
		anchor = lines.findIndex(l => /^-\s*\*\*Status\*\*:/i.test(l));
	}
	if (anchor !== -1) {
		lines.splice(anchor + 1, 0, newLine);
	} else {
		while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
			lines.pop();
		}
		lines.push(newLine, '');
	}
	return lines.join(eol);
}
