/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { createCSSRule } from '../../../../base/browser/domStylesheets.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CanonicalStatusCategory, IWorkspacesExplorerService } from '../common/workspacesExplorer.js';
import { ITicketLabelDefinition, LABEL_COLOR_PALETTE, nextLabelColor, normalizeLabelDefinitions, sanitizeLabelName } from '../common/ticketLabels.js';
import { buildStatusMigration, categoryMapFromLifecycle, cloneCategoryMap, IWorkspaceLifecycleConfig, lifecycleFromCategoryMap, planStatusMigration, recordStatusRename, STATUS_CATEGORIES, STATUS_CATEGORY_COLORS, StatusCategoryMap, validateCategoryMap } from '../common/workspaceLifecycle.js';

/**
 * Shared editors for a workspace's status lifecycle (the 5-category matrix, UI-14) and its label definitions (UI-13),
 * used by the create-workspace dialog and the "Edit Lifecycle & Labels" dialog of the workspace page.
 */

// --- theme-aware styles (UI-24) ---

/**
 * The element popups and dialogs of the Workspaces UI attach to: the workbench container, where the theme's
 * `--vscode-*` colors are defined (they are scoped to `.monaco-workbench`, so on `document.body` every theme color
 * resolves to nothing: black text, transparent buttons).
 */
export function themedOverlayHost(anchor: HTMLElement | undefined): HTMLElement {
	return anchor?.closest<HTMLElement>('.monaco-workbench') ?? (anchor?.ownerDocument ?? mainWindow.document).body;
}

/** Text inputs / selects: the theme's input colors. Use with the `anyag-themed-input` class (placeholder, focus). */
export const THEMED_INPUT_COLORS = 'border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))); background: var(--vscode-input-background); color: var(--vscode-input-foreground);';
/** Secondary buttons. Use with the `anyag-btn-secondary` class (hover). */
export const THEMED_SECONDARY_BUTTON_COLORS = 'background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent);';
/** Primary buttons. Use with the `anyag-btn-primary` class (hover). */
export const THEMED_PRIMARY_BUTTON_COLORS = 'background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent);';
/** Popup menus (pickers). Rows use the `anyag-menu-row` class (hover). */
export const THEMED_MENU_COLORS = 'background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))); box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));';
/** Secondary text (help, captions). */
export const THEMED_DESCRIPTION_COLOR = 'color: var(--vscode-descriptionForeground);';
/** Neutral row / section background that works in dark and light themes. */
const NEUTRAL_FILL = 'rgba(128, 128, 128, 0.08)';
const NEUTRAL_BORDER = 'var(--vscode-widget-border, rgba(128, 128, 128, 0.35))';

let themedRulesCreated = false;
/** Registers the hover / focus / placeholder rules of the themed classes once (inline styles cannot express them). */
export function ensureThemedControlRules(): void {
	if (themedRulesCreated) {
		return;
	}
	themedRulesCreated = true;
	createCSSRule('.anyag-themed-input::placeholder', 'color: var(--vscode-input-placeholderForeground); opacity: 1;');
	createCSSRule('.anyag-themed-input:focus', 'outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;');
	createCSSRule('.anyag-btn-secondary:hover', 'background: var(--vscode-button-secondaryHoverBackground) !important;');
	createCSSRule('.anyag-btn-primary:hover', 'background: var(--vscode-button-hoverBackground) !important;');
	createCSSRule('.anyag-menu-row:hover', 'background: var(--vscode-list-hoverBackground) !important; color: var(--vscode-list-hoverForeground, inherit);');
}

export const STATUS_LIFECYCLE_PRESETS: { readonly [name: string]: StatusCategoryMap } = {
	'Default': {
		'Todo': ['Todo'],
		'In Progress': ['In Progress'],
		'Done': ['Done'],
		'Blocked': ['Blocked'],
		'Removed': ['Removed']
	},
	'Agile / Scrum': {
		'Todo': ['Backlog', 'Ready'],
		'In Progress': ['Developing', 'Testing', 'Reviewing', 'Deploying'],
		'Done': ['Done', 'Released'],
		'Blocked': ['Blocked', 'On Hold'],
		'Removed': ['Canceled']
	},
	'Kanban': {
		'Todo': ['To Do'],
		'In Progress': ['Doing'],
		'Done': ['Done'],
		'Blocked': ['Blocked'],
		'Removed': ['Archived']
	}
};

