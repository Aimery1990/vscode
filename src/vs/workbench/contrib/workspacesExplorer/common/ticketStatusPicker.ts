/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from './workspacesExplorer.js';
import { STATUS_CATEGORIES, STATUS_CATEGORY_COLORS } from './workspaceLifecycle.js';

/**
 * Manual Status / Priority editing (UI-18): the options of the ticket page dropdowns and of the Workspaces tree
 * "Set Status" / "Set Priority" submenus.
 *
 * - The effective lifecycle of a ticket is its template's `statuses` when the template defines any, else the
 *   workspace lifecycle (the same rule as the AI edit button's options).
 * - Status options are grouped by the 5 canonical categories (in canonical order, empty groups dropped).
 * - Priorities are the app's 5 levels (`Very High` .. `Very Low`).
 */

/** A template status definition (subset of `IStatusDefinition`). */
export interface ITemplateStatusLike {
	readonly id?: string;
	readonly label?: string;
	readonly category?: string;
}

/** The workspace lifecycle (subset of `IWorkspaceStatusesInfo`). */
export interface IWorkspaceLifecycleLike {
	readonly statuses: readonly string[];
	getCategory(status?: string): CanonicalStatusCategory;
}

export interface IStatusOption {
	readonly status: string;
	readonly category: CanonicalStatusCategory;
}

export interface IEffectiveStatusLifecycle {
	readonly source: 'template' | 'workspace';
	readonly options: readonly IStatusOption[];
}

export interface IStatusOptionItem extends IStatusOption {
	readonly isCurrent: boolean;
	/** The ticket's current status, not part of the effective lifecycle (shown so it can be seen as checked). */
	readonly isOutsideLifecycle: boolean;
}

export interface IStatusOptionGroup {
	readonly category: CanonicalStatusCategory;
	readonly color: string;
	readonly items: readonly IStatusOptionItem[];
}

function sameText(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function asCategory(raw: string | undefined): CanonicalStatusCategory | undefined {
	if (!raw) {
		return undefined;
	}
	return STATUS_CATEGORIES.find(c => sameText(c, raw));
}

/** The statuses a ticket can take: its template's statuses if it defines any, else the workspace lifecycle. */
export function resolveEffectiveStatusOptions(templateStatuses: readonly ITemplateStatusLike[] | undefined, workspace: IWorkspaceLifecycleLike): IEffectiveStatusLifecycle {
	const options: IStatusOption[] = [];
	const add = (status: string, category: CanonicalStatusCategory) => {
		const name = status.trim();
		if (name && !options.some(o => sameText(o.status, name))) {
			options.push({ status: name, category });
		}
	};
	for (const def of templateStatuses ?? []) {
		if (!def) {
			continue;
		}
		const name = (def.label || def.id || '').trim();
		if (name) {
			add(name, asCategory(def.category) ?? workspace.getCategory(name));
		}
	}
	if (options.length > 0) {
		return { source: 'template', options };
	}
	for (const status of workspace.statuses) {
		add(status, workspace.getCategory(status));
	}
	return { source: 'workspace', options };
}

/**
 * Groups the options by canonical category (canonical order, empty groups dropped) and marks the current status.
 * A current status that is not part of the options is added to its category (`currentCategory`, else Todo).
 */
export function groupStatusOptions(options: readonly IStatusOption[], current: string | undefined, currentCategory?: CanonicalStatusCategory): IStatusOptionGroup[] {
	const cur = (current ?? '').trim();
	const items: IStatusOptionItem[] = options.map(o => ({ ...o, isCurrent: !!cur && sameText(o.status, cur), isOutsideLifecycle: false }));
	if (cur && !items.some(i => i.isCurrent)) {
		items.push({ status: cur, category: currentCategory ?? 'Todo', isCurrent: true, isOutsideLifecycle: true });
	}
	const groups: IStatusOptionGroup[] = [];
	for (const category of STATUS_CATEGORIES) {
		const inGroup = items.filter(i => i.category === category);
		if (inGroup.length > 0) {
			groups.push({ category, color: STATUS_CATEGORY_COLORS[category].text, items: inGroup });
		}
	}
	return groups;
}

/** Whether `status` is one of the options (case-insensitive). */
export function hasStatusOption(options: readonly IStatusOption[], status: string): boolean {
	return options.some(o => sameText(o.status, status));
}

/** The spelling of `status` used by the options (case-insensitive match), or undefined. */
export function findStatusOption(options: readonly IStatusOption[], status: string): IStatusOption | undefined {
	return options.find(o => sameText(o.status, status));
}

/**
 * The template (custom module) of a ticket type, matched like the ticket page does: by id or name, case-insensitive,
 * with `-`, `_` and spaces treated alike. Built-in container types (workspace, folder, file) have none.
 */
export function findTemplateForType<T extends { readonly id?: string; readonly name?: string }>(templates: readonly T[], type: string | undefined): T | undefined {
	const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/[-_\s]+/g, '_');
	const target = norm(type);
	if (!target || target === 'workspace' || target === 'folder' || target === 'file') {
		return undefined;
	}
	return templates.find(t => norm(t.id) === target) ?? templates.find(t => norm(t.name) === target);
}

