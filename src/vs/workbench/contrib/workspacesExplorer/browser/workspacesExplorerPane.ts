/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getActiveDocument, getWindow, isHTMLInputElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService, IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { basename, dirname } from '../../../../base/common/resources.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { Action, IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspacesExplorerService, IWorkspaceItem, IWorkspaceChildItem, ICreateResourceOptions, CanonicalStatusCategory } from '../common/workspacesExplorer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAgentsManagerService, IAgentCredentialService, IAgentCredential, IAgentItem, getGlobalDefaultModel, resolveDefaultModel, resolveDefaultModelId } from '../../agentsManager/common/agentsManager.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { EntityDetailEditor } from './entityDetailEditor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { openSubWorkflowTicketCanvas } from '../../workflowsManager/browser/subWorkflowLiveView.js';
import { getSubWorkflowTicketVisual, isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import { AccountManagementDialog } from '../../accountManagement/browser/accountManagementDialog.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { VIEW_ID } from '../../files/common/files.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICustomModule, ICustomField, IParameterDefinition, IActionButton, resolveCustomModuleIcon, getDefaultCustomModuleColor, normalizeNumberFieldValue, numberFieldRulesFromAttributes, buildHttpTicketValue, buildSshTicketValue } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { isCommentKeybinding, togglePythonComment } from '../../customModules/browser/pythonSyntaxHighlighter.js';
import { stringifyYaml } from '../../customModules/browser/customModulesService.js';
import { parseYaml } from '../../customModules/common/templateYaml.js';
import { MASKED_SECRET, maskBrowserCredentials } from '../../customModules/common/browserCredentials.js';
import { FREESTYLE_TICKET_COLOR, FREESTYLE_TICKET_LABEL, FREESTYLE_TICKET_TYPE, FREESTYLE_TYPE_PROMPT, isFreestyleTicketType } from '../../customModules/common/freestyleTicket.js';
import { clashesWithBuiltInTicketType } from '../../customModules/common/templateNameClash.js';
import { getAnyAgentGlobalFolders } from '../../customModules/common/anyagentGlobalPaths.js';
import { createDefaultCategoryMap, readTicketStatus, readTopLevelMetadata, STATUS_CATEGORIES, STATUS_CATEGORY_COLORS } from '../common/workspaceLifecycle.js';
import { buildPriorityOptions, DEFAULT_TICKET_PRIORITY, findStatusOption, findTemplateForType, groupStatusOptions, resolveEffectiveStatusOptions } from '../common/ticketStatusPicker.js';
import { describeRestoreDecision } from '../common/ticketRestore.js';
import { applyStatusFilter, describeHiddenTickets, describeStatusFilter, FINISHED_CATEGORIES, HIDDEN_STATUS_CATEGORIES_STORAGE_KEY, LEGACY_HIDE_FINISHED_TICKETS_STORAGE_KEY, resolveHiddenCategories, serializeHiddenCategories, toggleHiddenCategory } from '../common/ticketVisibility.js';
import { getLabelColor } from '../common/ticketLabels.js';
import { CHILD_COUNT_MODE_STORAGE_KEY, CHILD_COUNT_MODES, ChildCountMode, countSubtree, describeChildCountPill, ITicketSubtreeCounts, ITicketSubtreeSummary, parseChildCountMode } from '../common/ticketSubtreeCount.js';
import { classifyTestResult, collectFailingDescendants, describeFailingBelow, describeTestResult, describeTicketFailure, IFailingSummary } from '../common/ticketFailure.js';
import { createCSSRule } from '../../../../base/browser/domStylesheets.js';
import { renderLabelDefinitionsEditor, renderStatusLifecycleMatrix, summarizeCategoryMap } from './workspaceLifecycleEditor.js';
import { IWorkspacePin, isWorkspacePinned, orderByPins, parseWorkspacePins, pinWorkspace, serializeWorkspacePins, unpinWorkspace, WORKSPACE_PINS_STORAGE_KEY } from '../common/workspacePins.js';
import { readTicketFileResolved } from './ticketFieldFiles.js';
import { buildPrunedTicketTree, describeSearchResult, findExactIdMatch, findMatchRange, GO_TO_TICKET_COMMAND_ID, IPrunedTicketTree, ITicketSearchEntry, ITicketSearchResult, normalizeTicketQuery, searchTickets, splitHighlight, TICKET_SEARCH_DEBOUNCE_MS, TICKET_SEARCH_MIN_QUERY_LENGTH } from '../common/ticketSearch.js';

function getTicketTypeBadge(type: string, customModulesMap?: Map<string, { color: string; icon: ThemeIcon }>): { color: string; bg: string } {
	const t = (type || 'task').toLowerCase();
	const subWorkflowVisual = getSubWorkflowTicketVisual(t);
	if (subWorkflowVisual) {
		return { color: subWorkflowVisual.color, bg: hexToRgba(subWorkflowVisual.color, 0.18) };
	}
	if (customModulesMap) {
		const customVisual = customModulesMap.get(t);
		if (customVisual && customVisual.color) {
			return { color: customVisual.color, bg: hexToRgba(customVisual.color, 0.18) };
		}
	}
	switch (t) {
		case 'job': return { color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.18)' };
		case 'task': return { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.18)' };
		case 'project': return { color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.18)' };
		case 'workflow': return { color: '#0d9488', bg: 'rgba(13, 148, 136, 0.18)' };
		case 'agent': return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)' };
		case 'case': return { color: '#f472b6', bg: 'rgba(244, 114, 182, 0.18)' };
		case 'issue': return { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.18)' };
		case 'analysis': return { color: '#34d399', bg: 'rgba(52, 211, 153, 0.18)' };
		case 'note': return { color: '#00b4d8', bg: 'rgba(0, 180, 216, 0.18)' };
		case 'workspace': return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.18)' };
		default: {
			const fallbackColor = getDefaultCustomModuleColor(t);
			return { color: fallbackColor, bg: hexToRgba(fallbackColor, 0.18) };
		}
	}
}

function getCustomIconForName(name: string | undefined): ThemeIcon {
	return resolveCustomModuleIcon(undefined, name);
}

function buildCustomModulesVisualMap(mods: ICustomModule[]): Map<string, { color: string; icon: ThemeIcon }> {
	const map = new Map<string, { color: string; icon: ThemeIcon }>();

	for (const m of mods) {
		const keyId = (m.id || '').toLowerCase();
		const keyName = (m.name || '').toLowerCase();
		if (!keyId && !keyName) { continue; }

		// Use the persisted icon and color directly so they remain permanently stable
		const icon = resolveCustomModuleIcon(m.icon, keyId || keyName);
		const color = m.color || getDefaultCustomModuleColor(keyName || keyId);

		const visual = { color, icon };
		if (keyId) { map.set(keyId, visual); }
		if (keyName) { map.set(keyName, visual); }
	}
	// Freestyle tickets have no template; they always use the Freestyle look
	map.set(FREESTYLE_TICKET_TYPE, { color: FREESTYLE_TICKET_COLOR, icon: Codicon.edit });
	return map;
}

