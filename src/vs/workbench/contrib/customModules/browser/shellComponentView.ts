/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IShellRunResult } from '../../entityPersistence/common/entityPersistence.js';
import {
	IShellComponentConfig, SHELL_DEFAULT_TIMEOUT_SEC, SHELL_MAX_TIMEOUT_SEC, SHELL_TYPES, ShellConfigKey, computeShellConfirmationHash,
	defaultShellType, getShellConfirmationKey, isShellConfigConfirmed, parseShellEnv, shellMainOutput, shellTypeOf
} from '../common/shellComponent.js';

/*
 * DOM of the shell component (CI-55), shared by the template / node designer and the ticket card:
 * - a settings form (script, working directory, shell, environment lines, timeout);
 * - a confirmation bar (confirmed / needs confirmation + Confirm button) and the confirmation dialog;
 * - a result area: Done / Failed badge, exit code, duration, shell and folder, the script, stdout / stderr, copy.
 * UI text uses the workbench font; only the script, environment and output are monospace.
 */

const INPUT_STYLE = 'width: 100%; box-sizing: border-box; padding: 5px 8px; font-size: 12px; font-family: inherit; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15)); background: var(--vscode-input-background); color: var(--vscode-input-foreground);';
const LABEL_STYLE = 'font-size: 11px; font-weight: 600; opacity: 0.85;';
const MONO = 'font-family: var(--vscode-editor-font-family, monospace);';

export interface IShellConfigFormOptions {
	/** Values shown as placeholders when a setting is empty (e.g. the template values on a ticket). */
	readonly fallback?: IShellComponentConfig;
	readonly readOnly?: boolean;
}

