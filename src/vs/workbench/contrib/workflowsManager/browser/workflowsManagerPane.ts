/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workflowsManager.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
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
import { Action } from '../../../../base/common/actions.js';

import { IWorkflowsManagerService, IWorkflowItem } from '../common/workflowsManager.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { dirname } from '../../../../base/common/resources.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';
import { createWorkflowDialog } from './workflowEditorDialog.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { VIEW_ID } from '../../files/common/files.js';

export class WorkflowsManagerPane extends ViewPane {
	private containerEl?: HTMLElement;
	private renderVersion = 0;
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
		@IWorkflowsManagerService private readonly workflowsManagerService: IWorkflowsManagerService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileService private readonly fileService: IFileService,
		@IViewsService private readonly viewsService: IViewsService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.workflowsManagerService.onDidChangeWorkflows(() => {
			this.updatePaneTitle();
			this.renderContent();
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.workflowsManagerService.notifyPaneExpanded(this.id);
			}
		}));

		this._register(this.workflowsManagerService.onDidExpandPane(expandedId => {
			if (expandedId === this.id) {
				if (!this.isExpanded()) {
					this.setExpanded(true);
				}
			} else if (this.isExpanded()) {
				this.setExpanded(false);
			}
		}));

		this.updatePaneTitle();
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

	protected override renderHeaderTitle(container: HTMLElement, title: string): void {
		super.renderHeaderTitle(container, title);
		this.updatePaneTitle();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('workflows-manager-viewpane');

		this.containerEl = append(container, $('.workflows-manager-main-container'));
		this.renderContent();
	}

	private getTargetScope(): 'all' | 'workspace' {
		if (this.id.endsWith('.workspace')) {
			return 'workspace';
		}
		return 'all';
	}

	private async updatePaneTitle(): Promise<void> {
		const all = await this.workflowsManagerService.getWorkflows();
		const targetScope = this.getTargetScope();

		let list = all;
		if (targetScope === 'workspace') {
			const activeFolder = this.workspaceContextService.getWorkspace().folders[0];
			if (activeFolder) {
				list = all.filter(w => w.belongsToWorkspaceUri && w.belongsToWorkspaceUri.toLowerCase() === activeFolder.uri.toString().toLowerCase());
			} else {
				list = [];
			}
		}

		const baseName = targetScope === 'workspace' ? 'Workspace Workflows' : 'All Workflows';
		this.updateTitle(`${baseName} (${list.length})`);
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const currentVersion = ++this.renderVersion;
		clearNode(this.containerEl);

		const all = await this.workflowsManagerService.getWorkflows();
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		const targetScope = this.getTargetScope();
		let scoped = all;
		const activeFolder = this.workspaceContextService.getWorkspace().folders[0];

		if (targetScope === 'workspace') {
			if (activeFolder) {
				const activeUriStr = activeFolder.uri.toString().toLowerCase();
				scoped = all.filter(w => w.belongsToWorkspaceUri && w.belongsToWorkspaceUri.toLowerCase() === activeUriStr);
			} else {
				scoped = [];
			}
		}

		// Update Title
		this.updatePaneTitle();

		// Search Filter
		const filtered = scoped.filter(w => {
			if (!this.filterText) {
				return true;
			}
			return w.name.toLowerCase().includes(this.filterText) ||
				(w.description && w.description.toLowerCase().includes(this.filterText)) ||
				(w.belongsToWorkspaceName && w.belongsToWorkspaceName.toLowerCase().includes(this.filterText));
		});

		// 1. Filter Row
		const filterRow = append(this.containerEl, $('.workflows-filter-row'));
		const filterInput = append(filterRow, $('input.filter-input')) as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.placeholder = `Search workflows by name or description...`;
		filterInput.value = this.filterText;

		filterInput.oninput = () => {
			this.filterText = filterInput.value.toLowerCase().trim();
			this.renderContent();
		};

		// 2. List Body
		const listBody = append(this.containerEl, $('.workflows-list-body'));

		if (filtered.length === 0) {
			const placeholder = append(listBody, $('.workflows-empty-placeholder'));
			
			const icon = append(placeholder, $('.placeholder-icon' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
			icon.style.color = '#0d9488';
			
			const text = append(placeholder, $('.placeholder-text'));
			text.textContent = this.filterText ? 'No matching workflows found.' : 'No workflows configured yet.';

			const createBtn = append(placeholder, $('button.monaco-button', {
				style: 'padding: 4px 10px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(13, 148, 136, 0.15); border: 1px solid rgba(13, 148, 136, 0.35); color: #0d9488; font-weight: 600;'
			}));
			createBtn.innerText = '+ Create Workflow';
			createBtn.onclick = () => this.createNewWorkflow();
			return;
		}

		for (const workflow of filtered) {
			this.renderWorkflowCard(listBody, workflow);
		}
	}

	private renderWorkflowCard(parent: HTMLElement, workflow: IWorkflowItem): void {
		const card = append(parent, $('.workflow-item-card'));

		let isDraggable = !workflow.isMissing;
		const activeInput = this.editorService.activeEditor;
		if (activeInput instanceof WorkflowEditorInput) {
			const activeWorkflowUriStr = activeInput.workflowUri.toString().toLowerCase();
			if (workflow.id.toLowerCase() === activeWorkflowUriStr) {
				isDraggable = false;
			}
		}

		if (isDraggable) {
			card.draggable = true;
			card.ondragstart = (e) => {
				e.stopPropagation();
				if (e.dataTransfer) {
					e.dataTransfer.setData('text/plain', `any-agent-import:workflow:${workflow.name}`);
					e.dataTransfer.effectAllowed = 'copy';
				}
				card.style.opacity = '0.5';
			};
			card.ondragend = () => {
				card.style.opacity = '1';
			};
		}

		card.style.cursor = 'pointer';
		card.onclick = async () => {
			const folderUri = URI.parse(workflow.id);
			await this.editorService.openEditor(new WorkflowEditorInput(folderUri, workflow.name), { pinned: true });
		};

		// Header
		const header = append(card, $('.card-header'));
		const left = append(header, $('.card-left'));

		const icon = append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
		icon.style.fontSize = '13px';
		icon.style.color = '#0d9488';

		const title = append(left, $('.card-title'));
		title.textContent = workflow.name;

		// Header Actions (Play/Run button)
		const cardActions = append(header, $('.card-actions'));

		const runBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.play)));
		runBtn.style.fontSize = '12px';
		runBtn.style.color = '#22c55e';
		runBtn.style.cursor = 'pointer';
		runBtn.style.opacity = '0.85';
		runBtn.title = 'Run Workflow';
		runBtn.onclick = (e) => {
			e.stopPropagation();
			this.notificationService.info(`Workflow '${workflow.name}' run started successfully!`);
		};

		// Right Click Context Menu for secondary actions
		card.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();

			const folderUri = URI.parse(workflow.id);
			const actionsList: Action[] = [];

			// 1. Open Flowchart Editor
			actionsList.push(new Action('open_workflow', 'Open Flowchart Editor', ThemeIcon.asClassName(Codicon.folderOpened), true, async () => {
				await this.editorService.openEditor(new WorkflowEditorInput(folderUri, workflow.name), { pinned: true });
			}));

			// 2. Create Sub-Entity...
			actionsList.push(new Action('create_sub_entity', 'Create Sub-Entity...', ThemeIcon.asClassName(Codicon.add), true, async () => {
				const workspacesView = await this.viewsService.openView<any>('workbench.workspacesExplorer.mainPane', true);
				if (workspacesView && typeof workspacesView.showCreateResourceModal === 'function') {
					workspacesView.showCreateResourceModal(folderUri, workflow.name);
				}
			}));

			// 3. Show in Explorer & Reveal in OS
			actionsList.push(new Action('show_in_explorer', 'Show in Explorer', ThemeIcon.asClassName(Codicon.folderLibrary), true, async () => {
				await this.showInExplorer(folderUri);
			}));
			actionsList.push(new Action('reveal_in_os', isMacintosh ? 'Reveal in Finder' : 'Reveal in Explorer', ThemeIcon.asClassName(Codicon.folder), true, async () => {
				try {
					await this.commandService.executeCommand('revealFileInOS', folderUri);
				} catch {
					this.notificationService.warn(`Path does not exist: ${folderUri.fsPath}`);
				}
			}));

			// 4. Remove from Workflows
			actionsList.push(new Action('remove_from_workflows', 'Remove from Workflows', ThemeIcon.asClassName(Codicon.close), true, async () => {
				const confirm = await this.dialogService.confirm({
					type: 'warning',
					message: `Are you sure you want to remove '${workflow.name}' from workflows?`,
					detail: `This will keep the physical folder intact but rename it to '~${workflow.name}', making it ignored in the explorer and workflows list.`,
					primaryButton: 'Remove from Workflows'
				});
				if (confirm.confirmed) {
					try {
						const parentDir = dirname(folderUri);
						const newName = '~' + workflow.name;
						const newUri = URI.joinPath(parentDir, newName);

						if (await this.fileService.exists(folderUri)) {
							await this.fileService.move(folderUri, newUri, true);
						}
						await this.entityPersistenceService.removeSnapshot(folderUri);
						this.notificationService.info(`Removed '${workflow.name}' from workflows.`);
					} catch (err) {
						this.notificationService.error(`Failed to remove from workflows: ${err}`);
					}
				}
			}));

			// 5. Move to Trash...
			actionsList.push(new Action('move_to_trash', 'Move to Trash...', ThemeIcon.asClassName(Codicon.trash), true, async () => {
				const confirm = await this.dialogService.confirm({
					type: 'warning',
					message: `Are you sure you want to move '${workflow.name}' to trash?`,
					detail: `This will move '${folderUri.fsPath}' to OS Trash if it exists on disk.`,
					primaryButton: 'Move to Trash'
				});
				if (confirm.confirmed) {
					try {
						await this.workflowsManagerService.deleteWorkflow(workflow.id);
						this.notificationService.info(`Moved '${workflow.name}' to trash.`);
					} catch (err) {
						this.notificationService.error(`Failed to delete workflow: ${err}`);
					}
				}
			}));

			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: e.clientX, y: e.clientY }),
				getActions: () => actionsList
			});
		};

		// Description
		if (workflow.description && workflow.description !== 'workspace Agent') {
			const desc = append(card, $('.card-description'));
			desc.textContent = workflow.description;
		} else if (workflow.isMissing) {
			const desc = append(card, $('.card-description', { style: 'color: #f43f5e; font-weight: 500;' }));
			desc.textContent = `⚠️ Files missing or damaged. Click Repair (🛠️) to restore.`;
		}

		// Footer Row
		const footer = append(card, $('.card-footer'));
		const workspaceBadge = append(footer, $('.workspace-badge'));
		let wsName = workflow.belongsToWorkspaceName || 'Workspace';
		if (!workflow.belongsToWorkspaceUri || workflow.belongsToWorkspaceUri.toLowerCase().endsWith('/repos/jobs')) {
			wsName = 'Independent';
		}
		workspaceBadge.textContent = wsName;
		workspaceBadge.title = `Belongs to: ${wsName}`;
	}

	private async createNewWorkflow(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const targetFolderUri = folders[0]?.uri;
		this.instantiationService.invokeFunction(accessor => createWorkflowDialog(accessor, targetFolderUri));
	}
}
