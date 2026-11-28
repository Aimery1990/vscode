/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { ITemplateStatusLike, IWorkspaceLifecycleLike } from '../../workspacesExplorer/common/ticketStatusPicker.js';
import { themedOverlayHost } from '../../workspacesExplorer/browser/workspaceLifecycleEditor.js';
import {
	buildRunStatusOptionGroups, describeRunStatusSetting, FAILED_RUN_STATUS_SETTING_KEY, FAILED_RUN_STATUS_SETTING_LABEL, inheritRunStatusLabel, RUN_STATUS_INHERIT,
	RUN_STATUS_SETTING_KEY, RUN_STATUS_SETTING_LABEL, RunStatusSettingKind, runStatusSelectValue
} from '../common/runCompletionStatus.js';

/**
 * The two "status after a run" settings (CI-58) as labelled dropdowns: "On successful run, set status to" (pre-filled
 * with the workspace's Done status) and "On failed run, set status to" (pre-filled with its Blocked status). Used by the
 * template designer, the Freestyle ticket page and the workflow editor.
 */

export type RunStatusSettingKey = typeof RUN_STATUS_SETTING_KEY | typeof FAILED_RUN_STATUS_SETTING_KEY;

export interface IRunStatusSettingsControlOptions {
	readonly lifecycle: IWorkspaceLifecycleLike | undefined;
	readonly templateStatuses?: readonly ITemplateStatusLike[];
	/** Stored values (undefined / empty: the default). */
	readonly success: unknown;
	readonly failure: unknown;
	/**
	 * Per-ticket use: the settings inherited from the template / workflow. A first option "Use template default (…)"
	 * ({@link RUN_STATUS_INHERIT}) shows the effective inherited value and is selected while `success` / `failure`
	 * (the ticket's own values) are undefined.
	 */
	readonly inherit?: { readonly source: 'template' | 'workflow' | 'structure'; readonly success: unknown; readonly failure: unknown };
	readonly onChange: (key: RunStatusSettingKey, value: string) => void;
}

const SELECT_STYLE = 'width: 100%; box-sizing: border-box; padding: 3px 6px; font-size: 12px; border-radius: 4px; cursor: pointer; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); font-family: inherit;';
const LABEL_STYLE = 'font-size: 11px; color: var(--vscode-descriptionForeground);';

function buildSelect(kind: RunStatusSettingKind, opts: IRunStatusSettingsControlOptions): HTMLElement {
	const key: RunStatusSettingKey = kind === 'success' ? RUN_STATUS_SETTING_KEY : FAILED_RUN_STATUS_SETTING_KEY;
	const label = kind === 'success' ? RUN_STATUS_SETTING_LABEL : FAILED_RUN_STATUS_SETTING_LABEL;
	const stored = kind === 'success' ? opts.success : opts.failure;
	const describe = () => describeRunStatusSetting(stored, opts.lifecycle, opts.templateStatuses, kind);
	const tooltip = kind === 'success'
		? 'Status this ticket moves to when a whole run ends successfully (Done by default). A status set by a step of the run (e.g. an Approve button) wins.'
		: 'Status this ticket moves to when a whole run fails (Blocked by default). A run stopped by the user leaves the status unchanged.';
	const select = $<HTMLSelectElement>('select.run-status-setting-select', { style: SELECT_STYLE, title: `${tooltip}\nCurrent: ${describe()}`, 'aria-label': label, 'data-run-status-setting': key });
	const inherit = opts.inherit;
	const inheritOwn = inherit && (stored === undefined || stored === '');
	const current = inheritOwn ? RUN_STATUS_INHERIT : runStatusSelectValue(stored, opts.lifecycle, opts.templateStatuses, kind);
	if (inherit) {
		const inherited = kind === 'success' ? inherit.success : inherit.failure;
		const el = append(select, $<HTMLOptionElement>('option', { value: RUN_STATUS_INHERIT }, inheritRunStatusLabel(inherit.source, inherited, opts.lifecycle, opts.templateStatuses, kind)));
		el.selected = current === RUN_STATUS_INHERIT;
		select.title = `${tooltip}\nCurrent: ${inheritOwn ? el.text : describe()}`;
	}
	for (const group of buildRunStatusOptionGroups(opts.lifecycle, opts.templateStatuses, stored)) {
		const parent = group.category ? append(select, $<HTMLOptGroupElement>('optgroup', { label: group.category })) : select;
		for (const option of group.options) {
			const el = append(parent, $<HTMLOptionElement>('option', { value: option.value }, option.label));
			el.selected = option.value === current;
		}
	}
	select.onchange = () => opts.onChange(key, select.value);
	select.onclick = e => e.stopPropagation();
	select.onmousedown = e => e.stopPropagation();
	select.onkeydown = e => e.stopPropagation();
	return $('label.run-status-setting', { style: 'display: flex; flex-direction: column; gap: 3px;' },
		$('span', { style: LABEL_STYLE }, label),
		select
	);
}

/** Closes the open popover of {@link showRunStatusSettingsPopover}, if any. */
let openPopoverClose: (() => void) | undefined;

/** Both settings, stacked. */
export function buildRunStatusSettingsControl(opts: IRunStatusSettingsControlOptions): HTMLElement {
	return $('div.run-status-settings', { style: 'display: flex; flex-direction: column; gap: 8px;' },
		buildSelect('success', opts),
		buildSelect('failure', opts)
	);
}

/**
 * A small popover under `anchor` holding both settings (the workflow editor's toolbox button). Closes on a click
 * outside or Escape. Returns a function that closes it.
 */
export function showRunStatusSettingsPopover(anchor: HTMLElement, title: string, opts: IRunStatusSettingsControlOptions): () => void {
	const win = getWindow(anchor);
	const doc = win.document;
	openPopoverClose?.();
	const control = buildRunStatusSettingsControl(opts);
	const rect = anchor.getBoundingClientRect();
	const width = 260;
	const left = Math.max(8, Math.min(Math.round(rect.right + 6), win.innerWidth - width - 8));
	const top = Math.max(8, Math.min(Math.round(rect.top), win.innerHeight - 200));
	const popover = $('div.run-status-settings-popover', {
		role: 'dialog', 'aria-label': title,
		style: `position: fixed; top: ${top}px; left: ${left}px; width: ${width}px; z-index: 10000; box-sizing: border-box; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; border-radius: 8px; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent)); box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));`
	},
		$('div', { style: 'font-size: 12px; font-weight: 600;' }, title),
		control
	);
	const close = () => {
		if (openPopoverClose === close) {
			openPopoverClose = undefined;
		}
		doc.removeEventListener('mousedown', onOutside, true);
		doc.removeEventListener('keydown', onKey, true);
		popover.remove();
	};
	const onOutside = (e: MouseEvent) => {
		if (!popover.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
			close();
		}
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
			anchor.focus();
		}
	};
	// Inside the workbench so the theme variables apply
	themedOverlayHost(anchor).appendChild(popover);
	doc.addEventListener('mousedown', onOutside, true);
	doc.addEventListener('keydown', onKey, true);
	openPopoverClose = close;
	(control.firstElementChild?.lastElementChild as HTMLElement | null | undefined)?.focus();
	return close;
}
