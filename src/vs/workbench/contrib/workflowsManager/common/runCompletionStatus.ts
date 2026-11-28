/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CanonicalStatusCategory } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { readTopLevelMetadata, STATUS_CATEGORIES } from '../../workspacesExplorer/common/workspaceLifecycle.js';
import { ITemplateStatusLike, IWorkspaceLifecycleLike } from '../../workspacesExplorer/common/ticketStatusPicker.js';
import { removeTicketLinkSectionLine, setTicketLinkSectionLine } from '../../workspacesExplorer/common/ticketDependencies.js';

/**
 * Status after a run (CI-58): when a whole-ticket run or a workflow run ends, the ticket (or workflow ticket) moves to
 * a configured status, so finished work does not have to be moved by hand.
 *
 * - Two settings, stored as {@link RUN_STATUS_SETTING_KEY} (successful run) and {@link FAILED_RUN_STATUS_SETTING_KEY}
 *   (failed run) on the template (`ICustomModule`), on a Freestyle ticket's own structure (`freestyle_schema.json`,
 *   also an `ICustomModule`) and on a workflow (`workflow_flowchart.json`).
 * - Unset / empty / legacy value: the workspace's Done status (success) / Blocked status (failure), i.e. the first
 *   status of that category of the workspace lifecycle. {@link RUN_STATUS_DONT_CHANGE}: the status is left alone.
 *   Any other value: that status name.
 * - A run stopped by the user is not a failure: the status is left alone. The UI-20 failure marker is separate.
 * - A finished run never moves a ticket back to a Todo-category status.
 * - A status set explicitly during the run (a Button Group decision with a target status, a set-status step, a person)
 *   wins over the setting.
 * - The name is resolved against the template's statuses first, then the workspace lifecycle; not found: skipped.
 *
 * Status (the stage of the work) and the run result (pass / fail) are different things: this is only about status.
 */

/** Property holding the successful-run setting on a template / Freestyle structure / workflow flowchart. */
export const RUN_STATUS_SETTING_KEY = 'statusOnSuccessfulRun';
/** Property holding the failed-run setting. */
export const FAILED_RUN_STATUS_SETTING_KEY = 'statusOnFailedRun';
/** Setting value: do not change the status after a successful run. */
export const RUN_STATUS_DONT_CHANGE = '__dont_change__';
/** Label of {@link RUN_STATUS_DONT_CHANGE} in the dropdowns. */
export const RUN_STATUS_DONT_CHANGE_LABEL = 'Don\'t change';
/** Caption of the successful-run setting. */
export const RUN_STATUS_SETTING_LABEL = 'On successful run, set status to:';
/** Caption of the failed-run setting. */
export const FAILED_RUN_STATUS_SETTING_LABEL = 'On failed run, set status to:';
/** Used when neither the workspace lifecycle nor the template has a Done-category status. */
export const FALLBACK_DONE_STATUS = 'Done';
/** Used when neither the workspace lifecycle nor the template has a Blocked-category status. */
export const FALLBACK_BLOCKED_STATUS = 'Blocked';

/** Which run end a setting is for. */
export type RunStatusSettingKind = 'success' | 'failure';

/** The category whose first status is the default of a setting. */
export function defaultCategoryOf(kind: RunStatusSettingKind): CanonicalStatusCategory {
	return kind === 'success' ? 'Done' : 'Blocked';
}

export type RunStatusSetting =
	| { readonly kind: 'default' }
	| { readonly kind: 'dontChange' }
	| { readonly kind: 'status'; readonly status: string };

export type RunOutcome = 'success' | 'failed' | 'stopped';

