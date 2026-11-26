/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/workflowsManager.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService, IView } from '../../../common/views.js';
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
			if (this.isBodyVisible() && this.containerEl) {
				this.renderContent();
			} else {
				this.updatePaneTitle();
			}
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.workflowsManagerService.notifyPaneExpanded(this.id);
				this.renderContent();
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

	private getTargetScope(): 'all' | 'workspace' | 'independent' {
		if (this.id.endsWith('.workspace')) {
			return 'workspace';
		}
		if (this.id.endsWith('.independent')) {
			return 'independent';
		}
		return 'all';
	}

	private isIndependentWorkflow(w: IWorkflowItem): boolean {
		const wsUriLower = (w.belongsToWorkspaceUri || '').toLowerCase();
		const idLower = (w.id || '').toLowerCase();
		if (idLower.includes('/documents/workflows/') || wsUriLower.endsWith('/documents/workflows') || wsUriLower.endsWith('/repos/jobs')) {
			return true;
		}
		if (!w.belongsToWorkspaceUri || w.belongsToWorkspaceName === 'Independent') {
			return true;
		}
		return false;
	}

	private async updatePaneTitle(): Promise<void> {
		const all = await this.workflowsManagerService.getWorkflows();
		const targetScope = this.getTargetScope();

		let list = all;
		if (targetScope === 'workspace') {
			list = all.filter(w => !this.isIndependentWorkflow(w));
		} else if (targetScope === 'independent') {
			list = all.filter(w => this.isIndependentWorkflow(w));
		}

		const baseName = targetScope === 'workspace'
			? 'Workspace Workflows'
			: targetScope === 'independent'
				? 'Independent Workflows'
				: 'All Workflows';
		this.updateTitle(`${baseName} (${list.length})`);
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const currentVersion = ++this.renderVersion;
		const all = await this.workflowsManagerService.getWorkflows();
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		clearNode(this.containerEl);

		const targetScope = this.getTargetScope();
		let scoped = all;

		if (targetScope === 'workspace') {
			scoped = all.filter(w => !this.isIndependentWorkflow(w));
		} else if (targetScope === 'independent') {
			scoped = all.filter(w => this.isIndependentWorkflow(w));
		}

		// Update Title synchronously with scoped items
		const baseName = targetScope === 'workspace'
			? 'Workspace Workflows'
			: targetScope === 'independent'
				? 'Independent Workflows'
				: 'All Workflows';
		this.updateTitle(`${baseName} (${scoped.length})`);

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
			if (workflow.isMissing) {
				this.notificationService.warn(`Workflow '${workflow.name}' cannot be opened: folder not found on disk.`);
				return;
			}
			const folderUri = URI.parse(workflow.id);
			await this.editorService.openEditor(new WorkflowEditorInput(folderUri, workflow.name), { pinned: true });
		};

		// Header
		const header = append(card, $('.card-header'));
		const left = append(header, $('.card-left'));

		const icon = append(left, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
		icon.style.fontSize = '13px';
		icon.style.color = workflow.isMissing ? '#ef4444' : '#0d9488';

		const title = append(left, $('.card-title'));
		const displayTitle = workflow.title || workflow.name;
		const displayTicketId = workflow.ticketId || workflow.name;
		title.textContent = displayTitle;
		title.title = `${displayTitle} [${displayTicketId} · WORKFLOW]`;

		// Header Actions
		const cardActions = append(header, $('.card-actions'));

		const idBadge = append(cardActions, $('span', {
			style: 'font-size: 8px; padding: 1px 5px; border-radius: 3px; background: rgba(13, 148, 136, 0.2); color: #0d9488; font-weight: 600; text-transform: uppercase; margin-right: 4px;'
		}, displayTicketId));
		idBadge.title = `Ticket ID: ${displayTicketId} · Type: WORKFLOW`;

		if (workflow.isMissing) {
			const removeBtn = append(cardActions, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
			removeBtn.style.fontSize = '12px';
			removeBtn.style.color = '#f43f5e';
			removeBtn.style.cursor = 'pointer';
			removeBtn.style.opacity = '0.9';
			removeBtn.title = 'Remove Missing Workflow from List';
			removeBtn.onclick = async (e) => {
				e.stopPropagation();
				const confirm = await this.dialogService.confirm({
					type: 'warning',
					message: `Remove missing workflow '${workflow.name}'?`,
					detail: `The physical folder for this workflow no longer exists on disk. This action will remove its record from your workflows list.`,
					primaryButton: 'Remove'
				});
				if (confirm.confirmed) {
					const folderUri = URI.parse(workflow.id);
					await this.workflowsManagerService.removeSavedWorkflow(folderUri);
					await this.entityPersistenceService.removeSnapshot(folderUri);
					this.notificationService.info(`Workflow '${workflow.name}' removed from list.`);
				}
			};
		} else {
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
		}

		// Right Click Context Menu for secondary actions
		card.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();

			const folderUri = URI.parse(workflow.id);
			const actionsList: Action[] = [];

			if (workflow.isMissing) {
				actionsList.push(new Action('remove_missing_workflow', 'Remove Missing Workflow from List (\uD83D\uDDD1️)', ThemeIcon.asClassName(Codicon.trash), true, async () => {
					const confirm = await this.dialogService.confirm({
						type: 'warning',
						message: `Remove missing workflow '${workflow.name}'?`,
						detail: `The physical folder for this workflow no longer exists on disk. This action will remove its record from your workflows list.`,
						primaryButton: 'Remove'
					});
					if (confirm.confirmed) {
						await this.workflowsManagerService.removeSavedWorkflow(folderUri);
						await this.entityPersistenceService.removeSnapshot(folderUri);
						this.notificationService.info(`Workflow '${workflow.name}' removed from list.`);
					}
				}));
			} else {
				// 1. Open Flowchart Editor
				actionsList.push(new Action('open_workflow', 'Open Flowchart Editor', ThemeIcon.asClassName(Codicon.folderOpened), true, async () => {
					await this.editorService.openEditor(new WorkflowEditorInput(folderUri, workflow.name), { pinned: true });
				}));

				// 2. Create Sub-Entity...
				actionsList.push(new Action('create_sub_entity', 'Create Sub-Entity...', ThemeIcon.asClassName(Codicon.add), true, async () => {
					interface IWorkspacesExplorerView extends IView {
						showCreateResourceModal?(target: URI, name: string): void;
					}
					const workspacesView = await this.viewsService.openView<IWorkspacesExplorerView>('workbench.workspacesExplorer.mainPane', true);
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
							await this.workflowsManagerService.removeSavedWorkflow(folderUri);
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
			}

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
			desc.textContent = `⚠️ Files missing on disk. Click \uD83D\uDDD1️ to remove record.`;
		}

		// Footer Row
		const footer = append(card, $('.card-footer'));
		const workspaceBadge = append(footer, $('.workspace-badge'));
		let wsName = workflow.belongsToWorkspaceName || 'Workspace';
		if (this.isIndependentWorkflow(workflow)) {
			wsName = 'Independent';
		}
		workspaceBadge.textContent = wsName;
		workspaceBadge.title = `Belongs to: ${wsName}`;
	}

	private async createNewWorkflow(): Promise<void> {
		const defaultUri = this.getTargetScope() === 'independent' ? URI.file('/Users/aimery/Documents/workflows') : undefined;
		this.instantiationService.invokeFunction(accessor => createWorkflowDialog(accessor, defaultUri));
	}
}
