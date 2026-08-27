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
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Action } from '../../../../base/common/actions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspacesExplorerService, IWorkspaceItem } from '../common/workspacesExplorer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAgentsManagerService, IAgentCredentialService, IAgentCredential } from '../../agentsManager/common/agentsManager.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { AccountManagementDialog } from '../../accountManagement/browser/accountManagementDialog.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { VIEW_ID } from '../../files/common/files.js';

interface ICustomField {
	id: string;
	label: string;
	type: 'text' | 'textarea' | 'select' | 'multiselect' | 'switch';
	options?: string[];
}

interface ICustomModule {
	id: string;
	name: string;
	description?: string;
	prompt?: string;
	isDeprecated?: boolean;
	color: string;
	storageScope?: 'global' | 'workspace';
	fields?: ICustomField[];
}

function stringifyYaml(obj: any, indent = 0): string {
	const spacing = ' '.repeat(indent);
	if (Array.isArray(obj)) {
		if (obj.length === 0) return ' []';
		let res = '';
		for (const item of obj) {
			if (typeof item === 'object' && item !== null) {
				const itemYaml = stringifyYaml(item, indent + 2).trim();
				res += `\n${spacing}- ${itemYaml}`;
			} else {
				res += `\n${spacing}- ${item}`;
			}
		}
		return res;
	} else if (typeof obj === 'object' && obj !== null) {
		let res = '';
		for (const [k, v] of Object.entries(obj)) {
			if (v === undefined) continue;
			if (typeof v === 'object' && v !== null) {
				res += `${res ? '\n' : ''}${spacing}${k}:${stringifyYaml(v, indent + 2)}`;
			} else {
				const valStr = typeof v === 'string' && (v.includes('\n') || v.includes(':') || v.startsWith('#') || v.includes(',') || v.includes('[') || v.includes(']')) 
					? JSON.stringify(v)
					: v;
				res += `${res ? '\n' : ''}${spacing}${k}: ${valStr}`;
			}
		}
		return res;
	}
	return String(obj);
}

function parseYaml(yaml: string): any {
	const lines = yaml.split(/\r?\n/);
	const result: any = {};
	let currentFieldList: any[] = [];
	let currentField: any = null;

	for (let line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const indent = line.length - line.trimStart().length;

		if (trimmed.startsWith('-')) {
			const content = trimmed.substring(1).trim();
			if (content.includes(':')) {
				const colonIndex = content.indexOf(':');
				const key = content.substring(0, colonIndex).trim();
				let val = content.substring(colonIndex + 1).trim();
				if (val.startsWith('"') && val.endsWith('"')) {
					try { val = JSON.parse(val); } catch {}
				}
				currentField = { [key]: val };
				currentFieldList.push(currentField);
			} else {
				let val = content;
				if (val.startsWith('"') && val.endsWith('"')) {
					try { val = JSON.parse(val); } catch {}
				}
				if (currentField && Array.isArray(currentField.options)) {
					currentField.options.push(val);
				}
			}
		} else if (trimmed.includes(':')) {
			const colonIndex = trimmed.indexOf(':');
			const key = trimmed.substring(0, colonIndex).trim();
			let val = trimmed.substring(colonIndex + 1).trim();
			if (val.startsWith('"') && val.endsWith('"')) {
				try { val = JSON.parse(val); } catch {}
			}

			if (indent === 0) {
				if (key === 'fields') {
					result.fields = [];
					currentFieldList = result.fields;
				} else {
					result[key] = (val === 'true' ? true : val === 'false' ? false : val);
				}
			} else if (indent > 0 && currentField) {
				if (key === 'options') {
					currentField.options = [];
				} else {
					currentField[key] = (val === 'true' ? true : val === 'false' ? false : val);
				}
			}
		}
	}
	return result;
}

function getColorForName(name: string | undefined): string {
	if (!name) return '#38bdf8';
	const MODERN_PALETTE = [
		'#38bdf8', // Light Blue
		'#a78bfa', // Purple/Violet
		'#f472b6', // Pink
		'#34d399', // Emerald/Green
		'#fbbf24', // Amber/Yellow
		'#fb923c', // Orange
		'#2dd4bf', // Teal
		'#f87171', // Red
		'#818cf8', // Indigo
		'#c084fc', // Fuchsia
		'#22d3ee', // Cyan
		'#eab308'  // Yellow-gold
	];
	let hash = 0;
	const str = String(name).trim();
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % MODERN_PALETTE.length;
	return MODERN_PALETTE[index];
}

