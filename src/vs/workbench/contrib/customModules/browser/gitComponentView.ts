/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { IGitRunResult } from '../../entityPersistence/common/entityPersistence.js';
import { GIT_COMMANDS, GIT_COMMAND_INFO, GIT_PARAM_INFO, GitConfigKey, IGitComponentConfig, gitCommandOf, gitMainOutput } from '../common/gitComponent.js';

/*
 * DOM of the git component (CI-24), shared by the template designer and the ticket card:
 * - a settings form: a command selector and only the parameters of the selected command;
 * - a result area: Done / Failed badge, command line, exit code, duration, branch / commit and the output.
 * UI text uses the workbench font; only command lines and output are monospace.
 */

const INPUT_STYLE = 'width: 100%; box-sizing: border-box; padding: 5px 8px; font-size: 12px; font-family: inherit; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15)); background: var(--vscode-input-background); color: var(--vscode-input-foreground);';
const LABEL_STYLE = 'font-size: 11px; font-weight: 600; opacity: 0.85;';
const MONO = 'font-family: var(--vscode-editor-font-family, monospace);';

export interface IGitConfigFormOptions {
	/** Values shown as placeholders when a setting is empty (e.g. the template values on a ticket). */
	readonly fallback?: IGitComponentConfig;
	readonly readOnly?: boolean;
}

export interface IGitConfigForm {
	getConfig(): IGitComponentConfig;
}

