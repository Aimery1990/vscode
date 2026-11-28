/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, getActiveElement } from '../../../../base/browser/dom.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, isEqualOrParent } from '../../../../base/common/resources.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import { openSubWorkflowTicketCanvas } from '../../workflowsManager/browser/subWorkflowLiveView.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import {
	BoardTestResult, buildTicketBoard, classifyBoardTestResult, cleanAgentName, collectBoardLabels, countSubtasks, describeBoardCardMeta, describeBoardPriority,
	filterBoardCards, IBoardGroup, IBoardStatusColumn, isBoardFilterActive, ITicketBoard, OTHER_BOARD_GROUP, parseBoardModeKeys, pluralize, TicketPageMode, updateBoardModeKeys
} from '../common/ticketBoardModel.js';
import { readTestResultField } from '../common/ticketFailure.js';
import { getLabelColor, ITicketLabelDefinition } from '../common/ticketLabels.js';
import { findStatusOption, findTemplateForType, resolveEffectiveStatusOptions } from '../common/ticketStatusPicker.js';
import { readTicketLabels, readTicketStatus, readTopLevelMetadata } from '../common/workspaceLifecycle.js';
import { CanonicalStatusCategory, IWorkspaceStatusesInfo, IWorkspacesExplorerService, WORKSPACE_PANE_VIEW_ID } from '../common/workspacesExplorer.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { openWorkspaceLifecycleDialog } from './workspaceLifecycleEditor.js';

/**
 * Board (kanban) mode of the ticket page (UI-25): the ticket's direct child tickets grouped by category and status.
 *
 * The ticket page owns one controller: it puts {@link createToggleButton} in its action bar and calls {@link mount}
 * after each render with the details layout element; the controller adds its own host next to it and, in Board mode,
 * hides the details layout and the page header (the board draws its own header). The mode is remembered per ticket.
 *
 * Logic (data, filters, refresh, drag and drop, create, open) lives in the controller; everything visual is in
 * {@link renderTicketBoard} and {@link TICKET_BOARD_CSS} so the look can be replaced on its own.
 */

/** One card of the board. */
export interface ITicketBoardCard {
	readonly uri: URI;
	readonly ticketId: string;
	readonly title?: string;
	readonly type?: string;
	readonly status?: string;
	readonly removed: boolean;
	readonly priority?: string;
	readonly labels: readonly string[];
	readonly subtasks: { readonly done: number; readonly total: number };
	readonly failure?: { readonly reasons: readonly string[] };
	readonly testResult?: BoardTestResult;
	/** "Current AI Agent" of the ticket, when set. */
	readonly agent?: string;
}

/** The opened ticket itself (board header). */
export interface ITicketBoardParent {
	readonly ticketId: string;
	readonly title: string;
	readonly status?: string;
	readonly category?: CanonicalStatusCategory;
	/** Workspace name, then the ancestors' IDs, then the ticket ID. */
	readonly breadcrumb: readonly string[];
}

const BOARD_MODE_STORAGE_KEY = 'anyagent.ticketPage.boardModeTickets';
const CARD_DRAG_MIME = 'application/vnd.anyagent.ticket-board-card';
const REFRESH_DEBOUNCE_MS = 300;

/** The Workspaces tree view (structural: avoids importing the pane). */
interface ICreateResourceHost {
	showCreateResourceModal?(target: URI, parentName?: string, onSuccess?: (type: string, name: string) => void): void;
}

export class TicketBoardController extends Disposable {

	private _ticketUri: URI | undefined;
	private _enabled = false;
	private _mode: TicketPageMode = 'details';
	private _showRemoved = false;
	private _showEmptyStatuses = true;
	private _query = '';
	private _labelFilter: string[] = [];
	private readonly _collapsed = new Set<string>();
	private _toggleBtn: HTMLButtonElement | undefined;
	private _detailsEl: HTMLElement | undefined;
	private _pageHeaderEl: HTMLElement | undefined;
	private readonly _host: HTMLElement;
	private _cards: readonly ITicketBoardCard[] | undefined;
	private _parent: ITicketBoardParent | undefined;
	private _statuses: IWorkspaceStatusesInfo | undefined;
	private _loadSeq = 0;
	private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** The card being dragged on this board (drops from anywhere else are ignored). */
	private _dragCard: ITicketBoardCard | undefined;

	constructor(
		@IWorkspacesExplorerService private readonly _workspacesExplorerService: IWorkspacesExplorerService,
		@IFileService private readonly _fileService: IFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICustomModulesService private readonly _customModulesService: ICustomModulesService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IViewsService private readonly _viewsService: IViewsService
	) {
		super();
		this._host = $('div.ticket-board-host');
		this._host.style.display = 'none';
		this._register(this._workspacesExplorerService.onDidChangeWorkspaces(() => this._scheduleRefresh()));
		this._register(toDisposable(() => {
			if (this._refreshTimer) {
				clearTimeout(this._refreshTimer);
			}
			this._host.remove();
		}));
	}

	// ---------------------------------------------------------------------------------------------------------
	// Ticket page integration
	// ---------------------------------------------------------------------------------------------------------