function sameText(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function templateStatusName(def: ITemplateStatusLike | undefined): string {
	return (def?.label || def?.id || '').trim();
}

/** Parses a stored setting value. Anything that is not a non-empty string means the default (Done). */
export function parseRunStatusSetting(raw: unknown): RunStatusSetting {
	if (typeof raw !== 'string' || !raw.trim()) {
		return { kind: 'default' };
	}
	if (raw.trim() === RUN_STATUS_DONT_CHANGE) {
		return { kind: 'dontChange' };
	}
	return { kind: 'status', status: raw.trim() };
}

/**
 * The first status of `category` in the workspace lifecycle, else the template's first status of that category, else
 * `fallback`.
 */
export function firstStatusOfCategory(category: CanonicalStatusCategory, fallback: string, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[]): string {
	const fromWorkspace = lifecycle?.statuses.find(s => s.trim() && lifecycle.getCategory(s) === category);
	if (fromWorkspace) {
		return fromWorkspace.trim();
	}
	const fromTemplate = (templateStatuses ?? []).find(d => templateStatusName(d) && sameText(d?.category || '', category));
	return fromTemplate ? templateStatusName(fromTemplate) : fallback;
}

/** The workspace's Done status (default of the successful-run setting). */
export function defaultDoneStatus(lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[]): string {
	return firstStatusOfCategory('Done', FALLBACK_DONE_STATUS, lifecycle, templateStatuses);
}

/** The workspace's Blocked status (default of the failed-run setting). */
export function defaultBlockedStatus(lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[]): string {
	return firstStatusOfCategory('Blocked', FALLBACK_BLOCKED_STATUS, lifecycle, templateStatuses);
}

function defaultStatusOf(kind: RunStatusSettingKind, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[]): string {
	return kind === 'success' ? defaultDoneStatus(lifecycle, templateStatuses) : defaultBlockedStatus(lifecycle, templateStatuses);
}

/** Category of a resolved status: the template's own category first, else the workspace lifecycle's. */
function categoryOfStatus(status: string, templateStatuses: readonly ITemplateStatusLike[] | undefined, lifecycle: IWorkspaceLifecycleLike | undefined): CanonicalStatusCategory | undefined {
	const def = (templateStatuses ?? []).find(d => sameText(templateStatusName(d), status));
	const fromTemplate = def ? STATUS_CATEGORIES.find(c => sameText(c, def.category || '')) : undefined;
	if (fromTemplate) {
		return fromTemplate;
	}
	return lifecycle && lifecycle.statuses.some(s => sameText(s, status)) ? lifecycle.getCategory(status) : undefined;
}

/**
 * The spelling of `name` among the template's statuses, else among the workspace lifecycle (case-insensitive), or
 * undefined when neither has it (the same lookup as the UI-18 Set Status path).
 */
export function resolveRunStatusName(name: string, templateStatuses: readonly ITemplateStatusLike[] | undefined, lifecycle: IWorkspaceLifecycleLike | undefined): string | undefined {
	if (!name.trim()) {
		return undefined;
	}
	const fromTemplate = (templateStatuses ?? []).map(templateStatusName).find(s => s && sameText(s, name));
	if (fromTemplate) {
		return fromTemplate;
	}
	return lifecycle?.statuses.find(s => sameText(s, name))?.trim();
}

/** The status name the setting asks for (before resolving), or undefined for "Don't change". */
export function targetStatusOfSetting(setting: RunStatusSetting, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[], kind: RunStatusSettingKind = 'success'): string | undefined {
	switch (setting.kind) {
		case 'dontChange': return undefined;
		case 'status': return setting.status;
		default: return defaultStatusOf(kind, lifecycle, templateStatuses);
	}
}

export interface IRunStatusDecisionInput {
	readonly outcome: RunOutcome;
	/** Raw stored successful-run setting (see {@link parseRunStatusSetting}). */
	readonly setting: unknown;
	/** Raw stored failed-run setting. */
	readonly failureSetting?: unknown;
	/** Status a step of this run explicitly set for this ticket (e.g. a Button Group target status). */
	readonly explicitStatus?: string;
	/** True when the ticket's status was changed by anything else during this run (it wins as well). */
	readonly statusChangedDuringRun?: boolean;
	/** The ticket's status right now. */
	readonly currentStatus?: string;
	readonly templateStatuses?: readonly ITemplateStatusLike[];
	readonly lifecycle?: IWorkspaceLifecycleLike;
}

export type RunStatusDecision =
	| { readonly action: 'set'; readonly status: string; readonly reason: string }
	| { readonly action: 'keep'; readonly reason: string };

/** What to do with a ticket's status when its run ended (pure). */
export function decideStatusAfterRun(input: IRunStatusDecisionInput): RunStatusDecision {
	if (input.outcome === 'stopped') {
		return { action: 'keep', reason: 'the run was stopped' };
	}
	if (input.explicitStatus && input.explicitStatus.trim()) {
		return { action: 'keep', reason: `a step of the run set the status to '${input.explicitStatus.trim()}'` };
	}
	if (input.statusChangedDuringRun) {
		return { action: 'keep', reason: 'the status was set during the run' };
	}
	const kind: RunStatusSettingKind = input.outcome === 'success' ? 'success' : 'failure';
	const runText = kind === 'success' ? 'a successful run' : 'a failed run';
	const setting = parseRunStatusSetting(kind === 'success' ? input.setting : input.failureSetting);
	const wanted = targetStatusOfSetting(setting, input.lifecycle, input.templateStatuses, kind);
	if (wanted === undefined) {
		return { action: 'keep', reason: `the setting for ${runText} is "${RUN_STATUS_DONT_CHANGE_LABEL}"` };
	}
	const resolved = resolveRunStatusName(wanted, input.templateStatuses, input.lifecycle);
	if (!resolved) {
		return { action: 'keep', reason: `status '${wanted}' is not in the template's statuses or the workspace lifecycle` };
	}
	if (categoryOfStatus(resolved, input.templateStatuses, input.lifecycle) === 'Todo') {
		return { action: 'keep', reason: `'${resolved}' is a Todo status; a finished run never moves a ticket back to Todo` };
	}
	if (input.currentStatus !== undefined && sameText(input.currentStatus, resolved)) {
		return { action: 'keep', reason: `the status is already '${resolved}'` };
	}
	return { action: 'set', status: resolved, reason: setting.kind === 'default' ? `default (${defaultCategoryOf(kind)}) after ${runText}` : `set after ${runText}` };
}

export interface IRunStatusOptionGroup {
	/** Undefined for the "Don't change" group. */
	readonly category?: CanonicalStatusCategory;
	readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * Dropdown options: "Don't change", then the statuses (workspace lifecycle, then template statuses it lacks) grouped
 * by category in canonical order (empty groups and the Todo category dropped). A stored status found in neither is listed under its own group
 * so the current value stays visible.
 */
export function buildRunStatusOptionGroups(lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[], storedValue?: unknown): IRunStatusOptionGroup[] {
	const entries: { status: string; category: CanonicalStatusCategory }[] = [];
	const add = (status: string, category: CanonicalStatusCategory) => {
		const name = status.trim();
		if (name && !entries.some(e => sameText(e.status, name))) {
			entries.push({ status: name, category });
		}
	};
	for (const s of lifecycle?.statuses ?? []) {
		add(s, lifecycle!.getCategory(s));
	}
	for (const def of templateStatuses ?? []) {
		const name = templateStatusName(def);
		const category = STATUS_CATEGORIES.find(c => sameText(c, def?.category || '')) ?? lifecycle?.getCategory(name) ?? 'Todo';
		add(name, category);
	}
	const stored = parseRunStatusSetting(storedValue);
	const groups: IRunStatusOptionGroup[] = [{ options: [{ value: RUN_STATUS_DONT_CHANGE, label: RUN_STATUS_DONT_CHANGE_LABEL }] }];
	for (const category of STATUS_CATEGORIES) {
		if (category === 'Todo') {
			continue; // a finished run never moves a ticket back to Todo
		}
		const inGroup = entries.filter(e => e.category === category);
		if (inGroup.length > 0) {
			groups.push({ category, options: inGroup.map(e => ({ value: e.status, label: e.status })) });
		}
	}
	if (stored.kind === 'status' && !entries.some(e => sameText(e.status, stored.status))) {
		groups.push({ options: [{ value: stored.status, label: `${stored.status} (not in lifecycle)` }] });
	}
	return groups;
}

/**
 * The value the dropdown shows for a stored setting: "Don't change", the stored status, or (unset) the workspace's
 * Done status, pre-filled.
 */
export function runStatusSelectValue(storedValue: unknown, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[], kind: RunStatusSettingKind = 'success'): string {
	const setting = parseRunStatusSetting(storedValue);
	if (setting.kind === 'dontChange') {
		return RUN_STATUS_DONT_CHANGE;
	}
	const wanted = targetStatusOfSetting(setting, lifecycle, templateStatuses, kind) ?? FALLBACK_DONE_STATUS;
	return resolveRunStatusName(wanted, templateStatuses, lifecycle) ?? wanted;
}

/** Short text of a stored setting, e.g. for a tooltip: "Done (default)", "Don't change", "In Review". */
export function describeRunStatusSetting(storedValue: unknown, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses?: readonly ITemplateStatusLike[], kind: RunStatusSettingKind = 'success'): string {
	const setting = parseRunStatusSetting(storedValue);
	if (setting.kind === 'dontChange') {
		return RUN_STATUS_DONT_CHANGE_LABEL;
	}
	const value = runStatusSelectValue(storedValue, lifecycle, templateStatuses, kind);
	return setting.kind === 'default' ? `${value} (default)` : value;
}

/**
 * True when a status change record ({ field, at }) of the ticket's change log (CI-50) is from `sinceEpochMs` or later,
 * i.e. the status was set while the run was going on.
 */
export function hasStatusChangeSince(records: readonly { readonly field: string; readonly at: string }[], sinceEpochMs: number): boolean {
	return records.some(r => r.field === 'status' && Date.parse(r.at) >= sinceEpochMs);
}

// ---------------------------------------------------------------------------------------------------------------
// Per-ticket settings (every ticket can override its template / workflow settings)
// ---------------------------------------------------------------------------------------------------------------

/** ticket.md line of a ticket's own successful-run setting (next to Depends On / Follow Children). */
export const TICKET_RUN_STATUS_FIELD_KEY = 'Status On Successful Run';
/** ticket.md line of a ticket's own failed-run setting. */
export const TICKET_FAILED_RUN_STATUS_FIELD_KEY = 'Status On Failed Run';
/** Dropdown value: no per-ticket value, the template's / workflow's setting (else the default) applies. */
export const RUN_STATUS_INHERIT = '__inherit__';
/** Values of a ticket.md line meaning "inherit" (case-insensitive), besides an empty value. */
const INHERIT_VALUES = ['default', 'inherit', 'none', 'use template default', 'use workflow default'];

/** The ticket.md key of a setting kind. */
export function ticketRunStatusFieldKey(kind: RunStatusSettingKind): string {
	return kind === 'success' ? TICKET_RUN_STATUS_FIELD_KEY : TICKET_FAILED_RUN_STATUS_FIELD_KEY;
}

/**
 * A ticket's own setting read from its ticket.md, as a stored setting value: a status name, {@link RUN_STATUS_DONT_CHANGE}
 * ("Don't change"), or undefined when it has none (missing line, empty, "Default").
 */
export function readTicketRunStatusOverride(ticketMd: string, kind: RunStatusSettingKind): string | undefined {
	return parseTicketRunStatusOverride(readTopLevelMetadata(ticketMd, ticketRunStatusFieldKey(kind)));
}

/** A ticket.md line value as a stored setting value (see {@link readTicketRunStatusOverride}). */
export function parseTicketRunStatusOverride(value: string | undefined): string | undefined {
	const v = (value || '').trim();
	if (!v || v === RUN_STATUS_INHERIT || INHERIT_VALUES.includes(v.toLowerCase())) {
		return undefined;
	}
	if (v === RUN_STATUS_DONT_CHANGE || sameText(v, RUN_STATUS_DONT_CHANGE_LABEL) || sameText(v, 'dont change')) {
		return RUN_STATUS_DONT_CHANGE;
	}
	return v;
}

/**
 * Writes a ticket's own setting (`value`: a status, {@link RUN_STATUS_DONT_CHANGE}) or removes it (undefined /
 * {@link RUN_STATUS_INHERIT}: the template / workflow setting applies again).
 */
export function setTicketRunStatusOverrideLine(ticketMd: string, kind: RunStatusSettingKind, value: string | undefined): string {
	const key = ticketRunStatusFieldKey(kind);
	const v = parseTicketRunStatusOverride(value);
	if (v === undefined) {
		return removeTicketLinkSectionLine(ticketMd, key);
	}
	const anchors = kind === 'success'
		? ['Follow Children', 'Update Status From Dependencies', 'Depends On', 'Linked By', 'Link To']
		: [TICKET_RUN_STATUS_FIELD_KEY, 'Follow Children', 'Update Status From Dependencies', 'Depends On', 'Linked By', 'Link To'];
	return setTicketLinkSectionLine(ticketMd, key, v === RUN_STATUS_DONT_CHANGE ? RUN_STATUS_DONT_CHANGE_LABEL : v, anchors);
}

/**
 * The setting that applies: the ticket's own value first, then the inherited one (template, workflow or Freestyle
 * structure; undefined / empty there means the default Done / Blocked).
 */
export function effectiveRunStatusSetting(ticketOverride: string | undefined, inherited: unknown): unknown {
	const own = parseTicketRunStatusOverride(ticketOverride);
	return own !== undefined ? own : inherited;
}

/** Label of the "inherit" option: "Use template default (Done)", "Use workflow default (Don't change)". */
export function inheritRunStatusLabel(source: 'template' | 'workflow' | 'structure', inherited: unknown, lifecycle: IWorkspaceLifecycleLike | undefined, templateStatuses: readonly ITemplateStatusLike[] | undefined, kind: RunStatusSettingKind): string {
	const value = parseRunStatusSetting(inherited).kind === 'dontChange' ? RUN_STATUS_DONT_CHANGE_LABEL : runStatusSelectValue(inherited, lifecycle, templateStatuses, kind);
	return `Use ${source === 'structure' ? 'structure' : source} default (${value})`;
}
