/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import { openSubWorkflowTicketCanvas } from '../../workflowsManager/browser/subWorkflowLiveView.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { BoardTestResult, buildTicketBoard, classifyBoardTestResult, IBoardGroup, IBoardStatusColumn, ITicketBoard, OTHER_BOARD_GROUP, parseBoardModeKeys, TicketPageMode, updateBoardModeKeys } from '../common/ticketBoardModel.js';
import { readTestResultField } from '../common/ticketFailure.js';
import { getLabelColor, ITicketLabelDefinition } from '../common/ticketLabels.js';
import { findStatusOption, findTemplateForType, getPriorityColor, normalizePriority, resolveEffectiveStatusOptions } from '../common/ticketStatusPicker.js';
import { readTicketLabels, readTopLevelMetadata, STATUS_CATEGORY_COLORS } from '../common/workspaceLifecycle.js';
import { IWorkspaceStatusesInfo, IWorkspacesExplorerService } from '../common/workspacesExplorer.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';

/**
 * Board (kanban) mode of the ticket page (UI-25): the ticket's direct child tickets grouped by category and status.
 *
 * The ticket page owns one controller: it puts {@link createToggleButton} in its action bar and calls {@link mount}
 * after each render with the details layout element; the controller adds its own host next to it and shows one of
 * the two. The mode is remembered per ticket (workspace storage).
 *
 * Logic (data, refresh, drag and drop, opening tickets) lives in the controller; everything visual is in
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
	readonly childCount: number;
	readonly failure?: { readonly reasons: readonly string[] };
	readonly testResult?: BoardTestResult;
}

const BOARD_MODE_STORAGE_KEY = 'anyagent.ticketPage.boardModeTickets';
const CARD_DRAG_MIME = 'application/vnd.anyagent.ticket-board-card';
const REFRESH_DEBOUNCE_MS = 300;

export class TicketBoardController extends Disposable {

	private _ticketUri: URI | undefined;
	private _enabled = false;
	private _mode: TicketPageMode = 'details';
	private _showRemoved = false;
	private _toggleBtn: HTMLButtonElement | undefined;
	private _detailsEl: HTMLElement | undefined;
	private readonly _host: HTMLElement;
	private _cards: readonly ITicketBoardCard[] | undefined;
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
		@ICustomModulesService private readonly _customModulesService: ICustomModulesService
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
		append(btn, $('span', { class: ThemeIcon.asClassName(Codicon.project), style: 'font-size: 14px;' }));
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
		if (changedTicket) {
			this._cards = undefined;
			this._statuses = undefined;
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
		append(btn, $('span', { class: ThemeIcon.asClassName(board ? Codicon.layoutPanelLeft : Codicon.project), style: 'font-size: 13px;' }));
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
			const [statuses, summary] = await Promise.all([
				this._workspacesExplorerService.getWorkspaceStatuses(ticketUri),
				this._workspacesExplorerService.getTicketSubtreeSummary(ticketUri)
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
					childCount: node.children.filter(c => !c.removed).length,
					failure: node.failure,
					testResult: result ? classifyBoardTestResult(result.value) : undefined
				};
			}));
			if (seq !== this._loadSeq || ticketUri !== this._ticketUri) {
				return;
			}
			this._statuses = statuses;
			this._cards = cards;
			this._render();
		} catch (err) {
			console.error('[TicketBoard] Failed to load child tickets:', err);
			if (seq === this._loadSeq) {
				this._cards = [];
				this._render(String((err as Error)?.message ?? err));
			}
		}
	}

	private async _readTicketHead(ticketUri: URI): Promise<string | undefined> {
		for (const uri of [URI.joinPath(ticketUri, '.agents', 'ticket.md'), URI.joinPath(ticketUri, 'ticket.md')]) {
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

	/** Drop on a status column: the same "Set Status" path as the tree (UI-18), recorded as User (CI-50). */
	private async _moveCard(card: ITicketBoardCard, column: IBoardStatusColumn<ITicketBoardCard>): Promise<void> {
		if (!column.droppable || (card.status ?? '').trim().toLowerCase() === column.status.toLowerCase() || !this._statuses) {
			return;
		}
		let templates: Awaited<ReturnType<ICustomModulesService['getCustomModules']>> = [];
		try {
			templates = await this._customModulesService.getCustomModules(this._ticketUri);
		} catch {
			// no templates: the workspace lifecycle applies
		}
		const options = resolveEffectiveStatusOptions(findTemplateForType(templates, card.type)?.statuses, this._statuses).options;
		const match = findStatusOption(options, column.status);
		if (!match) {
			this._notificationService.warn(`'${column.status}' is not a status of ${card.ticketId} (its template defines its own statuses).`);
			return;
		}
		try {
			await this._workspacesExplorerService.setEntityStatus(card.uri, match.status, 'User');
		} catch (err) {
			this._notificationService.error(`Failed to set the status of ${card.ticketId}: ${String((err as Error)?.message ?? err)}`);
			return;
		}
		// show the move right away; the file watcher refresh confirms it
		if (this._cards) {
			this._cards = this._cards.map(c => c === card ? { ...c, status: match.status } : c);
			this._render();
		}
		this._scheduleRefresh();
	}

	// ---------------------------------------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------------------------------------

	private _render(error?: string): void {
		const statuses = this._statuses;
		const cards = this._cards;
		const board = statuses && cards ? buildTicketBoard(cards, statuses, { showRemoved: this._showRemoved }) : undefined;
		renderTicketBoard(this._host, {
			board,
			error,
			showRemoved: this._showRemoved,
			labelDefs: statuses?.labels ?? [],
			isDragging: () => !!this._dragCard,
			onToggleRemoved: () => {
				this._showRemoved = !this._showRemoved;
				this._render();
			},
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
	readonly showRemoved: boolean;
	readonly labelDefs: readonly ITicketLabelDefinition[];
	isDragging(): boolean;
	onToggleRemoved(): void;
	onOpen(card: ITicketBoardCard): void;
	onDragStart(card: ITicketBoardCard): void;
	onDragEnd(): void;
	onDrop(column: IBoardStatusColumn<ITicketBoardCard>): void;
}

export const TICKET_BOARD_CSS = `
/* Warm "settings panel" look (reference: media player Subtitles & dictation section). Tokens first, then rules. */
.ticket-board {
	--tb-panel-bg: #1c1a17; --tb-panel-border: #3d3427; --tb-inset-bg: #141210; --tb-input-border: #8b7355;
	--tb-accent: #f5c451; --tb-accent-fill: rgba(245, 196, 81, 0.12); --tb-text: #e7e5e4; --tb-muted: #a8a29e; --tb-divider: #3d3427;
	--tb-capsule-bg: #0d0c0b;
}
.monaco-workbench.vs .ticket-board, .monaco-workbench.hc-light .ticket-board {
	--tb-panel-bg: #fbf7ef; --tb-panel-border: #e2d3b5; --tb-inset-bg: #ffffff; --tb-input-border: #b08d57;
	--tb-accent: #8a5a00; --tb-accent-fill: rgba(176, 122, 20, 0.10); --tb-text: #292524; --tb-muted: #6b6259; --tb-divider: #e2d3b5;
	--tb-capsule-bg: #ffffff;
}
.ticket-board { display: flex; flex-direction: column; gap: 14px; padding: 16px 0 20px; color: var(--tb-text); font-size: 14px; }
.ticket-board-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.ticket-board-help { font-size: 14px; color: var(--tb-muted); flex: 1; min-width: 200px; }
.ticket-board-toolbar button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 13.5px; font-weight: 600;
	background: var(--tb-accent-fill); color: var(--tb-accent); border: 1px solid var(--tb-input-border); }
.ticket-board-toolbar button:hover { border-color: var(--tb-accent); }
.ticket-board-toolbar button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.ticket-board-toolbar button[aria-pressed="true"] { background: var(--tb-accent); color: var(--tb-capsule-bg); border-color: var(--tb-accent); }
.ticket-board-scroll { overflow-x: auto; padding-bottom: 8px; }
.ticket-board-groups { display: flex; gap: 18px; align-items: stretch; min-width: min-content; }
.ticket-board-group { display: flex; flex-direction: column; gap: 10px; flex-basis: 0; min-width: 0; }
.ticket-board-capsule { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 5px 14px; border-radius: 999px; font-size: 14px; font-weight: 600;
	color: var(--tb-text); background: var(--tb-capsule-bg); border: 1px solid var(--tb-input-border); }
.ticket-board-capsule .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ticket-board-capsule .count { font-weight: 400; color: var(--tb-muted); }
.ticket-board-columns { display: flex; gap: 12px; flex: 1; }
.ticket-board-column { flex: 1 1 0; min-width: 260px; display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 8px; min-height: 260px;
	background: var(--tb-panel-bg); border: 1px solid var(--tb-panel-border); }
.ticket-board-column.drop-target { border-color: var(--tb-accent); box-shadow: inset 0 0 0 1px var(--tb-accent); }
.ticket-board-column-header { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--tb-divider); }
.ticket-board-column-header .icon { font-size: 14px; color: var(--tb-muted); }
.ticket-board-column-header .name { font-size: 16px; font-weight: 600; color: var(--tb-accent); flex: 1; }
.ticket-board-column-header .count { font-size: 14px; color: var(--tb-muted); }
.ticket-board-empty { font-size: 14px; color: var(--tb-muted); font-style: italic; padding: 4px 2px; }
.ticket-board-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 6px; cursor: pointer; font-size: 14.5px;
	background: var(--tb-inset-bg); color: var(--tb-text); border: 1px solid var(--tb-panel-border); }
.ticket-board-card:hover { border-color: var(--tb-input-border); }
.ticket-board-card:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.ticket-board-card.dragging { opacity: 0.5; }
.ticket-board-card .row { display: flex; align-items: center; gap: 8px; }
.ticket-board-card .prio { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ticket-board-card .id { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; color: var(--tb-accent); }
.ticket-board-card .title { line-height: 1.45; word-break: break-word; color: var(--tb-text); }
.ticket-board-card .spacer { flex: 1; }
.ticket-board-card .children { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--tb-muted); }
.ticket-board-card .mark { font-size: 15px; }
.ticket-board-card .mark.failed { color: var(--vscode-errorForeground, #f87171); }
.ticket-board-card .mark.passed { color: var(--vscode-testing-iconPassed, #34d399); }
.ticket-board-card .mark.notRun { color: var(--tb-muted); }
.ticket-board-card .labels { display: flex; flex-wrap: wrap; gap: 5px; }
.ticket-board-card .label { font-size: 12.5px; padding: 1px 8px; border-radius: 4px; border: 1px solid; color: var(--tb-text); }
`;

function categoryDotColor(group: IBoardGroup<ITicketBoardCard>): string {
	return group.kind === OTHER_BOARD_GROUP ? 'var(--vscode-descriptionForeground)' : STATUS_CATEGORY_COLORS[group.kind].text;
}

export function renderTicketBoard(host: HTMLElement, opts: ITicketBoardRenderOptions): void {
	clearNode(host);
	append(host, $('style', undefined, TICKET_BOARD_CSS));
	const root = append(host, $('div.ticket-board'));

	const toolbar = append(root, $('div.ticket-board-toolbar'));
	const board = opts.board;
	append(toolbar, $('span.ticket-board-help', undefined, board ? `${board.total} child ticket${board.total === 1 ? '' : 's'}. Click a card to open it; drag it onto another status to change its status.` : 'Loading child tickets…'));
	const removedBtn = append(toolbar, $<HTMLButtonElement>('button.ticket-board-removed-toggle', { type: 'button', title: opts.showRemoved ? 'Hide Removed tickets' : 'Show Removed tickets' }));
	removedBtn.setAttribute('aria-pressed', opts.showRemoved ? 'true' : 'false');
	append(removedBtn, $('span', { class: ThemeIcon.asClassName(opts.showRemoved ? Codicon.eye : Codicon.eyeClosed) }));
	append(removedBtn, $('span', undefined, board && !opts.showRemoved && board.hiddenRemovedCount > 0 ? `Removed (${board.hiddenRemovedCount} hidden)` : 'Removed'));
	removedBtn.addEventListener('click', () => opts.onToggleRemoved());

	if (opts.error) {
		append(root, $('div.ticket-board-empty', undefined, `Could not load child tickets: ${opts.error}`));
	}
	if (!board) {
		return;
	}
	if (board.total === 0) {
		append(root, $('div.ticket-board-empty', undefined, 'This ticket has no child tickets.'));
	}

	const groupsEl = append(append(root, $('div.ticket-board-scroll')), $('div.ticket-board-groups'));
	for (const group of board.groups) {
		const groupEl = append(groupsEl, $('div.ticket-board-group', { 'data-category': group.kind }));
		groupEl.style.flexGrow = String(group.weight);
		const capsule = append(groupEl, $('div.ticket-board-capsule'));
		const dot = append(capsule, $('span.dot'));
		dot.style.background = categoryDotColor(group);
		append(capsule, $('span', undefined, group.kind));
		append(capsule, $('span.count', undefined, String(group.count)));

		const columnsEl = append(groupEl, $('div.ticket-board-columns'));
		for (const column of group.columns) {
			const colEl = append(columnsEl, $('div.ticket-board-column', { 'data-status': column.status }));
			if (group.showStatusHeaders) {
				const header = append(colEl, $('div.ticket-board-column-header'));
				append(header, iconSpan('icon', Codicon.listFlat));
				append(header, $('span.name', undefined, column.status));
				append(header, $('span.count', undefined, String(column.cards.length)));
			}
			if (column.cards.length === 0) {
				append(colEl, $('div.ticket-board-empty', undefined, 'No tickets'));
			}
			for (const card of column.cards) {
				append(colEl, renderCard(card, opts));
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
	}
}

function iconSpan(classes: string, icon: ThemeIcon, title?: string): HTMLElement {
	const span = $('span');
	span.className = `${classes} ${ThemeIcon.asClassName(icon)}`;
	if (title) {
		span.title = title;
	}
	return span;
}

function renderCard(card: ITicketBoardCard, opts: ITicketBoardRenderOptions): HTMLElement {
	const el = $('div.ticket-board-card', { draggable: 'true', 'data-ticket-id': card.ticketId, title: `${card.ticketId}${card.title ? ` ${card.title}` : ''}\nStatus: ${card.status || 'None'}\nClick to open, drag to change status` });
	const top = append(el, $('div.row'));
	const prio = append(top, $('span.prio', { title: `Priority: ${normalizePriority(card.priority) ?? card.priority ?? 'Medium'}` }));
	prio.style.background = getPriorityColor(card.priority);
	append(top, $('span.id', undefined, card.ticketId));
	append(top, $('span.spacer'));
	if (card.failure) {
		append(top, iconSpan('mark failed', Codicon.error, `Failing:\n${card.failure.reasons.map(r => `• ${r}`).join('\n')}`));
	} else if (card.testResult) {
		const icon = card.testResult === 'passed' ? Codicon.pass : card.testResult === 'failed' ? Codicon.error : Codicon.circleLargeOutline;
		const text = card.testResult === 'passed' ? 'Passed' : card.testResult === 'failed' ? 'Failed' : 'Not run';
		append(top, iconSpan(`mark ${card.testResult}`, icon, `Test result: ${text}`));
	}
	if (card.childCount > 0) {
		const children = append(top, $('span.children', { title: `${card.childCount} child ticket${card.childCount === 1 ? '' : 's'}` }));
		append(children, $('span', { class: ThemeIcon.asClassName(Codicon.listTree) }));
		append(children, $('span', undefined, String(card.childCount)));
	}
	append(el, $('div.title', undefined, card.title || card.ticketId));
	if (card.labels.length > 0) {
		const labels = append(el, $('div.labels'));
		for (const name of card.labels) {
			const chip = append(labels, $('span.label', undefined, name));
			const color = getLabelColor(opts.labelDefs, name);
			chip.style.borderColor = color;
			chip.style.background = `color-mix(in srgb, ${color} 18%, transparent)`;
		}
	}
	el.addEventListener('click', () => opts.onOpen(card));
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