export interface IStatusLifecycleMatrix {
	getCategoryMap(): StatusCategoryMap;
	getConfig(): IWorkspaceLifecycleConfig;
	/** Statuses renamed in the editor (original name -> current name). */
	getRenames(): { [original: string]: string };
}

export interface IStatusLifecycleMatrixOptions {
	/** Called after every change (add, remove, rename, preset). */
	onChange?: () => void;
	/** Double-click a status chip to rename it (the edit dialog; tickets are migrated on save). */
	allowRename?: boolean;
	/**
	 * Show the "Preset:" row (Default / Agile / Scrum / Kanban), which replaces ALL statuses, custom ones included.
	 * Only the New Workspace dialog sets it; default false (UI-33: never in the edit lifecycle dialog).
	 */
	showPresets?: boolean;
}

/** Renders the preset buttons (only with `showPresets`) and the 5-category status matrix into `parent`. */
export function renderStatusLifecycleMatrix(parent: HTMLElement, initial: StatusCategoryMap, options: IStatusLifecycleMatrixOptions = {}): IStatusLifecycleMatrix {
	let currentCategoryMap = cloneCategoryMap(initial);
	let renames: { [original: string]: string } = {};
	const changed = () => options.onChange?.();
	ensureThemedControlRules();

	// Presets Row (new workspaces only, UI-33)
	const presetsRow = options.showPresets ? append(parent, $('div.status-lifecycle-presets', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' })) : undefined;
	if (presetsRow) {
		append(presetsRow, $('span', { style: `font-size: 10.5px; font-weight: 500; ${THEMED_DESCRIPTION_COLOR}` }, 'Preset:'));
	}

	const matrixContainer = append(parent, $('.category-matrix-container', {
		style: 'display: flex; flex-direction: column; gap: 5px;'
	}));

	const statusExists = (name: string, except?: { cat: CanonicalStatusCategory; idx: number }) => STATUS_CATEGORIES.some(cat =>
		currentCategoryMap[cat].some((st, idx) => st.toLowerCase() === name.toLowerCase() && !(except && except.cat === cat && except.idx === idx)));

	const startRename = (labelEl: HTMLElement, cat: CanonicalStatusCategory, idx: number) => {
		const oldName = currentCategoryMap[cat][idx];
		const input = $<HTMLInputElement>('input.monaco-inputbox.anyag-themed-input', {
			style: `padding: 0 4px; font-size: 10px; border-radius: 3px; ${THEMED_INPUT_COLORS} width: 96px; height: 16px; box-sizing: border-box;`
		});
		input.value = oldName;
		labelEl.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		const commit = (save: boolean) => {
			if (done) {
				return;
			}
			done = true;
			const next = input.value.trim();
			if (save && next && next !== oldName && !statusExists(next, { cat, idx })) {
				currentCategoryMap[cat][idx] = next;
				recordStatusRename(renames, oldName, next);
				changed();
			}
			renderMatrix();
		};
		input.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				commit(false);
			}
		};
		input.onblur = () => commit(true);
	};

	const renderMatrix = () => {
		clearNode(matrixContainer);
		for (const cat of STATUS_CATEGORIES) {
			const color = STATUS_CATEGORY_COLORS[cat];
			const catRow = append(matrixContainer, $('.category-row', {
				style: `background: ${NEUTRAL_FILL}; border: 1px solid ${color.border}; border-radius: 5px; padding: 4px 8px; display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 10px;`
			}));

			// Left group: Category badge + chips
			const leftGroup = append(catRow, $('div', {
				style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0;'
			}));

			// Category Badge
			append(leftGroup, $('span', {
				style: `font-size: 9px; font-weight: 700; color: ${color.text}; background: ${color.bg}; border: 1px solid ${color.border}; padding: 1.5px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.4px; flex-shrink: 0; min-width: 72px; text-align: center;`
			}, cat));

			// Chips
			for (let idx = 0; idx < currentCategoryMap[cat].length; idx++) {
				const stName = currentCategoryMap[cat][idx];
				const chip = append(leftGroup, $('.status-chip', {
					style: `display: inline-flex; align-items: center; gap: 4px; background: ${NEUTRAL_FILL}; border: 1px solid ${NEUTRAL_BORDER}; padding: 1.5px 6px; border-radius: 3px; font-size: 10px; color: ${color.text}; font-weight: 500;`
				}));
				const labelEl = append(chip, $('span', {}, stName));
				if (options.allowRename) {
					labelEl.title = cat === 'Removed' && idx === 0
						? 'Removed status (tickets moved out of view use it). Double-click to rename'
						: 'Double-click to rename';
					labelEl.style.cursor = 'text';
					labelEl.ondblclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						startRename(labelEl, cat, idx);
					};
				}
				if (currentCategoryMap[cat].length > 1 || cat !== 'Removed') {
					const removeChipBtn = append(chip, $('span', {
						style: 'cursor: pointer; opacity: 0.75; font-size: 9px; margin-left: 2px; line-height: 1;',
						title: 'Remove status'
					}, '\u2715'));
					removeChipBtn.onclick = () => {
						currentCategoryMap[cat].splice(idx, 1);
						renderMatrix();
						changed();
					};
				}
			}

			// Right aligned Inline Add Status Input Form
			const addForm = append(catRow, $('div', {
				style: 'display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; margin-left: auto;'
			}));
			const addInput = append(addForm, $('input.monaco-inputbox.anyag-themed-input', {
				placeholder: `+ Add status...`,
				style: `padding: 1.5px 5px; font-size: 10px; border-radius: 3px; ${THEMED_INPUT_COLORS} width: 105px; height: 20px; box-sizing: border-box;`
			})) as HTMLInputElement;

			const doAdd = () => {
				const val = addInput.value.trim();
				if (val && !currentCategoryMap[cat].includes(val)) {
					currentCategoryMap[cat].push(val);
					renderMatrix();
					changed();
				}
			};

			addInput.onkeydown = (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					doAdd();
				}
			};

			const addBtn = append(addForm, $('button.monaco-button.anyag-btn-secondary', {
				title: `Add a status to ${cat}`,
				style: `padding: 1px 5px; font-size: 9.5px; border-radius: 3px; cursor: pointer; ${THEMED_SECONDARY_BUTTON_COLORS} height: 20px; line-height: 16px;`
			}));
			addBtn.innerText = 'Add';
			addBtn.onclick = (e) => {
				e.preventDefault();
				doAdd();
			};
		}
	};

	renderMatrix();

	if (presetsRow) {
		for (const [pName, pMap] of Object.entries(STATUS_LIFECYCLE_PRESETS)) {
			const prBtn = append(presetsRow, $('button.monaco-button.anyag-btn-secondary', {
				title: `Replace the statuses with the ${pName} preset`,
				style: `padding: 2px 7px; font-size: 10px; border-radius: 3px; cursor: pointer; ${THEMED_SECONDARY_BUTTON_COLORS}`
			}));
			prBtn.innerText = pName;
			prBtn.onclick = (e) => {
				e.preventDefault();
				currentCategoryMap = cloneCategoryMap(pMap);
				renames = {};
				renderMatrix();
				changed();
			};
		}
	}

	return {
		getCategoryMap: () => cloneCategoryMap(currentCategoryMap),
		getConfig: () => lifecycleFromCategoryMap(currentCategoryMap),
		getRenames: () => ({ ...renames })
	};
}

