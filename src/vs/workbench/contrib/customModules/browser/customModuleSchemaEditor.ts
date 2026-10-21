/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ICustomModule, ICustomField, CustomFieldType, ICompositeComponent, IStatusDefinition, IActionButton, DEFAULT_STATUS_DEFINITIONS } from '../../entityPersistence/common/entityPersistence.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICustomModulesService } from '../common/customModules.js';
import { CustomModuleSchemaEditorInput } from './customModuleSchemaEditorInput.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';

export class CustomModuleSchemaEditor extends EditorPane {
	static readonly ID = 'workbench.editor.customModuleSchema';

	private _container?: HTMLElement;
	private _activeModule?: ICustomModule;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IRequestService private readonly _requestService: IRequestService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super(CustomModuleSchemaEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.custom-module-schema-editor'));
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflowY = 'auto';
		this._container.style.overflowX = 'hidden';
		this._container.style.boxSizing = 'border-box';
		this._container.style.background = 'var(--vscode-editor-background, #181818)';
		this._container.style.color = 'var(--vscode-editor-foreground, #e0e0e0)';
		this._container.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		this._container.style.padding = '24px 32px';
	}

	override layout(dimension: Dimension): void {
		// Native layout in _container automatically fills dimension
	}

	override async setInput(input: CustomModuleSchemaEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this._loadAndRender(input);
	}

	override clearInput(): void {
		this._syncDraft();
		if (this._container) {
			clearNode(this._container);
		}
		this._activeModule = undefined;
		super.clearInput();
	}

	override dispose(): void {
		if (this._container) {
			clearNode(this._container);
			this._container = undefined;
		}
		super.dispose();
	}

	private _syncDraft(): void {
		if (this.input instanceof CustomModuleSchemaEditorInput && this._activeModule) {
			this.input.draftModule = this._activeModule;
		}
	}

	private async _loadAndRender(input: CustomModuleSchemaEditorInput): Promise<void> {
		if (!this._container) {
			return;
		}
		clearNode(this._container);

		if (input.draftModule) {
			this._activeModule = input.draftModule;
		} else {
			const allMods = await this.customModulesService.getCustomModules(input.workspaceUri);
			const found = allMods.find(m => m.id.toLowerCase() === input.moduleId.toLowerCase());

			if (found) {
				this._activeModule = JSON.parse(JSON.stringify(found));
			} else {
				this._activeModule = {
					id: input.moduleId,
					name: input.moduleName || input.moduleId,
					color: '#38bdf8',
					storageScope: 'global',
					description: '',
					prompt: '',
					fields: []
				};
			}
			input.draftModule = this._activeModule;
		}

		const activeMod = this._activeModule!;
		const rawFields: ICustomField[] = activeMod.fields ?? (activeMod.fields = []);

		// Enforce Title and Description as mandatory root fields at index 0 and 1
		let titleField = rawFields.find(f => f.id === 'title' || f.label?.toLowerCase() === 'title');
		if (!titleField) {
			titleField = { id: 'title', label: 'Title', type: 'text', required: true };
		} else {
			titleField.id = 'title';
			titleField.label = 'Title';
			titleField.type = 'text';
			titleField.required = true;
		}

		let descField = rawFields.find(f => (f.id === 'description' || f.label?.toLowerCase() === 'description') && f !== titleField);
		if (!descField) {
			descField = { id: 'description', label: 'Description', type: 'textarea', required: true };
		} else {
			descField.id = 'description';
			descField.label = 'Description';
			descField.type = 'textarea';
			descField.required = true;
		}

		const otherFields = rawFields.filter(f =>
			f !== titleField &&
			f !== descField &&
			f.id.toLowerCase() !== 'title' &&
			f.label?.toLowerCase() !== 'title' &&
			f.id.toLowerCase() !== 'description' &&
			f.label?.toLowerCase() !== 'description'
		);

		const fields: ICustomField[] = [titleField, descField, ...otherFields];
		activeMod.fields = fields;

		const currentStatuses: IStatusDefinition[] = (activeMod.statuses && Array.isArray(activeMod.statuses) && activeMod.statuses.length > 0)
			? JSON.parse(JSON.stringify(activeMod.statuses))
			: JSON.parse(JSON.stringify(DEFAULT_STATUS_DEFINITIONS));
		activeMod.statuses = currentStatuses;

		const compositeClasses = await this.customModulesService.getCompositeComponents(input.workspaceUri);

		const wrapper = append(this._container, $('.schema-editor-wrapper', {
			style: 'max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px;'
		}));

		activeMod.isDeprecated = !!activeMod.isDeprecated;

		// Header Bar
		const header = append(wrapper, $('.schema-editor-header', {
			style: 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 12px;'
		}));
		const titleEl = append(header, $('h2', {
			style: 'margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8; display: flex; align-items: center; gap: 10px;'
		}));
		append(titleEl, $('span.codicon.codicon-custom-modules-view-icon'));
		append(titleEl, $('span', {}, `Edit Module Schema: ${activeMod.name}`));

		// Header Right Actions (Status Pill, Toggle Status Button, Delete Button)
		const headerActions = append(header, $('.schema-editor-header-actions', {
			style: 'display: flex; align-items: center; gap: 10px;'
		}));

		const statusBadge = append(headerActions, $('span.schema-status-pill', {
			style: 'font-size: 11px; padding: 4px 10px; border-radius: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;'
		}));

		const toggleStatusBtn = append(headerActions, $('button.monaco-button.schema-header-btn', {
			style: 'padding: 5px 12px; font-size: 11.5px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: 500;'
		}));

		const deleteBtn = append(headerActions, $('button.monaco-button.schema-delete-btn', {
			style: 'padding: 5px 12px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); display: flex; align-items: center; gap: 6px; font-weight: 500;'
		}));
		append(deleteBtn, $('span.codicon.codicon-trash'));
		append(deleteBtn, $('span', {}, 'Delete Module'));

		// Top Configuration Card (Scope, Type Definition, Color, Status)
		const configCard = append(wrapper, $('.config-meta-container', {
			style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); padding: 14px 18px; border-radius: 8px;'
		}));