	/** The Details / Board toggle of the page's action bar (a new one per page render). */
	createToggleButton(): HTMLButtonElement {
		const btn = $<HTMLButtonElement>('button.btn-secondary.ticket-board-toggle-btn', { type: 'button' });
		// same 28px square as the other icon-only buttons of the ticket page action bar (UI-26)
		btn.style.cssText = 'display: none; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 0; border-radius: 6px; cursor: pointer;';
		btn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			this._setMode(this._mode === 'board' ? 'details' : 'board');
		});
		this._toggleBtn = btn;
		// shown by mount() once the page knows it has a board (previews never call it)
		this._enabled = false;
		this._syncToggle();
		return btn;
	}

	/**
	 * Called after each page render. `detailsEl` is the page's details layout (hidden in Board mode); the board is
	 * put right after it. `enabled` is false for pages without a board (preview, workflow node, agent).
	 */
	mount(detailsEl: HTMLElement | undefined, ticketUri: URI | undefined, enabled: boolean): void {
		const changedTicket = ticketUri?.toString() !== this._ticketUri?.toString();
		this._ticketUri = ticketUri;
		this._enabled = enabled && !!ticketUri && !!detailsEl;
		this._detailsEl = detailsEl;
		// the page header (breadcrumb, title, action bar) is the element right before the details layout
		const header = detailsEl?.previousElementSibling as HTMLElement | null | undefined;
		this._pageHeaderEl = header?.firstElementChild?.firstElementChild?.classList.contains('header-breadcrumb') ? header : undefined;
		if (changedTicket) {
			this._cards = undefined;
			this._parent = undefined;
			this._statuses = undefined;
			this._query = '';
			this._labelFilter = [];
			this._collapsed.clear();
			this._loadSeq++;
		}
		if (!this._enabled || !detailsEl) {
			this._mode = 'details';
			this._host.remove();
			this._syncToggle();
			return;
		}
		detailsEl.after(this._host);
		this._mode = this._readRememberedMode();
		this._apply();
		if (this._mode === 'board') {
			this._render();
			this._load();
		}
	}

	/** The page lost its input. */
	clear(): void {
		this._ticketUri = undefined;
		this._enabled = false;
		this._cards = undefined;
		this._parent = undefined;
		this._statuses = undefined;
		this._loadSeq++;
		clearNode(this._host);
		this._host.remove();
	}

	private _setMode(mode: TicketPageMode): void {
		if (!this._enabled || !this._ticketUri) {
			return;
		}
		this._mode = mode;
		this._rememberMode(mode);
		this._apply();
		if (mode === 'board') {
			this._render();
			this._load();
		}
	}

	private _apply(): void {
		const board = this._enabled && this._mode === 'board';
		if (this._detailsEl) {
			this._detailsEl.style.display = board ? 'none' : '';
		}
		if (this._pageHeaderEl) {
			this._pageHeaderEl.style.display = board ? 'none' : '';
		}
		this._host.style.display = board ? '' : 'none';
		this._syncToggle();
	}

	private _syncToggle(): void {
		const btn = this._toggleBtn;
		if (!btn) {
			return;
		}
		btn.style.display = this._enabled ? 'inline-flex' : 'none';
		const board = this._mode === 'board';
		clearNode(btn);
		append(btn, $('span', { class: ThemeIcon.asClassName(board ? Codicon.layoutPanelLeft : Codicon.project), style: 'font-size: 14px;' }));
		btn.title = board ? 'Switch to Details view' : 'Switch to Board view (child tickets by status)';
		btn.setAttribute('aria-label', btn.title);
		btn.setAttribute('aria-pressed', board ? 'true' : 'false');
	}

	// ---------------------------------------------------------------------------------------------------------
	// Remembered mode (per ticket, workspace storage, per user)
	// ---------------------------------------------------------------------------------------------------------

	private _storageKey(): string {
		const email = this._workspacesExplorerService.getActiveUserEmail();
		return email ? `${BOARD_MODE_STORAGE_KEY}:${email}` : BOARD_MODE_STORAGE_KEY;
	}

	private _readRememberedMode(): TicketPageMode {
		if (!this._ticketUri) {
			return 'details';
		}
		const keys = parseBoardModeKeys(this._storageService.get(this._storageKey(), StorageScope.WORKSPACE));
		return keys.includes(this._ticketUri.toString()) ? 'board' : 'details';
	}

	private _rememberMode(mode: TicketPageMode): void {
		if (!this._ticketUri) {
			return;
		}
		const key = this._storageKey();
		const keys = updateBoardModeKeys(parseBoardModeKeys(this._storageService.get(key, StorageScope.WORKSPACE)), this._ticketUri.toString(), mode);
		this._storageService.store(key, JSON.stringify(keys), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	// ---------------------------------------------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------------------------------------------

	private _scheduleRefresh(): void {
		if (!this._enabled || this._mode !== 'board') {
			return;
		}
		if (this._refreshTimer) {
			clearTimeout(this._refreshTimer);
		}
		this._refreshTimer = setTimeout(() => {
			this._refreshTimer = undefined;
			this._load();
		}, REFRESH_DEBOUNCE_MS);
	}

	private async _load(): Promise<void> {
		const ticketUri = this._ticketUri;
		if (!ticketUri) {
			return;
		}
		const seq = ++this._loadSeq;
		try {
			const [statuses, summary, parent] = await Promise.all([
				this._workspacesExplorerService.getWorkspaceStatuses(ticketUri),
				this._workspacesExplorerService.getTicketSubtreeSummary(ticketUri),
				this._loadParent(ticketUri)
			]);
			const cards = await Promise.all(summary.children.filter(n => !!n.resource).map(async (node): Promise<ITicketBoardCard> => {
				const uri = node.resource!;
				const text = await this._readTicketHead(uri);
				const result = text !== undefined ? readTestResultField(text) : undefined;
				return {
					uri,
					ticketId: node.ticketId || basename(uri),
					title: node.title,
					type: node.type,
					status: node.status,
					removed: node.removed,
					priority: text !== undefined ? readTopLevelMetadata(text, 'Priority') : undefined,
					labels: text !== undefined ? readTicketLabels(text) : [],
					subtasks: countSubtasks(node.children),
					failure: node.failure,
					testResult: result ? classifyBoardTestResult(result.value) : undefined,
					agent: text !== undefined ? cleanAgentName(readTopLevelMetadata(text, 'Current AI Agent')) : undefined
				};
			}));
			if (seq !== this._loadSeq || ticketUri !== this._ticketUri) {
				return;
			}
			this._statuses = statuses;
			this._cards = cards;
			this._parent = { ...parent, category: parent.status ? statuses.getCategory(parent.status) : undefined };
			this._render();
		} catch (err) {
			console.error('[TicketBoard] Failed to load child tickets:', err);
			if (seq === this._loadSeq) {
				this._cards = [];
				this._render(String((err as Error)?.message ?? err));
			}
		}
	}

	private async _loadParent(ticketUri: URI): Promise<Omit<ITicketBoardParent, 'category'>> {
		const text = await this._readTicketHead(ticketUri);
		const snapshot = this._workspacesExplorerService.getMetadataSnapshot(ticketUri);
		const ticketId = (text !== undefined ? readTopLevelMetadata(text, 'Ticket ID') : undefined) || snapshot?.ticketId || basename(ticketUri);
		let title = (text !== undefined ? readTopLevelMetadata(text, 'Title') : undefined) || snapshot?.title;
		if (!title) {
			// older tickets keep the title in README.md
			const readme = await this._readHead([URI.joinPath(ticketUri, '.agents', 'README.md'), URI.joinPath(ticketUri, 'README.md')]);
			title = readme !== undefined ? readTopLevelMetadata(readme, 'Title') : undefined;
		}
		title = title && title.toLowerCase() !== 'none' ? title : ticketId;
		const breadcrumb: string[] = [];
		try {
			const root = await this._workspacesExplorerService.findWorkspaceRootUri(ticketUri);
			if (isEqualOrParent(ticketUri, root) && root.toString() !== ticketUri.toString()) {
				const rootSnap = this._workspacesExplorerService.getMetadataSnapshot(root);
				breadcrumb.push(rootSnap?.title || rootSnap?.entityName || basename(root));
				const rel = ticketUri.path.slice(root.path.length).split('/').filter(s => !!s);
				let current = root;
				for (const seg of rel.slice(0, -1)) {
					current = URI.joinPath(current, seg);
					breadcrumb.push(this._workspacesExplorerService.getMetadataSnapshot(current)?.ticketId || seg);
				}
			}
		} catch {
			// no workspace root: just the ticket
		}
		breadcrumb.push(ticketId);
		return { ticketId, title, status: text !== undefined ? readTicketStatus(text) : undefined, breadcrumb };
	}

	private _readTicketHead(ticketUri: URI): Promise<string | undefined> {
		return this._readHead([URI.joinPath(ticketUri, '.agents', 'ticket.md'), URI.joinPath(ticketUri, 'ticket.md')]);
	}

	private async _readHead(uris: readonly URI[]): Promise<string | undefined> {
		for (const uri of uris) {
			try {
				return (await this._fileService.readFile(uri, { length: 16384 })).value.toString();
			} catch {
				// try the next location
			}
		}
		return undefined;
	}

	// ---------------------------------------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------------------------------------

	private async _openCard(card: ITicketBoardCard): Promise<void> {
		const name = basename(card.uri);
		const type = (card.type || '').toLowerCase();
		if (type === 'workflow') {
			await this._editorService.openEditor(new WorkflowEditorInput(card.uri, name), { pinned: true });
		} else if (isSubWorkflowTicketType(card.type)) {
			await openSubWorkflowTicketCanvas(this._editorService, card.uri, name);
		} else {
			await this._editorService.openEditor(new EntityDetailEditorInput(card.uri, name), { pinned: true });
		}
	}

	/** The status a card may take (the same effective lifecycle as the tree's Set Status, UI-18), or undefined. */
	private async _matchStatus(type: string | undefined, status: string): Promise<string | undefined> {
		if (!this._statuses) {
			return undefined;
		}
		let templates: Awaited<ReturnType<ICustomModulesService['getCustomModules']>> = [];
		try {
			templates = await this._customModulesService.getCustomModules(this._ticketUri);
		} catch {
			// no templates: the workspace lifecycle applies
		}
		return findStatusOption(resolveEffectiveStatusOptions(findTemplateForType(templates, type)?.statuses, this._statuses).options, status)?.status;
	}

	/** Drop on a status column: the same "Set Status" path as the tree (UI-18), recorded as User (CI-50). */
	private async _moveCard(card: ITicketBoardCard, column: IBoardStatusColumn<ITicketBoardCard>): Promise<void> {
		if (!column.droppable || (card.status ?? '').trim().toLowerCase() === column.status.toLowerCase()) {
			return;
		}
		const match = await this._matchStatus(card.type, column.status);
		if (!match) {
			this._notificationService.warn(`'${column.status}' is not a status of ${card.ticketId} (its template defines its own statuses).`);
			return;
		}
		try {
			await this._workspacesExplorerService.setEntityStatus(card.uri, match, 'User');
		} catch (err) {
			this._notificationService.error(`Failed to set the status of ${card.ticketId}: ${String((err as Error)?.message ?? err)}`);
			return;
		}
		// show the move right away; the file watcher refresh confirms it
		if (this._cards) {
			this._cards = this._cards.map(c => c === card ? { ...c, status: match } : c);
			this._render();
		}
		this._scheduleRefresh();
	}

	/** Opens the tree's create dialog for a direct child; with `status`, the new child then gets that status. */
	private async _createChild(status?: string): Promise<void> {
		const parentUri = this._ticketUri;
		if (!parentUri) {
			return;
		}
		let view = this._viewsService.getViewWithId(WORKSPACE_PANE_VIEW_ID) as ICreateResourceHost | null;
		if (!view) {
			view = await this._viewsService.openView(WORKSPACE_PANE_VIEW_ID, false) as ICreateResourceHost | null;
		}
		if (!view || typeof view.showCreateResourceModal !== 'function') {
			this._notificationService.warn('Open the Workspaces view to create a ticket.');
			return;
		}
		const before = new Set((this._cards ?? []).map(c => c.uri.toString()));
		view.showCreateResourceModal(parentUri, this._parent?.ticketId ?? basename(parentUri), () => {
			if (status) {
				this._applyStatusToNewChild(parentUri, before, status);
			} else {
				this._scheduleRefresh();
			}
		});
	}

	private async _applyStatusToNewChild(parentUri: URI, before: ReadonlySet<string>, status: string): Promise<void> {
		for (let attempt = 0; attempt < 10; attempt++) {
			const summary = await this._workspacesExplorerService.getTicketSubtreeSummary(parentUri);
			const created = summary.children.find(n => n.resource && !before.has(n.resource.toString()));
			if (created?.resource) {
				const match = await this._matchStatus(created.type, status);
				if (!match) {
					this._notificationService.warn(`'${status}' is not a status of ${created.ticketId ?? basename(created.resource)}; it keeps its initial status.`);
				} else if ((created.status ?? '').trim().toLowerCase() !== match.toLowerCase()) {
					await this._workspacesExplorerService.setEntityStatus(created.resource, match, 'User');
				}
				this._scheduleRefresh();
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 400));
		}
		this._scheduleRefresh();
	}

	private async _openStatusMapping(anchor: HTMLElement): Promise<void> {
		if (!this._ticketUri) {
			return;
		}
		const wsRoot = await this._workspacesExplorerService.findWorkspaceRootUri(this._ticketUri);
		await openWorkspaceLifecycleDialog({
			workspacesExplorerService: this._workspacesExplorerService,
			notificationService: this._notificationService,
			workspaceUri: wsRoot,
			workspaceName: this._parent?.breadcrumb[0] ?? basename(wsRoot),
			onSaved: () => this._scheduleRefresh(),
			anchor
		});
	}

	private _showMenu(anchor: HTMLElement, actions: IAction[]): void {
		this._contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	// ---------------------------------------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------------------------------------

	private _render(error?: string): void {
		const statuses = this._statuses;
		const all = this._cards;
		const filter = { query: this._query, labels: this._labelFilter };
		const cards = all ? filterBoardCards(all, filter) : undefined;
		const board = statuses && cards ? buildTicketBoard(cards, statuses, { showRemoved: this._showRemoved, showEmptyStatuses: this._showEmptyStatuses }) : undefined;
		const labelOptions = collectBoardLabels(all ?? [], (statuses?.labels ?? []).map(l => l.name));
		renderTicketBoard(this._host, {
			board,
			error,
			parent: this._parent,
			totalChildren: all?.length,
			filterActive: isBoardFilterActive(filter),
			query: this._query,
			labelFilter: this._labelFilter,
			customStatusCount: statuses?.statuses.length ?? 0,
			collapsed: this._collapsed,
			labelDefs: statuses?.labels ?? [],
			isDragging: () => !!this._dragCard,
			onShowDetails: () => this._setMode('details'),
			onQuery: query => {
				this._query = query;
				this._render();
			},
			onLabelsMenu: anchor => this._showMenu(anchor, [
				...labelOptions.map(name => toAction({
					id: `board.label.${name}`,
					label: name,
					checked: this._labelFilter.some(l => l.toLowerCase() === name.toLowerCase()),
					run: () => {
						const has = this._labelFilter.some(l => l.toLowerCase() === name.toLowerCase());
						this._labelFilter = has ? this._labelFilter.filter(l => l.toLowerCase() !== name.toLowerCase()) : [...this._labelFilter, name];
						this._render();
					}
				})),
				...(labelOptions.length === 0 ? [toAction({ id: 'board.label.none', label: 'No labels', enabled: false, run: () => { } })] : []),
				...(this._labelFilter.length > 0 ? [new Separator(), toAction({ id: 'board.label.clear', label: 'Clear label filter', run: () => { this._labelFilter = []; this._render(); } })] : [])
			]),
			onViewOptions: anchor => this._showMenu(anchor, [
				toAction({ id: 'board.showRemoved', label: 'Show Removed', checked: this._showRemoved, run: () => { this._showRemoved = !this._showRemoved; this._render(); } }),
				toAction({ id: 'board.showEmpty', label: 'Show empty statuses', checked: this._showEmptyStatuses, run: () => { this._showEmptyStatuses = !this._showEmptyStatuses; this._render(); } })
			]),
			onStatusMapping: anchor => this._openStatusMapping(anchor),
			onCreate: status => this._createChild(status),
			onColumnMenu: (anchor, column) => this._showMenu(anchor, [
				...(column.droppable ? [toAction({ id: 'board.column.create', label: 'Create ticket here', run: () => this._createChild(column.status) })] : []),
				toAction({
					id: 'board.column.collapse',
					label: this._collapsed.has(column.status) ? 'Expand column' : 'Collapse column',
					run: () => {
						if (!this._collapsed.delete(column.status)) {
							this._collapsed.add(column.status);
						}
						this._render();
					}
				}),
				new Separator(),
				toAction({ id: 'board.column.mapping', label: 'Open status mapping', run: () => this._openStatusMapping(anchor) })
			]),
			onOpen: card => this._openCard(card),
			onDragStart: card => { this._dragCard = card; },
			onDragEnd: () => { this._dragCard = undefined; },
			onDrop: column => {
				const card = this._dragCard;
				this._dragCard = undefined;
				if (card) {
					this._moveCard(card, column);
				}
			}
		});
	}
}

// =============================================================================================================
// Visual layer (layout + styles only). Restyle here; the controller above does not depend on the markup.
// =============================================================================================================

export interface ITicketBoardRenderOptions {
	readonly board: ITicketBoard<ITicketBoardCard> | undefined;
	readonly error?: string;
	readonly parent: ITicketBoardParent | undefined;
	/** All direct children before filters (undefined while loading). */
	readonly totalChildren: number | undefined;
	readonly filterActive: boolean;
	readonly query: string;
	readonly labelFilter: readonly string[];
	readonly customStatusCount: number;
	readonly collapsed: ReadonlySet<string>;
	readonly labelDefs: readonly ITicketLabelDefinition[];
	isDragging(): boolean;
	onShowDetails(): void;
	onQuery(query: string): void;
	onLabelsMenu(anchor: HTMLElement): void;
	onViewOptions(anchor: HTMLElement): void;
	onStatusMapping(anchor: HTMLElement): void;
	/** Creates a direct child; with a status, the child gets it. */
	onCreate(status?: string): void;
	onColumnMenu(anchor: HTMLElement, column: IBoardStatusColumn<ITicketBoardCard>): void;
	onOpen(card: ITicketBoardCard): void;
	onDragStart(card: ITicketBoardCard): void;
	onDragEnd(): void;
	onDrop(column: IBoardStatusColumn<ITicketBoardCard>): void;
}

/** Category accent colors (header top border, dot, name). */
const BOARD_CATEGORY_COLORS: { readonly [kind: string]: string } = {
	'Todo': '#a1a1aa',
	'In Progress': '#3b82f6',
	'Done': '#22c55e',
	'Blocked': '#ef4444',
	'Removed': '#71717a',
	[OTHER_BOARD_GROUP]: '#a1a1aa'
};

export const TICKET_BOARD_CSS = `
/* Neutral kanban look. Surfaces are derived from the theme (editor background + a little foreground) so the */
/* board follows dark and light themes; the hex values are the fallbacks of the reference design. */
.ticket-board {
	--tb-page: var(--vscode-editor-background, #1e1e1e);
	--tb-text: var(--vscode-editor-foreground, #e5e5e5);
	--tb-muted: var(--vscode-descriptionForeground, #9ca3af);
	--tb-surface: color-mix(in srgb, var(--vscode-foreground, #cccccc) 4%, var(--tb-page));
	--tb-card: color-mix(in srgb, var(--vscode-foreground, #cccccc) 8%, var(--tb-page));
	--tb-border: color-mix(in srgb, var(--vscode-foreground, #cccccc) 14%, var(--tb-page));
	--tb-border-strong: color-mix(in srgb, var(--vscode-foreground, #cccccc) 30%, var(--tb-page));
	--tb-accent: var(--vscode-focusBorder, #3b82f6);
	--tb-danger: var(--vscode-errorForeground, #f87171);
	--tb-success: var(--vscode-testing-iconPassed, #22c55e);
	display: flex; flex-direction: column; gap: 16px; padding: 4px 0 20px; color: var(--tb-text);
	font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif); font-size: 14px;
}
.ticket-board button { font-family: inherit; }
.ticket-board-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ticket-board-crumbs { font-size: 13px; color: var(--tb-muted); display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.ticket-board-crumbs .sep { opacity: 0.6; }
.ticket-board-title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ticket-board-title { font-size: 30px; font-weight: 600; line-height: 1.2; margin: 0; color: var(--tb-text); }
.ticket-board-status-pill { font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
.ticket-board-subtitle { margin-top: 6px; font-size: 14px; color: var(--tb-muted); }
.ticket-board-head-actions { display: flex; align-items: center; gap: 8px; }
.ticket-board-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 6px; cursor: pointer; font-size: 13.5px; font-weight: 500;
	background: var(--vscode-button-secondaryBackground, #3a3a3c); color: var(--vscode-button-secondaryForeground, #e5e5e5); border: 1px solid var(--tb-border); }
.ticket-board-btn:hover { border-color: var(--tb-border-strong); }
.ticket-board-btn.primary { background: var(--vscode-button-background, #2563eb); color: var(--vscode-button-foreground, #ffffff); border-color: transparent; }
.ticket-board-btn.primary:hover { background: var(--vscode-button-hoverBackground, #1d4ed8); }
.ticket-board-btn.icon { width: 32px; padding: 0; justify-content: center; }
.ticket-board-btn:focus-visible, .ticket-board-search:focus { outline: 1px solid var(--tb-accent); outline-offset: 1px; }
.ticket-board-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ticket-board-search-wrap { position: relative; display: flex; align-items: center; }
.ticket-board-search-wrap .codicon { position: absolute; left: 10px; color: var(--tb-muted); pointer-events: none; }
.ticket-board-search { width: 280px; height: 32px; padding: 0 10px 0 32px; border-radius: 6px; font-size: 13.5px; font-family: inherit;
	background: var(--vscode-input-background, var(--tb-surface)); color: var(--vscode-input-foreground, var(--tb-text)); border: 1px solid var(--tb-border); }
.ticket-board-btn.active { border-color: var(--tb-accent); color: var(--tb-text); }
.ticket-board-toolbar .grow { flex: 1; }
.ticket-board-group-label { font-size: 13px; color: var(--tb-muted); }
.ticket-board-empty { font-size: 14px; color: var(--tb-muted); padding: 8px 2px; }
.ticket-board-scroll { overflow-x: auto; padding-bottom: 8px; }
.ticket-board-groups { display: flex; gap: 16px; align-items: stretch; min-width: min-content; }
.ticket-board-group { display: flex; flex-direction: column; gap: 10px; flex-basis: 0; min-width: 0; }
.ticket-board-cat { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 6px; font-size: 14px;
	background: var(--tb-surface); border: 1px solid var(--tb-border); border-top: 2px solid var(--tb-cat); }
.ticket-board-cat .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tb-cat); flex: none; }
.ticket-board-cat .name { font-weight: 600; color: var(--tb-cat-text, var(--tb-cat)); }
.ticket-board-cat .count { color: var(--tb-muted); }
.ticket-board-cat .grow { flex: 1; }
.ticket-board-cat .meta { font-size: 12.5px; color: var(--tb-muted); }
.ticket-board-columns { display: flex; gap: 12px; flex: 1; }
.ticket-board-column { flex: 1 1 0; min-width: 272px; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 8px; min-height: 320px;
	background: var(--tb-surface); border: 1px solid var(--tb-border); }
.ticket-board-column.collapsed { flex: 0 0 auto; min-width: 180px; min-height: 0; }
.ticket-board-column.drop-target { border-color: var(--tb-accent); box-shadow: inset 0 0 0 1px var(--tb-accent); }
.ticket-board-column-header { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.ticket-board-column-header .name { font-size: 16px; font-weight: 600; color: var(--tb-text); }
.ticket-board-column-header .badge { font-size: 12px; min-width: 20px; text-align: center; padding: 1px 7px; border-radius: 999px;
	background: var(--vscode-badge-background, #3a3a3c); color: var(--vscode-badge-foreground, #e5e5e5); }
.ticket-board-column-header .grow { flex: 1; }
.ticket-board-column-header .menu { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer;
	background: transparent; border: none; color: var(--tb-muted); }
.ticket-board-column-header .menu:hover { background: var(--tb-card); color: var(--tb-text); }
.ticket-board-cards { display: flex; flex-direction: column; gap: 8px; flex: 1; }
.ticket-board-add { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 13.5px;
	background: transparent; border: none; color: var(--tb-muted); }
.ticket-board-add:hover { color: var(--tb-text); background: var(--tb-card); }
.ticket-board-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 6px; cursor: pointer;
	background: var(--tb-card); color: var(--tb-text); border: 1px solid var(--tb-border); }
.ticket-board-card:hover { border-color: var(--tb-border-strong); }
.ticket-board-card:focus, .ticket-board-card:focus-visible { outline: none; border-color: var(--tb-accent); background: color-mix(in srgb, var(--tb-accent) 10%, var(--tb-card)); }
.ticket-board-card.dragging { opacity: 0.5; }
.ticket-board-card .line { display: flex; align-items: center; gap: 8px; }
.ticket-board-card .id { font-size: 12.5px; color: var(--tb-muted); }
.ticket-board-card .grow { flex: 1; }
.ticket-board-card .prio { font-size: 12.5px; color: var(--tb-muted); }
.ticket-board-card .prio.high { color: var(--tb-danger); }
.ticket-board-card .prio.done { color: var(--tb-success); }
.ticket-board-card .title { font-size: 15px; line-height: 1.4; word-break: break-word; color: var(--tb-text); }
.ticket-board-card .labels { display: flex; flex-wrap: wrap; gap: 6px; }
.ticket-board-card .label { font-size: 12px; padding: 2px 8px; border-radius: 4px; }
.ticket-board-card .meta { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--tb-muted); }
.ticket-board-card .meta.runFailed, .ticket-board-card .meta.testFailed { color: var(--tb-danger); }
.ticket-board-card .meta.testPassed { color: var(--tb-success); }
.ticket-board-card .agent { font-size: 12.5px; color: var(--tb-muted); }
.ticket-board-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--tb-border);
	font-size: 13px; color: var(--tb-muted); }
`;

function iconSpan(classes: string, icon: ThemeIcon, title?: string): HTMLElement {
	const span = $('span');
	span.className = `${classes} ${ThemeIcon.asClassName(icon)}`;
	if (title) {
		span.title = title;
	}
	return span;
}

function button(classes: string, label: string | undefined, icon: ThemeIcon | undefined, title: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
	const btn = $<HTMLButtonElement>(`button.${classes.split(' ').join('.')}`, { type: 'button', title, 'aria-label': title });
	if (icon) {
		append(btn, iconSpan('', icon));
	}
	if (label) {
		append(btn, $('span', undefined, label));
	}
	btn.addEventListener('click', e => {
		e.preventDefault();
		e.stopPropagation();
		onClick(btn);
	});
	return btn;
}

function categoryColor(kind: string): string {
	return BOARD_CATEGORY_COLORS[kind] ?? BOARD_CATEGORY_COLORS[OTHER_BOARD_GROUP];
}

/** The search box of each board host (kept focused across re-renders). */
const searchInputs = new WeakMap<HTMLElement, HTMLInputElement>();

export function renderTicketBoard(host: HTMLElement, opts: ITicketBoardRenderOptions): void {
	// keep the search box focused across re-renders (live filtering)
	const oldSearch = searchInputs.get(host);
	const searchFocused = !!oldSearch && getActiveElement() === oldSearch;
	const selection = searchFocused ? [oldSearch.selectionStart, oldSearch.selectionEnd] : undefined;

	clearNode(host);
	append(host, $('style', undefined, TICKET_BOARD_CSS));
	const root = append(host, $('div.ticket-board'));
	renderHeader(root, opts);
	searchInputs.set(host, renderToolbar(root, opts));

	if (opts.error) {
		append(root, $('div.ticket-board-empty', undefined, `Could not load child tickets: ${opts.error}`));
	}
	const board = opts.board;
	if (board) {
		if (opts.totalChildren === 0) {
			append(root, $('div.ticket-board-empty', undefined, 'This ticket has no child tickets yet.'));
		} else if (board.total === 0 && opts.filterActive) {
			append(root, $('div.ticket-board-empty', undefined, 'No tickets match the search or label filter.'));
		}
		const groupsEl = append(append(root, $('div.ticket-board-scroll')), $('div.ticket-board-groups'));
		for (const group of board.groups) {
			renderGroup(groupsEl, group, opts);
		}
		const footer = append(root, $('div.ticket-board-footer'));
		append(footer, $('span', undefined, 'System statuses group your workflow. Each custom status has its own column.'));
		const shown = board.total - board.hiddenRemovedCount;
		append(footer, $('span', undefined, `${pluralize(opts.customStatusCount, 'custom status', 'custom statuses')} · ${pluralize(shown, 'ticket')}`));
	} else if (!opts.error) {
		append(root, $('div.ticket-board-empty', undefined, 'Loading child tickets…'));
	}

	if (searchFocused && selection) {
		const input = searchInputs.get(host);
		input?.focus();
		input?.setSelectionRange(selection[0], selection[1]);
	}
}

function renderHeader(root: HTMLElement, opts: ITicketBoardRenderOptions): void {
	const head = append(root, $('div.ticket-board-head'));
	const left = append(head, $('div'));
	const parent = opts.parent;
	const crumbs = append(left, $('div.ticket-board-crumbs'));
	for (const segment of [...(parent?.breadcrumb ?? []), 'Board']) {
		if (crumbs.childElementCount > 0) {
			append(crumbs, $('span.sep', undefined, '/'));
		}
		append(crumbs, $('span', undefined, segment));
	}
	const titleRow = append(left, $('div.ticket-board-title-row'));
	append(titleRow, $('h1.ticket-board-title', undefined, parent?.title ?? ''));
	if (parent?.status) {
		const pill = append(titleRow, $('span.ticket-board-status-pill', { title: `Status: ${parent.status}${parent.category ? ` (${parent.category})` : ''}` }, parent.status));
		const color = categoryColor(parent.category ?? OTHER_BOARD_GROUP);
		pill.style.color = `color-mix(in srgb, ${color} 80%, var(--tb-text))`;
		pill.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
	}
	append(left, $('div.ticket-board-subtitle', undefined, opts.totalChildren === undefined ? '' : pluralize(opts.totalChildren, 'child ticket')));

	const actions = append(head, $('div.ticket-board-head-actions'));
	append(actions, button('ticket-board-btn icon', undefined, Codicon.layoutPanelLeft, 'Switch to Details view', () => opts.onShowDetails()));
	append(actions, button('ticket-board-btn', 'Status mapping', Codicon.settings, 'Edit the workspace lifecycle (statuses and categories) and labels', btn => opts.onStatusMapping(btn)));
	append(actions, button('ticket-board-btn primary', 'Create ticket', Codicon.add, 'Create a child ticket', () => opts.onCreate()));
}

function renderToolbar(root: HTMLElement, opts: ITicketBoardRenderOptions): HTMLInputElement {
	const bar = append(root, $('div.ticket-board-toolbar'));
	const wrap = append(bar, $('div.ticket-board-search-wrap'));
	append(wrap, iconSpan('', Codicon.search));
	const input = append(wrap, $<HTMLInputElement>('input.ticket-board-search', { type: 'text', placeholder: 'Search by title or ticket ID...', 'aria-label': 'Search by title or ticket ID' }));
	input.value = opts.query;
	input.addEventListener('input', () => opts.onQuery(input.value));
	input.addEventListener('keydown', e => {
		if (e.key === 'Escape' && input.value) {
			e.stopPropagation();
			opts.onQuery('');
		}
	});
	const labelsText = opts.labelFilter.length > 0 ? `Labels (${opts.labelFilter.length})` : 'Labels';
	const labelsBtn = append(bar, button('ticket-board-btn ticket-board-labels-btn', labelsText, Codicon.chevronDown, 'Filter by label', btn => opts.onLabelsMenu(btn)));
	labelsBtn.classList.toggle('active', opts.labelFilter.length > 0);
	// label before the chevron
	labelsBtn.append(labelsBtn.firstChild!);
	append(bar, $('span.grow'));
	append(bar, $('span.ticket-board-group-label', undefined, 'Group: System status'));
	const viewBtn = append(bar, button('ticket-board-btn ticket-board-view-options', 'View options', Codicon.chevronDown, 'View options', btn => opts.onViewOptions(btn)));
	viewBtn.append(viewBtn.firstChild!);
	return input;
}

function renderGroup(groupsEl: HTMLElement, group: IBoardGroup<ITicketBoardCard>, opts: ITicketBoardRenderOptions): void {
	const groupEl = append(groupsEl, $('div.ticket-board-group', { 'data-category': group.kind }));
	groupEl.style.flexGrow = String(group.weight);
	const color = categoryColor(group.kind);
	groupEl.style.setProperty('--tb-cat', color);
	if (group.kind === 'Todo' || group.kind === OTHER_BOARD_GROUP) {
		groupEl.style.setProperty('--tb-cat-text', 'var(--tb-text)');
	}
	const cat = append(groupEl, $('div.ticket-board-cat'));
	append(cat, $('span.dot'));
	append(cat, $('span.name', undefined, group.kind));
	append(cat, $('span.count', undefined, String(group.count)));
	append(cat, $('span.grow'));
	if (group.kind !== OTHER_BOARD_GROUP) {
		append(cat, $('span.meta', undefined, pluralize(group.columns.length, 'status', 'statuses')));
	}

	const columnsEl = append(groupEl, $('div.ticket-board-columns'));
	for (const column of group.columns) {
		renderColumn(columnsEl, group, column, opts);
	}
}

function renderColumn(columnsEl: HTMLElement, group: IBoardGroup<ITicketBoardCard>, column: IBoardStatusColumn<ITicketBoardCard>, opts: ITicketBoardRenderOptions): void {
	const collapsed = opts.collapsed.has(column.status);
	const colEl = append(columnsEl, $('div.ticket-board-column', { 'data-status': column.status }));
	colEl.classList.toggle('collapsed', collapsed);
	const header = append(colEl, $('div.ticket-board-column-header'));
	append(header, $('span.name', undefined, column.status));
	append(header, $('span.badge', undefined, String(column.cards.length)));
	append(header, $('span.grow'));
	append(header, button('menu', undefined, Codicon.ellipsis, `${column.status} actions`, btn => opts.onColumnMenu(btn, column)));

	if (!collapsed) {
		const list = append(colEl, $('div.ticket-board-cards'));
		for (const card of column.cards) {
			append(list, renderCard(card, group.kind === 'Done', opts));
		}
		if (column.droppable) {
			append(colEl, button('ticket-board-add', 'Create ticket', Codicon.add, `Create a child ticket with status ${column.status}`, () => opts.onCreate(column.status)));
		}
	}
	if (column.droppable) {
		colEl.addEventListener('dragover', e => {
			if (opts.isDragging()) {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
				colEl.classList.add('drop-target');
			}
		});
		colEl.addEventListener('dragleave', e => {
			if (!colEl.contains(e.relatedTarget as Node | null)) {
				colEl.classList.remove('drop-target');
			}
		});
		colEl.addEventListener('drop', e => {
			colEl.classList.remove('drop-target');
			if (opts.isDragging()) {
				e.preventDefault();
				opts.onDrop(column);
			}
		});
	}
}

function renderCard(card: ITicketBoardCard, inDone: boolean, opts: ITicketBoardRenderOptions): HTMLElement {
	const el = $('div.ticket-board-card', { draggable: 'true', tabindex: '0', role: 'button', 'data-ticket-id': card.ticketId, title: `${card.ticketId}${card.title ? ` ${card.title}` : ''}\nStatus: ${card.status || 'None'}\nClick to open, drag to change status` });

	const top = append(el, $('div.line'));
	append(top, $('span.id', undefined, card.ticketId));
	append(top, $('span.grow'));
	if (inDone) {
		append(top, $('span.prio.done', undefined, card.status || 'Done'));
	} else {
		const prio = describeBoardPriority(card.priority);
		append(top, $(`span.prio.${prio.tone}`, undefined, prio.text));
	}

	append(el, $('div.title', undefined, card.title || card.ticketId));

	if (card.labels.length > 0) {
		const labels = append(el, $('div.labels'));
		for (const name of card.labels) {
			const chip = append(labels, $('span.label', undefined, name));
			const color = getLabelColor(opts.labelDefs, name);
			chip.style.background = `color-mix(in srgb, ${color} 20%, transparent)`;
			chip.style.color = `color-mix(in srgb, ${color} 72%, var(--tb-text))`;
		}
	}

	const meta = describeBoardCardMeta(card);
	if (meta.kind !== 'none' || card.agent) {
		const footer = append(el, $('div.line'));
		if (meta.kind !== 'none') {
			const icon = meta.kind === 'runFailed' || meta.kind === 'testFailed' ? Codicon.error : meta.kind === 'testPassed' ? Codicon.pass : meta.kind === 'testNotRun' ? Codicon.circleLargeOutline : Codicon.checklist;
			const tooltip = card.failure ? `Failing:\n${card.failure.reasons.map(r => `• ${r}`).join('\n')}` : meta.text;
			const metaEl = append(footer, $(`span.meta.${meta.kind}`, { title: tooltip }));
			append(metaEl, iconSpan('', icon));
			append(metaEl, $('span', undefined, meta.text));
		}
		append(footer, $('span.grow'));
		if (card.agent) {
			append(footer, $('span.agent', { title: `Current AI Agent: ${card.agent}` }, card.agent));
		}
	}

	el.addEventListener('click', () => opts.onOpen(card));
	el.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			opts.onOpen(card);
		}
	});
	el.addEventListener('dragstart', e => {
		opts.onDragStart(card);
		el.classList.add('dragging');
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData(CARD_DRAG_MIME, card.uri.toString());
		}
	});
	el.addEventListener('dragend', () => {
		el.classList.remove('dragging');
		opts.onDragEnd();
	});
	return el;
}