/** Renders the settings form; `onChange` receives the full config and the edited setting after every edit. */
export function renderShellConfigForm(parent: HTMLElement, initial: IShellComponentConfig, onChange: (config: IShellComponentConfig, changed: ShellConfigKey) => void, options: IShellConfigFormOptions = {}): void {
	const config: IShellComponentConfig = { ...initial };
	const root = append(parent, $('div.shell-config-form', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
	const fallbackText = (key: ShellConfigKey): string => {
		const value = options.fallback?.[key];
		return value !== undefined && value !== null && String(value) !== '' ? String(value) : '';
	};
	const emit = (key: ShellConfigKey) => onChange({ ...config }, key);

	// Script
	const scriptRow = append(root, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
	append(scriptRow, $('label', { style: LABEL_STYLE, title: '{variables} are passed as environment variables, never pasted into the script' }, 'Script'));
	const script = append(scriptRow, $('textarea.shell-script-input', { rows: '5', spellcheck: 'false', style: `${INPUT_STYLE} ${MONO} resize: vertical; line-height: 1.45;` })) as HTMLTextAreaElement;
	script.value = String(config.shellScript ?? '');
	script.placeholder = fallbackText('shellScript') ? `${fallbackText('shellScript')}\n(template)` : 'e.g. ls -la {folder}\nnpm run build';
	script.title = 'Command or multi-line script. {variables} reach the script as "${ANYAGENT_VAR_name}" environment variables.';
	script.readOnly = !!options.readOnly;
	script.oninput = () => {
		config.shellScript = script.value;
		emit('shellScript');
	};

	// Working directory + shell + timeout
	const row = append(root, $('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end;' }));
	const cwdBox = append(row, $('div', { style: 'display: flex; flex-direction: column; gap: 3px; flex: 1 1 240px; min-width: 180px;' }));
	append(cwdBox, $('label', { style: LABEL_STYLE, title: 'Absolute, ~/..., or relative to the workspace / workflow folder' }, 'Working directory'));
	const cwd = append(cwdBox, $('input', { type: 'text', style: INPUT_STYLE })) as HTMLInputElement;
	cwd.value = String(config.shellCwd ?? '');
	cwd.placeholder = fallbackText('shellCwd') ? `${fallbackText('shellCwd')} (template)` : 'Workspace folder (default), /abs/path, ~/dir or {variable}';
	cwd.title = 'Working directory: absolute, ~/..., or relative to the workspace / workflow folder. Empty: the workspace folder.';
	cwd.readOnly = !!options.readOnly;
	cwd.oninput = () => {
		config.shellCwd = cwd.value;
		emit('shellCwd');
	};

	const shellBox = append(row, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
	append(shellBox, $('label', { style: LABEL_STYLE }, 'Shell'));
	const select = append(shellBox, $('select.shell-type-select', { style: `${INPUT_STYLE} width: auto; min-width: 110px;`, title: 'Shell that runs the script' })) as HTMLSelectElement;
	const templateShell = options.fallback?.shellType;
	const defaultOpt = append(select, $('option', { value: '' })) as HTMLOptionElement;
	defaultOpt.textContent = templateShell ? `${templateShell} (template)` : `${defaultShellType()} (default)`;
	for (const type of SHELL_TYPES) {
		const opt = append(select, $('option', { value: type })) as HTMLOptionElement;
		opt.textContent = type;
	}
	select.value = String(config.shellType ?? '');
	select.disabled = !!options.readOnly;
	select.onchange = () => {
		config.shellType = select.value || undefined;
		emit('shellType');
	};

	const timeoutBox = append(row, $('div', { style: 'display: flex; flex-direction: column; gap: 3px; width: 110px;' }));
	append(timeoutBox, $('label', { style: LABEL_STYLE }, 'Timeout (s)'));
	const timeout = append(timeoutBox, $('input', { type: 'number', min: '1', max: String(SHELL_MAX_TIMEOUT_SEC), style: INPUT_STYLE })) as HTMLInputElement;
	timeout.value = config.shellTimeoutSec === undefined || config.shellTimeoutSec === null ? '' : String(config.shellTimeoutSec);
	timeout.placeholder = fallbackText('shellTimeoutSec') || String(SHELL_DEFAULT_TIMEOUT_SEC);
	timeout.title = `Seconds before the script and its child processes are stopped (1-${SHELL_MAX_TIMEOUT_SEC})`;
	timeout.readOnly = !!options.readOnly;
	timeout.oninput = () => {
		config.shellTimeoutSec = timeout.value.trim() === '' ? undefined : Number(timeout.value);
		emit('shellTimeoutSec');
	};

	// Environment
	const envRow = append(root, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
	append(envRow, $('label', { style: LABEL_STYLE, title: 'One KEY=VALUE per line; values may use {variables}' }, 'Environment (optional)'));
	const envInput = append(envRow, $('textarea.shell-env-input', { rows: '2', spellcheck: 'false', style: `${INPUT_STYLE} ${MONO} resize: vertical;` })) as HTMLTextAreaElement;
	envInput.value = String(config.shellEnv ?? '');
	envInput.placeholder = fallbackText('shellEnv') ? `${fallbackText('shellEnv')}\n(template)` : 'NODE_ENV=production\nAPI_TOKEN={API_TOKEN}   (never plain-text secrets)';
	envInput.title = 'Extra environment variables, one KEY=VALUE per line. Secrets must reference a variable, e.g. API_TOKEN={API_TOKEN}.';
	envInput.readOnly = !!options.readOnly;
	const envError = append(envRow, $('div', { style: 'font-size: 11px; color: var(--vscode-errorForeground, #f87171); display: none;' }));
	const checkEnv = () => {
		const errors = parseShellEnv(envInput.value).errors;
		envError.textContent = errors.join('; ');
		envError.style.display = errors.length ? 'block' : 'none';
	};
	checkEnv();
	envInput.oninput = () => {
		config.shellEnv = envInput.value;
		checkEnv();
		emit('shellEnv');
	};
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------

/** Shows the full script, folder and shell, and asks a person to confirm it. */
export async function askToConfirmShellScript(dialogService: IDialogService, config: IShellComponentConfig, label: string): Promise<boolean> {
	const envLines = String(config.shellEnv ?? '').trim();
	const detail = [
		`Shell: ${shellTypeOf(config)}`,
		`Working directory: ${String(config.shellCwd ?? '').trim() || '(workspace folder)'}`,
		...(envLines ? ['', 'Environment:', envLines] : []),
		'',
		'Script:',
		String(config.shellScript ?? ''),
		'',
		'This script was written or changed by AI. It runs on this computer with your permissions. Confirm only if you have read it and want it to run.'
	].join('\n');
	const res = await dialogService.confirm({
		type: 'warning',
		message: `Confirm the shell script of '${label}'?`,
		detail,
		primaryButton: 'Confirm and allow it to run'
	});
	return res.confirmed;
}

/** Marker for `config` (HMAC with the local key). */
export function shellConfirmationMarker(storageService: IStorageService, config: IShellComponentConfig): Promise<string> {
	return computeShellConfirmationHash(getShellConfirmationKey(storageService), config);
}

/** True when one of `markers` confirms `config`. */
export function isShellConfirmed(storageService: IStorageService, config: IShellComponentConfig, markers: readonly (string | undefined)[]): Promise<boolean> {
	return isShellConfigConfirmed(getShellConfirmationKey(storageService), config, markers);
}

/**
 * Marker after a person edited the settings in the UI: the edit confirms the new config when the person typed the
 * script itself (`scriptTypedByPerson`), or when the config was already confirmed before the edit. Otherwise (e.g. only
 * the folder of an unconfirmed AI script was changed) it stays unconfirmed and needs the Confirm button.
 * Returns undefined when not confirmed.
 */
export async function shellMarkerAfterUiEdit(storageService: IStorageService, before: IShellComponentConfig, beforeMarkers: readonly (string | undefined)[], after: IShellComponentConfig, scriptTypedByPerson: boolean): Promise<string | undefined> {
	if (!String(after.shellScript ?? '').trim()) {
		return undefined;
	}
	if (scriptTypedByPerson || await isShellConfirmed(storageService, before, beforeMarkers)) {
		return shellConfirmationMarker(storageService, after);
	}
	return undefined;
}

export interface IShellConfirmBar {
	/** Re-renders the bar for a config and its markers. */
	update(config: IShellComponentConfig, markers: readonly (string | undefined)[]): Promise<boolean>;
}

/** Confirmation status line with a Confirm button (shown only while the script is not confirmed). */
export function renderShellConfirmBar(parent: HTMLElement, storageService: IStorageService, onConfirm: () => void): IShellConfirmBar {
	const bar = append(parent, $('div.shell-confirm-bar', { style: 'display: none; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; padding: 6px 8px; border-radius: 4px;' }));
	let seq = 0;
	return {
		update: async (config, markers) => {
			const mine = ++seq;
			const hasScript = !!String(config.shellScript ?? '').trim();
			const confirmed = hasScript && await isShellConfirmed(storageService, config, markers);
			if (mine !== seq) {
				return confirmed;
			}
			clearNode(bar);
			if (!hasScript) {
				bar.style.display = 'none';
				return false;
			}
			bar.style.display = 'flex';
			if (confirmed) {
				bar.style.background = 'transparent';
				bar.style.padding = '0';
				append(bar, $('span', { style: 'opacity: 0.7;', title: 'This script was written or confirmed by a person and may run.' },
					$('span.codicon.codicon-pass', { style: 'font-size: 12px; margin-right: 4px; color: #22c55e;' }), 'Script confirmed'));
				return true;
			}
			bar.style.background = 'rgba(251, 191, 36, 0.12)';
			bar.style.padding = '6px 8px';
			append(bar, $('span', { style: 'color: #fbbf24;' },
				$('span.codicon.codicon-warning', { style: 'font-size: 12px; margin-right: 4px;' }),
				'Needs confirmation: this script was written or changed by AI and will not run until a person confirms it.'));
			const btn = append(bar, $('button.shell-confirm-btn', {
				type: 'button',
				title: 'Review the full script, folder and shell, and allow it to run',
				'aria-label': 'Confirm shell script',
				style: 'display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; font-size: 11.5px; font-family: inherit; border-radius: 4px; border: 1px solid rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.16); color: inherit; cursor: pointer;'
			}, $('span.codicon.codicon-shield', { style: 'font-size: 12px;' }), 'Confirm')) as HTMLButtonElement;
			btn.onclick = e => {
				e.preventDefault();
				e.stopPropagation();
				onConfirm();
			};
			return false;
		}
	};
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export interface IShellResultViewOptions {
	readonly onCopy: (text: string) => void;
	/** Shows a "Running" badge instead of the result. */
	readonly running?: boolean;
	/** Text shown before the first run. */
	readonly emptyText?: string;
}

/** Renders the result of the last run (or the running / empty state) into `parent` (its content is replaced). */
export function renderShellResultView(parent: HTMLElement, result: IShellRunResult | undefined, options: IShellResultViewOptions): void {
	clearNode(parent);
	const box = append(parent, $('div.shell-result', { style: 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.15);' }));
	const header = append(box, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px;' }));
	if (options.running) {
		append(header, $('span', { style: 'padding: 1px 8px; border-radius: 10px; background: rgba(251, 191, 36, 0.18); color: #fbbf24; font-weight: 600;' },
			$('span.codicon.codicon-loading.codicon-modifier-spin', { style: 'font-size: 11px; margin-right: 4px;' }), 'Running'));
		return;
	}
	if (!result) {
		append(header, $('span', { style: 'opacity: 0.6; font-style: italic;' }, options.emptyText ?? 'Not run yet.'));
		return;
	}
	const ok = result.ok;
	append(header, $('span.shell-result-badge', {
		style: `padding: 1px 8px; border-radius: 10px; font-weight: 600; background: ${ok ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)'}; color: ${ok ? '#22c55e' : '#ef4444'};`,
		title: result.error ?? ''
	}, $(`span.codicon.codicon-${ok ? 'check' : 'error'}`, { style: 'font-size: 11px; margin-right: 4px;' }), ok ? 'Done' : 'Failed'));
	append(header, $('span', { style: 'opacity: 0.8;' }, `exit ${result.exitCode}`));
	append(header, $('span', { style: 'opacity: 0.8;' }, `${result.durationMs} ms`));
	if (result.timedOut) {
		append(header, $('span', { style: 'color: #ef4444;' }, 'timed out'));
	}
	if (result.cancelled) {
		append(header, $('span', { style: 'color: #ef4444;' }, 'stopped'));
	}
	append(header, $('span', { style: 'opacity: 0.8;', title: `Shell and working directory: ${result.cwd}` },
		$('span.codicon.codicon-terminal', { style: 'font-size: 11px; margin-right: 3px;' }),
		`${result.shell}${result.cwd ? ` · ${result.cwd}` : ''}`));
	if (result.executedAt) {
		const at = new Date(result.executedAt);
		if (!isNaN(at.getTime())) {
			append(header, $('span', { style: 'opacity: 0.55;' }, at.toLocaleString()));
		}
	}
	const copyBtn = append(header, $('button.shell-result-copy', {
		type: 'button',
		title: 'Copy script and output',
		'aria-label': 'Copy script and output',
		style: 'margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; opacity: 0.8;'
	}, $('span.codicon.codicon-copy', { style: 'font-size: 13px;' }))) as HTMLButtonElement;
	copyBtn.onclick = e => {
		e.preventDefault();
		e.stopPropagation();
		const parts = [result.command ? `$ ${result.command}` : '', result.stdout, result.stderr].filter(Boolean);
		options.onCopy(parts.join('\n') || shellMainOutput(result));
	};

	if (result.error && (result.needsConfirmation || !result.stderr || result.exitCode === -1)) {
		append(box, $('div', { style: 'font-size: 12px; color: #ef4444;' }, result.error));
	}
	if (result.command && !result.needsConfirmation) {
		append(box, $('pre.shell-result-command', { style: `${MONO} margin: 0; font-size: 11.5px; opacity: 0.9; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all;` }, `$ ${result.command}`));
	}
	const pre = (caption: string, text: string, isError: boolean) => {
		append(box, $('div', { style: `font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6;${isError ? ' color: #f87171;' : ''}` }, caption));
		append(box, $('pre.shell-result-output', { style: `${MONO} margin: 0; font-size: 11.5px; line-height: 1.45; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; padding: 6px 8px; border-radius: 4px; background: rgba(0, 0, 0, 0.25);${isError ? ' color: #fca5a5;' : ''}` }, text));
	};
	if (result.stdout) {
		pre('stdout', result.stdout, false);
	}
	if (result.stderr && result.stderr !== result.error) {
		pre('stderr', result.stderr, !ok);
	}
	if (!result.stdout && !result.stderr && result.exitCode !== -1) {
		append(box, $('div', { style: 'font-size: 11.5px; opacity: 0.6; font-style: italic;' }, '(no output)'));
	}
}