/** All statuses of a matrix in order, for summaries. */
export function summarizeCategoryMap(map: StatusCategoryMap): string {
	return STATUS_CATEGORIES.flatMap(cat => map[cat]).join(', ');
}

export interface ILabelDefinitionsEditor {
	getLabels(): ITicketLabelDefinition[];
	/** Labels renamed in the editor (original name -> current name). */
	getRenames(): { [original: string]: string };
}

const ICON_BUTTON_STYLE = `display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border-radius: 4px; cursor: pointer; ${THEMED_SECONDARY_BUTTON_COLORS} font-size: 12px;`;

/** Renders the label definitions editor (add / remove / rename, color from a small palette) into `parent`. */
export function renderLabelDefinitionsEditor(parent: HTMLElement, initial: readonly ITicketLabelDefinition[], onChange?: () => void): ILabelDefinitionsEditor {
	const labels: { name: string; color: string }[] = normalizeLabelDefinitions(initial).map(l => ({ ...l }));
	const renames: { [original: string]: string } = {};
	/** Index of the label whose color is being picked; -1 = the new label; undefined = palette closed. */
	let colorTarget: number | undefined;
	let newColor = nextLabelColor(labels);
	ensureThemedControlRules();

	const chipsEl = append(parent, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center;' }));
	const paletteEl = append(parent, $('div', { style: `display: none; align-items: center; gap: 5px; flex-wrap: wrap; padding: 4px 6px; border-radius: 5px; background: ${NEUTRAL_FILL}; border: 1px solid ${NEUTRAL_BORDER};` }));
	const addRow = append(parent, $('div', { style: 'display: flex; align-items: center; gap: 5px;' }));

	const exists = (name: string, exceptIdx?: number) => labels.some((l, i) => i !== exceptIdx && l.name.toLowerCase() === name.toLowerCase());

	const newSwatch = append(addRow, $<HTMLButtonElement>('button.monaco-button', { type: 'button', title: 'Color of the new label', style: `width: 16px; height: 16px; padding: 0; border-radius: 50%; cursor: pointer; border: 1px solid ${NEUTRAL_BORDER}; flex-shrink: 0;` }));
	const newInput = append(addRow, $<HTMLInputElement>('input.monaco-inputbox.anyag-themed-input', {
		placeholder: '+ Add label...',
		style: `padding: 2px 6px; font-size: 10.5px; border-radius: 4px; ${THEMED_INPUT_COLORS} width: 150px; height: 22px; box-sizing: border-box;`
	}));
	const addBtn = append(addRow, $<HTMLButtonElement>('button.monaco-button.anyag-btn-secondary', { type: 'button', title: 'Add label', style: ICON_BUTTON_STYLE }));
	append(addBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));

	const doAdd = () => {
		const name = sanitizeLabelName(newInput.value);
		if (!name || exists(name)) {
			newInput.select();
			return;
		}
		labels.push({ name, color: newColor });
		newInput.value = '';
		newColor = nextLabelColor(labels);
		colorTarget = undefined;
		render();
		onChange?.();
	};
	addBtn.onclick = (e) => {
		e.preventDefault();
		doAdd();
	};
	newInput.onkeydown = (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			doAdd();
		}
	};
	newSwatch.onclick = (e) => {
		e.preventDefault();
		colorTarget = colorTarget === -1 ? undefined : -1;
		render();
	};

	const startRename = (nameEl: HTMLElement, idx: number) => {
		const oldName = labels[idx].name;
		const input = $<HTMLInputElement>('input.monaco-inputbox.anyag-themed-input', {
			style: `padding: 0 4px; font-size: 10.5px; border-radius: 3px; ${THEMED_INPUT_COLORS} width: 100px; height: 17px; box-sizing: border-box;`
		});
		input.value = oldName;
		nameEl.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		const commit = (save: boolean) => {
			if (done) {
				return;
			}
			done = true;
			const next = sanitizeLabelName(input.value);
			if (save && next && next !== oldName && !exists(next, idx)) {
				labels[idx].name = next;
				recordStatusRename(renames, oldName, next);
				onChange?.();
			}
			render();
		};
		input.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				commit(false);
			}
		};
		input.onblur = () => commit(true);
	};

	const render = () => {
		clearNode(chipsEl);
		if (labels.length === 0) {
			append(chipsEl, $('span', { style: `font-size: 10.5px; font-style: italic; ${THEMED_DESCRIPTION_COLOR}` }, 'No labels defined yet.'));
		}
		labels.forEach((label, idx) => {
			const chip = append(chipsEl, $('span', {
				style: `display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px 1px 5px; border-radius: 10px; font-size: 10.5px; font-weight: 600; color: ${label.color}; background: ${label.color}22; border: 1px solid ${label.color}66;${colorTarget === idx ? ' outline: 1px solid var(--vscode-focusBorder, var(--vscode-foreground));' : ''}`
			}));
			const swatch = append(chip, $<HTMLButtonElement>('button', { type: 'button', title: 'Change color', style: `width: 10px; height: 10px; padding: 0; border-radius: 50%; cursor: pointer; background: ${label.color}; border: 1px solid ${NEUTRAL_BORDER};` }));
			swatch.onclick = (e) => {
				e.preventDefault();
				colorTarget = colorTarget === idx ? undefined : idx;
				render();
			};
			const nameEl = append(chip, $('span', { title: 'Double-click to rename', style: 'cursor: text;' }, label.name));
			nameEl.ondblclick = (e) => {
				e.preventDefault();
				startRename(nameEl, idx);
			};
			const removeBtn = append(chip, $<HTMLButtonElement>('button', { type: 'button', title: 'Remove label', style: 'display: inline-flex; align-items: center; padding: 0; background: transparent; border: none; cursor: pointer; color: inherit; opacity: 0.6; font-size: 10px;' }));
			append(removeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
			removeBtn.onclick = (e) => {
				e.preventDefault();
				labels.splice(idx, 1);
				colorTarget = undefined;
				render();
				onChange?.();
			};
		});

		newSwatch.style.background = newColor;

		clearNode(paletteEl);
		if (colorTarget === undefined || (colorTarget >= 0 && !labels[colorTarget])) {
			paletteEl.style.display = 'none';
			colorTarget = undefined;
			return;
		}
		paletteEl.style.display = 'flex';
		const target = colorTarget;
		const current = target === -1 ? newColor : labels[target].color;
		append(paletteEl, $('span', { style: 'font-size: 10px; opacity: 0.7; margin-right: 2px;' }, target === -1 ? 'Color for the new label:' : `Color for "${labels[target].name}":`));
		for (const color of LABEL_COLOR_PALETTE) {
			const dot = append(paletteEl, $<HTMLButtonElement>('button', { type: 'button', title: color, style: `width: 14px; height: 14px; padding: 0; border-radius: 50%; cursor: pointer; background: ${color}; border: 2px solid ${color.toLowerCase() === current.toLowerCase() ? 'var(--vscode-focusBorder, var(--vscode-foreground))' : 'transparent'};` }));
			dot.onclick = (e) => {
				e.preventDefault();
				if (target === -1) {
					newColor = color;
				} else {
					labels[target].color = color;
					onChange?.();
				}
				colorTarget = undefined;
				render();
			};
		}
	};

	render();

	return {
		getLabels: () => normalizeLabelDefinitions(labels),
		getRenames: () => ({ ...renames })
	};
}

