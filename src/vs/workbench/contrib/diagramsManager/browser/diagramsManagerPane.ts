/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/diagramsManager.css';
import * as DOM from '../../../../base/browser/dom.js';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDiagramsManagerService, IDiagramItem } from '../common/diagramsManager.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { DiagramEditorInput } from './diagramEditorInput.js';
import { createDiagramDialog } from './diagramEditorDialog.js';

export class DiagramsManagerPane extends ViewPane {
	private containerEl?: HTMLElement;
	private filterText = '';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IDiagramsManagerService private readonly diagramsManagerService: IDiagramsManagerService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.diagramsManagerService.onDidChangeDiagrams(() => {
			this.renderContent();
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.diagramsManagerService.notifyPaneExpanded(this.id);
			}
		}));

		this._register(this.diagramsManagerService.onDidExpandPane(expandedId => {
			if (expandedId === this.id) {
				if (!this.isExpanded()) {
					this.setExpanded(true);
				}
			} else if (this.isExpanded()) {
				this.setExpanded(false);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('diagrams-manager-viewpane');

		this.containerEl = append(container, $('.diagrams-manager-main-container'));
		this.renderContent();
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) return;
		clearNode(this.containerEl);

		// 1. Top Action Toolbar: Filter + New Diagram
		const toolbar = append(this.containerEl, $('.diagrams-toolbar'));

		const searchBox = append(toolbar, $('.diagrams-search-box'));
		const searchIcon = append(searchBox, $('span' + ThemeIcon.asCSSSelector(Codicon.search)));
		searchIcon.style.opacity = '0.6';

		const input = append(searchBox, $('input.diagrams-search-input')) as HTMLInputElement;
		input.placeholder = 'Search diagrams...';
		input.value = this.filterText;
		input.oninput = () => {
			this.filterText = input.value.trim().toLowerCase();
			this.renderList(listContainer, allDiagrams);
		};

		const newBtn = append(toolbar, $('button.diagrams-new-btn'));
		append(newBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
		append(newBtn, $('span')).textContent = 'New Diagram';
		newBtn.onclick = () => {
			createDiagramDialog(this.workspaceContextService, async (result) => {
				try {
					const uri = await this.diagramsManagerService.createDiagram(result);
					const editorInput = this.instantiationService.createInstance(DiagramEditorInput, uri, result.name);
					await this.editorService.openEditor(editorInput);
					this.notificationService.info(`Created diagram '${result.name}'`);
				} catch (err) {
					this.notificationService.error(`Failed to create diagram: ${err}`);
				}
			});
		};

		// 2. Diagrams List Container
		const listContainer = append(this.containerEl, $('.diagrams-list-container'));
		const allDiagrams = await this.diagramsManagerService.getDiagrams();
		this.renderList(listContainer, allDiagrams);
	}

	private renderList(container: HTMLElement, allDiagrams: IDiagramItem[]): void {
		clearNode(container);

		let filtered = allDiagrams;
		if (this.filterText) {
			filtered = allDiagrams.filter(d =>
				d.name.toLowerCase().includes(this.filterText) ||
				(d.description && d.description.toLowerCase().includes(this.filterText)) ||
				(d.belongsToWorkspaceName && d.belongsToWorkspaceName.toLowerCase().includes(this.filterText))
			);
		}

		if (filtered.length === 0) {
			const emptyEl = append(container, $('.diagrams-empty-state'));
			const emptyIcon = append(emptyEl, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));
			emptyIcon.style.fontSize = '32px';
			emptyIcon.style.opacity = '0.4';
			emptyIcon.style.marginBottom = '8px';

			const emptyText = append(emptyEl, $('.empty-text'));
			emptyText.textContent = this.filterText ? 'No diagrams matching search' : 'No diagrams created yet';

			if (!this.filterText) {
				const createFirstBtn = append(emptyEl, $('button.vscode-button'));
				createFirstBtn.style.marginTop = '12px';
				createFirstBtn.textContent = 'Create First Diagram';
				createFirstBtn.onclick = () => {
					createDiagramDialog(this.workspaceContextService, async (result) => {
						const uri = await this.diagramsManagerService.createDiagram(result);
						const editorInput = this.instantiationService.createInstance(DiagramEditorInput, uri, result.name);
						await this.editorService.openEditor(editorInput);
					});
				};
			}
			return;
		}

		for (const diagram of filtered) {
			const itemEl = append(container, $('.diagram-card-item'));
			itemEl.onclick = async () => {
				const editorInput = this.instantiationService.createInstance(DiagramEditorInput, diagram.uri, diagram.name);
				await this.editorService.openEditor(editorInput);
			};

			const iconEl = append(itemEl, $('.diagram-card-icon'));
			append(iconEl, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));

			const infoEl = append(itemEl, $('.diagram-card-info'));
			const titleRow = append(infoEl, $('.diagram-card-title-row'));
			const nameEl = append(titleRow, $('.diagram-card-title'));
			nameEl.textContent = diagram.name;
			nameEl.title = diagram.name;

			if (diagram.belongsToWorkspaceName) {
				const badge = append(titleRow, $('.diagram-card-badge'));
				badge.textContent = diagram.belongsToWorkspaceName;
			}

			if (diagram.description) {
				const descEl = append(infoEl, $('.diagram-card-desc'));
				descEl.textContent = diagram.description;
				descEl.title = diagram.description;
			}

			// Hover action buttons
			const actionsEl = append(itemEl, $('.diagram-card-actions'));

			const deleteBtn = append(actionsEl, $('.action-btn'));
			append(deleteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
			deleteBtn.title = 'Delete Diagram';
			deleteBtn.onclick = async (e) => {
				e.stopPropagation();
				const confirm = await this.dialogService.confirm({
					message: `Are you sure you want to delete diagram '${diagram.name}'?`,
					type: 'warning',
					primaryButton: 'Delete'
				});
				if (confirm.confirmed) {
					await this.diagramsManagerService.deleteDiagram(diagram.uri);
					this.notificationService.info(`Deleted diagram '${diagram.name}'`);
				}
			};

			// Context Menu
			itemEl.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.contextMenuService.showContextMenu({
					getAnchor: () => new StandardMouseEvent(DOM.getWindow(itemEl), e),
					getActions: () => [
						{
							id: 'open',
							label: 'Open Diagram',
							tooltip: '',
							class: undefined,
							enabled: true,
							checked: false,
							run: async () => {
								const editorInput = this.instantiationService.createInstance(DiagramEditorInput, diagram.uri, diagram.name);
								await this.editorService.openEditor(editorInput);
							}
						},
						{
							id: 'reveal',
							label: 'Reveal in Explorer View',
							tooltip: '',
							class: undefined,
							enabled: true,
							checked: false,
							run: async () => {
								await this.commandService.executeCommand('revealInExplorer', diagram.uri);
							}
						},
						{
							id: 'delete',
							label: 'Delete Diagram',
							tooltip: '',
							class: undefined,
							enabled: true,
							checked: false,
							run: async () => {
								const confirm = await this.dialogService.confirm({
									message: `Are you sure you want to delete diagram '${diagram.name}'?`,
									type: 'warning',
									primaryButton: 'Delete'
								});
								if (confirm.confirmed) {
									await this.diagramsManagerService.deleteDiagram(diagram.uri);
									this.notificationService.info(`Deleted diagram '${diagram.name}'`);
								}
							}
						}
					]
				});
			};
		}
	}
}