		// Status Row in Configuration Card
		const statusRow = append(configCard, $('.config-status-row', {
			style: 'display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 6px; background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.06);'
		}));
		const statusLeft = append(statusRow, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
		const statusTitle = append(statusLeft, $('div', { style: 'font-size: 11.5px; font-weight: 600; display: flex; align-items: center; gap: 8px;' }));
		append(statusTitle, $('span', {}, 'Module Status:'));
		const statusLabel = append(statusTitle, $('span.status-text', { style: 'font-weight: 700;' }));

		append(statusLeft, $('div', {
			style: 'font-size: 11px; opacity: 0.65;'
		}, 'When disabled, this module will not appear in the new ticket type options. Existing tickets remain preserved.'));

		// Toggle Switch in config row
		const switchWrapper = append(statusRow, $('label.schema-status-switch', {
			style: 'position: relative; display: inline-block; width: 44px; height: 22px; cursor: pointer; flex-shrink: 0;'
		}));
		const switchInput = append(switchWrapper, $('input', {
			type: 'checkbox',
			style: 'opacity: 0; width: 0; height: 0;'
		})) as HTMLInputElement;
		switchInput.checked = !activeMod.isDeprecated;
		const switchSlider = append(switchWrapper, $('span.switch-slider'));

		const updateStatusVisuals = () => {
			const isDep = !!activeMod.isDeprecated;
			if (!isDep) {
				statusBadge.className = 'schema-status-pill active-status';
				statusBadge.textContent = '● Active';
				statusBadge.style.color = '#34d399';
				statusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
				statusBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';

				toggleStatusBtn.className = 'monaco-button schema-header-btn deactivate';
				toggleStatusBtn.textContent = 'Disable Module';
				toggleStatusBtn.style.color = '#fbbf24';
				toggleStatusBtn.style.background = 'rgba(245, 158, 11, 0.12)';
				toggleStatusBtn.style.border = '1px solid rgba(245, 158, 11, 0.3)';

				statusLabel.textContent = 'Active';
				statusLabel.style.color = '#34d399';
				switchInput.checked = true;
				switchSlider.style.backgroundColor = '#10b981';
			} else {
				statusBadge.className = 'schema-status-pill deprecated';
				statusBadge.textContent = '● Disabled';
				statusBadge.style.color = '#f59e0b';
				statusBadge.style.background = 'rgba(245, 158, 11, 0.15)';
				statusBadge.style.border = '1px solid rgba(245, 158, 11, 0.3)';

				toggleStatusBtn.className = 'monaco-button schema-header-btn restore';
				toggleStatusBtn.textContent = 'Enable Module';
				toggleStatusBtn.style.color = '#34d399';
				toggleStatusBtn.style.background = 'rgba(16, 185, 129, 0.12)';
				toggleStatusBtn.style.border = '1px solid rgba(16, 185, 129, 0.3)';

				statusLabel.textContent = 'Disabled';
				statusLabel.style.color = '#f59e0b';
				switchInput.checked = false;
				switchSlider.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
			}
		};

		const handleToggleStatus = async () => {
			activeMod.isDeprecated = !activeMod.isDeprecated;
			updateStatusVisuals();
			try {
				const currentModules = await this.customModulesService.getCustomModules(input.workspaceUri);
				const existingIndex = currentModules.findIndex(m => m.id.toLowerCase() === activeMod.id.toLowerCase());
				if (existingIndex !== -1) {
					currentModules[existingIndex] = activeMod;
				} else {
					currentModules.push(activeMod);
				}
				await this.customModulesService.saveCustomModules(currentModules, input.workspaceUri);
				this.notificationService.info(`Module "${activeMod.name}" is now ${activeMod.isDeprecated ? 'Disabled' : 'Active'}`);
			} catch (e) {
				this.notificationService.error(`Failed to update module status: ${e}`);
			}
		};

		toggleStatusBtn.onclick = handleToggleStatus;
		switchInput.onchange = handleToggleStatus;
		updateStatusVisuals();

		const handleDeleteModule = async () => {
			const res = await this.dialogService.confirm({
				message: `Delete module "${activeMod.name}"?`,
				detail: `This will permanently remove the schema YAML file (${activeMod.id}.yaml). Existing tickets of this type will preserve their data.`,
				primaryButton: 'Delete'
			});
			if (res.confirmed) {
				try {
					if (this.input instanceof CustomModuleSchemaEditorInput) {
						this.input.draftModule = undefined;
					}
					await this.customModulesService.deleteCustomModule(activeMod.id, input.workspaceUri);
					this.notificationService.info(`Module "${activeMod.name}" has been deleted.`);
					this.group.closeEditor(this.input!);
				} catch (e) {
					this.notificationService.error(`Failed to delete module: ${e}`);
				}
			}
		};
		deleteBtn.onclick = handleDeleteModule;

		const configTopRow = append(configCard, $('.config-top-row', {
			style: 'display: flex; gap: 20px; align-items: center; justify-content: space-between; flex-wrap: wrap;'
		}));
		const topLeftGroup = append(configTopRow, $('.top-left-group', {
			style: 'display: flex; gap: 16px; align-items: center; flex: 1; min-width: 320px;'
		}));

		activeMod.storageScope = 'global';

		// Type Definition Input
		const defGroup = append(topLeftGroup, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
		append(defGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Type Definition:'));
		const defInput = append(defGroup, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 5px 10px; font-size: 12px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		defInput.placeholder = 'e.g. Explains purpose of this module entity...';
		defInput.value = activeMod.description || '';
		defInput.oninput = () => {
			activeMod.description = defInput.value;
		};

		// Module Color Picker
		const colorContainer = append(configTopRow, $('div', { style: 'display: flex; align-items: center; gap: 10px;' }));
		append(colorContainer, $('span', { style: 'font-size: 11px; font-weight: 600; text-transform: uppercase; color: #888888;' }, 'Module Color:'));
		const colorPalette = append(colorContainer, $('.palette-dots', { style: 'display: flex; gap: 6px;' }));
		const availableColors = ['#eab308', '#a855f7', '#3b82f6', '#0d9488', '#ec4899', '#06b6d4', '#10b981', '#ef4444'];
		let activeColor = activeMod.color || availableColors[0];
		const colorElements: HTMLElement[] = [];

		availableColors.forEach(c => {
			const dot = append(colorPalette, $('div', {
				style: `width: 18px; height: 18px; border-radius: 50%; background: ${c}; cursor: pointer; transition: all 0.15s ease; box-sizing: border-box;`
			}));
			if (c.toLowerCase() === activeColor.toLowerCase()) {
				dot.style.transform = 'scale(1.25)';
				dot.style.boxShadow = '0 0 0 2px #fff';
			}
			dot.onclick = () => {
				activeColor = c;
				activeMod.color = c;
				colorElements.forEach(el => {
					el.style.transform = 'none';
					el.style.boxShadow = 'none';
				});
				dot.style.transform = 'scale(1.25)';
				dot.style.boxShadow = '0 0 0 2px #fff';
			};
			colorElements.push(dot);
		});

		// Type Prompt Section (AI Instructions)
		const promptBox = append(configCard, $('.type-prompt-box', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 4px;' }));
		const promptHeader = append(promptBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
		append(promptHeader, $('span', { style: 'font-size: 11px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.05em;' }, 'Type Prompt (AI System Instructions for this Module):'));
		append(promptHeader, $('span', { style: 'font-size: 10.5px; opacity: 0.6;' }, 'Multi-line AI instructions when tickets of this type are processed'));

		const promptInput = append(promptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 72px; padding: 8px 12px; font-size: 12px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #141414; color: inherit; box-sizing: border-box; resize: vertical; line-height: 1.4;'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'Provide specific guidelines for AI agents handling this module entity...';
		promptInput.value = activeMod.prompt || '';
		promptInput.oninput = () => {
			activeMod.prompt = promptInput.value;
		};

		// Main 2-column Designer Layout
		const designerLayout = append(wrapper, $('.designer-layout', {
			style: 'display: flex; gap: 20px; align-items: stretch; min-height: 620px;'
		}));

		// Left Column: Component Library
		const leftLibrary = append(designerLayout, $('.component-library', {
			style: 'width: 250px; flex-shrink: 0; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px; height: fit-content;'
		}));

		append(leftLibrary, $('div', { style: 'font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #888888; letter-spacing: 0.05em;' }, 'Component Library'));
		append(leftLibrary, $('div', { style: 'font-size: 10.5px; opacity: 0.65; line-height: 1.4;' }, 'Drag & drop components anywhere to canvas on the right, or click to append.'));

		append(leftLibrary, $('div', { style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #38bdf8; margin-top: 4px;' }, 'Base Primitives'));

		const primitivesList = append(leftLibrary, $('.primitives-list', { style: 'display: flex; flex-direction: column; gap: 6px;' }));

		const baseComponents: Array<{ label: string; icon: ThemeIcon; type: CustomFieldType; defaultName: string; defaultChoices?: string[]; itemFields?: ICustomField[]; buttons?: IActionButton[] }> = [
			{ label: 'Single-line Input (Text)', icon: Codicon.symbolString, type: 'text', defaultName: 'Text Field' },
			{ label: 'Number Input (Numeric)', icon: Codicon.symbolNumber, type: 'number', defaultName: 'Amount' },
			{ label: 'Textarea (Multiline)', icon: Codicon.listFlat, type: 'textarea', defaultName: 'Description' },
			{ label: 'Dropdown (Select)', icon: Codicon.chevronDown, type: 'select', defaultName: 'Select Option', defaultChoices: ['Option 1', 'Option 2', 'Option 3'] },
			{ label: 'Checkboxes (Multiselect)', icon: Codicon.checklist, type: 'multiselect', defaultName: 'Tags', defaultChoices: ['Tag A', 'Tag B', 'Tag C'] },
			{ label: 'Switch (Toggle)', icon: Codicon.circleFilled, type: 'switch', defaultName: 'Enabled Flag' },
			{ label: 'Single Date Picker', icon: Codicon.calendar, type: 'date', defaultName: 'Due Date' },
			{ label: 'Single Time Picker', icon: Codicon.watch, type: 'time', defaultName: 'Time' },
			{ label: 'Single DateTime Picker', icon: Codicon.history, type: 'datetime', defaultName: 'Timestamp' },
			{ label: 'Date Range (Start ~ End)', icon: Codicon.calendar, type: 'date_range', defaultName: 'Date Range' },
			{ label: 'Time Range (Start ~ End)', icon: Codicon.watch, type: 'time_range', defaultName: 'Time Range' },
			{ label: 'DateTime Range (Start ~ End)', icon: Codicon.history, type: 'datetime_range', defaultName: 'Duration Range' },
			{
				label: 'Container (Nested Subfields)',
				icon: Codicon.layers,
				type: 'dynamic_list',
				defaultName: 'Container',
				itemFields: [
					{ id: `sub_${Date.now()}_1`, label: 'Item Name', type: 'text' },
					{ id: `sub_${Date.now()}_2`, label: 'Description', type: 'textarea' }
				]
			},
			{
				label: 'Attachment (Files / Images / PDF)',
				icon: Codicon.files,
				type: 'attachment',
				defaultName: 'Attachment'
			},
			{
				label: 'Action Buttons (Horizontal)',
				icon: Codicon.run,
				type: 'button_group',
				defaultName: 'Action Buttons',
				buttons: [
					{ id: `btn_${Date.now()}_1`, label: 'Approve', color: '#22c55e', targetStatus: 'Done' },
					{ id: `btn_${Date.now()}_2`, label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
				]
			},
			{
				label: 'Browser (Web Navigation & Data)',
				icon: Codicon.globe,
				type: 'browser',
				defaultName: 'Browser'
			},
			{
				label: 'Git Repository & Branch Binding',
				icon: Codicon.sourceControl,
				type: 'git',
				defaultName: 'Git Repository'
			},
			{
				label: 'Input Parameters (Runtime Variables)',
				icon: Codicon.symbolVariable,
				type: 'parameters',
				defaultName: 'Parameters'
			}
		];

		const rightCanvas = append(designerLayout, $('.designer-canvas', {
			style: 'flex: 1; min-width: 0; min-height: 580px; display: flex; flex-direction: column; gap: 12px; transition: all 0.2s ease;'
		}));

		let currentDraggingItem: {
			source: 'palette' | 'canvas';
			type?: CustomFieldType;
			isClass?: boolean;
			classId?: string;
			name?: string;
			fromIndex?: number;
		} | null = null;

		const addFieldFromDef = (bc: typeof baseComponents[0], insertIndex?: number) => {
			let count = 1;
			let candidate = `${bc.defaultName} ${count}`;
			while (
				candidate.toLowerCase() === 'title' ||
				candidate.toLowerCase() === 'description' ||
				fields.some(f => f.label.toLowerCase() === candidate.toLowerCase())
			) {
				count++;
				candidate = `${bc.defaultName} ${count}`;
			}

			const newField: ICustomField = {
				id: candidate.toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
				label: candidate,
				type: bc.type
			};
			if (bc.type === 'number') {
				newField.unit = '';
				newField.precision = 2;
			}
			if (bc.defaultChoices) {
				newField.options = [...bc.defaultChoices];
			}
			if (bc.itemFields) {
				newField.itemFields = JSON.parse(JSON.stringify(bc.itemFields));
			}
			if (bc.buttons) {
				newField.buttons = JSON.parse(JSON.stringify(bc.buttons));
			}
			if (bc.type === 'browser') {
				newField.defaultUrl = '';
				newField.credentials = [];
			}
			if (bc.type === 'git') {
				newField.gitRemoteUrl = '';
				newField.gitBranch = 'main';
			}
			if (bc.type === 'parameters') {
				newField.parameters = [
					{ id: `param_${Date.now()}_1`, name: 'start', label: 'Start Offset', defaultValue: '0', description: 'Zero-based pagination start index' }
				];
			}
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= fields.length) {
				const safeInsertIndex = Math.max(2, insertIndex);
				fields.splice(safeInsertIndex, 0, newField);
			} else {
				fields.push(newField);
			}
			renderCanvas();
		};

		const addCompositeClass = (cc: ICompositeComponent, insertIndex?: number) => {
			let count = 1;
			let candidate = `${cc.name} ${count}`;
			while (
				candidate.toLowerCase() === 'title' ||
				candidate.toLowerCase() === 'description' ||
				fields.some(f => f.label.toLowerCase() === candidate.toLowerCase())
			) {
				count++;
				candidate = `${cc.name} ${count}`;
			}

			const newField: ICustomField = {
				id: `${cc.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${Date.now()}`,
				label: candidate,
				type: 'dynamic_list',
				componentRef: cc.id,
				itemFields: JSON.parse(JSON.stringify(cc.itemFields || []))
			};
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= fields.length) {
				const safeInsertIndex = Math.max(2, insertIndex);
				fields.splice(safeInsertIndex, 0, newField);
			} else {
				fields.push(newField);
			}
			renderCanvas();
		};

		const handleItemDrop = (targetIndex?: number, position: 'before' | 'after' = 'before', e?: DragEvent) => {
			if (currentDraggingItem) {
				if (currentDraggingItem.source === 'palette') {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(2, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					if (currentDraggingItem.isClass && currentDraggingItem.classId) {
						const cc = compositeClasses.find(c => c.id === currentDraggingItem!.classId);
						if (cc) {
							addCompositeClass(cc, insertPos);
						}
					} else if (currentDraggingItem.type) {
						const bc = baseComponents.find(c => c.type === currentDraggingItem!.type);
						if (bc) {
							addFieldFromDef(bc, insertPos);
						}
					}
				} else if (currentDraggingItem.source === 'canvas') {
					const from = currentDraggingItem.fromIndex;
					if (from !== undefined && from >= 2) {
						if (targetIndex !== undefined) {
							const effectiveTarget = Math.max(2, targetIndex);
							if (from !== effectiveTarget) {
								const [moved] = fields.splice(from, 1);
								let adjustedTarget = effectiveTarget;
								if (from < effectiveTarget) {
									adjustedTarget = effectiveTarget - 1;
								}
								const finalPos = Math.max(2, position === 'after' ? adjustedTarget + 1 : adjustedTarget);
								fields.splice(finalPos, 0, moved);
								renderCanvas();
							}
						} else {
							// Dropped below all cards -> move to the end
							if (from !== fields.length - 1) {
								const [moved] = fields.splice(from, 1);
								fields.push(moved);
								renderCanvas();
							}
						}
					}
				}
				currentDraggingItem = null;
				return;
			}

			if (e?.dataTransfer) {
				const plainText = e.dataTransfer.getData('text/plain');
				if (plainText.startsWith('field:')) {
					const from = parseInt(plainText.replace('field:', ''), 10);
					if (!isNaN(from) && from >= 2 && from < fields.length) {
						if (targetIndex !== undefined) {
							const effectiveTarget = Math.max(2, targetIndex);
							if (from !== effectiveTarget) {
								const [moved] = fields.splice(from, 1);
								let adjustedTarget = effectiveTarget;
								if (from < effectiveTarget) {
									adjustedTarget = effectiveTarget - 1;
								}
								const finalPos = Math.max(2, position === 'after' ? adjustedTarget + 1 : adjustedTarget);
								fields.splice(finalPos, 0, moved);
								renderCanvas();
								return;
							}
						} else if (targetIndex === undefined && from !== fields.length - 1) {
							const [moved] = fields.splice(from, 1);
							fields.push(moved);
							renderCanvas();
							return;
						}
					}
				} else if (plainText.startsWith('composite:')) {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(2, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					const cId = plainText.replace('composite:', '');
					const cc = compositeClasses.find(c => c.id === cId);
					if (cc) {
						addCompositeClass(cc, insertPos);
						return;
					}
				} else {
					let insertPos: number | undefined = undefined;
					if (typeof targetIndex === 'number') {
						insertPos = Math.max(2, position === 'after' ? targetIndex + 1 : targetIndex);
					}
					const bc = baseComponents.find(c => c.type === plainText);
					if (bc) {
						addFieldFromDef(bc, insertPos);
						return;
					}
				}
			}
		};

		rightCanvas.ondragover = (e) => {
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy';
			}
		};
		rightCanvas.ondrop = (e) => {
			e.preventDefault();
			handleItemDrop(undefined, 'after', e);
		};

		const renderCanvas = () => {
			this._syncDraft();
			clearNode(rightCanvas);

			if (fields.length === 0) {
				const emptyCanvas = append(rightCanvas, $('.empty-canvas', {
					style: 'flex: 1; min-height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 24px; border: 2px dashed rgba(255, 255, 255, 0.12); border-radius: 8px; text-align: center; gap: 12px; background: rgba(0, 0, 0, 0.12); transition: all 0.2s ease;'
				}));
				emptyCanvas.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
					emptyCanvas.style.borderColor = '#38bdf8';
					emptyCanvas.style.background = 'rgba(56, 189, 248, 0.06)';
				};
				emptyCanvas.ondragleave = () => {
					emptyCanvas.style.borderColor = 'rgba(255, 255, 255, 0.12)';
					emptyCanvas.style.background = 'rgba(0, 0, 0, 0.12)';
				};
				emptyCanvas.ondrop = (e) => {
					e.preventDefault();
					e.stopPropagation();
					emptyCanvas.style.borderColor = 'rgba(255, 255, 255, 0.12)';
					emptyCanvas.style.background = 'rgba(0, 0, 0, 0.12)';
					handleItemDrop(undefined, 'after', e);
				};

				append(emptyCanvas, $('span' + ThemeIcon.asCSSSelector(Codicon.layout), { style: 'font-size: 36px; color: #38bdf8; opacity: 0.6;' }));
				append(emptyCanvas, $('div', { style: 'font-size: 13.5px; font-weight: 500;' }, 'Canvas is Empty'));
				append(emptyCanvas, $('div', { style: 'font-size: 11.5px; opacity: 0.65; max-width: 320px; line-height: 1.5;' }, 'Drag & drop components or reusable classes anywhere into this canvas, or click them in the library on the left.'));
				return;
			}

			// Render Field Cards
			fields.forEach((field, fIdx) => {
				const isContainer = field.type === 'dynamic_list';
				const isAttachment = field.type === 'attachment';
				const isNumber = field.type === 'number';
				const defaultBorderColor = isContainer
					? 'rgba(6, 182, 212, 0.28)'
					: (isAttachment
						? 'rgba(16, 185, 129, 0.28)'
						: (isNumber
							? 'rgba(234, 179, 8, 0.28)'
							: 'rgba(255, 255, 255, 0.12)'));
				const fieldCard = append(rightCanvas, $('.canvas-field-card', {
					style: isContainer
						? `background: rgba(6, 182, 212, 0.04); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease; position: relative;`
						: (isAttachment
							? `background: rgba(16, 185, 129, 0.04); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease; position: relative;`
							: (isNumber
								? `background: rgba(234, 179, 8, 0.03); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease; position: relative;`
								: `background: var(--vscode-editor-background, #1e1e1e); border: 1px solid ${defaultBorderColor}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25); transition: border-color 0.15s ease; position: relative;`))
				}));

				// Support dropping onto a card with precise before/after detection
				fieldCard.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy';
					}
					const rect = fieldCard.getBoundingClientRect();
					const isTop = e.clientY < rect.top + rect.height / 2;
					if (isTop) {
						fieldCard.style.boxShadow = '0 -3px 0 0 #38bdf8, 0 2px 6px rgba(0, 0, 0, 0.25)';
						fieldCard.style.borderColor = '#38bdf8';
					} else {
						fieldCard.style.boxShadow = '0 3px 0 0 #38bdf8, 0 2px 6px rgba(0, 0, 0, 0.25)';
						fieldCard.style.borderColor = '#38bdf8';
					}
				};
				fieldCard.ondragleave = () => {
					fieldCard.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
					fieldCard.style.borderColor = defaultBorderColor;
				};
				fieldCard.ondrop = (e) => {
					e.preventDefault();
					e.stopPropagation();
					fieldCard.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
					fieldCard.style.borderColor = defaultBorderColor;
					const rect = fieldCard.getBoundingClientRect();
					const isTop = e.clientY < rect.top + rect.height / 2;
					handleItemDrop(fIdx, isTop ? 'before' : 'after', e);
				};

				const isMandatory = fIdx === 0 || fIdx === 1 || field.id === 'title' || field.id === 'description';

				// Card Header
				const cardHeader = append(fieldCard, $('.card-header', {
					style: 'display: flex; justify-content: space-between; align-items: center;'
				}));
				const headerLeft = append(cardHeader, $('.header-left', {
					style: 'display: flex; align-items: center; gap: 10px;'
				}));

				if (isMandatory) {
					const lockIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.lock), {
						style: 'font-size: 13px; color: #38bdf8; opacity: 0.85; padding: 2px 4px;'
					}));
					lockIcon.title = 'Mandatory root field (fixed position)';
				} else {
					const gripper = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper), {
						style: 'font-size: 13px; opacity: 0.55; cursor: grab; user-select: none; padding: 2px 4px;'
					}));
					gripper.title = 'Drag to reorder field';
					gripper.onmouseenter = () => { fieldCard.setAttribute('draggable', 'true'); };
					gripper.onmousedown = () => { fieldCard.setAttribute('draggable', 'true'); };
					gripper.onmouseleave = () => {
						if (!currentDraggingItem) { fieldCard.setAttribute('draggable', 'false'); }
					};
				}

				fieldCard.ondragstart = (e) => {
					if (isMandatory) {
						e.preventDefault();
						return;
					}
					currentDraggingItem = { source: 'canvas', fromIndex: fIdx };
					e.dataTransfer?.setData('text/plain', `field:${fIdx}`);
					if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
					fieldCard.style.opacity = '0.4';
				};
				fieldCard.ondragend = () => {
					fieldCard.setAttribute('draggable', 'false');
					fieldCard.style.opacity = '1';
					currentDraggingItem = null;
					rightCanvas.querySelectorAll('.canvas-field-card').forEach((el) => {
						const card = el as HTMLElement;
						card.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.25)';
						card.style.borderColor = defaultBorderColor;
					});
				};

				// Mandatory Badge
				if (isMandatory) {
					append(headerLeft, $('span.type-badge', {
						style: 'font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); letter-spacing: 0.04em;'
					}, 'MANDATORY ROOT'));
				}

				// Badge
				const isBrowser = field.type === 'browser';
				const isGit = field.type === 'git';
				const isParameters = field.type === 'parameters';
				const badgeText = isContainer ? 'CONTAINER' : (isAttachment ? 'ATTACHMENT' : (isNumber ? 'NUMBER' : (isBrowser ? 'BROWSER' : (isGit ? 'GIT REPO' : (isParameters ? 'INPUT PARAMETERS' : field.type.toUpperCase())))));
				const badgeBg = isContainer ? 'rgba(6, 182, 212, 0.18)' : (isAttachment ? 'rgba(16, 185, 129, 0.18)' : (isNumber ? 'rgba(234, 179, 8, 0.18)' : (isBrowser ? 'rgba(56, 189, 248, 0.18)' : (isGit ? 'rgba(249, 115, 22, 0.18)' : (isParameters ? 'rgba(168, 85, 247, 0.18)' : 'rgba(99, 102, 241, 0.18)')))));
				const badgeColor = isContainer ? '#06b6d4' : (isAttachment ? '#10b981' : (isNumber ? '#facc15' : (isBrowser ? '#38bdf8' : (isGit ? '#f97316' : (isParameters ? '#c084fc' : '#818cf8')))));
				const badgeBorder = isContainer ? 'rgba(6, 182, 212, 0.35)' : (isAttachment ? 'rgba(16, 185, 129, 0.35)' : (isNumber ? 'rgba(234, 179, 8, 0.35)' : (isBrowser ? 'rgba(56, 189, 248, 0.35)' : (isGit ? 'rgba(249, 115, 22, 0.35)' : (isParameters ? 'rgba(168, 85, 247, 0.35)' : 'rgba(99, 102, 241, 0.35)')))));

				append(headerLeft, $('span.type-badge', {
					style: `font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; letter-spacing: 0.04em;`
				}, badgeText));

				if (field.componentRef) {
					append(headerLeft, $('span.class-badge', {
						style: 'font-size: 9.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: rgba(6, 182, 212, 0.12); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.25);'
					}, `CLASS: ${field.label}`));
				}

				const headerRight = append(cardHeader, $('.header-right', {
					style: 'display: flex; align-items: center; gap: 8px;'
				}));

				if (isMandatory) {
					append(headerRight, $('span', {
						style: 'font-size: 11px; color: rgba(255, 255, 255, 0.45); font-style: italic;'
					}, 'Required Root Field'));
				} else {
					// Move Up / Down
					const canMoveUp = fIdx > 2;
					const upBtn = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), {
						style: `cursor: pointer; font-size: 12px; opacity: ${canMoveUp ? '0.7;' : '0.2; pointer-events: none;'}`
					}));
					upBtn.title = 'Move Up';
					upBtn.onclick = () => {
						if (fIdx > 2) {
							const temp = fields[fIdx];
							fields[fIdx] = fields[fIdx - 1];
							fields[fIdx - 1] = temp;
							renderCanvas();
						}
					};

					const canMoveDown = fIdx < fields.length - 1;
					const downBtn = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), {
						style: `cursor: pointer; font-size: 12px; opacity: ${canMoveDown ? '0.7;' : '0.2; pointer-events: none;'}`
					}));
					downBtn.title = 'Move Down';
					downBtn.onclick = () => {
						if (fIdx < fields.length - 1) {
							const temp = fields[fIdx];
							fields[fIdx] = fields[fIdx + 1];
							fields[fIdx + 1] = temp;
							renderCanvas();
						}
					};

					// Delete button
					const delBtn = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
						style: 'cursor: pointer; font-size: 12px; color: #ef4444; opacity: 0.8;'
					}));
					delBtn.title = 'Remove Field';
					delBtn.onclick = () => {
						fields.splice(fIdx, 1);
						renderCanvas();
					};
				}

				// Field Label Input Row
				const labelRow = append(fieldCard, $('.field-label-row', {
					style: 'display: flex; align-items: center; gap: 10px;'
				}));
				append(labelRow, $('span', { style: 'font-size: 11.5px; opacity: 0.8; font-weight: 500; min-width: 75px;' }, 'Field Label:'));
				const labelInput = append(labelRow, $('input.monaco-inputbox', {
					style: 'flex: 1; padding: 6px 10px; font-size: 12px; font-weight: 500; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit;'
				})) as HTMLInputElement;
				labelInput.value = field.label || field.id;
				if (isMandatory) {
					labelInput.readOnly = true;
					labelInput.style.opacity = '0.7';
					labelInput.style.cursor = 'not-allowed';
					labelInput.title = 'Mandatory field name is fixed';
				} else {
					labelInput.oninput = () => {
						field.label = labelInput.value.trim() || `Field_${fIdx + 1}`;
					};
				}

				// Number Input Settings (Unit & Precision)
				if (isNumber) {
					if (field.precision === undefined) {
						field.precision = 2;
					}
					const numConfigBox = append(fieldCard, $('.number-config-box', {
						style: 'display: flex; flex-direction: column; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 10px 12px; border-radius: 6px; border: 1px solid rgba(234, 179, 8, 0.2);'
					}));

					const numTop = append(numConfigBox, $('div', {
						style: 'display: flex; align-items: center; justify-content: space-between;'
					}));
					const numTitle = append(numTop, $('div', {
						style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #facc15; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px;'
					}));
					append(numTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolNumber)));
					append(numTitle, $('span', {}, 'Numeric Settings (Unit & Precision):'));

					const previewBadge = append(numTop, $('div.number-preview-badge', {
						style: 'font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); font-variant-numeric: tabular-nums;'
					}));

					const updatePreview = () => {
						const prec = field.precision !== undefined ? field.precision : 2;
						const sampleVal = (1250.5).toLocaleString('en-US', {
							minimumFractionDigits: prec,
							maximumFractionDigits: prec
						});
						const unit = (field.unit || '').trim();
						if (unit) {
							if (/^[$€¥£₹₽₿]/.test(unit)) {
								previewBadge.textContent = `Preview: ${unit}${sampleVal}`;
							} else {
								previewBadge.textContent = `Preview: ${sampleVal} ${unit}`;
							}
						} else {
							previewBadge.textContent = `Preview: ${sampleVal}`;
						}
					};
					updatePreview();

					const inputsRow = append(numConfigBox, $('div', {
						style: 'display: flex; align-items: center; gap: 14px; flex-wrap: wrap;'
					}));

					// Unit / Suffix input
					const unitWrap = append(inputsRow, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
					append(unitWrap, $('label', { style: 'font-size: 11px; opacity: 0.75;' }, 'Unit / Suffix:'));
					const unitInput = append(unitWrap, $('input.monaco-inputbox', {
						placeholder: 'e.g. $, kg, %, USD',
						style: 'width: 130px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit;'
					})) as HTMLInputElement;
					unitInput.value = field.unit || '';
					unitInput.oninput = () => {
						field.unit = unitInput.value;
						updatePreview();
					};

					// Decimal Precision select
					const precWrap = append(inputsRow, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
					append(precWrap, $('label', { style: 'font-size: 11px; opacity: 0.75;' }, 'Decimals:'));
					const precSelect = append(precWrap, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; cursor: pointer;'
					})) as HTMLSelectElement;

					const precOptions = [
						{ val: 0, text: '0 (Integer, e.g. 1,251)' },
						{ val: 1, text: '1 Decimal (e.g. 1,250.5)' },
						{ val: 2, text: '2 Decimals (e.g. 1,250.50) [Default]' },
						{ val: 3, text: '3 Decimals (e.g. 1,250.500)' },
						{ val: 4, text: '4 Decimals (e.g. 1,250.5000)' }
					];
					precOptions.forEach(opt => {
						const o = append(precSelect, $('option', { value: String(opt.val) }, opt.text)) as HTMLOptionElement;
						if (opt.val === (field.precision !== undefined ? field.precision : 2)) {
							o.selected = true;
						}
					});
					precSelect.onchange = () => {
						field.precision = parseInt(precSelect.value, 10);
						updatePreview();
					};
				}

				// Select / Multiselect Options Management
				if (field.type === 'select' || field.type === 'multiselect') {
					const optContainer = append(fieldCard, $('.options-manager', {
						style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(0, 0, 0, 0.2); padding: 10px; border-radius: 6px;'
					}));
					append(optContainer, $('div', { style: 'font-size: 10.5px; font-weight: 600; opacity: 0.7; text-transform: uppercase;' }, 'CHOICES / OPTIONS:'));

					if (!field.options) {
						field.options = ['Option 1', 'Option 2'];
					}

					const chipsBox = append(optContainer, $('.chips-box', {
						style: 'display: flex; flex-wrap: wrap; gap: 6px; align-items: center;'
					}));

					const renderChips = () => {
						clearNode(chipsBox);
						field.options!.forEach((opt, oIdx) => {
							const chip = append(chipsBox, $('.option-chip', {
								style: 'background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 12px; padding: 3px 10px; font-size: 11px; display: flex; align-items: center; gap: 6px;'
							}));
							append(chip, $('span', {}, opt));
							const removeX = append(chip, $('span', { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }, '✕'));
							removeX.onclick = () => {
								field.options!.splice(oIdx, 1);
								renderChips();
							};
						});

						// Add option inline
						const addInput = append(chipsBox, $('input.monaco-inputbox', {
							placeholder: '+ Add Option',
							style: 'width: 100px; padding: 3px 8px; font-size: 11px; border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.2); background: transparent; color: inherit;'
						})) as HTMLInputElement;
						addInput.onkeydown = (e) => {
							if (e.key === 'Enter' && addInput.value.trim()) {
								field.options!.push(addInput.value.trim());
								addInput.value = '';
								renderChips();
							}
						};
					};
					renderChips();
				}

				// Attachment Upload Preview Box
				if (isAttachment) {
					const attachPreview = append(fieldCard, $('.attachment-schema-preview', {
						style: 'display: flex; flex-direction: column; gap: 8px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1.5px dashed rgba(16, 185, 129, 0.3);'
					}));
					const previewTop = append(attachPreview, $('div', { style: 'display: flex; align-items: center; justify-content: space-between;' }));
					const previewLeft = append(previewTop, $('div', { style: 'display: flex; align-items: center; gap: 8px; color: #10b981; font-size: 11px; font-weight: 600; text-transform: uppercase;' }));
					append(previewLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.files)));
					append(previewLeft, $('span', {}, 'Attachment Upload Zone (Single / Multi Files)'));
					append(previewTop, $('span', { style: 'font-size: 10px; opacity: 0.6;' }, 'PNG, JPG, PDF, Documents'));

					const mockDrop = append(attachPreview, $('div', {
						style: 'display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; background: rgba(16, 185, 129, 0.04); border-radius: 4px; font-size: 11px; opacity: 0.8;'
					}));
					append(mockDrop, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 15px; color: #10b981;' }));
					append(mockDrop, $('span', {}, 'Allows users to upload one or multiple files/images/PDFs when creating or editing entities'));
				}

				// Dynamic Container (List) Sub-fields Canvas
				if (isContainer) {
					const subCanvas = append(fieldCard, $('.subfields-canvas', {
						style: 'padding: 12px 14px; background: rgba(0, 0, 0, 0.25); border: 1.5px dashed rgba(6, 182, 212, 0.3); border-radius: 6px; display: flex; flex-direction: column; gap: 8px;'
					}));

					const renderSubFieldsList = () => {
						clearNode(subCanvas);
						const subHeader = append(subCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;'
						}));
						append(subHeader, $('div', {
							style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #06b6d4; letter-spacing: 0.05em;'
						}, 'Composite Item Template (Sub-Fields):'));

						if (!field.itemFields) {
							field.itemFields = [];
						}

						if (field.itemFields.length === 0) {
							append(subCanvas, $('div', {
								style: 'font-size: 11px; opacity: 0.5; font-style: italic; padding: 6px 0;'
							}, 'No sub-fields defined. Click "+ Add Sub-Field" below to configure template items.'));
						}

						field.itemFields.forEach((subF, sIdx) => {
							const subCard = append(subCanvas, $('.subfield-card', {
								style: 'padding: 8px 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; display: flex; flex-direction: column; gap: 6px;'
							}));

							const subTop = append(subCard, $('.sub-top', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
							append(subTop, $('span', {
								style: 'font-size: 9.5px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8;'
							}, subF.type.replace(/_/g, ' ')));

							const subActs = append(subTop, $('.sub-actions', { style: 'display: flex; gap: 6px; align-items: center;' }));
							if (sIdx > 0) {
								const uB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
								uB.title = 'Move Sub-Field Up';
								uB.onclick = () => {
									const [sf] = field.itemFields!.splice(sIdx, 1);
									field.itemFields!.splice(sIdx - 1, 0, sf);
									renderSubFieldsList();
								};
							}
							if (sIdx < field.itemFields!.length - 1) {
								const dB = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px;' }));
								dB.title = 'Move Sub-Field Down';
								dB.onclick = () => {
									const [sf] = field.itemFields!.splice(sIdx, 1);
									field.itemFields!.splice(sIdx + 1, 0, sf);
									renderSubFieldsList();
								};
							}
							const dBtn = append(subActs, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.6; font-size: 11px; color: #ef4444;' }));
							dBtn.title = 'Delete Sub-Field';
							dBtn.onclick = () => {
								field.itemFields?.splice(sIdx, 1);
								renderSubFieldsList();
							};

							const subInpRow = append(subCard, $('div', { style: 'display: flex; gap: 8px; align-items: center;' }));
							append(subInpRow, $('label', { style: 'font-size: 10.5px; opacity: 0.8; min-width: 65px;' }, 'Sub-Label:'));
							const subInp = append(subInpRow, $('input.monaco-inputbox', {
								style: 'flex: 1; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLInputElement;
							subInp.value = subF.label;
							subInp.oninput = () => {
								subF.label = subInp.value;
							};

							const subTypeSelect = append(subInpRow, $('select.monaco-select', {
								style: 'padding: 4px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
							})) as HTMLSelectElement;
							const availableSubTypes: Array<{ type: CustomFieldType; label: string }> = [
								{ type: 'text', label: 'Text' },
								{ type: 'number', label: 'Number' },
								{ type: 'textarea', label: 'Textarea' },
								{ type: 'select', label: 'Select' },
								{ type: 'multiselect', label: 'Multiselect' },
								{ type: 'switch', label: 'Switch' },
								{ type: 'date', label: 'Date' },
								{ type: 'time', label: 'Time' },
								{ type: 'datetime', label: 'DateTime' },
								{ type: 'date_range', label: 'Date Range' },
								{ type: 'time_range', label: 'Time Range' },
								{ type: 'datetime_range', label: 'DateTime Range' },
								{ type: 'attachment', label: 'Attachment' }
							];
							availableSubTypes.forEach(st => {
								append(subTypeSelect, $('option', { value: st.type }, st.label));
							});
							subTypeSelect.value = subF.type;
							subTypeSelect.onchange = () => {
								subF.type = subTypeSelect.value as CustomFieldType;
								if ((subF.type === 'select' || subF.type === 'multiselect') && !subF.options) {
									subF.options = ['Option 1', 'Option 2'];
								}
								renderSubFieldsList();
							};
						});

						// Add Sub-Field & Save as Class Action Row
						const addSubRow = append(subCanvas, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.06);' }));
						const addSubBtn = append(addSubRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(6, 182, 212, 0.12); border: 1px solid rgba(6, 182, 212, 0.3); color: #06b6d4; font-weight: 500;'
						}));
						addSubBtn.innerText = '+ Add Sub-Field';
						addSubBtn.onclick = () => {
							field.itemFields?.push({
								id: `sub_${Date.now()}_${field.itemFields.length + 1}`,
								label: `New Sub-Field`,
								type: 'text'
							});
							renderSubFieldsList();
						};

						const saveClassBtn = append(addSubRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: #e0e0e0;'
						}));
						saveClassBtn.innerText = 'Save as Class Asset';
						saveClassBtn.onclick = async () => {
							const className = field.label || 'My Composite Class';
							const newClass: ICompositeComponent = {
								id: `comp_${Date.now()}`,
								name: className,
								itemFields: JSON.parse(JSON.stringify(field.itemFields || [])),
								storageScope: activeMod.storageScope
							};
							await this.customModulesService.saveCompositeComponent(newClass, input.workspaceUri);
							this.notificationService.info(`Saved composite class "${className}" to Component Library!`);
							await this._loadAndRender(input);
						};
					};
					renderSubFieldsList();
				}

				const isButtonGroup = field.type === 'button_group' || field.type === 'button';
				if (isButtonGroup) {
					if (!field.buttons || !Array.isArray(field.buttons) || field.buttons.length === 0) {
						field.buttons = [
							{ id: `btn_${Date.now()}_1`, label: 'Approve', color: '#22c55e', targetStatus: 'Done' },
							{ id: `btn_${Date.now()}_2`, label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
						];
					}

					const btnGroupCanvas = append(fieldCard, $('.buttongroup-schema-canvas', {
						style: 'padding: 12px 14px; background: rgba(0, 0, 0, 0.25); border: 1.5px dashed rgba(56, 189, 248, 0.35); border-radius: 6px; display: flex; flex-direction: column; gap: 10px;'
					}));

					const renderButtonItems = () => {
						clearNode(btnGroupCanvas);
						const bgHeader = append(btnGroupCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;'
						}));
						const bgTitle = append(bgHeader, $('div', {
							style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #38bdf8; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px;'
						}));
						append(bgTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.run)));
						append(bgTitle, $('span', {}, 'Action Buttons & Status Transitions (Horizontal):'));

						append(bgHeader, $('span', {
							style: 'font-size: 10px; opacity: 0.65;'
						}, `${field.buttons!.length} button${field.buttons!.length === 1 ? '' : 's'}`));

						// Horizontal Button Preview & Configuration Grid
						const buttonsContainer = append(btnGroupCanvas, $('.buttons-config-container', {
							style: 'display: flex; flex-direction: column; gap: 8px;'
						}));

						let draggingButtonIndex: number | null = null;

						field.buttons!.forEach((btn, bIdx) => {
							const btnCard = append(buttonsContainer, $('.button-config-card', {
								style: 'padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;'
							}));

							// Drag Grip Handle (6-dots gripper)
							const dragHandle = append(btnCard, $('.button-row-drag-handle'));
							dragHandle.title = 'Drag to reorder button';
							append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
							dragHandle.onmouseenter = () => { btnCard.setAttribute('draggable', 'true'); };
							dragHandle.onmousedown = () => { btnCard.setAttribute('draggable', 'true'); };
							dragHandle.onmouseleave = () => {
								if (draggingButtonIndex === null) {
									btnCard.setAttribute('draggable', 'false');
								}
							};

							btnCard.ondragstart = (e) => {
								draggingButtonIndex = bIdx;
								e.dataTransfer?.setData('text/plain', `button:${bIdx}`);
								if (e.dataTransfer) {
									e.dataTransfer.effectAllowed = 'move';
								}
								btnCard.style.opacity = '0.35';
								btnCard.style.background = 'rgba(255, 255, 255, 0.08)';
							};

							btnCard.ondragend = () => {
								btnCard.setAttribute('draggable', 'false');
								btnCard.style.opacity = '1';
								btnCard.style.background = 'rgba(255, 255, 255, 0.03)';
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								draggingButtonIndex = null;
								buttonsContainer.querySelectorAll('.button-config-card').forEach(el => {
									const c = el as HTMLElement;
									c.style.boxShadow = 'none';
									c.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								});
							};

							btnCard.ondragover = (e) => {
								e.preventDefault();
								if (e.dataTransfer) {
									e.dataTransfer.dropEffect = 'move';
								}
								const rect = btnCard.getBoundingClientRect();
								const isTop = e.clientY < rect.top + rect.height / 2;
								if (isTop) {
									btnCard.style.boxShadow = '0 -2px 0 0 #38bdf8';
									btnCard.style.borderColor = '#38bdf8';
								} else {
									btnCard.style.boxShadow = '0 2px 0 0 #38bdf8';
									btnCard.style.borderColor = '#38bdf8';
								}
							};

							btnCard.ondragleave = () => {
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
							};

							btnCard.ondrop = (e) => {
								e.preventDefault();
								e.stopPropagation();
								btnCard.style.boxShadow = 'none';
								btnCard.style.borderColor = 'rgba(255, 255, 255, 0.08)';
								if (draggingButtonIndex === null || draggingButtonIndex === bIdx) {
									return;
								}
								const rect = btnCard.getBoundingClientRect();
								const isTop = e.clientY < rect.top + rect.height / 2;
								let targetIdx = isTop ? bIdx : bIdx + 1;
								const [movedItem] = field.buttons!.splice(draggingButtonIndex, 1);
								if (draggingButtonIndex < targetIdx) {
									targetIdx--;
								}
								field.buttons!.splice(targetIdx, 0, movedItem);
								draggingButtonIndex = null;
								renderButtonItems();
							};

							// Left: Label Input
							const btnLeft = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 180px;' }));
							append(btnLeft, $('label', { style: 'font-size: 10.5px; opacity: 0.7; min-width: 36px;' }, 'Label:'));
							const labelInp = append(btnLeft, $('input.monaco-inputbox', {
								style: 'width: 110px; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLInputElement;
							labelInp.value = btn.label;
							labelInp.oninput = () => {
								btn.label = labelInp.value;
							};

							// Color Palette Dots
							const colorContainer = append(btnLeft, $('div', { style: 'display: flex; align-items: center; gap: 4px;' }));
							const presetColors = ['#22c55e', '#ef4444', '#38bdf8', '#f59e0b', '#a855f7', '#64748b'];
							presetColors.forEach(c => {
								const dot = append(colorContainer, $('div', {
									style: `width: 14px; height: 14px; border-radius: 50%; background: ${c}; cursor: pointer; border: 2px solid ${btn.color === c ? '#ffffff' : 'transparent'}; box-sizing: border-box; transition: transform 0.1s ease;`
								}));
								dot.title = `Color: ${c}`;
								dot.onclick = () => {
									btn.color = c;
									renderButtonItems();
								};
							});

							// Target Status Transition Dropdown
							const statusWrap = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							append(statusWrap, $('label', { style: 'font-size: 10.5px; opacity: 0.7;' }, 'Transitions to:'));
							const statusSel = append(statusWrap, $('select.monaco-select', {
								style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
							})) as HTMLSelectElement;

							append(statusSel, $('option', { value: '' }, 'None (No Status Change)'));
							currentStatuses.forEach(st => {
								const opt = append(statusSel, $('option', { value: st.label }, `→ ${st.label} (${st.category})`)) as HTMLOptionElement;
								if (btn.targetStatus === st.label) {
									opt.selected = true;
								}
							});
							statusSel.value = btn.targetStatus || '';
							statusSel.onchange = () => {
								btn.targetStatus = statusSel.value;
							};

							// Right Actions: Remove Button (left/right arrows removed per user request)
							const btnActs = append(btnCard, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
							const delB = append(btnActs, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px; color: #ef4444;' }));
							delB.title = 'Remove Button';
							delB.onclick = () => {
								field.buttons!.splice(bIdx, 1);
								renderButtonItems();
							};
						});

						// Footer: Add button row
						const addBtnRow = append(btnGroupCanvas, $('div', {
							style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 4px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
						}));
						const addBtn = append(addBtnRow, $('button.monaco-button', {
							style: 'padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-weight: 500;'
						}));
						addBtn.innerText = '+ Add Button';
						addBtn.onclick = () => {
							field.buttons!.push({
								id: `btn_${Date.now()}_${field.buttons!.length + 1}`,
								label: `Action ${field.buttons!.length + 1}`,
								color: '#38bdf8',
								targetStatus: ''
							});
							renderButtonItems();
						};
					};
					renderButtonItems();
				}

				// Browser Primitive Configuration Box
				if (field.type === 'browser') {
					const browserBox = append(fieldCard, $('.browser-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.25);'
					}));

					// Default URL Row
					const urlRow = append(browserBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					const urlTop = append(urlRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					append(urlTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: #38bdf8;' }, 'Default Target URL / Site (Optional):'));
					append(urlTop, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Preloaded in ticket browser and silent automation'));
					const urlInput = append(urlRow, $('input.monaco-inputbox.browser-url-input', {
						placeholder: 'e.g. https://www.linkedin.com/jobs/ or https://github.com',
						style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
					})) as HTMLInputElement;
					urlInput.value = field.defaultUrl || '';
					urlInput.oninput = () => {
						field.defaultUrl = urlInput.value.trim();
					};

					// URL Action & Test Buttons Row
					const actionsRow = append(urlRow, $('div', { style: 'display: flex; gap: 8px; margin-top: 6px; align-items: center;' }));

					const silentBtn = append(actionsRow, $('button.monaco-button.browser-silent-fetch-btn', {
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(silentBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudDownload)));
					append(silentBtn, $('span', {}, 'Fetch (Silent)'));
					silentBtn.title = 'Test Fetch: Fetch webpage in background and extract text/HTML into preview below';

					const openTabBtn = append(actionsRow, $('button.monaco-button.browser-open-tab-btn', {
						style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(167, 139, 250, 0.15); color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(openTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.linkExternal)));
					append(openTabBtn, $('span', {}, 'Open in Tab'));
					openTabBtn.title = 'Test in Browser: Open URL in a new VS Code browser tab beside and extract content into preview below';

					const newTabBtn = append(actionsRow, $('button.monaco-button.browser-new-tab-btn', {
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.35); transition: all 0.15s ease;'
					})) as HTMLButtonElement;
					append(newTabBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
					append(newTabBtn, $('span', {}, 'New Tab'));
					newTabBtn.title = 'Open a new independent browser tab to freely navigate, sign in, or test cookies';
					newTabBtn.onclick = async () => {
						this._syncDraft();
						const targetUrl = urlInput.value.trim() || 'https://www.google.com';
						try {
							const uri = URI.parse(targetUrl);
							await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
								viewColumn: -2, // ViewColumn.Beside
								preserveFocus: false
							});
						} catch {
							await this._commandService.executeCommand('simpleBrowser.show');
						}
					};

					// Credentials Section
					const credsBox = append(browserBox, $('.browser-creds-container', {
						style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
					}));

					const credsTop = append(credsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					append(credsTop, $('div', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: #a78bfa;' }, 'Authentication Credentials (Key-Value Pairs):'));
					append(credsTop, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Available for AI & automated login'));

					if (!field.credentials) {
						field.credentials = [];
					}

					const credsListContainer = append(credsBox, $('.creds-list', { style: 'display: flex; flex-direction: column; gap: 6px;' }));

					const renderCredRows = () => {
						clearNode(credsListContainer);
						if (!field.credentials || field.credentials.length === 0) {
							append(credsListContainer, $('div', {
								style: 'font-size: 11px; opacity: 0.5; font-style: italic; padding: 4px 0;'
							}, 'No credentials configured. Click "+ Add Credential Row" below to define login parameters.'));
						} else {
							field.credentials.forEach((c, cIdx) => {
								const row = append(credsListContainer, $('.cred-row', {
									style: 'display: flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 5px; padding: 6px 8px;'
								}));

								append(row, $('span', {
									style: 'font-size: 10px; font-weight: 700; color: #a78bfa; padding: 2px 6px; background: rgba(167, 139, 250, 0.12); border-radius: 3px; min-width: 24px; text-align: center;'
								}, `#${cIdx + 1}`));

								// Key Input
								const keyInp = append(row, $('input.monaco-inputbox', {
									placeholder: 'Key (e.g. username, password, token)',
									style: 'width: 140px; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
								})) as HTMLInputElement;
								keyInp.value = c.key;
								keyInp.oninput = () => { c.key = keyInp.value; };

								// Colon separator
								append(row, $('span', { style: 'opacity: 0.5; font-size: 12px;' }, ':'));

								// Value Input
								const valInp = append(row, $('input.monaco-inputbox', {
									placeholder: 'Value / Credential secret',
									type: 'text',
									style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
								})) as HTMLInputElement;
								valInp.value = c.value;
								valInp.oninput = () => { c.value = valInp.value; };

								// Delete row button
								const delBtn = append(row, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
									style: 'cursor: pointer; opacity: 0.7; font-size: 11.5px; color: #ef4444; padding: 4px;'
								}));
								delBtn.title = 'Remove Credential Row';
								delBtn.onclick = () => {
									field.credentials!.splice(cIdx, 1);
									renderCredRows();
								};
							});
						}
					};

					renderCredRows();

					// Add Row button
					const addRowBtn = append(credsBox, $('button.monaco-button', {
						style: 'align-self: flex-start; padding: 4px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(167, 139, 250, 0.12); border: 1px solid rgba(167, 139, 250, 0.3); color: #a78bfa; font-weight: 500;'
					}));
					addRowBtn.innerText = '+ Add Credential Row';
					addRowBtn.onclick = () => {
						if (!field.credentials) field.credentials = [];
						field.credentials.push({
							id: `cred_${Date.now()}_${field.credentials.length + 1}`,
							key: '',
							value: ''
						});
						renderCredRows();
					};

					// Extracted Web Content Area (AI-Ready Preview)
					const contentArea = append(browserBox, $('.browser-content-container', {
						style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.06);'
					}));

					const contentHeader = append(contentArea, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center;'
					}));
					const contentHeaderLeft = append(contentHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 8px;'
					}));
					append(contentHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.85; text-transform: uppercase; color: #94a3b8;'
					}, 'Extracted Web Content (AI-Ready Preview):'));

					const statusBadge = append(contentHeaderLeft, $('span.browser-fetch-status', {
						style: 'font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); opacity: 0.75;'
					}, field.defaultContent ? 'Preloaded default content' : 'Not tested yet'));

					const contentHeaderRight = append(contentHeader, $('div', {
						style: 'display: flex; gap: 6px;'
					}));

					const copyBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit;'
					}));
					copyBtn.innerText = 'Copy Text';

					const clearBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit;'
					}));
					clearBtn.innerText = 'Clear';

					const contentDisplay = append(contentArea, $('.browser-content-display', {
						style: 'min-height: 110px; max-height: 240px; overflow-y: auto; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #e2e8f0;'
					}));

					const resetPlaceholder = () => {
						clearNode(contentDisplay);
						append(contentDisplay, $('span', { style: 'opacity: 0.4; font-style: italic;' }, 'No webpage content extracted yet. Enter a URL above and click "Fetch (Silent)" or "Open in Tab" to test webpage extraction.'));
					};

					if (field.defaultContent) {
						contentDisplay.textContent = field.defaultContent;
					} else {
						resetPlaceholder();
					}

					copyBtn.onclick = () => {
						const text = contentDisplay.textContent || '';
						if (text && !text.startsWith('No webpage content')) {
							this._clipboardService.writeText(text);
							this.notificationService.info('Web content copied to clipboard.');
						}
					};

					clearBtn.onclick = () => {
						resetPlaceholder();
						statusBadge.textContent = 'Cleared';
						statusBadge.style.color = '';
						field.defaultContent = '';
					};

					const executeFetch = async (openTab: boolean) => {
						await this._executeBrowserFetch(urlInput, statusBadge, contentDisplay, field, openTab, fields);
					};

					silentBtn.onclick = () => executeFetch(false);
					openTabBtn.onclick = () => executeFetch(true);

					urlInput.onkeydown = (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							executeFetch(false);
						}
					};
				}

				// Git Primitive Configuration Box
				if (field.type === 'git') {
					const gitSchemaBox = append(fieldCard, $('.git-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 10px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(249, 115, 22, 0.25);'
					}));

					const gitNote = append(gitSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.8; line-height: 1.4; color: #fb923c;' }));
					append(gitNote, $('span' + ThemeIcon.asCSSSelector(Codicon.sourceControl), { style: 'margin-right: 6px;' }));
					append(gitNote, $('span', {}, 'When included in schema, tickets of this type will enable Git repository and branch binding.'));

					// Default Remote URL
					const remoteRow = append(gitSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					append(remoteRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Default Git Remote URL (Optional):'));
					const remoteInput = append(remoteRow, $('input.monaco-inputbox', {
						placeholder: 'e.g. git@github.com:org/repo.git or https://github.com/org/repo.git',
						style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box;'
					})) as HTMLInputElement;
					remoteInput.value = field.gitRemoteUrl || '';
					remoteInput.oninput = () => {
						field.gitRemoteUrl = remoteInput.value.trim();
					};

					// Default Target Branch
					const branchRow = append(gitSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					append(branchRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Default Target Branch (Optional):'));
					const branchInput = append(branchRow, $('input.monaco-inputbox', {
						placeholder: 'e.g. main, master, feature/base',
						style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box;'
					})) as HTMLInputElement;
					branchInput.value = field.gitBranch || '';
					branchInput.oninput = () => {
						field.gitBranch = branchInput.value.trim();
					};
				}

				// Parameters Primitive Configuration Box
				if (field.type === 'parameters') {
					if (!field.parameters) {
						field.parameters = [];
					}
					const paramSchemaBox = append(fieldCard, $('.parameters-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(168, 85, 247, 0.25);'
					}));

					const paramNotice = append(paramSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.85; line-height: 1.4; color: #c084fc; display: flex; align-items: center; gap: 6px;' }));
					append(paramNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolVariable)));
					append(paramNotice, $('span', {}, 'Define runtime input parameters for tickets. Reference these parameters in URLs and prompts using {{param_name}}.'));

					// Parameters List Container
					const paramListContainer = append(paramSchemaBox, $('.params-list', { style: 'display: flex; flex-direction: column; gap: 8px;' }));

					const renderParamList = () => {
						clearNode(paramListContainer);

						if (!field.parameters || field.parameters.length === 0) {
							append(paramListContainer, $('div', {
								style: 'font-size: 11px; font-style: italic; opacity: 0.5; padding: 6px 0;'
							}, 'No parameters defined yet. Click "+ Add Parameter" below.'));
							return;
						}

						field.parameters.forEach((param, pIdx) => {
							const row = append(paramListContainer, $('.param-row-card', {
								style: 'display: flex; flex-direction: column; gap: 6px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 10px;'
							}));

							// Top line: Name, copy tag, and delete
							const topLine = append(row, $('.param-row-top', { style: 'display: flex; align-items: center; gap: 8px;' }));

							const nameInput = append(topLine, $('input.monaco-inputbox', {
								placeholder: 'Variable Name (e.g. start, env)',
								style: 'flex: 1; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; font-family: var(--vscode-editor-font-family, monospace);'
							})) as HTMLInputElement;
							nameInput.value = param.name || '';

							const copyTag = append(topLine, $('span.param-copy-tag', {
								title: 'Click to copy reference token',
								style: 'font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); font-weight: 700; color: #c084fc; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 4px; padding: 3px 7px; cursor: pointer; user-select: none; white-space: nowrap;'
							}, `{{${param.name || 'param'}}}`));
							copyTag.onclick = () => {
								const token = `{{${param.name || 'param'}}}`;
								this._clipboardService.writeText(token);
								this.notificationService.info(`Copied '${token}' to clipboard.`);
							};

							nameInput.oninput = () => {
								param.name = nameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
								nameInput.value = param.name;
								copyTag.textContent = `{{${param.name || 'param'}}}`;
							};

							const delBtn = append(topLine, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
								title: 'Delete Parameter',
								style: 'cursor: pointer; opacity: 0.6; font-size: 12px; padding: 4px;'
							}));
							delBtn.onmouseenter = () => delBtn.style.opacity = '1';
							delBtn.onmouseleave = () => delBtn.style.opacity = '0.6';
							delBtn.onclick = () => {
								field.parameters!.splice(pIdx, 1);
								renderParamList();
							};

							// Bottom line: Label, Default Value, Choices, and Description
							const bottomGrid = append(row, $('.param-row-grid', {
								style: 'display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;'
							}));

							// Label
							const labelCol = append(bottomGrid, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
							append(labelCol, $('label', { style: 'font-size: 10px; opacity: 0.7;' }, 'Display Label:'));
							const labelInput = append(labelCol, $('input.monaco-inputbox', {
								placeholder: 'e.g. Start Offset',
								style: 'width: 100%; padding: 4px 7px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; box-sizing: border-box;'
							})) as HTMLInputElement;
							labelInput.value = param.label || '';
							labelInput.oninput = () => { param.label = labelInput.value.trim(); };

							// Default Value
							const defCol = append(bottomGrid, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
							append(defCol, $('label', { style: 'font-size: 10px; opacity: 0.7;' }, 'Default Value:'));
							const defInput = append(defCol, $('input.monaco-inputbox', {
								placeholder: 'e.g. 0',
								style: 'width: 100%; padding: 4px 7px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; box-sizing: border-box;'
							})) as HTMLInputElement;
							defInput.value = param.defaultValue || '';
							defInput.oninput = () => { param.defaultValue = defInput.value; };

							// Choices / Options
							const optsCol = append(bottomGrid, $('div', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
							append(optsCol, $('label', { style: 'font-size: 10px; opacity: 0.7;' }, 'Choices (comma-separated):'));
							const optsInput = append(optsCol, $('input.monaco-inputbox', {
								placeholder: 'e.g. testing, dev, prod',
								style: 'width: 100%; padding: 4px 7px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.2); color: inherit; box-sizing: border-box;'
							})) as HTMLInputElement;
							optsInput.value = (param.options || []).join(', ');
							optsInput.oninput = () => {
								const val = optsInput.value.trim();
								param.options = val ? val.split(',').map(s => s.trim()).filter(Boolean) : undefined;
							};
						});
					};

					renderParamList();

					// Add Parameter Button
					const addParamBtn = append(paramSchemaBox, $('button', {
						style: 'align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); cursor: pointer; transition: all 0.15s ease;'
					}));
					append(addParamBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
					append(addParamBtn, $('span', {}, 'Add Parameter'));
					addParamBtn.onclick = () => {
						const count = (field.parameters?.length || 0) + 1;
						field.parameters!.push({
							id: `param_${Date.now()}_${count}`,
							name: `param_${count}`,
							label: `Parameter ${count}`,
							defaultValue: ''
						});
						renderParamList();
					};
				}
			});

			// Persistent Drop Zone at the bottom of the right canvas!
			const bottomDropZone = append(rightCanvas, $('.canvas-drop-zone', {
				style: 'flex: 1; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 2px dashed rgba(255, 255, 255, 0.12); border-radius: 8px; background: rgba(255, 255, 255, 0.015); color: rgba(255, 255, 255, 0.45); font-size: 11.5px; transition: all 0.2s ease;'
			}));
			bottomDropZone.ondragover = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) { e.dataTransfer.dropEffect = currentDraggingItem?.source === 'canvas' ? 'move' : 'copy'; }
				bottomDropZone.style.borderColor = '#38bdf8';
				bottomDropZone.style.background = 'rgba(56, 189, 248, 0.08)';
				bottomDropZone.style.color = '#38bdf8';
			};
			bottomDropZone.ondragleave = () => {
				bottomDropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
				bottomDropZone.style.background = 'rgba(255, 255, 255, 0.015)';
				bottomDropZone.style.color = 'rgba(255, 255, 255, 0.45)';
			};
			bottomDropZone.ondrop = (e) => {
				e.preventDefault();
				e.stopPropagation();
				bottomDropZone.style.borderColor = 'rgba(255, 255, 255, 0.12)';
				bottomDropZone.style.background = 'rgba(255, 255, 255, 0.015)';
				bottomDropZone.style.color = 'rgba(255, 255, 255, 0.45)';
				handleItemDrop(undefined, 'after', e);
			};

			append(bottomDropZone, $('span' + ThemeIcon.asCSSSelector(Codicon.plus), { style: 'font-size: 20px; opacity: 0.6;' }));
			append(bottomDropZone, $('span', { style: 'font-weight: 500;' }, 'Drop components here to append to schema (or click on the left)'));
		};

		// Populate Base Components in Library
		baseComponents.forEach(bc => {
			const item = append(primitivesList, $('.primitive-item', {
				style: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
			}));
			item.setAttribute('draggable', 'true');
			item.ondragstart = (e) => {
				currentDraggingItem = { source: 'palette', type: bc.type };
				e.dataTransfer?.setData('text/plain', bc.type);
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'copy';
				}
			};
			item.ondragend = () => {
				currentDraggingItem = null;
			};
			item.onmouseenter = () => {
				item.style.background = 'rgba(56, 189, 248, 0.12)';
				item.style.borderColor = 'rgba(56, 189, 248, 0.3)';
			};
			item.onmouseleave = () => {
				item.style.background = 'rgba(255, 255, 255, 0.04)';
				item.style.borderColor = 'rgba(255, 255, 255, 0.08)';
			};

			append(item, $('span' + ThemeIcon.asCSSSelector(bc.icon), { style: 'font-size: 13px; opacity: 0.75; min-width: 16px; text-align: center;' }));
			append(item, $('span', { style: 'font-size: 11.5px;' }, bc.label));

			item.onclick = () => {
				addFieldFromDef(bc);
			};
		});

		// Reusable Classes in Library
		const reusableSection = append(leftLibrary, $('.reusable-classes-section', {
			style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px;'
		}));
		append(reusableSection, $('div', {
			style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #06b6d4;'
		}, `Reusable Classes (${compositeClasses.length})`));

		if (compositeClasses.length === 0) {
			append(reusableSection, $('div', {
				style: 'font-size: 10.5px; opacity: 0.45; font-style: italic; padding: 4px 0;'
			}, 'No classes saved yet. Add a Container to canvas and click "Save as Class Asset".'));
		} else {
			const compList = append(reusableSection, $('.composite-classes-list', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
			compositeClasses.forEach(cc => {
				const ccItem = append(compList, $('.primitive-item', {
					style: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
				}));
				ccItem.setAttribute('draggable', 'true');
				ccItem.ondragstart = (e) => {
					currentDraggingItem = { source: 'palette', isClass: true, classId: cc.id, name: cc.name };
					e.dataTransfer?.setData('text/plain', `composite:${cc.id}`);
					e.dataTransfer?.setData('application/json', JSON.stringify({ isComposite: true, id: cc.id, name: cc.name }));
					if (e.dataTransfer) {
						e.dataTransfer.effectAllowed = 'copy';
					}
				};
				ccItem.ondragend = () => {
					currentDraggingItem = null;
				};
				ccItem.onmouseenter = () => {
					ccItem.style.background = 'rgba(6, 182, 212, 0.12)';
					ccItem.style.borderColor = 'rgba(6, 182, 212, 0.35)';
				};
				ccItem.onmouseleave = () => {
					ccItem.style.background = 'rgba(255, 255, 255, 0.04)';
					ccItem.style.borderColor = 'rgba(255, 255, 255, 0.08)';
				};

				append(ccItem, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolClass), { style: 'color: #06b6d4; font-size: 12px; min-width: 16px; text-align: center;' }));
				append(ccItem, $('span', { style: 'font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, cc.name));

				ccItem.onclick = () => {
					addCompositeClass(cc);
				};
			});
		}

		// 3. Status Lifecycle Definitions Section in Left Library
		const statusSection = append(leftLibrary, $('.status-lifecycle-section', {
			style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px;'
		}));
		const statusHeader = append(statusSection, $('div', {
			style: 'display: flex; justify-content: space-between; align-items: center;'
		}));
		append(statusHeader, $('div', {
			style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #a78bfa; display: flex; align-items: center; gap: 6px;'
		}, 'Status Lifecycle'));
		const statusCountBadge = append(statusHeader, $('span', {
			style: 'font-size: 10px; opacity: 0.75; background: rgba(167, 139, 250, 0.15); color: #a78bfa; padding: 1px 6px; border-radius: 4px; font-weight: 600;'
		}, `${currentStatuses.length} stages`));

		append(statusSection, $('div', {
			style: 'font-size: 10.5px; opacity: 0.65; line-height: 1.4;'
		}, 'Define workflow stages for this ticket type. Action buttons can transition tickets between these statuses.'));

		// Status Pills Preview Container
		const statusPillsBox = append(statusSection, $('div', {
			style: 'display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0;'
		}));
		const renderStatusPills = () => {
			clearNode(statusPillsBox);
			statusCountBadge.textContent = `${currentStatuses.length} stages`;
			currentStatuses.forEach(st => {
				const pill = append(statusPillsBox, $('div', {
					style: `font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: ${st.color || '#cccccc'}; display: inline-flex; align-items: center; gap: 5px;`
				}));
				append(pill, $('span', { style: `width: 6px; height: 6px; border-radius: 50%; background: ${st.color || '#cccccc'};` }));
				append(pill, $('span', {}, st.label));
			});
		};
		renderStatusPills();

		const configStatusBtn = append(statusSection, $('button.monaco-button', {
			style: 'padding: 6px 12px; font-size: 11px; border-radius: 6px; cursor: pointer; background: rgba(167, 139, 250, 0.15); border: 1px solid rgba(167, 139, 250, 0.35); color: #c4b5fd; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s ease;'
		}));
		append(configStatusBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.settingsGear)));
		append(configStatusBtn, $('span', {}, 'Configure Status Lifecycle'));

		const openStatusLifecycleModal = () => {
			const overlay = append(this._container!, $('.status-lifecycle-modal-overlay'));
			const modal = append(overlay, $('.status-lifecycle-modal-card', {
				style: 'padding: 20px; display: flex; flex-direction: column; gap: 14px;'
			}));

			// Modal Header
			const mHeader = append(modal, $('div', {
				style: 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 10px;'
			}));
			const mTitleWrap = append(mHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
			append(mTitleWrap, $('span' + ThemeIcon.asCSSSelector(Codicon.pulse), { style: 'color: #a78bfa; font-size: 16px;' }));
			append(mTitleWrap, $('span', { style: 'font-size: 15px; font-weight: 600; color: #ffffff;' }, 'Status Lifecycle & Workflow Stages'));

			const closeBtn = append(mHeader, $('button', {
				style: 'background: transparent; border: none; font-size: 16px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; border-radius: 4px;'
			}, '✕'));
			closeBtn.onclick = () => {
				overlay.remove();
			};

			append(modal, $('div', {
				style: 'font-size: 11.5px; opacity: 0.75; line-height: 1.5;'
			}, 'Define operational statuses for this ticket type. Action buttons on tickets can transition them between these statuses. Each status maps to a standard category bucket for search and reporting.'));

			// Scrollable list of statuses
			const listContainer = append(modal, $('.status-rows-container', {
				style: 'flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; max-height: 380px; padding-right: 4px;'
			}));

			let draggingStatusIndex: number | null = null;

			const renderModalRows = () => {
				clearNode(listContainer);
				currentStatuses.forEach((st, sIdx) => {
					const row = append(listContainer, $('.status-modal-row', {
						style: 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;'
					}));

					// Drag Grip Handle (dots icon)
					const dragHandle = append(row, $('.status-row-drag-handle'));
					dragHandle.title = 'Drag to reorder';
					append(dragHandle, $('span' + ThemeIcon.asCSSSelector(Codicon.gripper)));
					dragHandle.onmouseenter = () => { row.setAttribute('draggable', 'true'); };
					dragHandle.onmousedown = () => { row.setAttribute('draggable', 'true'); };
					dragHandle.onmouseleave = () => {
						if (draggingStatusIndex === null) {
							row.setAttribute('draggable', 'false');
						}
					};

					row.ondragstart = (e) => {
						draggingStatusIndex = sIdx;
						e.dataTransfer?.setData('text/plain', `status:${sIdx}`);
						if (e.dataTransfer) {
							e.dataTransfer.effectAllowed = 'move';
						}
						row.style.opacity = '0.35';
						row.style.background = 'rgba(255, 255, 255, 0.08)';
					};

					row.ondragend = () => {
						row.setAttribute('draggable', 'false');
						row.style.opacity = '1';
						row.style.background = 'rgba(255, 255, 255, 0.03)';
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						draggingStatusIndex = null;
						listContainer.querySelectorAll('.status-modal-row').forEach(el => {
							const r = el as HTMLElement;
							r.style.boxShadow = 'none';
							r.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						});
					};

					row.ondragover = (e) => {
						e.preventDefault();
						if (e.dataTransfer) {
							e.dataTransfer.dropEffect = 'move';
						}
						const rect = row.getBoundingClientRect();
						const isTop = e.clientY < rect.top + rect.height / 2;
						if (isTop) {
							row.style.boxShadow = '0 -2px 0 0 #38bdf8';
							row.style.borderColor = '#38bdf8';
						} else {
							row.style.boxShadow = '0 2px 0 0 #38bdf8';
							row.style.borderColor = '#38bdf8';
						}
					};

					row.ondragleave = () => {
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
					};

					row.ondrop = (e) => {
						e.preventDefault();
						e.stopPropagation();
						row.style.boxShadow = 'none';
						row.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						if (draggingStatusIndex === null || draggingStatusIndex === sIdx) {
							return;
						}
						const rect = row.getBoundingClientRect();
						const isTop = e.clientY < rect.top + rect.height / 2;
						let targetIdx = isTop ? sIdx : sIdx + 1;
						const [movedItem] = currentStatuses.splice(draggingStatusIndex, 1);
						if (draggingStatusIndex < targetIdx) {
							targetIdx--;
						}
						currentStatuses.splice(targetIdx, 0, movedItem);
						draggingStatusIndex = null;
						renderModalRows();
					};

					// Color Dot
					const colorDot = append(row, $('div', {
						style: `width: 18px; height: 18px; border-radius: 50%; background: ${st.color}; cursor: pointer; flex-shrink: 0; box-shadow: 0 0 6px ${st.color}55; border: 1.5px solid rgba(255,255,255,0.4);`
					}));
					colorDot.title = 'Click to cycle color';
					colorDot.onclick = () => {
						const colors = ['#818cf8', '#fbbf24', '#34d399', '#f43f5e', '#94a3b8', '#38bdf8', '#a855f7', '#06b6d4', '#ec4899'];
						const currIdx = colors.indexOf(st.color);
						st.color = colors[(currIdx + 1) % colors.length];
						renderModalRows();
					};

					// Status Label Input
					const labelInp = append(row, $('input.monaco-inputbox', {
						placeholder: 'Status Name',
						style: 'flex: 1; padding: 4px 8px; font-size: 12px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(0, 0, 0, 0.25); color: inherit;'
					})) as HTMLInputElement;
					labelInp.value = st.label;
					labelInp.oninput = () => {
						st.label = labelInp.value;
						st.id = labelInp.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
					};

					// Canonical Category Mapping Select
					append(row, $('span', { style: 'font-size: 11px; opacity: 0.65; white-space: nowrap;' }, 'Category:'));
					const catSel = append(row, $('select.monaco-select', {
						style: 'padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: #1a1a1a; color: inherit; cursor: pointer;'
					})) as HTMLSelectElement;
					['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'].forEach(cat => {
						const opt = append(catSel, $('option', { value: cat }, cat)) as HTMLOptionElement;
						if (st.category === cat) {
							opt.selected = true;
						}
					});
					catSel.value = st.category;
					catSel.onchange = () => {
						st.category = catSel.value as any;
					};

					// Row Actions: Move Up, Move Down, Delete
					const rowActs = append(row, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					if (sIdx > 0) {
						const upB = append(rowActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
						upB.title = 'Move Up';
						upB.onclick = () => {
							const [item] = currentStatuses.splice(sIdx, 1);
							currentStatuses.splice(sIdx - 1, 0, item);
							renderModalRows();
						};
					}
					if (sIdx < currentStatuses.length - 1) {
						const dnB = append(rowActs, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px;' }));
						dnB.title = 'Move Down';
						dnB.onclick = () => {
							const [item] = currentStatuses.splice(sIdx, 1);
							currentStatuses.splice(sIdx + 1, 0, item);
							renderModalRows();
						};
					}
					const delB = append(rowActs, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.6; font-size: 12px; color: #ef4444;' }));
					delB.title = 'Delete Status';
					delB.onclick = () => {
						if (currentStatuses.length <= 1) {
							this.notificationService.warn('At least one status stage must be preserved.');
							return;
						}
						currentStatuses.splice(sIdx, 1);
						renderModalRows();
					};
				});
			};
			renderModalRows();

			// Modal Footer
			const mFooter = append(modal, $('div', {
				style: 'display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 12px; margin-top: 6px;'
			}));

			const mFooterLeft = append(mFooter, $('div', { style: 'display: flex; gap: 8px;' }));
			const addStageBtn = append(mFooterLeft, $('button.monaco-button', {
				style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(167, 139, 250, 0.15); border: 1px solid rgba(167, 139, 250, 0.35); color: #c4b5fd;'
			}));
			addStageBtn.innerText = '+ Add Status Stage';
			addStageBtn.onclick = () => {
				currentStatuses.push({
					id: `status_${Date.now()}`,
					label: `New Stage`,
					color: '#38bdf8',
					category: 'In Progress'
				});
				renderModalRows();
			};

			const resetBtn = append(mFooterLeft, $('button.monaco-button', {
				style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); color: var(--vscode-descriptionForeground);'
			}));
			resetBtn.innerText = 'Reset to Defaults';
			resetBtn.onclick = () => {
				currentStatuses.length = 0;
				currentStatuses.push(...JSON.parse(JSON.stringify(DEFAULT_STATUS_DEFINITIONS)));
				renderModalRows();
			};

			const applyBtn = append(mFooter, $('button.monaco-button', {
				style: 'padding: 6px 18px; font-size: 12px; border-radius: 6px; cursor: pointer; background: #007acc; color: #ffffff; border: none; font-weight: 600;'
			}));
			applyBtn.innerText = 'Apply & Close';
			applyBtn.onclick = () => {
				activeMod.statuses = currentStatuses;
				renderStatusPills();
				renderCanvas();
				overlay.remove();
			};
		};
		configStatusBtn.onclick = () => {
			openStatusLifecycleModal();
		};

		renderCanvas();

		// Footer Action Bar (Delete on left, Cancel & Save on right)
		const footer = append(wrapper, $('.schema-editor-footer', {
			style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08);'
		}));

		const footerLeft = append(footer, $('.schema-editor-footer-left'));
		const footerDelBtn = append(footerLeft, $('button.monaco-button.schema-delete-btn', {
			style: 'padding: 6px 14px; font-size: 12px; border-radius: 6px; cursor: pointer; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); font-weight: 500; display: flex; align-items: center; gap: 6px;'
		}));
		append(footerDelBtn, $('span.codicon.codicon-trash'));
		append(footerDelBtn, $('span', {}, 'Delete Module'));
		footerDelBtn.onclick = handleDeleteModule;

		const footerRight = append(footer, $('.schema-editor-footer-right', {
			style: 'display: flex; align-items: center; gap: 12px;'
		}));

		const cancelBtn = append(footerRight, $('button.monaco-button', {
			style: 'padding: 6px 16px; font-size: 12px; border-radius: 6px; cursor: pointer; background: rgba(255, 255, 255, 0.08); color: #e0e0e0; border: 1px solid rgba(255, 255, 255, 0.15);'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => {
			if (this.input instanceof CustomModuleSchemaEditorInput) {
				this.input.draftModule = undefined;
			}
			this.group.closeEditor(this.input!);
		};

		const saveBtn = append(footerRight, $('button.monaco-button', {
			style: 'padding: 6px 20px; font-size: 12px; border-radius: 6px; cursor: pointer; background: #007acc; color: #ffffff; border: none; font-weight: 600;'
		}));
		saveBtn.innerText = 'Save Module Schema';
		saveBtn.onclick = async () => {
			try {
				activeMod.statuses = currentStatuses;
				const currentModules = await this.customModulesService.getCustomModules(input.workspaceUri);
				const existingIndex = currentModules.findIndex(m => m.id.toLowerCase() === activeMod.id.toLowerCase());
				if (existingIndex !== -1) {
					currentModules[existingIndex] = activeMod;
				} else {
					currentModules.push(activeMod);
				}
				await this.customModulesService.saveCustomModules(currentModules, input.workspaceUri);
				this._syncDraft();
				this.notificationService.info(`Successfully saved schema for module "${activeMod.name}"`);
			} catch (e) {
				this.notificationService.error(`Failed to save schema: ${e}`);
			}
		};
	}

	private async _fetchUrlContent(
		rawUrl: string,
		credentials?: Array<{ key: string; value: string }>
	): Promise<{ title: string; content: string; isAuthRequired?: boolean; rawError?: string }> {
		let targetUrl = rawUrl.trim();
		if (!/^https?:\/\//i.test(targetUrl)) {
			targetUrl = 'https://' + targetUrl;
		}

		// 1. Try headless extraction via IWebContentExtractorService first
		// This uses the integrated browser's session partition ('persist:vscode-browser'),
		// so logged-in cookies and JavaScript dynamic single-page applications (SPA) are executed seamlessly!
		try {
			const extractorService = this._instantiationService.invokeFunction(accessor => accessor.get(IWebContentExtractorService));
			if (extractorService) {
				const uri = URI.parse(targetUrl);
				const extractResults = await Promise.race([
					extractorService.extract([uri], { followRedirects: true }),
					new Promise<WebContentExtractResult[]>((_, reject) => setTimeout(() => reject(new Error('Extraction timed out')), 12000))
				]);
				if (extractResults && extractResults.length > 0) {
					const first = extractResults[0];
					if (first.status === 'ok' && first.result && first.result.length > 30) {
						const title = first.title || targetUrl;
						const formatted = `# ${title}\nURL: ${targetUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${first.result}`;
						return { title, content: formatted };
					} else if (first.status === 'error' && /auth|401|403|login|session|verification/i.test(first.error)) {
						return {
							title: targetUrl,
							content: first.result || first.error,
							isAuthRequired: true,
							rawError: first.error
						};
					}
				}
			}
		} catch {
			// Fallback to HTTP request
		}

		// 2. Fallback to direct HTTP request with bridged browser cookies & user credentials
		let html = '';
		let statusCode = 200;
		try {
			let reqService: IRequestService = this._requestService;
			try {
				const mainProcessService = this._instantiationService.invokeFunction(accessor => accessor.get(IMainProcessService));
				if (mainProcessService) {
					reqService = new RequestChannelClient(mainProcessService.getChannel('request'));
				}
			} catch {
				// Fallback to renderer requestService
			}

			const extraHeaders: Record<string, string> = {};
			if (credentials && Array.isArray(credentials)) {
				for (const c of credentials) {
					if (!c.key || !c.value) { continue; }
					const lowerKey = c.key.toLowerCase().trim();
					if (lowerKey === 'cookie') {
						extraHeaders['Cookie'] = c.value;
					} else if (lowerKey === 'li_at') {
						extraHeaders['Cookie'] = (extraHeaders['Cookie'] ? extraHeaders['Cookie'] + '; ' : '') + `li_at=${c.value}`;
					} else if (lowerKey === 'token' || lowerKey === 'bearer') {
						extraHeaders['Authorization'] = `Bearer ${c.value}`;
					} else if (lowerKey === 'authorization') {
						extraHeaders['Authorization'] = c.value;
					} else {
						extraHeaders[c.key.trim()] = c.value;
					}
				}
			}

			const requestOptions = {
				type: 'GET',
				url: targetUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.9',
					'Sec-Fetch-Dest': 'document',
					'Sec-Fetch-Mode': 'navigate',
					'Sec-Fetch-Site': 'none',
					...extraHeaders
				},
				timeout: 20000,
				callSite: 'customModuleSchemaEditor'
			};
			const context = await reqService.request(requestOptions, CancellationToken.None);
			statusCode = context.res.statusCode || 200;
			const text = await asText(context);
			html = text || '';
		} catch (err: any) {
			const rawErr = err?.message || String(err);
			return {
				title: targetUrl,
				content: `Failed to fetch URL (${targetUrl}): ${rawErr}`,
				rawError: rawErr
			};
		}

		if (!html) {
			return { title: targetUrl, content: `Empty response received from ${targetUrl}`, rawError: 'Empty response body' };
		}

		// Detect true authentication walls (redirects to login, 401, 403, or authwall pages)
		const isAuthPage = statusCode === 401 || statusCode === 403 ||
			(html.includes('/uas/login') && !targetUrl.includes('/login') && !targetUrl.includes('/signup')) ||
			(html.includes('authwall') && !targetUrl.includes('authwall'));

		if (isAuthPage) {
			return {
				title: targetUrl,
				content: html,
				isAuthRequired: true,
				rawError: `HTTP ${statusCode}: Authentication or Session Verification Required`
			};
		}

		try {
			let title = targetUrl;
			const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
			}

			const cleanedText = this._cleanHtmlToText(html);
			const maxChars = 25000;
			const displayContent = cleanedText.length > maxChars
				? cleanedText.slice(0, maxChars) + '\n\n... [Content truncated for display and AI context]'
				: cleanedText;

			const formatted = `# ${title}\nURL: ${targetUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${displayContent}`;
			return { title, content: formatted };
		} catch (parseErr: any) {
			const cleaned = this._cleanHtmlToText(html);
			return { title: targetUrl, content: cleaned };
		}
	}

	private _cleanHtmlToText(html: string): string {
		try {
			// 1. Remove non-content tags including script, style, svg, iframe, noscript, etc.
			let clean = html.replace(/<(script|style|svg|noscript|iframe|canvas|video|audio|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
			// 2. Convert block-level tags and line-breaks to newlines
			clean = clean.replace(/<\/?(p|div|li|h[1-6]|tr|article|section|header|footer|br|blockquote|table|ol|ul)[^>]*>/gi, '\n');
			// 3. Strip all remaining HTML tags
			clean = clean.replace(/<[^>]+>/g, ' ');
			// 4. Decode common HTML entities
			clean = clean
				.replace(/&nbsp;/gi, ' ')
				.replace(/&amp;/gi, '&')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/&middot;/gi, '·');
			// 5. Clean up multiple spaces and empty lines
			const lines = clean.split('\n')
				.map(l => l.replace(/[ \t]+/g, ' ').trim())
				.filter(l => l.length > 0);

			return lines.join('\n');
		} catch {
			return html.replace(/<[^>]+>/g, ' ').slice(0, 10000);
		}
	}

	private async _executeBrowserFetch(
		urlInput: HTMLInputElement,
		statusEl: HTMLElement,
		contentEl: HTMLElement,
		field: ICustomField,
		openTab: boolean,
		allFields?: ICustomField[]
	): Promise<void> {
		let url = urlInput.value.trim();
		if (!url) {
			this.notificationService.warn('Please enter a target URL before testing.');
			urlInput.focus();
			return;
		}

		if (!/^https?:\/\//i.test(url)) {
			url = 'https://' + url;
			urlInput.value = url;
			field.defaultUrl = url;
		}

		let finalUrl = url;
		if (allFields) {
			for (const f of allFields) {
				if (f.type === 'parameters' && f.parameters) {
					for (const p of f.parameters) {
						if (p.name) {
							const val = p.defaultValue ?? '';
							const reDouble = new RegExp(`\\{\\{\\s*${p.name}\\s*\\}\\}`, 'g');
							const reSingle = new RegExp(`\\{\\s*${p.name}\\s*\\}`, 'g');
							finalUrl = finalUrl.replace(reDouble, val).replace(reSingle, val);
						}
					}
				}
			}
		}

		if (openTab) {
			this._syncDraft();
			try {
				const uri = URI.parse(finalUrl);
				await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
					viewColumn: -2, // ViewColumn.Beside (split editor beside)
					preserveFocus: false
				});
			} catch (e) {
				try {
					await this._commandService.executeCommand('simpleBrowser.show', finalUrl);
				} catch (err) {
					console.error('Failed to open simpleBrowser:', err);
				}
			}
		}

		statusEl.textContent = 'Fetching webpage content...';
		statusEl.style.color = '#38bdf8';

		try {
			const result = await this._fetchUrlContent(finalUrl, field.credentials);
			if (result.isAuthRequired) {
				throw new Error(result.rawError || 'Authentication Required');
			}
			if (result.content.startsWith('Failed to fetch URL')) {
				throw new Error(result.rawError || result.content);
			}
			contentEl.textContent = result.content;
			field.defaultContent = result.content;
			this._syncDraft();
			const charCount = result.content.length;
			const timestamp = new Date().toLocaleTimeString();
			statusEl.textContent = `Fetched at ${timestamp} (${charCount} chars)`;
			statusEl.style.color = '#34d399';
			// Suppress notificationService.info toast to prevent webview "Paused due to Notification" overlay
		} catch (err: any) {
			const rawErr = err?.message || String(err);
			const isAuthOrCors = /auth|401|403|login|session|verification/i.test(rawErr);
			const timestamp = new Date().toLocaleString();
			if (isAuthOrCors) {
				statusEl.textContent = 'Auth Required / Protected Page (Raw Error Logged)';
				statusEl.style.color = '#fbbf24';
				const formattedNotice = `[AUTH REQUIRED / PROTECTED PAGE]
Target URL: ${url}
Timestamp: ${timestamp}
Status: Authentication Required / Access Restricted

--- [RAW SERVER & NETWORK RESPONSE] ---
${rawErr}

--- [AUTOMATION & TROUBLESHOOTING GUIDANCE] ---
1. Why this happened:
   The destination endpoint (${url}) requires an active authenticated session or blocks unauthenticated automated background crawlers (CORS / Anti-Scraping / 307 Redirect to Login).

2. Interactive Login:
   Click the "Open in Tab" or "+ New Tab" button directly above this card to open a browser tab beside and log in.

3. Automated AI Agent usage:
   In the "Authentication Credentials (Key-Value Pairs)" section above, configure your login credentials (username/email & password or session token). AI agents will use these credentials when automating tasks on this ticket.`;

				contentEl.textContent = formattedNotice;
				field.defaultContent = formattedNotice;
				this._syncDraft();
				// Avoid notificationService.warn toast to prevent webview "Paused due to Notification" overlay
			} else {
				statusEl.textContent = `Fetch failed: ${rawErr.slice(0, 30)}`;
				statusEl.style.color = '#f87171';
				const formattedErr = `[HTTP / NETWORK FETCH ERROR]
Target URL: ${url}
Timestamp: ${timestamp}

--- [RAW SERVER & NETWORK ERROR] ---
${rawErr}

--- [SUGGESTED ACTION] ---
Check the network connection or click "Open in Tab" / "+ New Tab" to inspect the page interactively.`;

				contentEl.textContent = formattedErr;
				field.defaultContent = formattedErr;
				this._syncDraft();
			}
		}
	}
}