export interface IWorkspaceLifecycleDialogOptions {
	readonly workspacesExplorerService: IWorkspacesExplorerService;
	readonly notificationService: INotificationService;
	/** The workspace root (or any folder inside it). */
	readonly workspaceUri: URI;
	readonly workspaceName?: string;
	/** Called after a successful save. */
	readonly onSaved?: () => void;
	/** An element of the page opening the dialog (the dialog joins its workbench window, see {@link themedOverlayHost}). */
	readonly anchor?: HTMLElement;
}

const SECTION_STYLE = `background: ${NEUTRAL_FILL}; border: 1px solid ${NEUTRAL_BORDER}; border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px;`;
const SECTION_TITLE_STYLE = 'font-size: 11.5px; font-weight: 600; color: var(--vscode-foreground);';
const HELP_TEXT_STYLE = `font-size: 10.5px; line-height: 1.4; ${THEMED_DESCRIPTION_COLOR}`;
const BUTTON_STYLE = `padding: 6px 14px; font-size: 12px; border-radius: 6px; cursor: pointer; ${THEMED_SECONDARY_BUTTON_COLORS}`;
const PRIMARY_BUTTON_STYLE = `padding: 6px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; cursor: pointer; ${THEMED_PRIMARY_BUTTON_COLORS}`;

