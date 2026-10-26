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
import { ICustomModule, ICustomField, CustomFieldType, ICompositeComponent, IStatusDefinition, IActionButton, DEFAULT_STATUS_DEFINITIONS, IOutputSpec } from '../../entityPersistence/common/entityPersistence.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
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
import { IAgentsManagerService, IAgentCredentialService } from '../../agentsManager/common/agentsManager.js';
import { showPrimitiveHelpModal } from './primitiveHelpGuide.js';
import { ITicketWorkflowRuntimeService } from '../../workflowsManager/browser/ticketWorkflowRuntime.js';


export class CustomModuleSchemaEditor extends EditorPane {
	static readonly ID = 'workbench.editor.customModuleSchema';

	private _container?: HTMLElement;
	private _activeModule?: ICustomModule;
	private _isToolboxCompact: boolean = false;
	private _workspaceUri?: URI;

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
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService
	) {
		super(CustomModuleSchemaEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.custom-module-schema-editor'));
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.boxSizing = 'border-box';
		this._container.style.background = 'var(--vscode-editor-background, #181818)';
		this._container.style.color = 'var(--vscode-editor-foreground, #e0e0e0)';
		this._container.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		this._container.style.padding = '0';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'row';
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

	private async _persistCurrentModule(): Promise<void> {
		if (!this._activeModule) {
			return;
		}
		this._syncDraft();
		const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
		try {
			const currentModules = await this.customModulesService.getCustomModules(wsUri);
			const existingIndex = currentModules.findIndex(m => m.id.toLowerCase() === this._activeModule!.id.toLowerCase());
			if (existingIndex !== -1) {
				currentModules[existingIndex] = this._activeModule!;
			} else {
				currentModules.push(this._activeModule!);
			}
			await this.customModulesService.saveCustomModules(currentModules, wsUri);
		} catch (e) {
			console.warn('[CustomModuleSchemaEditor] Failed to auto-persist schema module:', e);
		}
	}

	private async _loadAndRender(input: CustomModuleSchemaEditorInput): Promise<void> {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		this._workspaceUri = input.workspaceUri;

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

		// 1. Left Dedicated Toolbox Sidebar (Full-height, pinned, independent scroll, like Workflow Toolbox)
		const leftLibrary = append(this._container, $('.schema-editor-toolbox', {
			style: `width: ${this._isToolboxCompact ? '56px' : '260px'}; min-width: ${this._isToolboxCompact ? '56px' : '260px'}; height: 100%; border-right: 1px solid var(--vscode-sideBar-border, rgba(255, 255, 255, 0.08)); background: var(--vscode-sideBar-background, #181818); display: flex; flex-direction: column; padding: ${this._isToolboxCompact ? '12px 6px' : '16px 14px'}; gap: 14px; box-sizing: border-box; flex-shrink: 0; overflow-y: auto; overflow-x: hidden; transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.2s cubic-bezier(0.16, 1, 0.3, 1);`
		}));

		// 2. Right Main Scrollable Viewport (Contains Header, Config Card, Canvas & Footer. Scrolls smoothly as a unified document!)
		const mainViewport = append(this._container, $('.schema-editor-main-viewport', {
			style: 'flex: 1; height: 100%; min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 24px 36px; box-sizing: border-box;'
		}));

		const wrapper = append(mainViewport, $('.schema-editor-wrapper', {
			style: 'max-width: 1080px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 18px;'
		}));

		activeMod.isDeprecated = !!activeMod.isDeprecated;

		// Header Bar
		const header = append(wrapper, $('.schema-editor-header', {
			style: 'display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 8px; flex-shrink: 0;'
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
			style: 'display: flex; flex-direction: column; gap: 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); padding: 10px 14px; border-radius: 8px; flex-shrink: 0;'
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
			style: 'width: 100%; height: 50px; padding: 6px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #141414; color: inherit; box-sizing: border-box; resize: vertical; line-height: 1.4;'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'Provide specific guidelines for AI agents handling this module entity...';
		promptInput.value = activeMod.prompt || '';
		promptInput.oninput = () => {
			activeMod.prompt = promptInput.value;
		};

		// Configure Left Toolbox (Full-height Sidebar)
		const toolboxHeader = append(leftLibrary, $('.workflow-toolbar-header', {
			style: 'display: flex; align-items: center; justify-content: space-between; width: 100%; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);'
		}));
		if (!this._isToolboxCompact) {
			const tbTitle = append(toolboxHeader, $('div', {
				style: 'font-size: 11px; font-weight: 700; color: #38bdf8; letter-spacing: 0.6px; text-transform: uppercase;'
			}, 'TOOLBOX'));
			tbTitle.title = 'Primitives & Components Toolbox';
		}
		const toggleBtn = append(toolboxHeader, $('button.monaco-button.workflow-toolbar-toggle-btn', {
			type: 'button',
			title: this._isToolboxCompact ? 'Expand Toolbox' : 'Collapse Toolbox',
			style: 'width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.03); color: #888888; cursor: pointer; padding: 0;'
		}));
		append(toggleBtn, $('span' + ThemeIcon.asCSSSelector(this._isToolboxCompact ? Codicon.chevronRight : Codicon.chevronLeft)));
		toggleBtn.onclick = (e) => {
			e.stopPropagation();
			this._isToolboxCompact = !this._isToolboxCompact;
			this._loadAndRender(input);
		};

		if (!this._isToolboxCompact) {
			append(leftLibrary, $('div', { style: 'font-size: 10.5px; opacity: 0.65; line-height: 1.4;' }, 'Drag & drop components anywhere to canvas on the right, or click to append.'));
			append(leftLibrary, $('div', { style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #38bdf8; margin-top: 4px;' }, 'Base Primitives'));
		}

		const primitivesList = append(leftLibrary, $('.primitives-list', {
			style: `display: flex; flex-direction: column; gap: 6px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
		}));

		const baseComponents: Array<{ label: string; icon: ThemeIcon; type: CustomFieldType; defaultName: string; defaultChoices?: string[]; itemFields?: ICustomField[]; buttons?: IActionButton[] }> = [
			{
				label: 'Input Parameters (Runtime Variables)',
				icon: Codicon.symbolVariable,
				type: 'parameters',
				defaultName: 'Parameters'
			},
			{
				label: 'AI Prompt (Model / Agent)',
				icon: Codicon.sparkle,
				type: 'prompt',
				defaultName: 'AI Prompt'
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
				label: 'Python (Code Automation)',
				icon: Codicon.code,
				type: 'python',
				defaultName: 'Python Script'
			},
			{
				label: 'Output',
				icon: Codicon.output,
				type: 'output',
				defaultName: 'Output'
			},
			{ label: 'Single-line Input (Text)', icon: Codicon.symbolString, type: 'text', defaultName: 'Text Field' },
			{ label: 'Textarea (Multiline)', icon: Codicon.listFlat, type: 'textarea', defaultName: 'Description' },
			{ label: 'Number Input (Numeric)', icon: Codicon.symbolNumber, type: 'number', defaultName: 'Amount' },
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
			}
		];

		// Right Main Area: Canvas appended inside scrollable wrapper
		const rightCanvas = append(wrapper, $('.designer-canvas', {
			style: 'display: flex; flex-direction: column; gap: 14px; min-height: 400px; transition: all 0.2s ease;'
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
			if (bc.type === 'python') {
				newField.pythonPath = '';
				newField.pythonEnvMode = 'existing';
				newField.pythonCode = '# Write Python automation script here\nimport sys, os, json\n\n# Access upstream context via TICKET_CONTEXT (e.g. TICKET_CONTEXT.get("Field Name"))\n# Define the return value for Output Manifest and downstream steps:\nOUTPUT = {"status": "success", "message": "Hello from Python primitive"}\n';
				newField.pythonOutput = '';
			}
			if (bc.type === 'parameters') {
				newField.parameters = [
					{ id: `param_${Date.now()}_1`, name: 'start', label: 'Start Offset', defaultValue: '0', description: 'Zero-based pagination start index' }
				];
			}
			if (bc.type === 'prompt') {
				newField.defaultContent = 'Please analyze the ticket details and execute instructions:';
				newField.targetMode = 'model';
				newField.targetModel = 'gemini-1.5-flash';
				newField.targetAgentId = '';
			}
			if (bc.type === 'output') {
				const candidatePrimitives = fields.filter(f =>
					f &&
					f.type !== 'output' &&
					f.type !== 'result' &&
					f.id !== 'title' &&
					f.id !== 'description' &&
					f.label?.toLowerCase() !== 'title' &&
					f.label?.toLowerCase() !== 'description'
				);
				newField.outputSpecs = candidatePrimitives.map(cp => ({
					fieldKey: cp.label || cp.id,
					label: cp.label || cp.id,
					enabled: true,
					defaultFormat: 'table'
				}));
			}
			if (typeof insertIndex === 'number' && insertIndex >= 0 && insertIndex <= fields.length) {
				const safeInsertIndex = Math.max(2, insertIndex);
				fields.splice(safeInsertIndex, 0, newField);
			} else {
				fields.push(newField);
			}
			renderCanvas();
			if (insertIndex === undefined) {
				setTimeout(() => {
					mainViewport.scrollTop = mainViewport.scrollHeight;
				}, 40);
			}
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
			if (insertIndex === undefined) {
				setTimeout(() => {
					mainViewport.scrollTop = mainViewport.scrollHeight;
				}, 40);
			}
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
				const isPython = field.type === 'python';
				const isParameters = field.type === 'parameters';
				const isPrompt = field.type === 'prompt';
				const isOutput = field.type === 'output' || field.type === 'result';
				const badgeText = isContainer ? 'CONTAINER' : (isAttachment ? 'ATTACHMENT' : (isNumber ? 'NUMBER' : (isBrowser ? 'BROWSER' : (isGit ? 'GIT REPO' : (isPython ? 'PYTHON' : (isParameters ? 'INPUT PARAMETERS' : (isPrompt ? 'AI PROMPT' : (isOutput ? 'OUTPUT' : field.type.toUpperCase()))))))));
				const badgeBg = isContainer ? 'rgba(6, 182, 212, 0.18)' : (isAttachment ? 'rgba(16, 185, 129, 0.18)' : (isNumber ? 'rgba(234, 179, 8, 0.18)' : (isBrowser ? 'rgba(56, 189, 248, 0.18)' : (isGit ? 'rgba(249, 115, 22, 0.18)' : (isPython ? 'rgba(56, 189, 248, 0.15)' : (isParameters ? 'rgba(168, 85, 247, 0.18)' : (isPrompt ? 'rgba(59, 130, 246, 0.18)' : (isOutput ? 'rgba(129, 140, 248, 0.18)' : 'rgba(99, 102, 241, 0.18)'))))))));
				const badgeColor = isContainer ? '#06b6d4' : (isAttachment ? '#10b981' : (isNumber ? '#facc15' : (isBrowser ? '#38bdf8' : (isGit ? '#f97316' : (isPython ? '#38bdf8' : (isParameters ? '#c084fc' : (isPrompt ? '#60a5fa' : (isOutput ? '#818cf8' : '#818cf8'))))))));
				const badgeBorder = isContainer ? 'rgba(6, 182, 212, 0.35)' : (isAttachment ? 'rgba(16, 185, 129, 0.35)' : (isNumber ? 'rgba(234, 179, 8, 0.35)' : (isBrowser ? 'rgba(56, 189, 248, 0.35)' : (isGit ? 'rgba(249, 115, 22, 0.35)' : (isPython ? 'rgba(56, 189, 248, 0.35)' : (isParameters ? 'rgba(168, 85, 247, 0.35)' : (isPrompt ? 'rgba(59, 130, 246, 0.35)' : (isOutput ? 'rgba(129, 140, 248, 0.35)' : 'rgba(99, 102, 241, 0.35)'))))))));

				append(headerLeft, $('span.type-badge', {
					style: `font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; letter-spacing: 0.04em;`
				}, badgeText));

				if (field.componentRef) {
					append(headerLeft, $('span.class-badge', {
						style: 'font-size: 9.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: rgba(6, 182, 212, 0.12); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.25);'
					}, `CLASS: ${field.label}`));
				}

				// Info button (circle with 'i') opening primitive usage guide & RUN_TICKETS execution behavior
				const infoCircleBtn = append(headerLeft, $('span.primitive-info-circle-btn', {
					style: 'display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border-radius: 50%; border: 1px solid rgba(56, 189, 248, 0.45); color: #38bdf8; background: rgba(56, 189, 248, 0.08); font-size: 11px; cursor: pointer; transition: all 0.15s ease; user-select: none; margin-left: 2px;',
					title: `View ${field.label || field.type} usage guide & RUN_TICKETS execution behavior`
				}));
				append(infoCircleBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
				infoCircleBtn.onmouseenter = () => {
					infoCircleBtn.style.background = 'rgba(56, 189, 248, 0.22)';
					infoCircleBtn.style.borderColor = '#38bdf8';
					infoCircleBtn.style.transform = 'scale(1.12)';
				};
				infoCircleBtn.onmouseleave = () => {
					infoCircleBtn.style.background = 'rgba(56, 189, 248, 0.08)';
					infoCircleBtn.style.borderColor = 'rgba(56, 189, 248, 0.45)';
					infoCircleBtn.style.transform = 'scale(1)';
				};
				infoCircleBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					showPrimitiveHelpModal(this._container!, field.type, field.label || field.id, field.componentRef);
				};


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
								{ type: 'attachment', label: 'Attachment' },
								{ type: 'prompt', label: 'AI Prompt' }
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
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: nowrap;'
					}));
					const contentHeaderLeft = append(contentHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1;'
					}));
					append(contentHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.9; text-transform: uppercase; color: #94a3b8; white-space: nowrap;'
					}, 'Debug: Extracted Web Content (Test Preview):'));

					append(contentHeaderLeft, $('span.browser-debug-badge', {
						style: 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600; white-space: nowrap;'
					}, 'Template Debug Only'));

					const statusBadge = append(contentHeaderLeft, $('span.browser-fetch-status', {
						style: 'font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); opacity: 0.75; display: none; white-space: nowrap;'
					}));

					const contentHeaderRight = append(contentHeader, $('div', {
						style: 'display: flex; gap: 5px; align-items: center; flex-shrink: 0;'
					}));

					const copyBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					copyBtn.innerText = 'Copy';

					const clearBtn = append(contentHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					clearBtn.innerText = 'Clear';

					const contentDisplay = append(contentArea, $('.browser-content-display', {
						style: 'min-height: 110px; max-height: 240px; overflow-y: auto; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #e2e8f0;'
					}));

					const resetPlaceholder = () => {
						clearNode(contentDisplay);
						append(contentDisplay, $('span', { style: 'opacity: 0.4; font-style: italic;' }, 'No webpage content extracted yet. Enter a URL above and click "Fetch (Silent)" or "Open in Tab" to test webpage extraction during template design. (This is debug preview only, not saved to ticket instances)'));
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

					clearBtn.onclick = async () => {
						resetPlaceholder();
						statusBadge.textContent = '';
						statusBadge.style.display = 'none';
						field.defaultContent = '';
						this._syncDraft();
						await this._persistCurrentModule();
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

				// Prompt Primitive Configuration Box
				if (field.type === 'prompt') {
					if (!field.targetMode) {
						field.targetMode = 'model';
					}
					if (!field.targetModel) {
						field.targetModel = 'gemini-1.5-flash';
					}
					const promptSchemaBox = append(fieldCard, $('.prompt-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.25);'
					}));

					// Top Description
					const promptNotice = append(promptSchemaBox, $('div', { style: 'font-size: 11px; opacity: 0.85; line-height: 1.4; color: #60a5fa; display: flex; align-items: center; gap: 6px;' }));
					append(promptNotice, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkle)));
					append(promptNotice, $('span', {}, 'AI Prompt Primitive: configure instruction prompt and choose whether it is processed by an AI Model or an autonomous AI Agent.'));

					// Target Mode Switcher (Model vs Agent)
					const modeRow = append(promptSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					append(modeRow, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Processing Target Mode:'));
					const modeButtons = append(modeRow, $('div', { style: 'display: flex; gap: 8px;' }));

					const modelModeBtn = append(modeButtons, $('button.monaco-button', {
						type: 'button',
						style: `padding: 6px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; ${field.targetMode !== 'agent' ? 'background: rgba(59, 130, 246, 0.18); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.5);' : 'background: rgba(255, 255, 255, 0.05); color: #ccc; border: 1px solid rgba(255, 255, 255, 0.15);'}`
					})) as HTMLButtonElement;
					append(modelModeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.zap)));
					append(modelModeBtn, $('span', {}, 'Large Language Model (Direct)'));

					const agentModeBtn = append(modeButtons, $('button.monaco-button', {
						type: 'button',
						style: `padding: 6px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; ${field.targetMode === 'agent' ? 'background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5);' : 'background: rgba(255, 255, 255, 0.05); color: #ccc; border: 1px solid rgba(255, 255, 255, 0.15);'}`
					})) as HTMLButtonElement;
					append(agentModeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
					append(agentModeBtn, $('span', {}, 'AI Agent (Role-based Autonomous)'));

					// Target Selector Container
					const targetSelectContainer = append(promptSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));

					const renderTargetSelector = async () => {
						clearNode(targetSelectContainer);
						if (field.targetMode === 'agent') {
							append(targetSelectContainer, $('label', { style: 'font-size: 11px; font-weight: 600; color: #38bdf8;' }, 'Target AI Agent:'));
							const agentSelect = append(targetSelectContainer, $('select.monaco-select-box', {
								style: 'width: 100%; padding: 6px 10px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLSelectElement;

							let agentsList: any[] = [];
							try {
								const agentsMgr = this._instantiationService.invokeFunction(accessor => {
									try { return accessor.get(IAgentsManagerService); } catch { return undefined; }
								});
								if (agentsMgr) {
									agentsList = await agentsMgr.getAgents();
								}
							} catch { }

							if (agentsList.length === 0) {
								const opt = append(agentSelect, $('option', { value: '' }, '-- No AI Agents configured yet --')) as HTMLOptionElement;
								opt.selected = true;
							} else {
								const defaultOpt = append(agentSelect, $('option', { value: '' }, '-- Select AI Agent --')) as HTMLOptionElement;
								if (!field.targetAgentId) defaultOpt.selected = true;

								agentsList.forEach(ag => {
									const opt = append(agentSelect, $('option', { value: ag.id }, `${ag.name} (${ag.role || 'Agent'})`)) as HTMLOptionElement;
									if (field.targetAgentId === ag.id) {
										opt.selected = true;
									}
								});
							}

							agentSelect.onchange = () => {
								field.targetAgentId = agentSelect.value;
								const selAgent = agentsList.find(a => a.id === agentSelect.value);
								field.targetAgentName = selAgent?.name || '';
							};
						} else {
							append(targetSelectContainer, $('label', { style: 'font-size: 11px; font-weight: 600; color: #60a5fa;' }, 'Target AI Model:'));
							const modelRow = append(targetSelectContainer, $('div', { style: 'display: flex; gap: 8px; align-items: center;' }));

							// Provider Selector (OpenAI, Gemini, Anthropic, Ollama, Custom, etc.)
							const providerSelect = append(modelRow, $('select.monaco-select-box', {
								style: 'width: 140px; padding: 6px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.35); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLSelectElement;

							// Model Selector
							const modelSelect = append(modelRow, $('select.monaco-select-box', {
								style: 'flex: 1; padding: 6px 10px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(59, 130, 246, 0.35); background: rgba(0, 0, 0, 0.25); color: inherit;'
							})) as HTMLSelectElement;

							const customInput = append(modelRow, $('input.monaco-inputbox', {
								placeholder: 'Custom model ID (e.g. deepseek-chat)',
								style: 'flex: 1; padding: 6px 10px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; display: none;'
							})) as HTMLInputElement;

							const providerModelsMap: Record<string, { id: string; label: string }[]> = {
								openai: [
									{ id: 'gpt-4o', label: 'OpenAI GPT-4o (Omni Flagship)' },
									{ id: 'gpt-4o-mini', label: 'OpenAI GPT-4o-mini (Lightweight)' },
									{ id: 'o1-preview', label: 'OpenAI o1 (Advanced Reasoning)' },
									{ id: 'o1-mini', label: 'OpenAI o1-mini (Fast Reasoning)' },
									{ id: 'gpt-4-turbo', label: 'OpenAI GPT-4 Turbo' },
									{ id: 'custom', label: 'Custom Model ID...' }
								],
								gemini: [
									{ id: 'gemini-2.5-flash', label: 'Google Gemini 2.5 Flash' },
									{ id: 'gemini-2.5-pro', label: 'Google Gemini 2.5 Pro' },
									{ id: 'gemini-2.0-flash', label: 'Google Gemini 2.0 Flash' },
									{ id: 'gemini-1.5-pro', label: 'Google Gemini 1.5 Pro' },
									{ id: 'gemini-1.5-flash', label: 'Google Gemini 1.5 Flash' },
									{ id: 'custom', label: 'Custom Model ID...' }
								],
								anthropic: [
									{ id: 'claude-3-5-sonnet-20241022', label: 'Anthropic Claude 3.5 Sonnet' },
									{ id: 'claude-3-5-haiku-20241022', label: 'Anthropic Claude 3.5 Haiku' },
									{ id: 'claude-3-opus-20240229', label: 'Anthropic Claude 3 Opus' },
									{ id: 'custom', label: 'Custom Model ID...' }
								],
								ollama: [
									{ id: 'llama3.1', label: 'Ollama Llama 3.1' },
									{ id: 'qwen2.5-coder', label: 'Ollama Qwen 2.5 Coder' },
									{ id: 'mistral', label: 'Ollama Mistral' },
									{ id: 'deepseek-r1', label: 'Ollama DeepSeek-R1' },
									{ id: 'custom', label: 'Custom Model ID...' }
								],
								'custom-openai': [
									{ id: 'custom', label: 'Custom Endpoint Model' }
								]
							};

							const populateProviders = async () => {
								clearNode(providerSelect);
								let configuredCreds: any[] = [];
								try {
									const credService = this._instantiationService.invokeFunction(accessor => {
										try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
									});
									if (credService) {
										configuredCreds = await credService.getCredentials();
									}
								} catch {}

								const standardProviders = [
									{ id: 'openai', label: 'OpenAI' },
									{ id: 'gemini', label: 'Google Gemini' },
									{ id: 'anthropic', label: 'Anthropic Claude' },
									{ id: 'ollama', label: 'Ollama Local' },
									{ id: 'custom-openai', label: 'Custom Endpoint' }
								];

								// Determine active provider
								let activeProv = field.targetProvider || 'openai';
								if (!field.targetProvider && field.targetModel) {
									if (field.targetModel.startsWith('gemini')) activeProv = 'gemini';
									else if (field.targetModel.startsWith('claude')) activeProv = 'anthropic';
									else if (field.targetModel.startsWith('gpt') || field.targetModel.startsWith('o1')) activeProv = 'openai';
								}

								standardProviders.forEach(p => {
									const opt = append(providerSelect, $('option', { value: p.id }, p.label)) as HTMLOptionElement;
									if (p.id === activeProv) opt.selected = true;
								});

								field.targetProvider = providerSelect.value;
								updateModelsForProvider(field.targetProvider);
							};

							const updateModelsForProvider = (providerId: string) => {
								clearNode(modelSelect);
								const list = providerModelsMap[providerId] || providerModelsMap['openai'];
								let matched = false;
								list.forEach(m => {
									const opt = append(modelSelect, $('option', { value: m.id }, m.label)) as HTMLOptionElement;
									if (m.id === field.targetModel) {
										opt.selected = true;
										matched = true;
									}
								});
								if (!matched && field.targetModel && field.targetModel !== 'custom') {
									const customOpt = append(modelSelect, $('option', { value: field.targetModel }, `Custom: ${field.targetModel}`)) as HTMLOptionElement;
									customOpt.selected = true;
									matched = true;
								}
								if (!matched && list.length > 0) {
									field.targetModel = list[0].id;
									(modelSelect.firstChild as HTMLOptionElement).selected = true;
								}
								if (modelSelect.value === 'custom') {
									customInput.style.display = 'block';
									customInput.value = field.targetModel === 'custom' ? '' : (field.targetModel || '');
								} else {
									customInput.style.display = 'none';
								}
							};

							populateProviders();

							providerSelect.onchange = () => {
								field.targetProvider = providerSelect.value;
								const defaultFirst = (providerModelsMap[field.targetProvider] || [])[0]?.id || 'gpt-4o';
								field.targetModel = defaultFirst;
								updateModelsForProvider(field.targetProvider);
							};

							modelSelect.onchange = () => {
								if (modelSelect.value === 'custom') {
									customInput.style.display = 'block';
									customInput.focus();
									field.targetModel = customInput.value.trim() || 'gpt-4o';
								} else {
									customInput.style.display = 'none';
									field.targetModel = modelSelect.value;
								}
							};

							customInput.oninput = () => {
								field.targetModel = customInput.value.trim();
							};
						}
					};

					modelModeBtn.onclick = () => {
						field.targetMode = 'model';
						modelModeBtn.style.background = 'rgba(59, 130, 246, 0.18)';
						modelModeBtn.style.color = '#60a5fa';
						modelModeBtn.style.borderColor = 'rgba(59, 130, 246, 0.5)';
						agentModeBtn.style.background = 'rgba(255, 255, 255, 0.05)';
						agentModeBtn.style.color = '#ccc';
						agentModeBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						renderTargetSelector();
					};

					agentModeBtn.onclick = () => {
						field.targetMode = 'agent';
						agentModeBtn.style.background = 'rgba(56, 189, 248, 0.2)';
						agentModeBtn.style.color = '#38bdf8';
						agentModeBtn.style.borderColor = 'rgba(56, 189, 248, 0.5)';
						modelModeBtn.style.background = 'rgba(255, 255, 255, 0.05)';
						modelModeBtn.style.color = '#ccc';
						modelModeBtn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
						renderTargetSelector();
					};

					renderTargetSelector();

					// Collect available referenceable fields (primitives from the schema)
					const allSchemaFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
					const referenceableFields = allSchemaFields.filter(f => f && f.id !== field.id && f.type !== 'output' && f.type !== 'result');

					// Default Instruction / Prompt Template Textarea
					const promptTextRow = append(promptSchemaBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px; position: relative;' }));
					const promptTop = append(promptTextRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					append(promptTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Default Instruction / Prompt Template:'));
					append(promptTop, $('span', { style: 'font-size: 10px; color: #38bdf8;' }, 'Supports {Field Label} or @Field references'));

					// Quick Reference Insert Toolbar (Clickable Chips)
					if (referenceableFields.length > 0) {
						const chipBar = append(promptTextRow, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.15); border-radius: 4px; padding: 4px 8px;' }));
						append(chipBar, $('span', { style: 'font-size: 10px; font-weight: 600; color: #94a3b8;' }, 'Insert Primitive:'));
						referenceableFields.forEach(rf => {
							const rfLabel = rf.label || rf.id;
							const chip = append(chipBar, $('button.prompt-insert-chip', {
								type: 'button',
								style: 'padding: 2px 7px; font-size: 10px; font-weight: 600; border-radius: 3px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.28); cursor: pointer; transition: all 0.15s ease;'
							}));
							chip.textContent = `+ {${rfLabel}}`;
							chip.title = `Click to insert reference to ${rfLabel} (${rf.type.toUpperCase()})`;
							chip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								insertTextAtCursor(`{${rfLabel}}`);
							};
						});
					}

					const promptTextarea = append(promptTextRow, $('textarea.monaco-inputbox', {
						rows: 5,
						placeholder: 'e.g. Please analyze the ticket details:\nGet the result of {Linkedin Product Manager AI Software} above and extract each job as json...',
						style: 'width: 100%; padding: 8px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.45;'
					})) as HTMLTextAreaElement;
					promptTextarea.value = field.defaultContent || '';

					// Floating Autocomplete Menu for @ and {
					const autocompleteMenu = append(promptTextRow, $('div.prompt-autocomplete-menu', {
						style: 'display: none; position: absolute; z-index: 50; max-height: 160px; overflow-y: auto; background: #1e293b; border: 1px solid #38bdf8; border-radius: 5px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); width: 280px; padding: 4px;'
					}));

					// Live Referenced Primitives Preview Bar
					const previewRow = append(promptTextRow, $('div.prompt-references-preview', {
						style: 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-height: 20px; font-size: 10px;'
					}));

					const updateReferencePreview = () => {
						clearNode(previewRow);
						const val = promptTextarea.value;
						if (!val || referenceableFields.length === 0) return;

						const matchedRefs: typeof referenceableFields = [];
						for (const rf of referenceableFields) {
							const rfLabel = rf.label || rf.id;
							if (!rfLabel) continue;
							const escapedLabel = rfLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
							const reBrace = new RegExp(`\\{\\s*${escapedLabel}\\s*\\}`, 'i');
							const reAt = new RegExp(`@${escapedLabel}\\b`, 'i');
							const escapedId = rf.id ? rf.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
							const reIdBrace = escapedId ? new RegExp(`\\{\\s*${escapedId}\\s*\\}`, 'i') : null;

							if (reBrace.test(val) || reAt.test(val) || (reIdBrace && reIdBrace.test(val))) {
								matchedRefs.push(rf);
							}
						}

						if (matchedRefs.length > 0) {
							append(previewRow, $('span', { style: 'color: #94a3b8; font-weight: 600;' }, 'Linked Outputs:'));
							matchedRefs.forEach(rf => {
								const pill = append(previewRow, $('span.prompt-ref-pill', {
									style: 'padding: 2px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); font-weight: 600; display: inline-flex; align-items: center; gap: 4px;'
								}));
								pill.textContent = `🔗 ${rf.label || rf.id} [${rf.type.toUpperCase()}]`;
							});
						}
					};

					const insertTextAtCursor = (insertText: string) => {
						const start = promptTextarea.selectionStart || 0;
						const end = promptTextarea.selectionEnd || 0;
						const current = promptTextarea.value;
						promptTextarea.value = current.substring(0, start) + insertText + current.substring(end);
						promptTextarea.selectionStart = promptTextarea.selectionEnd = start + insertText.length;
						field.defaultContent = promptTextarea.value;
						promptTextarea.focus();
						updateReferencePreview();
						autocompleteMenu.style.display = 'none';
					};

					const showAutocomplete = (prefix: string) => {
						clearNode(autocompleteMenu);
						const query = prefix.toLowerCase();
						const filtered = referenceableFields.filter(rf =>
							(rf.label || rf.id).toLowerCase().includes(query) ||
							rf.type.toLowerCase().includes(query)
						);
						if (filtered.length === 0) {
							autocompleteMenu.style.display = 'none';
							return;
						}
						filtered.forEach(rf => {
							const rfLabel = rf.label || rf.id;
							const itemEl = append(autocompleteMenu, $('div.prompt-autocomplete-item', {
								style: 'padding: 5px 8px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; border-radius: 3px; transition: background 0.1s ease;'
							}));
							itemEl.onmouseenter = () => itemEl.style.background = 'rgba(56, 189, 248, 0.2)';
							itemEl.onmouseleave = () => itemEl.style.background = 'transparent';
							append(itemEl, $('span', { style: 'font-weight: 600; color: #f1f5f9;' }, rfLabel));
							append(itemEl, $('span', { style: 'font-size: 9px; color: #38bdf8; background: rgba(56,189,248,0.15); padding: 1px 4px; border-radius: 2px;' }, rf.type.toUpperCase()));

							itemEl.onmousedown = (e) => {
								e.preventDefault();
								e.stopPropagation();
								const start = promptTextarea.selectionStart || 0;
								const textBefore = promptTextarea.value.substring(0, start);
								const lastTriggerIdx = Math.max(textBefore.lastIndexOf('@'), textBefore.lastIndexOf('{'));
								if (lastTriggerIdx >= 0) {
									promptTextarea.value = promptTextarea.value.substring(0, lastTriggerIdx) + `{${rfLabel}}` + promptTextarea.value.substring(start);
									promptTextarea.selectionStart = promptTextarea.selectionEnd = lastTriggerIdx + rfLabel.length + 2;
								} else {
									insertTextAtCursor(`{${rfLabel}}`);
								}
								field.defaultContent = promptTextarea.value;
								updateReferencePreview();
								autocompleteMenu.style.display = 'none';
							};
						});

						autocompleteMenu.style.display = 'block';
						autocompleteMenu.style.bottom = '30px';
						autocompleteMenu.style.left = '10px';
					};

					promptTextarea.oninput = () => {
						field.defaultContent = promptTextarea.value;
						updateReferencePreview();

						const cursor = promptTextarea.selectionStart || 0;
						const before = promptTextarea.value.substring(0, cursor);
						const lastAt = before.lastIndexOf('@');
						const lastBrace = before.lastIndexOf('{');
						const triggerIdx = Math.max(lastAt, lastBrace);

						if (triggerIdx >= 0 && triggerIdx >= cursor - 25) {
							const query = before.substring(triggerIdx + 1);
							if (!/[\s\n}]/.test(query)) {
								showAutocomplete(query);
								return;
							}
						}
						autocompleteMenu.style.display = 'none';
					};

					promptTextarea.onkeydown = (e) => {
						if (e.key === 'Escape') {
							autocompleteMenu.style.display = 'none';
						}
					};

					updateReferencePreview();

					// Debug: AI Prompt Test Execution Area (Template Preview)
					const promptDebugArea = append(promptSchemaBox, $('.prompt-debug-container', {
						style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 6px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08);'
					}));

					const debugHeader = append(promptDebugArea, $('div', {
						style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: nowrap;'
					}));

					const debugHeaderLeft = append(debugHeader, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1;'
					}));

					append(debugHeaderLeft, $('span', {
						style: 'font-size: 11px; font-weight: 600; opacity: 0.9; text-transform: uppercase; color: #94a3b8; white-space: nowrap;'
					}, 'Debug: AI Execution Output (Test Preview):'));

					append(debugHeaderLeft, $('span.prompt-debug-badge', {
						style: 'font-size: 9.5px; padding: 2px 6px; border-radius: 3px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-weight: 600; white-space: nowrap;'
					}, 'Template Debug Only'));

					const promptStatusBadge = append(debugHeaderLeft, $('span.prompt-test-status', {
						style: 'font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); opacity: 0.75; display: none; white-space: nowrap;'
					}));

					const debugHeaderRight = append(debugHeader, $('div', {
						style: 'display: flex; gap: 5px; align-items: center; flex-shrink: 0;'
					}));

					// Test Prompt Button
					const testPromptBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px; font-weight: 600; border-radius: 4px; cursor: pointer; background: rgba(59, 130, 246, 0.22); border: 1px solid rgba(59, 130, 246, 0.5); color: #60a5fa; transition: all 0.15s ease; white-space: nowrap;'
					})) as HTMLButtonElement;
					append(testPromptBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
					append(testPromptBtn, $('span', {}, 'Test'));

					const copyPromptOutBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					copyPromptOutBtn.innerText = 'Copy';

					const clearPromptOutBtn = append(debugHeaderRight, $('button.monaco-button', {
						style: 'background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; padding: 2px 8px; font-size: 10.5px; opacity: 0.8; cursor: pointer; color: inherit; white-space: nowrap;'
					}));
					clearPromptOutBtn.innerText = 'Clear';

					const promptOutputDisplay = append(promptDebugArea, $('.prompt-output-display', {
						style: 'min-height: 110px; max-height: 260px; overflow-y: auto; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 6px; color: #e2e8f0;'
					}));

					const resetPromptOutputPlaceholder = () => {
						clearNode(promptOutputDisplay);
						append(promptOutputDisplay, $('span', { style: 'opacity: 0.4; font-style: italic;' }, 'No test response yet. Click "Test" to test your instruction with the configured AI model/agent during template design. (This is debug preview only, not saved to ticket instances)'));
					};

					if (field.debugPromptOutput) {
						promptOutputDisplay.textContent = field.debugPromptOutput;
						promptStatusBadge.textContent = 'Saved Preview';
						promptStatusBadge.style.color = '#34d399';
						promptStatusBadge.style.display = 'inline-block';
					} else {
						resetPromptOutputPlaceholder();
					}

					copyPromptOutBtn.onclick = () => {
						const text = promptOutputDisplay.textContent || '';
						if (text && !text.startsWith('No test response')) {
							this._clipboardService.writeText(text);
							this.notificationService.info('Prompt output copied to clipboard.');
						}
					};

					clearPromptOutBtn.onclick = async () => {
						resetPromptOutputPlaceholder();
						promptStatusBadge.textContent = '';
						promptStatusBadge.style.display = 'none';
						field.debugPromptOutput = '';
						this._syncDraft();
						await this._persistCurrentModule();
					};

					testPromptBtn.onclick = async () => {
						testPromptBtn.disabled = true;
						testPromptBtn.style.opacity = '0.5';
						try {
							await this._executePromptTest(promptTextarea, promptStatusBadge, promptOutputDisplay, field, allSchemaFields);
						} finally {
							testPromptBtn.disabled = false;
							testPromptBtn.style.opacity = '1';
						}
					};
				}

				if (field.type === 'output' || field.type === 'result') {
					if (!Array.isArray(field.outputSpecs)) {
						field.outputSpecs = [];
					}

					const outputBox = append(fieldCard, $('.primitive-config-box', {
						style: 'margin-top: 10px; padding: 12px 14px; background: rgba(129, 140, 248, 0.05); border: 1px solid rgba(129, 140, 248, 0.2); border-radius: 6px; display: flex; flex-direction: column; gap: 10px;'
					}));

					const headerRow = append(outputBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					const titleEl = append(headerRow, $('div', { style: 'font-size: 11.5px; font-weight: 600; color: #818cf8; display: flex; align-items: center; gap: 6px;' }));
					append(titleEl, $('span' + ThemeIcon.asCSSSelector(Codicon.output)));
					append(titleEl, $('span', {}, 'Output Manifest & Export Selection'));

					const syncBtn = append(headerRow, $('button.sync-primitives-btn', {
						style: 'display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; background: rgba(129, 140, 248, 0.15); color: #818cf8; border: 1px solid rgba(129, 140, 248, 0.35); cursor: pointer; transition: all 0.15s ease;'
					}));
					append(syncBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.refresh)));
					append(syncBtn, $('span', {}, 'Sync Primitives'));

					append(outputBox, $('div', { style: 'font-size: 11px; color: rgba(255, 255, 255, 0.65); line-height: 1.4;' },
						'Select which primitives to expose as outputs for inspection, downstream workflows, or other tickets.'
					));

					const specsContainer = append(outputBox, $('.output-specs-container', {
						style: 'display: flex; flex-direction: column; gap: 8px;'
					}));

					const syncSpecsWithCanvas = () => {
						try {
							const allFields = (this._activeModule?.fields && this._activeModule.fields.length > 0) ? this._activeModule.fields : fields;
							const currentCanvasFields = allFields.filter(f =>
								f &&
								f.id !== field.id &&
								f.type !== 'output' &&
								f.type !== 'result' &&
								f.id !== 'title' &&
								f.id !== 'description' &&
								f.label?.toLowerCase() !== 'title' &&
								f.label?.toLowerCase() !== 'description'
							);

							if (!Array.isArray(field.outputSpecs)) {
								field.outputSpecs = [];
							}

							const existingMap = new Map<string, IOutputSpec>();
							for (const s of field.outputSpecs) {
								if (s && typeof s === 'object') {
									if (s.fieldKey) { existingMap.set(s.fieldKey, s); }
									if (s.label) { existingMap.set(s.label, s); }
								}
							}

							const updated: IOutputSpec[] = [];
							for (const f of currentCanvasFields) {
								const fKey = f.label || f.id || 'Primitive';
								const existing = existingMap.get(fKey) || (f.id ? existingMap.get(f.id) : undefined);
								if (existing) {
									updated.push({
										fieldKey: fKey,
										label: f.label || f.id || fKey,
										enabled: existing.enabled ?? true,
										defaultFormat: existing.defaultFormat || 'table'
									});
								} else {
									updated.push({
										fieldKey: fKey,
										label: f.label || f.id || fKey,
										enabled: true,
										defaultFormat: 'table'
									});
								}
							}
							field.outputSpecs = updated;
						} catch (err) {
							console.error('[OutputPrimitive] syncSpecsWithCanvas error:', err);
							this.notificationService.error(`Sync error: ${err}`);
						}
					};

					const renderSpecsList = () => {
						try {
							clearNode(specsContainer);
							if (!Array.isArray(field.outputSpecs) || field.outputSpecs.length === 0) {
								append(specsContainer, $('div', {
									style: 'padding: 10px 14px; font-size: 11px; font-style: italic; color: rgba(255, 255, 255, 0.45); text-align: center; border: 1px dashed rgba(255, 255, 255, 0.15); border-radius: 4px; background: rgba(0, 0, 0, 0.15);'
								}, 'No candidate primitives found in canvas. Add Browser, AI Prompt, or other primitives, then click "Sync Primitives" above.'));
								return;
							}

							field.outputSpecs.forEach((spec, specIdx) => {
								if (!spec) {
									return;
								}
								const row = append(specsContainer, $('.output-spec-row', {
									style: 'display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 5px; gap: 10px;'
								}));

								const leftPart = append(row, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
								const checkbox = append(leftPart, $('input', {
									type: 'checkbox',
									style: 'cursor: pointer; width: 14px; height: 14px;'
								})) as HTMLInputElement;
								checkbox.checked = spec.enabled ?? true;
								checkbox.onchange = () => {
									spec.enabled = checkbox.checked;
									this._syncDraft();
								};

								append(leftPart, $('span', {
									style: 'font-size: 11.5px; font-weight: 500; color: #f1f5f9;'
								}, spec.label || spec.fieldKey || `Output ${specIdx + 1}`));

								const rightPart = append(row, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
								append(rightPart, $('span', { style: 'font-size: 10.5px; opacity: 0.6;' }, 'Default View:'));
								const formatSelect = append(rightPart, $('select', {
									style: 'padding: 2px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit;'
								})) as HTMLSelectElement;

								const formatOptions = [
									{ value: 'table', label: 'Table' },
									{ value: 'markdown', label: 'Markdown' },
									{ value: 'json', label: 'JSON' },
									{ value: 'text', label: 'Text' }
								];

								formatOptions.forEach(opt => {
									const optEl = document.createElement('option');
									optEl.value = opt.value;
									optEl.textContent = opt.label;
									if ((spec.defaultFormat || 'table') === opt.value) {
										optEl.selected = true;
									}
									formatSelect.appendChild(optEl);
								});

								formatSelect.onchange = () => {
									spec.defaultFormat = formatSelect.value;
									this._syncDraft();
								};
							});
						} catch (err) {
							console.error('[OutputPrimitive] renderSpecsList error:', err);
							this.notificationService.error(`Render error: ${err}`);
						}
					};

					syncSpecsWithCanvas();
					renderSpecsList();

					syncBtn.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						syncSpecsWithCanvas();
						renderSpecsList();
						this._syncDraft();
						const count = field.outputSpecs?.length || 0;
						this.notificationService.info(`Synced ${count} primitive(s) into Output Manifest.`);
					};
				}

				// Python Primitive Configuration Box
				if (field.type === 'python') {
					const pythonBox = append(fieldCard, $('.python-schema-config', {
						style: 'display: flex; flex-direction: column; gap: 12px; background: rgba(0, 0, 0, 0.2); padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08);'
					}));

					const pythonNote = append(pythonBox, $('div', { style: 'font-size: 11px; opacity: 0.8; line-height: 1.4; color: inherit; display: flex; align-items: center; gap: 6px;' }));
					append(pythonNote, $('span' + ThemeIcon.asCSSSelector(Codicon.code)));
					append(pythonNote, $('span', {}, 'Python Code Automation & Scripting Primitive. Run local scripts with custom Python interpreters or virtual environments.'));

					// Python Interpreter / Virtualenv Row
					const interpRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 5px;' }));
					const interpTop = append(interpRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					append(interpTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85; color: inherit;' }, 'Python Interpreter / Virtualenv:'));
					append(interpTop, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Leave empty for auto-detection (.venv or python3)'));

					let initialPyPath = '';
					if (typeof field.pythonPath === 'string') {
						initialPyPath = field.pythonPath.trim();
					} else if (field.pythonPath && typeof field.pythonPath === 'object') {
						initialPyPath = String((field.pythonPath as any).interpreterPath || (field.pythonPath as any).pythonPath || '').trim();
					}
					if (initialPyPath === '[object Object]' || initialPyPath === 'undefined' || initialPyPath === 'null') {
						initialPyPath = '';
					}
					field.pythonPath = initialPyPath;

					const interpInputBar = append(interpRow, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
					const interpInput = append(interpInputBar, $('input.monaco-inputbox', {
						placeholder: 'Auto-detect (.venv or system python3) — or click Browse... to select',
						style: 'flex: 1; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
					})) as HTMLInputElement;
					interpInput.value = initialPyPath;

					const browseBtn = append(interpInputBar, $('button', {
						style: 'padding: 5px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.08); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;',
						title: 'Select Python Interpreter or Virtualenv Folder'
					}));
					append(browseBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.folder)));
					append(browseBtn, $('span', {}, 'Browse...'));

					const testInterpBtn = append(interpInputBar, $('button', {
						style: 'padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.08); color: inherit; cursor: pointer; white-space: nowrap;',
						title: 'Test Python Interpreter and Verify Version'
					}, 'Test'));

					// Detection feedback & Create venv bar
					const statusRow = append(interpRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }));
					const statusBadge = append(statusRow, $('div', {
						style: 'font-size: 10.5px; display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.05); color: rgba(255, 255, 255, 0.7);'
					}));
					const venvCreateBtn = append(statusRow, $('button', {
						style: 'display: none; padding: 3px 10px; font-size: 10.5px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.12); color: #38bdf8; cursor: pointer; white-space: nowrap;',
						title: 'Create a new virtual environment at this path'
					}, '+ Create Virtualenv'));

					const updateDetectionStatus = async () => {
						let currentVal = interpInput.value.trim();
						if (currentVal === '[object Object]' || currentVal === 'undefined' || currentVal === 'null') {
							currentVal = '';
							interpInput.value = '';
						}
						field.pythonPath = currentVal;
						this._syncDraft();

						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);

						if (!runtime || !wsUri) {
							statusBadge.textContent = currentVal ? `Path: ${currentVal}` : 'Default: System / Active .venv';
							statusBadge.style.color = 'rgba(255, 255, 255, 0.7)';
							statusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
							statusBadge.style.border = 'none';
							venvCreateBtn.style.display = 'none';
							return;
						}

						try {
							const det = await runtime.detectPythonEnvironment(wsUri, currentVal);
							if (det.isValid) {
								venvCreateBtn.style.display = 'none';
								if (det.isVenv) {
									statusBadge.textContent = `✓ Virtualenv (${det.venvRoot || det.interpreterPath})`;
									statusBadge.style.color = '#4ade80';
									statusBadge.style.background = 'rgba(74, 222, 128, 0.12)';
									statusBadge.style.border = '1px solid rgba(74, 222, 128, 0.3)';
								} else {
									statusBadge.textContent = `✓ Interpreter (${det.interpreterPath})`;
									statusBadge.style.color = '#38bdf8';
									statusBadge.style.background = 'rgba(56, 189, 248, 0.12)';
									statusBadge.style.border = '1px solid rgba(56, 189, 248, 0.3)';
								}
							} else {
								statusBadge.textContent = `⚠ ${det.error || 'Virtual environment not found'}`;
								statusBadge.style.color = '#f87171';
								statusBadge.style.background = 'rgba(248, 113, 113, 0.12)';
								statusBadge.style.border = '1px solid rgba(248, 113, 113, 0.3)';
								venvCreateBtn.style.display = 'inline-block';
							}
						} catch {
							statusBadge.textContent = currentVal || 'Default: System / Active .venv';
							statusBadge.style.color = 'rgba(255, 255, 255, 0.7)';
							statusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
							statusBadge.style.border = 'none';
							venvCreateBtn.style.display = 'none';
						}
					};

					interpInput.oninput = () => {
						updateDetectionStatus();
					};

					browseBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						try {
							const uris = await this._fileDialogService.showOpenDialog({
								canSelectFiles: true,
								canSelectFolders: true,
								canSelectMany: false,
								title: 'Select Python Interpreter or Virtualenv Folder'
							});
							if (uris && uris.length > 0) {
								const pickedUri = uris[0];
								const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
								let finalPath = pickedUri.fsPath;
								if (wsUri && finalPath.startsWith(wsUri.fsPath)) {
									finalPath = finalPath.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
								}
								interpInput.value = finalPath;
								await updateDetectionStatus();
							}
						} catch (err: any) {
							this.notificationService.error(`Failed to pick folder: ${err.message || err}`);
						}
					};

					testInterpBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available for testing.');
							return;
						}
						testInterpBtn.setAttribute('disabled', 'true');
						testInterpBtn.textContent = 'Testing...';
						try {
							const res = await runtime.testPythonInterpreter(wsUri, interpInput.value.trim());
							if (res.success) {
								statusBadge.textContent = `${res.version} ✓`;
								statusBadge.style.color = '#4ade80';
								statusBadge.style.background = 'rgba(74, 222, 128, 0.12)';
								statusBadge.style.border = '1px solid rgba(74, 222, 128, 0.3)';
								this.notificationService.info(`Python interpreter verified: ${res.version}`);
							} else {
								statusBadge.textContent = 'Interpreter test failed ✗';
								statusBadge.style.color = '#f87171';
								statusBadge.style.background = 'rgba(248, 113, 113, 0.12)';
								statusBadge.style.border = '1px solid rgba(248, 113, 113, 0.3)';
								this.notificationService.warn(`Test failed: ${res.error}`);
							}
						} catch (err: any) {
							this.notificationService.error(`Test error: ${err.message || err}`);
						} finally {
							testInterpBtn.removeAttribute('disabled');
							testInterpBtn.textContent = 'Test';
						}
					};

					venvCreateBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available.');
							return;
						}
						venvCreateBtn.setAttribute('disabled', 'true');
						venvCreateBtn.textContent = 'Creating venv...';
						statusBadge.textContent = 'Initializing virtualenv via python3 -m venv... ⏳';
						try {
							const targetName = interpInput.value.trim() || '.venv';
							const res = await runtime.createVirtualEnv(wsUri, targetName);
							if (res.success) {
								this.notificationService.info(`Virtualenv created at ${res.venvPath}`);
								if (!interpInput.value.trim()) {
									interpInput.value = '.venv';
								}
								await updateDetectionStatus();
							} else {
								this.notificationService.error(`Failed to create virtualenv: ${res.error}`);
							}
						} catch (err: any) {
							this.notificationService.error(`Creation error: ${err.message || err}`);
						} finally {
							venvCreateBtn.removeAttribute('disabled');
							venvCreateBtn.textContent = '+ Create Virtualenv';
						}
					};

					// Trigger initial detection on render
					updateDetectionStatus();

					// Source Code Row
					const codeRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					const codeTop = append(codeRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
					append(codeTop, $('label', { style: 'font-size: 11px; font-weight: 600; opacity: 0.85;' }, 'Source Code:'));
					append(codeTop, $('span', { style: 'font-size: 10px; opacity: 0.55;' }, 'Supports {{variable}} interpolation'));
					const codeTextarea = append(codeRow, $('textarea.monaco-inputbox', {
						rows: '6',
						placeholder: '# Enter Python automation script...',
						style: 'width: 100%; padding: 8px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.45; resize: vertical;'
					})) as HTMLTextAreaElement;
					codeTextarea.value = field.pythonCode || '';
					codeTextarea.onkeydown = (e) => {
						if (e.key === 'Tab') {
							e.preventDefault();
							const start = codeTextarea.selectionStart;
							const end = codeTextarea.selectionEnd;
							codeTextarea.value = codeTextarea.value.substring(0, start) + '    ' + codeTextarea.value.substring(end);
							codeTextarea.selectionStart = codeTextarea.selectionEnd = start + 4;
							field.pythonCode = codeTextarea.value;
							this._syncDraft();
						}
					};
					codeTextarea.oninput = () => {
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
					};

					// Context Variable Insert Bar under Source Code
					const varBar = append(codeRow, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px;'
					}));
					append(varBar, $('span', { style: 'font-size: 10.5px; opacity: 0.65;' }, 'Insert Context:'));

					const insertTextAtCursor = (textToInsert: string, cursorOffsetFromEnd: number = 0) => {
						const start = codeTextarea.selectionStart;
						const end = codeTextarea.selectionEnd;
						const before = codeTextarea.value.substring(0, start);
						const after = codeTextarea.value.substring(end);
						codeTextarea.value = before + textToInsert + after;
						const newCursor = start + textToInsert.length + cursorOffsetFromEnd;
						codeTextarea.selectionStart = codeTextarea.selectionEnd = newCursor;
						codeTextarea.focus();
						field.pythonCode = codeTextarea.value;
						this._syncDraft();
					};

					// Base Chip: + TICKET_CONTEXT['']
					const chipStyle = 'padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;';

					const baseChip = append(varBar, $('button', {
						style: chipStyle + ' font-weight: 600;',
						title: 'Insert TICKET_CONTEXT[\'\'] into script'
					}, "+ TICKET_CONTEXT['']"));
					baseChip.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						insertTextAtCursor("TICKET_CONTEXT['']", -2);
					};

					// Return Value Chip: + OUTPUT =
					const outputChip = append(varBar, $('button', {
						style: chipStyle + ' font-weight: 600; border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1); color: #34d399;',
						title: 'Insert return value assignment OUTPUT = ... (consumed by downstream primitives & Output Manifest)'
					}, '+ OUTPUT = '));
					outputChip.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						insertTextAtCursor('\nOUTPUT = ');
					};

					// Specific Field Chips from Schema
					const otherFields = (fields || this._activeModule?.fields || []).filter(f => f && f.id !== field.id);
					const maxInitialVisible = 2;
					const visibleFields = otherFields.slice(0, maxInitialVisible);
					const hiddenFields = otherFields.slice(maxInitialVisible);

					visibleFields.forEach(of => {
						const ofLabel = of.label || of.id;
						const fieldChip = append(varBar, $('button', {
							style: chipStyle,
							title: `Insert TICKET_CONTEXT['${ofLabel}']`
						}, `+ TICKET_CONTEXT['${ofLabel}']`));
						fieldChip.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							insertTextAtCursor(`TICKET_CONTEXT['${ofLabel}']`);
						};
					});

					if (hiddenFields.length > 0) {
						const hiddenContainer = append(varBar, $('span', {
							style: 'display: none;'
						}));

						hiddenFields.forEach(of => {
							const ofLabel = of.label || of.id;
							const fieldChip = append(hiddenContainer, $('button', {
								style: chipStyle,
								title: `Insert TICKET_CONTEXT['${ofLabel}']`
							}, `+ TICKET_CONTEXT['${ofLabel}']`));
							fieldChip.onclick = (e) => {
								e.preventDefault();
								e.stopPropagation();
								insertTextAtCursor(`TICKET_CONTEXT['${ofLabel}']`);
							};
						});

						let isExpanded = false;
						const moreBtn = append(varBar, $('button', {
							style: 'padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;',
							title: 'Toggle more context fields'
						}, `+${hiddenFields.length} More...`));

						moreBtn.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							isExpanded = !isExpanded;
							if (isExpanded) {
								hiddenContainer.style.display = 'contents';
								moreBtn.textContent = 'Less';
							} else {
								hiddenContainer.style.display = 'none';
								moreBtn.textContent = `+${hiddenFields.length} More...`;
							}
						};
					}

					// DEBUG: Execution Output & Logs Preview Row
					const previewRow = append(pythonBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
					const previewHeader = append(previewRow, $('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }));

					const previewHeaderLeft = append(previewHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
					append(previewHeaderLeft, $('label', { style: 'font-size: 10.5px; font-weight: 600; opacity: 0.85; text-transform: uppercase;' }, 'DEBUG: Execution Output & Logs Preview:'));
					append(previewHeaderLeft, $('span', {
						style: 'font-size: 9.5px; padding: 1px 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); opacity: 0.75;'
					}, '[Template Debug Only]'));

					const previewActions = append(previewHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));

					const testRunBtn = append(previewActions, $('button', {
						style: 'padding: 3px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(56, 189, 248, 0.12); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Run script with current interpreter to test output'
					}));
					append(testRunBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
					append(testRunBtn, $('span', {}, 'Test'));

					const copyBtn = append(previewActions, $('button', {
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Copy output to clipboard'
					}));
					append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
					append(copyBtn, $('span', {}, 'Copy'));

					const clearBtn = append(previewActions, $('button', {
						style: 'padding: 3px 8px; font-size: 10.5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05); color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;',
						title: 'Clear output preview'
					}));
					append(clearBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clearAll)));
					append(clearBtn, $('span', {}, 'Clear'));

					const previewBox = append(previewRow, $('div', {
						style: 'padding: 8px 10px; font-size: 11px; border-radius: 5px; border: 1px dashed rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.25); color: rgba(255, 255, 255, 0.75); font-family: var(--vscode-editor-font-family, monospace); min-height: 48px; max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;'
					}));
					previewBox.textContent = field.pythonOutput || '[Ready to execute] Output, stdout/stderr, and runtime duration will appear here when run.';

					testRunBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const runtime = this._instantiationService.invokeFunction(accessor => {
							try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
						});
						const wsUri = this._workspaceUri || (this.input instanceof CustomModuleSchemaEditorInput ? this.input.workspaceUri : undefined);
						if (!runtime || !wsUri) {
							this.notificationService.warn('Workspace runtime not available for execution.');
							return;
						}
						testRunBtn.setAttribute('disabled', 'true');
						testRunBtn.style.opacity = '0.6';
						previewBox.textContent = '[Executing script...] Running in background terminal...';
						try {
							const scriptCode = codeTextarea.value;

							// Gather full schema context from preceding and static fields
							const schemaContext: Record<string, any> = {};
							const allFieldsToGather = fields || this._activeModule?.fields || [];
							for (const f of allFieldsToGather) {
								if (!f || f.id === field.id) continue;
								const fKey = f.label || f.id;
								let val: any = '';
								if (f.type === 'browser') {
									val = f.defaultContent || f.defaultUrl || '';
								} else if (f.type === 'parameters' && f.parameters) {
									const pMap: Record<string, any> = {};
									f.parameters.forEach(p => { if (p.name) pMap[p.name] = p.defaultValue ?? ''; });
									val = pMap;
								} else if (f.type === 'prompt') {
									val = f.debugPromptOutput || f.defaultContent || '';
								} else if (f.type === 'python') {
									val = f.pythonResult !== undefined ? f.pythonResult : (f.pythonOutput || f.pythonCode || '');
								} else if (f.type === 'git') {
									val = f.gitRemoteUrl || '';
								} else {
									val = f.defaultContent || f.defaultValue || '';
								}
								schemaContext[fKey] = val;
							}
							if (this._activeModule?.name) {
								schemaContext['Title'] = this._activeModule.name;
							}

							const res = await runtime.executePythonScript(wsUri, wsUri, interpInput.value.trim(), scriptCode, schemaContext);
							const durationStr = `${res.durationMs}ms`;
							const exitCodeStr = `Exit code: ${res.exitCode}`;
							const headerLine = `[Finished in ${durationStr} | ${exitCodeStr}]\n`;
							let displayText = '';
							if (res.result !== undefined) {
								const formattedResult = typeof res.result === 'object' ? JSON.stringify(res.result, null, 2) : String(res.result);
								displayText = `=== RETURN VALUE (OUTPUT) ===\n${formattedResult}\n\n=== CONSOLE LOGS & EXECUTION ===\n${headerLine}${res.output || '(No console stdout/stderr output)'}`;
							} else {
								displayText = `${headerLine}${res.output ? res.output : '(Script completed with no output)'}`;
							}
							previewBox.textContent = displayText;
							field.pythonOutput = displayText;
							field.pythonResult = res.result;
							this._syncDraft();
							await this._persistCurrentModule();
							if (res.success) {
								this.notificationService.info(`Script executed successfully (${durationStr})`);
							} else {
								this.notificationService.warn(`Script finished with exit code ${res.exitCode}`);
							}
						} catch (err: any) {
							previewBox.textContent = `[Error executing script]: ${err.message || err}`;
							this.notificationService.error(`Execution error: ${err.message || err}`);
						} finally {
							testRunBtn.removeAttribute('disabled');
							testRunBtn.style.opacity = '1';
						}
					};

					copyBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						const text = previewBox.textContent || '';
						if (!text) { return; }
						try {
							await this._clipboardService.writeText(text);
							this.notificationService.info('Output copied to clipboard.');
						} catch {
							this.notificationService.warn('Could not copy output to clipboard.');
						}
					};

					clearBtn.onclick = async (e) => {
						e.preventDefault();
						e.stopPropagation();
						previewBox.textContent = '[Ready to execute] Output, stdout/stderr, and runtime duration will appear here when run.';
						field.pythonOutput = '';
						field.pythonResult = undefined;
						this._syncDraft();
						await this._persistCurrentModule();
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
				title: `${bc.label} (Drag or Click to Add)`,
				style: this._isToolboxCompact
					? 'width: 38px; height: 38px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
					: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
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

			append(item, $('span' + ThemeIcon.asCSSSelector(bc.icon), { style: 'font-size: 14px; opacity: 0.85; min-width: 16px; text-align: center;' }));
			if (!this._isToolboxCompact) {
				append(item, $('span', { style: 'font-size: 11.5px; flex: 1;' }, bc.label));
				const toolboxInfoBtn = append(item, $('span.toolbox-item-info-btn', {
					style: 'display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: rgba(56, 189, 248, 0.7); font-size: 11px; cursor: pointer; transition: all 0.15s ease;',
					title: `View ${bc.label} documentation & RUN_TICKETS guide`
				}));
				append(toolboxInfoBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
				toolboxInfoBtn.onmouseenter = () => {
					toolboxInfoBtn.style.color = '#38bdf8';
					toolboxInfoBtn.style.background = 'rgba(56, 189, 248, 0.18)';
				};
				toolboxInfoBtn.onmouseleave = () => {
					toolboxInfoBtn.style.color = 'rgba(56, 189, 248, 0.7)';
					toolboxInfoBtn.style.background = 'transparent';
				};
				toolboxInfoBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					showPrimitiveHelpModal(this._container!, bc.type, bc.label);
				};
			}

			item.onclick = () => {
				addFieldFromDef(bc);
			};
		});

		// Reusable Classes in Library
		const reusableSection = append(leftLibrary, $('.reusable-classes-section', {
			style: `display: flex; flex-direction: column; gap: 6px; margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 10px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
		}));
		if (!this._isToolboxCompact) {
			append(reusableSection, $('div', {
				style: 'font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #06b6d4;'
			}, `Reusable Classes (${compositeClasses.length})`));
		}

		if (compositeClasses.length === 0) {
			if (!this._isToolboxCompact) {
				append(reusableSection, $('div', {
					style: 'font-size: 10.5px; opacity: 0.45; font-style: italic; padding: 4px 0;'
				}, 'No classes saved yet. Add a Container to canvas and click "Save as Class Asset".'));
			}
		} else {
			const compList = append(reusableSection, $('.composite-classes-list', {
				style: `display: flex; flex-direction: column; gap: 6px; ${this._isToolboxCompact ? 'align-items: center;' : ''}`
			}));
			compositeClasses.forEach(cc => {
				const ccItem = append(compList, $('.primitive-item', {
					title: `Class: ${cc.name} (Drag or Click to Add)`,
					style: this._isToolboxCompact
						? 'width: 38px; height: 38px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease;'
						: 'padding: 7px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: grab; display: flex; align-items: center; gap: 8px; transition: all 0.15s ease;'
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

				append(ccItem, $('span' + ThemeIcon.asCSSSelector(Codicon.symbolClass), { style: 'color: #06b6d4; font-size: 13px; min-width: 16px; text-align: center;' }));
				if (!this._isToolboxCompact) {
					append(ccItem, $('span', { style: 'font-size: 11.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, cc.name));
					const ccInfoBtn = append(ccItem, $('span.toolbox-item-info-btn', {
						style: 'display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; color: rgba(6, 182, 212, 0.7); font-size: 11px; cursor: pointer; transition: all 0.15s ease;',
						title: `View Class ${cc.name} documentation & RUN_TICKETS guide`
					}));
					append(ccInfoBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
					ccInfoBtn.onmouseenter = () => {
						ccInfoBtn.style.color = '#06b6d4';
						ccInfoBtn.style.background = 'rgba(6, 182, 212, 0.18)';
					};
					ccInfoBtn.onmouseleave = () => {
						ccInfoBtn.style.color = 'rgba(6, 182, 212, 0.7)';
						ccInfoBtn.style.background = 'transparent';
					};
					ccInfoBtn.onclick = (e) => {
						e.stopPropagation();
						e.preventDefault();
						showPrimitiveHelpModal(this._container!, 'reusable_class', cc.name, cc.id);
					};
				}

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
					extractorService.extract([uri], { followRedirects: true, bypassCache: true }),
					new Promise<WebContentExtractResult[]>((_, reject) => setTimeout(() => reject(new Error('Extraction timed out')), 25000))
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

	private _extractJobsFromHtml(html: string): string {
		try {
			const seenIds = new Set<string>();
			const jobs: Array<{ jobId: string; title: string; company: string; location: string; link: string }> = [];

			// 1. Regex search for Voyager JobPosting entities in embedded JSON
			const entityRegex = /"entityUrn":"urn:li:(?:fsd_)?jobPosting:([0-9]+)"/g;
			let match: RegExpExecArray | null;
			while ((match = entityRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);

				const contextStart = Math.max(0, match.index - 500);
				const contextEnd = Math.min(html.length, match.index + 1500);
				const snippet = html.slice(contextStart, contextEnd);

				let title = '';
				const titleMatch = snippet.match(/"title":\{"text":"([^"]+)"\}|"title":"([^"]+)"/);
				if (titleMatch) {
					title = titleMatch[1] || titleMatch[2] || '';
				}

				let company = '';
				const compMatch = snippet.match(/"companyName":"([^"]+)"|"primaryDescription":\{"text":"([^"]+)"\}/);
				if (compMatch) {
					company = compMatch[1] || compMatch[2] || '';
				}

				let location = '';
				const locMatch = snippet.match(/"formattedLocation":"([^"]+)"|"secondaryDescription":\{"text":"([^"]+)"\}/);
				if (locMatch) {
					location = locMatch[1] || locMatch[2] || '';
				}

				jobs.push({
					jobId,
					title: title || 'Job Posting',
					company: company || 'Unknown Company',
					location: location || '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			// 2. Regex search for currentJobId or /jobs/view/ in HTML attributes
			const hrefRegex = /(?:currentJobId=|\/jobs\/view\/)([0-9]+)/g;
			while ((match = hrefRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);
				jobs.push({
					jobId,
					title: 'Job Posting',
					company: 'Unknown Company',
					location: '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			if (jobs.length === 0) {
				return '';
			}

			let md = `## Extracted Job Listings (${jobs.length} Jobs Found)\n\n`;
			md += `| # | Job ID | Job Title | Company | Location | Direct Link |\n`;
			md += `|---|---|---|---|---|---|\n`;
			for (let i = 0; i < jobs.length; i++) {
				const j = jobs[i];
				md += `| ${i + 1} | ${j.jobId} | ${j.title} | ${j.company} | ${j.location || '-'} | [${j.title}](${j.link}) |\n`;
			}
			md += `\n---\n\n`;
			return md;
		} catch {
			return '';
		}
	}

	private _cleanHtmlToText(html: string): string {
		try {
			const jobTable = this._extractJobsFromHtml(html);

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

			const mainText = lines.join('\n');
			return jobTable ? (jobTable + mainText) : mainText;
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

		statusEl.style.display = 'inline-block';
		statusEl.textContent = 'Fetching...';
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
			await this._persistCurrentModule();
			const charCount = result.content.length;
			statusEl.textContent = `Fetched (${charCount} chars)`;
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

	private async _executePromptTest(
		promptTextarea: HTMLTextAreaElement,
		statusEl: HTMLElement,
		outputEl: HTMLElement,
		field: ICustomField,
		allFields?: ICustomField[]
	): Promise<void> {
		const rawPrompt = promptTextarea.value.trim();
		if (!rawPrompt) {
			this.notificationService.warn('Please enter a prompt template before testing.');
			promptTextarea.focus();
			return;
		}

		// Interpolate referenced primitives ({Field Label} or @FieldLabel)
		let interpolatedPrompt = rawPrompt;
		if (allFields && allFields.length > 0) {
			for (const f of allFields) {
				if (!f || f.id === field.id) continue;
				const fLabel = f.label || f.id;
				let valToInsert = '';

				if (f.type === 'browser') {
					valToInsert = f.defaultContent || f.defaultUrl || '';
				} else if (f.type === 'parameters' && f.parameters) {
					const paramMap: Record<string, any> = {};
					f.parameters.forEach(p => {
						if (p.name) paramMap[p.name] = p.defaultValue ?? '';
					});
					valToInsert = JSON.stringify(paramMap);
				} else if (f.type === 'prompt') {
					valToInsert = f.debugPromptOutput || f.defaultContent || '';
				} else if (f.type === 'python') {
					valToInsert = f.pythonResult !== undefined
						? (typeof f.pythonResult === 'object' ? JSON.stringify(f.pythonResult, null, 2) : String(f.pythonResult))
						: (f.pythonOutput || f.pythonCode || '');
				} else if (f.type === 'git') {
					valToInsert = f.gitRemoteUrl || '';
				} else {
					valToInsert = f.defaultContent || '';
				}

				if (valToInsert) {
					const reBrace = new RegExp(`\\{\\s*${fLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}`, 'gi');
					const reAt = new RegExp(`@${fLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
					interpolatedPrompt = interpolatedPrompt.replace(reBrace, valToInsert).replace(reAt, valToInsert);
				}
			}
		}

		statusEl.style.display = 'inline-block';
		statusEl.textContent = 'Running...';
		statusEl.style.color = '#38bdf8';
		outputEl.textContent = 'Waiting for AI response...';

		const startTime = Date.now();
		try {
			const credService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (!credService || !credService.executePrompt) {
				throw new Error('AI Credential Service is not available');
			}

			let targetModel = field.targetModel || 'gemini-1.5-flash';
			let systemPrompt: string | undefined = undefined;

			if (field.targetMode === 'agent' && field.targetAgentId) {
				try {
					const agentsMgr = this._instantiationService.invokeFunction(accessor => {
						try { return accessor.get(IAgentsManagerService); } catch { return undefined; }
					});
					if (agentsMgr) {
						const ag = await agentsMgr.getAgent(field.targetAgentId);
						if (ag) {
							if (ag.modelName) targetModel = ag.modelName;
							systemPrompt = ag.systemPrompt || (ag.role ? `You are a helpful ${ag.role}.` : undefined);
						}
					}
				} catch { }
			}

			const res = await credService.executePrompt(targetModel, interpolatedPrompt, systemPrompt, field.targetProvider);
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

			if (res.success && res.text) {
				outputEl.textContent = res.text;
				field.debugPromptOutput = res.text;
				this._syncDraft();
				statusEl.textContent = `Done (${elapsedSec}s)`;
				statusEl.style.color = '#34d399';
				await this._persistCurrentModule();
			} else {
				const errMsg = res.error || 'Unknown AI response error';
				outputEl.textContent = `[AI Execution Error]\n${errMsg}`;
				statusEl.textContent = `Failed (${elapsedSec}s)`;
				statusEl.style.color = '#f87171';
			}
		} catch (err: any) {
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
			const errMsg = err?.message || String(err);
			outputEl.textContent = `[Prompt Test Failed]\n${errMsg}`;
			statusEl.textContent = `Error (${elapsedSec}s)`;
			statusEl.style.color = '#f87171';
		}
	}
}
