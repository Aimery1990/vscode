/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICustomModule, ICustomField, ICompositeComponent } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../common/customModules.js';

export interface ISchemaDesignerOptions {
	workspaceUri?: URI;
	targetModuleId?: string;
	onUpdate?: () => void;
}

function getColorForName(name: string): string {
	const colors = ['#fbbf24', '#a78bfa', '#60a5fa', '#0d9488', '#f472b6', '#38bdf8', '#34d399', '#f87171'];
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return colors[Math.abs(hash) % colors.length];
}

export class CustomModulesSchemaDesignerDialog {

	constructor(
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService
	) { }

	public async open(options: ISchemaDesignerOptions): Promise<void> {
		const targetUri = options.workspaceUri;
		const onUpdate = options.onUpdate || (() => {});

		const mgOverlay = append(document.body, $('.manage-modules-overlay'));
		mgOverlay.style.position = 'fixed';
		mgOverlay.style.top = '0';
		mgOverlay.style.left = '0';
		mgOverlay.style.width = '100vw';
		mgOverlay.style.height = '100vh';
		mgOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
		mgOverlay.style.backdropFilter = 'blur(6px)';
		mgOverlay.style.display = 'flex';
		mgOverlay.style.alignItems = 'center';
		mgOverlay.style.justifyContent = 'center';
		mgOverlay.style.zIndex = '11000';

		const mgModal = append(mgOverlay, $('.manage-modules-modal'));
		mgModal.style.width = '100%';
		mgModal.style.maxWidth = '480px';
		mgModal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		mgModal.style.border = '1px solid rgba(255, 255, 255, 0.18)';
		mgModal.style.borderRadius = '12px';
		mgModal.style.padding = '20px 24px';
		mgModal.style.boxShadow = '0 16px 40px rgba(0,0,0,0.8)';
		mgModal.style.display = 'flex';
		mgModal.style.flexDirection = 'column';
		mgModal.style.gap = '14px';
		mgModal.style.color = 'var(--vscode-editorWidget-foreground, #e0e0e0)';
		mgModal.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		mgModal.style.transition = 'max-width 0.25s cubic-bezier(0.4, 0, 0.2, 1)';

		let selectedModule: ICustomModule | null = null;

		if (options.targetModuleId) {
			const allMods = await this.customModulesService.getCustomModules(targetUri);
			const target = allMods.find(m => m.id.toLowerCase() === options.targetModuleId!.toLowerCase());
			if (target) {
				selectedModule = JSON.parse(JSON.stringify(target));
			}
		}

		const renderManagerContent = async () => {
			clearNode(mgModal);

			if (!selectedModule) {
				// --- STAGE 1: List View ---
				mgModal.style.maxWidth = '520px';

				const mgHeader = append(mgModal, $('.mg-header', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
				append(mgHeader, $('div', { style: 'font-weight: 600; font-size: 14px; color: #38bdf8;' }, 'Manage Custom Modules'));
				const mgClose = append(mgHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close), { style: 'cursor: pointer; font-size: 13px; opacity: 0.7;' }));
				mgClose.onclick = () => {
					mgOverlay.remove();
					onUpdate();
				};

				const formGroup = append(mgModal, $('.form-group', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
				append(formGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 500;' }, 'Create New Module Name:'));
				const inputRow = append(formGroup, $('div', { style: 'display: flex; gap: 8px;' }));
				const nameInputEl = append(inputRow, $('input.monaco-inputbox', {
					style: 'flex: 1; padding: 6px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
				})) as HTMLInputElement;
				nameInputEl.placeholder = 'e.g. Test, Release, Design...';

				const addBtn = append(inputRow, $('button.monaco-button', {
					style: 'padding: 6px 14px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
				}));
				addBtn.innerText = 'Add';

				const errorText = append(formGroup, $('div', { style: 'font-size: 11px; color: #ef4444; display: none;' }));

				const listContainer = append(mgModal, $('.modules-list-container', {
					style: 'max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px; background: rgba(0,0,0,0.15);'
				}));

				const refreshList = async () => {
					clearNode(listContainer);
					const currentModules = await this.customModulesService.getCustomModules(targetUri);

					if (currentModules.length === 0) {
						append(listContainer, $('div', { style: 'font-size: 11px; opacity: 0.5; text-align: center; padding: 16px; color: #888888;' }, 'No custom modules created yet.'));
						return;
					}

					for (const m of currentModules) {
						const row = append(listContainer, $('.module-row', {
							style: 'display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04);'
						}));

						const left = append(row, $('.module-left', { style: 'display: flex; align-items: center; gap: 8px;' }));
						const dot = append(left, $('span'));
						dot.style.display = 'inline-block';
						dot.style.width = '8px';
						dot.style.height = '8px';
						dot.style.borderRadius = '50%';
						dot.style.backgroundColor = m.color;

						const nameSpan = append(left, $('span', { style: 'font-size: 12px; font-weight: 500;' }, m.name));
						if (m.isDeprecated) {
							nameSpan.style.opacity = '0.5';
							nameSpan.style.textDecoration = 'line-through';
							const depLabel = append(left, $('span', { style: 'font-size: 10px; color: #fb923c; background: rgba(251,146,60,0.12); border: 1px solid rgba(251,146,60,0.3); border-radius: 3px; padding: 1px 4px;' }));
							depLabel.innerText = 'Deprecated';
						}

						const right = append(row, $('.module-right', { style: 'display: flex; align-items: center; gap: 10px;' }));

						// Edit Button
						if (!m.isDeprecated) {
							const editIcon = append(right, $('span' + ThemeIcon.asCSSSelector(Codicon.edit), {
								style: 'font-size: 12px; cursor: pointer; color: #38bdf8; opacity: 0.8;'
							}));
							editIcon.title = 'Edit Module Schema';
							editIcon.onclick = () => {
								selectedModule = JSON.parse(JSON.stringify(m));
								renderManagerContent();
							};
						}

						// Deactivate / Restore Button
						const actBtn = append(right, $('span', {
							style: 'font-size: 11px; cursor: pointer; text-decoration: underline;'
						}));
						if (m.isDeprecated) {
							actBtn.innerText = 'Restore';
							actBtn.style.color = '#34d399';
							actBtn.onclick = async () => {
								m.isDeprecated = false;
								await this.customModulesService.saveCustomModules(currentModules, targetUri);
								await refreshList();
							};
						} else {
							actBtn.innerText = 'Deactivate';
							actBtn.style.color = '#fb923c';
							actBtn.onclick = async () => {
								m.isDeprecated = true;
								await this.customModulesService.saveCustomModules(currentModules, targetUri);
								await refreshList();
							};
						}

						// Delete Button
						const delIcon = append(right, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
							style: 'font-size: 12px; cursor: pointer; color: #ef4444; opacity: 0.7;'
						}));
						delIcon.title = 'Delete Module';
						delIcon.onclick = async () => {
							const res = await this.dialogService.confirm({
								message: `Delete custom module "${m.name}"?`,
								detail: `This will remove the YAML schema file (${m.id}.yaml). Existing tickets of this type will keep their data.`,
								primaryButton: 'Delete'
							});
							if (res.confirmed) {
								await this.customModulesService.deleteCustomModule(m.id, targetUri);
								await refreshList();
							}
						};
					}
				};

				addBtn.onclick = async () => {
					const val = nameInputEl.value.trim();
					if (!val) {
						errorText.innerText = 'Please enter a valid module name.';
						errorText.style.display = 'block';
						return;
					}

					const id = val.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
					const currentModules = await this.customModulesService.getCustomModules(targetUri);

					const isReserved = ['workspace', 'job', 'project', 'task', 'workflow', 'case', 'agent', 'issue', 'analysis', 'folder', 'file'].includes(id);
					if (isReserved) {
						errorText.innerText = `"${val}" is a reserved system module name.`;
						errorText.style.display = 'block';
						return;
					}

					if (currentModules.some((m: ICustomModule) => m.id === id)) {
						errorText.innerText = `Module "${val}" already exists.`;
						errorText.style.display = 'block';
						return;
					}

					errorText.style.display = 'none';
					const color = getColorForName(val);
					const newModule: ICustomModule = {
						id,
						name: val,
						color,
						storageScope: 'global',
						fields: []
					};

					selectedModule = newModule;
					nameInputEl.value = '';
					renderManagerContent();
				};

				nameInputEl.onkeydown = (e) => {
					if (e.key === 'Enter') {
						addBtn.click();
					}
				};

				const mgFooter = append(mgModal, $('.mg-footer', { style: 'display: flex; justify-content: flex-end; margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;' }));
				const doneBtn = append(mgFooter, $('button.monaco-button', {
					style: 'padding: 6px 16px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.15); font-weight: 600;'
				}));
				doneBtn.innerText = 'Close';
				doneBtn.onclick = async () => {
					mgOverlay.remove();
					onUpdate();
				};

				await refreshList();
			} else {
				// --- STAGE 2: Specialized Module Editor Canvas ---
				mgModal.style.maxWidth = '1020px';
				const activeMod = selectedModule;

				// Header
				const mgHeader = append(mgModal, $('.mg-header', { style: 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;' }));
				append(mgHeader, $('div', { style: 'font-weight: 600; font-size: 14px; color: #38bdf8;' }, `Edit Module Schema: ${activeMod.name}`));
				const mgBack = append(mgHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close), { style: 'cursor: pointer; font-size: 13px; opacity: 0.7;' }));
				mgBack.onclick = () => {
					selectedModule = null;
					renderManagerContent();
				};

				// Metadata & Options configuration layout
				const configMetaContainer = append(mgModal, $('.config-meta-container', { style: 'display: flex; flex-direction: column; gap: 10px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); padding: 12px 16px; border-radius: 8px;' }));
				const configTopRow = append(configMetaContainer, $('.config-top-row', { style: 'display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap;' }));
				const topLeftGroup = append(configTopRow, $('.top-left-group', { style: 'display: flex; gap: 16px; align-items: center; flex: 1; min-width: 320px;' }));

				activeMod.storageScope = 'global';

				// Type Definition (Description) Input
				const defGroup = append(topLeftGroup, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
				append(defGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Type Definition:'));
				const defInput = append(defGroup, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box;'
				})) as HTMLInputElement;
				defInput.placeholder = 'e.g. Explains purpose of this module...';
				defInput.value = activeMod.description || '';
				defInput.oninput = () => {
					activeMod.description = defInput.value;
				};

				// Color Picker container
				const colorContainer = append(configTopRow, $('div', { style: 'display: flex; align-items: center; gap: 12px;' }));
				const renderColorPicker = () => {
					colorContainer.textContent = '';
					append(colorContainer, $('span', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888;' }, 'Module Color:'));
					const pickerRow = append(colorContainer, $('div', { style: 'display: flex; gap: 6px;' }));
					const colors = ['#fbbf24', '#a78bfa', '#60a5fa', '#0d9488', '#f472b6', '#38bdf8', '#34d399', '#f87171'];
					colors.forEach(c => {
						const dot = append(pickerRow, $('span', {
							style: `display: inline-block; width: 18px; height: 18px; border-radius: 50%; background-color: ${c}; cursor: pointer; border: 2px solid ${activeMod.color === c ? '#fff' : 'transparent'}; box-sizing: border-box; transition: transform 0.1s ease;`
						}));
						dot.onclick = () => {
							activeMod.color = c;
							renderColorPicker();
						};
					});
				};
				renderColorPicker();

				// Multi-line Type Prompt Section
				const promptGroup = append(configMetaContainer, $('.form-group.config-prompt-section', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
				const promptLabelRow = append(promptGroup, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
				append(promptLabelRow, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #38bdf8;' }, 'Type Prompt (AI System Instructions for this Module):'));
				append(promptLabelRow, $('span', { style: 'font-size: 10px; opacity: 0.5;' }, 'Multi-line AI instructions when tickets of this type are processed'));

				const typePromptInput = append(promptGroup, $('textarea.monaco-inputbox', {
					rows: '2',
					style: 'width: 100%; min-height: 48px; padding: 6px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit; line-height: 1.4;'
				})) as HTMLTextAreaElement;
				typePromptInput.placeholder = 'e.g. Instructions for AI to process tickets of this type...';
				typePromptInput.value = activeMod.prompt || '';
				typePromptInput.oninput = () => {
					activeMod.prompt = typePromptInput.value;
				};

				// Main columns
				const modalLayoutContainer = append(mgModal, $('.modal-layout-container', { style: 'display: flex; gap: 20px; width: 100%; height: 480px; overflow: hidden;' }));
				
				// Left Column: Palette library
				const leftColumn = append(modalLayoutContainer, $('.left-col', { style: 'flex: 32; border-right: 1px solid rgba(255,255,255,0.08); padding-right: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;' }));

				// Right Column: Canvas list
				const rightColumn = append(modalLayoutContainer, $('.right-col', { style: 'flex: 68; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding-left: 6px;' }));
				const fieldsListContainer = append(rightColumn, $('.fields-list-container', {
					style: 'display: flex; flex-direction: column; gap: 10px; min-height: 100%;'
				}));

				const getBadgeStyle = (type: string) => {
					const colorMap: { [key: string]: { bg: string; text: string } } = {
						text: { bg: 'rgba(56,189,248,0.12)', text: '#38bdf8' },
						textarea: { bg: 'rgba(129,140,248,0.12)', text: '#818cf8' },
						select: { bg: 'rgba(167,139,250,0.12)', text: '#a78bfa' },
						multiselect: { bg: 'rgba(192,132,252,0.12)', text: '#c084fc' },
						switch: { bg: 'rgba(45,212,191,0.12)', text: '#2dd4bf' },
						date: { bg: 'rgba(52,211,153,0.12)', text: '#34d399' },
						time: { bg: 'rgba(251,191,36,0.12)', text: '#fbbf24' },
						datetime: { bg: 'rgba(96,165,250,0.12)', text: '#60a5fa' },
						date_range: { bg: 'rgba(16,185,129,0.12)', text: '#10b981' },
						time_range: { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b' },
						datetime_range: { bg: 'rgba(236,72,153,0.12)', text: '#ec4899' },
						dynamic_list: { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4' },
						attachment: { bg: 'rgba(16,185,129,0.15)', text: '#10b981' },
						browser: { bg: 'rgba(56,189,248,0.15)', text: '#38bdf8' },
						git: { bg: 'rgba(249,115,22,0.15)', text: '#f97316' }
					};
					const c = colorMap[type] || colorMap.text;
					return `font-size: 9px; padding: 2px 6px; border-radius: 4px; background: ${c.bg}; color: ${c.text}; text-transform: uppercase; font-weight: bold; letter-spacing: 0.05em;`;
				};

				const primitiveTypes = [
					{ type: 'text', label: 'Single-line Input (Text)', icon: Codicon.symbolString },
					{ type: 'textarea', label: 'Textarea (Multiline)', icon: Codicon.listFlat },
					{ type: 'select', label: 'Dropdown (Select)', icon: Codicon.chevronDown },
					{ type: 'multiselect', label: 'Checkboxes (Multiselect)', icon: Codicon.checklist },
					{ type: 'switch', label: 'Switch (Toggle)', icon: Codicon.circleFilled },
					{ type: 'date', label: 'Single Date Picker', icon: Codicon.calendar },
					{ type: 'time', label: 'Single Time Picker', icon: Codicon.watch },
					{ type: 'datetime', label: 'Single DateTime Picker', icon: Codicon.history },
					{ type: 'date_range', label: 'Date Range (Start ~ End)', icon: Codicon.calendar },
					{ type: 'time_range', label: 'Time Range (Start ~ End)', icon: Codicon.watch },
					{ type: 'datetime_range', label: 'DateTime Range (Start ~ End)', icon: Codicon.history },
					{ type: 'dynamic_list', label: 'Container (Nested Subfields)', icon: Codicon.layers },
					{ type: 'attachment', label: 'Attachment (Files / Images / PDF)', icon: Codicon.files },
					{ type: 'browser', label: 'Browser (Web Navigation)', icon: Codicon.globe },
					{ type: 'git', label: 'Git Repository Binding', icon: Codicon.sourceControl }
				];

				let currentDraggingItem: { source: 'palette' | 'canvas' | 'subcanvas'; type?: string; label?: string; isClass?: boolean; classId?: string; itemFields?: any[]; canvasIndex?: number; subIndex?: number } | null = null;

				const refreshLeftPalette = async () => {
					clearNode(leftColumn);
					append(leftColumn, $('div', { style: 'font-size: 11px; opacity: 0.85; font-weight: 700; text-transform: uppercase; color: #888888;' }, 'Component Library'));
					append(leftColumn, $('div', { style: 'font-size: 10px; opacity: 0.5; line-height: 1.4;' }, 'Drag & drop components to the canvas on the right, or click to append.'));

					const primSection = append(leftColumn, $('.prim-section', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					append(primSection, $('div', { style: 'font-size: 10px; font-weight: 600; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;' }, 'Base Primitives'));

					primitiveTypes.forEach(ft => {
						const btn = append(primSection, $('button.monaco-button', {
							style: 'padding: 6px 10px; font-size: 11px; border-radius: 5px; cursor: grab; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: inherit; display: flex; align-items: center; gap: 8px; text-align: left;'
						}));
						btn.setAttribute('draggable', 'true');
						btn.ondragstart = (ev) => {
							currentDraggingItem = { source: 'palette', type: ft.type, label: ft.label };
							ev.dataTransfer?.setData('text/plain', ft.type);
						};
						btn.ondragend = () => {
							currentDraggingItem = null;
						};

						const btnIcon = append(btn, $('span' + ThemeIcon.asCSSSelector(ft.icon)));
						btnIcon.style.opacity = '0.7';
						append(btn, $('span', {}, ft.label));

						btn.onclick = () => {
							if (!activeMod.fields) { activeMod.fields = []; }
							const fieldId = `field_${Date.now()}`;
							const newF: ICustomField = {
								id: fieldId,
								label: ft.type === 'dynamic_list' ? 'New Dynamic List' : `New ${ft.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
								type: ft.type as any,
								options: (ft.type === 'select' || ft.type === 'multiselect') ? ['Option 1', 'Option 2'] : undefined,
								itemFields: ft.type === 'dynamic_list' ? [
									{ id: `sub_${Date.now()}_1`, label: 'Item Name', type: 'text' },
									{ id: `sub_${Date.now()}_2`, label: 'Service Period', type: 'date_range' },
									{ id: `sub_${Date.now()}_3`, label: 'Description', type: 'textarea' }
								] : undefined
							};
							activeMod.fields.push(newF);
							renderFieldList();
							rightColumn.scrollTop = rightColumn.scrollHeight;
						};
					});

					// Section 2: Saved Composite Classes
					const compSection = append(leftColumn, $('.comp-section', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px;' }));
					append(compSection, $('div', { style: 'font-size: 10px; font-weight: 600; color: #06b6d4; text-transform: uppercase; letter-spacing: 0.05em;' }, 'My Composite Classes'));

					const savedClasses = await this.customModulesService.getCompositeComponents(targetUri);
					if (savedClasses.length === 0) {
						append(compSection, $('div', { style: 'font-size: 10px; opacity: 0.45; font-style: italic; padding: 4px 0;' }, 'No saved classes yet. Design a Dynamic Container & click "Save as Class".'));
					} else {
						savedClasses.forEach(sc => {
							const cRow = append(compSection, $('div', { style: 'display: flex; align-items: center; gap: 4px;' }));
							const cBtn = append(cRow, $('button.monaco-button', {
								style: 'flex: 1; padding: 6px 8px; font-size: 11px; border-radius: 5px; cursor: grab; background: rgba(6,182,212,0.08); border: 1px solid rgba(6,182,212,0.25); color: #06b6d4; display: flex; align-items: center; gap: 6px; text-align: left;'
							}));
							cBtn.setAttribute('draggable', 'true');
							cBtn.ondragstart = (ev) => {
								currentDraggingItem = { source: 'palette', type: 'dynamic_list', label: sc.name, isClass: true, classId: sc.id, itemFields: sc.itemFields };
								ev.dataTransfer?.setData('text/plain', sc.id);
							};
							cBtn.ondragend = () => {
								currentDraggingItem = null;
							};

							append(cBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolClass)));
							append(cBtn, $('span', { style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, sc.name));

							cBtn.onclick = () => {
								if (!activeMod.fields) { activeMod.fields = []; }
								const fieldId = `field_${Date.now()}`;
								activeMod.fields.push({
									id: fieldId,
									label: sc.name,
									type: 'dynamic_list',
									componentRef: sc.id,
									itemFields: JSON.parse(JSON.stringify(sc.itemFields || []))
								});
								renderFieldList();
								rightColumn.scrollTop = rightColumn.scrollHeight;
							};

							const trashBtn = append(cRow, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
								style: 'color: #ef4444; opacity: 0.6; cursor: pointer; padding: 4px; font-size: 11px;'
							}));
							trashBtn.onclick = async () => {
								await this.customModulesService.deleteCompositeComponent(sc, targetUri);
								await refreshLeftPalette();
							};
						});
					}
				};

				fieldsListContainer.ondragover = (ev) => {
					ev.preventDefault();
				};
				fieldsListContainer.ondrop = (ev) => {
					ev.preventDefault();
					if (currentDraggingItem && currentDraggingItem.source === 'palette') {
						if (!activeMod.fields) { activeMod.fields = []; }
						if (currentDraggingItem.isClass) {
							activeMod.fields.push({
								id: `field_${Date.now()}`,
								label: currentDraggingItem.label || 'Composite Class',
								type: 'dynamic_list',
								componentRef: currentDraggingItem.classId,
								itemFields: JSON.parse(JSON.stringify(currentDraggingItem.itemFields || []))
							});
						} else {
							const pType = currentDraggingItem.type || 'text';
							activeMod.fields.push({
								id: `field_${Date.now()}`,
								label: pType === 'dynamic_list' ? 'New Dynamic List' : `New ${pType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
								type: pType as any,
								options: (pType === 'select' || pType === 'multiselect') ? ['Option 1', 'Option 2'] : undefined,
								itemFields: pType === 'dynamic_list' ? [
									{ id: `sub_${Date.now()}_1`, label: 'Item Name', type: 'text' },
									{ id: `sub_${Date.now()}_2`, label: 'Service Period', type: 'date_range' },
									{ id: `sub_${Date.now()}_3`, label: 'Description', type: 'textarea' }
								] : undefined
							});
						}
						currentDraggingItem = null;
						renderFieldList();
						rightColumn.scrollTop = rightColumn.scrollHeight;
					}
				};

				const renderFieldList = () => {
					clearNode(fieldsListContainer);
					const fields = activeMod.fields || [];

					if (fields.length === 0) {
						const empty = append(fieldsListContainer, $('div', { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 260px; border: 1.5px dashed rgba(255,255,255,0.08); border-radius: 8px; color: #888888; gap: 8px;' }));
						append(empty, $('span' + ThemeIcon.asCSSSelector(Codicon.package), { style: 'font-size: 24px; opacity: 0.5;' }));
						append(empty, $('div', { style: 'font-size: 12px;' }, 'Drag & drop components here or click from palette to design your schema.'));
						return;
					}

					fields.forEach((field, fIdx) => {
						const isContainer = field.type === 'dynamic_list';
						const fieldCard = append(fieldsListContainer, $('.field-card', {
							style: isContainer
								? 'padding: 12px 14px; border-radius: 8px; background: rgba(6, 182, 212, 0.04); border: 1px solid rgba(6, 182, 212, 0.25); display: flex; flex-direction: column; gap: 10px; cursor: grab; position: relative; transition: border-color 0.15s ease;'
								: 'padding: 12px 14px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 8px; cursor: grab; position: relative; transition: border-color 0.15s ease;'
						}));
						fieldCard.setAttribute('draggable', 'true');

						fieldCard.onmousedown = (e) => {
							const target = e.target as HTMLElement;
							if (target.closest('input, textarea, button, select, span, label, .subfields-canvas')) {
								fieldCard.setAttribute('draggable', 'false');
							} else {
								fieldCard.setAttribute('draggable', 'true');
							}
						};

						fieldCard.ondragstart = (ev) => {
							currentDraggingItem = { source: 'canvas', canvasIndex: fIdx };
							ev.dataTransfer?.setData('text/plain', String(fIdx));
						};
						fieldCard.ondragover = (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							fieldCard.style.borderColor = '#38bdf8';
						};
						fieldCard.ondragleave = () => {
							fieldCard.style.borderColor = isContainer ? 'rgba(6, 182, 212, 0.25)' : 'rgba(255,255,255,0.05)';
						};
						fieldCard.ondrop = (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							fieldCard.style.borderColor = isContainer ? 'rgba(6, 182, 212, 0.25)' : 'rgba(255,255,255,0.05)';

							if (currentDraggingItem) {
								if (currentDraggingItem.source === 'palette') {
									const newField: ICustomField = currentDraggingItem.isClass ? {
										id: `field_${Date.now()}`,
										label: currentDraggingItem.label || 'Composite Class',
										type: 'dynamic_list',
										componentRef: currentDraggingItem.classId,
										itemFields: JSON.parse(JSON.stringify(currentDraggingItem.itemFields || []))
									} : {
										id: `field_${Date.now()}`,
										label: currentDraggingItem.type === 'dynamic_list' ? 'New Dynamic List' : `New ${currentDraggingItem.type!.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
										type: currentDraggingItem.type as any,
										options: (currentDraggingItem.type === 'select' || currentDraggingItem.type === 'multiselect') ? ['Option 1', 'Option 2'] : undefined,
										itemFields: currentDraggingItem.type === 'dynamic_list' ? [
											{ id: `sub_${Date.now()}_1`, label: 'Item Name', type: 'text' },
											{ id: `sub_${Date.now()}_2`, label: 'Service Period', type: 'date_range' },
											{ id: `sub_${Date.now()}_3`, label: 'Description', type: 'textarea' }
										] : undefined
									};
									activeMod.fields?.splice(fIdx, 0, newField);
									currentDraggingItem = null;
									renderFieldList();
								} else if (currentDraggingItem.source === 'canvas') {
									const fromIdx = currentDraggingItem.canvasIndex;
									if (fromIdx !== undefined && fromIdx !== fIdx && activeMod.fields) {
										const [moved] = activeMod.fields.splice(fromIdx, 1);
										activeMod.fields.splice(fIdx, 0, moved);
										currentDraggingItem = null;
										renderFieldList();
									}
								}
							}
						};

						// Card Header
						const cardHeader = append(fieldCard, $('.card-header', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
						const headLeft = append(cardHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
						append(headLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.grabber), { style: 'opacity: 0.35; cursor: grab;' }));
						const badge = append(headLeft, $('span', { style: getBadgeStyle(field.type) }));
						badge.innerText = field.type.replace(/_/g, ' ');

						if (field.componentRef) {
							const refBadge = append(headLeft, $('span', { style: 'font-size: 9px; padding: 2px 6px; border-radius: 4px; background: rgba(6,182,212,0.1); color: #06b6d4; font-weight: 600;' }));
							refBadge.innerText = `Class: ${field.label}`;
						}

						const headRight = append(cardHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));

						// Move Up
						if (fIdx > 0) {
							const upBtn = append(headRight, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
							upBtn.title = 'Move Up';
							upBtn.onclick = () => {
								const [f] = activeMod.fields!.splice(fIdx, 1);
								activeMod.fields!.splice(fIdx - 1, 0, f);
								renderFieldList();
							};
						}

						// Move Down
						if (fIdx < fields.length - 1) {
							const downBtn = append(headRight, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
							downBtn.title = 'Move Down';
							downBtn.onclick = () => {
								const [f] = activeMod.fields!.splice(fIdx, 1);
								activeMod.fields!.splice(fIdx + 1, 0, f);
								renderFieldList();
							};
						}

						// Delete Button
						const delBtn = append(headRight, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px; color: #ef4444;' }));
						delBtn.title = 'Remove Field';
						delBtn.onclick = () => {
							activeMod.fields?.splice(fIdx, 1);
							renderFieldList();
						};

						// Card Body: Label input
						const labelRow = append(fieldCard, $('.label-row', { style: 'display: flex; gap: 8px; align-items: center;' }));
						append(labelRow, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 500; min-width: 70px;' }, 'Field Label:'));
						const labelInput = append(labelRow, $('input.monaco-inputbox', {
							style: 'flex: 1; padding: 4px 8px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.2); color: inherit;'
						})) as HTMLInputElement;
						labelInput.value = field.label;
						labelInput.oninput = () => {
							field.label = labelInput.value;
						};

						// Options Row for select / multiselect
						if (field.type === 'select' || field.type === 'multiselect') {
							const optRow = append(fieldCard, $('.opt-row', { style: 'display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; background: rgba(0,0,0,0.15); border-radius: 6px;' }));
							append(optRow, $('label', { style: 'font-size: 10px; opacity: 0.8; font-weight: 600; text-transform: uppercase;' }, 'Choices / Options:'));
							const optList = append(optRow, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center;' }));
							if (!field.options) { field.options = ['Option 1', 'Option 2']; }

							const renderOpts = () => {
								clearNode(optList);
								field.options?.forEach((opt, oIdx) => {
									const tag = append(optList, $('.opt-tag', { style: 'display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 11px;' }));
									const optInp = append(tag, $('input', {
										style: 'background: transparent; border: none; color: inherit; font-size: 11px; width: 80px;'
									})) as HTMLInputElement;
									optInp.value = opt;
									optInp.oninput = () => {
										field.options![oIdx] = optInp.value;
									};

									const rmOpt = append(tag, $('span', { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }, '×'));
									rmOpt.onclick = () => {
										field.options?.splice(oIdx, 1);
										renderOpts();
									};
								});

								const addOptBtn = append(optList, $('button.monaco-button', {
									style: 'padding: 2px 8px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); color: inherit;'
								}));
								addOptBtn.innerText = '+ Add Option';
								addOptBtn.onclick = () => {
									field.options?.push(`Option ${field.options.length + 1}`);
									renderOpts();
								};
							};
							renderOpts();
						}

						// Dynamic Container / Sub-fields Canvas
						if (field.type === 'dynamic_list') {
							const subCanvas = append(fieldCard, $('.subfields-canvas', {
								style: 'padding: 10px 12px; background: rgba(0,0,0,0.25); border: 1.5px dashed rgba(6,182,212,0.3); border-radius: 6px; display: flex; flex-direction: column; gap: 8px;'
							}));

							const renderSubFieldsList = () => {
								clearNode(subCanvas);
								append(subCanvas, $('div', { style: 'font-size: 10px; font-weight: 700; text-transform: uppercase; color: #06b6d4; letter-spacing: 0.05em;' }, 'Composite Item Template (Sub-Fields):'));

								if (!field.itemFields) { field.itemFields = []; }

								field.itemFields.forEach((subF, sIdx) => {
									const subCard = append(subCanvas, $('.subfield-card', {
										style: 'padding: 8px 10px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 5px; display: flex; flex-direction: column; gap: 6px; cursor: grab; position: relative;'
									}));

									const subTop = append(subCard, $('.sub-top', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
									const subBadge = append(subTop, $('span', { style: getBadgeStyle(subF.type) }));
									subBadge.innerText = subF.type.replace(/_/g, ' ');

									const subActs = append(subTop, $('.sub-actions', { style: 'display: flex; gap: 6px; align-items: center;' }));
									if (sIdx > 0) {
										const uB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
										uB.onclick = () => {
											const [sf] = field.itemFields!.splice(sIdx, 1);
											field.itemFields!.splice(sIdx - 1, 0, sf);
											renderSubFieldsList();
										};
									}
									if (sIdx < field.itemFields!.length - 1) {
										const dB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
										dB.onclick = () => {
											const [sf] = field.itemFields!.splice(sIdx, 1);
											field.itemFields!.splice(sIdx + 1, 0, sf);
											renderSubFieldsList();
										};
									}
									const dBtn = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px; color: #ef4444;' }));
									dBtn.onclick = () => {
										field.itemFields?.splice(sIdx, 1);
										renderSubFieldsList();
									};

									const subInpRow = append(subCard, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
									append(subInpRow, $('label', { style: 'font-size: 10px; opacity: 0.75; min-width: 60px;' }, 'Sub-Label:'));
									const subInp = append(subInpRow, $('input.monaco-inputbox', {
										style: 'flex: 1; padding: 3px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.2); color: inherit;'
									})) as HTMLInputElement;
									subInp.value = subF.label;
									subInp.oninput = () => {
										subF.label = subInp.value;
									};
								});

								// Add sub-field row
								const addSubRow = append(subCanvas, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 4px;' }));
								const addSubBtn = append(addSubRow, $('button.monaco-button', {
									style: 'padding: 4px 10px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(6,182,212,0.12); border: 1px solid rgba(6,182,212,0.3); color: #06b6d4;'
								}));
								addSubBtn.innerText = '+ Add Sub-Field';
								addSubBtn.onclick = () => {
									field.itemFields?.push({
										id: `sub_${Date.now()}`,
										label: `New Text Field`,
										type: 'text'
									});
									renderSubFieldsList();
								};

								// Save as Class button
								const saveClassBtn = append(addSubRow, $('button.monaco-button', {
									style: 'padding: 4px 10px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: inherit;'
								}));
								saveClassBtn.innerText = 'Save as Class';
								saveClassBtn.onclick = async () => {
									const className = field.label || 'My Composite Class';
									const newClass: ICompositeComponent = {
										id: `comp_${Date.now()}`,
										name: className,
										itemFields: JSON.parse(JSON.stringify(field.itemFields || [])),
										storageScope: activeMod.storageScope
									};
									await this.customModulesService.saveCompositeComponent(newClass, targetUri);
									this.notificationService.info(`Saved composite class "${className}" to Component Library!`);
									await refreshLeftPalette();
								};
							};

							renderSubFieldsList();
						}
					});
				};

				renderFieldList();
				await refreshLeftPalette();

				// Footer Actions (Save & Cancel)
				const footer = append(mgModal, $('.editor-footer', { style: 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;' }));

				const cancelBtn = append(footer, $('button.monaco-button', {
					style: 'padding: 6px 14px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: inherit;'
				}));
				cancelBtn.innerText = 'Cancel';
				cancelBtn.onclick = () => {
					selectedModule = null;
					renderManagerContent();
				};

				const saveBtn = append(footer, $('button.monaco-button', {
					style: 'padding: 6px 18px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
				}));
				saveBtn.innerText = 'Save Module Schema';
				saveBtn.onclick = async () => {
					try {
						const currentModules = await this.customModulesService.getCustomModules(targetUri);
						const index = currentModules.findIndex(m => m.id === activeMod.id);
						if (index !== -1) {
							currentModules[index] = activeMod;
						} else {
							currentModules.push(activeMod);
						}
						await this.customModulesService.saveCustomModules(currentModules, targetUri);
						this.notificationService.info(`Saved schema for module "${activeMod.name}".`);
						selectedModule = null;
						await renderManagerContent();
					} catch (e) {
						this.notificationService.error(`Failed to save schema: ${e}`);
					}
				};
			}
		};

		await renderManagerContent();
	}
}