function getColorForName(name: string | undefined): string {
	if (!name) { return '#38bdf8'; }
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

/** A row of the rendered tree, kept per row element so it survives DOM reconciliation. */
interface IRenderedRowEntry {
	canonicalId: string;
	child: IWorkspaceChildItem;
	parentWsId: string;
	parentFolderUri: URI;
	rowEl: HTMLElement;
}

/** Editor panes that can reload their content (e.g. the entity detail editor). */
let createWorkspaceDialogFontRuleCreated = false;
/** UI-29: the New Workspace dialog's form controls inherit the workbench font (Chromium gives buttons Arial). */
function ensureCreateWorkspaceDialogFontRule(): void {
	if (createWorkspaceDialogFontRuleCreated) {
		return;
	}
	createWorkspaceDialogFontRuleCreated = true;
	createCSSRule('.create-workspace-modal-overlay button, .create-workspace-modal-overlay input, .create-workspace-modal-overlay textarea, .create-workspace-modal-overlay select', 'font-family: inherit;');
}

function isRefreshablePane(pane: unknown): pane is { refresh(): unknown } {
	return typeof (pane as { refresh?: unknown } | undefined)?.refresh === 'function';
}

/** `target` is a workspace item (has `uri` and `name`) rather than a bare URI. */
function isWorkspaceItemTarget(target: IWorkspaceItem | URI): target is IWorkspaceItem {
	return 'uri' in target && 'name' in target;
}

/** A dynamic-list entry card of the Create Entity dialog. */
interface IDynamicListCard {
	readonly cardEl: HTMLElement;
	readonly badgeEl: HTMLElement;
	readonly titleInput: HTMLInputElement;
	/** The entry's sub-field controls, in DOM order. */
	readonly subInputs: HTMLElement[];
}

/** Inner controls and value getters of a custom-field control in the Create Entity dialog. */
interface ICreateDialogFieldParts {
	checkboxes?: HTMLInputElement[];
	rangeStart?: HTMLInputElement;
	rangeEnd?: HTMLInputElement;
	listCards?: IDynamicListCard[];
	getAttachedFiles?: () => Array<{ name: string; size: number; dataUrl?: string }>;
	getSelectedAction?: () => string;
	getSelectedTargetStatus?: () => string;
	getBrowserData?: () => { url: string; credentials: Array<{ id: string; key: string; value: string }>; content: string; lastFetched: string };
	getPromptData?: () => object;
	getTtsData?: () => object;
	getPythonData?: () => { code: string };
	getParametersData?: () => Record<string, unknown>;
}

/** Extra keys that older template YAML may carry on a Python component. */
type ILegacyPythonField = ICustomField & { code?: string; pythonLocked?: boolean; pythonExternalScripts?: string[] };

export class MainWorkspaceViewPane extends ViewPane {
	private static readonly INITIAL_CHILDREN_BATCH_SIZE = 50;
	private static readonly LOAD_MORE_BATCH_SIZE = 50;

	private containerEl?: HTMLElement;
	private renderVersion = 0;
	private expandedWorkspaces = new Set<string>();
	private nodeVisibleLimitMap = new Map<string, number>();
	private hasInitializedExpansion = false;
	private filterText = '';
	/** UI-21: deep ticket search (filter text of 2+ characters); undefined in the normal tree. */
	private _activeSearch?: { readonly result: ITicketSearchResult; readonly tree: IPrunedTicketTree; readonly note: string };
	/** UI-21: rows the user collapsed while in search results (the normal expansion state is left untouched). */
	private readonly _searchCollapsed = new Set<string>();
	private _searchTimer: ReturnType<typeof setTimeout> | undefined;
	private _filterInputEl?: HTMLInputElement;
	/** Scroll the selected row into view after the next completed render (reveal / Go to Ticket). */
	private _scrollToSelectionPending = false;
	private selectedWorkspaceId?: string;
	private selectedItemId?: string;
	private selectedItemIds = new Set<string>();
	private lastSelectedAnchorId?: string;
	private renderedOrder: IRenderedRowEntry[] = [];
	/** Render entry of each tree row element (rows are reused across renders by `_reconcileDomChildren`). */
	private readonly rowRenderEntries = new WeakMap<HTMLElement, IRenderedRowEntry>();
	private createWorkspaceModalOverlay?: HTMLElement;
	private static createResourceModalOverlay?: HTMLElement;
	private batchActionBarEl?: HTMLElement;
	private treeBoxEl?: HTMLElement;
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
	private _showRemovedItems: boolean = false;
	/** Status categories hidden by the tree's status filter (UI-16). */
	private _hiddenStatusCategories: ReadonlySet<CanonicalStatusCategory> = new Set();
	private _statusFilterMenu?: IOpenContextView;
	/** Child-count pill mode, one global choice for the tree (UI-17). */
	private _childCountMode: ChildCountMode;
	/** Counts per sub-tree summary for the current filter, so re-renders do not walk unchanged sub-trees again. */
	private readonly _childCountMemo = new WeakMap<ITicketSubtreeSummary, { key: string; counts: ITicketSubtreeCounts; failing: IFailingSummary }>();
	private _childCountRenderTimer: ReturnType<typeof setTimeout> | undefined;

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
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IContextViewService private readonly contextViewService: IContextViewService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._storageService = storageService;
		this._showRemovedItems = this._storageService.getBoolean('anyagent.workspacesExplorer.showRemovedItems', StorageScope.PROFILE, false);
		this._hiddenStatusCategories = this._loadHiddenStatusCategories();
		this._childCountMode = parseChildCountMode(this._storageService.get(CHILD_COUNT_MODE_STORAGE_KEY, StorageScope.PROFILE));
		this._register(toDisposable(() => this._statusFilterMenu?.close()));
		this._register(toDisposable(() => {
			if (this._searchTimer) {
				clearTimeout(this._searchTimer);
				this._searchTimer = undefined;
			}
		}));
		this._register(toDisposable(() => {
			if (this._childCountRenderTimer) {
				clearTimeout(this._childCountRenderTimer);
				this._childCountRenderTimer = undefined;
			}
		}));
		this._restoreViewState();
		this._register(this._storageService.onWillSaveState(() => this._saveViewState()));

		let renderTimer: ReturnType<typeof setTimeout> | undefined;
		this._register({
			dispose: () => {
				if (renderTimer) {
					clearTimeout(renderTimer);
					renderTimer = undefined;
				}
			}
		});
		const scheduleRender = () => {
			if (!this.isBodyVisible()) {
				return;
			}
			if (renderTimer) {
				clearTimeout(renderTimer);
			}
			renderTimer = setTimeout(() => {
				renderTimer = undefined;
				if (this.isBodyVisible()) {
					this.renderContent();
				}
			}, 60);
		};
		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(scheduleRender));
		this._register(this.customModulesService.onDidChangeModules(scheduleRender));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.rawUpdated.some(u => u.path.includes('/entity_type/') || u.path.includes('/entity_types/'))) {
				scheduleRender();
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(scheduleRender));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.renderContent();
			}
		}));
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

		this.containerEl.tabIndex = 0;
		this.containerEl.style.outline = 'none';
		this.containerEl.onkeydown = async (e: KeyboardEvent) => {
			const activeTag = (getActiveDocument().activeElement as HTMLElement | null)?.tagName?.toUpperCase();
			if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
				return;
			}
			if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedItemIds.size > 0) {
				e.preventDefault();
				e.stopPropagation();
				await this.deleteSelectedItems();
			} else if (e.key === 'Escape' && this.selectedItemIds.size > 1) {
				e.preventDefault();
				e.stopPropagation();
				this.selectedItemIds.clear();
				this.updateSelectionVisuals();
			}
		};

		this.renderContent();
	}

	private updateSelectionVisuals(): void {
		if (this.treeBoxEl) {
			// Workspace cards are the direct children of the tree box
			const wsCards = Array.from(this.treeBoxEl.children).filter(el => el.classList.contains('workspace-item-card'));
			for (let i = 0; i < wsCards.length; i++) {
				const card = wsCards[i] as HTMLElement;
				const wsId = card.getAttribute('data-ws-id');
				if (wsId && wsId === this.selectedWorkspaceId) {
					card.style.backgroundColor = 'rgba(56, 189, 248, 0.12)';
					card.style.border = '1px solid #38bdf8';
				} else {
					card.style.backgroundColor = 'rgba(255, 255, 255, 0.03)';
					card.style.border = '1px solid rgba(255, 255, 255, 0.07)';
				}
			}
		}

		for (const entry of this.renderedOrder) {
			const isSelected = this.selectedItemIds.has(entry.canonicalId);
			if (isSelected) {
				entry.rowEl.style.backgroundColor = 'rgba(56, 189, 248, 0.25)';
				entry.rowEl.style.border = '1px solid #38bdf8';
			} else {
				entry.rowEl.style.backgroundColor = 'transparent';
				entry.rowEl.style.border = '1px solid transparent';
			}
		}

		if (!this.batchActionBarEl) {
			return;
		}
		const selectedEntries = this.renderedOrder.filter(r => this.selectedItemIds.has(r.canonicalId));
		if (selectedEntries.length <= 1) {
			this.batchActionBarEl.style.display = 'none';
			clearNode(this.batchActionBarEl);
			return;
		}

		this.batchActionBarEl.style.display = 'flex';
		clearNode(this.batchActionBarEl);

		const leftInfo = append(this.batchActionBarEl, $('span', {
			style: 'font-size: 11px; font-weight: 600; color: #38bdf8; white-space: nowrap;'
		}, `${selectedEntries.length} Selected`));

		const actionsGroup = append(this.batchActionBarEl, $('div', {
			style: 'display: flex; align-items: center; gap: 4px; flex-wrap: wrap;'
		}));

		// Select All Siblings button
		const selectSiblingsBtn = append(actionsGroup, $('button', {
			style: 'padding: 2px 6px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(56, 189, 248, 0.14); border: 1px solid rgba(56, 189, 248, 0.35); color: #38bdf8; font-weight: 500;'
		}, 'All Siblings'));
		selectSiblingsBtn.title = 'Select all sibling tickets in the same folder';
		selectSiblingsBtn.onclick = (e) => {
			e.stopPropagation();
			const parentPaths = new Set(selectedEntries.map(s => s.parentFolderUri.toString()));
			for (const entry of this.renderedOrder) {
				if (parentPaths.has(entry.parentFolderUri.toString()) && entry.child.type !== 'file') {
					this.selectedItemIds.add(entry.canonicalId);
				}
			}
			this.updateSelectionVisuals();
		};

		// Batch Delete button
		const delBtn = append(actionsGroup, $('button', {
			style: 'padding: 2px 7px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.5); color: #f87171; font-weight: 600; display: flex; align-items: center; gap: 3px;'
		}));
		append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), { style: 'font-size: 10px;' }));
		append(delBtn, $('span', {}, `Delete (${selectedEntries.length})`));
		delBtn.title = 'Delete all selected tickets/items (Move to Trash)';
		delBtn.onclick = async (e) => {
			e.stopPropagation();
			await this.deleteSelectedItems(selectedEntries.map(s => s.child));
		};

		// Clear selection button
		const clearBtn = append(actionsGroup, $('button', {
			style: 'padding: 2px 5px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); color: inherit; opacity: 0.8;'
		}, '\u2715'));
		clearBtn.title = 'Clear selection (Esc)';
		clearBtn.onclick = (e) => {
			e.stopPropagation();
			this.selectedItemIds.clear();
			this.updateSelectionVisuals();
		};
		void leftInfo;
	}

	private async deleteSelectedItems(explicitItems?: IWorkspaceChildItem[]): Promise<void> {
		const rawItems = explicitItems && explicitItems.length > 0
			? explicitItems
			: this.renderedOrder.filter(r => this.selectedItemIds.has(r.canonicalId)).map(r => r.child);

		if (rawItems.length === 0) {
			return;
		}

		// Deduplicate and filter out descendants whose parent directory is also in the delete list
		const uniqueByPath = new Map<string, IWorkspaceChildItem>();
		for (const item of rawItems) {
			uniqueByPath.set(item.uri.fsPath, item);
		}
		const allPaths = Array.from(uniqueByPath.keys());
		const topLevelItems = Array.from(uniqueByPath.values()).filter(item => {
			const p = item.uri.fsPath;
			return !allPaths.some(other => other !== p && p.startsWith(other + '/'));
		});

		const itemLabels = topLevelItems.slice(0, 8).map(it => {
			const snap = this.workspacesExplorerService.getMetadataSnapshot(it.uri);
			const tid = it.ticketId || snap?.ticketId || it.code || it.name;
			const title = it.title || snap?.title || '';
			return title && title !== tid ? `${tid}: ${title}` : tid;
		});
		if (topLevelItems.length > 8) {
			itemLabels.push(`...and ${topLevelItems.length - 8} more`);
		}

		const confirmRes = await this.dialogService.confirm({
			type: 'warning',
			message: topLevelItems.length === 1
				? `Delete '${itemLabels[0]}'?`
				: `Delete ${topLevelItems.length} selected items?`,
			detail: `The following item(s) will be moved to Trash:\n\n${itemLabels.map(l => `• ${l}`).join('\n')}`,
			primaryButton: topLevelItems.length === 1 ? 'Delete' : `Delete ${topLevelItems.length} Items`,
			cancelButton: 'Cancel'
		});

		if (!confirmRes.confirmed) {
			return;
		}

		// Close any open editor tabs belonging to the deleted items
		for (const editorIdentifier of this.editorService.editors) {
			const resource = editorIdentifier.resource;
			const wfUri = (editorIdentifier as EditorInput & { workflowUri?: URI }).workflowUri;
			const targetUri = wfUri || resource;
			if (targetUri) {
				const shouldClose = topLevelItems.some(it =>
					this.uriIdentityService.extUri.isEqualOrParent(targetUri, it.uri)
				);
				if (shouldClose) {
					try {
						const groups = this.editorService.findEditors(editorIdentifier);
						for (const g of groups) {
							await g.group.closeEditor(editorIdentifier);
						}
					} catch { }
				}
			}
		}

		let deletedCount = 0;
		for (const item of topLevelItems) {
			try {
				await this.fileService.del(item.uri, { recursive: true, useTrash: true });
				deletedCount++;
			} catch {
				try {
					await this.fileService.del(item.uri, { recursive: true, useTrash: false });
					deletedCount++;
				} catch (err) {
					this.notificationService.error(`Failed to delete '${item.name}': ${err}`);
				}
			}
		}

		this.selectedItemIds.clear();
		this.selectedItemId = undefined;
		this.lastSelectedAnchorId = undefined;
		this.notificationService.info(`Deleted ${deletedCount} item(s).`);
		await this.renderContent();
	}

	private async markSelectedItemsRemoved(explicitItems?: IWorkspaceChildItem[]): Promise<void> {
		const items = explicitItems && explicitItems.length > 0
			? explicitItems
			: this.renderedOrder.filter(r => this.selectedItemIds.has(r.canonicalId)).map(r => r.child);
		if (items.length === 0) {
			return;
		}
		let updatedCount = 0;
		for (const item of items) {
			if (item.type === 'file' || item.type === 'folder') {
				continue;
			}
			try {
				const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(item.uri);
				const removedStatus = wsStatuses.removedStatus || 'Removed';
				await this.workspacesExplorerService.setEntityStatus(item.uri, removedStatus);
				updatedCount++;
			} catch { }
		}
		this.selectedItemIds.clear();
		this.notificationService.info(`Marked ${updatedCount} ticket(s) as Removed.`);
		await this.renderContent();
	}

	/**
	 * Restores removed tickets (UI-19): each one gets back the status it had before its removal (from its CI-50 change
	 * log, else the lifecycle's initial status), recorded with actor User. Agents are also set back to idle.
	 */
	private async _restoreTickets(items: readonly IWorkspaceChildItem[]): Promise<void> {
		const templates = items.length > 0 ? await this._getCustomModules(items[0].uri) : [];
		const messages: string[] = [];
		let failed = 0;
		for (const item of items) {
			try {
				const result = await this.workspacesExplorerService.restoreEntity(item.uri, 'User', findTemplateForType(templates, item.type)?.statuses);
				if (item.type === 'agent' && this.agentsManagerService) {
					const agentsList = await this.agentsManagerService.getAgents();
					const matchingAgent = agentsList.find(a => a.folderPath === item.uri.fsPath);
					if (matchingAgent) {
						await this.agentsManagerService.updateAgent({ ...matchingAgent, status: 'idle' });
					}
				}
				const name = item.title || item.name;
				messages.push(result.changed ? `${describeRestoreDecision(result, name)}.` : `'${name}' is not removed (${result.status || 'no status'}); left unchanged.`);
			} catch (err) {
				failed++;
				this.notificationService.error(`Failed to restore '${item.name}': ${err}`);
			}
		}
		if (messages.length === 1) {
			this.notificationService.info(messages[0]);
		} else if (messages.length > 1) {
			this.notificationService.info(`${messages.length} ticket(s) processed${failed > 0 ? `, ${failed} failed` : ''}: ${messages.join(' ')}`);
		}
		this.selectedItemIds.clear();
		await this.renderContent();
	}

	/** Reads the hidden status categories, migrating the UI-15 boolean "Hide Done & Removed" key once (UI-16). */
	private _loadHiddenStatusCategories(): Set<CanonicalStatusCategory> {
		const raw = this._storageService.get(HIDDEN_STATUS_CATEGORIES_STORAGE_KEY, StorageScope.PROFILE);
		const legacyRaw = this._storageService.get(LEGACY_HIDE_FINISHED_TICKETS_STORAGE_KEY, StorageScope.PROFILE);
		const hidden = resolveHiddenCategories(raw, legacyRaw === undefined ? undefined : legacyRaw === 'true');
		if (legacyRaw !== undefined) {
			if (raw === undefined) {
				this._storageService.store(HIDDEN_STATUS_CATEGORIES_STORAGE_KEY, serializeHiddenCategories(hidden), StorageScope.PROFILE, StorageTarget.USER);
			}
			this._storageService.remove(LEGACY_HIDE_FINISHED_TICKETS_STORAGE_KEY, StorageScope.PROFILE);
		}
		return hidden;
	}

	private _setHiddenStatusCategories(hidden: ReadonlySet<CanonicalStatusCategory>, filterIcon: HTMLElement): void {
		this._hiddenStatusCategories = hidden;
		this._storageService.store(HIDDEN_STATUS_CATEGORIES_STORAGE_KEY, serializeHiddenCategories(hidden), StorageScope.PROFILE, StorageTarget.USER);
		this._updateStatusFilterIcon(filterIcon);
		this.renderContent();
	}

	private _updateStatusFilterIcon(icon: HTMLElement): void {
		const active = this._hiddenStatusCategories.size > 0;
		icon.className = ThemeIcon.asClassName(active ? Codicon.filterFilled : Codicon.filter);
		icon.style.opacity = active ? '1' : '0.7';
		icon.style.color = active ? '#38bdf8' : '';
		icon.title = describeStatusFilter(this._hiddenStatusCategories);
	}

	/** Ticket rows have a status / priority; files, folders, agents (runtime status) and workspaces do not (UI-18). */
	private static _hasStatusSemantics(item: IWorkspaceChildItem): boolean {
		const type = (item.type || '').toLowerCase();
		return type !== 'file' && type !== 'folder' && type !== 'agent' && type !== 'workspace';
	}

	private async _readTicketMd(entityUri: URI): Promise<string | undefined> {
		for (const uri of [URI.joinPath(entityUri, '.agents', 'ticket.md'), URI.joinPath(entityUri, 'ticket.md')]) {
			try {
				return (await this.fileService.readFile(uri, { length: 16384 })).value.toString();
			} catch {
				// try the next location
			}
		}
		return undefined;
	}

	/**
	 * "Set Status" / "Set Priority" submenus of a ticket row (UI-18). They apply to every selected ticket (files,
	 * folders, agents skipped); statuses come from the right-clicked ticket's effective lifecycle and a ticket whose
	 * lifecycle lacks the picked status is left unchanged. Writes are recorded by CI-50 with actor User.
	 */
	private async _createSetStatusPriorityMenus(child: IWorkspaceChildItem, selectedChildren: readonly IWorkspaceChildItem[]): Promise<IAction[]> {
		if (!MainWorkspaceViewPane._hasStatusSemantics(child)) {
			return [];
		}
		const targets = (selectedChildren.length > 1 ? selectedChildren : [child]).filter(c => MainWorkspaceViewPane._hasStatusSemantics(c));
		if (targets.length === 0) {
			return [];
		}
		const templates = await this._getCustomModules(child.uri);
		const lifecycleOf = async (item: IWorkspaceChildItem) => resolveEffectiveStatusOptions(findTemplateForType(templates, item.type)?.statuses, await this.workspacesExplorerService.getWorkspaceStatuses(item.uri));
		const current = await Promise.all(targets.map(async item => {
			const text = await this._readTicketMd(item.uri);
			return {
				item,
				status: (text !== undefined ? readTicketStatus(text) : undefined) ?? item.status,
				priority: (text !== undefined ? readTopLevelMetadata(text, 'Priority') : undefined) || DEFAULT_TICKET_PRIORITY
			};
		}));
		const allHave = (field: 'status' | 'priority', value: string) => current.every(c => (c[field] ?? '').trim().toLowerCase() === value.toLowerCase());
		const suffix = targets.length > 1 ? ` (${targets.length} Tickets)` : '';

		const runForAll = async (label: string, apply: (item: IWorkspaceChildItem) => Promise<boolean>) => {
			let changed = 0;
			let skipped = 0;
			let failed = 0;
			for (const item of targets) {
				try {
					if (await apply(item)) {
						changed++;
					} else {
						skipped++;
					}
				} catch (err) {
					failed++;
					console.error(`[WorkspacesExplorer] Failed to set ${label} of '${item.name}':`, err);
				}
			}
			if (failed > 0) {
				this.notificationService.error(`Failed to set ${label} of ${failed} ticket(s).`);
			}
			if (skipped > 0) {
				this.notificationService.info(`Set ${label} of ${changed} ticket(s); ${skipped} skipped (value not in their lifecycle).`);
			}
			await this.renderContent();
		};

		const ownLifecycle = await lifecycleOf(child);
		const ownCurrent = current.find(c => c.item === child)?.status;
		const groups = groupStatusOptions(ownLifecycle.options, targets.length === 1 ? ownCurrent : undefined);
		const statusActions: IAction[] = [];
		for (const group of groups) {
			if (statusActions.length > 0) {
				statusActions.push(new Separator());
			}
			for (const option of group.items) {
				statusActions.push(toAction({
					id: `set_status_${option.status}`,
					label: option.isOutsideLifecycle ? `${option.status} (not in lifecycle)` : option.status,
					tooltip: `${option.status} (${option.category})`,
					checked: allHave('status', option.status),
					enabled: !option.isOutsideLifecycle,
					run: () => runForAll('status', async item => {
						const match = findStatusOption((await lifecycleOf(item)).options, option.status);
						if (!match) {
							return false;
						}
						await this.workspacesExplorerService.setEntityStatus(item.uri, match.status, 'User');
						return true;
					})
				}));
			}
		}

		const priorityActions = buildPriorityOptions(targets.length === 1 ? current[0]?.priority : undefined).map(p => toAction({
			id: `set_priority_${p.level}`,
			label: p.isOutsideLevels ? `${p.level} (non-standard)` : p.level,
			checked: allHave('priority', p.level),
			enabled: !p.isOutsideLevels,
			run: () => runForAll('priority', async item => {
				await this.workspacesExplorerService.setEntityPriority(item.uri, p.level, 'User');
				return true;
			})
		}));

		return [
			new SubmenuAction('set_status', `Set Status${suffix}`, statusActions),
			new SubmenuAction('set_priority', `Set Priority${suffix}`, priorityActions)
		];
	}

	/** "Child Count" submenu of the row / workspace context menus (UI-17); the choice applies to the whole tree. */
	private _createChildCountMenu(): SubmenuAction {
		return new SubmenuAction('child_count_mode', 'Child Count', CHILD_COUNT_MODES.map(({ mode, label }) => toAction({
			id: `child_count_mode_${mode}`,
			label,
			checked: this._childCountMode === mode,
			run: () => {
				this._childCountMode = mode;
				this._storageService.store(CHILD_COUNT_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
				this.renderContent();
			}
		})));
	}

	/**
	 * Appends the child-count pill for the ticket / workspace folder `folderUri` (UI-17) and returns its part of the
	 * row's visual signature. Rendering never waits for the scan: a cached (possibly stale) summary is used right away,
	 * and the tree re-renders once a newer summary is ready.
	 */
	private _appendChildCountPill(container: HTMLElement, folderUri: URI): string {
		// the summary is loaded even when the count is off: failing descendants (UI-20) still show as a red dot
		const summary = this.workspacesExplorerService.peekTicketSubtreeSummary(folderUri);
		this.workspacesExplorerService.getTicketSubtreeSummary(folderUri).then(fresh => {
			if (fresh !== summary) {
				this._scheduleChildCountRender();
			}
		}, () => { /* unreadable folder: no pill */ });
		if (!summary) {
			return 'pending';
		}
		const filterKey = `${Array.from(this._hiddenStatusCategories).sort().join(',')}|${this._showRemovedItems ? '1' : '0'}`;
		let memo = this._childCountMemo.get(summary);
		if (!memo || memo.key !== filterKey) {
			memo = {
				key: filterKey,
				counts: countSubtree(summary, this._hiddenStatusCategories, this._showRemovedItems),
				failing: collectFailingDescendants(summary, this._hiddenStatusCategories, this._showRemovedItems)
			};
			this._childCountMemo.set(summary, memo);
		}
		// UI-20: a red pill (or a red dot when the count is off) on every ancestor of a failing ticket
		const failingText = describeFailingBelow(memo.failing);
		const pill = describeChildCountPill(memo.counts, this._childCountMode);
		if (!pill) {
			if (!failingText) {
				return 'none';
			}
			const dot = append(container, $('span.ticket-failing-dot', {
				style: 'flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));'
			}));
			dot.title = failingText;
			dot.setAttribute('role', 'img');
			dot.setAttribute('aria-label', failingText);
			return `dot:${failingText}`;
		}
		const style = failingText
			? 'flex-shrink: 0; font-size: 8.5px; line-height: 12px; padding: 0 5px; border-radius: 6px; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, rgba(229, 20, 0, 0.16)); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));'
			: 'flex-shrink: 0; font-size: 8.5px; line-height: 12px; padding: 0 5px; border-radius: 6px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); background: rgba(128, 128, 128, 0.14); border: 1px solid rgba(128, 128, 128, 0.28);';
		const pillEl = append(container, $(failingText ? 'span.ticket-child-count.ticket-child-count-failing' : 'span.ticket-child-count', { style }, pill.text));
		pillEl.title = failingText ? `${failingText}\n\n${pill.tooltip}` : pill.tooltip;
		return `${this._childCountMode}:${pill.text}:${pillEl.title}`;
	}

	/**
	 * UI-20: a red error icon after the title of a failing ticket, explaining why on hover.
	 * UI-23: a test-case ticket (one with a result field) always shows exactly one result icon: the red error icon when
	 * failing, otherwise a green check (Pass), a muted slashed circle (Blocked) or a muted circle (Not Run / empty).
	 * Only failures propagate to the ancestors (see {@link _appendChildCountPill}).
	 */
	private _appendTicketFailureMarker(container: HTMLElement, ticketUri: URI): string {
		const failure = this.workspacesExplorerService.peekTicketFailure(ticketUri);
		const testResult = this.workspacesExplorerService.peekTicketTestResult(ticketUri);
		const resultState = testResult ? classifyTestResult(testResult.value) : undefined;
		if (failure) {
			const reasons = describeTicketFailure(failure);
			const text = resultState === 'failed' ? `${describeTestResult('failed')}\n${reasons}` : reasons;
			this._appendTicketMarker(container, 'span.ticket-failing-marker', Codicon.error, 'var(--vscode-errorForeground)', text);
			return `fail:${text}`;
		}
		if (!resultState) {
			return '';
		}
		const text = describeTestResult(resultState);
		switch (resultState) {
			case 'passed':
				this._appendTicketMarker(container, 'span.ticket-test-result-marker.ticket-test-passed', Codicon.pass, 'var(--vscode-testing-iconPassed, #22c55e)', text);
				break;
			case 'blocked':
				this._appendTicketMarker(container, 'span.ticket-test-result-marker.ticket-test-blocked', Codicon.circleSlash, 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))', text);
				break;
			default:
				// 'failed' without a failure cannot happen (a failing value always fails); shown as not run
				this._appendTicketMarker(container, 'span.ticket-test-result-marker.ticket-test-not-run', Codicon.circleLargeOutline, 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))', text, '9.5px');
				break;
		}
		return `test:${resultState}:${testResult?.value ?? ''}`;
	}

	private _appendTicketMarker(container: HTMLElement, selector: string, icon: ThemeIcon, color: string, text: string, fontSize = '11px'): void {
		const marker = append(container, $(selector + ThemeIcon.asCSSSelector(icon), {
			style: `flex-shrink: 0; font-size: ${fontSize}; color: ${color};`
		}));
		marker.title = text;
		marker.setAttribute('role', 'img');
		marker.setAttribute('aria-label', text);
	}

	private _scheduleChildCountRender(): void {
		if (this._childCountRenderTimer) {
			return;
		}
		this._childCountRenderTimer = setTimeout(() => {
			this._childCountRenderTimer = undefined;
			if (this.isBodyVisible()) {
				this.renderContent();
			}
		}, 100);
	}

	/** Whether a workspace / ticket row is expanded; in search results (UI-21) the path to every match is. */
	private _isNodeExpanded(canonicalId: string): boolean {
		if (this._activeSearch) {
			return this._activeSearch.tree.expanded.has(canonicalId) && !this._searchCollapsed.has(canonicalId);
		}
		return this.expandedWorkspaces.has(canonicalId);
	}

	/** Toggles a row; in search results only the search view's own collapsed set changes. Returns the new state. */
	private _toggleNodeExpanded(canonicalId: string): boolean {
		if (this._activeSearch) {
			if (this._searchCollapsed.has(canonicalId)) {
				this._searchCollapsed.delete(canonicalId);
			} else {
				this._searchCollapsed.add(canonicalId);
			}
			return this._isNodeExpanded(canonicalId);
		}
		if (this.expandedWorkspaces.has(canonicalId)) {
			this.expandedWorkspaces.delete(canonicalId);
			this.nodeVisibleLimitMap.delete(canonicalId);
			return false;
		}
		this.expandedWorkspaces.add(canonicalId);
		return true;
	}

	/** Fills `container` with `text`, the `range` part highlighted in the list highlight color (UI-21). */
	private _appendHighlightedText(container: HTMLElement, text: string, range: readonly [number, number] | undefined, underline: boolean): void {
		if (!range) {
			container.textContent = text;
			return;
		}
		for (const segment of splitHighlight(text, range)) {
			if (segment.highlight) {
				append(container, $('span.ticket-search-highlight', {
					style: `color: var(--vscode-list-highlightForeground); font-weight: 700;${underline ? ' text-decoration: underline;' : ''}`
				}, segment.text));
			} else {
				append(container, $('span', undefined, segment.text));
			}
		}
	}

	private _clearFilter(): void {
		if (this._searchTimer) {
			clearTimeout(this._searchTimer);
			this._searchTimer = undefined;
		}
		if (this._filterInputEl) {
			this._filterInputEl.value = '';
		}
		this.filterText = '';
		this._searchCollapsed.clear();
	}

	/** Enter in the filter box (UI-21): an exact ticket ID (or a single result) is opened and revealed in the tree. */
	private async _openTicketFromFilter(): Promise<void> {
		const raw = this._filterInputEl?.value ?? '';
		const query = normalizeTicketQuery(raw);
		if (!query) {
			return;
		}
		const index = await this.workspacesExplorerService.getTicketSearchIndex();
		if (normalizeTicketQuery(this._filterInputEl?.value ?? '') !== query) {
			return; // typed on meanwhile
		}
		let target = findExactIdMatch(index.entries, query, this._showRemovedItems);
		if (!target && query.length >= TICKET_SEARCH_MIN_QUERY_LENGTH) {
			const result = searchTickets(index.entries, query, { includeRemoved: this._showRemovedItems, limit: 2 });
			if (result.total === 1) {
				target = result.matches[0].entry;
			}
		}
		if (target) {
			await this.revealTicket(target, true);
		} else if (this._searchTimer) {
			// no exact ID: show the results right away instead of waiting for the debounce
			clearTimeout(this._searchTimer);
			this._searchTimer = undefined;
			this.renderContent();
		}
	}

	/**
	 * Shows `entry` in the normal tree (clears the search, expands the workspace and every ancestor, loads all
	 * children along the path, selects and scrolls to the row) and optionally opens it like a click does (UI-21).
	 */
	async revealTicket(entry: ITicketSearchEntry, open: boolean): Promise<void> {
		this._clearFilter();
		const pathKeys = [entry.workspaceKey, ...entry.ancestors.map(a => a.key)];
		const REVEAL_LIMIT = 100000;
		for (const key of [...pathKeys, this.getCanonicalId(entry.workspaceResource)]) {
			this.expandedWorkspaces.add(key);
			if ((this.nodeVisibleLimitMap.get(key) ?? 0) < REVEAL_LIMIT) {
				this.nodeVisibleLimitMap.set(key, REVEAL_LIMIT); // the ticket may be past the first page of its level
			}
		}
		this.selectedWorkspaceId = entry.workspaceKey;
		this.selectedItemId = entry.key;
		this.lastSelectedAnchorId = entry.key;
		this.selectedItemIds.clear();
		this.selectedItemIds.add(entry.key);
		this._scrollToSelectionPending = true;
		const rendered = this.renderContent();
		if (open) {
			await this._openTicketEditor(entry.resource, entry.type);
		}
		await rendered;
	}

	/** Opens a ticket the way a click on its row does. */
	private async _openTicketEditor(uri: URI, type: string | undefined): Promise<void> {
		const name = basename(uri);
		try {
			if (type === 'workflow') {
				await this.editorService.openEditor(new WorkflowEditorInput(uri, name), { pinned: true });
			} else if (type && isSubWorkflowTicketType(type)) {
				await openSubWorkflowTicketCanvas(this.editorService, uri, name);
			} else {
				await this.editorService.openEditor(new EntityDetailEditorInput(uri, name), { pinned: true });
			}
		} catch (err) {
			this.notificationService.error(`Failed to open ticket '${name}': ${err}`);
		}
	}

	/** Multi-select status-category filter dropdown (UI-16). Stays open while toggling; closes on outside click / Escape. */
	private _showStatusFilterMenu(anchor: HTMLElement): void {
		this._statusFilterMenu = this.contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container) => {
				const store = new DisposableStore();
				const menu = append(container, $('.anyagent-status-filter-menu', {
					style: 'min-width: 190px; padding: 4px 0; border-radius: 6px; font-size: 12px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);'
				}));
				menu.setAttribute('role', 'menu');

				const addItem = (label: string, checked: boolean | undefined, dotColor: string | undefined, title: string, onSelect: () => void) => {
					const row = append(menu, $('div', {
						style: 'display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 6px; cursor: pointer; white-space: nowrap;'
					}));
					row.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
					if (checked !== undefined) {
						row.setAttribute('aria-checked', String(checked));
					}
					row.tabIndex = 0;
					row.title = title;
					const check = append(row, $('span' + ThemeIcon.asCSSSelector(Codicon.check)));
					check.style.visibility = checked ? 'visible' : 'hidden';
					check.style.fontSize = '12px';
					if (dotColor) {
						append(row, $('span', { style: `width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: ${dotColor};` }));
					}
					append(row, $('span', {}, label));
					store.add(addDisposableListener(row, EventType.MOUSE_OVER, () => {
						row.style.background = 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))';
						row.style.color = 'var(--vscode-menu-selectionForeground, inherit)';
					}));
					store.add(addDisposableListener(row, EventType.MOUSE_OUT, () => {
						row.style.background = '';
						row.style.color = '';
					}));
					const select = (e: Event) => {
						e.preventDefault();
						e.stopPropagation();
						onSelect();
						rerender();
					};
					store.add(addDisposableListener(row, EventType.CLICK, select));
					store.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
						if (e.key === 'Enter' || e.key === ' ') {
							select(e);
						}
					}));
				};

				const addSeparator = () => {
					append(menu, $('div', { style: 'height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));' }));
				};

				const rerender = () => {
					store.clear();
					clearNode(menu);
					renderItems();
				};

				const renderItems = () => {
					const hidden = this._hiddenStatusCategories;
					for (const category of STATUS_CATEGORIES) {
						const isVisible = !hidden.has(category);
						addItem(category, isVisible, STATUS_CATEGORY_COLORS[category].text, isVisible ? `Hide ${category} tickets` : `Show ${category} tickets`, () => {
							this._setHiddenStatusCategories(toggleHiddenCategory(this._hiddenStatusCategories, category), anchor);
						});
					}
					addSeparator();
					addItem('Show All', undefined, undefined, 'Show tickets of every status', () => {
						this._setHiddenStatusCategories(new Set(), anchor);
					});
					addItem('Hide Done & Removed', undefined, undefined, 'Show only Todo, In Progress and Blocked tickets', () => {
						this._setHiddenStatusCategories(new Set(FINISHED_CATEGORIES), anchor);
					});
				};
				renderItems();

				// close on outside click / Escape (clicks on the funnel itself are handled by its toggle)
				const win = getWindow(anchor);
				const outer = new DisposableStore();
				outer.add(store);
				outer.add(addDisposableListener(win, EventType.MOUSE_DOWN, (e: MouseEvent) => {
					const target = e.target as Node | null;
					if (target && !menu.contains(target) && !anchor.contains(target)) {
						this._statusFilterMenu?.close();
					}
				}, true));
				outer.add(addDisposableListener(win, EventType.KEY_DOWN, (e: KeyboardEvent) => {
					if (e.key === 'Escape') {
						this._statusFilterMenu?.close();
					}
				}, true));
				return outer;
			},
			onHide: () => {
				this._statusFilterMenu = undefined;
			}
		});
	}

	private _ensureStaticChrome(): void {
		if (!this.containerEl || this.treeBoxEl) {
			return;
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

		const headerIcons = append(headerRow, $('div', { style: 'display: flex; align-items: center; gap: 8px;' }));
		// UI-21: Go to Ticket (quick pick over every ticket of every workspace)
		const goToTicketIcon = append(headerIcons, $('span' + ThemeIcon.asCSSSelector(Codicon.search)));
		goToTicketIcon.style.cursor = 'pointer';
		goToTicketIcon.style.opacity = '0.85';
		const goToKeybinding = this.keybindingService.lookupKeybinding(GO_TO_TICKET_COMMAND_ID)?.getLabel();
		goToTicketIcon.title = goToKeybinding ? `Go to Ticket... (${goToKeybinding})` : 'Go to Ticket...';
		goToTicketIcon.setAttribute('role', 'button');
		goToTicketIcon.setAttribute('aria-label', 'Go to Ticket');
		goToTicketIcon.onclick = (e) => {
			e.stopPropagation();
			this.commandService.executeCommand(GO_TO_TICKET_COMMAND_ID);
		};
		const statusFilterIcon = append(headerIcons, $('span'));
		statusFilterIcon.style.cursor = 'pointer';
		this._updateStatusFilterIcon(statusFilterIcon);
		statusFilterIcon.onclick = (e) => {
			e.stopPropagation();
			if (this._statusFilterMenu) {
				this._statusFilterMenu.close();
				return;
			}
			this._showStatusFilterMenu(statusFilterIcon);
		};

		const addWsIcon = append(headerIcons, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
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
		filterInput.placeholder = 'Search tickets by ID or title, filter workspaces...';
		filterInput.title = 'Type 2+ characters to search every ticket of every workspace by ID (e.g. 0111) or title. Enter opens an exact ticket ID.';
		filterInput.value = this.filterText;
		this._filterInputEl = filterInput;
		filterInput.oninput = () => {
			const next = normalizeTicketQuery(filterInput.value);
			const wasSearching = this.filterText.length >= TICKET_SEARCH_MIN_QUERY_LENGTH;
			this.filterText = next;
			if (this._searchTimer) {
				clearTimeout(this._searchTimer);
				this._searchTimer = undefined;
			}
			if (next.length >= TICKET_SEARCH_MIN_QUERY_LENGTH) {
				// UI-21: deep search, debounced (the index itself is cached by the service)
				this._searchTimer = setTimeout(() => {
					this._searchTimer = undefined;
					this.renderContent();
				}, TICKET_SEARCH_DEBOUNCE_MS);
				return;
			}
			if (wasSearching) {
				this._searchCollapsed.clear();
			}
			this.renderContent();
		};
		filterInput.onkeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this._openTicketFromFilter();
			} else if (e.key === 'Escape' && filterInput.value) {
				e.preventDefault();
				e.stopPropagation();
				this._clearFilter();
				this.renderContent();
			}
		};

		// --- 2.5 Batch Selection Bar (visible when 2+ items are selected via Cmd/Ctrl+Click or Shift+Click) ---
		this.batchActionBarEl = append(this.containerEl, $('.batch-selection-bar', {
			style: 'display: none; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 8px; border-radius: 5px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.35); flex-shrink: 0;'
		}));

		// --- 3. Workspace Multi-Tree List ---
		this.treeBoxEl = append(this.containerEl, $('.tree-box'));
		this.treeBoxEl.style.flex = '1';
		this.treeBoxEl.style.overflowY = 'auto';
		this.treeBoxEl.style.display = 'flex';
		this.treeBoxEl.style.flexDirection = 'column';
		this.treeBoxEl.style.gap = '6px';
		this.treeBoxEl.style.minHeight = '0';
		this.treeBoxEl.style.paddingRight = '2px';
	}

	private _reconcileDomChildren(liveParent: HTMLElement, stagingParent: HTMLElement): void {
		const desiredNodes = Array.from(stagingParent.children) as HTMLElement[];
		const desiredKeys = new Set<string>();
		for (const node of desiredNodes) {
			const k = node.getAttribute('data-sync-key');
			if (k) {
				desiredKeys.add(k);
			}
		}

		// 1. Remove any stale nodes in liveParent that are no longer in desiredNodes
		const existingByKey = new Map<string, HTMLElement>();
		const currentChildren = Array.from(liveParent.children) as HTMLElement[];
		for (const child of currentChildren) {
			const k = child.getAttribute('data-sync-key');
			if (!k || !desiredKeys.has(k)) {
				child.remove();
			} else {
				existingByKey.set(k, child);
			}
		}

		// 2. Reconcile in-order without disturbing unchanged nodes or scroll positions
		for (let i = 0; i < desiredNodes.length; i++) {
			const desired = desiredNodes[i];
			const key = desired.getAttribute('data-sync-key');
			const existing = key ? existingByKey.get(key) : undefined;
			const isContainer = desired.getAttribute('data-sync-container') === '1';

			if (existing) {
				if (isContainer) {
					if (liveParent.children[i] !== existing) {
						liveParent.insertBefore(existing, liveParent.children[i] || null);
					}
					this._reconcileDomChildren(existing, desired);
				} else {
					const existingSig = existing.getAttribute('data-visual-sig');
					const desiredSig = desired.getAttribute('data-visual-sig');
					if (existingSig !== null && existingSig === desiredSig) {
						const desiredEntry = this.rowRenderEntries.get(desired);
						if (desiredEntry) {
							this.rowRenderEntries.set(existing, {
								...desiredEntry,
								rowEl: existing
							});
						}
						if (liveParent.children[i] !== existing) {
							liveParent.insertBefore(existing, liveParent.children[i] || null);
						}
					} else {
						liveParent.replaceChild(desired, existing);
					}
				}
			} else {
				liveParent.insertBefore(desired, liveParent.children[i] || null);
			}
		}
	}

	/**
	 * Which workspace / item is selected and which nodes are expanded is kept per window, so the tree comes back
	 * the same way after the app is closed and reopened (together with the restored editor tabs).
	 */
	private static readonly VIEW_STATE_KEY = 'anyagent.workspacesExplorer.viewState';
	private _lastSavedViewState = '';

	/** Pinned workspaces (UI-11), keyed by canonical workspace id; kept per profile, not in workspace files. */
	private _getWorkspacePins(): IWorkspacePin[] {
		return parseWorkspacePins(this._storageService.get(WORKSPACE_PINS_STORAGE_KEY, StorageScope.PROFILE));
	}

	private _toggleWorkspacePin(canonicalWsId: string): void {
		const pins = this._getWorkspacePins();
		const next = isWorkspacePinned(pins, canonicalWsId) ? unpinWorkspace(pins, canonicalWsId) : pinWorkspace(pins, canonicalWsId, Date.now());
		if (next.length === 0) {
			this._storageService.remove(WORKSPACE_PINS_STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this._storageService.store(WORKSPACE_PINS_STORAGE_KEY, serializeWorkspacePins(next), StorageScope.PROFILE, StorageTarget.USER);
		}
		this.renderContent();
	}

	private _restoreViewState(): void {
		try {
			const raw = this._storageService.get(MainWorkspaceViewPane.VIEW_STATE_KEY, StorageScope.WORKSPACE, '');
			if (!raw) {
				return;
			}
			const data = JSON.parse(raw) as { selectedWorkspaceId?: string; selectedItemId?: string; expanded?: string[] };
			this.selectedWorkspaceId = typeof data.selectedWorkspaceId === 'string' ? data.selectedWorkspaceId : undefined;
			this.selectedItemId = typeof data.selectedItemId === 'string' ? data.selectedItemId : undefined;
			if (Array.isArray(data.expanded)) {
				this.expandedWorkspaces = new Set(data.expanded.filter(id => typeof id === 'string'));
				this.hasInitializedExpansion = true;
			}
			this._lastSavedViewState = raw;
		} catch {
			// ignore a corrupt entry; the default view state is used
		}
	}

	private _saveViewState(): void {
		const raw = JSON.stringify({
			selectedWorkspaceId: this.selectedWorkspaceId,
			selectedItemId: this.selectedItemId,
			expanded: Array.from(this.expandedWorkspaces)
		});
		if (raw !== this._lastSavedViewState) {
			this._lastSavedViewState = raw;
			this._storageService.store(MainWorkspaceViewPane.VIEW_STATE_KEY, raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	private async renderContent(): Promise<void> {
		if (!this.containerEl) {
			return;
		}

		this._ensureStaticChrome();
		const currentVersion = ++this.renderVersion;

		const workspacePins = this._getWorkspacePins();
		const workspaces = orderByPins(await this.workspacesExplorerService.getWorkspaces(), workspacePins, w => this.getCanonicalId(w.id));
		if (this.renderVersion !== currentVersion || !this.containerEl || !this.treeBoxEl) {
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

		// Build desired DOM structure offscreen so live DOM stays 100% untouched during async disk scans
		const treeBox = $('.tree-box-staging');

		// UI-21: 2+ characters search every ticket of every workspace; the tree then shows only the paths to the matches
		let search: typeof this._activeSearch;
		if (this.filterText.length >= TICKET_SEARCH_MIN_QUERY_LENGTH) {
			const query = this.filterText;
			const index = await this.workspacesExplorerService.getTicketSearchIndex();
			if (this.renderVersion !== currentVersion || !this.containerEl || !this.treeBoxEl) {
				return;
			}
			const result = searchTickets(index.entries, query, { includeRemoved: this._showRemovedItems });
			search = { result, tree: buildPrunedTicketTree(result.matches), note: describeSearchResult(result, this._filterInputEl?.value ?? query, index.truncated) };
		}
		this._activeSearch = search;

		const workspaceNameMatches = (w: IWorkspaceItem) => !this.filterText || w.name.toLowerCase().includes(this.filterText) || w.uri.fsPath.toLowerCase().includes(this.filterText);
		const filteredWorkspaces = search
			? workspaces.filter(w => search.tree.workspaceKeys.has(this.getCanonicalId(w.id)) || workspaceNameMatches(w))
			: workspaces.filter(workspaceNameMatches);

		if (filteredWorkspaces.length > 0 && (!this.selectedWorkspaceId || (!this.filterText && !filteredWorkspaces.some(w => this.getCanonicalId(w.id) === this.selectedWorkspaceId)))) {
			this.selectedWorkspaceId = this.getCanonicalId(filteredWorkspaces[0].id);
			this.selectedItemId = undefined;
		}
		this._saveViewState();

		this.targetSelectedElement = undefined;

		if (search) {
			const noteEl = append(treeBox, $('div.ticket-search-note', {
				style: `font-size: 10.5px; padding: 0 2px; flex-shrink: 0; color: var(--vscode-descriptionForeground);${search.result.total === 0 ? ' text-align: center; padding: 10px 0;' : ''}`
			}, search.note));
			noteEl.setAttribute('data-sync-key', 'ticket-search-note');
			noteEl.setAttribute('data-visual-sig', `note:${search.note}`);
			noteEl.setAttribute('aria-live', 'polite');
		}

		if (filteredWorkspaces.length === 0) {
			if (!search) {
				const emptyEl = append(treeBox, $('div', { style: 'font-size: 11px; opacity: 0.5; padding: 10px 0; text-align: center;' }, 'No workspaces added yet.'));
				emptyEl.setAttribute('data-sync-key', 'empty-workspaces');
				emptyEl.setAttribute('data-visual-sig', 'empty');
			}
		} else {
			for (const ws of filteredWorkspaces) {
				const canonicalWsId = this.getCanonicalId(ws.id);
				const wsCard = append(treeBox, $('.workspace-item-card'));
				wsCard.setAttribute('data-sync-key', `ws:${canonicalWsId}`);
				wsCard.setAttribute('data-sync-container', '1');
				wsCard.setAttribute('data-ws-id', canonicalWsId);
				wsCard.style.borderRadius = '6px';
				wsCard.style.flexShrink = '0';

				const isWorkspaceSelected = this.selectedWorkspaceId === canonicalWsId;

				if (isWorkspaceSelected) {
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

				const isExpanded = this._isNodeExpanded(canonicalWsId);
				const isPinned = isWorkspacePinned(workspacePins, canonicalWsId);

				// Card Header
				const cardHeader = append(wsCard, $('.card-header-row'));
				cardHeader.setAttribute('data-sync-key', `ws-header:${canonicalWsId}`);
				cardHeader.style.display = 'flex';
				cardHeader.style.alignItems = 'center';
				cardHeader.style.justifyContent = 'space-between';
				cardHeader.style.padding = '6px 8px';
				cardHeader.style.cursor = 'pointer';
				cardHeader.title = `${ws.name} - ${ws.uri.fsPath} (Right click for menu, drag to reorder, double click to open in window)`;

				if (isWorkspaceSelected && !this.selectedItemId) {
					this.targetSelectedElement = cardHeader;
				}

				// Native VS Code Context Menu on Right Click
				cardHeader.oncontextmenu = (e) => {
					e.preventDefault();
					e.stopPropagation();

					const actions = [
						new Action('toggle_pin_workspace', isPinned ? 'Unpin' : 'Pin to Top', ThemeIcon.asClassName(isPinned ? Codicon.pinned : Codicon.pin), true, async () => {
							this._toggleWorkspacePin(canonicalWsId);
						}),
						new Action('refresh_workspace', 'Refresh', ThemeIcon.asClassName(Codicon.refresh), true, async () => {
							this.workspacesExplorerService.refreshCaches(ws.uri);
							this.renderContent();
							const activeEditor = this.editorService.activeEditorPane;
							if (activeEditor && isRefreshablePane(activeEditor)) {
								await activeEditor.refresh();
							}
							this.notificationService.info(`Refreshed workspace '${ws.name}'.`);
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
						new Action('create_entity', 'Create Entity...', ThemeIcon.asClassName(Codicon.sparkleFilled), true, () => {
							this.showCreateResourceModal(ws);
						}),
						new Action('toggle_removed_items', this._showRemovedItems ? 'Hide Removed Tickets' : 'Show Removed Tickets', ThemeIcon.asClassName(this._showRemovedItems ? Codicon.eyeClosed : Codicon.eye), true, async () => {
							this._showRemovedItems = !this._showRemovedItems;
							this._storageService.store('anyagent.workspacesExplorer.showRemovedItems', this._showRemovedItems, StorageScope.PROFILE, StorageTarget.USER);
							this.renderContent();
						}),
						new Action('remove_entry', 'Remove Entry from Explorer', ThemeIcon.asClassName(Codicon.sparkleFilled), true, async () => {
							this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
								workspaceId: ws.name,
								field: '/RemoveWorkspace',
								label: `Remove '${ws.name}' from Explorer`,
								prompt: `[Workspace: "${ws.name}" | Action: "Remove Workspace Entry from Explorer" | Path: "${ws.uri.fsPath}"]\nPlease remove this workspace entry from the explorer.`
							});
						}),
						new Action('move_to_trash', 'Move to Trash...', ThemeIcon.asClassName(Codicon.sparkleFilled), true, async () => {
							this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
								workspaceId: ws.name,
								field: '/TrashWorkspace',
								label: `Move '${ws.name}' to Trash`,
								prompt: `[Workspace: "${ws.name}" | Action: "Move Workspace to OS Trash" | Path: "${ws.uri.fsPath}"]\nPlease move this workspace directory to OS Trash and clean up its references.`
							});
						})
					];

					this.contextMenuService.showContextMenu({
						getAnchor: () => ({ x: e.clientX, y: e.clientY }),
						getActions: () => [...actions, new Separator(), this._createChildCountMenu()]
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
					const expandedNow = this._toggleNodeExpanded(canonicalWsId);
					chevronIcon.className = ThemeIcon.asClassName(expandedNow ? Codicon.chevronDown : Codicon.chevronRight);
					chevronIcon.title = expandedNow ? 'Collapse' : 'Expand';
					this.renderContent();
				};

				const customModules = await this._getCustomModules(ws.uri);
				const customModulesMap = buildCustomModulesVisualMap(customModules);

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
				} else if (ws.detectedType === 'note') {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.book)));
					wsIcon.style.color = '#2dd4bf';
					badgeText = 'NOTE';
					badgeBg = 'rgba(45, 212, 191, 0.2)';
					badgeFg = '#2dd4bf';
				} else if (ws.detectedType && ws.detectedType !== 'workspace' && ws.detectedType !== 'folder') {
					const visual = getSubWorkflowTicketVisual(ws.detectedType) || customModulesMap.get(ws.detectedType.toLowerCase());
					const customIcon = visual?.icon || getCustomIconForName(ws.detectedType);
					const customColor = visual?.color || getColorForName(ws.detectedType);
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(customIcon)));
					wsIcon.style.color = customColor;
					badgeText = ws.detectedType.toUpperCase();
					badgeBg = hexToRgba(customColor, 0.2);
					badgeFg = customColor;
				} else {
					wsIcon = append(headerLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rootFolder)));
					wsIcon.style.color = 'inherit';
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

				// UI-17: visible descendant tickets of the whole workspace
				let wsChildCountSig = 'missing';
				if (!ws.isMissing) {
					wsChildCountSig = this._appendChildCountPill(headerLeft, ws.uri);
					if (headerLeft.lastElementChild !== wsTitleSpan) {
						wsTitleSpan.style.flex = '0 1 auto';
					}
				}

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

				cardHeader.setAttribute(
					'data-visual-sig',
					`${isExpanded ? '1' : '0'}|${isPinned ? 'P' : ''}|${ws.detectedType || ''}|${wsDisplayText}|${badgeText}|${badgeBg}|${badgeFg}|${wsIcon.className}|${wsIcon.style.color}|${wsChildCountSig}`
				);

				// Header Actions
				const headerActions = append(headerRight, $('.header-actions'));
				headerActions.style.display = 'flex';
				headerActions.style.alignItems = 'center';
				headerActions.style.gap = '6px';

				const createBtn = append(headerActions, $('span' + ThemeIcon.asCSSSelector(Codicon.plus)));
				createBtn.style.opacity = '0.8';
				createBtn.style.fontSize = '13px';
				createBtn.title = `New Entity in '${ws.name}'...`;
				createBtn.onclick = (e) => {
					e.stopPropagation();
					this.showCreateResourceModal(ws.uri, ws.name);
				};

				// Pin to Top / Unpin (UI-11): always visible when pinned, otherwise only while hovering the header
				const pinBtn = append(headerActions, $('span' + ThemeIcon.asCSSSelector(isPinned ? Codicon.pinned : Codicon.pin)));
				pinBtn.style.fontSize = '13px';
				pinBtn.style.opacity = '0.8';
				pinBtn.style.visibility = isPinned ? 'visible' : 'hidden';
				if (isPinned) {
					pinBtn.style.color = '#38bdf8';
				}
				pinBtn.title = isPinned ? 'Unpin' : 'Pin to Top';
				pinBtn.setAttribute('role', 'button');
				pinBtn.setAttribute('aria-label', pinBtn.title);
				pinBtn.onclick = (e) => {
					e.stopPropagation();
					this._toggleWorkspacePin(canonicalWsId);
				};
				cardHeader.onmouseenter = () => {
					cardHeader.style.backgroundColor = 'rgba(255, 255, 255, 0.04)';
					pinBtn.style.visibility = 'visible';
				};
				cardHeader.onmouseleave = () => {
					cardHeader.style.backgroundColor = 'transparent';
					pinBtn.style.visibility = isPinned ? 'visible' : 'hidden';
				};

				// Single Click: Select workspace card, open its Domain Form in main editor area, and toggle expansion in-place
				cardHeader.onclick = async () => {
					this.selectedWorkspaceId = canonicalWsId;
					this.selectedItemId = canonicalWsId;
					this.selectedItemIds.clear();
					this.lastSelectedAnchorId = undefined;

					this._toggleNodeExpanded(canonicalWsId);

					this.renderContent();

					try {
						if (ws.detectedType === 'workflow') {
							await this.editorService.openEditor(new WorkflowEditorInput(ws.uri, ws.name), { pinned: true });
						} else {
							await this.editorService.openEditor(new EntityDetailEditorInput(ws.uri, ws.name), { pinned: true });
						}
					} catch (err) {
						console.error('Failed to open Workspace domain editor', err);
					}
				};

				// Expanded Body: Inner Scrollable Children Container
				if (isExpanded) {
					const childrenContainer = append(wsCard, $('.children-container'));
					childrenContainer.setAttribute('data-sync-key', `ws-children:${canonicalWsId}`);
					childrenContainer.setAttribute('data-sync-container', '1');
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

		if (this.renderVersion === currentVersion && this.treeBoxEl) {
			this._reconcileDomChildren(this.treeBoxEl, treeBox);
			this.renderedOrder = [];
			this._collectRenderedRows(this.treeBoxEl);
			this.updateSelectionVisuals();
			if (this._scrollToSelectionPending) {
				const selectedRow = this.renderedOrder.find(r => r.canonicalId === this.selectedItemId)?.rowEl;
				if (selectedRow) {
					this._scrollToSelectionPending = false;
					selectedRow.scrollIntoView({ block: 'center' });
				}
			}
		}
	}

	/** Collects the live tree rows in document order (depth-first) into `renderedOrder`. */
	private _collectRenderedRows(parent: Element): void {
		for (const el of Array.from(parent.children)) {
			const entry = el.classList.contains('child-item-row') ? this.rowRenderEntries.get(el as HTMLElement) : undefined;
			if (entry) {
				entry.rowEl = el as HTMLElement;
				this.renderedOrder.push(entry);
			}
			this._collectRenderedRows(el);
		}
	}

	private async renderChildrenTree(
		parentContainer: HTMLElement,
		folderUri: URI,
		parentWsId: string,
		depth: number,
		currentVersion: number,
		customModulesMap?: Map<string, { color: string; icon: ThemeIcon }>
	): Promise<void> {
		if (!customModulesMap) {
			const mods = await this._getCustomModules(folderUri);
			customModulesMap = buildCustomModulesVisualMap(mods);
		}

		const parentCanonicalKey = this.getCanonicalId(folderUri);
		const visibleLimit = this.filterText
			? undefined
			: (this.nodeVisibleLimitMap.get(parentCanonicalKey) || MainWorkspaceViewPane.INITIAL_CHILDREN_BATCH_SIZE);

		const page = await this.workspacesExplorerService.scanWorkspaceChildrenPaginated(folderUri, this._showRemovedItems, visibleLimit);
		const wsLifecycle = await this.workspacesExplorerService.getWorkspaceStatuses(folderUri);
		if (this.renderVersion !== currentVersion || !this.containerEl) {
			return;
		}
		// UI-15 / UI-16: hide tickets whose status category is filtered out (with their sub-tree)
		const isTicketItem = (c: IWorkspaceChildItem) => c.type !== 'folder' && c.type !== 'file';
		// UI-21: in search results only the matches and their ancestors are shown, even when the status filter hides them
		const search = this._activeSearch;
		const { visible: children, hiddenCount } = search
			? { visible: page.items.filter(c => search.tree.visible.has(this.getCanonicalId(c.id))), hiddenCount: 0 }
			: applyStatusFilter(page.items, this._hiddenStatusCategories, c => isTicketItem(c) && c.status ? wsLifecycle.getCategory(c.status) : undefined);
		const hiddenText = describeHiddenTickets(hiddenCount);
		const appendHiddenLine = () => {
			if (hiddenText) {
				const hiddenEl = append(parentContainer, $('div', { style: `font-size: 10px; opacity: 0.45; font-style: italic; padding: 2px 0 2px ${depth * 12 + 16}px;`, title: `${describeStatusFilter(this._hiddenStatusCategories)}. Use the filter icon in the panel header to show them` }, hiddenText));
				hiddenEl.setAttribute('data-sync-key', `hidden:${parentCanonicalKey}`);
				hiddenEl.setAttribute('data-visual-sig', `hidden:${hiddenCount}:${depth}`);
			}
		};

		if (children.length === 0 && hiddenCount > 0) {
			appendHiddenLine();
			return;
		}

		if (children.length === 0) {
			if (search) {
				return;
			}
			const isPlainFolder = !await this.fileService.exists(URI.joinPath(folderUri, '.agents', 'ticket.md')) &&
				!await this.fileService.exists(URI.joinPath(folderUri, 'ticket.md'));
			if (isPlainFolder) {
				const emptyFolderEl = append(parentContainer, $('div', { style: `font-size: 11px; opacity: 0.4; padding: 4px 0 4px ${depth * 12}px;` }, '(Empty folder)'));
				emptyFolderEl.setAttribute('data-sync-key', `empty:${folderUri.toString()}`);
				emptyFolderEl.setAttribute('data-visual-sig', `empty:${depth}`);
			}
			return;
		}

		for (const child of children) {
			const canonicalChildId = this.getCanonicalId(child.id);
			const isDirectory = child.type !== 'file';
			const isExpanded = isDirectory && this._isNodeExpanded(canonicalChildId);
			const searchMatch = search?.tree.matchByKey.get(canonicalChildId);
			const isChildSelected = this.selectedItemIds.has(canonicalChildId) || (this.selectedWorkspaceId === parentWsId && this.selectedItemId === canonicalChildId);
			if (isChildSelected && this.selectedItemIds.size === 0) {
				this.selectedItemIds.add(canonicalChildId);
			}

			const isRemoved = !!(child.status && (
				child.status.toLowerCase() === 'removed' ||
				child.status.toLowerCase() === 'canceled' ||
				child.status.toLowerCase() === 'cancelled'
			));

			const childRow = append(parentContainer, $('.child-item-row'));
			childRow.setAttribute('data-sync-key', `row:${canonicalChildId}`);
			childRow.style.display = 'flex';
			childRow.style.alignItems = 'center';
			childRow.style.justifyContent = 'space-between';
			childRow.style.padding = `4px 6px 4px ${depth * 12}px`;
			childRow.style.borderRadius = '4px';
			childRow.style.cursor = 'pointer';
			childRow.style.userSelect = 'none';
			if (isRemoved) {
				childRow.style.opacity = '0.55';
			} else if (search && !searchMatch) {
				childRow.style.opacity = '0.8'; // UI-21: ancestor on the path to a match
			}
			if (searchMatch) {
				// UI-21: subtle row highlight; background-image survives the selection / hover background-color changes
				childRow.classList.add('ticket-search-match');
				const tint = 'color-mix(in srgb, var(--vscode-list-highlightForeground) 12%, transparent)';
				childRow.style.backgroundImage = `linear-gradient(${tint}, ${tint})`;
				childRow.style.boxShadow = 'inset 2px 0 0 var(--vscode-list-highlightForeground)';
			}

			this.rowRenderEntries.set(childRow, {
				canonicalId: canonicalChildId,
				child,
				parentWsId,
				parentFolderUri: folderUri,
				rowEl: childRow
			});

			let isDraggable = true;
			if (child.type === 'file' || child.type === 'folder' || isRemoved) {
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
				if (!this.selectedItemIds.has(canonicalChildId)) {
					childRow.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
				}
			};
			childRow.onmouseleave = () => {
				if (!this.selectedItemIds.has(canonicalChildId)) {
					childRow.style.backgroundColor = 'transparent';
				}
			};

			// Right click context menu
			childRow.oncontextmenu = async (e) => {
				e.preventDefault();
				e.stopPropagation();

				if (!this.selectedItemIds.has(canonicalChildId)) {
					this.selectedWorkspaceId = parentWsId;
					this.selectedItemId = canonicalChildId;
					this.lastSelectedAnchorId = canonicalChildId;
					this.selectedItemIds.clear();
					this.selectedItemIds.add(canonicalChildId);
					this.updateSelectionVisuals();
				}

				const selectedChildren = this.renderedOrder
					.filter(r => this.selectedItemIds.has(r.canonicalId))
					.map(r => r.child);

				const wsRootUri = await this.workspacesExplorerService.findWorkspaceRootUri(child.uri);
				const allWorkspaces = await this.workspacesExplorerService.getWorkspaces();
				const matchedWs = allWorkspaces.find(w => w.uri.toString() === wsRootUri.toString());
				const actualWsName = matchedWs?.name || matchedWs?.code || 'neoWorkspace';

				const rootPath = wsRootUri.path.replace(/\/+$/, '');
				const childPath = child.uri.path.replace(/\/+$/, '');
				let parentRelPath = '/';
				if (childPath.startsWith(rootPath + '/')) {
					const rel = childPath.substring(rootPath.length + 1);
					const lastSlash = rel.lastIndexOf('/');
					if (lastSlash > 0) {
						parentRelPath = '/' + rel.substring(0, lastSlash);
					}
				}

				const snapshot = this.workspacesExplorerService.getMetadataSnapshot(child.uri);
				const realTicketId = snapshot?.ticketId || child.code || child.name;

				const childActions: IAction[] = [];

				if (selectedChildren.length > 1) {
					childActions.push(
						new Action('batch_delete_selected', `Delete Selected (${selectedChildren.length} Items)...`, ThemeIcon.asClassName(Codicon.trash), true, async () => {
							await this.deleteSelectedItems(selectedChildren);
						}),
						new Action('batch_mark_removed', `Mark Selected (${selectedChildren.length}) as Removed`, ThemeIcon.asClassName(Codicon.archive), true, async () => {
							await this.markSelectedItemsRemoved(selectedChildren);
						}),
						new Action('batch_clear_selection', `Clear Selection (${selectedChildren.length})`, ThemeIcon.asClassName(Codicon.clearAll), true, async () => {
							this.selectedItemIds.clear();
							this.updateSelectionVisuals();
						})
					);
				}

				childActions.push(
					new Action('refresh_child', 'Refresh', ThemeIcon.asClassName(Codicon.refresh), true, async () => {
						this.workspacesExplorerService.refreshCaches(child.uri);
						this.renderContent();
						const activeEditor = this.editorService.activeEditorPane;
						if (activeEditor && isRefreshablePane(activeEditor)) {
							await activeEditor.refresh();
						}
						this.notificationService.info(`Refreshed '${child.name}'.`);
					})
				);

				if (isDirectory && !isRemoved) {
					childActions.push(new Action('create_sub_entity', `Create Sub-Entity...`, ThemeIcon.asClassName(Codicon.sparkleFilled), true, () => {
						this.showCreateResourceModal(child.uri, child.name);
					}));
				}

				if (child.type !== 'file' && child.type !== 'folder') {
					const formattedType = child.type.charAt(0).toUpperCase() + child.type.slice(1);
					childActions.push(
						new Action('edit_entity', `Edit ${formattedType} Details...`, ThemeIcon.asClassName(Codicon.sparkleFilled), true, async () => {
							try {
								if (child.type === 'workflow') {
									await this.editorService.openEditor(new WorkflowEditorInput(child.uri, child.name), { pinned: true });
								} else if (isSubWorkflowTicketType(child.type)) {
									await openSubWorkflowTicketCanvas(this.editorService, child.uri, child.name);
								} else {
									await this.editorService.openEditor(new EntityDetailEditorInput(child.uri, child.name, false), { pinned: true });
								}
							} catch (err) {
								console.error('Failed to open Entity editor:', err);
							}
						}),
						new Action('copy_ticket_json', 'Copy Ticket Content (JSON)', ThemeIcon.asClassName(Codicon.copy), true, async () => {
							const activePane = this.editorService.activeEditorPane;
							const ticketPane = activePane as { _entityUri?: URI; copyTicketAsJson?: () => Promise<void> } | undefined;
							if (ticketPane && ticketPane._entityUri?.toString() === child.uri.toString() && typeof ticketPane.copyTicketAsJson === 'function') {
								await ticketPane.copyTicketAsJson();
							} else {
								await EntityDetailEditor.copyTicketAtUriToClipboard(child.uri, child.name, this.fileService, this.clipboardService, this.notificationService);
							}
						})
					);
				}

				childActions.push(
					new Action('show_in_explorer', 'Show in Explorer', ThemeIcon.asClassName(Codicon.folderLibrary), true, async () => {
						await this.showInExplorer(child.uri);
					})
				);

				childActions.push(
					new Action('reveal_in_os', isMacintosh ? 'Reveal in Finder' : 'Reveal in Explorer', ThemeIcon.asClassName(Codicon.folder), true, async () => {
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

				const isRemovedTicket = (item: IWorkspaceChildItem) => item.type !== 'file' && item.type !== 'folder' && !!item.status && (
					wsLifecycle.getCategory(item.status) === 'Removed' || ['removed', 'canceled', 'cancelled'].includes(item.status.toLowerCase())
				);
				if (isRemoved || isRemovedTicket(child)) {
					const restoreTargets = selectedChildren.length > 1 ? selectedChildren.filter(isRemovedTicket) : [child];
					const restoreLabel = restoreTargets.length > 1 ? `Restore Selected (${restoreTargets.length} Tickets)` : 'Restore Ticket (Reactivate to Active)';
					childActions.push(
						new Action('restore_child_to_ws', restoreLabel, ThemeIcon.asClassName(Codicon.history), true, async () => {
							await this._restoreTickets(restoreTargets.length > 0 ? restoreTargets : [child]);
						})
					);
				} else if (child.type !== 'file' && child.type !== 'folder') {
					childActions.push(
						new Action('remove_child_from_ws', 'Remove from Workspace', ThemeIcon.asClassName(Codicon.sparkleFilled), true, async () => {
							this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
								workspaceId: actualWsName,
								ticketId: realTicketId,
								parentPath: parentRelPath,
								entityUri: child.uri.toString(),
								field: '/Action/RemoveFromWorkspace',
								label: `Remove '${child.name}' (${realTicketId}) from Workspace`,
								prompt: `[Workspace: ${actualWsName} | Ticket: ${realTicketId} | Parent Path: ${parentRelPath} | Action: "Remove Ticket from Active Workspace" | Folder: "${child.name}" | Path: "${child.uri.fsPath}"]\nPlease mark ticket '${realTicketId}' (folder '${child.name}') as Removed and clean up its references.`,
								autoSend: true
							});
						})
					);
				}

				childActions.push(
					new Action('direct_delete_child', selectedChildren.length > 1 ? `Delete Selected (${selectedChildren.length} Items)...` : `Delete '${child.title || realTicketId}'...`, ThemeIcon.asClassName(Codicon.trash), true, async () => {
						await this.deleteSelectedItems(selectedChildren.length > 1 ? selectedChildren : [child]);
					}),
					new Action('trash_child', 'Move to Trash (via AI)...', ThemeIcon.asClassName(Codicon.sparkleFilled), true, async () => {
						this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
							workspaceId: actualWsName,
							ticketId: realTicketId,
							parentPath: parentRelPath,
							entityUri: child.uri.toString(),
							field: '/Action/MoveToTrash',
							label: `Move '${child.name}' (${realTicketId}) to OS Trash`,
							prompt: `[Workspace: ${actualWsName} | Ticket: ${realTicketId} | Parent Path: ${parentRelPath} | Action: "Move Ticket to OS Trash" | Folder: "${child.name}" | Path: "${child.uri.fsPath}"]\nPlease move ticket '${realTicketId}' (folder '${child.name}') to OS Trash, remove it from workspace, and clean up all its links and references.`,
							autoSend: true
						});
					})
				);

				const statusPriorityMenus = await this._createSetStatusPriorityMenus(child, selectedChildren);
				if (statusPriorityMenus.length > 0) {
					childActions.push(new Separator(), ...statusPriorityMenus);
				}
				childActions.push(new Separator(), this._createChildCountMenu());

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
					const expandedNow = this._toggleNodeExpanded(canonicalChildId);
					chevronIcon.className = ThemeIcon.asClassName(expandedNow ? Codicon.chevronDown : Codicon.chevronRight);
					chevronIcon.title = expandedNow ? 'Collapse' : 'Expand';
					this.renderContent();
				};
			} else {
				const spacer = append(childLeft, $('span'));
				spacer.style.display = 'inline-block';
				spacer.style.width = '11px';
				spacer.style.flexShrink = '0';
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
			} else if (child.type === 'folder') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.folder)));
				childIcon.style.opacity = '0.8';
			} else if (child.type === 'file') {
				childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.file)));
				childIcon.style.opacity = '0.7';
			} else {
				const typeLower = (child.type || '').toLowerCase();
				const configuredVisual = getSubWorkflowTicketVisual(typeLower) || customModulesMap.get(typeLower);
				if (configuredVisual) {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(configuredVisual.icon)));
					childIcon.style.color = configuredVisual.color;
					badgeText = child.type.toUpperCase();
					badgeBg = hexToRgba(configuredVisual.color, 0.2);
					badgeFg = configuredVisual.color;
				} else if (typeLower === 'job') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.rocket)));
					childIcon.style.color = '#fbbf24';
					badgeText = 'JOB';
					badgeBg = 'rgba(251, 191, 36, 0.2)';
					badgeFg = '#fbbf24';
				} else if (typeLower === 'project') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.project)));
					childIcon.style.color = '#60a5fa';
					badgeText = 'PROJECT';
					badgeBg = 'rgba(96, 165, 250, 0.2)';
					badgeFg = '#60a5fa';
				} else if (typeLower === 'agent') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.robot)));
					childIcon.style.color = '#38bdf8';
					badgeText = 'AGENT';
					badgeBg = 'rgba(56, 189, 248, 0.2)';
					badgeFg = '#38bdf8';
				} else if (typeLower === 'task') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.checklist)));
					childIcon.style.color = '#a78bfa';
					badgeText = 'TASK';
					badgeBg = 'rgba(167, 139, 250, 0.2)';
					badgeFg = '#a78bfa';
				} else if (typeLower === 'case') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.beaker)));
					childIcon.style.color = '#f472b6';
					badgeText = 'CASE';
					badgeBg = 'rgba(244, 114, 182, 0.2)';
					badgeFg = '#f472b6';
				} else if (typeLower === 'issue') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.bug)));
					childIcon.style.color = '#ef4444';
					badgeText = 'ISSUE';
					badgeBg = 'rgba(239, 68, 68, 0.2)';
					badgeFg = '#ef4444';
				} else if (typeLower === 'analysis') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.graph)));
					childIcon.style.color = '#34d399';
					badgeText = 'ANALYSIS';
					badgeBg = 'rgba(52, 211, 153, 0.2)';
					badgeFg = '#34d399';
				} else if (typeLower === 'workflow') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.githubAction)));
					childIcon.style.color = '#0d9488';
					badgeText = 'WORKFLOW';
					badgeBg = 'rgba(13, 148, 136, 0.2)';
					badgeFg = '#0d9488';
				} else if (typeLower === 'note') {
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(Codicon.book)));
					childIcon.style.color = '#2dd4bf';
					badgeText = 'NOTE';
					badgeBg = 'rgba(45, 212, 191, 0.2)';
					badgeFg = '#2dd4bf';
				} else {
					const customIcon = resolveCustomModuleIcon(undefined, child.type);
					const color = getDefaultCustomModuleColor(child.type);
					childIcon = append(childLeft, $('span' + ThemeIcon.asCSSSelector(customIcon)));
					childIcon.style.color = color;
					badgeText = child.type.toUpperCase();
					badgeBg = hexToRgba(color, 0.2);
					badgeFg = color;
				}
			}

			const childSnapshot = this.workspacesExplorerService.getMetadataSnapshot(child.uri);
			const childTicketId = child.ticketId || childSnapshot?.ticketId || child.code || child.name;
			const childTitle = child.title || childSnapshot?.title || '';
			const isTicketEntity = child.type !== 'folder' && child.type !== 'file';
			const childDisplayText = isTicketEntity
				? (childTitle || childTicketId || child.name)
				: ((childTitle && childTitle !== childTicketId) ? `${childTicketId} ${childTitle}` : (childTicketId || child.name));

			const childTitleSpan = append(childLeft, $('span', {
				style: 'font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;'
			}));
			this._appendHighlightedText(childTitleSpan, childDisplayText, searchMatch ? findMatchRange(childDisplayText, search!.result.query) : undefined, false);
			childTitleSpan.title = isTicketEntity
				? `${childDisplayText} [${childTicketId} · ${badgeText}] (${child.uri.fsPath})`
				: `${childDisplayText} (${child.uri.fsPath})`;

			// UI-17: visible descendant tickets of this ticket, as a muted pill right after the title
			let childCountSig = '';
			if (isTicketEntity && isDirectory) {
				childCountSig = `${this._appendTicketFailureMarker(childLeft, child.uri)}|${this._appendChildCountPill(childLeft, child.uri)}`;
				if (childLeft.lastElementChild !== childTitleSpan) {
					childTitleSpan.style.flex = '0 1 auto';
				}
			}

			// UI-21: a search result whose status category is hidden by the funnel is still shown, with a hint
			let hiddenByFilterHint = false;
			if (search && isTicketEntity && child.status && this._hiddenStatusCategories.has(wsLifecycle.getCategory(child.status))) {
				hiddenByFilterHint = true;
				const hint = append(childLeft, $('span.ticket-search-hidden-hint', { style: 'flex-shrink: 0; font-size: 9.5px; font-style: italic; color: var(--vscode-descriptionForeground);' }, '(hidden by filter)'));
				hint.title = `${describeStatusFilter(this._hiddenStatusCategories)}. Shown because it is on the path to a search result`;
				if (childLeft.lastElementChild !== childTitleSpan) {
					childTitleSpan.style.flex = '0 1 auto';
				}
			}

			// Ticket labels (UI-13): small colored chips after the title; the title keeps priority when space is short
			const childLabels = isTicketEntity ? (child.labels || []) : [];
			if (childLabels.length > 0) {
				childTitleSpan.style.flex = '0 1 auto';
				const labelsEl = append(childLeft, $('span.ticket-label-chips', {
					style: 'display: inline-flex; align-items: center; gap: 3px; flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap;'
				}));
				labelsEl.title = `Labels: ${childLabels.join(', ')}`;
				for (const label of childLabels) {
					const color = getLabelColor(wsLifecycle.labels, label);
					append(labelsEl, $('span', {
						style: `flex-shrink: 1; min-width: 14px; max-width: 72px; overflow: hidden; text-overflow: ellipsis; font-size: 8.5px; line-height: 12px; padding: 0 4px; border-radius: 6px; color: ${color}; background: ${hexToRgba(color, 0.16)}; border: 1px solid ${hexToRgba(color, 0.4)};`
					}, label));
				}
			}

			// Right-Aligned Badges & Actions Group
			const childRight = append(childRow, $('.child-right'));
			childRight.style.display = 'flex';
			childRight.style.alignItems = 'center';
			childRight.style.gap = '4px';
			childRight.style.flexShrink = '0';

			// UI-15: the ticket's status as a compact chip colored by its category
			const statusCategory = isTicketEntity && child.status ? wsLifecycle.getCategory(child.status) : undefined;
			if (statusCategory && child.status) {
				const catColor = STATUS_CATEGORY_COLORS[statusCategory];
				const statusChip = append(childRight, $('span.ticket-status-chip', {
					style: `display: inline-flex; align-items: center; gap: 3px; max-width: 76px; font-size: 8.5px; line-height: 12px; padding: 0 5px 0 4px; border-radius: 6px; color: ${catColor.text}; background: ${catColor.bg}; border: 1px solid ${catColor.border}; white-space: nowrap;`
				}));
				append(statusChip, $('span', { style: `width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; background: ${catColor.text};` }));
				append(statusChip, $('span', { style: 'overflow: hidden; text-overflow: ellipsis;' }, child.status));
				statusChip.title = `Status: ${child.status} (${statusCategory})`;
			}

			if (badgeText) {
				const displayedBadgeText = isTicketEntity ? childTicketId : badgeText;
				const badge = append(childRight, $('span', { style: `font-size: 8px; padding: 1px 5px; border-radius: 3px; background: ${badgeBg}; color: ${badgeFg}; font-weight: 600; text-transform: uppercase;` }));
				this._appendHighlightedText(badge, displayedBadgeText, searchMatch && isTicketEntity ? findMatchRange(displayedBadgeText, search!.result.query) : undefined, true);
				badge.title = isTicketEntity
					? `Ticket ID: ${childTicketId} · Type: ${badgeText}`
					: `Entity Type: ${badgeText}`;
			}

			if (isRemoved && !statusCategory) {
				const removedBadge = append(childRight, $('span', {
					style: 'font-size: 8px; padding: 1px 5px; border-radius: 3px; background: rgba(148, 163, 184, 0.16); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); font-weight: 600; text-transform: uppercase;'
				}, 'REMOVED'));
				removedBadge.title = 'Status: Removed';
			}

			if (isDirectory) {
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

			childRow.setAttribute(
				'data-visual-sig',
				`${isDirectory ? (isExpanded ? 'exp' : 'col') : 'leaf'}|${depth}|${child.type}|${childDisplayText}|${childTicketId}|${badgeText}|${badgeBg}|${badgeFg}|${childIcon.className}|${childIcon.style.color}|${isRemoved ? '1' : '0'}|${isDraggable ? '1' : '0'}|${childLabels.map(l => `${l}:${getLabelColor(wsLifecycle.labels, l)}`).join(',')}|${child.status || ''}:${statusCategory || ''}|${childCountSig}|${searchMatch ? `m:${search!.result.query}` : search ? 'a' : ''}${hiddenByFilterHint ? ':h' : ''}`
			);

			// Single Click / Cmd+Click (multi-select) / Shift+Click (range-select)
			childRow.onclick = async (e: MouseEvent) => {
				this.containerEl?.focus();

				if (e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
					const anchorId = this.lastSelectedAnchorId || this.selectedItemId;
					const anchorIdx = anchorId ? this.renderedOrder.findIndex(r => r.canonicalId === anchorId) : -1;
					const targetIdx = this.renderedOrder.findIndex(r => r.canonicalId === canonicalChildId);

					if (anchorIdx !== -1 && targetIdx !== -1) {
						if (!e.metaKey && !e.ctrlKey) {
							this.selectedItemIds.clear();
						}
						const start = Math.min(anchorIdx, targetIdx);
						const end = Math.max(anchorIdx, targetIdx);
						for (let i = start; i <= end; i++) {
							this.selectedItemIds.add(this.renderedOrder[i].canonicalId);
						}
					} else {
						this.selectedItemIds.add(canonicalChildId);
						this.lastSelectedAnchorId = canonicalChildId;
					}
					this.selectedWorkspaceId = parentWsId;
					this.selectedItemId = canonicalChildId;
					this.updateSelectionVisuals();
					return;
				}

				if (e.metaKey || e.ctrlKey) {
					e.preventDefault();
					e.stopPropagation();
					if (this.selectedItemIds.size === 0 && this.selectedItemId && this.selectedItemId !== canonicalChildId) {
						this.selectedItemIds.add(this.selectedItemId);
					}
					if (this.selectedItemIds.has(canonicalChildId)) {
						this.selectedItemIds.delete(canonicalChildId);
					} else {
						this.selectedItemIds.add(canonicalChildId);
					}
					this.lastSelectedAnchorId = canonicalChildId;
					this.selectedWorkspaceId = parentWsId;
					this.selectedItemId = canonicalChildId;
					this.updateSelectionVisuals();
					return;
				}

				this.selectedWorkspaceId = parentWsId;
				this.selectedItemId = canonicalChildId;
				this.lastSelectedAnchorId = canonicalChildId;
				this.selectedItemIds.clear();
				this.selectedItemIds.add(canonicalChildId);
				this.updateSelectionVisuals();

				if (child.type === 'workflow') {
					await this.editorService.openEditor(new WorkflowEditorInput(child.uri, child.name), { pinned: true });
				} else if (isSubWorkflowTicketType(child.type)) {
					// A Sub-Workflow ticket is an independent workflow: open its own canvas
					await openSubWorkflowTicketCanvas(this.editorService, child.uri, child.name);
				} else if (child.type === 'folder' || child.type === 'workspace' || child.type === 'project' || child.type === 'job') {
					this._toggleNodeExpanded(canonicalChildId);
					this.renderContent();
					// Also check if directory contains a primary md file like .agents folder or legacy files
					const configDir = URI.joinPath(child.uri, '.agents');
					const legacyConfigExists = await this.fileService.exists(URI.joinPath(child.uri, 'instruction.md')) || await this.fileService.exists(URI.joinPath(child.uri, 'README.md'));
					if (await this.fileService.exists(configDir) || legacyConfigExists) {
						await this.editorService.openEditor(new EntityDetailEditorInput(child.uri, child.name), { pinned: true });
					}
				} else if (child.type !== 'file' && child.type !== 'folder') {
					// Ticket entity (custom modules like xxx, task, case, issue, agent, note, etc.)
					await this.editorService.openEditor(new EntityDetailEditorInput(child.uri, child.name), { pinned: true });
				} else if (child.uri.path.toLowerCase().endsWith('.md')) {
					const fileName = child.uri.path.split('/').pop() || '';
					const parentUri = dirname(child.uri);
					const isAgentMd = parentUri.path.endsWith('.agents') || ['instruction.md', 'readme.md', 'work_log.md', 'worklog.md', 'ticket.md', 'tickets.md', 'workspace.md'].includes(fileName.toLowerCase());
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
			};

			// If directory is expanded, recursively render sub-tree container
			if (isExpanded) {
				const subContainer = append(parentContainer, $('.sub-children-container'));
				subContainer.setAttribute('data-sync-key', `sub:${canonicalChildId}`);
				subContainer.setAttribute('data-sync-container', '1');
				subContainer.style.display = 'flex';
				subContainer.style.flexDirection = 'column';
				subContainer.style.gap = '2px';
				await this.renderChildrenTree(subContainer, child.uri, parentWsId, depth + 1, currentVersion, customModulesMap);
			}
		}

		appendHiddenLine();

		if (page.hasMore && !search) {
			const remainingCount = Math.max(1, page.totalCount - page.items.length);
			const nextStep = Math.min(MainWorkspaceViewPane.LOAD_MORE_BATCH_SIZE, remainingCount);
			const loadMoreRow = append(parentContainer, $('.load-more-children-row'));
			loadMoreRow.setAttribute('data-sync-key', `load-more:${parentCanonicalKey}`);
			loadMoreRow.setAttribute('data-visual-sig', `load-more:${page.items.length}:${page.totalCount}:${depth}`);
			loadMoreRow.style.display = 'flex';
			loadMoreRow.style.alignItems = 'center';
			loadMoreRow.style.justifyContent = 'space-between';
			loadMoreRow.style.gap = '6px';
			loadMoreRow.style.padding = `5px 8px 5px ${depth * 12 + 16}px`;
			loadMoreRow.style.marginTop = '2px';
			loadMoreRow.style.borderRadius = '4px';
			loadMoreRow.style.background = 'rgba(56, 189, 248, 0.06)';
			loadMoreRow.style.border = '1px dashed rgba(56, 189, 248, 0.22)';
			loadMoreRow.style.fontSize = '10.5px';
			loadMoreRow.style.color = 'rgba(226, 232, 240, 0.8)';

			const infoSpan = append(loadMoreRow, $('span', {
				style: 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
			}, `Showing ${page.items.length} of ${page.totalCount}`));

			const actionsWrap = append(loadMoreRow, $('div', {
				style: 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;'
			}));

			const loadNextBatch = () => {
				const currentLim = this.nodeVisibleLimitMap.get(parentCanonicalKey) || MainWorkspaceViewPane.INITIAL_CHILDREN_BATCH_SIZE;
				this.nodeVisibleLimitMap.set(parentCanonicalKey, currentLim + MainWorkspaceViewPane.LOAD_MORE_BATCH_SIZE);
				this.renderContent();
			};

			const loadMoreBtn = append(actionsWrap, $('button', {
				style: 'padding: 2px 7px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(56, 189, 248, 0.16); border: 1px solid rgba(56, 189, 248, 0.38); color: #38bdf8; font-weight: 600;'
			}, `Load More (+${nextStep})`));
			loadMoreBtn.title = `Load next ${nextStep} child items`;
			loadMoreBtn.onclick = (e) => {
				e.stopPropagation();
				loadMoreBtn.disabled = true;
				loadMoreBtn.textContent = 'Loading...';
				loadNextBatch();
			};

			if (remainingCount > MainWorkspaceViewPane.LOAD_MORE_BATCH_SIZE) {
				const loadAllBtn = append(actionsWrap, $('button', {
					style: 'padding: 2px 6px; font-size: 10px; border-radius: 3px; cursor: pointer; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.16); color: rgba(226, 232, 240, 0.85); font-weight: 500;'
				}, 'Show All'));
				loadAllBtn.title = `Load all ${page.totalCount} child items`;
				loadAllBtn.onclick = (e) => {
					e.stopPropagation();
					loadAllBtn.disabled = true;
					loadAllBtn.textContent = 'Loading...';
					this.nodeVisibleLimitMap.set(parentCanonicalKey, page.totalCount + 1000);
					this.renderContent();
				};
			}

			void infoSpan;
		}
	}

	/**
	 * Dedicated Modal for Creating a New Workspace
	 */
	private showCreateWorkspaceModal(): void {
		if (!this.containerEl) {
			return;
		}

		this.createWorkspaceModalOverlay?.remove();

		const overlay = append(this.containerEl, $('.create-workspace-modal-overlay'));
		this.createWorkspaceModalOverlay = overlay;
		// UI-29: buttons, inputs and text boxes use the workbench font (form controls do not inherit it by default)
		ensureCreateWorkspaceDialogFontRule();
		overlay.style.fontFamily = 'var(--vscode-font-family)';
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
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); color: #38bdf8; box-sizing: border-box; font-family: inherit; font-weight: 600;'
		})) as HTMLInputElement;
		wsIdInput.readOnly = true;
		wsIdInput.placeholder = 'e.g., ABCD-0000';

		const updateWsId = () => {
			const rawCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
			wsIdInput.value = rawCode ? `${rawCode}-0000` : '';
		};

		nameInput.oninput = () => {
			const cleanName = nameInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
			if (cleanName.length >= 3 && !codeInput.dataset.userEdited) {
				codeInput.value = cleanName.slice(0, 5);
			}
			updateWsId();
		};

		codeInput.oninput = () => {
			codeInput.dataset.userEdited = 'true';
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
					if (cleanName.length >= 3 && !codeInput.dataset.userEdited) {
						codeInput.value = cleanName.slice(0, 5);
					}
					updateWsId();
				}
			}
		};

		// Description Input (Full width, multi-line textarea)
		const descBox = append(modalBody, $('.form-group'));
		append(descBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Description:'));
		const descInput = append(descBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
		})) as HTMLTextAreaElement;
		descInput.placeholder = 'Brief purpose or detailed description of this workspace...';

		// Ticket Statuses Lifecycle Matrix (5 Canonical Categories)
		const statusCard = append(modalBody, $('.form-group', {
			style: 'background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px;'
		}));

		let isMatrixExpanded = false;

		const statusHeader = append(statusCard, $('div', {
			style: 'display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; padding: 2px 0;'
		}));

		const headerLeft = append(statusHeader, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
		append(headerLeft, $('label', { style: 'font-size: 11.5px; opacity: 0.85; font-weight: 500; cursor: pointer; color: inherit;' }, 'Ticket Statuses Lifecycle (5 Categories):'));
		const summarySpan = append(headerLeft, $('span', { style: 'font-size: 10px; opacity: 0.45;' }, '(Todo, In Progress, Done, Blocked, Removed)'));

		const toggleBtn = append(statusHeader, $('span', {
			style: 'font-size: 10px; opacity: 0.65; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.1); cursor: pointer;'
		}, 'Customize'));

		const statusBody = append(statusCard, $('div', {
			style: 'display: none; flex-direction: column; gap: 8px; margin-top: 2px;'
		}));

		const toggleAccordion = () => {
			isMatrixExpanded = !isMatrixExpanded;
			if (isMatrixExpanded) {
				statusBody.style.display = 'flex';
				toggleBtn.innerText = 'Collapse';
				toggleBtn.style.opacity = '0.9';
			} else {
				statusBody.style.display = 'none';
				toggleBtn.innerText = 'Customize';
				toggleBtn.style.opacity = '0.65';
			}
		};

		statusHeader.onclick = () => {
			toggleAccordion();
		};

		const statusMatrix = renderStatusLifecycleMatrix(statusBody, createDefaultCategoryMap(), {
			onChange: () => {
				summarySpan.innerText = `(${summarizeCategoryMap(statusMatrix.getCategoryMap())})`;
			}
		});

		const getCustomStatusesConfig = () => {
			const config = statusMatrix.getConfig();
			return { customStatuses: config.statuses, statusMapping: config.mapping, initialStatus: config.initialStatus, removedStatus: config.removedStatus };
		};

		// Ticket Labels (UI-13): the labels tickets of this workspace can carry
		const labelsCard = append(modalBody, $('.form-group', {
			style: 'background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px;'
		}));
		append(labelsCard, $('label', { style: 'font-size: 11.5px; opacity: 0.85; font-weight: 500; color: inherit;' }, 'Ticket Labels (optional):'));
		const labelsEditor = renderLabelDefinitionsEditor(labelsCard, []);

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
		const priorityDots: HTMLElement[] = [];
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
					const dotEl = priorityDots[i];
					btnEl.style.border = isSel ? `1px solid ${priorities[i].color}` : '1px solid rgba(255,255,255,0.08)';
					btnEl.style.backgroundColor = isSel ? `${priorities[i].color}25` : 'rgba(255,255,255,0.03)';
					btnEl.style.color = isSel ? priorities[i].color : 'inherit';
					if (dotEl) {
						dotEl.style.boxShadow = isSel ? `0 0 6px ${priorities[i].color}` : 'none';
					}
				}
			};

			priorityButtons.push(pBtn);
			priorityDots.push(dot);
		}

		// Current AI Agent Dropdown (Full width)
		const agentBox = append(modalBody, $('.form-group'));
		append(agentBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Current AI Agent:'));
		const agentSelect = append(agentBox, $('select.monaco-select-box', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; cursor: pointer;'
		})) as HTMLSelectElement;
		append(agentSelect, $('option', { value: '' }, 'None (Unassigned)'));

		let availableAgents: IAgentItem[] = [];
		if (this.agentsManagerService) {
			this.agentsManagerService.getAgents().then(agents => {
				availableAgents = agents || [];
				for (const ag of availableAgents) {
					append(agentSelect, $('option', { value: ag.id }, `${ag.name} (${ag.role || 'Agent'})`));
				}
			}).catch(() => { });
		}

		// Link To Multi-Select Section
		const linkBox = append(modalBody, $('.form-group', { style: 'position: relative;' }));
		append(linkBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Link To:'));

		const selectedWsLinkTickets: string[] = [];
		const wsLinkChipsContainer = append(linkBox, $('.link-chips-container', {
			style: 'display: none; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;'
		}));

		const wsLinkInputWrapper = append(linkBox, $('.link-input-wrapper', {
			style: 'position: relative; display: flex; align-items: center;'
		}));

		const wsLinkSearchInput = append(wsLinkInputWrapper, $('input.monaco-inputbox', {
			placeholder: 'Select or search tickets to link...',
			style: 'width: 100%; padding: 7px 28px 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLInputElement;

		const wsLinkDropdownArrow = append(wsLinkInputWrapper, $('div', {
			style: 'position: absolute; right: 10px; font-size: 9px; opacity: 0.6; pointer-events: none; user-select: none;'
		}));
		wsLinkDropdownArrow.textContent = '▼';

		const wsLinkDropdownMenu = append(linkBox, $('.link-dropdown-menu', {
			style: 'position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15)); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 100005; display: none; margin-top: 4px; box-sizing: border-box; padding: 4px 0;'
		}));

		let wsAvailableTickets: Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }> = [];

		const renderWsLinkChips = () => {
			clearNode(wsLinkChipsContainer);
			if (selectedWsLinkTickets.length === 0) {
				wsLinkChipsContainer.style.display = 'none';
				return;
			}
			wsLinkChipsContainer.style.display = 'flex';
			for (let i = 0; i < selectedWsLinkTickets.length; i++) {
				const ticketId = selectedWsLinkTickets[i];
				const ticketObj = wsAvailableTickets.find(t => t.id === ticketId || t.code === ticketId);
				const badgeInfo = getTicketTypeBadge(ticketObj?.type || 'task');
				const chip = append(wsLinkChipsContainer, $('.link-chip', {
					style: `display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 3px 8px; border-radius: 5px; font-size: 11px;`
				}));

				if (ticketObj) {
					const typeBadge = append(chip, $('span', {
						style: `font-size: 8.5px; font-weight: 700; color: ${badgeInfo.color}; background: ${badgeInfo.bg}; padding: 1px 4px; border-radius: 3px; text-transform: uppercase;`
					}));
					typeBadge.textContent = ticketObj.type;
				}

				const titleSpan = append(chip, $('span', { style: 'font-weight: 500;' }));
				titleSpan.textContent = ticketObj ? `${ticketObj.id} (${ticketObj.title})` : ticketId;

				const removeBtn = append(chip, $('span', {
					style: 'cursor: pointer; opacity: 0.6; margin-left: 2px; font-size: 11px;'
				}));
				removeBtn.textContent = '\u2715';
				removeBtn.onmouseenter = () => { removeBtn.style.opacity = '1.0'; };
				removeBtn.onmouseleave = () => { removeBtn.style.opacity = '0.6'; };
				removeBtn.onclick = (e) => {
					e.stopPropagation();
					selectedWsLinkTickets.splice(i, 1);
					renderWsLinkChips();
					renderWsLinkDropdown();
				};
			}
		};

		const renderWsLinkDropdown = () => {
			clearNode(wsLinkDropdownMenu);
			const query = wsLinkSearchInput.value.toLowerCase().trim();

			const filtered = wsAvailableTickets.filter(t => {
				if (!query) { return true; }
				const haystack = `${t.id} ${t.code} ${t.title} ${t.summary} ${t.type} ${t.workspaceName}`.toLowerCase();
				return haystack.includes(query);
			});

			if (filtered.length === 0) {
				const emptyItem = append(wsLinkDropdownMenu, $('.dropdown-empty', {
					style: 'padding: 10px 14px; font-size: 11.5px; opacity: 0.6; font-style: italic;'
				}));
				emptyItem.textContent = query ? `No tickets matching "${query}". Press Enter to link as custom ID.` : 'No available tickets found in workspace.';
			} else {
				filtered.forEach(ticket => {
					const isChecked = selectedWsLinkTickets.includes(ticket.id) || selectedWsLinkTickets.includes(ticket.code);
					const badgeInfo = getTicketTypeBadge(ticket.type);

					const item = append(wsLinkDropdownMenu, $('.ticket-dropdown-item', {
						style: `display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; cursor: pointer; transition: background 0.1s ease; border-bottom: 1px solid rgba(255,255,255,0.03); background: ${isChecked ? 'rgba(56, 189, 248, 0.08)' : 'transparent'};`
					}));

					item.onmouseenter = () => {
						item.style.background = isChecked ? 'rgba(56, 189, 248, 0.15)' : 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))';
					};
					item.onmouseleave = () => {
						item.style.background = isChecked ? 'rgba(56, 189, 248, 0.08)' : 'transparent';
					};

					const leftInfo = append(item, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;' }));

					const checkbox = append(leftInfo, $('input', {
						type: 'checkbox',
						style: 'cursor: pointer; accent-color: #38bdf8;'
					})) as HTMLInputElement;
					checkbox.checked = isChecked;

					const typeBadge = append(leftInfo, $('span', {
						style: `font-size: 8.5px; font-weight: 700; color: ${badgeInfo.color}; background: ${badgeInfo.bg}; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0;`
					}));
					typeBadge.textContent = ticket.type;

					const textCol = append(leftInfo, $('div', { style: 'display: flex; flex-direction: column; min-width: 0;' }));
					const idTitleRow = append(textCol, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					append(idTitleRow, $('span', { style: 'font-weight: 600; font-size: 11.5px; color: #38bdf8;' }, ticket.id));
					if (ticket.title) {
						append(idTitleRow, $('span', { style: 'font-size: 11.5px; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' }, ` - ${ticket.title}`));
					}

					append(item, $('span', {
						style: 'font-size: 10px; opacity: 0.5; margin-left: 8px; flex-shrink: 0;'
					}, ticket.workspaceName));

					const toggleItem = (e: Event) => {
						e.stopPropagation();
						const idx = selectedWsLinkTickets.indexOf(ticket.id);
						if (idx !== -1) {
							selectedWsLinkTickets.splice(idx, 1);
						} else {
							selectedWsLinkTickets.push(ticket.id);
						}
						renderWsLinkChips();
						renderWsLinkDropdown();
					};

					item.onclick = toggleItem;
				});
			}
		};

		this._loadAllAvailableTickets().then(tickets => {
			wsAvailableTickets = tickets;
			renderWsLinkChips();
			renderWsLinkDropdown();
		});

		wsLinkSearchInput.onclick = (e) => {
			e.stopPropagation();
			wsLinkDropdownMenu.style.display = 'block';
			renderWsLinkDropdown();
		};

		wsLinkSearchInput.oninput = () => {
			wsLinkDropdownMenu.style.display = 'block';
			renderWsLinkDropdown();
		};

		wsLinkSearchInput.onkeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = wsLinkSearchInput.value.trim();
				if (val && !selectedWsLinkTickets.includes(val)) {
					selectedWsLinkTickets.push(val);
					wsLinkSearchInput.value = '';
					renderWsLinkChips();
					renderWsLinkDropdown();
				}
			} else if (e.key === 'Escape') {
				wsLinkDropdownMenu.style.display = 'none';
			}
		};

		const wsLinkClickListener = (e: MouseEvent) => {
			if (e.target !== wsLinkSearchInput && !wsLinkDropdownMenu.contains(e.target as Node)) {
				wsLinkDropdownMenu.style.display = 'none';
			}
		};
		mainWindow.document.addEventListener('click', wsLinkClickListener);

		// Attachments Section (Full width)
		const attachBox = append(modalBody, $('.form-group'));
		append(attachBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Attachments:'));
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
					append(tag, $('span', {}, fileName));
					const delBtn = append(tag, $('span', { style: 'cursor: pointer; opacity: 0.6; margin-left: 4px;' }, '\u2715'));
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

		// Git Configuration Section (Collapsible, Default Collapsed)
		const gitBox = append(modalBody, $('.form-group', { style: 'background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;' }));

		const gitHeaderRow = append(gitBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;' }));
		const gitTitle = append(gitHeaderRow, $('div', { style: 'font-size: 11.5px; opacity: 0.9; font-weight: 600; display: flex; align-items: center; gap: 6px;' }));
		const gitChevron = append(gitTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		gitChevron.style.fontSize = '12px';
		gitChevron.style.transition = 'transform 0.15s ease';
		append(gitTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.sourceControl)));
		append(gitTitle, $('span', {}, 'Git Repository & Branch Binding (Optional)'));

		const gitToggleHint = append(gitHeaderRow, $('span', { style: 'font-size: 10.5px; opacity: 0.6; color: #38bdf8;' }, 'Configure Git...'));

		const gitContent = append(gitBox, $('div', { style: 'display: none; flex-direction: column; gap: 10px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px;' }));

		let isGitExpanded = false;
		gitHeaderRow.onclick = () => {
			isGitExpanded = !isGitExpanded;
			gitContent.style.display = isGitExpanded ? 'flex' : 'none';
			gitChevron.className = ThemeIcon.asClassName(isGitExpanded ? Codicon.chevronDown : Codicon.chevronRight);
			gitToggleHint.textContent = isGitExpanded ? 'Collapse' : 'Configure Git...';
		};

		// Git Remote URL Input
		const gitRemoteRow = append(gitContent, $('div'));
		append(gitRemoteRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Git Remote URL (e.g. GitHub / GitLab repository URL):'));
		const gitRemoteInput = append(gitRemoteRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitRemoteInput.placeholder = 'e.g. git@github.com:org/repo.git or https://github.com/org/repo.git';

		// Target Branch Input
		const gitBranchRow = append(gitContent, $('div'));
		append(gitBranchRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Target Branch:'));
		const gitBranchInput = append(gitBranchRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitBranchInput.placeholder = 'e.g. main, master, feature/workspace-setup (leave blank for default)';

		// Test & Diagnostic Row
		const gitActionRow = append(gitContent, $('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 2px;' }));
		const testGitBtn = append(gitActionRow, $('button', {
			style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(56, 189, 248, 0.15) !important; color: #38bdf8 !important; border: 1px solid rgba(56, 189, 248, 0.35) !important; outline: none; transition: all 0.15s ease;'
		})) as HTMLButtonElement;
		testGitBtn.onmouseenter = () => { testGitBtn.style.background = 'rgba(56, 189, 248, 0.25) !important'; };
		testGitBtn.onmouseleave = () => { testGitBtn.style.background = 'rgba(56, 189, 248, 0.15) !important'; };
		append(testGitBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plug)));
		append(testGitBtn, $('span', {}, 'Test & Verify Git'));

		const gitStatusBadge = append(gitActionRow, $('div', {
			style: 'font-size: 11px; padding: 4px 8px; border-radius: 4px; display: none; align-items: center; gap: 6px; flex: 1; word-break: break-word;'
		}));

		const copyDiagnosticBtn = append(gitActionRow, $('button.btn-secondary', {
			style: 'display: none; align-items: center; gap: 4px; padding: 3px 8px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.15);'
		}));
		append(copyDiagnosticBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		append(copyDiagnosticBtn, $('span', {}, 'Copy Diagnostics'));

		let lastGitDiagnosticText = '';

		testGitBtn.onclick = async () => {
			testGitBtn.disabled = true;
			testGitBtn.style.opacity = '0.6';
			gitStatusBadge.style.display = 'flex';
			gitStatusBadge.style.backgroundColor = 'rgba(56, 189, 248, 0.12)';
			gitStatusBadge.style.color = '#38bdf8';
			gitStatusBadge.style.border = '1px solid rgba(56, 189, 248, 0.3)';
			gitStatusBadge.textContent = 'Verifying Git repository & branch...';
			copyDiagnosticBtn.style.display = 'none';

			try {
				const remoteUrl = gitRemoteInput.value.trim();
				const targetBranch = gitBranchInput.value.trim();

				let curr = selectedPathUri || (pathInput.value.trim() ? URI.file(pathInput.value.trim()) : undefined);
				let foundGitUri: URI | undefined = undefined;
				if (curr) {
					while (curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
						const checkGit = URI.joinPath(curr, '.git');
						if (await this.fileService.exists(checkGit)) {
							foundGitUri = checkGit;
							break;
						}
						const parent = dirname(curr);
						if (parent.path === curr.path) { break; }
						curr = parent;
					}
				}

				let branchName = 'main';
				const hasLocalGit = !!foundGitUri;
				let gitConfigRemote = '';

				if (foundGitUri) {
					try {
						const headUri = URI.joinPath(foundGitUri, 'HEAD');
						if (await this.fileService.exists(headUri)) {
							const headContent = (await this.fileService.readFile(headUri)).value.toString().trim();
							if (headContent.startsWith('ref: refs/heads/')) {
								branchName = headContent.replace('ref: refs/heads/', '').trim();
							}
						}
					} catch { }

					try {
						const configUri = URI.joinPath(foundGitUri, 'config');
						if (await this.fileService.exists(configUri)) {
							const configContent = (await this.fileService.readFile(configUri)).value.toString();
							const match = configContent.match(/url\s*=\s*(.+)/);
							if (match && match[1]) {
								gitConfigRemote = match[1].trim();
							}
						}
					} catch { }
				}

				const desiredBranch = targetBranch || branchName;
				const isBranchAligned = !targetBranch || targetBranch === branchName;

				if (hasLocalGit) {
					if (isBranchAligned) {
						gitStatusBadge.style.backgroundColor = 'rgba(52, 211, 153, 0.15)';
						gitStatusBadge.style.color = '#34d399';
						gitStatusBadge.style.border = '1px solid rgba(52, 211, 153, 0.35)';
						gitStatusBadge.textContent = `✔️ Connected: Local Git valid (Active Branch: '${branchName}'${gitConfigRemote ? ` | Remote: ${gitConfigRemote}` : ''})`;
						lastGitDiagnosticText = `Git Verification Success:\n- Path: ${curr?.fsPath || 'Local'}\n- Active Branch: ${branchName}\n- Remote URL: ${remoteUrl || gitConfigRemote || 'None'}\n- Status: OK / Aligned`;
					} else {
						gitStatusBadge.style.backgroundColor = 'rgba(251, 146, 60, 0.15)';
						gitStatusBadge.style.color = '#fb923c';
						gitStatusBadge.style.border = '1px solid rgba(251, 146, 60, 0.35)';
						gitStatusBadge.textContent = `⚠️ Warning: Local branch is '${branchName}', but target is '${targetBranch}'.`;
						lastGitDiagnosticText = `Git Branch Alert:\n- Local Active Branch: ${branchName}\n- Desired Target Branch: ${targetBranch}\n- Status: Target branch differs from current active branch.`;
						copyDiagnosticBtn.style.display = 'inline-flex';
					}
				} else if (remoteUrl) {
					gitStatusBadge.style.backgroundColor = 'rgba(56, 189, 248, 0.15)';
					gitStatusBadge.style.color = '#38bdf8';
					gitStatusBadge.style.border = '1px solid rgba(56, 189, 248, 0.35)';
					gitStatusBadge.textContent = `✔️ Remote Git URL specified: ${remoteUrl} (Target Branch: '${desiredBranch}')`;
					lastGitDiagnosticText = `Remote Git Configured:\n- Remote URL: ${remoteUrl}\n- Target Branch: ${desiredBranch}\n- Status: Ready to track/clone`;
				} else {
					gitStatusBadge.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
					gitStatusBadge.style.color = 'var(--vscode-foreground)';
					gitStatusBadge.style.border = '1px solid rgba(255, 255, 255, 0.15)';
					gitStatusBadge.textContent = `\u2139\ufe0f No local .git repository found at target path. Workspace will be initialized as standard directory.`;
					lastGitDiagnosticText = `No Git Repository:\n- Path: ${curr?.fsPath || 'Not selected'}\n- Note: Leave blank if Git tracking is not required for this workspace.`;
					copyDiagnosticBtn.style.display = 'inline-flex';
				}
			} catch (err) {
				gitStatusBadge.style.backgroundColor = 'rgba(248, 113, 113, 0.15)';
				gitStatusBadge.style.color = '#f87171';
				gitStatusBadge.style.border = '1px solid rgba(248, 113, 113, 0.35)';
				gitStatusBadge.textContent = `\u274C Git Check Error: ${(err as Error | undefined)?.message || err}`;
				lastGitDiagnosticText = `Git Check Error:\n- Error Details: ${(err as Error | undefined)?.stack || (err as Error | undefined)?.message || err}`;
				copyDiagnosticBtn.style.display = 'inline-flex';
			} finally {
				testGitBtn.disabled = false;
				testGitBtn.style.opacity = '1';
			}
		};

		copyDiagnosticBtn.onclick = () => {
			if (lastGitDiagnosticText) {
				this.clipboardService.writeText(lastGitDiagnosticText);
				this.notificationService.info('Copied Git diagnostic information to clipboard.');
			}
		};

		// Ticket Type Prompt (Pre-populated)
		const typePromptBox = append(modalBody, $('.form-group'));
		append(typePromptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Ticket Type Prompt (Global Workspace Rules):'));
		const typePromptInput = append(typePromptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
		})) as HTMLTextAreaElement;
		typePromptInput.value = 'A workspace is the root environment container. Manage sub-entities, repository structure, and lifecycle.';

		// Ticket Prompt (Instance specific prompt)
		const ticketPromptBox = append(modalBody, $('.form-group'));
		append(ticketPromptBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Ticket Prompt (Specific Instruction / Rule):'));
		const ticketPromptInput = append(ticketPromptBox, $('textarea.monaco-inputbox', {
			style: 'width: 100%; height: 56px; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; font-family: inherit;'
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

			const gitRepoUrl = gitRemoteInput.value.trim();
			const originalBtnHtml = submitBtn.innerHTML;
			const btn = submitBtn as HTMLButtonElement;
			if (gitRepoUrl) {
				btn.disabled = true;
				btn.style.opacity = '0.7';
				btn.textContent = 'Cloning Git Repository & Initializing...';
			}

			try {
				const wsCode = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
				const assignedAgentId = agentSelect.value || undefined;
				const matchingAgent = availableAgents.find(a => a.id === assignedAgentId);

				const statusConfig = getCustomStatusesConfig();

				const res = await this.workspacesExplorerService.createWorkspace({
					name,
					title: titleInput.value.trim() || name,
					workspaceId: wsIdInput.value.trim() || (wsCode ? `${wsCode}-0000` : undefined),
					targetParentUri: parentUri,
					description: descInput.value.trim(),
					code: wsCode,
					type: 'workspace',
					status: statusConfig.initialStatus,
					customStatuses: statusConfig.customStatuses,
					statusMapping: statusConfig.statusMapping,
					removedStatus: statusConfig.removedStatus,
					labelDefinitions: labelsEditor.getLabels(),
					priority: selectedPriority,
					assignedAgentId: assignedAgentId,
					assignedAgentName: matchingAgent ? matchingAgent.name : undefined,
					linkTo: selectedWsLinkTickets.length > 0 ? selectedWsLinkTickets.join(', ') : undefined,
					attachments: selectedAttachments.length > 0 ? selectedAttachments : undefined,
					typePrompt: typePromptInput.value.trim() || undefined,
					ticketPrompt: ticketPromptInput.value.trim() || undefined,
					gitRepoUrl: gitRepoUrl || undefined,
					gitBranch: gitBranchInput.value.trim() || undefined
				});

				mainWindow.document.removeEventListener('click', wsLinkClickListener);
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
				btn.disabled = false;
				btn.style.opacity = '1';
				btn.innerHTML = originalBtnHtml;
				this.notificationService.error(`Failed to create workspace: ${(err as Error | undefined)?.message || err}`);
			}
		};
	}

	/**
	 * Renders a spacious Create Resource Modal Overlay under the target Workspace or Folder
	 */
	public showCreateResourceModal(target?: IWorkspaceItem | URI, parentName?: string, onSuccess?: (type: string, name: string) => void, initialType?: string): void {
		// No target location: use the current workspace (tickets always live inside a workspace); without one, refuse (CI-26)
		if (!target) {
			this.workspacesExplorerService.getWorkspaces().then(workspaces => {
				const current = workspaces.find(w => w.isCurrent) || workspaces[0];
				if (!current) {
					this.notificationService.warn('There is no workspace to create this in. Create or open a workspace first (choose its folder with the folder picker), then create the item inside it.');
					return;
				}
				this.showCreateResourceModal(current, parentName, onSuccess, initialType);
			}, err => this.notificationService.error(`Failed to load workspaces: ${(err as Error | undefined)?.message || err}`));
			return;
		}

		let targetUri: URI;
		let targetName: string;

		if (typeof target === 'object' && isWorkspaceItemTarget(target)) {
			targetUri = (target as IWorkspaceItem).uri;
			targetName = (target as IWorkspaceItem).name;
		} else {
			targetUri = target as URI;
			targetName = parentName || targetUri.path.split('/').filter(Boolean).pop() || 'Workspace';
		}

		MainWorkspaceViewPane.createResourceModalOverlay?.remove();

		const overlay = append(mainWindow.document.body, $('.create-resource-modal-overlay'));
		MainWorkspaceViewPane.createResourceModalOverlay = overlay;
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
		overlay.style.zIndex = '100000';
		overlay.style.padding = '20px';

		// Set once the document click listener (closing the dropdowns) is registered below
		const docClickListener: { current?: (e: MouseEvent) => void } = {};
		const removeOverlay = () => {
			if (docClickListener.current) {
				mainWindow.document.removeEventListener('click', docClickListener.current);
			}
			overlay.remove();
		};

		const modal = append(overlay, $('.create-resource-modal'));
		modal.style.width = '640px';
		modal.style.maxWidth = '92vw';
		modal.style.maxHeight = '88vh';
		modal.style.backgroundColor = 'var(--vscode-editorWidget-background, #1e1e1e)';
		modal.style.color = 'var(--vscode-foreground, #cccccc)';
		modal.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif)';
		modal.style.fontSize = '12px';
		modal.style.border = '1px solid rgba(255, 255, 255, 0.18)';
		modal.style.borderRadius = '12px';
		modal.style.padding = '24px 28px';
		modal.style.boxShadow = '0 16px 40px rgba(0,0,0,0.7)';
		modal.style.display = 'flex';
		modal.style.flexDirection = 'column';
		modal.style.gap = '16px';
		modal.style.boxSizing = 'border-box';
		modal.style.transition = 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)';

		const isRootWorkspace = (target && typeof target === 'object' && isWorkspaceItemTarget(target)) || !parentName;
		const modalHeadingText = isRootWorkspace ? `Create Entity in ${targetName}` : `Create Sub-Entity in ${targetName}`;

		// Modal Header
		const modalHeader = append(modal, $('.modal-header'));
		modalHeader.style.display = 'flex';
		modalHeader.style.alignItems = 'center';
		modalHeader.style.justifyContent = 'space-between';

		const modalTitle = append(modalHeader, $('div', { style: 'font-weight: 600; font-size: 14px; color: #38bdf8; display: flex; align-items: center; gap: 8px;' }));
		append(modalTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.folderActive)));
		const modalTitleText = append(modalTitle, $('span', {}, modalHeadingText));

		const headerRight = append(modalHeader, $('div', { style: 'display: flex; align-items: center; gap: 12px;' }));

		const computeDualPaneLayout = () => {
			const vw = mainWindow.innerWidth;
			const vh = mainWindow.innerHeight;
			const gap = 12;
			const maxPairWidth = Math.min(1340, vw - 32);
			const leftW = Math.floor((maxPairWidth - gap) * 0.52);
			const rightW = Math.floor((maxPairWidth - gap) * 0.48);
			const startX = Math.max(12, Math.floor((vw - (leftW + gap + rightW)) / 2));
			const targetH = Math.min(800, Math.floor(vh * 0.88));
			const topY = Math.floor((vh - targetH) / 2);

			return {
				left: { x: startX, y: topY, w: leftW, h: targetH },
				right: { x: startX + leftW + gap, y: topY, w: rightW, h: targetH }
			};
		};

		let isCompanionActive = false;
		const aiCompanionBtn = append(headerRight, $('button.btn-secondary', {
			style: 'display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; border-radius: 5px; cursor: pointer; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); transition: all 0.2s ease;'
		}));
		append(aiCompanionBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkleFilled)));
		append(aiCompanionBtn, $('span', {}, 'AI Co-Pilot'));
		aiCompanionBtn.title = 'Open Agent Central side-by-side to assist in entity planning';
		aiCompanionBtn.onclick = () => {
			isCompanionActive = !isCompanionActive;
			if (isCompanionActive) {
				const layout = computeDualPaneLayout();

				overlay.style.alignItems = 'flex-start';
				overlay.style.justifyContent = 'flex-start';
				modal.style.position = 'fixed';
				modal.style.left = `${layout.left.x}px`;
				modal.style.top = `${layout.left.y}px`;
				modal.style.width = `${layout.left.w}px`;
				modal.style.height = `${layout.left.h}px`;
				modal.style.maxHeight = `${layout.left.h}px`;
				modal.style.transform = 'none';

				aiCompanionBtn.style.background = 'rgba(56, 189, 248, 0.25)';
				aiCompanionBtn.style.borderColor = 'rgba(56, 189, 248, 0.6)';

				this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
					workspaceId: targetName,
					field: '/Create',
					label: `Create in ${targetName}`,
					companionMode: true,
					companionPosition: {
						left: layout.right.x,
						top: `${layout.right.y}px`,
						width: layout.right.w,
						height: layout.right.h
					},
					prompt: `Help me plan and create a new entity under '${targetName}'. I want to `
				});
			} else {
				overlay.style.alignItems = 'center';
				overlay.style.justifyContent = 'center';
				modal.style.position = 'relative';
				modal.style.left = '';
				modal.style.top = '';
				modal.style.width = '640px';
				modal.style.height = '';
				modal.style.maxHeight = '88vh';
				modal.style.transform = 'none';

				aiCompanionBtn.style.background = 'rgba(56, 189, 248, 0.12)';
				aiCompanionBtn.style.borderColor = 'rgba(56, 189, 248, 0.35)';

				this.commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup');
			}
		};

		const closeIcon = append(headerRight, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
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

		// Target Location / Workspace Selector Row
		const locationBox = append(modalBody, $('.form-group'));
		append(locationBox, $('label', { style: 'display: block; margin-bottom: 6px; font-size: 11.5px; opacity: 0.85; font-weight: 500;' }, 'Target Location / Workspace:'));
		const locationSelect = append(locationBox, $('select.monaco-select', {
			style: 'width: 100%; padding: 7px 12px; font-size: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer; outline: none;'
		})) as HTMLSelectElement;

		// Category / Type Selection Row
		const categoryBox = append(modalBody, $('.form-group'));
		const labelRow = append(categoryBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;' }));
		append(labelRow, $('label', { style: 'font-size: 11.5px; opacity: 0.85; font-weight: 500;' }, 'Select Sub-Entity Type:'));

		const manageBtn = append(labelRow, $('span', {
			style: 'font-size: 11px; color: #38bdf8; cursor: pointer; display: flex; align-items: center; gap: 4px; opacity: 0.85; transition: opacity 0.15s ease;'
		}));
		manageBtn.textContent = 'Manage Custom Modules';
		manageBtn.onmouseenter = () => manageBtn.style.opacity = '1.0';
		manageBtn.onmouseleave = () => manageBtn.style.opacity = '0.85';

		let selectedType: string = initialType || 'job';
		const categoryGrid = append(categoryBox, $('.category-grid'));

		const initLocationSelector = async () => {
			clearNode(locationSelect);
			const managedWorkspaces = await this.workspacesExplorerService.getWorkspaces();
			const wsList = [...managedWorkspaces];

			// If no target was passed, default to the first managed workspace if available
			if (!target && wsList.length > 0) {
				targetUri = wsList[0].uri;
				targetName = wsList[0].name;
				modalTitleText.textContent = `Create Entity in ${targetName}`;
			}

			let matchedTarget = false;
			for (const ws of wsList) {
				const opt = append(locationSelect, $('option', { value: ws.uri.toString(), 'data-name': ws.name }, `\uD83D\uDCC1 ${ws.name} (${ws.uri.fsPath})`)) as HTMLOptionElement;
				if (ws.uri.toString() === targetUri.toString() || ws.uri.fsPath === targetUri.fsPath) {
					opt.selected = true;
					matchedTarget = true;
				}
			}

			if (!matchedTarget && targetUri) {
				const subOpt = $('option', { value: targetUri.toString(), 'data-name': targetName }, `\uD83D\uDCC2 ${targetName} (${targetUri.fsPath})`) as HTMLOptionElement;
				subOpt.selected = true;
				locationSelect.insertBefore(subOpt, locationSelect.firstChild);
			}

			locationSelect.onchange = async () => {
				const val = locationSelect.value;
				const selOpt = locationSelect.options[locationSelect.selectedIndex];
				if (val) {
					targetUri = URI.parse(val);
					targetName = selOpt?.getAttribute('data-name') || targetUri.path.split('/').filter(Boolean).pop() || 'Workspace';
					modalTitleText.textContent = `Create Entity in ${targetName}`;
					await renderTypeGrid();
					await refreshNameAndBadge();
				}
			};
		};

		const typeButtons: HTMLElement[] = [];
		let typesList: { type: string; label: string; icon: ThemeIcon; color: string; bg: string }[] = [];

		// Instant full-name tooltip for the type buttons. Lives inside the overlay because the
		// workbench hover widget renders below this modal's z-index.
		const typeTooltip = append(overlay, $('.type-option-tooltip'));
		typeTooltip.style.cssText = 'position: fixed; display: none; z-index: 100001; pointer-events: none; max-width: 320px; padding: 4px 8px; border-radius: 4px; font-size: 12px; line-height: 1.4; white-space: normal; word-break: break-word; color: var(--vscode-editorHoverWidget-foreground, #ddd); background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); box-shadow: 0 2px 8px rgba(0,0,0,0.36);';
		const hideTypeTooltip = () => { typeTooltip.style.display = 'none'; };
		const showTypeTooltip = (anchor: HTMLElement, text: string) => {
			typeTooltip.textContent = text;
			typeTooltip.style.display = 'block';
			const r = anchor.getBoundingClientRect();
			const tip = typeTooltip.getBoundingClientRect();
			const viewW = mainWindow.innerWidth;
			const left = Math.max(4, Math.min(r.left + (r.width - tip.width) / 2, viewW - tip.width - 4));
			const below = r.bottom + 6;
			const top = below + tip.height > mainWindow.innerHeight - 4 ? r.top - tip.height - 6 : below;
			typeTooltip.style.left = `${left}px`;
			typeTooltip.style.top = `${top}px`;
		};

		const renderTypeGrid = async () => {
			hideTypeTooltip();
			clearNode(categoryGrid);
			categoryGrid.style.display = 'grid';
			categoryGrid.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
			categoryGrid.style.gap = '8px';
			categoryGrid.style.width = '100%';
			categoryGrid.style.boxSizing = 'border-box';
			typeButtons.length = 0;

			// ARCHIVED / PRESERVED IN CODE: Initial hardcoded sub-entity types for rollback reference.
			/*
			const legacyBaseTypes = [
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
			*/

			// Map of system pre-configured entity types to their distinctive rich icons
			const systemPreconfiguredIcons: Record<string, ThemeIcon> = {
				'job': Codicon.briefcase,
				'task': Codicon.tasklist,
				'project': Codicon.project,
				'workflow': Codicon.githubAction,
				'case': Codicon.checklist,
				'agent': Codicon.robot,
				'issue': Codicon.bug,
				'analysis': Codicon.graph,
				'note': Codicon.book
			};

			const defaultSystemModules: ICustomModule[] = [
				{ id: 'job', name: 'Job', color: '#fbbf24' },
				{ id: 'task', name: 'Task', color: '#a78bfa' },
				{ id: 'project', name: 'Project', color: '#60a5fa' },
				{ id: 'workflow', name: 'Workflow', color: '#0d9488' },
				{ id: 'case', name: 'Case', color: '#f472b6' },
				{ id: 'agent', name: 'AI Agent', color: '#38bdf8' },
				{ id: 'issue', name: 'Issue', color: '#ef4444' },
				{ id: 'analysis', name: 'Analysis', color: '#34d399' },
				{ id: 'note', name: 'Note', color: '#2dd4bf' }
			];

			let customModules: ICustomModule[] = [];
			try {
				customModules = (await this._getCustomModules(targetUri)).filter(m => !m.isDeprecated);
			} catch (err) {
				console.error('Error fetching custom modules:', err);
			}

			// Ensure baseline system modules exist if not yet configured in filesystem
			const existingIds = new Set(customModules.map(m => m.id.toLowerCase()));
			for (const defMod of defaultSystemModules) {
				if (!existingIds.has(defMod.id.toLowerCase())) {
					customModules.push(defMod);
					existingIds.add(defMod.id.toLowerCase());
				}
			}

			// Sort types: standard pre-configured types first in canonical order, then custom modules alphabetically
			const canonicalOrder = ['job', 'task', 'project', 'workflow', 'case', 'agent', 'issue', 'analysis', 'note'];
			customModules.sort((a, b) => {
				const idxA = canonicalOrder.indexOf(a.id.toLowerCase());
				const idxB = canonicalOrder.indexOf(b.id.toLowerCase());
				if (idxA !== -1 && idxB !== -1) {
					return idxA - idxB;
				}
				if (idxA !== -1) { return -1; }
				if (idxB !== -1) { return 1; }
				return a.name.localeCompare(b.name);
			});

			// "Freestyle" needs no template: the ticket designs its own components after creation
			const freestyleType = {
				type: FREESTYLE_TICKET_TYPE,
				label: FREESTYLE_TICKET_LABEL,
				icon: Codicon.edit,
				color: FREESTYLE_TICKET_COLOR,
				bg: hexToRgba(FREESTYLE_TICKET_COLOR, 0.18)
			};
			// A (legacy) template using the reserved "freestyle" name is never offered: "Freestyle" always means no template
			const customTypes = customModules.filter(m => !clashesWithBuiltInTicketType(m)).map(m => {
				const icon = m.icon
					? resolveCustomModuleIcon(m.icon, m.id)
					: (systemPreconfiguredIcons[m.id.toLowerCase()] || resolveCustomModuleIcon(undefined, m.id));
				const color = m.color || getDefaultCustomModuleColor(m.name || m.id);
				return {
					type: m.id,
					label: m.name,
					icon,
					color,
					bg: hexToRgba(color, 0.18)
				};
			});

			const filesystemTypes = [
				{ type: 'folder', label: 'Folder', icon: Codicon.folder, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.18)' },
				{ type: 'file', label: 'File', icon: Codicon.file, color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.18)' }
			];

			typesList = [freestyleType, ...customTypes, ...filesystemTypes];

			if (!typesList.some(t => t.type === selectedType)) {
				selectedType = 'job';
			}

			for (const t of typesList) {
				const btn = append(categoryGrid, $('.type-option-btn'));
				btn.style.padding = '8px 6px';
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
				btn.style.boxSizing = 'border-box';
				btn.style.width = '100%';
				btn.style.minWidth = '0';
				btn.style.minHeight = '34px';
				btn.setAttribute('aria-label', t.label);
				btn.addEventListener('mouseenter', () => showTypeTooltip(btn, t.label));
				btn.addEventListener('mouseleave', hideTypeTooltip);

				const iconSpan = append(btn, $('span' + ThemeIcon.asCSSSelector(t.icon)));
				iconSpan.style.color = t.color;
				iconSpan.style.fontSize = '14px';
				iconSpan.style.flexShrink = '0';

				append(btn, $('span', {
					style: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px;'
				}, t.label));

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

		// Title Input
		const titleBox = append(modalBody, $('.form-group'));
		const titleLabel = append(titleBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Title:'));
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

		// Type Definition Input
		const typeDefBox = append(modalBody, $('.form-group'));
		append(typeDefBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Type Definition:'));
		const typeDefInput = append(typeDefBox, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		typeDefInput.placeholder = '.agents/entity_type/job.yaml';

		// Status (Clean badge row)
		const statusBox = append(modalBody, $('.form-group'));
		append(statusBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Status:'));
		const statusBadgeWrapper = append(statusBox, $('div', { style: 'padding: 2px 0;' }));
		append(statusBadgeWrapper, $('span', {
			style: 'display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(129, 140, 248, 0.18); color: #818cf8; border: 1px solid rgba(129, 140, 248, 0.4);'
		}, 'Todo'));

		// Git Configuration Section (Collapsible, Default Collapsed and Hidden unless schema contains git primitive)
		const gitBox = append(modalBody, $('.form-group', { style: 'background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 14px; display: none; flex-direction: column; gap: 8px;' }));

		const gitHeaderRow = append(gitBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;' }));
		const gitTitle = append(gitHeaderRow, $('div', { style: 'font-size: 11.5px; opacity: 0.9; font-weight: 600; display: flex; align-items: center; gap: 6px;' }));
		const gitChevron = append(gitTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronRight)));
		gitChevron.style.fontSize = '12px';
		gitChevron.style.transition = 'transform 0.15s ease';
		append(gitTitle, $('span' + ThemeIcon.asCSSSelector(Codicon.sourceControl)));
		append(gitTitle, $('span', {}, 'Git Repository & Branch Binding (Optional)'));

		const gitToggleHint = append(gitHeaderRow, $('span', { style: 'font-size: 10.5px; opacity: 0.6; color: #38bdf8;' }, 'Configure Git...'));

		const gitContent = append(gitBox, $('div', { style: 'display: none; flex-direction: column; gap: 10px; margin-top: 4px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px;' }));

		let isGitExpanded = false;
		gitHeaderRow.onclick = () => {
			isGitExpanded = !isGitExpanded;
			gitContent.style.display = isGitExpanded ? 'flex' : 'none';
			gitChevron.className = ThemeIcon.asClassName(isGitExpanded ? Codicon.chevronDown : Codicon.chevronRight);
			gitToggleHint.textContent = isGitExpanded ? 'Collapse' : 'Configure Git...';
		};

		// Git Remote URL Input
		const gitRemoteRow = append(gitContent, $('div'));
		append(gitRemoteRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Git Remote URL (Leave blank to inherit parent repository):'));
		const gitRemoteInput = append(gitRemoteRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitRemoteInput.placeholder = 'e.g. git@github.com:org/repo.git or https://github.com/org/repo.git';

		// Target Branch Input
		const gitBranchRow = append(gitContent, $('div'));
		append(gitBranchRow, $('label', { style: 'display: block; font-size: 10.5px; opacity: 0.7; margin-bottom: 3px;' }, 'Target Branch:'));
		const gitBranchInput = append(gitBranchRow, $('input.monaco-inputbox', {
			style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
		})) as HTMLInputElement;
		gitBranchInput.placeholder = 'e.g. main, master, feature/user-auth (leave blank for default)';

		// Test & Diagnostic Row
		const gitActionRow = append(gitContent, $('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 2px;' }));
		const testGitBtn = append(gitActionRow, $('button', {
			style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(56, 189, 248, 0.15) !important; color: #38bdf8 !important; border: 1px solid rgba(56, 189, 248, 0.35) !important; outline: none; transition: all 0.15s ease;'
		})) as HTMLButtonElement;
		testGitBtn.onmouseenter = () => { testGitBtn.style.background = 'rgba(56, 189, 248, 0.25) !important'; };
		testGitBtn.onmouseleave = () => { testGitBtn.style.background = 'rgba(56, 189, 248, 0.15) !important'; };
		append(testGitBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.plug)));
		append(testGitBtn, $('span', {}, 'Test & Verify Git'));

		const gitStatusBadge = append(gitActionRow, $('div', {
			style: 'font-size: 11px; padding: 4px 8px; border-radius: 4px; display: none; align-items: center; gap: 6px; flex: 1; word-break: break-word;'
		}));

		const copyDiagnosticBtn = append(gitActionRow, $('button.btn-secondary', {
			style: 'display: none; align-items: center; gap: 4px; padding: 3px 8px; font-size: 10.5px; border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.15);'
		}));
		append(copyDiagnosticBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		append(copyDiagnosticBtn, $('span', {}, 'Copy Diagnostics'));

		let lastGitDiagnosticText = '';

		testGitBtn.onclick = async () => {
			testGitBtn.disabled = true;
			testGitBtn.style.opacity = '0.6';
			gitStatusBadge.style.display = 'flex';
			gitStatusBadge.style.backgroundColor = 'rgba(56, 189, 248, 0.12)';
			gitStatusBadge.style.color = '#38bdf8';
			gitStatusBadge.style.border = '1px solid rgba(56, 189, 248, 0.3)';
			gitStatusBadge.textContent = 'Verifying Git repository & branch...';
			copyDiagnosticBtn.style.display = 'none';

			try {
				const remoteUrl = gitRemoteInput.value.trim();
				const targetBranch = gitBranchInput.value.trim();

				let curr = targetUri;
				let foundGitUri: URI | undefined = undefined;
				while (curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
					const checkGit = URI.joinPath(curr, '.git');
					if (await this.fileService.exists(checkGit)) {
						foundGitUri = checkGit;
						break;
					}
					const parent = dirname(curr);
					if (parent.path === curr.path) { break; }
					curr = parent;
				}

				let branchName = 'main';
				const hasLocalGit = !!foundGitUri;
				let gitConfigRemote = '';

				if (foundGitUri) {
					try {
						const headUri = URI.joinPath(foundGitUri, 'HEAD');
						if (await this.fileService.exists(headUri)) {
							const headContent = (await this.fileService.readFile(headUri)).value.toString().trim();
							if (headContent.startsWith('ref: refs/heads/')) {
								branchName = headContent.replace('ref: refs/heads/', '').trim();
							}
						}
					} catch { }

					try {
						const configUri = URI.joinPath(foundGitUri, 'config');
						if (await this.fileService.exists(configUri)) {
							const configContent = (await this.fileService.readFile(configUri)).value.toString();
							const match = configContent.match(/url\s*=\s*(.+)/);
							if (match && match[1]) {
								gitConfigRemote = match[1].trim();
							}
						}
					} catch { }
				}

				const desiredBranch = targetBranch || branchName;
				const isBranchAligned = !targetBranch || targetBranch === branchName;

				if (hasLocalGit) {
					if (isBranchAligned) {
						gitStatusBadge.style.backgroundColor = 'rgba(52, 211, 153, 0.15)';
						gitStatusBadge.style.color = '#34d399';
						gitStatusBadge.style.border = '1px solid rgba(52, 211, 153, 0.35)';
						gitStatusBadge.textContent = `✔️ Connected: Local Git valid (Active Branch: '${branchName}'${gitConfigRemote ? ` | Remote: ${gitConfigRemote}` : ''})`;
						lastGitDiagnosticText = `Git Verification Success:\n- Path: ${targetUri.fsPath}\n- Active Branch: ${branchName}\n- Remote URL: ${remoteUrl || gitConfigRemote || 'None'}\n- Status: OK / Aligned`;
					} else {
						gitStatusBadge.style.backgroundColor = 'rgba(251, 146, 60, 0.15)';
						gitStatusBadge.style.color = '#fb923c';
						gitStatusBadge.style.border = '1px solid rgba(251, 146, 60, 0.35)';
						gitStatusBadge.textContent = `⚠️ Warning: Local branch is '${branchName}', but target is '${targetBranch}'.`;
						lastGitDiagnosticText = `Git Branch Alert:\n- Local Active Branch: ${branchName}\n- Desired Target Branch: ${targetBranch}\n- Status: Target branch differs from current active branch.`;
						copyDiagnosticBtn.style.display = 'inline-flex';
					}
				} else if (remoteUrl) {
					gitStatusBadge.style.backgroundColor = 'rgba(56, 189, 248, 0.15)';
					gitStatusBadge.style.color = '#38bdf8';
					gitStatusBadge.style.border = '1px solid rgba(56, 189, 248, 0.35)';
					gitStatusBadge.textContent = `✔️ Remote Git URL specified: ${remoteUrl} (Target Branch: '${desiredBranch}')`;
					lastGitDiagnosticText = `Remote Git Configured:\n- Remote URL: ${remoteUrl}\n- Target Branch: ${desiredBranch}\n- Status: Ready to track/clone`;
				} else {
					gitStatusBadge.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
					gitStatusBadge.style.color = 'var(--vscode-foreground)';
					gitStatusBadge.style.border = '1px solid rgba(255, 255, 255, 0.15)';
					gitStatusBadge.textContent = `\u2139\ufe0f No local .git repository found at this path. Entity will be created as standard workspace ticket folder.`;
					lastGitDiagnosticText = `No Git Repository:\n- Path: ${targetUri.fsPath}\n- Note: Leave blank if Git tracking is not required for this folder.`;
					copyDiagnosticBtn.style.display = 'inline-flex';
				}
			} catch (err) {
				gitStatusBadge.style.backgroundColor = 'rgba(248, 113, 113, 0.15)';
				gitStatusBadge.style.color = '#f87171';
				gitStatusBadge.style.border = '1px solid rgba(248, 113, 113, 0.35)';
				gitStatusBadge.textContent = `\u274C Git Check Error: ${(err as Error | undefined)?.message || err}`;
				lastGitDiagnosticText = `Git Check Error:\n- Error Details: ${(err as Error | undefined)?.stack || (err as Error | undefined)?.message || err}`;
				copyDiagnosticBtn.style.display = 'inline-flex';
			} finally {
				testGitBtn.disabled = false;
				testGitBtn.style.opacity = '1';
			}
		};

		copyDiagnosticBtn.onclick = () => {
			if (lastGitDiagnosticText) {
				this.clipboardService.writeText(lastGitDiagnosticText);
				this.notificationService.info('Copied Git diagnostic information to clipboard.');
			}
		};

		// Custom Fields Box for Custom Modules
		const customFieldsBox = append(modalBody, $('.custom-fields-box', { style: 'display: flex; flex-direction: column; gap: 10px; margin-top: 8px;' }));
		// The custom-field controls in DOM order (rebuilt together with `customFieldsBox`) and their inner parts
		let customFieldControls: HTMLElement[] = [];
		const fieldParts = new WeakMap<HTMLElement, ICreateDialogFieldParts>();
		const registerFieldControl = (el: HTMLElement) => {
			customFieldControls.push(el);
		};

		// Base Agent to Inherit From
		const baseAgentBox = append(modalBody, $('.form-group', { style: 'display: none;' }));
		append(baseAgentBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 4px; font-weight: 500;' }, 'Base Agent to Inherit From:'));
		const baseAgentSelect = append(baseAgentBox, $('select.monaco-select', {
			style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; box-sizing: border-box;'
		})) as HTMLSelectElement;

		append(baseAgentSelect, $('option', { value: '' }, '-- Create from Scratch (No Base Agent) --'));

		this.agentsManagerService.getAgents().then(agents => {
			for (const ag of agents) {
				append(baseAgentSelect, $('option', { value: ag.id }, `${ag.name} (${ag.model?.modelId || resolveDefaultModelId(ag.model?.providerId, 'gemini-2.5-flash')})`));
			}
		}).catch(() => { });

		// AI Agent Credential Box
		const credBox = append(modalBody, $('.form-group', { style: 'display: none;' }));
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
		const modelBox = append(modalBody, $('.form-group', { style: 'position: relative; display: none;' }));
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
		const promptBox = append(modalBody, $('.form-group', { style: 'display: none;' }));
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
				if (!query) { return true; }
				const matchString = `${m.id} ${m.label}`.toLowerCase();
				let queryIndex = 0;
				for (let i = 0; i < matchString.length; i++) {
					if (matchString[i] === query[queryIndex]) {
						queryIndex++;
						if (queryIndex === query.length) { return true; }
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

		const clickListener = (e: MouseEvent) => {
			if (e.target !== modelInput && !modelDropdown.contains(e.target as Node)) {
				modelDropdown.style.display = 'none';
			}
			if (typeof linkSearchInput !== 'undefined' && typeof linkDropdownMenu !== 'undefined') {
				if (e.target !== linkSearchInput && !linkDropdownMenu.contains(e.target as Node)) {
					linkDropdownMenu.style.display = 'none';
				}
			}
		};
		docClickListener.current = clickListener;
		mainWindow.document.addEventListener('click', clickListener);

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
			if (!baseAgentId) { return; }

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
			} catch { }
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
		const priorityDots: HTMLElement[] = [];
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
					const dotEl = priorityDots[i];
					btnEl.style.border = isSel ? `1px solid ${priorities[i].color}` : '1px solid rgba(255,255,255,0.08)';
					btnEl.style.backgroundColor = isSel ? `${priorities[i].color}25` : 'rgba(255,255,255,0.03)';
					btnEl.style.color = isSel ? priorities[i].color : 'inherit';
					if (dotEl) {
						dotEl.style.boxShadow = isSel ? `0 0 6px ${priorities[i].color}` : 'none';
					}
				}
			};
			priorityButtons.push(pBtn);
			priorityDots.push(dot);
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
				const opt = append(agentSelect, $('option', { value: ag.id }, `${ag.name} (${ag.model?.modelId || resolveDefaultModelId(ag.model?.providerId, 'gemini-2.5-flash')})`));
				opt.setAttribute('data-name', ag.name);
			}
		}).catch(() => { });

		// Link To Multi-Select Section
		const linkBox = append(modalBody, $('.form-group', { style: 'position: relative;' }));
		append(linkBox, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; margin-bottom: 5px; font-weight: 500;' }, 'Link To:'));

		const selectedLinkTickets: string[] = [];
		const linkChipsContainer = append(linkBox, $('.link-chips-container', {
			style: 'display: none; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;'
		}));

		const linkInputWrapper = append(linkBox, $('.link-input-wrapper', {
			style: 'position: relative; display: flex; align-items: center;'
		}));

		const linkSearchInput = append(linkInputWrapper, $('input.monaco-inputbox', {
			placeholder: 'Select or search tickets to link...',
			style: 'width: 100%; padding: 7px 28px 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; outline: none; cursor: pointer;'
		})) as HTMLInputElement;

		const linkDropdownArrow = append(linkInputWrapper, $('div', {
			style: 'position: absolute; right: 10px; font-size: 9px; opacity: 0.6; pointer-events: none; user-select: none;'
		}));
		linkDropdownArrow.textContent = '▼';

		const linkDropdownMenu = append(linkBox, $('.link-dropdown-menu', {
			style: 'position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15)); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); z-index: 100005; display: none; margin-top: 4px; box-sizing: border-box; padding: 4px 0;'
		}));

		let availableTickets: Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }> = [];

		const renderLinkChips = () => {
			clearNode(linkChipsContainer);
			if (selectedLinkTickets.length === 0) {
				linkChipsContainer.style.display = 'none';
				return;
			}
			linkChipsContainer.style.display = 'flex';
			for (let i = 0; i < selectedLinkTickets.length; i++) {
				const ticketId = selectedLinkTickets[i];
				const ticketObj = availableTickets.find(t => t.id === ticketId || t.code === ticketId);
				const badgeInfo = getTicketTypeBadge(ticketObj?.type || 'task');
				const chip = append(linkChipsContainer, $('.link-chip', {
					style: `display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); padding: 3px 8px; border-radius: 5px; font-size: 11px;`
				}));

				if (ticketObj) {
					const typeBadge = append(chip, $('span', {
						style: `font-size: 8.5px; font-weight: 700; color: ${badgeInfo.color}; background: ${badgeInfo.bg}; padding: 1px 4px; border-radius: 3px; text-transform: uppercase;`
					}));
					typeBadge.textContent = ticketObj.type;
				}

				const titleSpan = append(chip, $('span', { style: 'font-weight: 500;' }));
				titleSpan.textContent = ticketObj ? `${ticketObj.id} (${ticketObj.title})` : ticketId;

				const removeBtn = append(chip, $('span', {
					style: 'cursor: pointer; opacity: 0.6; margin-left: 2px; font-size: 11px;'
				}));
				removeBtn.textContent = '\u2715';
				removeBtn.onmouseenter = () => { removeBtn.style.opacity = '1.0'; };
				removeBtn.onmouseleave = () => { removeBtn.style.opacity = '0.6'; };
				removeBtn.onclick = (e) => {
					e.stopPropagation();
					selectedLinkTickets.splice(i, 1);
					renderLinkChips();
					renderLinkDropdown();
				};
			}
		};

		const renderLinkDropdown = () => {
			clearNode(linkDropdownMenu);
			const query = linkSearchInput.value.toLowerCase().trim();

			const filtered = availableTickets.filter(t => {
				if (!query) { return true; }
				const haystack = `${t.id} ${t.code} ${t.title} ${t.summary} ${t.type} ${t.workspaceName}`.toLowerCase();
				return haystack.includes(query);
			});

			if (filtered.length === 0) {
				const emptyItem = append(linkDropdownMenu, $('.dropdown-empty', {
					style: 'padding: 10px 14px; font-size: 11.5px; opacity: 0.6; font-style: italic;'
				}));
				emptyItem.textContent = query ? `No tickets matching "${query}". Press Enter to link as custom ID.` : 'No available tickets found in workspace.';
			} else {
				filtered.forEach(ticket => {
					const isChecked = selectedLinkTickets.includes(ticket.id) || selectedLinkTickets.includes(ticket.code);
					const badgeInfo = getTicketTypeBadge(ticket.type);

					const item = append(linkDropdownMenu, $('.ticket-dropdown-item', {
						style: `display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; cursor: pointer; transition: background 0.1s ease; border-bottom: 1px solid rgba(255,255,255,0.03); background: ${isChecked ? 'rgba(56, 189, 248, 0.08)' : 'transparent'};`
					}));

					item.onmouseenter = () => {
						item.style.background = isChecked ? 'rgba(56, 189, 248, 0.15)' : 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))';
					};
					item.onmouseleave = () => {
						item.style.background = isChecked ? 'rgba(56, 189, 248, 0.08)' : 'transparent';
					};

					const leftInfo = append(item, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;' }));

					const checkbox = append(leftInfo, $('input', {
						type: 'checkbox',
						style: 'cursor: pointer; accent-color: #38bdf8;'
					})) as HTMLInputElement;
					checkbox.checked = isChecked;

					const typeBadge = append(leftInfo, $('span', {
						style: `font-size: 8.5px; font-weight: 700; color: ${badgeInfo.color}; background: ${badgeInfo.bg}; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0;`
					}));
					typeBadge.textContent = ticket.type;

					const textCol = append(leftInfo, $('div', { style: 'display: flex; flex-direction: column; min-width: 0;' }));
					const idTitleRow = append(textCol, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
					append(idTitleRow, $('span', { style: 'font-weight: 600; font-size: 11.5px; color: #38bdf8;' }, ticket.id));
					if (ticket.title) {
						append(idTitleRow, $('span', { style: 'font-size: 11.5px; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' }, ` - ${ticket.title}`));
					}

					append(item, $('span', {
						style: 'font-size: 10px; opacity: 0.5; margin-left: 8px; flex-shrink: 0;'
					}, ticket.workspaceName));

					const toggleItem = (e: Event) => {
						e.stopPropagation();
						const idx = selectedLinkTickets.indexOf(ticket.id);
						if (idx !== -1) {
							selectedLinkTickets.splice(idx, 1);
						} else {
							selectedLinkTickets.push(ticket.id);
						}
						renderLinkChips();
						renderLinkDropdown();
					};

					item.onclick = toggleItem;
				});
			}
		};

		this._loadAllAvailableTickets().then(tickets => {
			availableTickets = tickets;
			renderLinkChips();
			renderLinkDropdown();
		});

		linkSearchInput.onclick = (e) => {
			e.stopPropagation();
			linkDropdownMenu.style.display = 'block';
			renderLinkDropdown();
		};

		linkSearchInput.oninput = () => {
			linkDropdownMenu.style.display = 'block';
			renderLinkDropdown();
		};

		linkSearchInput.onkeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = linkSearchInput.value.trim();
				if (val && !selectedLinkTickets.includes(val)) {
					selectedLinkTickets.push(val);
					linkSearchInput.value = '';
					renderLinkChips();
					renderLinkDropdown();
				}
			} else if (e.key === 'Escape') {
				linkDropdownMenu.style.display = 'none';
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
			style: 'padding: 7px 18px; font-size: 11.5px; border-radius: 6px; cursor: pointer; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #ffffff); border: none; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px;'
		})) as HTMLButtonElement;
		clearNode(submitBtn);
		const sparkleSpan = append(submitBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.sparkleFilled)));
		sparkleSpan.style.fontSize = '12px';
		append(submitBtn, $('span', {}, 'Create'));

		const updateValidation = async () => {
			const inputName = nameInput.value.trim();
			if (!inputName) {
				warningBanner.style.display = 'none';
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
				warningBanner.innerText = `Item '${inputName}' already exists in '${targetName}'. Please enter a unique name.`;
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
			// Freestyle never uses a template, even if one happens to be called "freestyle"
			const matchingModule = isFreestyleTicketType(selectedType) ? undefined : customModules.find((m: ICustomModule) => m.id === selectedType);

			if (selectedType === 'folder') {
				codeBox.style.display = 'none';
				badgeBox.style.display = 'none';
				titleBox.style.display = 'none';
				descBox.style.display = 'block';
				typeDefBox.style.display = 'none';
				statusBox.style.display = 'none';
				priorityBox.style.display = 'none';
				agentBox.style.display = 'none';
				linkBox.style.display = 'none';
				typePromptBox.style.display = 'none';
				ruleBox.style.display = 'none';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'Folder Name:';
				nameInput.value = 'new_folder';
				nameInput.readOnly = false;
				nameInput.style.opacity = '1.0';
				nameInput.style.cursor = 'text';
				descLabel.innerText = 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';
			} else if (selectedType === 'file') {
				codeBox.style.display = 'none';
				badgeBox.style.display = 'none';
				titleBox.style.display = 'none';
				descBox.style.display = 'block';
				typeDefBox.style.display = 'none';
				statusBox.style.display = 'none';
				priorityBox.style.display = 'none';
				agentBox.style.display = 'none';
				linkBox.style.display = 'none';
				typePromptBox.style.display = 'none';
				ruleBox.style.display = 'none';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'File Name:';
				nameInput.value = 'new_file.md';
				nameInput.readOnly = false;
				nameInput.style.opacity = '1.0';
				nameInput.style.cursor = 'text';
				descLabel.innerText = 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';
			} else {
				const isFreestyle = isFreestyleTicketType(selectedType);
				// A Freestyle ticket starts with Title + Description (no template)
				const hasDescField = isFreestyle || !!(matchingModule && Array.isArray(matchingModule.fields) && matchingModule.fields.some(f => f.id?.toLowerCase() === 'description' || f.label?.toLowerCase() === 'description'));
				const descFieldDef = matchingModule?.fields?.find(f => f.id?.toLowerCase() === 'description' || f.label?.toLowerCase() === 'description');
				const titleFieldDef = matchingModule?.fields?.find(f => f.id?.toLowerCase() === 'title' || f.label?.toLowerCase() === 'title');

				codeBox.style.display = 'block';
				badgeBox.style.display = 'block';
				titleBox.style.display = 'block';
				descBox.style.display = hasDescField ? 'block' : 'none';
				if (!hasDescField) {
					descInput.value = '';
				}
				typeDefBox.style.display = 'block';
				statusBox.style.display = 'block';
				priorityBox.style.display = 'block';
				agentBox.style.display = 'none';
				linkBox.style.display = 'none';
				typePromptBox.style.display = 'none';
				ruleBox.style.display = 'none';
				credBox.style.display = 'none';
				modelBox.style.display = 'none';
				promptBox.style.display = 'none';
				baseAgentBox.style.display = 'none';
				nameLabel.innerText = 'Entity Folder Name / Ticket ID:';
				titleLabel.innerText = titleFieldDef?.label ? `${titleFieldDef.label}:` : 'Title:';
				descLabel.innerText = descFieldDef?.label ? `${descFieldDef.label}:` : 'Description:';
				descInput.placeholder = 'Brief purpose of this entity...';

				const customCode = codeInput.value.trim();
				const seq = await this.workspacesExplorerService.generateNextSequentialName(targetUri, selectedType, customCode);
				nameInput.value = seq.name;
				nameInput.readOnly = true;
				nameInput.style.opacity = '0.65';
				nameInput.style.cursor = 'not-allowed';
				previewBadge.innerText = `Generated Ticket ID: ${seq.name} (Prefix Code: ${seq.code})`;
				const currentTypeObj = typesList.find(t => t.type === selectedType);
				const badgeColor = currentTypeObj ? currentTypeObj.color : '#38bdf8';
				previewBadge.style.color = badgeColor;
				previewBadge.style.borderColor = `${badgeColor}58`;

				const isBuiltIn = !matchingModule;
				if (isFreestyle) {
					typeDefInput.value = 'Freestyle (no template: add components in the ticket after creation)';
					typeDefInput.placeholder = typeDefInput.value;
				} else if (isBuiltIn) {
					typeDefInput.value = 'Built-in (System)';
					typeDefInput.placeholder = 'Built-in (System)';
				} else {
					const defFile = (matchingModule as (ICustomModule & { definitionFile?: string }) | undefined)?.definitionFile;
					const modDesc = typeof matchingModule?.description === 'string' ? matchingModule.description.trim() : '';
					typeDefInput.value = defFile || modDesc || `.agents/entity_type/${selectedType}.yaml`;
					typeDefInput.placeholder = `.agents/entity_type/${selectedType}.yaml`;
				}
				typeDefInput.readOnly = true;
				typeDefInput.style.opacity = '0.65';
				typeDefInput.style.cursor = 'not-allowed';
				const modPrompt = typeof matchingModule?.prompt === 'string' ? matchingModule.prompt.trim() : '';
				typePromptInput.value = isFreestyle ? FREESTYLE_TYPE_PROMPT : (modPrompt || builtInTypePrompts[selectedType] || '');
			}

			// Git Section Visibility: Only displayed when module schema contains a 'git' primitive field!
			const hasGitField = !!(matchingModule && matchingModule.fields && matchingModule.fields.some(f => f.type === 'git'));
			gitBox.style.display = hasGitField ? 'flex' : 'none';
			if (hasGitField) {
				const gitField = matchingModule!.fields!.find(f => f.type === 'git');
				if (gitField?.gitRemoteUrl && !gitRemoteInput.value) {
					gitRemoteInput.value = gitField.gitRemoteUrl;
				}
				if (gitField?.gitBranch && !gitBranchInput.value) {
					gitBranchInput.value = gitField.gitBranch;
				}
			} else {
				gitRemoteInput.value = '';
				gitBranchInput.value = '';
			}

			if (matchingModule && matchingModule.fields && matchingModule.fields.length > 0) {
				clearNode(customFieldsBox);
				customFieldControls = [];
				customFieldsBox.style.display = 'flex';
				for (const field of matchingModule.fields) {
					if (field.id === 'title' || field.label?.toLowerCase() === 'title' || field.id === 'description' || field.label?.toLowerCase() === 'description') {
						continue;
					}
					const fieldGroup = append(customFieldsBox, $('.form-group', { style: 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px;' }));
					append(fieldGroup, $('label', { style: 'display: block; font-size: 11.5px; opacity: 0.85; font-weight: 600;' }, `${field.label}:`));

					if (field.type === 'textarea') {
						registerFieldControl(append(fieldGroup, $('textarea.monaco-inputbox.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 8px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; resize: vertical; min-height: 52px; font-family: inherit;'
						})));
					} else if (field.type === 'select') {
						const select = append(fieldGroup, $('select.monaco-select.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer;'
						})) as HTMLSelectElement;
						registerFieldControl(select);
						(field.options || []).forEach((opt: string) => {
							append(select, $('option', { value: opt }, opt));
						});
					} else if (field.type === 'multiselect') {
						const container = append(fieldGroup, $('.multiselect-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.15);'
						}));
						registerFieldControl(container);
						const checkboxes: HTMLInputElement[] = [];
						fieldParts.set(container, { checkboxes });
						(field.options || []).forEach((opt: string) => {
							const row = append(container, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 11.5px; cursor: pointer;' }));
							checkboxes.push(append(row, $<HTMLInputElement>('input', { type: 'checkbox', value: opt, style: 'cursor: pointer;' })));
							append(row, $('span', {}, opt));
						});
					} else if (field.type === 'switch') {
						const row = append(fieldGroup, $('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 11.5px; cursor: pointer; padding: 4px 0;' }));
						registerFieldControl(append(row, $('input.custom-field-input', {
							type: 'checkbox',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'cursor: pointer;'
						})));
						append(row, $('span', {}, 'Enabled'));
					} else if (field.type === 'date') {
						registerFieldControl(append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
							type: 'date',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						})));
					} else if (field.type === 'time') {
						registerFieldControl(append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
							type: 'time',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						})));
					} else if (field.type === 'datetime') {
						registerFieldControl(append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
							type: 'datetime-local',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						})));
					} else if (field.type === 'date_range' || field.type === 'time_range' || field.type === 'datetime_range') {
						const rangeContainer = append(fieldGroup, $('.range-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; align-items: center; gap: 8px;'
						}));
						registerFieldControl(rangeContainer);
						const inputType = field.type === 'date_range' ? 'date' : field.type === 'time_range' ? 'time' : 'datetime-local';
						const rangeStart = append(rangeContainer, $<HTMLInputElement>('input.monaco-inputbox.range-start', {
							type: inputType,
							placeholder: 'Start',
							style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
						}));
						append(rangeContainer, $('span', { style: 'opacity: 0.6; font-size: 12px;' }, '\u2794'));
						const rangeEnd = append(rangeContainer, $<HTMLInputElement>('input.monaco-inputbox.range-end', {
							type: inputType,
							placeholder: 'End',
							style: 'flex: 1; padding: 7px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit;'
						}));
						fieldParts.set(rangeContainer, { rangeStart, rangeEnd });
					} else if (field.type === 'dynamic_list') {
						const listContainer = append(fieldGroup, $('.dynamic-list-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(56, 189, 248, 0.2); background: rgba(56, 189, 248, 0.03); border-radius: 8px; padding: 12px;'
						}));
						registerFieldControl(listContainer);
						const listCards: IDynamicListCard[] = [];
						fieldParts.set(listContainer, { listCards });

						const itemsWrapper = append(listContainer, $('.dynamic-items-wrapper', { style: 'display: flex; flex-direction: column; gap: 10px;' }));

						const renderItemCard = (itemData?: { _title?: string }) => {
							const currentCount = listCards.length;
							const idx = currentCount + 1;
							const itemCard = append(itemsWrapper, $('.dynamic-item-card', {
								style: 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;'
							}));

							const itemHeader = append(itemCard, $('.item-card-header', { style: 'display: flex; justify-content: space-between; align-items: center;' }));
							const headerLeft = append(itemHeader, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1;' }));
							const badgeEl = append(headerLeft, $('span', { style: 'font-size: 10px; font-weight: 700; background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 2px 6px; border-radius: 4px;' }, `#${idx}`));
							const titleInput = append(headerLeft, $<HTMLInputElement>('input.monaco-inputbox.item-title-input', {
								placeholder: `Entry Title (e.g. Company, Project, Milestone)...`,
								value: itemData?._title || '',
								style: 'flex: 1; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
							}));
							const cardRefs: IDynamicListCard = { cardEl: itemCard, badgeEl, titleInput, subInputs: [] };
							listCards.push(cardRefs);

							const delItemBtn = append(itemHeader, $('span' + ThemeIcon.asCSSSelector(Codicon.trash), {
								style: 'color: #ef4444; cursor: pointer; padding: 4px; font-size: 12px; opacity: 0.8;'
							}));
							delItemBtn.onclick = () => {
								itemCard.remove();
								const cardIdx = listCards.indexOf(cardRefs);
								if (cardIdx >= 0) {
									listCards.splice(cardIdx, 1);
								}
								// Re-index remaining
								listCards.forEach((card, rIdx) => {
									card.badgeEl.innerText = `#${rIdx + 1}`;
								});
							};

							const subFieldsList = field.itemFields || [];
							if (subFieldsList.length > 0) {
								const subGrid = append(itemCard, $('.subfields-grid', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
								for (const subF of subFieldsList) {
									const subRow = append(subGrid, $('.subfield-row', { style: 'display: flex; flex-direction: column; gap: 3px;' }));
									append(subRow, $('label', { style: 'font-size: 10.5px; opacity: 0.75; font-weight: 500;' }, `${subF.label}:`));

									if (subF.type === 'textarea') {
										cardRefs.subInputs.push(append(subRow, $('textarea.monaco-inputbox.sub-field-input', {
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											rows: '3',
											style: 'width: 100%; padding: 6px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff; resize: vertical; font-family: inherit;'
										})));
									} else if (subF.type === 'select') {
										const sSelect = append(subRow, $('select.monaco-select.sub-field-input', {
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.25); color: #fff;'
										})) as HTMLSelectElement;
										cardRefs.subInputs.push(sSelect);
										(subF.options || []).forEach(o => append(sSelect, $('option', { value: o }, o)));
									} else if (subF.type === 'date_range' || subF.type === 'time_range' || subF.type === 'datetime_range') {
										const rBox = append(subRow, $('.range-container.sub-field-input', {
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											style: 'display: flex; align-items: center; gap: 6px;'
										}));
										cardRefs.subInputs.push(rBox);
										const iType = subF.type === 'date_range' ? 'date' : subF.type === 'time_range' ? 'time' : 'datetime-local';
										const subRangeStart = append(rBox, $<HTMLInputElement>('input.monaco-inputbox.range-start', {
											type: iType,
											style: 'flex: 1; padding: 4px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
										}));
										append(rBox, $('span', { style: 'font-size: 11px; opacity: 0.6;' }, '\u2794'));
										const subRangeEnd = append(rBox, $<HTMLInputElement>('input.monaco-inputbox.range-end', {
											type: iType,
											style: 'flex: 1; padding: 4px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
										}));
										fieldParts.set(rBox, { rangeStart: subRangeStart, rangeEnd: subRangeEnd });
									} else if (subF.type === 'date' || subF.type === 'time' || subF.type === 'datetime') {
										const iType = subF.type === 'date' ? 'date' : subF.type === 'time' ? 'time' : 'datetime-local';
										cardRefs.subInputs.push(append(subRow, $('input.monaco-inputbox.sub-field-input', {
											type: iType,
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
										})));
									} else if (subF.type === 'switch') {
										const sLabel = append(subRow, $('label', { style: 'display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer;' }));
										cardRefs.subInputs.push(append(sLabel, $('input.sub-field-input', {
											type: 'checkbox',
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type
										})));
										append(sLabel, $('span', {}, 'Enabled'));
									} else if (subF.type === 'number') {
										cardRefs.subInputs.push(append(subRow, $('input.monaco-inputbox.sub-field-input', {
											type: 'number',
											step: 'any',
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											placeholder: `Enter ${subF.label}...`,
											style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
										})));
									} else {
										cardRefs.subInputs.push(append(subRow, $('input.monaco-inputbox.sub-field-input', {
											type: 'text',
											'data-subfield-id': subF.id,
											'data-subfield-label': subF.label,
											'data-subfield-type': subF.type,
											placeholder: `Enter ${subF.label}...`,
											style: 'width: 100%; padding: 5px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: #fff;'
										})));
									}
								}
							}
						};

						// Render initial entry
						renderItemCard();

						const addEntryBtn = append(listContainer, $('button.monaco-button', {
							style: 'padding: 5px 12px; font-size: 11px; border-radius: 5px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); cursor: pointer; align-self: flex-start; font-weight: 500;'
						}));
						addEntryBtn.innerText = `+ Add ${field.label} Entry`;
						addEntryBtn.onclick = (e) => {
							e.preventDefault();
							renderItemCard();
						};
					} else if (field.type === 'attachment') {
						const attachContainer = append(fieldGroup, $('.attachment-field-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 8px; border: 1.5px dashed rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.03); border-radius: 8px; padding: 12px;'
						}));
						registerFieldControl(attachContainer);

						const fileListWrapper = append(attachContainer, $('.attachment-file-list', {
							style: 'display: flex; flex-wrap: wrap; gap: 8px;'
						}));

						const attachedFiles: Array<{ name: string; size: number; dataUrl?: string }> = [];

						const fileInput = append(attachContainer, $('input', {
							type: 'file',
							multiple: 'multiple',
							style: 'display: none;'
						})) as HTMLInputElement;

						const renderFileList = () => {
							clearNode(fileListWrapper);
							if (attachedFiles.length === 0) {
								append(fileListWrapper, $('div', {
									style: 'font-size: 11px; opacity: 0.5; font-style: italic;'
								}, 'No attachments uploaded yet. Click or drop files below.'));
							} else {
								attachedFiles.forEach((f, idx) => {
									const pill = append(fileListWrapper, $('.attachment-pill', {
										style: 'display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; font-size: 11px;'
									}));
									const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name);
									const isPdf = /\.pdf$/i.test(f.name);
									const iconClass = isImg ? Codicon.fileMedia : isPdf ? Codicon.filePdf : Codicon.file;
									append(pill, $('span' + ThemeIcon.asCSSSelector(iconClass), { style: 'font-size: 12px; color: #10b981;' }));
									append(pill, $('span', { style: 'max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, f.name));
									const sizeKb = (f.size / 1024).toFixed(0);
									append(pill, $('span', { style: 'opacity: 0.5; font-size: 9.5px;' }, `(${sizeKb} KB)`));
									const removeBtn = append(pill, $('span', { style: 'cursor: pointer; opacity: 0.6; font-size: 11px; margin-left: 2px;' }, '\u2715'));
									removeBtn.onclick = (ev) => {
										ev.stopPropagation();
										attachedFiles.splice(idx, 1);
										renderFileList();
									};
								});
							}
						};
						renderFileList();

						const dropZone = append(attachContainer, $('.attachment-drop-target', {
							style: 'display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.2); cursor: pointer; transition: all 0.2s;'
						}));
						append(dropZone, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload), { style: 'font-size: 16px; color: #10b981;' }));
						append(dropZone, $('span', { style: 'font-size: 11px; opacity: 0.8;' }, 'Click to browse or drop images, PDFs, files here'));

						const handleFiles = (files: FileList | null) => {
							if (!files) { return; }
							for (let i = 0; i < files.length; i++) {
								const file = files[i];
								const reader = new FileReader();
								reader.onload = () => {
									attachedFiles.push({
										name: file.name,
										size: file.size,
										dataUrl: reader.result as string
									});
									renderFileList();
								};
								reader.readAsDataURL(file);
							}
						};

						fileInput.onchange = () => {
							handleFiles(fileInput.files);
							fileInput.value = '';
						};

						dropZone.onclick = () => fileInput.click();

						dropZone.ondragover = (e) => {
							e.preventDefault();
							e.stopPropagation();
							dropZone.style.background = 'rgba(16, 185, 129, 0.15)';
						};
						dropZone.ondragleave = () => {
							dropZone.style.background = 'rgba(0, 0, 0, 0.2)';
						};
						dropZone.ondrop = (e) => {
							e.preventDefault();
							e.stopPropagation();
							dropZone.style.background = 'rgba(0, 0, 0, 0.2)';
							if (e.dataTransfer?.files) {
								handleFiles(e.dataTransfer.files);
							}
						};

						fieldParts.set(attachContainer, { getAttachedFiles: () => attachedFiles });
					} else if (field.type === 'button_group') {
						const buttonsList: IActionButton[] = (field.buttons && Array.isArray(field.buttons) && field.buttons.length > 0)
							? field.buttons
							: [
								{ id: 'btn_1', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
								{ id: 'btn_2', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
							];

						const btnGroupContainer = append(fieldGroup, $('.action-buttons-group-row.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0;'
						}));
						registerFieldControl(btnGroupContainer);

						let selectedActionLabel = '';
						let selectedTargetStatus = '';
						fieldParts.set(btnGroupContainer, {
							getSelectedAction: () => selectedActionLabel,
							getSelectedTargetStatus: () => selectedTargetStatus
						});

						const renderButtons = () => {
							clearNode(btnGroupContainer);
							buttonsList.forEach(btn => {
								const btnColor = btn.color || '#3b82f6';
								const isSelected = selectedActionLabel === btn.label;
								const b = append(btnGroupContainer, $('button.ticket-action-transition-btn', {
									type: 'button',
									style: `--btn-accent-color: ${btnColor}; ${isSelected ? `background: color-mix(in srgb, ${btnColor} 26%, transparent); border-color: ${btnColor}; color: #ffffff; box-shadow: 0 0 0 1px ${btnColor};` : ''}`,
									title: btn.targetStatus ? `Action: '${btn.label}' (Transitions to '${btn.targetStatus}')` : `Action: '${btn.label}'`
								}));

								append(b, $('span.action-btn-text', {}, btn.label));

								b.onclick = (e) => {
									e.preventDefault();
									e.stopPropagation();
									if (selectedActionLabel === btn.label) {
										selectedActionLabel = '';
										selectedTargetStatus = '';
									} else {
										selectedActionLabel = btn.label;
										selectedTargetStatus = btn.targetStatus || '';
									}
									renderButtons();
								};
							});
						};
						renderButtons();
					} else if (field.type === 'number') {
						const numWrapper = append(fieldGroup, $('div', {
							style: 'display: flex; align-items: center; gap: 8px;'
						}));
						registerFieldControl(append(numWrapper, $('input.monaco-inputbox.custom-field-input', {
							type: 'number',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							...(typeof field.min === 'number' ? { min: String(field.min), 'data-min': String(field.min) } : {}),
							...(typeof field.max === 'number' ? { max: String(field.max), 'data-max': String(field.max) } : {}),
							...(typeof field.precision === 'number' ? { 'data-precision': String(field.precision) } : {}),
							step: (field.precision !== undefined && field.precision > 0) ? (1 / Math.pow(10, field.precision)).toString() : 'any',
							placeholder: field.precision !== undefined && field.precision > 0 ? (0).toFixed(field.precision) : '0',
							style: 'flex: 1; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						})));
						if (field.unit) {
							append(numWrapper, $('span.number-unit-badge', {
								style: 'font-size: 11px; padding: 5px 8px; border-radius: 4px; background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); font-weight: 600;'
							}, field.unit));
						}
					} else if (field.type === 'browser') {
						const browserBox = append(fieldGroup, $('.browser-field-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(56, 189, 248, 0.25); background: rgba(56, 189, 248, 0.03); border-radius: 8px; padding: 10px 12px;'
						}));
						registerFieldControl(browserBox);

						const urlRow = append(browserBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
						append(urlRow, $('label', { style: 'font-size: 10.5px; opacity: 0.8; font-weight: 500;' }, 'Target URL:'));

						const urlInputWrapper = append(urlRow, $('div', { style: 'position: relative; width: 100%;' }));
						const urlDisplayEl = append(urlInputWrapper, $('div.prompt-tokenized-display', {
							style: 'display: flex; align-items: center; min-height: 29px; padding: 5px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; cursor: text; white-space: pre; overflow-x: auto; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
						}));
						const urlInput = append(urlInputWrapper, $('input.monaco-inputbox.browser-url-input', {
							placeholder: 'https://example.com...',
							value: field.defaultUrl || '',
							style: 'display: none; width: 100%; min-height: 29px; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.65); background: rgba(0,0,0,0.35); color: #fff; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); outline: none;'
						})) as HTMLInputElement;

						const renderUrlTokenized = () => {
							const text = urlInput.value || '';
							clearNode(urlDisplayEl);
							if (!text) {
								append(urlDisplayEl, $('span', { style: 'opacity: 0.45; font-style: italic;' }, urlInput.placeholder));
								return;
							}
							const tokenRegex = /(\{\{[^{}\n]+\}\}|\{[^{}\n]+\}|@[a-zA-Z0-9_\-\u4e00-\u9fa5]+)/g;
							let lastIdx = 0;
							let match: RegExpExecArray | null;
							while ((match = tokenRegex.exec(text)) !== null) {
								if (match.index > lastIdx) {
									append(urlDisplayEl, $('span', {}, text.slice(lastIdx, match.index)));
								}
								const fullMatch = match[0];
								const cleanTokenName = fullMatch.startsWith('{{') && fullMatch.endsWith('}}')
									? fullMatch.slice(2, -2).trim()
									: (fullMatch.startsWith('{') && fullMatch.endsWith('}') ? fullMatch.slice(1, -1).trim() : fullMatch.slice(1).trim());
								if (cleanTokenName) {
									const pill = append(urlDisplayEl, $('span.prompt-token-pill', {
										title: `Reference: ${cleanTokenName}`,
										style: 'display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; margin: 0 1px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(14, 99, 156, 0.28); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); vertical-align: baseline; user-select: none;'
									}));
									append(pill, $('span' + ThemeIcon.asCSSSelector(Codicon.link), { style: 'font-size: 10px;' }));
									append(pill, $('span', {}, cleanTokenName));
								} else {
									append(urlDisplayEl, $('span', {}, fullMatch));
								}
								lastIdx = tokenRegex.lastIndex;
							}
							if (lastIdx < text.length) {
								append(urlDisplayEl, $('span', {}, text.slice(lastIdx)));
							}
						};

						urlDisplayEl.onclick = () => {
							urlDisplayEl.style.display = 'none';
							urlInput.style.display = 'block';
							urlInput.focus();
						};
						urlInput.onblur = () => {
							urlInput.style.display = 'none';
							urlDisplayEl.style.display = 'flex';
							renderUrlTokenized();
						};
						urlInput.onkeydown = (ev) => {
							if (ev.key === 'Enter') {
								ev.preventDefault();
								urlInput.blur();
							}
						};
						renderUrlTokenized();

						// Credentials are set in the template and used at run time; the new ticket stores none. Only the
						// names are shown, with values always masked.
						const credNames = maskBrowserCredentials(field.credentials).map(c => c.key);
						if (credNames.length > 0) {
							const credsNote = 'Credentials are set in the template';
							const credsSection = append(browserBox, $('div', {
								title: credsNote,
								style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06);'
							}));
							append(credsSection, $('span', { style: 'font-size: 10.5px; opacity: 0.85; font-weight: 600; color: #a78bfa;' }, 'Credentials:'));
							for (const name of credNames) {
								append(credsSection, $('span', {
									style: 'font-size: 10.5px; padding: 1px 6px; border-radius: 3px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); font-family: var(--vscode-editor-font-family, monospace);'
								}, `${name} = ${MASKED_SECRET}`));
							}
							append(credsSection, $('span', { style: 'font-size: 10px; opacity: 0.5; font-style: italic;' }, credsNote));
						}

						fieldParts.set(browserBox, {
							getBrowserData: () => ({
								url: urlInput.value.trim(),
								credentials: [],
								content: field.defaultContent || '',
								lastFetched: field.defaultContent ? 'Initialized from Schema' : ''
							})
						});
					} else if (field.type === 'prompt') {
						const promptBox = append(fieldGroup, $('.prompt-field-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(59, 130, 246, 0.25); background: rgba(59, 130, 246, 0.04); border-radius: 8px; padding: 10px 12px;'
						}));
						registerFieldControl(promptBox);

						const targetDesc = field.targetMode === 'agent'
							? `Agent: ${field.targetAgentName || field.targetAgentId || 'Default'}`
							: `Model: ${field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash')}`;

						const topRow = append(promptBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }));
						append(topRow, $('span', { style: 'font-size: 10.5px; opacity: 0.85; font-weight: 600; color: #60a5fa;' }, `AI Instruction (${targetDesc})`));

						const preInjectedText = field.defaultContent || '';
						const isPreInjectedVisible = Boolean(field.promptPreInjectedVisible);

						if (isPreInjectedVisible) {
							const preInjectedContainer = append(promptBox, $('div', {
								style: 'display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 6px; background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.22);'
							}));
							const preHeader = append(preInjectedContainer, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 6px;' }));
							append(preHeader, $('span', { style: 'font-size: 10.5px; font-weight: 600; color: #60a5fa;' }, 'Pre-Injected Prompt (Template Instruction):'));
							const preTextarea = append(preInjectedContainer, $('textarea.monaco-inputbox', {
								readonly: 'readonly',
								rows: 5,
								style: 'width: 100%; min-height: 118px; padding: 8px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #cbd5e1; box-sizing: border-box; line-height: 1.45; resize: vertical; opacity: 0.9;'
							})) as HTMLTextAreaElement;
							preTextarea.value = preInjectedText;
						}

						const userInputContainer = append(promptBox, $('div', {
							style: 'display: flex; flex-direction: column; gap: 4px;'
						}));
						append(userInputContainer, $('span', { style: 'font-size: 10.5px; font-weight: 600; color: #60a5fa;' }, 'User Prompt / Instructions:'));

						const promptTextarea = append(userInputContainer, $('textarea.monaco-inputbox.prompt-text-input', {
							placeholder: 'Enter your prompt or custom instructions here...',
							rows: 5,
							style: 'width: 100%; min-height: 118px; padding: 8px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.45; resize: vertical;'
						})) as HTMLTextAreaElement;
						promptTextarea.value = field.defaultUserPrompt || '';

						const getPromptData = () => {
							const userPromptVal = promptTextarea.value.trim();
							const preTrimmed = preInjectedText.trim();
							const combinedPrompt = (preTrimmed && userPromptVal)
								? `${preTrimmed}\n\n--- User Prompt / Instructions ---\n${userPromptVal}`
								: (preTrimmed || userPromptVal);
							return {
								userPrompt: userPromptVal,
								preInjectedPrompt: preInjectedText,
								prompt: combinedPrompt,
								targetMode: field.targetMode || 'model',
								targetProvider: field.targetProvider || (field.targetModel ? '' : (getGlobalDefaultModel()?.providerId || '')),
								targetModel: field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash'),
								targetAgentId: field.targetAgentId || '',
								targetAgentName: field.targetAgentName || '',
								output: '',
								lastExecuted: ''
							};
						};
						fieldParts.set(promptBox, { getPromptData });
					} else if (field.type === 'tts') {
						const ttsBox = append(fieldGroup, $('.tts-field-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(236, 72, 153, 0.25); background: rgba(236, 72, 153, 0.04); border-radius: 8px; padding: 10px 12px;'
						}));
						registerFieldControl(ttsBox);

						const topRow = append(ttsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }));
						append(topRow, $('span', { style: 'font-size: 10.5px; opacity: 0.9; font-weight: 600; color: #f472b6;' }, `1. Speech Synthesis Text (Sent to AI Model Only · ${field.targetModel || 'gemini-2.5-flash-preview-tts'} · ${(field.ttsFormat || 'mp3').toUpperCase()})`));

						const ttsTextarea = append(ttsBox, $('textarea.monaco-inputbox.tts-text-input', {
							placeholder: 'Pure listening text sent to the AI model to synthesize into speech (hidden in ticket view)...',
							rows: 2,
							style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(236, 72, 153, 0.3); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.4; font-family: inherit;'
						})) as HTMLTextAreaElement;
						ttsTextarea.value = field.defaultContent || '';

						const displayRow = append(ttsBox, $('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px;' }));
						append(displayRow, $('span', { style: 'font-size: 10.5px; opacity: 0.9; font-weight: 600; color: #38bdf8;' }, '2. Display Text (Shown to Human Reader in Ticket · With Vocabulary Notes)'));

						const ttsDisplayTextarea = append(ttsBox, $('textarea.monaco-inputbox.tts-display-text-input', {
							placeholder: 'Annotated text shown to the human reader in the ticket (e.g. vocabulary notes not sent to the AI model)...',
							rows: 3,
							style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; line-height: 1.4; font-family: inherit;'
						})) as HTMLTextAreaElement;
						ttsDisplayTextarea.value = field.ttsDisplayText || '';

						const getTtsData = () => ({
							text: ttsTextarea.value.trim(),
							displayText: ttsDisplayTextarea.value.trim(),
							targetCredentialId: field.targetCredentialId || '',
							targetProvider: field.targetProvider || 'gemini',
							targetModel: field.targetModel || 'gemini-2.5-flash-preview-tts',
							ttsFormat: field.ttsFormat || 'mp3',
							ttsVoice: field.ttsVoice || 'Kore',
							ttsAutoPlay: Boolean(field.ttsAutoPlay),
							audioFileName: '',
							audioRelativePath: '',
							lastGenerated: '',
							lastSynthesizedText: ''
						});
						fieldParts.set(ttsBox, { getTtsData });
					} else if (field.type === 'python') {
						const pyBox = append(fieldGroup, $('.python-field-container.custom-field-input', {
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(234, 179, 8, 0.25); background: rgba(234, 179, 8, 0.04); border-radius: 8px; padding: 10px 12px;'
						}));
						registerFieldControl(pyBox);
						const pyTextarea = append(pyBox, $('textarea.monaco-inputbox.python-code-input', {
							placeholder: '# Python source code...',
							rows: 4,
							style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.4;'
						})) as HTMLTextAreaElement;
						const pyField: ILegacyPythonField = field;
						const initialPyCode = pyField.pythonCode || pyField.code || field.defaultContent || '';
						pyTextarea.value = initialPyCode;
						pyTextarea.onkeydown = (e) => {
							if (isCommentKeybinding(e)) {
								e.preventDefault();
								e.stopPropagation();
								togglePythonComment(pyTextarea);
							}
						};
						const getPythonData = () => ({
							code: pyTextarea.value || initialPyCode,
							pythonPath: pyField.pythonPath || '',
							pythonEnvMode: pyField.pythonEnvMode || 'existing',
							pythonLocked: Boolean(pyField.pythonLocked),
							externalScripts: Array.isArray(field.externalScripts) ? field.externalScripts : (Array.isArray(pyField.pythonExternalScripts) ? pyField.pythonExternalScripts : []),
							output: '',
							logs: '',
							lastExecuted: ''
						});
						fieldParts.set(pyBox, { getPythonData });
					} else if (field.type === 'parameters') {
						const paramsList: Array<IParameterDefinition & { type?: string }> = Array.isArray(field.parameters) ? field.parameters : [];
						if (paramsList.length === 0) {
							fieldGroup.remove();
						} else {
							const paramBox = append(fieldGroup, $('.parameters-field-container.custom-field-input', {
								'data-field-id': field.id,
								'data-field-label': field.label,
								'data-field-type': field.type,
								style: 'display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(168, 85, 247, 0.25); background: rgba(168, 85, 247, 0.04); border-radius: 8px; padding: 10px 12px;'
							}));
							registerFieldControl(paramBox);
							const paramInputsMap: Record<string, HTMLInputElement | HTMLSelectElement> = {};
							for (const p of paramsList) {
								const pKey = (p.name || p.id || '').trim();
								if (!pKey) { continue; }
								const pRow = append(paramBox, $('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }));
								const pLabelRow = append(pRow, $('div', { style: 'display: flex; align-items: center; gap: 6px;' }));
								append(pLabelRow, $('label', { style: 'font-size: 11px; opacity: 0.9; font-weight: 600; color: #c084fc; font-family: var(--vscode-editor-font-family, monospace);' }, `${pKey}:`));
								append(pLabelRow, $('span', {
									style: 'font-size: 9.5px; font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; color: #c084fc; background: rgba(168, 85, 247, 0.14); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 3px; padding: 1px 5px;'
								}, `{{${pKey}}}`));

								const defaultValStr = p.defaultValue !== undefined && p.defaultValue !== null ? String(p.defaultValue) : '';
								if (Array.isArray(p.options) && p.options.length > 0) {
									const pSelect = append(pRow, $('select.monaco-select', {
										style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; cursor: pointer;'
									})) as HTMLSelectElement;
									for (const opt of p.options) {
										const optEl = append(pSelect, $('option', { value: String(opt) }, String(opt))) as HTMLOptionElement;
										if (String(opt) === defaultValStr) {
											optEl.selected = true;
										}
									}
									paramInputsMap[pKey] = pSelect;
								} else {
									const pInput = append(pRow, $('input.monaco-inputbox', {
										type: p.type === 'number' ? 'number' : 'text',
										placeholder: defaultValStr ? `Default: ${defaultValStr}` : `Enter ${pKey}...`,
										value: defaultValStr,
										style: 'width: 100%; padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);'
									})) as HTMLInputElement;
									paramInputsMap[pKey] = pInput;
								}
							}
							const getParametersData = () => {
								const obj: Record<string, unknown> = {};
								for (const [k, inp] of Object.entries(paramInputsMap)) {
									const raw = inp.value;
									const defVal = paramsList.find(p => (p.name || p.id) === k)?.defaultValue;
									const isNonEmpty = raw !== undefined && raw !== null && String(raw).trim() !== '';
									obj[k] = isNonEmpty ? raw : (defVal !== undefined && defVal !== null && String(defVal).trim() !== '' ? defVal : raw);
								}
								return obj;
							};
							fieldParts.set(paramBox, { getParametersData });
						}
					} else if (field.type === 'git' || field.type === 'shell' || field.type === 'output' || field.type === 'table') {
						// Git primitive is managed via gitBox above; Shell is set up on the ticket card (CI-55); Output manifest & Data Table are hydrated from schema
						fieldGroup.remove();
					} else {
						registerFieldControl(append(fieldGroup, $('input.monaco-inputbox.custom-field-input', {
							type: 'text',
							'data-field-id': field.id,
							'data-field-label': field.label,
							'data-field-type': field.type,
							style: 'width: 100%; padding: 7px 12px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box;'
						})));
					}
				}
				if (customFieldsBox.children.length === 0) {
					customFieldsBox.style.display = 'none';
				}
			} else {
				clearNode(customFieldsBox);
				customFieldControls = [];
				customFieldsBox.style.display = 'none';
			}

			await updateValidation();
		};

		// Initial render and refresh
		initLocationSelector().then(() => renderTypeGrid()).then(() => {
			refreshNameAndBadge();
		});

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

			const gitRepoUrl = gitRemoteInput.value.trim();
			const originalBtnHtml = submitBtn.innerHTML;
			const btn = submitBtn as HTMLButtonElement;
			if (gitRepoUrl) {
				btn.disabled = true;
				btn.style.opacity = '0.7';
				btn.textContent = 'Cloning Git Repository & Initializing...';
			}

			try {
				const selectedOpt = agentSelect.options[agentSelect.selectedIndex];
				const assignedAgentId = agentSelect.value || undefined;
				const assignedAgentName = (assignedAgentId && selectedOpt) ? (selectedOpt.getAttribute('data-name') || selectedOpt.text.replace(/^\uD83E\uDD16\s*/, '').replace(/\s*\(.*\)$/, '')) : undefined;

				const agentModelOpt: ICreateResourceOptions['agentModel'] = undefined;

				let initialStatusOverride = '';
				const customModules = await this._getCustomModules(targetUri);
				const matchingModule = isFreestyleTicketType(selectedType) ? undefined : customModules.find((m: ICustomModule) => m.id === selectedType || m.name?.toLowerCase() === selectedType.toLowerCase());

				const customMetadata: { [key: string]: string } = {};

				// 1. Pre-populate full template defaults for ALL schema components so no component configuration or code is ever lost
				if (matchingModule && Array.isArray(matchingModule.fields)) {
					for (const f of matchingModule.fields) {
						const fKey = f.label || f.id;
						if (!fKey || f.id === 'title' || f.label?.toLowerCase() === 'title' || f.id === 'description' || f.label?.toLowerCase() === 'description') {
							continue;
						}
						if (f.type === 'parameters' && Array.isArray(f.parameters)) {
							const paramObj: Record<string, unknown> = {};
							for (const p of f.parameters) {
								const pKey = p.name || p.id;
								if (pKey) { paramObj[pKey] = (p.defaultValue !== undefined && p.defaultValue !== null && String(p.defaultValue).trim() !== '') ? p.defaultValue : ''; }
							}
							customMetadata[fKey] = JSON.stringify(paramObj);
						} else if (f.type === 'python') {
							const pyF: ILegacyPythonField = f;
							const codeVal = pyF.pythonCode || pyF.code || f.defaultContent || '';
							customMetadata[fKey] = JSON.stringify({
								code: String(codeVal),
								pythonPath: pyF.pythonPath || '',
								pythonEnvMode: pyF.pythonEnvMode || 'existing',
								pythonLocked: Boolean(pyF.pythonLocked),
								externalScripts: Array.isArray(f.externalScripts) ? f.externalScripts : (Array.isArray(pyF.pythonExternalScripts) ? pyF.pythonExternalScripts : []),
								output: '',
								logs: '',
								lastExecuted: ''
							});
						} else if (f.type === 'http_request') {
							customMetadata[fKey] = JSON.stringify(buildHttpTicketValue(f));
						} else if (f.type === 'table') {
							customMetadata[fKey] = JSON.stringify({
								columns: Array.isArray(f.tableColumns) ? f.tableColumns : [],
								rows: Array.isArray(f.tableRows) ? f.tableRows : [],
								dbEngine: f.tableDbEngine || 'sqlite',
								dbPath: f.tableDbPath || '',
								tableName: f.tableDbTableName || fKey.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
								autoSyncDb: Boolean(f.tableAutoSyncDb),
								sqlQuery: f.tableSqlQuery || '',
								sqlOutput: f.debugSqlOutput || ''
							});
						} else if (f.type === 'browser') {
							// The template's credentials are not copied: runs always use the template's
							customMetadata[fKey] = JSON.stringify({
								url: f.defaultUrl || '',
								credentials: [],
								content: f.defaultContent || '',
								lastFetched: ''
							});
						} else if (f.type === 'prompt') {
							customMetadata[fKey] = JSON.stringify({
								targetMode: f.targetMode || 'model',
								targetProvider: f.targetProvider || (f.targetModel ? 'gemini' : resolveDefaultModel({ providerId: 'gemini', modelId: 'gemini-2.5-flash' }).providerId),
								targetModel: f.targetModel || resolveDefaultModelId(f.targetProvider, 'gemini-2.5-flash'),
								targetCredentialId: f.targetCredentialId || '',
								targetAgentId: f.targetAgentId || '',
								targetAgentName: f.targetAgentName || '',
								preInjectedPrompt: f.defaultContent || '',
								promptPreInjectedVisible: !!f.promptPreInjectedVisible,
								userPrompt: f.defaultUserPrompt || '',
								userPrompts: Array.isArray(f.defaultUserPrompts) ? f.defaultUserPrompts : (f.defaultUserPrompt ? [f.defaultUserPrompt] : []),
								prompt: f.defaultUserPrompt || f.defaultContent || '',
								output: '',
								lastExecuted: ''
							});
						} else if (f.type === 'tts') {
							customMetadata[fKey] = JSON.stringify({
								text: f.defaultContent || '',
								displayText: f.ttsDisplayText || '',
								ttsShowSpeechTextInTicket: !!f.ttsShowSpeechTextInTicket,
								targetProvider: f.targetProvider || 'gemini',
								targetModel: f.targetModel || 'gemini-2.5-flash-preview-tts',
								targetCredentialId: f.targetCredentialId || '',
								ttsFormat: f.ttsFormat || 'mp3',
								ttsVoice: f.ttsVoice || 'Kore',
								ttsAutoPlay: !!f.ttsAutoPlay
							});
						} else if (f.type === 'media_player') {
							customMetadata[fKey] = JSON.stringify({
								mediaFilePath: f.mediaFilePath || '',
								mediaFileName: f.mediaFileName || '',
								mediaKind: f.mediaKind || 'audio',
								mediaMimeType: f.mediaMimeType || '',
								mediaPlaybackRate: typeof f.mediaPlaybackRate === 'number' ? f.mediaPlaybackRate : 1.0,
								mediaAutoPlay: !!f.mediaAutoPlay
							});
						} else if (f.type === 'voice_note') {
							const clips = Array.isArray(f.voiceClips) ? f.voiceClips : [];
							customMetadata[fKey] = JSON.stringify({
								voiceClips: clips,
								voiceTranscript: f.voiceTranscript || clips.map(c => (c?.transcript || '').trim()).filter(Boolean).join('\n\n'),
								voiceAutoTranscribe: f.voiceAutoTranscribe !== false,
								voicePlaybackRate: typeof f.voicePlaybackRate === 'number' ? f.voicePlaybackRate : 1.0
							});
						} else if (f.type === 'ssh') {
							customMetadata[fKey] = JSON.stringify(buildSshTicketValue(f));
						} else if (f.defaultContent !== undefined && f.defaultContent !== '') {
							customMetadata[fKey] = String(f.defaultContent);
						}
					}
				}

				// 2. Apply interactive overrides from dialog input controls
				const allPendingFieldAttachments: Array<{ name: string; size: number; dataUrl?: string }> = [];
				customFieldControls.forEach(inputEl => {
					const fieldLabel = inputEl.getAttribute('data-field-label');
					const parts = fieldParts.get(inputEl);
					if (fieldLabel) {
						if (isHTMLInputElement(inputEl) && inputEl.getAttribute('data-field-type') === 'number') {
							const numCheck = normalizeNumberFieldValue(numberFieldRulesFromAttributes(n => inputEl.getAttribute(n), fieldLabel), inputEl.value);
							if (!numCheck.ok) {
								throw new Error(numCheck.error);
							}
							customMetadata[fieldLabel] = numCheck.value;
							return;
						}
						if (isHTMLInputElement(inputEl) && inputEl.type === 'checkbox') {
							customMetadata[fieldLabel] = inputEl.checked ? 'true' : 'false';
						} else if (inputEl.classList.contains('multiselect-container')) {
							const checked = (parts?.checkboxes || []).filter(cb => cb.checked).map(cb => cb.value);
							customMetadata[fieldLabel] = checked.join(', ');
						} else if (inputEl.classList.contains('range-container')) {
							const startVal = parts?.rangeStart?.value || '';
							const endVal = parts?.rangeEnd?.value || '';
							if (startVal || endVal) {
								customMetadata[fieldLabel] = `${startVal} ~ ${endVal}`;
							}
						} else if (inputEl.classList.contains('dynamic-list-container')) {
							const itemCards = parts?.listCards || [];
							const items: Array<Record<string, string | number>> = [];
							itemCards.forEach((card, idx) => {
								const itemObj: Record<string, string | number> = { _index: idx + 1 };
								const titleInput = card.titleInput;
								if (titleInput && titleInput.value.trim()) {
									itemObj._title = titleInput.value.trim();
								}
								card.subInputs.forEach(subEl => {
									const subLabel = subEl.getAttribute('data-subfield-label');
									if (subLabel) {
										if (isHTMLInputElement(subEl) && subEl.type === 'checkbox') {
											itemObj[subLabel] = subEl.checked ? 'true' : 'false';
										} else if (subEl.classList.contains('range-container')) {
											const subParts = fieldParts.get(subEl);
											const startVal = subParts?.rangeStart?.value || '';
											const endVal = subParts?.rangeEnd?.value || '';
											itemObj[subLabel] = (startVal || endVal) ? `${startVal} ~ ${endVal}` : '';
										} else {
											itemObj[subLabel] = (subEl as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '';
										}
									}
								});
								items.push(itemObj);
							});
							if (items.length > 0) {
								customMetadata[fieldLabel] = JSON.stringify(items);
							}
						} else if (inputEl.classList.contains('attachment-field-container')) {
							const getFiles = parts?.getAttachedFiles;
							const filesList: Array<{ name: string; size: number; dataUrl?: string }> = getFiles ? getFiles() : [];
							if (filesList.length > 0) {
								customMetadata[fieldLabel] = JSON.stringify(filesList.map(f => ({ name: f.name, size: f.size })));
								filesList.forEach(f => {
									allPendingFieldAttachments.push(f);
								});
							}
						} else if (inputEl.classList.contains('action-buttons-group-row')) {
							const getAction = parts?.getSelectedAction;
							const chosenAction = getAction ? getAction() : '';
							if (chosenAction) {
								customMetadata[fieldLabel] = chosenAction;
							}
							const getTargetStatus = parts?.getSelectedTargetStatus;
							const targetSt = getTargetStatus ? getTargetStatus() : '';
							if (targetSt) {
								initialStatusOverride = targetSt;
							}
						} else if (inputEl.classList.contains('browser-field-container')) {
							const getBData = parts?.getBrowserData;
							const bData = getBData ? getBData() : undefined;
							if (bData && (bData.url || (bData.credentials && bData.credentials.length > 0))) {
								customMetadata[fieldLabel] = JSON.stringify(bData);
							}
						} else if (inputEl.classList.contains('prompt-field-container')) {
							const getPData = parts?.getPromptData;
							const pData = getPData ? getPData() : undefined;
							if (pData) {
								customMetadata[fieldLabel] = JSON.stringify(pData);
							}
						} else if (inputEl.classList.contains('tts-field-container')) {
							const getTData = parts?.getTtsData;
							const tData = getTData ? getTData() : undefined;
							if (tData) {
								customMetadata[fieldLabel] = JSON.stringify(tData);
							}
						} else if (inputEl.classList.contains('python-field-container')) {
							const getPyData = parts?.getPythonData;
							const pyData = getPyData ? getPyData() : undefined;
							if (pyData && pyData.code && pyData.code.trim()) {
								customMetadata[fieldLabel] = JSON.stringify(pyData);
							}
						} else if (inputEl.classList.contains('parameters-field-container')) {
							const getParamsData = parts?.getParametersData;
							const paramsData = getParamsData ? getParamsData() : undefined;
							if (paramsData && Object.keys(paramsData).length > 0) {
								customMetadata[fieldLabel] = JSON.stringify(paramsData);
							}
						} else {
							const rawVal = (inputEl as HTMLInputElement).value;
							if (rawVal !== undefined && String(rawVal).trim() !== '') {
								customMetadata[fieldLabel] = String(rawVal);
							}
						}
					}
				});

				if (matchingModule) {
					// 1. Resolve workspace root URI
					let wsRootUri = targetUri;
					while (wsRootUri.path !== '/' && wsRootUri.path !== '.') {
						if (await this.fileService.exists(URI.joinPath(wsRootUri, '.agents')) ||
							await this.fileService.exists(URI.joinPath(wsRootUri, 'workspace.md')) ||
							await this.fileService.exists(URI.joinPath(wsRootUri, 'ticket.md'))) {
							break;
						}
						const parent = dirname(wsRootUri);
						if (parent.path === wsRootUri.path) { break; }
						wsRootUri = parent;
					}

					// 2. Materialize / sync latest YAML in workspace .agents/entity_type/<type>.yaml
					const localYamlUri = URI.joinPath(wsRootUri, '.agents', 'entity_type', `${selectedType}.yaml`);
					await this._writeYamlFile(localYamlUri, { ...matchingModule, storageScope: 'workspace' });
				}

				const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(targetUri);
				const initialStatus = initialStatusOverride || ((selectedType === 'agent') ? 'idle' : (wsStatuses.statuses[0] || 'Todo'));

				const wsRootUri = await this.workspacesExplorerService.findWorkspaceRootUri(targetUri);
				const isSubEntity = wsRootUri.path !== targetUri.path;

				const createResult = await this.workspacesExplorerService.createResourceUnderWorkspace({
					workspaceUri: wsRootUri,
					targetParentUri: isSubEntity ? targetUri : undefined,
					type: selectedType,
					name,
					title: titleInput.value.trim() || undefined,
					code: codeInput.value.trim() || undefined,
					status: initialStatus,
					priority: selectedPriority,
					assignedAgentId,
					assignedAgentName,
					agentRulePrompt: ruleInput.value.trim() || undefined,
					ticketPrompt: ruleInput.value.trim() || undefined,
					description: descInput.value.trim() || undefined,
					typeDefinition: (!isFreestyleTicketType(selectedType) && typeDefInput.value.trim() && typeDefInput.value.trim() !== 'Built-in (System)' && typeDefInput.value.trim() !== 'None') ? typeDefInput.value.trim() : undefined,
					typePrompt: typePromptInput.value.trim() || undefined,
					linkTo: selectedLinkTickets.length > 0 ? selectedLinkTickets.join(', ') : undefined,
					attachments: undefined,
					agentModel: agentModelOpt,
					agentSystemPrompt: selectedType === 'agent' ? promptInput.value.trim() : undefined,
					gitRepoUrl: gitRepoUrl || undefined,
					gitBranch: gitBranchInput.value.trim() || undefined,
					customMetadata,
					// This dialog is the only place where Freestyle tickets may be created
					allowFreestyle: isFreestyleTicketType(selectedType)
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

				if (allPendingFieldAttachments.length > 0) {
					try {
						const attachmentsDir = URI.joinPath(createdFolderUri, 'attachments');
						if (!(await this.fileService.exists(attachmentsDir))) {
							await this.fileService.createFolder(attachmentsDir);
						}
						for (const pFile of allPendingFieldAttachments) {
							if (pFile.dataUrl) {
								const base64Data = pFile.dataUrl.split(',')[1] || '';
								if (base64Data) {
									const binaryString = atob(base64Data);
									const bytes = new Uint8Array(binaryString.length);
									for (let i = 0; i < binaryString.length; i++) {
										bytes[i] = binaryString.charCodeAt(i);
									}
									const buf = VSBuffer.wrap(bytes);
									const targetFileUri = URI.joinPath(attachmentsDir, pFile.name);
									await this.fileService.writeFile(targetFileUri, buf);
								}
							}
						}
					} catch (attErr) {
						console.warn('Failed to save some field attachments:', attErr);
					}
				}

				const isCustomEntity = selectedType !== 'file' && selectedType !== 'folder';
				if (isCustomEntity) {
					if (selectedType === 'workflow') {
						await this.editorService.openEditor(new WorkflowEditorInput(createdUri, name), { pinned: true });
					} else {
						const detailInput = new EntityDetailEditorInput(createdUri, name);
						// A new Freestyle ticket has no components yet: open it with the component toolbox shown
						detailInput.openComponentToolbox = isFreestyleTicketType(selectedType) && !createResult.alreadyExists;
						await this.editorService.openEditor(detailInput, { pinned: true });
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
				btn.disabled = false;
				btn.style.opacity = '1';
				btn.innerHTML = originalBtnHtml;
				this.notificationService.error(`Failed to create entity: ${(err as Error | undefined)?.message || err}`);
			}
		};
	}

	private async _readYamlFile(uri: URI): Promise<unknown> {
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
			if (parent.path === curr.path) { break; }
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

	private async _writeYamlFile(uri: URI, data: unknown): Promise<void> {
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
		return getAnyAgentGlobalFolders(this._storageService, this.environmentService.userHome).entityType;
	}

	private async _getCustomModules(workspaceUri: URI): Promise<ICustomModule[]> {
		try {
			return await this.customModulesService.getCustomModules(workspaceUri);
		} catch (e) {
			console.error('Error in _getCustomModules via customModulesService:', e);
			return [];
		}
	}

	private async _openCustomModulesManager(targetUri: URI, onUpdate: () => void): Promise<void> {
		try {
			await this.commandService.executeCommand('workbench.action.customModules.openManager', {
				workspaceUri: targetUri,
				onUpdate
			});
		} catch (e) {
			console.error('Failed to open custom modules manager:', e);
		}
	}

	private async _resolveFileUri(baseUri: URI, name: string): Promise<URI> {
		const agentsDir = URI.joinPath(baseUri, '.agents');
		const pathInAgents = URI.joinPath(agentsDir, name);
		if (await this.fileService.exists(pathInAgents)) {
			return pathInAgents;
		}
		const pathInRoot = URI.joinPath(baseUri, name);
		if (await this.fileService.exists(pathInRoot)) {
			return pathInRoot;
		}
		return pathInAgents;
	}

	/** Reads a file; ticket files with their field references resolved (CI-51). */
	private async _safeReadFile(uri: URI | undefined): Promise<string> {
		if (uri && await this.fileService.exists(uri)) {
			try {
				return await readTicketFileResolved(this.fileService, uri);
			} catch { }
		}
		return '';
	}

	private _parseMetadata(content: string): { [key: string]: string } {
		const metadata: { [key: string]: string } = {};
		const lines = (content || '').split(/\r?\n/);
		for (const line of lines) {
			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match) {
				const key = match[1].trim();
				const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				metadata[key] = val;
			}
		}
		return metadata;
	}

	private _extractEntityTitleAndSummary(meta: { [key: string]: string }, readmeContent: string, fallbackName: string): { title: string; summary: string } {
		let title = meta['Title'] || meta['Entity Name'] || '';
		let summary = meta['Description'] || meta['Summary'] || '';

		if (!summary && readmeContent) {
			const lines = readmeContent.split(/\r?\n/);
			for (const line of lines) {
				const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)$/i);
				if (descMatch && descMatch[1].trim() && descMatch[1].trim() !== 'None') {
					summary = descMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					break;
				}
			}
			if (!summary) {
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.startsWith('`') && !trimmed.startsWith('---')) {
						summary = trimmed;
						break;
					}
				}
			}
		}

		if (!title || title === fallbackName || title === meta['Ticket ID']) {
			if (summary) {
				title = summary;
				summary = '';
			} else {
				title = fallbackName.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			}
		}

		if (summary.length > 80) {
			summary = summary.substring(0, 77) + '...';
		}

		return { title, summary };
	}

	private async _loadAllAvailableTickets(): Promise<Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }>> {
		const result: Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }> = [];
		try {
			const workspaces = await this.workspacesExplorerService.getWorkspaces();

			for (const ws of workspaces) {
				const wsTargetBase = ws.uri.path.endsWith('.code-workspace') ? dirname(ws.uri) : ws.uri;
				const wsName = ws.name || wsTargetBase.path.split('/').filter(Boolean).pop() || 'Workspace';

				// 1. Check workspace root ticket
				const wsTicketUri = await this._resolveFileUri(wsTargetBase, 'ticket.md');
				const wsReadmeUri = await this._resolveFileUri(wsTargetBase, 'README.md');
				if (wsTicketUri && (await this.fileService.exists(wsTicketUri))) {
					const content = await this._safeReadFile(wsTicketUri);
					const readmeContent = await this._safeReadFile(wsReadmeUri);
					const meta = this._parseMetadata(content);
					const tId = meta['Ticket ID'] || meta['Entity ID'] || ws.name;
					const rawCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'];
					const tCode = (rawCode && rawCode !== 'None') ? rawCode : tId;
					const { title: tTitle, summary: tSummary } = this._extractEntityTitleAndSummary(meta, readmeContent, ws.name);
					const tType = meta['Ticket Type'] || meta['Entity Type'] || 'workspace';
					if (tId && !result.some(r => r.id === tId)) {
						result.push({
							id: tId,
							code: tCode,
							title: tTitle,
							summary: tSummary,
							type: tType,
							workspaceId: meta['Workspace ID'] || ws.name,
							workspaceName: wsName,
							uri: wsTargetBase.toString()
						});
					}
				}

				// 2. Scan children of workspace
				const children = await this.workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'file') { continue; }
					const childTicketUri = await this._resolveFileUri(child.uri, 'ticket.md');
					const childReadmeUri = await this._resolveFileUri(child.uri, 'README.md');
					if (childTicketUri && (await this.fileService.exists(childTicketUri))) {
						const content = await this._safeReadFile(childTicketUri);
						const readmeContent = await this._safeReadFile(childReadmeUri);
						const meta = this._parseMetadata(content);
						const tId = meta['Ticket ID'] || meta['Entity ID'] || child.name;
						const rawCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'];
						const tCode = (rawCode && rawCode !== 'None') ? rawCode : tId;
						const { title: tTitle, summary: tSummary } = this._extractEntityTitleAndSummary(meta, readmeContent, child.name);
						const tType = meta['Ticket Type'] || meta['Entity Type'] || child.type || 'task';
						if (tId && !result.some(r => r.id === tId)) {
							result.push({
								id: tId,
								code: tCode,
								title: tTitle,
								summary: tSummary,
								type: tType,
								workspaceId: meta['Workspace ID'] || ws.name,
								workspaceName: wsName,
								uri: child.uri.toString()
							});
						}
					}
				}
			}
		} catch (err) {
			console.error('Failed to load available tickets for linking:', err);
		}
		return result;
	}
}