/** Renders the settings form into `parent`; `onChange` receives the full config after every edit. */
export function renderGitConfigForm(parent: HTMLElement, initial: IGitComponentConfig, onChange: (config: IGitComponentConfig) => void, options: IGitConfigFormOptions = {}): IGitConfigForm {
	const config: IGitComponentConfig = { ...initial };
	const root = append(parent, $('div.git-config-form', { style: 'display: flex; flex-direction: column; gap: 8px;' }));

	const commandRow = append(root, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
	append(commandRow, $('label', { style: LABEL_STYLE }, 'Command'));
	const select = append(commandRow, $('select.git-command-select', { style: `${INPUT_STYLE} width: auto; min-width: 220px;`, title: 'git command to run' })) as HTMLSelectElement;
	for (const cmd of GIT_COMMANDS) {
		const opt = append(select, $('option', { value: cmd })) as HTMLOptionElement;
		opt.textContent = `${GIT_COMMAND_INFO[cmd].label} — ${GIT_COMMAND_INFO[cmd].description}`;
	}
	select.value = gitCommandOf(config);
	select.disabled = !!options.readOnly;
	const paramsBox = append(root, $('div.git-config-params', { style: 'display: flex; flex-direction: column; gap: 8px;' }));

	const emit = () => onChange({ ...config });

	const renderParams = () => {
		clearNode(paramsBox);
		const command = gitCommandOf(config);
		for (const key of GIT_COMMAND_INFO[command].params) {
			const info = GIT_PARAM_INFO[key];
			const fallback = options.fallback?.[key];
			if (info.kind === 'boolean') {
				const row = append(paramsBox, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;' }));
				const box = append(row, $('input', { type: 'checkbox' })) as HTMLInputElement;
				const current = config[key];
				box.checked = current === undefined ? (fallback === true || fallback === 'true') : (current === true || current === 'true');
				box.disabled = !!options.readOnly;
				append(row, $('span', undefined, info.label));
				box.onchange = () => {
					setValue(config, key, box.checked);
					emit();
				};
				continue;
			}
			const row = append(paramsBox, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
			append(row, $('label', { style: LABEL_STYLE, title: info.hint ?? '' }, info.label));
			const input = (info.kind === 'multiline'
				? append(row, $('textarea', { rows: '2', style: `${INPUT_STYLE} resize: vertical;` }))
				: append(row, $('input', { type: 'text', style: INPUT_STYLE }))) as HTMLInputElement | HTMLTextAreaElement;
			input.setAttribute('data-git-param', key);
			const value = config[key];
			input.value = value === undefined || value === null ? '' : String(value);
			const fallbackText = fallback !== undefined && fallback !== null && String(fallback) !== '' ? String(fallback) : '';
			input.placeholder = fallbackText ? `${fallbackText} (template)` : (info.placeholder ?? '');
			input.readOnly = !!options.readOnly;
			if (info.hint) {
				input.title = info.hint;
			}
			input.oninput = () => {
				setValue(config, key, info.kind === 'number' && input.value.trim() !== '' && !input.value.includes('{') ? Number(input.value) : input.value);
				emit();
			};
		}
	};

	select.onchange = () => {
		config.gitCommand = select.value;
		renderParams();
		emit();
	};
	renderParams();
	return { getConfig: () => ({ ...config }) };
}

function setValue(config: IGitComponentConfig, key: GitConfigKey, value: string | number | boolean): void {
	Reflect.set(config, key, value);
}

export interface IGitResultViewOptions {
	readonly onCopy: (text: string) => void;
	/** Shows a "Running" badge instead of the result. */
	readonly running?: boolean;
	/** Text shown before the first run. */
	readonly emptyText?: string;
}

/** Renders the result of the last run (or the running / empty state) into `parent` (its content is replaced). */
export function renderGitResultView(parent: HTMLElement, result: IGitRunResult | undefined, options: IGitResultViewOptions): void {
	clearNode(parent);
	const box = append(parent, $('div.git-result', { style: 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(0, 0, 0, 0.15);' }));
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
	append(header, $('span.git-result-badge', {
		style: `padding: 1px 8px; border-radius: 10px; font-weight: 600; background: ${ok ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)'}; color: ${ok ? '#22c55e' : '#ef4444'};`,
		title: result.error ?? ''
	}, $(`span.codicon.codicon-${ok ? 'check' : 'error'}`, { style: 'font-size: 11px; margin-right: 4px;' }), ok ? 'Done' : 'Failed'));
	append(header, $('span', { style: 'opacity: 0.8;' }, `exit ${result.exitCode}`));
	append(header, $('span', { style: 'opacity: 0.8;' }, `${result.durationMs} ms`));
	if (result.timedOut) {
		append(header, $('span', { style: 'color: #ef4444;' }, 'timed out'));
	}
	if (result.branch || result.commit) {
		append(header, $('span', { style: 'opacity: 0.8;', title: 'Branch and HEAD commit after the command' },
			$('span.codicon.codicon-git-branch', { style: 'font-size: 11px; margin-right: 3px;' }),
			`${result.branch || '?'}${result.commit ? ` @ ${result.commit}` : ''}`));
	}
	if (result.executedAt) {
		const at = new Date(result.executedAt);
		if (!isNaN(at.getTime())) {
			append(header, $('span', { style: 'opacity: 0.55;' }, at.toLocaleString()));
		}
	}
	const copyBtn = append(header, $('button.git-result-copy', {
		type: 'button',
		title: 'Copy output',
		'aria-label': 'Copy output',
		style: 'margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; opacity: 0.8;'
	}, $('span.codicon.codicon-copy', { style: 'font-size: 13px;' }))) as HTMLButtonElement;
	copyBtn.onclick = e => {
		e.preventDefault();
		e.stopPropagation();
		const parts = [result.command ? `$ ${result.command}` : '', result.stdout, result.stderr].filter(Boolean);
		options.onCopy(parts.join('\n') || gitMainOutput(result));
	};

	if (result.command) {
		append(box, $('div.git-result-command', { style: `${MONO} font-size: 11.5px; opacity: 0.9; word-break: break-all;` }, `$ ${result.command}`));
	} else if (result.error) {
		append(box, $('div', { style: 'font-size: 12px; color: #ef4444;' }, result.error));
	}
	const pre = (caption: string, text: string, isError: boolean) => {
		append(box, $('div', { style: `font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6;${isError ? ' color: #f87171;' : ''}` }, caption));
		append(box, $('pre.git-result-output', { style: `${MONO} margin: 0; font-size: 11.5px; line-height: 1.45; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; padding: 6px 8px; border-radius: 4px; background: rgba(0, 0, 0, 0.25);${isError ? ' color: #fca5a5;' : ''}` }, text));
	};
	if (result.stdout) {
		pre('stdout', result.stdout, false);
	}
	if (result.stderr && (result.command || result.stderr !== result.error)) {
		pre('stderr', result.stderr, !ok);
	}
	if (!result.stdout && !result.stderr && result.command) {
		append(box, $('div', { style: 'font-size: 11.5px; opacity: 0.6; font-style: italic;' }, '(no output)'));
	}
}