/**
 * The "Edit Lifecycle & Labels" dialog of a workspace (UI-13 / UI-14). Saving writes the lifecycle and labels to the
 * workspace ticket.md; renamed statuses / labels are migrated on all tickets; removed statuses still in use ask for a
 * replacement status first.
 */
export async function openWorkspaceLifecycleDialog(options: IWorkspaceLifecycleDialogOptions): Promise<void> {
	const { workspacesExplorerService: service, notificationService } = options;
	const info = await service.getWorkspaceStatuses(options.workspaceUri);
	const oldStatuses = [...info.statuses];
	const doc = mainWindow.document;
	ensureThemedControlRules();

	const overlay = $('.workspace-lifecycle-dialog-overlay', { style: 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; z-index: 10000; padding: 20px;' });
	const modal = append(overlay, $('div', { role: 'dialog', style: `width: 100%; max-width: 680px; max-height: 86vh; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); color: var(--vscode-foreground); border: 1px solid ${NEUTRAL_BORDER}; border-radius: 12px; padding: 20px 24px; box-shadow: 0 20px 50px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.6)); display: flex; flex-direction: column; overflow: hidden; gap: 12px;` }));

	const header = append(modal, $('div', { style: 'display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;' }));
	const titleEl = append(header, $('div', { style: 'font-weight: 600; font-size: 14px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
	append(titleEl, $('span' + ThemeIcon.asCSSSelector(Codicon.edit)));
	append(titleEl, $('span', {}, options.workspaceName ? `Edit Lifecycle & Labels - ${options.workspaceName}` : 'Edit Lifecycle & Labels'));
	const closeBtn = append(header, $<HTMLButtonElement>('button', { type: 'button', title: 'Close', style: 'display: inline-flex; background: transparent; border: none; cursor: pointer; color: var(--vscode-icon-foreground, var(--vscode-foreground)); padding: 2px;' }));
	append(closeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));

	const body = append(modal, $('div', { style: 'flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding-right: 6px;' }));

	// Status lifecycle
	const statusSection = append(body, $('div', { style: SECTION_STYLE }));
	append(statusSection, $('div', { style: SECTION_TITLE_STYLE }, 'Ticket Statuses Lifecycle (5 Categories)'));
	append(statusSection, $('div', { style: HELP_TEXT_STYLE }, 'Double-click a status to rename it (tickets using it follow the rename). The first status of "Todo" is the initial status, the first of "Removed" is the removed status. Template-defined statuses still take precedence for tickets of that template.'));
	const matrix = renderStatusLifecycleMatrix(statusSection, categoryMapFromLifecycle(info.statuses, info.mapping, info.removedStatus), { allowRename: true, onChange: () => resetMigration() });

	// Labels
	const labelSection = append(body, $('div', { style: SECTION_STYLE }));
	append(labelSection, $('div', { style: SECTION_TITLE_STYLE }, 'Ticket Labels'));
	append(labelSection, $('div', { style: HELP_TEXT_STYLE }, 'Labels tickets of this workspace can carry. Click a color dot to change its color, double-click a name to rename it (tickets follow the rename). Removing a label keeps it on tickets, shown in a neutral color.'));
	const labelsEditor = renderLabelDefinitionsEditor(labelSection, info.labels || []);

	// Migration panel (shown when removed statuses are still used)
	const migrationPanel = append(body, $('div', { style: 'display: none; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35);' }));

	const errorEl = append(modal, $('div', { style: 'display: none; font-size: 11.5px; color: #f87171; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); padding: 6px 10px; border-radius: 6px; flex-shrink: 0;' }));

	const footer = append(modal, $('div', { style: 'display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-shrink: 0;' }));
	const cancelBtn = append(footer, $<HTMLButtonElement>('button.anyag-btn-secondary', { type: 'button', title: 'Discard the changes', style: BUTTON_STYLE }, 'Cancel'));
	const saveBtn = append(footer, $<HTMLButtonElement>('button.anyag-btn-primary', { type: 'button', title: 'Save the lifecycle and labels', style: PRIMARY_BUTTON_STYLE }, 'Save'));

	let replacementSelect: HTMLSelectElement | undefined;
	function resetMigration(): void {
		replacementSelect = undefined;
		migrationPanel.style.display = 'none';
		clearNode(migrationPanel);
		saveBtn.textContent = 'Save';
	}

	const showError = (message: string | undefined) => {
		errorEl.textContent = message || '';
		errorEl.style.display = message ? 'block' : 'none';
	};

	const close = () => {
		doc.removeEventListener('keydown', onKeyDown, true);
		overlay.remove();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	};
	doc.addEventListener('keydown', onKeyDown, true);
	closeBtn.onclick = close;
	cancelBtn.onclick = close;
	overlay.onclick = (e) => {
		if (e.target === overlay) {
			close();
		}
	};

	let saving = false;
	saveBtn.onclick = async () => {
		if (saving) {
			return;
		}
		const categoryMap = matrix.getCategoryMap();
		const invalid = validateCategoryMap(categoryMap);
		if (invalid) {
			showError(invalid);
			return;
		}
		showError(undefined);
		saving = true;
		saveBtn.disabled = true;
		try {
			const config = lifecycleFromCategoryMap(categoryMap);
			const usage = await service.getWorkspaceStatusUsage(options.workspaceUri);
			const plan = planStatusMigration(oldStatuses, config.statuses, matrix.getRenames(), usage);

			if (plan.removedInUse.length > 0 && !replacementSelect) {
				// Ask for a replacement status first
				clearNode(migrationPanel);
				migrationPanel.style.display = 'flex';
				const total = plan.removedInUse.reduce((n, u) => n + u.count, 0);
				append(migrationPanel, $('div', { style: 'font-size: 11.5px; font-weight: 600; color: #fbbf24;' },
					`${total} ticket${total === 1 ? '' : 's'} still use${total === 1 ? 's' : ''} removed status${plan.removedInUse.length === 1 ? '' : 'es'}:`));
				append(migrationPanel, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 5px;' },
					...plan.removedInUse.map(u => $('span', { style: `font-size: 10.5px; padding: 1px 7px; border-radius: 4px; background: ${NEUTRAL_FILL}; border: 1px solid ${NEUTRAL_BORDER};` }, `${u.status} (${u.count})`))));
				const row = append(migrationPanel, $('div', { style: 'display: flex; align-items: center; gap: 8px; font-size: 11px;' }));
				append(row, $('span', { style: 'opacity: 0.8;' }, 'Move them to:'));
				const select = append(row, $<HTMLSelectElement>('select.monaco-select-box.anyag-themed-input', { style: `padding: 3px 8px; font-size: 11px; border-radius: 4px; ${THEMED_INPUT_COLORS}` }));
				for (const st of config.statuses) {
					append(select, $('option', { value: st }, st));
				}
				select.value = config.initialStatus;
				replacementSelect = select;
				append(migrationPanel, $('div', { style: HELP_TEXT_STYLE }, 'Click "Migrate & Save" to apply, or Cancel to keep the current lifecycle.'));
				saveBtn.textContent = 'Migrate & Save';
				migrationPanel.scrollIntoView({ block: 'nearest' });
				return;
			}

			const migration = buildStatusMigration(plan, replacementSelect?.value);
			const labels = labelsEditor.getLabels();
			const labelRenames: { [from: string]: string } = {};
			for (const [from, to] of Object.entries(labelsEditor.getRenames())) {
				if (labels.some(l => l.name === to)) {
					labelRenames[from] = to;
				}
			}
			const result = await service.updateWorkspaceLifecycle(options.workspaceUri, {
				statuses: config.statuses,
				mapping: config.mapping,
				removedStatus: config.removedStatus,
				labels,
				statusMigration: migration,
				labelRenames
			});
			close();
			notificationService.info(result.migratedTickets > 0
				? `Workspace lifecycle & labels saved. ${result.migratedTickets} ticket${result.migratedTickets === 1 ? '' : 's'} updated.`
				: 'Workspace lifecycle & labels saved.');
			options.onSaved?.();
		} catch (err) {
			showError(`Failed to save: ${(err as Error | undefined)?.message || err}`);
		} finally {
			saving = false;
			saveBtn.disabled = false;
		}
	};

	themedOverlayHost(options.anchor).appendChild(overlay);
}
