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
import { URI } from '../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDiagramsManagerService, IDiagramItem } from '../common/diagramsManager.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { DiagramEditorInput } from './diagramEditorInput.js';
import { createDiagramDialog } from './diagramEditorDialog.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { VIEW_ID } from '../../files/common/files.js';
import { dirname } from '../../../../base/common/resources.js';

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
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IViewsService private readonly viewsService: IViewsService,
		@IFileService private readonly fileService: IFileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.diagramsManagerService.onDidChangeDiagrams(() => {
			this.renderContent();
		}));

		this._register(this.editorService.onDidActiveEditorChange(() => {
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

	private async showInExplorer(resourceUri: URI): Promise<void> {
		try {
			const exists = await this.fileService.exists(resourceUri);
			if (!exists) {
				this.notificationService.warn(`Path does not exist: ${resourceUri.fsPath}`);
				return;
			}
			const stat = await this.fileService.resolve(resourceUri);
			const targetDir = stat.isDirectory ? resourceUri : dirname(resourceUri);

			const currentFolders = this.workspaceContextService.getWorkspace().folders;
			const isInside = currentFolders.some(f => this.uriIdentityService.extUri.isEqualOrParent(resourceUri, f.uri));

			if (!isInside) {
				await this.workspaceEditingService.addFolders([{ uri: targetDir }]);
			}

			await this.viewsService.openView(VIEW_ID, true);
			await this.commandService.executeCommand('revealInExplorer', resourceUri);
		} catch (err) {
			this.notificationService.error(`Failed to show in explorer: ${err}`);
		}
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

		const btnRow = append(toolbar, $('.diagrams-toolbar-buttons'));
		btnRow.style.display = 'flex';
		btnRow.style.gap = '6px';
		btnRow.style.width = '100%';

		const newBtn = append(btnRow, $('button.diagrams-new-btn'));
		newBtn.style.flex = '1';
		append(newBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
		append(newBtn, $('span')).textContent = 'New Diagram';
		newBtn.onclick = () => {
			createDiagramDialog(this.workspaceContextService, this.fileDialogService, this.pathService, async (result) => {
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

		const openFileBtn = append(btnRow, $('button.diagrams-new-btn.secondary'));
		openFileBtn.title = 'Open Existing Diagram File (.diagram.json)';
		openFileBtn.style.width = '34px';
		openFileBtn.style.padding = '0';
		openFileBtn.style.display = 'flex';
		openFileBtn.style.alignItems = 'center';
		openFileBtn.style.justifyContent = 'center';
		openFileBtn.style.background = 'rgba(255, 255, 255, 0.06)';
		openFileBtn.style.border = '1px solid rgba(255, 255, 255, 0.12)';
		append(openFileBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.folderOpened)));
		openFileBtn.onclick = async () => {
			const res = await this.fileDialogService.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: 'Diagrams', extensions: ['json'] }],
				title: 'Open Diagram File'
			});
			if (res && res.length > 0) {
				const fileUri = res[0];
				const name = fileUri.path.split('/').filter(Boolean).pop()?.replace(/\.diagram\.json$/, '').replace(/\.flowchart\.json$/, '').replace(/\.json$/, '') || 'Diagram';
				const editorInput = this.instantiationService.createInstance(DiagramEditorInput, fileUri, name);
				await this.editorService.openEditor(editorInput);
			}
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
			const emptyIcon = append(emptyEl, $('span' + ThemeIcon.asCSSSelector(Codicon.typeHierarchy)));
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
					createDiagramDialog(this.workspaceContextService, this.fileDialogService, this.pathService, async (result) => {
						const uri = await this.diagramsManagerService.createDiagram(result);
						const editorInput = this.instantiationService.createInstance(DiagramEditorInput, uri, result.name);
						await this.editorService.openEditor(editorInput);
					});
				};
			}
			return;
		}

		const activeEditor = this.editorService.activeEditor;
		const activeUriStr = (activeEditor instanceof DiagramEditorInput) ? activeEditor.resource.toString() : undefined;

		for (const diagram of filtered) {
			const itemEl = append(container, $('.diagram-card-item'));
			if (activeUriStr && diagram.uri.toString() === activeUriStr) {
				itemEl.classList.add('active');
			}

			itemEl.onclick = async () => {
				const editorInput = this.instantiationService.createInstance(DiagramEditorInput, diagram.uri, diagram.name);
				await this.editorService.openEditor(editorInput);
			};

			const iconEl = append(itemEl, $('.diagram-card-icon'));
			append(iconEl, $('span' + ThemeIcon.asCSSSelector(Codicon.typeHierarchy)));

			const infoEl = append(itemEl, $('.diagram-card-info'));
			const titleRow = append(infoEl, $('.diagram-card-title-row'));
			const nameEl = append(titleRow, $('.diagram-card-title'));
			nameEl.textContent = diagram.name;
			nameEl.title = diagram.name;

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
							id: 'show_in_explorer',
							label: 'Show in Explorer',
							tooltip: '',
							class: undefined,
							enabled: true,
							checked: false,
							run: async () => {
								await this.showInExplorer(diagram.uri);
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