// ---------------------------------------------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------------------------------------------

export interface IPriorityLevel {
	readonly level: string;
	readonly color: string;
}

/** The app's priority levels, highest first (create dialog, AI tools, ticket page colors). */
export const TICKET_PRIORITIES: readonly IPriorityLevel[] = [
	{ level: 'Very High', color: '#f43f5e' },
	{ level: 'High', color: '#fb923c' },
	{ level: 'Medium', color: '#38bdf8' },
	{ level: 'Low', color: '#34d399' },
	{ level: 'Very Low', color: '#2dd4bf' }
];

export const DEFAULT_TICKET_PRIORITY = 'Medium';

/** Color of a priority level that is not one of {@link TICKET_PRIORITIES}. */
export const NEUTRAL_PRIORITY_COLOR = '#94a3b8';

/** The canonical spelling of a priority level (case-insensitive), or undefined for an unknown value. */
export function normalizePriority(raw: string | undefined): string | undefined {
	const text = (raw ?? '').trim();
	return TICKET_PRIORITIES.find(p => sameText(p.level, text))?.level;
}

export function getPriorityColor(priority: string | undefined): string {
	const level = normalizePriority(priority || DEFAULT_TICKET_PRIORITY);
	return TICKET_PRIORITIES.find(p => p.level === level)?.color ?? NEUTRAL_PRIORITY_COLOR;
}

export interface IPriorityOptionItem extends IPriorityLevel {
	readonly isCurrent: boolean;
	readonly isOutsideLevels: boolean;
}

/** The priority options with the current one marked (an unknown current value is appended so it shows checked). */
export function buildPriorityOptions(current: string | undefined): IPriorityOptionItem[] {
	const cur = (current ?? '').trim();
	const items: IPriorityOptionItem[] = TICKET_PRIORITIES.map(p => ({ ...p, isCurrent: !!cur && sameText(p.level, cur), isOutsideLevels: false }));
	if (cur && cur.toLowerCase() !== 'none' && !items.some(i => i.isCurrent)) {
		items.push({ level: cur, color: NEUTRAL_PRIORITY_COLOR, isCurrent: true, isOutsideLevels: true });
	}
	return items;
}

/**
 * Writes the ticket's priority into its ticket.md: replaces the top-level `- **Priority**:` line (indented custom
 * fields are not touched), or adds one after `- **Status**:` (else at the end).
 */
export function setTicketPriorityLine(text: string, priority: string): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const newLine = `- **Priority**: ${priority}`;
	const existing = lines.findIndex(l => /^-\s*\*\*Priority\*\*:/i.test(l));
	if (existing !== -1) {
		lines[existing] = newLine;
		return lines.join(eol);
	}
	const anchor = lines.findIndex(l => /^-\s*\*\*Status\*\*:/i.test(l));
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