function hexToRgba(hex: string | undefined, alpha: number): string {
	if (!hex) {
		return `rgba(56, 189, 248, ${alpha})`;
	}
	let r = 0, g = 0, b = 0;
	if (hex.length === 4) {
		r = parseInt(hex[1] + hex[1], 16);
		g = parseInt(hex[2] + hex[2], 16);
		b = parseInt(hex[3] + hex[3], 16);
	} else if (hex.length === 7) {
		r = parseInt(hex.substring(1, 3), 16);
		g = parseInt(hex.substring(3, 5), 16);
		b = parseInt(hex.substring(5, 7), 16);
	}
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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

	private readonly _storageService: IStorageService;

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
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService,
		@IStorageService storageService: IStorageService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IViewsService private readonly viewsService: IViewsService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._storageService = storageService;

		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(() => this.renderContent()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.renderContent()));
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this.renderContent()));
	}

	async showInExplorer(resourceUri: URI): Promise<void> {
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
						e.dataTransfer.setData('vscode-workspace-id', ws.id);
						e.dataTransfer.setData('text/plain', `any-agent-import:project:${ws.name}`);
						e.dataTransfer.effectAllowed = 'copyMove';
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

					const sourceId = e.dataTransfer?.getData('vscode-workspace-id') || e.dataTransfer?.getData('text/plain');
					if (sourceId && sourceId !== ws.id && !sourceId.startsWith('any-agent-import:')) {
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
						new Action('edit_workspace', 'Edit Workspace...', ThemeIcon.asClassName(Codicon.edit), true, async () => {
							try {
								if (ws.detectedType === 'workflow') {
									await this.editorService.openEditor(new WorkflowEditorInput(ws.uri, ws.name), { pinned: true });
								} else {
									await this.editorService.openEditor(new EntityDetailEditorInput(ws.uri, ws.name, true), { pinned: true });
								}
							} catch (err) {
								console.error('Failed to open Workspace editor:', err);
							}
						}),
						new Action('show_in_explorer', 'Show in Explorer', ThemeIcon.asClassName(Codicon.folderLibrary), true, async () => {
							await this.showInExplorer(ws.uri);
						}),
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

				const customModules = await this._getCustomModules(ws.uri);
				const customModulesMap = new Map<string, string>();
				for (const m of customModules) {
					if (m.id && m.color) {
						customModulesMap.set(m.id.toLowerCase(), m.color);
						customModulesMap.set(m.name.toLowerCase(), m.color);
					}
				}

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
				} else if (ws.detectedType === 'workflow') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
					wsIcon.style.color = '#0d9488';
					badgeText = 'WORKFLOW';
					badgeBg = 'rgba(13, 148, 136, 0.2)';
					badgeFg = '#0d9488';
				} else if (ws.detectedType === 'analysis') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));
					wsIcon.style.color = '#34d399';
					badgeText = 'ANALYSIS';
					badgeBg = 'rgba(52, 211, 153, 0.2)';
					badgeFg = '#34d399';
				} else if (ws.detectedType && ws.detectedType !== 'workspace' && ws.detectedType !== 'folder') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.package)));
					const customColor = customModulesMap.get(ws.detectedType.toLowerCase()) || getColorForName(ws.detectedType);
					wsIcon.style.color = customColor;
					badgeText = ws.detectedType.toUpperCase();
					badgeBg = hexToRgba(customColor, 0.2);
					badgeFg = customColor;
				} else {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
					wsIcon.style.color = ws.isMissing ? '#f87171' : 'inherit';
				}

				const wsSnapshot = this.workspacesExplorerService.getMetadataSnapshot(ws.uri);
				let wsPrefix = wsSnapshot?.entityCode || ws.code || '';
				if (!wsPrefix && wsSnapshot?.ticketId && wsSnapshot.ticketId.includes('-')) {
					wsPrefix = wsSnapshot.ticketId.split('-')[0];
				}
				if (!wsPrefix && wsSnapshot?.workspaceId && wsSnapshot.workspaceId.includes('-')) {
					wsPrefix = wsSnapshot.workspaceId.split('-')[0];
				}
				if (wsPrefix) {
					wsPrefix = wsPrefix.toUpperCase();
				}

				const wsTitle = wsSnapshot?.title || ws.name;
				const wsDisplayText = (wsPrefix && wsTitle && wsTitle !== wsPrefix) ? `${wsPrefix} ${wsTitle}` : (wsPrefix || wsTitle || ws.name);

				const wsTitleSpan = append(headerLeft, $('span', {
					style: 'font-weight: 600; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;'
				}));
				wsTitleSpan.innerText = wsDisplayText;
				wsTitleSpan.title = `${wsDisplayText} (${ws.uri.fsPath})`;

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

				// Single Click: Select workspace card, open its Domain Form in main editor area, and toggle expansion in-place
				cardHeader.onclick = async () => {
					this.selectedWorkspaceId = canonicalWsId;
					this.selectedItemId = canonicalWsId;

					if (this.expandedWorkspaces.has(canonicalWsId)) {
						this.expandedWorkspaces.delete(canonicalWsId);
					} else {
						this.expandedWorkspaces.add(canonicalWsId);
					}

					try {
						if (ws.detectedType === 'workflow') {
							await this.editorService.openEditor(new WorkflowEditorInput(ws.uri, ws.name), { pinned: true });
						} else {
							await this.editorService.openEditor(new EntityDetailEditorInput(ws.uri, ws.name), { pinned: true });
						}
					} catch (err) {
						console.error('Failed to open Workspace domain editor', err);
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

					await this.renderChildrenTree(childrenContainer, ws.uri, canonicalWsId, 1, currentVersion, customModulesMap);
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
		currentVersion: number,
		customModulesMap?: Map<string, string>
	): Promise<void> {
		if (!customModulesMap) {
			const mods = await this._getCustomModules(folderUri);
			customModulesMap = new Map<string, string>();
			for (const m of mods) {
				if (m.id && m.color) {
					customModulesMap.set(m.id.toLowerCase(), m.color);
					customModulesMap.set(m.name.toLowerCase(), m.color);
				}
			}
		}

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
			const isDirectory = child.type !== 'file';
			const isExpanded = isDirectory && this.expandedWorkspaces.has(canonicalChildId);
			const isChildSelected = this.selectedWorkspaceId === parentWsId && this.selectedItemId === canonicalChildId;

			const childRow = append(parentContainer, $('.child-item-row'));
			childRow.style.display = 'flex';
			childRow.style.alignItems = 'center';
			childRow.style.justifyContent = 'space-between';
			childRow.style.padding = `4px 6px 4px ${depth * 12}px`;
			childRow.style.borderRadius = '4px';
			childRow.style.cursor = 'pointer';

			let isDraggable = true;
			if (child.type === 'file' || child.type === 'folder') {
				isDraggable = false;
			}
			const activeInput = this.editorService.activeEditor;
			if (activeInput instanceof WorkflowEditorInput) {
				const activeWorkflowUriStr = activeInput.workflowUri.toString().toLowerCase();
				if (child.uri.toString().toLowerCase() === activeWorkflowUriStr) {
					isDraggable = false;
				}
			}

			if (isDraggable) {
				childRow.draggable = true;
				childRow.ondragstart = (e) => {
					e.stopPropagation();
					if (e.dataTransfer) {
						e.dataTransfer.setData('text/plain', `any-agent-import:${child.type}:${child.name}`);
						e.dataTransfer.effectAllowed = 'copy';
					}
					childRow.style.opacity = '0.5';
				};
				childRow.ondragend = () => {
					childRow.style.opacity = '1';
				};
			}

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
					childActions.push(new Action('create_sub_entity', `Create Sub-Entity...`, ThemeIcon.asClassName(Codicon.add), true, () => {
						this.showCreateResourceModal(child.uri, child.name);
					}));
				}

				if (child.type !== 'file' && child.type !== 'folder') {
					childActions.push(new Action('edit_child', 'Edit...', ThemeIcon.asClassName(Codicon.edit), true, async () => {
						if (child.type === 'workflow') {
							await this.editorService.openEditor(new WorkflowEditorInput(child.uri, child.name), { pinned: true });
						} else {
							await this.editorService.openEditor(new EntityDetailEditorInput(child.uri, child.name, true), { pinned: true });
						}
					}));
				}

				childActions.push(
					new Action('show_in_explorer', 'Show in Explorer', ThemeIcon.asClassName(Codicon.folderLibrary), true, async () => {
						await this.showInExplorer(child.uri);
					}),
					new Action('reveal_child_in_os', isMacintosh ? 'Reveal in Finder' : 'Reveal in Explorer', ThemeIcon.asClassName(Codicon.folder), true, async () => {
						try {
							await this.commandService.executeCommand('revealFileInOS', child.uri);
						} catch {
							this.notificationService.warn(`Path does not exist: ${child.uri.fsPath}`);
						}
					})
				);

				if (child.type === 'file') {
					childActions.push(
						new Action('open_child', 'Open File', ThemeIcon.asClassName(Codicon.goToFile), true, async () => {
							if (child.uri.path.toLowerCase().endsWith('.md')) {
								await this.commandService.executeCommand('markdown.showPreview', child.uri);
							} else {
								await this.openerService.open(child.uri);
							}
						})
					);
				}

				if (child.type !== 'file' && child.type !== 'folder') {
					childActions.push(
						new Action('remove_child_from_ws', 'Remove from Workspace', ThemeIcon.asClassName(Codicon.close), true, async () => {
							const confirm = await this.dialogService.confirm({
								type: 'warning',
								message: `Are you sure you want to remove '${child.name}' from the workspace?`,
								detail: `This will keep the physical folder intact but rename it to '~${child.name}', making it ignored in the explorer.`,
								primaryButton: 'Remove'
							});
							if (confirm.confirmed) {
								try {
									const parentDir = dirname(child.uri);
									const newName = '~' + child.name;
									const newUri = URI.joinPath(parentDir, newName);
									
									// 1. Rename folder on disk
									if (await this.fileService.exists(child.uri)) {
										await this.fileService.move(child.uri, newUri, true);
									}
									
									// 2. Remove snapshot from global DB
									await this.workspacesExplorerService.removeSnapshot(child.uri);
									
									// 3. If it is registered as an agent in agentsManagerService, remove it too
									if (child.type === 'agent' && this.agentsManagerService) {
										const agentsList = await this.agentsManagerService.getAgents();
										const matchingAgent = agentsList.find(a => a.folderPath === child.uri.fsPath);
										if (matchingAgent) {
											await this.agentsManagerService.removeAgent(matchingAgent.id);
										}
									}
									
									this.notificationService.info(`Removed '${child.name}' from workspace.`);
									this.renderContent();
								} catch (err) {
									this.notificationService.error(`Failed to remove from workspace: ${err}`);
								}
							}
						})
					);
				}

				childActions.push(
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
								// Remove snapshot from global DB
								await this.workspacesExplorerService.removeSnapshot(child.uri);

								// If it is registered as an agent in agentsManagerService, remove it too
								if (child.type === 'agent' && this.agentsManagerService) {
									const agentsList = await this.agentsManagerService.getAgents();
									const matchingAgent = agentsList.find(a => a.folderPath === child.uri.fsPath);
									if (matchingAgent) {
										await this.agentsManagerService.removeAgent(matchingAgent.id);
									}
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
			} else if (child.type === 'workflow') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
				childIcon.style.color = '#0d9488';
				badgeText = 'WORKFLOW';
				badgeBg = 'rgba(13, 148, 136, 0.2)';
				badgeFg = '#0d9488';
			} else if (child.type !== 'folder' && child.type !== 'file') {
				// Custom Module!
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.package)));
				const color = customModulesMap.get(child.type.toLowerCase()) || getColorForName(child.type);
				childIcon.style.color = color;
				badgeText = child.type.toUpperCase();
				badgeBg = hexToRgba(color, 0.2);
				badgeFg = color;
			} else if (child.type === 'folder') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.folder)));
				childIcon.style.opacity = '0.8';
			} else {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.file)));
				childIcon.style.opacity = '0.7';
			}

			const childSnapshot = this.workspacesExplorerService.getMetadataSnapshot(child.uri);
			const childTicketId = childSnapshot?.ticketId || child.name;
			const childTitle = childSnapshot?.title || '';
			const childDisplayText = (childTitle && childTitle !== childTicketId) ? `${childTicketId} ${childTitle}` : (childTicketId || child.name);

			const childTitleSpan = append(childLeft, $('span', {
				style: 'font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;'
			}));
			childTitleSpan.innerText = childDisplayText;
			childTitleSpan.title = `${childDisplayText} (${child.uri.fsPath})`;

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
					// Also check if directory contains a primary md file like .agents folder or legacy files
					const configDir = URI.joinPath(child.uri, '.agents');
					const legacyConfigExists = await this.fileService.exists(URI.joinPath(child.uri, 'instruction.md')) || await this.fileService.exists(URI.joinPath(child.uri, 'README.md'));
					if (await this.fileService.exists(configDir) || legacyConfigExists) {
						if (child.type === 'workflow') {
							await this.editorService.openEditor(new WorkflowEditorInput(child.uri, child.name), { pinned: true });
						} else {
							await this.editorService.openEditor(new EntityDetailEditorInput(child.uri, child.name), { pinned: true });
						}
					}
				} else if (child.uri.path.toLowerCase().endsWith('.md')) {
					const fileName = child.uri.path.split('/').pop() || '';
					const parentUri = dirname(child.uri);
					const isAgentMd = parentUri.path.endsWith('.agents') || ['instruction.md', 'readme.md', 'work_log.md', 'worklog.md', 'ticket.md', 'workspace.md'].includes(fileName.toLowerCase());
					if (isAgentMd) {
						let entityUri = parentUri;
						if (parentUri.path.endsWith('.agents')) {
							entityUri = dirname(parentUri);
						}
						const entityName = entityUri.path.split('/').filter(Boolean).pop() || 'Entity';
						let isWorkflow = fileName.toLowerCase() === 'workflow.md' || entityUri.path.toLowerCase().includes('workflow');
						if (fileName.toLowerCase() === 'ticket.md') {
							const detectedType = await this.workspacesExplorerService.detectCustomEntityTypeFromDisk(entityUri);
							isWorkflow = detectedType === 'workflow';
						}
						if (isWorkflow) {
							await this.editorService.openEditor(new WorkflowEditorInput(entityUri, entityName), { pinned: true });
						} else {
							await this.editorService.openEditor(new EntityDetailEditorInput(entityUri, entityName), { pinned: true });
						}
					} else {
						await this.commandService.executeCommand('markdown.showPreview', child.uri);
					}
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
				await this.renderChildrenTree(subContainer, child.uri, parentWsId, depth + 1, currentVersion, customModulesMap);
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
		modal.style.maxWidth = '680px';
		modal.style.maxHeight = '86vh';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.18)';
		modal.style.borderRadius = '12px';
		modal.style.padding = '24px 28px';
		modal.style.boxShadow = '0 20px 50px rgba(0,0,0,0.75)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.overflow = 'hidden';
		modal.style.gap = '14px';

		// Modal Header (Fixed at top)
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';
		modalHeader.style.flexShrink = '0';
		modalHeader.style.paddingBottom = '4px';

		const modalTitle = append(modalHeader, $('div', { style: 'font-weight: 600; font-size: 14.5px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
		append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
		append(modalTitle, $('span', {}, 'Create New Workspace'));

		const closeIcon = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeIcon.style.cursor = 'pointer';
		closeIcon.style.fontSize = '14px';
		closeIcon.style.opacity = '0.7';
		closeIcon.onclick = () => overlay.remove();

		// Scrollable Body Container
		const modalBody = append(modal, $('.modal-body'));
		modalBody.style.flex = '1';
		modalBody.style.minHeight = '0';
		modalBody.style.overflowY = 'auto';
		modalBody.style.display = 'flex';
		modalBody.style.flexDirection = 'column';
		modalBody.style.gap = '16px';
		modalBody.style.paddingRight = '8px';

		// Row 1: Workspace Name & Workspace Title (2 Columns)
		const row1 = append(modalBody, $('.form-row'));
		row1.style.display = 'grid';
		row1.style.gridTemplateColumns = '1fr 1fr';
		row1.style.gap = '14px';

		const nameBox = append(row1, $('.form-group'));
		append(nameBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Workspace Name:'));
		const nameInput = append(nameBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		nameInput.placeholder = 'e.g., my_workspace';

		const titleBox = append(row1, $('.form-group'));
		append(titleBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Workspace Title:'));
		const titleInput = append(titleBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		titleInput.placeholder = 'e.g., My AI Workspace';

		// Row 2: Code Prefix & Workspace ID Preview (2 Columns)
		const row2 = append(modalBody, $('.form-row'));
		row2.style.display = 'grid';
		row2.style.gridTemplateColumns = '1fr 1fr';
		row2.style.gap = '14px';

		const codeBox = append(row2, $('.form-group'));
		append(codeBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Workspace Code Prefix:'));
		const codeInput = append(codeBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; text-transform: uppercase;'
		})) as HTMLInputElement;
		codeInput.placeholder = 'e.g., ABCD / FINO3';

		const wsIdBox = append(row2, $('.form-group'));
		append(wsIdBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Workspace ID (Ancestor Origin):'));
		const wsIdInput = append(wsIdBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); color: #38bdf8; box-sizing: border-box; font-family: monospace; font-weight: 600;'
		})) as HTMLInputElement;
		wsIdInput.readOnly = true;
		wsIdInput.placeholder = 'e.g., ABCD-0000';

		const updateWsId = () => {
			const rawCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
			wsIdInput.value = rawCode ? `${rawCode}-0000` : '';
		};

		nameInput.oninput = () => {
			const cleanName = nameInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
			if (cleanName.length >= 3 && !(codeInput as any).dataset.userEdited) {
				codeInput.value = cleanName.slice(0, 5);
			}
			updateWsId();
		};

		codeInput.oninput = () => {
			(codeInput as any).dataset.userEdited = 'true';
			updateWsId();
		};

		// Location Path Picker (Full width)
		const pathBox = append(modalBody, $('.form-group'));
		append(pathBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Target Location Path:'));

		const pathRow = append(pathBox, $('.path-input-row'));
		pathRow.style.display = 'flex';
		pathRow.style.gap = '8px';

		let selectedPathUri: URI | undefined;

		const pathInput = append(pathRow, $('input.monaco-inputbox', {
			style: 'flex: 1; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		pathInput.placeholder = 'Select or enter folder path...';

		const browseBtn = append(pathRow, $('button.monaco-button', {
			style: 'padding: 7px 14px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit; white-space: nowrap;'
		}));
		browseBtn.innerText = 'Browse...';
		browseBtn.onclick = async () => {
			const res = await this.fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				title: 'Select Location Path (Workspace folder will be created inside this path)'
			});
			if (res && res.length > 0) {
				selectedPathUri = res[0];
				pathInput.value = res[0].fsPath;

				if (!nameInput.value.trim()) {
					const defaultName = res[0].path.split('/').filter(Boolean).pop() || 'my_workspace';
					nameInput.value = defaultName;
					const cleanName = defaultName.toUpperCase().replace(/[^A-Z0-9]/g, '');
					if (cleanName.length >= 3 && !(codeInput as any).dataset.userEdited) {
						codeInput.value = cleanName.slice(0, 5);
					}
					updateWsId();
				}
			}
		};

		// Description Input (Full width, multi-line textarea)
		const descBox = append(modalBody, $('.form-group'));
		append(descBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Description (Optional):'));
		const descInput = append(descBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
		})) as HTMLTextAreaElement;
		descInput.placeholder = 'Brief purpose or detailed description of this workspace...';

		// Status (Clean row)
		const statusBox = append(modalBody, $('.form-group'));
		append(statusBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Status:'));
		const statusBadgeWrapper = append(statusBox, $('div', { style: 'padding: 2px 0;' }));
		append(statusBadgeWrapper, $('span', {
			style: 'display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(129, 140, 248, 0.18); color: #818cf8; border: 1px solid rgba(129, 140, 248, 0.4);'
		}, 'Todo'));

		// Priority Selection Box (5 Levels Flat Grid with Color Dots)
		const priorityBox = append(modalBody, $('.form-group'));
		append(priorityBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 6px; font-weight: 500;' }, 'Priority Level (5 Levels):'));

		let selectedPriority = 'Medium';
		const priorities = [
			{ level: 'Very High', label: 'Very High', color: '#f43f5e' },
			{ level: 'High', label: 'High', color: '#fb923c' },
			{ level: 'Medium', label: 'Medium', color: '#38bdf8' },
			{ level: 'Low', label: 'Low', color: '#34d399' },
			{ level: 'Very Low', label: 'Very Low', color: '#2dd4bf' }
		];

		const priorityGrid = append(priorityBox, $('.priority-grid'));
		priorityGrid.style.display = 'grid';
		priorityGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
		priorityGrid.style.gap = '8px';

		const priorityButtons: HTMLElement[] = [];
		for (const p of priorities) {
			const pBtn = append(priorityGrid, $('.priority-option-btn'));
			pBtn.style.padding = '7px 8px';
			pBtn.style.borderRadius = '6px';
			pBtn.style.cursor = 'pointer';
			pBtn.style.fontSize = '11.5px';
			pBtn.style.fontWeight = '600';
			pBtn.style.display = 'flex';
			pBtn.style.alignItems = 'center';
			pBtn.style.justifyContent = 'center';
			pBtn.style.gap = '6px';
			pBtn.style.border = p.level === selectedPriority ? `1px solid ${p.color}` : '1px solid rgba(255,255,255,0.08)';
			pBtn.style.backgroundColor = p.level === selectedPriority ? `${p.color}25` : 'rgba(255,255,255,0.03)';
			pBtn.style.color = p.level === selectedPriority ? p.color : 'inherit';
			pBtn.style.transition = 'all 0.15s ease';

			const dot = append(pBtn, $('span.priority-dot'));
			dot.style.display = 'inline-block';
			dot.style.width = '7px';
			dot.style.height = '7px';
			dot.style.borderRadius = '50%';
			dot.style.backgroundColor = p.color;
			dot.style.boxShadow = p.level === selectedPriority ? `0 0 6px ${p.color}` : 'none';
			dot.style.flexShrink = '0';

			const txt = append(pBtn, $('span'));
			txt.innerText = p.label;

			pBtn.onclick = () => {
				selectedPriority = p.level;
				for (let i = 0; i < priorityButtons.length; i++) {
					const isSel = priorities[i].level === selectedPriority;
					const btnEl = priorityButtons[i];
					const dotEl = btnEl.querySelector('.priority-dot') as HTMLElement;
					btnEl.style.border = isSel ? `1px solid ${priorities[i].color}` : '1px solid rgba(255,255,255,0.08)';
					btnEl.style.backgroundColor = isSel ? `${priorities[i].color}25` : 'rgba(255,255,255,0.03)';
					btnEl.style.color = isSel ? priorities[i].color : 'inherit';
					if (dotEl) {
						dotEl.style.boxShadow = isSel ? `0 0 6px ${priorities[i].color}` : 'none';
					}
				}
			};

			priorityButtons.push(pBtn);
		}

		// Current AI Agent Dropdown (Full width)
		const agentBox = append(modalBody, $('.form-group'));
		append(agentBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Current AI Agent (Optional):'));
		const agentSelect = append(agentBox, $('select.monaco-select-box', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; cursor: pointer;'
		})) as HTMLSelectElement;
		append(agentSelect, $('option', { value: '' }, '🤖 None (Unassigned)'));

		let availableAgents: any[] = [];
		if (this.agentsManagerService) {
			this.agentsManagerService.getAgents().then(agents => {
				availableAgents = agents || [];
				for (const ag of availableAgents) {
					append(agentSelect, $('option', { value: ag.id }, `🤖 ${ag.name} (${ag.role || 'Agent'})`));
				}
			}).catch(() => {});
		}

		// Link To Input (Full width)
		const linkBox = append(modalBody, $('.form-group'));
		append(linkBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Link To (Optional Ticket ID / Resource):'));
		const linkInput = append(linkBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		linkInput.placeholder = 'e.g., None, PROJ-0001, or URL';

		// Attachments Section (Full width)
		const attachBox = append(modalBody, $('.form-group'));
		append(attachBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Attachments (Optional):'));
		const attachRow = append(attachBox, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
		const attachTagsContainer = append(attachRow, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px;' }));

		const selectedAttachments: URI[] = [];
		const renderAttachmentTags = () => {
			clearNode(attachTagsContainer);
			if (selectedAttachments.length === 0) {
				append(attachTagsContainer, $('span', { style: 'font-size: 11px; opacity: 0.5; font-style: italic;' }, 'No attachments added.'));
			} else {
				for (let i = 0; i < selectedAttachments.length; i++) {
					const attUri = selectedAttachments[i];
					const fileName = attUri.path.split('/').filter(Boolean).pop() || 'file';
					const tag = append(attachTagsContainer, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; font-size: 11.5px;'
					}));
					append(tag, $('span', {}, `📄 ${fileName}`));
					const delBtn = append(tag, $('span', { style: 'cursor: pointer; opacity: 0.6; margin-left: 4px;' }, '✕'));
					delBtn.onclick = () => {
						selectedAttachments.splice(i, 1);
						renderAttachmentTags();
					};
				}
			}
		};
		renderAttachmentTags();

		const addAttachBtn = append(attachRow, $('button.monaco-button', {
			style: 'align-self: flex-start; padding: 5px 12px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		addAttachBtn.innerText = '+ Add Attachment File...';
		addAttachBtn.onclick = async () => {
			const res = await this.fileDialogService.showOpenDialog({
				canSelectFolders: false,
				canSelectFiles: true,
				canSelectMany: true,
				title: 'Select Attachment Files to link with this workspace'
			});
			if (res && res.length > 0) {
				for (const u of res) {
					if (!selectedAttachments.some(existing => existing.toString() === u.toString())) {
						selectedAttachments.push(u);
					}
				}
				renderAttachmentTags();
			}
		};

		// Ticket Type Prompt (Pre-populated)
		const typePromptBox = append(modalBody, $('.form-group'));
		append(typePromptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Ticket Type Prompt (Global Workspace Rules):'));
		const typePromptInput = append(typePromptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: var(--vscode-editor-font-family, monospace);'
		})) as HTMLTextAreaElement;
		typePromptInput.value = 'A workspace is the root environment container. Manage sub-entities, repository structure, and lifecycle.';

		// Ticket Prompt (Instance specific prompt)
		const ticketPromptBox = append(modalBody, $('.form-group'));
		append(ticketPromptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Ticket Prompt (Specific Instruction / Rule):'));
		const ticketPromptInput = append(ticketPromptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: var(--vscode-editor-font-family, monospace);'
		})) as HTMLTextAreaElement;
		ticketPromptInput.placeholder = 'Optional custom instruction or rules for this specific workspace...';

		// Action Buttons Row (Fixed footer pinned at bottom)
		const actionsRow = append(modal, $('.modal-actions-row'));
		actionsRow.style.display = 'flex';
		actionsRow.style.justifyContent = 'flex-end';
		actionsRow.style.alignItems = 'center';
		actionsRow.style.gap = '10px';
		actionsRow.style.paddingTop = '12px';
		actionsRow.style.borderTop = '1px solid rgba(255,255,255,0.08)';
		actionsRow.style.flexShrink = '0';

		const cancelBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 6px 16px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();

		const submitBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 7px 18px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
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
				const wsCode = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
				const assignedAgentId = agentSelect.value || undefined;
				const matchingAgent = availableAgents.find(a => a.id === assignedAgentId);

				const res = await this.workspacesExplorerService.createWorkspace({
					name,
					title: titleInput.value.trim() || name,
					workspaceId: wsIdInput.value.trim() || (wsCode ? `${wsCode}-0000` : undefined),
					targetParentUri: parentUri,
					description: descInput.value.trim(),
					code: wsCode,
					type: 'workspace',
					status: 'Todo',
					priority: selectedPriority,
					assignedAgentId: assignedAgentId,
					assignedAgentName: matchingAgent ? matchingAgent.name : undefined,
					linkTo: linkInput.value.trim() || undefined,
					attachments: selectedAttachments.length > 0 ? selectedAttachments : undefined,
					typePrompt: typePromptInput.value.trim() || undefined,
					ticketPrompt: ticketPromptInput.value.trim() || undefined
				});

				overlay.remove();

				if (res.alreadyExists) {
					this.notificationService.warn(`Workspace already exists at '${res.uri.fsPath}'. Opening workspace...`);
				} else {
					this.notificationService.info(`Created new workspace '${name}' with workspace.md & standard files.`);
				}

				this.expandedWorkspaces.add(res.uri.toString());
				const workspaceMdUri = URI.joinPath(res.uri, 'workspace.md');
				await this.commandService.executeCommand('markdown.showPreview', workspaceMdUri);
			} catch (err) {
				this.notificationService.error(`Failed to create workspace: ${err}`);
			}
		};
	}

	/**
	 * Renders a spacious Create Resource Modal Overlay under the target Workspace or Folder
	 */
	public showCreateResourceModal(target: IWorkspaceItem | URI, parentName?: string, onSuccess?: (type: string, name: string) => void): void {
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

		let clickListener: ((e: MouseEvent) => void) | undefined;
		const removeOverlay = () => {
			if (clickListener) {
				document.removeEventListener('click', clickListener);
			}
			overlay.remove();
		};

		const modal = append(overlay, $('.create-resource-modal'));
		modal.style.width = '100%';
		modal.style.maxWidth = '640px';
		modal.style.maxHeight = '88vh';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.18)';
		modal.style.borderRadius = '12px';
		modal.style.padding = '24px 28px';
		modal.style.boxShadow = '0 16px 40px rgba(0,0,0,0.7)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '16px';

		// Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';

		const modalTitle = append(modalHeader, $('div', { style: 'font-weight: 600; font-size: 14px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
		append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.folderActive)));
		append(modalTitle, $('span', {}, `Create Sub-Entity in ${targetName}`));

		const closeIcon = append(modalHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
		closeIcon.style.cursor = 'pointer';
		closeIcon.style.fontSize = '14px';
		closeIcon.style.opacity = '0.7';
		closeIcon.onclick = () => removeOverlay();

		// Scrollable Body Container
		const modalBody = append(modal, $('.modal-body'));
		modalBody.style.flex = '1';
		modalBody.style.overflowY = 'auto';
		modalBody.style.display = 'flex';
		modalBody.style.flexDirection = 'column';
		modalBody.style.gap = '16px';
		modalBody.style.paddingRight = '6px';

		// Category / Type Selection Row
		const categoryBox = append(modalBody, $('.form-group'));
		const labelRow = append(categoryBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;' }));
		append(labelRow, $('label', { style: 'font-size: 11.5px; opacity: 0.85; font-weight: 500;' }, 'Select Sub-Entity Type:'));

		const manageBtn = append(labelRow, $('span', {
			style: 'font-size: 11px; color: #38bdf8; cursor: pointer; display: flex; align-items: center; gap: 4px; opacity: 0.85; transition: opacity 0.15s ease;'
		}));
		manageBtn.textContent = '⚙️ Manage Custom Modules';
		manageBtn.onmouseenter = () => manageBtn.style.opacity = '1.0';
		manageBtn.onmouseleave = () => manageBtn.style.opacity = '0.85';

		let selectedType: string = 'job';
		const categoryGrid = append(categoryBox, $('.category-grid'));

		const typeButtons: HTMLElement[] = [];
		let typesList: { type: string; label: string; icon: ThemeIcon; color: string; bg: string }[] = [];



		const renderTypeGrid = async () => {
			clearNode(categoryGrid);
			categoryGrid.style.display = 'grid';
			categoryGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
			categoryGrid.style.gap = '8px';
			typeButtons.length = 0;

			const baseTypes = [
				{ type: 'job', label: 'Job', icon: Codicon.briefcase, color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.18)' },
				{ type: 'task', label: 'Task', icon: Codicon.tasklist, color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.18)' },
				{ type: 'project', label: 'Project', icon: Codicon.project, color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.18)' },
				{ type: 'workflow', label: 'Workflow', icon: Codicon.githubAction, color: '#0d9488', bg: 'rgba(13, 148, 136, 0.18)' },
				{ type: 'case', label: 'Case', icon: Codicon.checklist, color: '#f472b6', bg: 'rgba(244, 114, 182, 0.18)' },
				{ type: 'agent', label: 'AI Agent', icon: Codicon.robot, color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)' },
				{ type: 'issue', label: 'Issue', icon: Codicon.bug, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.18)' },
				{ type: 'analysis', label: 'Analysis', icon: Codicon.graph, color: '#34d399', bg: 'rgba(52, 211, 153, 0.18)' },
				{ type: 'folder', label: 'Folder', icon: Codicon.folder, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.18)' },
				{ type: 'file', label: 'File', icon: Codicon.file, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.18)' }
			];

			let customModules: ICustomModule[] = [];
			try {
				customModules = (await this._getCustomModules(targetUri)).filter(m => !m.isDeprecated);
			} catch (err) {
				console.error('Error fetching custom modules:', err);
			}

			const customTypes = customModules.map(m => ({
				type: m.id,
				label: m.name,
				icon: Codicon.package,
				color: m.color,
				bg: hexToRgba(m.color, 0.18)
			}));

			typesList = [...baseTypes, ...customTypes];

			if (!typesList.some(t => t.type === selectedType)) {
				selectedType = 'job';
			}

			for (const t of typesList) {
				const btn = append(categoryGrid, $('.type-option-btn'));
				btn.style.padding = '8px 10px';
				btn.style.borderRadius = '6px';
				btn.style.cursor = 'pointer';
				btn.style.fontSize = '11.5px';
				btn.style.display = 'flex';
				btn.style.alignItems = 'center';
				btn.style.justifyContent = 'center';
				btn.style.gap = '6px';
				btn.style.border = t.type === selectedType ? `1px solid ${t.color}` : '1px solid rgba(255,255,255,0.08)';
				btn.style.backgroundColor = t.type === selectedType ? t.bg : 'rgba(255,255,255,0.03)';
				btn.style.transition = 'all 0.15s ease';

				const iconSpan = append(btn, $('span' + ThemeIcon.asCSSSelector(t.icon)));
				iconSpan.style.color = t.color;
				iconSpan.style.fontSize = '14px';

				append(btn, $('span', {}, t.label));

				btn.onclick = async () => {
					selectedType = t.type;
					for (let i = 0; i < typeButtons.length; i++) {
						const isSelected = typesList[i].type === selectedType;
						typeButtons[i].style.border = isSelected ? `1px solid ${typesList[i].color}` : '1px solid rgba(255,255,255,0.08)';
						typeButtons[i].style.backgroundColor = isSelected ? typesList[i].bg : 'rgba(255,255,255,0.03)';
					}
					await refreshNameAndBadge();
				};

				typeButtons.push(btn);
			}
		};

		manageBtn.onclick = () => {
			this._openCustomModulesManager(targetUri, () => {
				renderTypeGrid().then(() => {
					refreshNameAndBadge();
				});
			});
		};

		renderTypeGrid().then(() => {
			refreshNameAndBadge();
		});

		// Entity Code Prefix Override Box
		const codeBox = append(modalBody, $('.form-group'));
		append(codeBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Entity Code Prefix (Optional Override):'));
		const codeInput = append(codeBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; text-transform: uppercase;'
		})) as HTMLInputElement;
		codeInput.placeholder = 'Inherited from parent (leave blank to inherit)';

		// Ticket ID Live Badge
		const badgeBox = append(modalBody, $('.form-group'));
		const previewBadge = append(badgeBox, $('div', {
			style: 'font-size: 11.5px; font-weight: 600; color: #38bdf8; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 6px; padding: 8px 12px; text-align: center;'
		}));
		previewBadge.innerText = 'Generated Ticket ID: calculating...';

		// Resource Name Input
		const nameBox = append(modalBody, $('.form-group'));
		const nameLabel = append(nameBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Entity Folder Name / Ticket ID:'));
		const nameInput = append(nameBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;

		// Warning banner element for duplicate or invalid names
		const warningBanner = append(nameBox, $('div', {
			style: 'font-size: 11px; color: #ef4444; margin-top: 4px; display: none; line-height: 1.3;'
		}));

		// Title Input (Required for non-folder/file)
		const titleBox = append(modalBody, $('.form-group'));
		const titleLabel = append(titleBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Title (Required):'));
		const titleInput = append(titleBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		titleInput.placeholder = 'e.g. Core Engine API, Fix Auth Bug, User Authentication';

		// Description Input (Multiline Textarea)
		const descBox = append(modalBody, $('.form-group'));
		const descLabel = append(descBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Description:'));
		const descInput = append(descBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
		})) as HTMLTextAreaElement;
		descInput.placeholder = 'Brief purpose of this entity...';

		// Status (Clean badge row)
		const statusBox = append(modalBody, $('.form-group'));
		append(statusBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Status:'));
		const statusBadgeWrapper = append(statusBox, $('div', { style: 'padding: 2px 0;' }));
		append(statusBadgeWrapper, $('span', {
			style: 'display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(129, 140, 248, 0.18); color: #818cf8; border: 1px solid rgba(129, 140, 248, 0.4);'
		}, 'Todo'));

		// Custom Fields Box for Custom Modules
		const customFieldsBox = append(modalBody, $('.custom-fields-box', { style: 'display: flex; flex-direction: column; gap: 10px; margin-top: 8px;' }));

		// Base Agent to Inherit From (Optional)
		const baseAgentBox = append(modalBody, $('.form-group'));
		append(baseAgentBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Base Agent to Inherit From (Optional):'));
		const baseAgentSelect = append(baseAgentBox, $('select.monaco-select', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; box-sizing: border-box;'
		})) as HTMLSelectElement;

		append(baseAgentSelect, $('option', { value: '' }, '-- Create from Scratch (No Base Agent) --'));

		this.agentsManagerService.getAgents().then(agents => {
			for (const ag of agents) {
				append(baseAgentSelect, $('option', { value: ag.id }, `🤖 ${ag.name} (${ag.model?.modelId || 'gemini-1.5-flash'})`));
			}
		}).catch(() => { });

		// AI Agent Credential Box
		const credBox = append(modalBody, $('.form-group'));
		append(credBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'API Connection Credential:'));
		const credSelect = append(credBox, $('select.monaco-select', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLSelectElement;

		const credHelp = append(credBox, $('div', {
			style: 'font-size: 11px; color: var(--vscode-descriptionForeground, #888888); margin-top: 4px; line-height: 1.4;'
		}));
		credHelp.appendChild(document.createTextNode('To connect custom providers (Ollama, DeepSeek, OpenAI, Claude), configure keys in '));
		const helpLink = append(credHelp, $('span', {
			style: 'color:var(--vscode-textLink-foreground,#38bdf8);cursor:pointer;text-decoration:underline;'
		}));
		helpLink.textContent = 'Account & Security Preferences -> AI LLM Providers';
		credHelp.appendChild(document.createTextNode('.'));

		helpLink.onclick = () => {
			removeOverlay();
			const dialog = this.instantiationService.createInstance(AccountManagementDialog);
			dialog.show('Models');
		};

		// AI Agent Model Box
		const modelBox = append(modalBody, $('.form-group', { style: 'position: relative;' }));
		append(modelBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'AI Model:'));
		const modelInputContainer = append(modelBox, $('.model-input-container', {
			style: 'position: relative; width: 100%;'
		}));
		const modelInput = append(modelInputContainer, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 30px 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; outline: none;'
		})) as HTMLInputElement;
		modelInput.placeholder = 'Search model or type custom ID...';

		const modelArrow = append(modelInputContainer, $('div', {
			style: 'position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 8px; color: var(--vscode-descriptionForeground, #888888); cursor: pointer; pointer-events: none;'
		}));
		modelArrow.textContent = '▼';

		const modelDropdown = append(modelBox, $('.model-search-dropdown', {
			style: 'position: absolute; top: 100%; left: 0; width: 100%; max-height: 160px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15)); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 100001; display: none; margin-top: 4px; box-sizing: border-box;'
		}));

		// AI Agent System Prompt Box
		const promptBox = append(modalBody, $('.form-group'));
		append(promptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'System Prompt / Core Instructions:'));
		const promptInput = append(promptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; min-height: 100px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; outline: none; resize: vertical; font-family: var(--vscode-editor-font-family, monospace);'
		})) as HTMLTextAreaElement;
		promptInput.placeholder = 'e.g. You are the Lead Architect. Maintain modular design, clear contracts, and update instruction.md files...';

		let savedCredentials: IAgentCredential[] = [];
		let availableModels: { id: string; label: string }[] = [];
		let isFiltering = false;

		const updateModelsList = () => {
			const activeId = credSelect.value;
			if (activeId === 'default' || activeId === 'none') {
				availableModels = [
					{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
					{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
					{ id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
					{ id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
					{ id: 'gpt-4o', label: 'GPT-4o' },
					{ id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
					{ id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' }
				];
				return;
			}
			const cred = savedCredentials.find(c => c.id === activeId);
			if (!cred) {
				availableModels = [];
				return;
			}
			const list = cred.cachedModels || [];
			availableModels = list.map((m: string) => ({ id: m, label: m }));
		};

		const renderFilteredDropdown = () => {
			clearNode(modelDropdown);
			const query = isFiltering ? modelInput.value.toLowerCase().trim() : '';

			const filtered = availableModels.filter(m => {
				if (!query) return true;
				const matchString = `${m.id} ${m.label}`.toLowerCase();
				let queryIndex = 0;
				for (let i = 0; i < matchString.length; i++) {
					if (matchString[i] === query[queryIndex]) {
						queryIndex++;
						if (queryIndex === query.length) return true;
					}
				}
				return false;
			});

			if (filtered.length === 0) {
				const noMatch = append(modelDropdown, $('.model-dropdown-item', {
					style: 'padding: 8px 12px; color: #888888; font-style: italic; font-size: 11px;'
				}));
				noMatch.textContent = 'No matching models. Type to use custom ID.';
				return;
			}

			filtered.forEach(m => {
				const item = append(modelDropdown, $('.model-dropdown-item', {
					style: 'padding: 8px 12px; cursor: pointer; transition: background 80ms ease; font-size: 11.5px; border-bottom: 1px solid rgba(255,255,255,0.02); color: var(--vscode-editorWidget-foreground, inherit); line-height: 1.4;'
				}));
				item.textContent = m.label;
				item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'; };
				item.onmouseleave = () => { item.style.background = 'transparent'; };
				item.onclick = (e) => {
					e.stopPropagation();
					modelInput.value = m.id;
					modelDropdown.style.display = 'none';
				};
			});
		};

		this.instantiationService.invokeFunction(async (accessor) => {
			const credentialService = accessor.get(IAgentCredentialService);
			savedCredentials = await credentialService.getCredentials();

			clearNode(credSelect);
			if (savedCredentials.length === 0) {
				const opt = append(credSelect, $('option', { value: 'none' }, 'No Credentials Configured (click link below to configure)')) as HTMLOptionElement;
				opt.disabled = true;
				opt.selected = true;
			} else {
				for (let i = 0; i < savedCredentials.length; i++) {
					const cred = savedCredentials[i];
					const displayName = cred.isEnabled !== false ? `${cred.name} (${cred.providerId})` : `${cred.name} (${cred.providerId}) [Disabled]`;
					const opt = append(credSelect, $('option', { value: cred.id }, displayName)) as HTMLOptionElement;
					if (cred.isEnabled === false) {
						opt.disabled = true;
					}
					if (i === 0 && cred.isEnabled !== false) {
						opt.selected = true;
					}
				}
			}
			updateModelsList();
			if (availableModels.length > 0) {
				modelInput.value = availableModels[0].id;
			}
		});

		modelInput.onclick = (e) => {
			e.stopPropagation();
			isFiltering = false;
			modelDropdown.style.display = 'block';
			renderFilteredDropdown();
		};

		modelInput.oninput = () => {
			isFiltering = true;
			modelDropdown.style.display = 'block';
			renderFilteredDropdown();
		};

		clickListener = (e: MouseEvent) => {
			if (e.target !== modelInput && !modelDropdown.contains(e.target as Node)) {
				modelDropdown.style.display = 'none';
			}
		};
		document.addEventListener('click', clickListener);

		credSelect.onchange = () => {
			isFiltering = false;
			updateModelsList();
			if (availableModels.length > 0) {
				modelInput.value = availableModels[0].id;
			}
			renderFilteredDropdown();
		};

		baseAgentSelect.onchange = async () => {
			const baseAgentId = baseAgentSelect.value;
			if (!baseAgentId) return;

			try {
				const baseAgent = await this.agentsManagerService.getAgent(baseAgentId);
				if (baseAgent) {
					if (baseAgent.model) {
						if (baseAgent.model.credentialId) {
							credSelect.value = baseAgent.model.credentialId;
							updateModelsList();
						} else {
							credSelect.value = 'default';
							updateModelsList();
						}
						modelInput.value = baseAgent.model.modelId;
					}
					promptInput.value = baseAgent.systemPrompt || '';
				}
			} catch {}
		};

		// Priority Selection Box (5 Levels)
		const priorityBox = append(modalBody, $('.form-group'));
		append(priorityBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 6px; font-weight: 500;' }, 'Priority Level (5 Levels):'));

		let selectedPriority = 'Medium';
		const priorities = [
			{ level: 'Very High', label: 'Very High', color: '#f43f5e' },
			{ level: 'High', label: 'High', color: '#fb923c' },
			{ level: 'Medium', label: 'Medium', color: '#38bdf8' },
			{ level: 'Low', label: 'Low', color: '#34d399' },
			{ level: 'Very Low', label: 'Very Low', color: '#2dd4bf' }
		];

		const priorityGrid = append(priorityBox, $('.priority-grid'));
		priorityGrid.style.display = 'grid';
		priorityGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
		priorityGrid.style.gap = '8px';

		const priorityButtons: HTMLElement[] = [];
		for (const p of priorities) {
			const pBtn = append(priorityGrid, $('.priority-option-btn'));
			pBtn.style.padding = '7px 8px';
			pBtn.style.borderRadius = '6px';
			pBtn.style.cursor = 'pointer';
			pBtn.style.fontSize = '11.5px';
			pBtn.style.fontWeight = '600';
			pBtn.style.display = 'flex';
			pBtn.style.alignItems = 'center';
			pBtn.style.justifyContent = 'center';
			pBtn.style.gap = '6px';
			pBtn.style.border = p.level === selectedPriority ? `1px solid ${p.color}` : '1px solid rgba(255,255,255,0.08)';
			pBtn.style.backgroundColor = p.level === selectedPriority ? `${p.color}25` : 'rgba(255,255,255,0.03)';
			pBtn.style.color = p.level === selectedPriority ? p.color : 'inherit';
			pBtn.style.transition = 'all 0.15s ease';

			const dot = append(pBtn, $('span.priority-dot'));
			dot.style.display = 'inline-block';
			dot.style.width = '7px';
			dot.style.height = '7px';
			dot.style.borderRadius = '50%';
			dot.style.backgroundColor = p.color;
			dot.style.boxShadow = p.level === selectedPriority ? `0 0 6px ${p.color}` : 'none';
			dot.style.flexShrink = '0';

			const txt = append(pBtn, $('span'));
			txt.innerText = p.label;

			pBtn.onclick = () => {
				selectedPriority = p.level;
				for (let i = 0; i < priorityButtons.length; i++) {
					const isSel = priorities[i].level === selectedPriority;
					const btnEl = priorityButtons[i];
					const dotEl = btnEl.querySelector('.priority-dot') as HTMLElement;
					btnEl.style.border = isSel ? `1px solid ${priorities[i].color}` : '1px solid rgba(255,255,255,0.08)';
					btnEl.style.backgroundColor = isSel ? `${priorities[i].color}25` : 'rgba(255,255,255,0.03)';
					btnEl.style.color = isSel ? priorities[i].color : 'inherit';
					if (dotEl) {
						dotEl.style.boxShadow = isSel ? `0 0 6px ${priorities[i].color}` : 'none';
					}
				}
			};
			priorityButtons.push(pBtn);
		}

		// AI Agent Assignment Box
		const agentBox = append(modalBody, $('.form-group'));
		append(agentBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Assign AI Agent (Involved Agent):'));

		const agentSelect = append(agentBox, $('select.monaco-select', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; box-sizing: border-box;'
		})) as HTMLSelectElement;

		append(agentSelect, $('option', { value: '' }, '-- Unassigned (No Agent) --'));

		this.agentsManagerService.getAgents().then(agents => {
			for (const ag of agents) {
				const opt = append(agentSelect, $('option', { value: ag.id }, `🤖 ${ag.name} (${ag.model?.modelId || 'gemini-1.5-flash'})`));
				opt.setAttribute('data-name', ag.name);
			}
		}).catch(() => { });

		// Link To Input (Optional)
		const linkBox = append(modalBody, $('.form-group'));
		append(linkBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Link To (Optional Ticket ID / Resource):'));
		const linkToInput = append(linkBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		linkToInput.placeholder = 'e.g., None, PROJ-0001, or URL';

		// Attachments Section (Optional)
		const attachBox = append(modalBody, $('.form-group'));
		append(attachBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Attachments (Optional):'));
		const attachRow = append(attachBox, $('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
		const attachTagsContainer = append(attachRow, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 6px;' }));

		const selectedAttachments: URI[] = [];
		const renderAttachmentTags = () => {
			clearNode(attachTagsContainer);
			if (selectedAttachments.length === 0) {
				append(attachTagsContainer, $('span', { style: 'font-size: 11px; opacity: 0.5; font-style: italic;' }, 'No attachments added.'));
			} else {
				for (let i = 0; i < selectedAttachments.length; i++) {
					const attUri = selectedAttachments[i];
					const fileName = attUri.path.split('/').filter(Boolean).pop() || 'file';
					const tag = append(attachTagsContainer, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 4px 10px; border-radius: 6px; font-size: 11.5px;'
					}));
					append(tag, $('span', {}, `📄 ${fileName}`));
					const delBtn = append(tag, $('span', { style: 'cursor: pointer; opacity: 0.6; margin-left: 4px;' }, '✕'));
					delBtn.onclick = () => {
						selectedAttachments.splice(i, 1);
						renderAttachmentTags();
					};
				}
			}
		};
		renderAttachmentTags();

		const addAttachBtn = append(attachRow, $('button.monaco-button', {
			style: 'align-self: flex-start; padding: 5px 12px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		addAttachBtn.innerText = '+ Add Attachment File...';
		addAttachBtn.onclick = async () => {
			const res = await this.fileDialogService.showOpenDialog({
				canSelectFolders: false,
				canSelectFiles: true,
				canSelectMany: true,
				title: 'Select Attachment Files to link with this entity'
			});
			if (res && res.length > 0) {
				for (const u of res) {
					if (!selectedAttachments.some(existing => existing.toString() === u.toString())) {
						selectedAttachments.push(u);
					}
				}
				renderAttachmentTags();
			}
		};

		const builtInTypePrompts: Record<string, string> = {
			workspace: 'A workspace is the root environment container. Manage sub-entities, repository structure, and lifecycle.',
			job: 'A job represents a high-level goal-oriented operational workflow. Break down tasks and record progress.',
			project: 'A project coordinates architecture, modules, implementation code, and verification.',
			task: 'A task is an actionable unit of engineering work. Implement changes cleanly and verify.',
			workflow: 'A workflow executes automated nodes, transitions, and AI pipelines.',
			agent: 'An AI agent operates autonomously following role constraints and tools.',
			case: 'A case verifies business scenarios, validation runs, and test plans.',
			issue: 'An issue tracks defects, root causes, and remediation actions.',
			analysis: 'An analysis documents architectural telemetry, research, and diagnostic findings.',
			note: 'A note captures memos, references, and knowledge-base items.',
			folder: '',
			file: ''
		};

		// Ticket Type Prompt Input
		const typePromptBox = append(modalBody, $('.form-group'));
		append(typePromptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Ticket Type Prompt (Global Type Rules):'));
		const typePromptInput = append(typePromptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: var(--vscode-editor-font-family, monospace);'
		})) as HTMLTextAreaElement;
		typePromptInput.placeholder = 'Global guidelines and prompt for this entity type...';

		// Agent Rule / Ticket Prompt Input
		const ruleBox = append(modalBody, $('.form-group'));
		append(ruleBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Ticket Prompt (Specific Instruction / Rule):'));
		const ruleInput = append(ruleBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
		})) as HTMLTextAreaElement;
		ruleInput.placeholder = 'e.g. Follow strict code quality rules and execute unit tests for this ticket...';

		// Action Buttons Row
		const actionsRow = append(modal, $('.modal-actions-row'));
		actionsRow.style.display = 'flex';
		actionsRow.style.justifyContent = 'flex-end';
		actionsRow.style.gap = '10px';
		actionsRow.style.marginTop = '8px';

		const cancelBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 7px 16px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: inherit;'
		}));
		cancelBtn.innerText = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();

		const submitBtn = append(actionsRow, $('button.monaco-button', {
			style: 'padding: 7px 18px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
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

			if (selectedType !== 'folder' && selectedType !== 'file') {
				const inputTitle = titleInput.value.trim();
				if (!inputTitle) {
					warningBanner.innerText = '⚠️ Please enter a Title for this entity.';
					warningBanner.style.display = 'block';
					submitBtn.disabled = true;
					submitBtn.style.opacity = '0.5';
					submitBtn.style.pointerEvents = 'none';
					return;
				}
			}

			const sanitizedName = inputName.replace(/[^a-zA-Z0-9_-]/g, '-');
			const targetCheckUri1 = URI.joinPath(targetUri, inputName);
			const targetCheckUri2 = URI.joinPath(targetUri, sanitizedName);
			const exists = await this.fileService.exists(targetCheckUri1) || await this.fileService.exists(targetCheckUri2);
			if (exists) {
				warningBanner.innerText = `⚠️ Item '${inputName}' already exists in '${targetName}'. Please enter a unique name.`;
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

		const refreshNameAndBadge = async () => {
			const customModules = await this._getCustomModules(targetUri);
			const matchingModule = customModules.find((m: ICustomModule) => m.id === selectedType);

			if (selectedType === 'folder') {
				codeBox.style.display = 'none';
				badgeBox.style.display = 'none';
				titleBox.style.display = 'none';
				statusBox.style.display = 'none';
				priorityBox.style.display = 'none';
				agentBox.style.display = 'none';
				linkBox.style.display = 'none';
				attachBox.style.display = 'none';
				typePromptBox.style.display = 'none';
				ruleBox.style.display = 'none';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'Folder Name:';
				nameInput.value = 'new_folder';
				descLabel.innerText = 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';
			} else if (selectedType === 'file') {
				codeBox.style.display = 'none';
				badgeBox.style.display = 'none';
				titleBox.style.display = 'none';
				statusBox.style.display = 'none';
				priorityBox.style.display = 'none';
				agentBox.style.display = 'none';
				linkBox.style.display = 'none';
				attachBox.style.display = 'none';
				typePromptBox.style.display = 'none';
				ruleBox.style.display = 'none';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'File Name:';
				nameInput.value = 'new_file.md';
				descLabel.innerText = 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';
			} else if (selectedType === 'agent') {
				codeBox.style.display = 'block';
				badgeBox.style.display = 'block';
				titleBox.style.display = 'block';
				statusBox.style.display = 'block';
				priorityBox.style.display = 'none';
				agentBox.style.display = 'none';
				linkBox.style.display = 'block';
				attachBox.style.display = 'block';
				typePromptBox.style.display = 'block';
				ruleBox.style.display = 'none';
				credBox.style.display = 'block';
				modelBox.style.display = 'block';
				promptBox.style.display = 'block';
				baseAgentBox.style.display = 'block';
				nameLabel.innerText = 'Agent Code / Ticket ID:';
				titleLabel.innerText = 'Agent Title / Name:';
				descLabel.innerText = 'Role & Description:';
				descInput.placeholder = 'e.g. NestJS Backend Specialist, Monaco UI Refactoring Architect';

				const customCode = codeInput.value.trim();
				const seq = await this.workspacesExplorerService.generateNextSequentialName(targetUri, selectedType, customCode);
				nameInput.value = seq.name;
				previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Prefix Code: ${seq.code})`;
				const currentTypeObj = typesList.find(t => t.type === selectedType);
				const badgeColor = currentTypeObj ? currentTypeObj.color : '#38bdf8';
				previewBadge.style.color = badgeColor;
				previewBadge.style.borderColor = `${badgeColor}58`;
				previewBadge.style.backgroundColor = `${badgeColor}12`;
				typePromptInput.value = matchingModule?.prompt || builtInTypePrompts[selectedType] || '';
			} else {
				codeBox.style.display = 'block';
				badgeBox.style.display = 'block';
				titleBox.style.display = 'block';
				statusBox.style.display = 'block';
				priorityBox.style.display = 'block';
				agentBox.style.display = 'block';
				linkBox.style.display = 'block';
				attachBox.style.display = 'block';
				typePromptBox.style.display = 'block';
				ruleBox.style.display = 'block';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'Entity Folder Name / Ticket ID:';
				titleLabel.innerText = 'Title (Required):';
				descLabel.innerText = 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';

				const customCode = codeInput.value.trim();
				const seq = await this.workspacesExplorerService.generateNextSequentialName(targetUri, selectedType, customCode);
				nameInput.value = seq.name;
				previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Prefix Code: ${seq.code})`;
				const currentTypeObj = typesList.find(t => t.type === selectedType);
				const badgeColor = currentTypeObj ? currentTypeObj.color : '#38bdf8';
				previewBadge.style.color = badgeColor;
				previewBadge.style.borderColor = `${badgeColor}58`;
				previewBadge.style.backgroundColor = `${badgeColor}12`;
				typePromptInput.value = matchingModule?.prompt || builtInTypePrompts[selectedType] || '';
			}

			if (matchingModule && matchingModule.fields && matchingModule.fields.length > 0) {
				clearNode(customFieldsBox);
				customFieldsBox.style.display = 'flex';
				for (const field of matchingModule.fields) {
					const fieldGroup = append(customFieldsBox, $('.form-group', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
					append(fieldGroup, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; font-weight: 500;' }, `${field.label}:`));
					
					if (field.type === 'textarea') {
						append(fieldGroup, $('textarea.monaco-inputbox.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							style: 'width: 100%; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; min-height: 52px; font-family: inherit;'
						}));
					} else if (field.type === 'select') {
						const select = append(fieldGroup, $('select.monaco-select.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer;'
						})) as HTMLSelectElement;
						(field.options || []).forEach((opt: string) => {
							append(select, $('option', { value: opt }, opt));
						});
					} else if (field.type === 'multiselect') {
						const container = append(fieldGroup, $('.multiselect-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							style: 'display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.15);'
						}));
						(field.options || []).forEach((opt: string) => {
							const row = append(container, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer;' }));
							append(row, $('input', { type: 'checkbox', value: opt, style: 'cursor: pointer;' }));
							append(row, $('span', {}, opt));
						});
					} else if (field.type === 'switch') {
						const row = append(fieldGroup, $('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 11.5px; cursor: pointer; padding: 4px 0;' }));
						append(row, $('input.custom-field-input', {
							type: 'checkbox',
							'data-field-id': field.id,
							'data-field-label': field.label,
							style: 'cursor: pointer;'
						}));
						append(row, $('span', {}, 'Enabled'));
					} else {
						append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
							type: 'text',
							'data-field-id': field.id,
							'data-field-label': field.label,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						}));
					}
				}
			} else {
				clearNode(customFieldsBox);
				customFieldsBox.style.display = 'none';
			}

			await updateValidation();
		};

		// Initial refresh
		refreshNameAndBadge();

		codeInput.oninput = () => {
			refreshNameAndBadge();
		};

		nameInput.oninput = () => {
			updateValidation();
		};

		titleInput.oninput = () => {
			updateValidation();
		};

		submitBtn.onclick = async () => {
			const name = nameInput.value.trim();
			if (!name) {
				this.notificationService.warn('Please enter a valid entity name.');
				return;
			}

			if (selectedType !== 'folder' && selectedType !== 'file') {
				const titleVal = titleInput.value.trim();
				if (!titleVal) {
					this.notificationService.warn('Please enter a Title for this entity.');
					titleInput.focus();
					return;
				}
			}

			if (selectedType === 'agent') {
				const roleVal = descInput.value.trim();
				const promptVal = promptInput.value.trim();
				if (!roleVal) {
					this.notificationService.warn('Please enter a Role Description.');
					descInput.focus();
					return;
				}
				if (!promptVal) {
					this.notificationService.warn('Please enter System Prompt instructions.');
					promptInput.focus();
					return;
				}
				if (credSelect.value === 'none') {
					this.notificationService.warn('Please configure and select an API Connection Credential first.');
					credSelect.focus();
					return;
				}
			}

			try {
				const selectedOpt = agentSelect.options[agentSelect.selectedIndex];
				const assignedAgentId = agentSelect.value || undefined;
				const assignedAgentName = (assignedAgentId && selectedOpt) ? (selectedOpt.getAttribute('data-name') || selectedOpt.text.replace(/^🤖\s*/, '').replace(/\s*\(.*\)$/, '')) : undefined;

				let agentModelOpt: any = undefined;
				if (selectedType === 'agent') {
					let selectedModel = modelInput.value.trim();
					selectedModel = selectedModel.replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-');
					if (!selectedModel) {
						this.notificationService.warn('Please enter an AI Model ID.');
						modelInput.focus();
						return;
					}

					let providerIdVal = 'gemini';
					let modelIdVal = selectedModel;
					let credentialIdVal: string | undefined = undefined;

					if (credSelect.value !== 'default' && credSelect.value !== 'none') {
						credentialIdVal = credSelect.value;
						const cred = savedCredentials.find(c => c.id === credentialIdVal);
						if (cred) {
							providerIdVal = cred.providerId;
						}
					}
					if (selectedModel.includes('/')) {
						const parts = selectedModel.split('/');
						providerIdVal = parts[0];
						modelIdVal = parts[1];
					} else {
						if (credSelect.value === 'default' || credSelect.value === 'none') {
							providerIdVal = selectedModel.startsWith('gpt') ? 'openai' : selectedModel.startsWith('claude') ? 'anthropic' : 'gemini';
						}
					}
					agentModelOpt = {
						providerId: providerIdVal,
						modelId: modelIdVal,
						credentialId: credentialIdVal
					};
				}

				const customMetadata: { [key: string]: string } = {};
				const customInputs = modalBody.querySelectorAll('.custom-field-input');
				customInputs.forEach(inputEl => {
					const fieldLabel = inputEl.getAttribute('data-field-label');
					if (fieldLabel) {
						if (inputEl instanceof HTMLInputElement && inputEl.type === 'checkbox') {
							customMetadata[fieldLabel] = inputEl.checked ? 'true' : 'false';
						} else if (inputEl.classList.contains('multiselect-container')) {
							const checked = Array.from(inputEl.querySelectorAll('input[type="checkbox"]:checked')).map((cb: any) => cb.value);
							customMetadata[fieldLabel] = checked.join(', ');
						} else {
							customMetadata[fieldLabel] = (inputEl as any).value || '';
						}
					}
				});

				const customModules = await this._getCustomModules(targetUri);
				const matchingModule = customModules.find((m: ICustomModule) => m.id === selectedType);

				const createResult = await this.workspacesExplorerService.createResourceUnderWorkspace({
					workspaceUri: targetUri,
					type: selectedType,
					name,
					title: titleInput.value.trim() || undefined,
					code: codeInput.value.trim() || undefined,
					status: 'Todo',
					priority: selectedPriority,
					assignedAgentId,
					assignedAgentName,
					agentRulePrompt: ruleInput.value.trim() || undefined,
					ticketPrompt: ruleInput.value.trim() || undefined,
					description: descInput.value.trim() || undefined,
					typeDefinition: matchingModule?.description || (['folder', 'file'].includes(selectedType) ? undefined : `.agents/entity_type/${selectedType}.yaml`),
					typePrompt: typePromptInput.value.trim() || undefined,
					linkTo: linkToInput.value.trim() || undefined,
					attachments: selectedAttachments.length > 0 ? selectedAttachments : undefined,
					agentModel: agentModelOpt,
					agentSystemPrompt: selectedType === 'agent' ? promptInput.value.trim() : undefined,
					customMetadata
				});

				const createdUri = createResult.uri;

				removeOverlay();
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

				const isCustomEntity = selectedType !== 'file' && selectedType !== 'folder';
				if (isCustomEntity) {
					if (selectedType === 'workflow') {
						await this.editorService.openEditor(new WorkflowEditorInput(createdUri, name), { pinned: true });
					} else {
						await this.editorService.openEditor(new EntityDetailEditorInput(createdUri, name), { pinned: true });
					}
				} else if (createdUri.path.toLowerCase().endsWith('.md')) {
					await this.commandService.executeCommand('markdown.showPreview', createdUri);
				} else {
					await this.openerService.open(createdUri);
				}
				await this.renderContent();

				if (onSuccess) {
					onSuccess(selectedType, name);
				}
			} catch (err) {
				this.notificationService.error(`Failed to create entity: ${err}`);
			}
		};
	}

	private async _readYamlFile(uri: URI): Promise<any> {
		try {
			if (await this.fileService.exists(uri)) {
				const content = await this.fileService.readFile(uri);
				return parseYaml(content.value.toString());
			}
		} catch (e) {
			console.error('Error reading YAML file:', e);
		}
		return null;
	}

	private async _ensureDirExists(dirUri: URI): Promise<void> {
		const parts: URI[] = [];
		let curr = dirUri;
		while (curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
			parts.push(curr);
			const parent = dirname(curr);
			if (parent.path === curr.path) break;
			curr = parent;
		}
		parts.reverse();
		for (const p of parts) {
			try {
				if (!await this.fileService.exists(p)) {
					await this.fileService.createFolder(p);
				}
			} catch (e) {
				console.error(`Failed to create directory part: ${p.toString()}`, e);
			}
		}
	}

	private async _writeYamlFile(uri: URI, data: any): Promise<void> {
		try {
			const parentDir = dirname(uri);
			await this._ensureDirExists(parentDir);
			const yamlContent = stringifyYaml(data);
			await this.fileService.writeFile(uri, VSBuffer.fromString(yamlContent));
		} catch (e) {
			console.error('Error writing YAML file:', e);
			this.notificationService.error(`Failed to write custom module YAML file: ${e}`);
		}
	}

	private _getGlobalEntityTypeDir(): URI {
		let savedPath = '~/.anyagent/entity_type';
		try {
			if (this._storageService) {
				savedPath = this._storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
			}
		} catch (e) {
			console.error('Failed to read globalEntityTypePath setting:', e);
		}
		const userHome = this.environmentService.userHome.fsPath;
		const resolvedPath = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_type');
		return URI.file(resolvedPath);
	}

	private async _getCustomModules(workspaceUri: URI): Promise<ICustomModule[]> {
		const modulesMap = new Map<string, ICustomModule>();
		try {
			const globalDir = this._getGlobalEntityTypeDir();
			const localDir = URI.joinPath(workspaceUri, '.agents', 'entity_type');
			const localDirPlural = URI.joinPath(workspaceUri, '.agents', 'entity_types');
			const parentLocalDir = URI.joinPath(dirname(workspaceUri), '.agents', 'entity_type');

			try {
				if (await this.fileService.exists(globalDir)) {
					const stat = await this.fileService.resolve(globalDir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
								const mod = await this._readYamlFile(child.resource);
								if (mod && mod.id) {
									mod.storageScope = 'global';
									modulesMap.set(mod.id.toLowerCase(), mod);
								}
							}
						}
					}
				}
			} catch (e) {
				console.error('Error listing global entity types:', e);
			}

			const checkDirs = [localDir, localDirPlural, parentLocalDir];
			for (const dir of checkDirs) {
				try {
					if (await this.fileService.exists(dir)) {
						const stat = await this.fileService.resolve(dir);
						if (stat.children) {
							for (const child of stat.children) {
								if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
									const mod = await this._readYamlFile(child.resource);
									if (mod && mod.id) {
										if (!mod.storageScope) {
											mod.storageScope = 'workspace';
										}
										modulesMap.set(mod.id.toLowerCase(), mod);
									}
								}
							}
						}
					}
				} catch (e) {
					console.error('Error listing local entity types:', e);
				}
			}
		} catch (e) {
			console.error('Error in _getCustomModules overall resolution:', e);
		}

		return Array.from(modulesMap.values());
	}

	private async _saveCustomModules(modules: ICustomModule[], workspaceUri: URI): Promise<void> {
		try {
			const globalDir = this._getGlobalEntityTypeDir();
			const localDir = URI.joinPath(workspaceUri, '.agents', 'entity_type');

			const activeIds = new Set(modules.map(m => m.id));

			try {
				if (await this.fileService.exists(globalDir)) {
					const stat = await this.fileService.resolve(globalDir);
					if (stat.children) {
						for (const child of stat.children) {
							const id = child.name.replace(/\.yaml$|\.yml$/i, '');
							if (!activeIds.has(id)) {
								await this.fileService.del(child.resource);
							}
						}
					}
				}
			} catch {}

			try {
				if (await this.fileService.exists(localDir)) {
					const stat = await this.fileService.resolve(localDir);
					if (stat.children) {
						for (const child of stat.children) {
							const id = child.name.replace(/\.yaml$|\.yml$/i, '');
							if (!activeIds.has(id)) {
								await this.fileService.del(child.resource);
							}
						}
					}
				}
			} catch {}

			for (const m of modules) {
				const fileData = { ...m };
				delete fileData.storageScope;

				const filename = `${m.id}.yaml`;

				if (m.storageScope === 'global') {
					const globalFile = URI.joinPath(globalDir, filename);
					const localFile = URI.joinPath(localDir, filename);
					await this._writeYamlFile(globalFile, { ...fileData, storageScope: 'global' });
					await this._writeYamlFile(localFile, { ...fileData, storageScope: 'global' });
				} else {
					const localFile = URI.joinPath(localDir, filename);
					await this._writeYamlFile(localFile, { ...fileData, storageScope: 'workspace' });
				}
			}
		} catch (e) {
			console.error('Error in _saveCustomModules:', e);
			this.notificationService.error(`Failed to save custom modules: ${e}`);
		}
	}

	private async _openCustomModulesManager(targetUri: URI, onUpdate: () => void): Promise<void> {
		if (!this.containerEl) {
			return;
		}
		const mgOverlay = append(this.containerEl, $('.manage-modules-overlay'));
		mgOverlay.style.position = 'fixed';
		mgOverlay.style.top = '0';
		mgOverlay.style.left = '0';
		mgOverlay.style.width = '100vw';
		mgOverlay.style.height = '100vh';
		mgOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
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

		const renderManagerContent = async () => {
			clearNode(mgModal);

			if (!selectedModule) {
				// --- STAGE 1: List View ---
				mgModal.style.maxWidth = '480px';

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
					style: 'max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px; background: rgba(0,0,0,0.15);'
				}));

				const refreshList = async () => {
					clearNode(listContainer);
					const currentModules = await this._getCustomModules(targetUri);

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
								selectedModule = JSON.parse(JSON.stringify(m)); // Deep copy to support cancel
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
								await this._saveCustomModules(currentModules, targetUri);
								await refreshList();
							};
						} else {
							actBtn.innerText = 'Deactivate';
							actBtn.style.color = '#fb923c';
							actBtn.onclick = async () => {
								m.isDeprecated = true;
								await this._saveCustomModules(currentModules, targetUri);
								await refreshList();
							};
						}
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
					const currentModules = await this._getCustomModules(targetUri);

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

					// Automatically enter edit mode for the new module
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
				mgModal.style.maxWidth = '900px';

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
				const configMetaContainer = append(mgModal, $('.config-meta-container', { style: 'display: flex; gap: 20px; align-items: center; flex-wrap: wrap; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); padding: 12px 16px; border-radius: 8px;' }));

				// Scope Selector
				const scopeGroup = append(configMetaContainer, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px;' }));
				append(scopeGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888;' }, 'Scope:'));
				const scopeSelect = append(scopeGroup, $('select.monaco-select', {
					style: 'padding: 4px 8px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; cursor: pointer;'
				})) as HTMLSelectElement;
				append(scopeSelect, $('option', { value: 'global' }, 'Global'));
				append(scopeSelect, $('option', { value: 'workspace' }, 'Workspace'));
				scopeSelect.value = activeMod.storageScope || 'global';
				scopeSelect.onchange = () => {
					activeMod.storageScope = scopeSelect.value as any;
				};

				// Type Definition (Description) Input
				const defGroup = append(configMetaContainer, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px;' }));
				append(defGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Type Definition:'));
				const defInput = append(defGroup, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box;'
				})) as HTMLInputElement;
				defInput.placeholder = 'e.g. Explains purpose of this module...';
				defInput.value = activeMod.description || '';
				defInput.oninput = () => {
					activeMod.description = defInput.value;
				};

				// Type Prompt (Ticket Type Prompt) Input
				const promptGroup = append(configMetaContainer, $('.form-group', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px;' }));
				append(promptGroup, $('label', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888; white-space: nowrap;' }, 'Type Prompt:'));
				const typePromptInput = append(promptGroup, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); background: #1a1a1a; color: inherit; box-sizing: border-box;'
				})) as HTMLInputElement;
				typePromptInput.placeholder = 'e.g. Instructions for AI to process tickets of this type...';
				typePromptInput.value = activeMod.prompt || '';
				typePromptInput.oninput = () => {
					activeMod.prompt = typePromptInput.value;
				};

				// Color Picker container
				const colorContainer = append(configMetaContainer, $('div', { style: 'display: flex; align-items: center; gap: 12px;' }));
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

				// Main columns
				const modalLayoutContainer = append(mgModal, $('.modal-layout-container', { style: 'display: flex; gap: 20px; width: 100%; height: 380px; overflow: hidden;' }));
				
				// Left Column: Palette library (30%)
				const leftColumn = append(modalLayoutContainer, $('.left-col', { style: 'flex: 3; border-right: 1px solid rgba(255,255,255,0.08); padding-right: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto;' }));

				// Palette Title & Stacked buttons
				append(leftColumn, $('div', { style: 'font-size: 11px; opacity: 0.85; font-weight: 600; text-transform: uppercase; color: #888888;' }, 'Component Library'));
				append(leftColumn, $('div', { style: 'font-size: 10px; opacity: 0.5; line-height: 1.4;' }, 'Click component buttons below to add new fields to the schema on the right.'));

				const paletteContainer = append(leftColumn, $('.palette-container', { style: 'display: flex; flex-direction: column; gap: 8px;' }));
				const fieldTypes = [
					{ type: 'text', label: 'Single-line Input (Text)', icon: Codicon.symbolString },
					{ type: 'textarea', label: 'Textarea (Multiline)', icon: Codicon.listFlat },
					{ type: 'select', label: 'Dropdown (Select)', icon: Codicon.chevronDown },
					{ type: 'multiselect', label: 'Checkboxes (Multiselect)', icon: Codicon.checklist },
					{ type: 'switch', label: 'Switch (Toggle)', icon: Codicon.circleFilled }
				];

				// Right Column: Canvas list (70%)
				const rightColumn = append(modalLayoutContainer, $('.right-col', { style: 'flex: 7; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding-left: 6px;' }));

				// Right Column Canvas fields renderer
				const fieldsListContainer = append(rightColumn, $('.fields-list-container', {
					style: 'display: flex; flex-direction: column; gap: 10px; min-height: 100%;'
				}));

				const renderFieldList = () => {
					clearNode(fieldsListContainer);
					const fields = activeMod.fields || [];

					if (fields.length === 0) {
						const empty = append(fieldsListContainer, $('div', { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; height: 260px; border: 1.5px dashed rgba(255,255,255,0.08); border-radius: 8px; color: #888888; gap: 8px;' }));
						append(empty, $('span' + ThemeIcon.asCSSSelector(Codicon.package), { style: 'font-size: 24px; opacity: 0.5;' }));
						append(empty, $('div', { style: 'font-size: 12px;' }, 'Drag or click components on the left to start designing your schema.'));
						return;
					}

					fields.forEach((field, fIdx) => {
						const fieldCard = append(fieldsListContainer, $('.field-card', {
							style: 'padding: 12px 14px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 8px; cursor: grab; position: relative;'
						}));
						fieldCard.setAttribute('draggable', 'true');

						fieldCard.onmousedown = (e) => {
							const target = e.target as HTMLElement;
							if (target.closest('input, textarea, button, select, span, label')) {
								fieldCard.setAttribute('draggable', 'false');
							} else {
								fieldCard.setAttribute('draggable', 'true');
							}
						};

						// Drag & Drop
						fieldCard.ondragstart = (ev) => {
							ev.dataTransfer?.setData('text/plain', String(fIdx));
						};
						fieldCard.ondragover = (ev) => ev.preventDefault();
						fieldCard.ondrop = (ev) => {
							ev.preventDefault();
							const fromIdx = Number(ev.dataTransfer?.getData('text/plain'));
							if (fromIdx !== fIdx && activeMod.fields) {
								const [removed] = activeMod.fields.splice(fromIdx, 1);
								activeMod.fields.splice(fIdx, 0, removed);
								renderFieldList();
							}
						};

						const topRow = append(fieldCard, $('.field-top-row', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
						const badge = append(topRow, $('span', {
							style: 'font-size: 9px; padding: 2px 6px; border-radius: 4px; background: rgba(56,189,248,0.12); color: #38bdf8; text-transform: uppercase; font-weight: bold; letter-spacing: 0.05em;'
						}));
						badge.innerText = field.type;

						const actions = append(topRow, $('.field-actions', { style: 'display: flex; gap: 8px;' }));
						
						const upBtn = append(actions, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowUp), { style: 'cursor: pointer; opacity: 0.7; font-size: 12px; padding: 2px;' }));
						upBtn.onclick = (e) => {
							e.stopPropagation();
							if (fIdx > 0 && activeMod.fields) {
								const temp = activeMod.fields[fIdx];
								activeMod.fields[fIdx] = activeMod.fields[fIdx - 1];
								activeMod.fields[fIdx - 1] = temp;
								renderFieldList();
							}
						};

						const downBtn = append(actions, $('span' + ThemeIcon.asCSSSelector(Codicon.arrowDown), { style: 'cursor: pointer; opacity: 0.7; font-size: 12px; padding: 2px;' }));
						downBtn.onclick = (e) => {
							e.stopPropagation();
							if (activeMod.fields && fIdx < activeMod.fields.length - 1) {
								const temp = activeMod.fields[fIdx];
								activeMod.fields[fIdx] = activeMod.fields[fIdx + 1];
								activeMod.fields[fIdx + 1] = temp;
								renderFieldList();
							}
						};

						const delBtn = append(actions, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'cursor: pointer; opacity: 0.7; color: #ef4444; font-size: 12px; padding: 2px;' }));
						delBtn.onclick = (e) => {
							e.stopPropagation();
							if (activeMod.fields) {
								activeMod.fields.splice(fIdx, 1);
								renderFieldList();
							}
						};

						// Label Rename Box
						const renameGroup = append(fieldCard, $('.rename-group', { style: 'display: flex; gap: 8px; align-items: center;' }));
						append(renameGroup, $('label', { style: 'font-size: 11px; opacity: 0.7; width: 80px; min-width: 80px;' }, 'Field Name:'));
						const labelInput = append(renameGroup, $('input.monaco-inputbox', {
							style: 'flex: 1; padding: 5px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: inherit;'
						})) as HTMLInputElement;
						labelInput.value = field.label;
						labelInput.placeholder = 'e.g. Version, Priority Level';
						labelInput.oninput = () => {
							const val = labelInput.value.trim() || `Field_${fIdx + 1}`;
							field.label = labelInput.value;
							field.id = val.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
						};

						// Options List Config for Dropdowns / Checkboxes
						if (field.type === 'select' || field.type === 'multiselect') {
							const optionsBox = append(fieldCard, $('.options-config-box', { style: 'margin-left: 88px; background: rgba(0,0,0,0.15); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);' }));
							
							const renderOptionsUI = () => {
								optionsBox.textContent = '';
								append(optionsBox, $('div', { style: 'font-size: 10px; color: #888888; margin-bottom: 6px; font-weight: 600; text-transform: uppercase;' }, 'Configure Options:'));
								
								if (!field.options) {
									field.options = ['Option 1', 'Option 2'];
								}

								const optsList = append(optionsBox, $('div', { style: 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px;' }));
								field.options.forEach((opt, oIdx) => {
									const optRow = append(optsList, $('div', { style: 'display: flex; gap: 6px; align-items: center;' }));
									const optInput = append(optRow, $('input.monaco-inputbox', {
										value: opt,
										style: 'flex: 1; padding: 3px 6px; font-size: 11px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff;'
									})) as HTMLInputElement;
									optInput.oninput = () => {
										field.options![oIdx] = optInput.value;
									};

									const optTrash = append(optRow, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
										style: 'color: #ef4444; cursor: pointer; padding: 4px; font-size: 11px;'
									}));
									optTrash.onclick = () => {
										field.options!.splice(oIdx, 1);
										renderOptionsUI();
									};
								});

								const addOptBtn = append(optionsBox, $('button.monaco-button', {
									style: 'padding: 3px 8px; font-size: 10px; border-radius: 4px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #fff; cursor: pointer; font-weight: 500;'
								}));
								addOptBtn.textContent = '+ Add Option';
								addOptBtn.onclick = () => {
									field.options!.push(`Option ${field.options!.length + 1}`);
									renderOptionsUI();
								};
							};
							renderOptionsUI();
						}
					});
				};

				fieldTypes.forEach(ft => {
					const btn = append(paletteContainer, $('button.monaco-button', {
						style: 'padding: 8px 12px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: inherit; display: flex; align-items: center; gap: 8px; text-align: left;'
					}));
					const btnIcon = append(btn, $('span' + ThemeIcon.asCSSSelector(ft.icon)));
					btnIcon.style.opacity = '0.6';
					append(btn, $('span', {}, ft.label));

					btn.onclick = () => {
						if (!activeMod.fields) activeMod.fields = [];
						const fieldId = `field_${Date.now()}`;
						activeMod.fields.push({
							id: fieldId,
							label: `New ${ft.type === 'text' ? 'Input Row' : ft.type === 'textarea' ? 'Input Box' : ft.type === 'select' ? 'Dropdown' : ft.type === 'multiselect' ? 'Checkboxes' : 'Switch'}`,
							type: ft.type as any,
							options: (ft.type === 'select' || ft.type === 'multiselect') ? ['Option 1', 'Option 2'] : undefined
						});
						renderFieldList();
						rightColumn.scrollTop = rightColumn.scrollHeight;
					};
				});

				renderFieldList();

				// Footer Controls
				const mgFooter = append(mgModal, $('.mg-footer', { style: 'display: flex; justify-content: flex-end; gap: 12px; margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;' }));
				
				const cancelBtn = append(mgFooter, $('button.monaco-button', {
					style: 'padding: 6px 16px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.1); font-weight: 500;'
				}));
				cancelBtn.innerText = 'Cancel';
				cancelBtn.onclick = () => {
					selectedModule = null;
					renderManagerContent();
				};

				const saveBtn = append(mgFooter, $('button.monaco-button', {
					style: 'padding: 6px 16px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600;'
				}));
				saveBtn.innerText = 'Save & Return';
				saveBtn.onclick = async () => {
					try {
						const globalDir = this._getGlobalEntityTypeDir();
						const localDir = URI.joinPath(targetUri, '.agents', 'entity_type');
						this.notificationService.info(`Saving module. ID: ${activeMod.id}, Scope: ${activeMod.storageScope || 'global'}`);
						this.notificationService.info(`Paths: Global -> ${globalDir.path}, Local -> ${localDir.path}`);

						const currentModules = await this._getCustomModules(targetUri);
						const index = currentModules.findIndex((m: ICustomModule) => m.id === activeMod.id);
						if (index !== -1) {
							currentModules[index] = activeMod;
						} else {
							currentModules.push(activeMod);
						}
						await this._saveCustomModules(currentModules, targetUri);
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

