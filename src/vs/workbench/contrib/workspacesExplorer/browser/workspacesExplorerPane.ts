/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Action } from '../../../../base/common/actions.js';
import { IWorkspacesExplorerService, ResourceType, IWorkspaceItem } from '../common/workspacesExplorer.js';

export class MainWorkspaceViewPane extends ViewPane {
	private containerEl?: HTMLElement;
	private renderVersion = 0;
	private expandedWorkspaces = new Set<string>();
	private hasInitializedExpansion = false;
	private filterText = '';
	private selectedWorkspaceId?: string;
	private selectedItemId?: string;
	private targetSelectedElement?: HTMLElement;

	private getCanonicalId(target: string | URI): string {
		const str = typeof target === 'string' ? target : target.toString();
		try {
			if (str.startsWith('file://')) {
				return URI.parse(str).fsPath.toLowerCase();
			}
			return str.toLowerCase();
		} catch {
			return str.toLowerCase();
		}
	}

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
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(() => this.renderContent()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.renderContent()));
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this.renderContent()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.containerEl = append(container, $('.workspace-main-pane'));
		this.containerEl.style.padding = '10px 12px';
		this.containerEl.style.fontSize = '12px';
		this.containerEl.style.color = 'var(--vscode-sideBar-foreground, #cccccc)';
		this.containerEl.style.display = 'flex';
		this.containerEl.style.flexDirection = 'column';
		this.containerEl.style.gap = '10px';
		this.containerEl.style.height = '100%';
		this.containerEl.style.boxSizing = 'border-box';
		this.containerEl.style.position = 'relative';
		this.containerEl.style.overflow = 'hidden';

		// Inject VS Code native scrollbar styling
		const styleEl = append(this.containerEl, $('style'));
		styleEl.textContent = `
			.workspace-main-pane ::-webkit-scrollbar {
				width: 6px;
				height: 6px;
			}
			.workspace-main-pane ::-webkit-scrollbar-thumb {
				background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.3));
				border-radius: 3px;
			}
			.workspace-main-pane ::-webkit-scrollbar-thumb:hover {
				background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.6));
			}
			.workspace-main-pane ::-webkit-scrollbar-thumb:active {
				background: var(--vscode-scrollbarSlider-activeBackground, rgba(140, 140, 140, 0.8));
			}
			.workspace-main-pane ::-webkit-scrollbar-track {
				background: transparent;
			}
		`;

		this.renderContent();
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		const existingTreeBox = this.containerEl.querySelector('.tree-box') as HTMLElement | null;
		const savedScrollTop = existingTreeBox ? existingTreeBox.scrollTop : 0;

		const currentVersion = ++this.renderVersion;
		clearNode(this.containerEl);

		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		// Initial expansion setup: Default expand active workspace once
		if (!this.hasInitializedExpansion) {
			for (const ws of workspaces) {
				if (ws.isCurrent) {
					this.expandedWorkspaces.add(this.getCanonicalId(ws.id));
				}
			}
			this.hasInitializedExpansion = true;
		}

		// --- 1. Header Row ---
		const headerRow = append(this.containerEl, $('.main-header-row'));
		headerRow.style.display = 'flex';
		headerRow.style.alignItems = 'center';
		headerRow.style.justifyContent = 'space-between';
		headerRow.style.marginBottom = '2px';
		headerRow.style.flexShrink = '0';

		const titleLeft = append(headerRow, $('.title-left'));
		titleLeft.style.display = 'flex';
		titleLeft.style.alignItems = 'center';
		titleLeft.style.gap = '6px';
		titleLeft.style.fontWeight = '600';
		titleLeft.style.color = '#38bdf8';
		titleLeft.style.fontSize = '12px';

		append(titleLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
		append(titleLeft, $('span', {}, 'Managed Workspaces'));

		const addWsIcon = append(headerRow, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		addWsIcon.style.cursor = 'pointer';
		addWsIcon.style.opacity = '0.85';
		addWsIcon.title = 'Create or Add Workspace...';
		addWsIcon.onclick = () => {
			this.showCreateWorkspaceModal();
		};

		// --- 2. Filter input box ---
		const filterInput = append(this.containerEl, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; flex-shrink: 0;'
		})) as HTMLInputElement;
		filterInput.placeholder = 'Filter workspaces, jobs, projects, tasks & agents...';
		filterInput.value = this.filterText;
		filterInput.oninput = () => {
			this.filterText = filterInput.value.toLowerCase().trim();
			this.renderContent();
		};

		// --- 3. Workspace Multi-Tree List ---
		const treeBox = append(this.containerEl, $('.tree-box'));
		treeBox.style.flex = '1';
		treeBox.style.overflowY = 'auto';
		treeBox.style.display = 'flex';
		treeBox.style.flexDirection = 'column';
		treeBox.style.gap = '6px';
		treeBox.style.minHeight = '0';
		treeBox.style.paddingRight = '2px';

		const filteredWorkspaces = workspaces.filter(w => !this.filterText || w.name.toLowerCase().includes(this.filterText) || w.uri.fsPath.toLowerCase().includes(this.filterText));

		if (!this.selectedWorkspaceId && filteredWorkspaces.length > 0) {
			this.selectedWorkspaceId = this.getCanonicalId(filteredWorkspaces[0].id);
		}

		this.targetSelectedElement = undefined;

		if (filteredWorkspaces.length === 0) {
			append(treeBox, $('div', { style: 'font-size: 11px; opacity: 0.5; padding: 10px 0; text-align: center;' }, 'No workspaces added yet.'));
		} else {
			for (const ws of filteredWorkspaces) {
				const canonicalWsId = this.getCanonicalId(ws.id);
				const wsCard = append(treeBox, $('.workspace-item-card'));
				wsCard.style.borderRadius = '6px';
				wsCard.style.flexShrink = '0';

				const isWorkspaceSelected = this.selectedWorkspaceId === canonicalWsId;

				// Handle missing / corrupted workspace card styling (clean Red Border + subtle Red Tint)
				if (ws.isMissing) {
					wsCard.style.backgroundColor = isWorkspaceSelected ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.08)';
					wsCard.style.border = isWorkspaceSelected ? '1px solid rgba(239, 68, 68, 0.8)' : '1px solid rgba(239, 68, 68, 0.45)';
				} else if (isWorkspaceSelected) {
					wsCard.style.backgroundColor = 'rgba(56, 189, 248, 0.12)';
					wsCard.style.border = '1px solid #38bdf8';
				} else {
					wsCard.style.backgroundColor = 'rgba(255, 255, 255, 0.03)';
					wsCard.style.border = '1px solid rgba(255, 255, 255, 0.07)';
				}
				wsCard.style.overflow = 'hidden';

				wsCard.draggable = true;

				wsCard.ondragstart = (e) => {
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.setData('text/plain', ws.id);
						e.dataTransfer.effectAllowed = 'move';
					}
					wsCard.style.opacity = '0.5';
				};

				wsCard.ondragend = () => {
					wsCard.style.opacity = '1';
					wsCard.style.borderTop = '';
					wsCard.style.borderBottom = '';
				};

				wsCard.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.dropEffect = 'move';
					}
					const rect = wsCard.getBoundingClientRect();
					const offset = e.clientY - rect.top;
					if (offset < rect.height / 2) {
						wsCard.style.borderTop = '2px solid #38bdf8';
						wsCard.style.borderBottom = '';
					} else {
						wsCard.style.borderBottom = '2px solid #38bdf8';
						wsCard.style.borderTop = '';
					}
				};

				wsCard.ondragleave = () => {
					wsCard.style.borderTop = '';
					wsCard.style.borderBottom = '';
				};

				wsCard.ondrop = async (e) => {
					e.preventDefault();
					e.stopPropagation();
					wsCard.style.borderTop = '';
					wsCard.style.borderBottom = '';

					const sourceId = e.dataTransfer?.getData('text/plain');
					if (sourceId && sourceId !== ws.id) {
						await this.workspacesExplorerService.reorderWorkspaces(sourceId, ws.id);
						this.renderContent();
					}
				};

				const isExpanded = this.expandedWorkspaces.has(canonicalWsId);

				// Card Header
				const cardHeader = append(wsCard, $('.card-header-row'));
				cardHeader.style.display = 'flex';
				cardHeader.style.alignItems = 'center';
				cardHeader.style.justifyContent = 'space-between';
				cardHeader.style.padding = '6px 8px';
				cardHeader.style.cursor = 'pointer';
				cardHeader.title = ws.isMissing ? `Warning: ${ws.missingReason || 'workspace.md is missing'} (Right click for menu)` : `${ws.name} - ${ws.uri.fsPath} (Right click for menu, drag to reorder, double click to open in window)`;
				cardHeader.onmouseenter = () => cardHeader.style.backgroundColor = 'rgba(255, 255, 255, 0.04)';
				cardHeader.onmouseleave = () => cardHeader.style.backgroundColor = 'transparent';

				if (isWorkspaceSelected && !this.selectedItemId) {
					this.targetSelectedElement = cardHeader;
				}

				// Native VS Code Context Menu on Right Click
				cardHeader.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();

					const actions = [
						new Action('reveal_in_os', isMacintosh ? 'Reveal in Finder' : 'Reveal in Explorer', ThemeIcon.asClassName(Codicon.folder), true, async () => {
							try {
								await this.commandService.executeCommand('revealFileInOS', ws.uri);
							} catch {
								this.notificationService.warn(`Path does not exist: ${ws.uri.fsPath}`);
							}
						}),
						new Action('reinitialize_ws', 'Re-initialize Workspace', ThemeIcon.asClassName(Codicon.tools), true, async () => {
							await this.workspacesExplorerService.reinitializeWorkspaceMd(ws.uri);
							this.notificationService.info(`Re-initialized workspace.md for '${ws.name}'`);
							this.renderContent();
						}),
						new Action('create_entity', 'Create New Entity Folder...', ThemeIcon.asClassName(Codicon.add), true, () => {
							this.showCreateResourceModal(ws);
						}),
						new Action('remove_entry', 'Remove Entry from Explorer', ThemeIcon.asClassName(Codicon.close), true, async () => {
							await this.workspacesExplorerService.removeWorkspace(ws.uri);
							this.notificationService.info(`Removed '${ws.name}' from explorer.`);
							this.renderContent();
						}),
						new Action('move_to_trash', 'Move to Trash...', ThemeIcon.asClassName(Codicon.trash), true, async () => {
							const confirm = await this.dialogService.confirm({
								type: 'warning',
								message: `Are you sure you want to move '${ws.name}' to trash?`,
								detail: `This will move '${ws.uri.fsPath}' to OS Trash if it exists on disk.`,
								primaryButton: 'Move to Trash'
							});
							if (confirm.confirmed) {
								try {
									const exists = await this.fileService.exists(ws.uri);
									if (exists) {
										await this.fileService.del(ws.uri, { useTrash: true, recursive: true });
									}
									await this.workspacesExplorerService.removeWorkspace(ws.uri);
									this.notificationService.info(`Removed '${ws.name}' workspace entry.`);
									this.renderContent();
								} catch (err) {
									// File non-existent or inaccessible, still remove entry cleanly!
									await this.workspacesExplorerService.removeWorkspace(ws.uri);
									this.notificationService.info(`Removed missing workspace entry '${ws.name}'.`);
									this.renderContent();
								}
							}
						})
					];

					this.contextMenuService.showContextMenu({
						getAnchor: () => ({ x: e.clientX, y: e.clientY }),
						getActions: () => actions
					});
				};

				const headerLeft = append(cardHeader, $('.header-left'));
				headerLeft.style.display = 'flex';
				headerLeft.style.alignItems = 'center';
				headerLeft.style.gap = '6px';
				headerLeft.style.overflow = 'hidden';

				const chevronIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(isExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
				chevronIcon.style.opacity = '0.6';
				chevronIcon.style.fontSize = '11px';
				chevronIcon.title = isExpanded ? 'Collapse' : 'Expand';
				chevronIcon.onclick = (e) => {
					e.stopPropagation();
					if (this.expandedWorkspaces.has(canonicalWsId)) {
						this.expandedWorkspaces.delete(canonicalWsId);
					} else {
						this.expandedWorkspaces.add(canonicalWsId);
					}
					this.renderContent();
				};

				let wsIcon: HTMLElement;
				let badgeText = '';
				let badgeBg = '';
				let badgeFg = '';

				if (ws.detectedType === 'job') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rocket)));
					wsIcon.style.color = '#fbbf24';
					badgeText = 'JOB';
					badgeBg = 'rgba(251, 191, 36, 0.2)';
					badgeFg = '#fbbf24';
				} else if (ws.detectedType === 'project') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.project)));
					wsIcon.style.color = '#60a5fa';
					badgeText = 'PROJECT';
					badgeBg = 'rgba(96, 165, 250, 0.2)';
					badgeFg = '#60a5fa';
				} else if (ws.detectedType === 'task') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
					wsIcon.style.color = '#a78bfa';
					badgeText = 'TASK';
					badgeBg = 'rgba(167, 139, 250, 0.2)';
					badgeFg = '#a78bfa';
				} else if (ws.detectedType === 'agent') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
					wsIcon.style.color = '#38bdf8';
					badgeText = 'AGENT';
					badgeBg = 'rgba(56, 189, 248, 0.2)';
					badgeFg = '#38bdf8';
				} else {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
					wsIcon.style.color = ws.isMissing ? '#f87171' : 'inherit';
				}

				append(headerLeft, $('span', { style: 'font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' }, ws.name));

				// Header Right Container (Badges + Actions)
				const headerRight = append(cardHeader, $('.header-right'));
				headerRight.style.display = 'flex';
				headerRight.style.alignItems = 'center';
				headerRight.style.gap = '6px';
				headerRight.style.flexShrink = '0';

				if (badgeText) {
					const badge = append(headerRight, $('span', { style: `font-size: 8.5px; padding: 1px 5px; border-radius: 3px; background: ${badgeBg}; color: ${badgeFg}; font-weight: 600; text-transform: uppercase;` }, badgeText));
					badge.title = `Entity Type: ${badgeText}`;
				}

				// Status Ring (Health / Cascading Error Indicator)
				const statusRing = append(headerRight, $('.status-ring'));
				const isCorrupted = ws.isMissing || ws.hasDamagedDescendant;
				statusRing.style.display = 'inline-block';
				statusRing.style.width = '7px';
				statusRing.style.height = '7px';
				statusRing.style.borderRadius = '50%';
				statusRing.style.flexShrink = '0';
				statusRing.style.marginLeft = '2px';

				if (isCorrupted) {
					statusRing.style.background = '#ef4444';
					statusRing.style.boxShadow = '0 0 5px rgba(239, 68, 68, 0.7)';
					statusRing.title = ws.isMissing ? (ws.missingReason || 'Missing/damaged entity files on disk') : 'Warning: Inner sub-entities or files are damaged!';
				} else {
					statusRing.style.background = '#22c55e';
					statusRing.style.opacity = '0.85';
					statusRing.title = 'Status: Healthy';
				}

				// Header Actions
				const headerActions = append(headerRight, $('.header-actions'));
				headerActions.style.display = 'flex';
				headerActions.style.alignItems = 'center';
				headerActions.style.gap = '6px';

				if (!ws.isMissing) {
					const createBtn = append(headerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
					createBtn.style.opacity = '0.8';
					createBtn.style.fontSize = '13px';
					createBtn.title = `New Entity in '${ws.name}'...`;
					createBtn.onclick = (e) => {
						e.stopPropagation();
						this.showCreateResourceModal(ws.uri, ws.name);
					};
				}

				if (isCorrupted) {
					// Repair 4-MD button for workspace / entity folder with missing files
					const fixBtn = append(headerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.tools)));
					fixBtn.style.color = '#fbbf24';
					fixBtn.style.fontSize = '12px';
					fixBtn.style.opacity = '0.9';
					fixBtn.title = 'Repair entity standard files from snapshot';
					fixBtn.onclick = async (e) => {
						e.stopPropagation();
						try {
							await this.workspacesExplorerService.repairEntityFromSnapshot(ws.uri);
							this.notificationService.info(`Repaired standard files for '${ws.name}'`);
							this.renderContent();
						} catch (err) {
							this.notificationService.error(`Failed to repair: ${err}`);
						}
					};
				}

				// Single Click: Select workspace card and toggle expansion in-place
				cardHeader.onclick = () => {
					this.selectedWorkspaceId = canonicalWsId;
					this.selectedItemId = canonicalWsId;

					if (this.expandedWorkspaces.has(canonicalWsId)) {
						this.expandedWorkspaces.delete(canonicalWsId);
					} else {
						this.expandedWorkspaces.add(canonicalWsId);
					}
					this.renderContent();
				};

				// Expanded Body: Inner Scrollable Children Container
				if (isExpanded) {
					const childrenContainer = append(wsCard, $('.children-container'));
					childrenContainer.style.padding = '4px 8px 8px 6px';
					childrenContainer.style.display = 'flex';
					childrenContainer.style.flexDirection = 'column';
					childrenContainer.style.gap = '3px';
					childrenContainer.style.borderTop = '1px solid rgba(255, 255, 255, 0.04)';
					childrenContainer.style.maxHeight = 'calc(88vh - 100px)';
					childrenContainer.style.overflowY = 'auto';

					await this.renderChildrenTree(childrenContainer, ws.uri, canonicalWsId, 1, currentVersion);
				}
			}
		}

		// Auto-scroll / anchor selected element into view, or restore scroll position
		if (this.targetSelectedElement) {
			this.targetSelectedElement.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
		} else if (savedScrollTop > 0 && treeBox) {
			treeBox.scrollTop = savedScrollTop;
		}
	}

	private async renderChildrenTree(
		parentContainer: HTMLElement,
		folderUri: URI,
		parentWsId: string,
		depth: number,
		currentVersion: number
	): Promise<void> {
		const children = await this.workspacesExplorerService.scanWorkspaceChildren(folderUri);
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}

		if (children.length === 0) {
			append(parentContainer, $('div', { style: `font-size: 11px; opacity: 0.4; padding: 4px 0 4px ${depth * 12}px;` }, '(Empty folder)'));
			return;
		}

		for (const child of children) {
			const canonicalChildId = this.getCanonicalId(child.id);
			const isDirectory = child.type === 'folder' || child.type === 'job' || child.type === 'project' || child.type === 'workspace' || child.type === 'agent' || child.type === 'task' || child.type === 'case' || child.type === 'issue' || child.type === 'analysis';
			const isExpanded = isDirectory && this.expandedWorkspaces.has(canonicalChildId);
			const isChildSelected = this.selectedWorkspaceId === parentWsId && this.selectedItemId === canonicalChildId;

			const childRow = append(parentContainer, $('.child-item-row'));
			childRow.style.display = 'flex';
			childRow.style.alignItems = 'center';
			childRow.style.justifyContent = 'space-between';
			childRow.style.padding = `4px 6px 4px ${depth * 12}px`;
			childRow.style.borderRadius = '4px';
			childRow.style.cursor = 'pointer';

			if (isChildSelected) {
				childRow.style.backgroundColor = 'rgba(56, 189, 248, 0.25)';
				childRow.style.border = '1px solid #38bdf8';
				this.targetSelectedElement = childRow;
			} else {
				childRow.style.backgroundColor = 'transparent';
				childRow.style.border = '1px solid transparent';
			}

			childRow.onmouseenter = () => {
				if (!isChildSelected) {
					childRow.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
				}
			};
			childRow.onmouseleave = () => {
				if (!isChildSelected) {
					childRow.style.backgroundColor = 'transparent';
				}
			};

			// Right click context menu
			childRow.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();

				const childActions: Action[] = [];

				if (isDirectory) {
					childActions.push(new Action('create_sub_entity', `Create Sub-Entity in '${child.name}'...`, ThemeIcon.asClassName(Codicon.add), true, () => {
						this.showCreateResourceModal(child.uri, child.name);
					}));
				}

				childActions.push(
					new Action('reveal_child_in_os', isMacintosh ? 'Reveal in Finder' : 'Reveal in Explorer', ThemeIcon.asClassName(Codicon.folder), true, async () => {
						try {
							await this.commandService.executeCommand('revealFileInOS', child.uri);
						} catch {
							this.notificationService.warn(`Path does not exist: ${child.uri.fsPath}`);
						}
					}),
					new Action('open_child', child.type === 'file' ? 'Open File' : 'Open Workspace Folder', ThemeIcon.asClassName(Codicon.goToFile), true, async () => {
						if (child.uri.path.toLowerCase().endsWith('.md')) {
							await this.commandService.executeCommand('markdown.showPreview', child.uri);
						} else if (isDirectory) {
							await this.commandService.executeCommand('vscode.openFolder', child.uri, { forceNewWindow: false });
						} else {
							await this.openerService.open(child.uri);
						}
					}),
					new Action('trash_child', 'Move to Trash...', ThemeIcon.asClassName(Codicon.trash), true, async () => {
						const confirm = await this.dialogService.confirm({
							type: 'warning',
							message: `Are you sure you want to move '${child.name}' to trash?`,
							detail: `This will move '${child.uri.fsPath}' to OS Trash if it exists.`,
							primaryButton: 'Move to Trash'
						});
						if (confirm.confirmed) {
							try {
								const exists = await this.fileService.exists(child.uri);
								if (exists) {
									await this.fileService.del(child.uri, { useTrash: true, recursive: true });
								}
								this.notificationService.info(`Removed '${child.name}'.`);
								this.renderContent();
							} catch (err) {
								this.notificationService.error(`Failed to move to trash: ${err}`);
							}
						}
					})
				);

				this.contextMenuService.showContextMenu({
					getAnchor: () => ({ x: e.clientX, y: e.clientY }),
					getActions: () => childActions
				});
			};

			const childLeft = append(childRow, $('.child-left'));
			childLeft.style.display = 'flex';
			childLeft.style.alignItems = 'center';
			childLeft.style.gap = '6px';
			childLeft.style.overflow = 'hidden';
			childLeft.style.flex = '1';

			// Folder expansion chevron
			if (isDirectory) {
				const chevronIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(isExpanded ? Codicon.chevronDown : Codicon.chevronRight)));
				chevronIcon.style.opacity = '0.6';
				chevronIcon.style.fontSize = '11px';
				chevronIcon.title = isExpanded ? 'Collapse' : 'Expand';
				chevronIcon.onclick = (e) => {
					e.stopPropagation();
					if (this.expandedWorkspaces.has(canonicalChildId)) {
						this.expandedWorkspaces.delete(canonicalChildId);
					} else {
						this.expandedWorkspaces.add(canonicalChildId);
					}
					this.renderContent();
				};
			}

			let childIcon: HTMLElement;
			let badgeText = '';
			let badgeBg = '';
			let badgeFg = '';

			if (child.type === 'workspace') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
				childIcon.style.color = '#38bdf8';
				badgeText = 'WORKSPACE';
				badgeBg = 'rgba(56, 189, 248, 0.2)';
				badgeFg = '#38bdf8';
			} else if (child.type === 'job') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rocket)));
				childIcon.style.color = '#fbbf24';
				badgeText = 'JOB';
				badgeBg = 'rgba(251, 191, 36, 0.2)';
				badgeFg = '#fbbf24';
			} else if (child.type === 'project') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.project)));
				childIcon.style.color = '#60a5fa';
				badgeText = 'PROJECT';
				badgeBg = 'rgba(96, 165, 250, 0.2)';
				badgeFg = '#60a5fa';
			} else if (child.type === 'agent') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
				childIcon.style.color = '#38bdf8';
				badgeText = 'AGENT';
				badgeBg = 'rgba(56, 189, 248, 0.2)';
				badgeFg = '#38bdf8';
			} else if (child.type === 'task') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
				childIcon.style.color = '#a78bfa';
				badgeText = 'TASK';
				badgeBg = 'rgba(167, 139, 250, 0.2)';
				badgeFg = '#a78bfa';
			} else if (child.type === 'case') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.beaker)));
				childIcon.style.color = '#f472b6';
				badgeText = 'CASE';
				badgeBg = 'rgba(244, 114, 182, 0.2)';
				badgeFg = '#f472b6';
			} else if (child.type === 'issue') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.bug)));
				childIcon.style.color = '#ef4444';
				badgeText = 'ISSUE';
				badgeBg = 'rgba(239, 68, 68, 0.2)';
				badgeFg = '#ef4444';
			} else if (child.type === 'analysis') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));
				childIcon.style.color = '#34d399';
				badgeText = 'ANALYSIS';
				badgeBg = 'rgba(52, 211, 153, 0.2)';
				badgeFg = '#34d399';
			} else if (child.type === 'folder') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.folder)));
				childIcon.style.opacity = '0.8';
			} else {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.file)));
				childIcon.style.opacity = '0.7';
			}

			append(childLeft, $('span', { style: 'font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' }, child.name));

			// Right-Aligned Badges & Actions Group
			const childRight = append(childRow, $('.child-right'));
			childRight.style.display = 'flex';
			childRight.style.alignItems = 'center';
			childRight.style.gap = '4px';
			childRight.style.flexShrink = '0';

			if (badgeText) {
				const badge = append(childRight, $('span', { style: `font-size: 8px; padding: 1px 5px; border-radius: 3px; background: ${badgeBg}; color: ${badgeFg}; font-weight: 600; text-transform: uppercase;` }, badgeText));
				badge.title = `Entity Type: ${badgeText}`;
			}

			// Status Ring (Health / Cascading Error Indicator)
			if (isDirectory) {
				const childStatusRing = append(childRight, $('.status-ring'));
				const isChildCorrupted = child.isMissing || child.hasDamagedDescendant;
				childStatusRing.style.display = 'inline-block';
				childStatusRing.style.width = '6.5px';
				childStatusRing.style.height = '6.5px';
				childStatusRing.style.borderRadius = '50%';
				childStatusRing.style.flexShrink = '0';
				childStatusRing.style.marginLeft = '2px';

				if (isChildCorrupted) {
					childStatusRing.style.background = '#ef4444';
					childStatusRing.style.boxShadow = '0 0 5px rgba(239, 68, 68, 0.7)';
					childStatusRing.title = child.isMissing ? (child.missingReason || 'Missing/damaged entity files') : 'Warning: Inner sub-entities are damaged!';
				} else {
					childStatusRing.style.background = '#22c55e';
					childStatusRing.style.opacity = '0.85';
					childStatusRing.title = 'Status: Healthy';
				}
			}

			if (child.isMissing || child.hasDamagedDescendant) {
				const fixBtn = append(childRight, $('span' + ThemeIcon.asCSSSelector(Codicon.tools)));
				fixBtn.style.color = '#fbbf24';
				fixBtn.style.fontSize = '11px';
				fixBtn.style.opacity = '0.9';
				fixBtn.style.marginLeft = '4px';
				fixBtn.title = 'Repair entity standard files from snapshot';
				fixBtn.onclick = async (e) => {
					e.stopPropagation();
					try {
						await this.workspacesExplorerService.repairEntityFromSnapshot(child.uri);
						this.notificationService.info(`Repaired standard files for '${child.name}'`);
						this.renderContent();
					} catch (err) {
						this.notificationService.error(`Failed to repair: ${err}`);
					}
				};
			}

			if (!child.isMissing && isDirectory) {
				const createSubBtn = append(childRight, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
				createSubBtn.style.opacity = '0.75';
				createSubBtn.style.fontSize = '11.5px';
				createSubBtn.style.marginLeft = '4px';
				createSubBtn.title = `New Entity Folder in '${child.name}'...`;
				createSubBtn.onclick = (e) => {
					e.stopPropagation();
					this.showCreateResourceModal(child.uri, child.name);
				};
			}

			// Single Click: Select item, expand if directory, open preview if md file
			childRow.onclick = async () => {
				this.selectedWorkspaceId = parentWsId;
				this.selectedItemId = canonicalChildId;

				if (isDirectory) {
					if (!this.expandedWorkspaces.has(canonicalChildId)) {
						this.expandedWorkspaces.add(canonicalChildId);
					} else {
						this.expandedWorkspaces.delete(canonicalChildId);
					}
					// Also check if directory contains a primary md file like instruction.md / job.md / workspace.md
					const possibleMds = ['instruction.md', 'job.md', 'workspace.md', 'project.md', 'agent.md', 'README.md'];
					for (const mdName of possibleMds) {
						const mdUri = URI.joinPath(child.uri, mdName);
						if (await this.fileService.exists(mdUri)) {
							await this.commandService.executeCommand('markdown.showPreview', mdUri);
							break;
						}
					}
				} else if (child.uri.path.toLowerCase().endsWith('.md')) {
					await this.commandService.executeCommand('markdown.showPreview', child.uri);
				} else {
					await this.openerService.open(child.uri);
				}

				this.renderContent();
			};

			// If directory is expanded, recursively render sub-tree container
			if (isExpanded) {
				const subContainer = append(parentContainer, $('.sub-children-container'));
				subContainer.style.display = 'flex';
				subContainer.style.flexDirection = 'column';
				subContainer.style.gap = '2px';
				await this.renderChildrenTree(subContainer, child.uri, parentWsId, depth + 1, currentVersion);
			}
		}
	}

	/**
	 * Dedicated Modal for Creating a New Workspace
	 */
	private showCreateWorkspaceModal(): void {
		if (!this.containerEl) {
			return;
		}

		const existingModal = this.containerEl.querySelector('.create-workspace-modal-overlay');
		if (existingModal) {
			existingModal.remove();
		}

		const overlay = append(this.containerEl, $('.create-workspace-modal-overlay'));
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100vw';
		overlay.style.height = '100vh';
		overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
		overlay.style.backdropFilter = 'blur(6px)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '10000';
		overlay.style.padding = '20px';

		const modal = append(overlay, $('.create-resource-modal'));
		modal.style.width = '100%';
		modal.style.maxWidth = '440px';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.15)';
		modal.style.borderRadius = '10px';
		modal.style.padding = '20px';
		modal.style.boxShadow = '0 12px 32px rgba(0,0,0,0.6)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '14px';

		// Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';

		const modalTitle = append(modalHeader, $('div', { style: 'font-weight: 600; font-size: 13px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
		append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
		append(modalTitle, $('span', {}, 'Create New Workspace'));

		const closeIcon = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeIcon.style.cursor = 'pointer';
		closeIcon.style.opacity = '0.7';
		closeIcon.onclick = () => overlay.remove();

		// Workspace Name Input
		const nameBox = append(modal, $('.form-group'));
		append(nameBox, $('label', { style: 'display: block; font-size: 11px; opacity: 0.85; margin-bottom: 4px;' }, 'Workspace Name:'));
		const nameInput = append(nameBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		nameInput.placeholder = 'e.g., my_workspace';
		nameInput.value = 'my_workspace';

		// Location Path Picker
		const pathBox = append(modal, $('.form-group'));
		append(pathBox, $('label', { style: 'display: block; font-size: 11px; opacity: 0.85; margin-bottom: 4px;' }, 'Target Location Path:'));
		
		const pathRow = append(pathBox, $('.path-input-row'));
		pathRow.style.display = 'flex';
		pathRow.style.gap = '6px';

		let selectedPathUri: URI | undefined;

		const pathInput = append(pathRow, $('input.monaco-inputbox', {
			style: 'flex: 1; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		pathInput.placeholder = 'Select or enter folder path...';

		const browseBtn = append(pathRow, $('button.monaco-button', {
			style: 'padding: 6px 10px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit; white-space: nowrap;'
		}));
		browseBtn.innerText = 'Browse...';
		browseBtn.onclick = async () => {
			const res = await this.fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				title: 'Select Workspace Location Path'
			});
			if (res && res.length > 0) {
				selectedPathUri = res[0];
				pathInput.value = res[0].fsPath;
			}
		};

		// Description Input
		const descBox = append(modal, $('.form-group'));
		append(descBox, $('label', { style: 'display: block; font-size: 11px; opacity: 0.85; margin-bottom: 4px;' }, 'Description (Optional):'));
		const descInput = append(descBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		descInput.placeholder = 'Brief purpose of this workspace';

		// Action Buttons Row
		const actionsRow = append(modal, $('.modal-actions-row'));
		actionsRow.style.display = 'flex';
		actionsRow.style.justifyContent = 'flex-end';
		actionsRow.style.gap = '8px';
		actionsRow.style.marginTop = '6px';

		const cancelBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();

		const submitBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 6px 14px; font-size: 11px; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
		}));
		submitBtn.innerText = 'Create Workspace';

		submitBtn.onclick = async () => {
			const name = nameInput.value.trim();
			if (!name) {
				this.notificationService.warn('Please enter a workspace name.');
				return;
			}

			const pathStr = pathInput.value.trim();
			const parentUri = selectedPathUri || (pathStr ? URI.file(pathStr) : undefined);

			if (!parentUri) {
				this.notificationService.warn('Please select or specify a valid location path.');
				return;
			}

			try {
				const res = await this.workspacesExplorerService.createWorkspaceWithNameAndPath(name, parentUri, descInput.value.trim());

				overlay.remove();

				if (res.alreadyExists) {
					this.notificationService.warn(`Workspace already exists at '${res.uri.fsPath}'. Opening workspace...`);
				} else {
					this.notificationService.info(`Created new workspace '${name}' with workspace.md & standard files.`);
				}

				this.expandedWorkspaces.add(res.uri.toString());
				const workspaceMdUri = URI.joinPath(res.uri, 'workspace.md');
				await this.commandService.executeCommand('markdown.showPreview', workspaceMdUri);
				await this.renderContent();
			} catch (err) {
				this.notificationService.error(`Failed to create workspace: ${err}`);
			}
		};
	}

	private async generateSequentialName(targetUri: URI, type: ResourceType): Promise<string> {
		const prefixMap: Record<ResourceType, string> = {
			job: 'JOB',
			task: 'TASK',
			project: 'PROJECT',
			workflow: 'WORKFLOW',
			case: 'CASE',
			agent: 'AGENT',
			issue: 'ISSUE',
			analysis: 'ANALYSIS',
			workspace: 'WORKSPACE',
			folder: 'FOLDER',
			file: 'FILE'
		};

		const prefix = prefixMap[type] || 'ENTITY';

		try {
			const stat = await this.fileService.resolve(targetUri);
			if (!stat.children) return `${prefix}-001`;

			let maxNum = 0;
			const regex = new RegExp(`^(?:${prefix}|${type})(?:[-_]?(?:${type}))?[-_]?(\\d+)$`, 'i');

			for (const child of stat.children) {
				const match = child.name.match(regex);
				if (match) {
					const num = parseInt(match[1], 10);
					if (!isNaN(num) && num > maxNum) {
						maxNum = num;
					}
				}
			}

			const nextNum = maxNum + 1;
			return `${prefix}-${String(nextNum).padStart(3, '0')}`;
		} catch {
			return `${prefix}-001`;
		}
	}

	/**
	 * Renders a spacious Create Resource Modal Overlay under the target Workspace or Folder
	 */
	private showCreateResourceModal(target: IWorkspaceItem | URI, parentName?: string): void {
		if (!this.containerEl) {
			return;
		}

		let targetUri: URI;
		let targetName: string;

		if (target && typeof target === 'object' && 'uri' in target && 'name' in target) {
			targetUri = (target as IWorkspaceItem).uri;
			targetName = (target as IWorkspaceItem).name;
		} else {
			targetUri = target as URI;
			targetName = parentName || 'Folder';
		}

		const existingModal = this.containerEl.querySelector('.create-resource-modal-overlay');
		if (existingModal) {
			existingModal.remove();
		}

		const overlay = append(this.containerEl, $('.create-resource-modal-overlay'));
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100vw';
		overlay.style.height = '100vh';
		overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.65)';
		overlay.style.backdropFilter = 'blur(6px)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '10000';
		overlay.style.padding = '20px';

		const modal = append(overlay, $('.create-resource-modal'));
		modal.style.width = '100%';
		modal.style.maxWidth = '480px';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.15)';
		modal.style.borderRadius = '10px';
		modal.style.padding = '20px';
		modal.style.boxShadow = '0 12px 32px rgba(0,0,0,0.6)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '14px';

		// Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';

		const modalTitle = append(modalHeader, $('div', { style: 'font-weight: 600; font-size: 13px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
		append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
		append(modalTitle, $('span', {}, `New Entity Folder in '${targetName}'`));

		const closeIcon = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeIcon.style.cursor = 'pointer';
		closeIcon.style.opacity = '0.7';
		closeIcon.onclick = () => overlay.remove();

		// Category Radio Selection (Workspace as 1st Top Entity)
		append(modal, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 500;' }, 'Select Entity Type:'));
		const categoryGrid = append(modal, $('.category-grid'));
		categoryGrid.style.display = 'grid';
		categoryGrid.style.gridTemplateColumns = '1fr 1fr 1fr';
		categoryGrid.style.gap = '6px';

		let selectedType: ResourceType = 'job';

		const types: { type: ResourceType; label: string; icon: ThemeIcon; color: string }[] = [
			{ type: 'job', label: 'Job', icon: Codicon.rocket, color: '#fbbf24' },
			{ type: 'task', label: 'Task', icon: Codicon.checklist, color: '#a78bfa' },
			{ type: 'project', label: 'Project', icon: Codicon.project, color: '#60a5fa' },
			{ type: 'case', label: 'Case', icon: Codicon.beaker, color: '#f472b6' },
			{ type: 'agent', label: 'AI Agent', icon: Codicon.robot, color: '#38bdf8' },
			{ type: 'issue', label: 'Issue', icon: Codicon.bug, color: '#ef4444' },
			{ type: 'analysis', label: 'Analysis', icon: Codicon.graph, color: '#34d399' },
			{ type: 'workspace', label: 'Workspace', icon: Codicon.rootFolder, color: '#38bdf8' },
			{ type: 'folder', label: 'Folder', icon: Codicon.folder, color: '#94a3b8' },
			{ type: 'file', label: 'File', icon: Codicon.file, color: '#94a3b8' }
		];

		const typeButtons: HTMLElement[] = [];

		for (const t of types) {
			const btn = append(categoryGrid, $('.type-option-btn'));
			btn.style.padding = '6px 8px';
			btn.style.borderRadius = '5px';
			btn.style.cursor = 'pointer';
			btn.style.fontSize = '10.5px';
			btn.style.display = 'flex';
			btn.style.alignItems = 'center';
			btn.style.gap = '5px';
			btn.style.border = t.type === selectedType ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.08)';
			btn.style.backgroundColor = t.type === selectedType ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.03)';

			const iconSpan = append(btn, $('span' + ThemeIcon.asCSSSelector(t.icon)));
			iconSpan.style.color = t.color;

			append(btn, $('span', {}, t.label));

			btn.onclick = async () => {
				selectedType = t.type;
				for (let i = 0; i < typeButtons.length; i++) {
					const isSelected = types[i].type === selectedType;
					typeButtons[i].style.border = isSelected ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.08)';
					typeButtons[i].style.backgroundColor = isSelected ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.03)';
				}
				nameInput.value = await this.generateSequentialName(targetUri, selectedType);
				await updateValidation();
			};

			typeButtons.push(btn);
		}

		// Resource Name Input
		const nameBox = append(modal, $('.form-group'));
		append(nameBox, $('label', { style: 'display: block; font-size: 11px; opacity: 0.85; margin-bottom: 4px;' }, 'Entity Folder Name:'));
		const nameInput = append(nameBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;

		// Warning banner element for duplicate or invalid names
		const warningBanner = append(nameBox, $('div', {
			style: 'font-size: 10.5px; color: #ef4444; margin-top: 4px; display: none; line-height: 1.3;'
		}));

		// Description Input
		const descBox = append(modal, $('.form-group'));
		append(descBox, $('label', { style: 'display: block; font-size: 11px; opacity: 0.85; margin-bottom: 4px;' }, 'Description:'));
		const descInput = append(descBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		descInput.placeholder = 'Brief purpose of this entity';

		// Action Buttons Row
		const actionsRow = append(modal, $('.modal-actions-row'));
		actionsRow.style.display = 'flex';
		actionsRow.style.justifyContent = 'flex-end';
		actionsRow.style.gap = '8px';
		actionsRow.style.marginTop = '6px';

		const cancelBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 5px 12px; font-size: 11px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();

		const submitBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 6px 14px; font-size: 11px; border-radius: 4px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
		})) as HTMLButtonElement;
		submitBtn.innerText = 'Create Entity';

		const updateValidation = async () => {
			const inputName = nameInput.value.trim();
			if (!inputName) {
				warningBanner.innerText = '⚠️ Please enter a valid entity name.';
				warningBanner.style.display = 'block';
				submitBtn.disabled = true;
				submitBtn.style.opacity = '0.5';
				submitBtn.style.pointerEvents = 'none';
				return;
			}

			const sanitizedName = inputName.replace(/[^a-zA-Z0-9_-]/g, '-');
			const targetCheckUri1 = URI.joinPath(targetUri, inputName);
			const targetCheckUri2 = URI.joinPath(targetUri, sanitizedName);
			const exists = await this.fileService.exists(targetCheckUri1) || await this.fileService.exists(targetCheckUri2);
			if (exists) {
				warningBanner.innerText = `⚠️ Entity folder '${inputName}' is already occupied in '${targetName}'. Please enter a unique name.`;
				warningBanner.style.display = 'block';
				submitBtn.disabled = true;
				submitBtn.style.opacity = '0.5';
				submitBtn.style.pointerEvents = 'none';
			} else {
				warningBanner.style.display = 'none';
				submitBtn.disabled = false;
				submitBtn.style.opacity = '1.0';
				submitBtn.style.pointerEvents = 'auto';
			}
		};

		// Set initial sequential name and run validation
		this.generateSequentialName(targetUri, selectedType).then(initialName => {
			nameInput.value = initialName;
			updateValidation();
		});

		nameInput.oninput = () => {
			updateValidation();
		};

		submitBtn.onclick = async () => {
			const name = nameInput.value.trim();
			if (!name) {
				this.notificationService.warn('Please enter a valid entity name.');
				return;
			}

			try {
				const createResult = await this.workspacesExplorerService.createResourceUnderWorkspace({
					workspaceUri: targetUri,
					type: selectedType,
					name,
					description: descInput.value.trim()
				});

				const createdUri = createResult.uri;

				overlay.remove();
				if (createResult.alreadyExists) {
					this.notificationService.info(`'${name}' already exists in ${targetName}. Opened existing ${selectedType} files.`);
				} else {
					this.notificationService.info(`Created ${selectedType} '${name}' standard files in ${targetName}`);
				}

				const canonicalParentId = this.getCanonicalId(targetUri);
				const createdFolderUri = dirname(createdUri);
				const canonicalCreatedId = this.getCanonicalId(createdFolderUri);

				this.expandedWorkspaces.add(canonicalParentId);
				this.expandedWorkspaces.add(canonicalCreatedId);
				this.selectedItemId = canonicalCreatedId;

				if (createdUri.path.toLowerCase().endsWith('.md')) {
					await this.commandService.executeCommand('markdown.showPreview', createdUri);
				} else {
					await this.openerService.open(createdUri);
				}
				await this.renderContent();
			} catch (err) {
				this.notificationService.error(`Failed to create entity: ${err}`);
			}
		};
	}
}
