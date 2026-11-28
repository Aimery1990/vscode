/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow, isHTMLElement, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { FREESTYLE_TICKET_TYPE } from '../../customModules/common/freestyleTicket.js';
import { getSubWorkflowTicketVisual, isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import { resolveCustomModuleIcon } from '../../entityPersistence/common/entityPersistence.js';
import { openSubWorkflowTicketCanvas } from '../../workflowsManager/browser/subWorkflowLiveView.js';
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { findTicketIdMentions, splitTicketIdMentions, ticketIdMentionAt, uniqueTicketIds } from '../common/ticketIdMentions.js';
import { ITicketSearchEntry } from '../common/ticketSearch.js';
import { IWorkspacesExplorerService } from '../common/workspacesExplorer.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';

/**
 * Clickable ticket ID mentions (UI-31).
 *
 * {@link ITicketMentionService} knows which IDs are real tickets: it keeps an ID → ticket map built from the UI-21
 * ticket search index of every managed workspace (reloaded, debounced, when ticket files change) and opens a ticket
 * in a new editor tab. {@link TicketMentionController} applies it to a page:
 *
 * - read-only text: every text node under the page root is scanned (also text added later, through a
 *   MutationObserver) and each known ID becomes a chip (type icon + ID, tooltip with title and status, click opens).
 *   Code, links, buttons, form controls and the like are left alone, as are the page's own ID and unknown IDs.
 * - text boxes: a thin "Mentions:" row under the box lists chips for the known IDs in its text (updated, debounced,
 *   while typing; hidden when there are none). Cmd+click (Ctrl+click elsewhere) on an ID inside the box opens it.
 */

export const ITicketMentionService = createDecorator<ITicketMentionService>('ticketMentionService');

export interface ITicketMentionService {
	readonly _serviceBrand: undefined;
	/** Fires when the set of known tickets (or their title / status / icon) changed. */
	readonly onDidChange: Event<void>;
	/** Starts loading the ticket index unless it is loaded and fresh; {@link onDidChange} fires when it changes. */
	ensureIndex(): void;
	/** The ticket with this ID (exact, upper case) from the loaded index, or undefined. */
	lookup(id: string): ITicketSearchEntry | undefined;
	/** The type icon of a ticket (template icon, built-in type icon or the default). */
	iconFor(entry: ITicketSearchEntry): ThemeIcon;
	/** Opens the ticket in a new pinned tab (never replacing the current one); `toSide` opens it in the side group. */
	open(entry: ITicketSearchEntry, toSide?: boolean): Promise<void>;
}

const BUILT_IN_TYPE_ICONS: Readonly<Record<string, ThemeIcon>> = {
	workspace: Codicon.rootFolder,
	job: Codicon.rocket,
	project: Codicon.project,
	agent: Codicon.robot,
	task: Codicon.checklist,
	case: Codicon.beaker,
	issue: Codicon.bug,
	analysis: Codicon.graph,
	workflow: Codicon.githubAction,
	note: Codicon.book,
	[FREESTYLE_TICKET_TYPE]: Codicon.edit,
};

export class TicketMentionService extends Disposable implements ITicketMentionService {
	declare readonly _serviceBrand: undefined;

	private static readonly RELOAD_DELAY_MS = 1200;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _byId = new Map<string, ITicketSearchEntry>();
	private _signature = '';
	private _loaded = false;
	private _stale = true;
	private _loading: Promise<void> | undefined;
	private readonly _reload = this._register(new RunOnceScheduler(() => this._load(), TicketMentionService.RELOAD_DELAY_MS));
	/** Template icons per workspace (by type id and name, lower case); undefined while loading. */
	private readonly _iconMaps = new Map<string, Map<string, ThemeIcon> | undefined>();

	constructor(
		@IWorkspacesExplorerService private readonly _workspacesExplorerService: IWorkspacesExplorerService,
		@IFileService fileService: IFileService,
		@ICustomModulesService private readonly _customModulesService: ICustomModulesService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super();
		this._register(fileService.onDidFilesChange(e => {
			if (!this._loaded) {
				return;
			}
			// new / deleted ticket folders, and ticket.md edits (title, status, type)
			const relevant = e.rawAdded.length > 0 || e.rawDeleted.length > 0 || e.rawUpdated.some(u => /\/ticket\.md$/i.test(u.path));
			if (relevant) {
				this._stale = true;
				this._reload.schedule();
			}
		}));
		this._register(this._workspacesExplorerService.onDidChangeWorkspaces(() => {
			if (this._loaded) {
				this._stale = true;
				this._reload.schedule();
			}
		}));
		this._register(this._customModulesService.onDidChangeModules(() => {
			if (this._iconMaps.size > 0) {
				this._iconMaps.clear();
				this._onDidChange.fire();
			}
		}));
	}

	ensureIndex(): void {
		if (this._stale && !this._loading && !this._reload.isScheduled()) {
			this._load();
		}
	}

	lookup(id: string): ITicketSearchEntry | undefined {
		return this._byId.get(id);
	}

	iconFor(entry: ITicketSearchEntry): ThemeIcon {
		const type = (entry.type || '').trim().toLowerCase();
		const subWorkflow = getSubWorkflowTicketVisual(type);
		if (subWorkflow) {
			return subWorkflow.icon;
		}
		const key = entry.workspaceKey;
		if (!this._iconMaps.has(key)) {
			this._loadIcons(key, entry);
		}
		return this._iconMaps.get(key)?.get(type) ?? BUILT_IN_TYPE_ICONS[type] ?? resolveCustomModuleIcon(undefined, type);
	}

	async open(entry: ITicketSearchEntry, toSide?: boolean): Promise<void> {
		const name = basename(entry.resource);
		const group = toSide ? SIDE_GROUP : ACTIVE_GROUP;
		try {
			const type = (entry.type || '').toLowerCase();
			if (type === 'workflow') {
				await this._editorService.openEditor(new WorkflowEditorInput(entry.resource, name), { pinned: true }, group);
			} else if (isSubWorkflowTicketType(type)) {
				await openSubWorkflowTicketCanvas(this._editorService, entry.resource, name);
			} else {
				await this._editorService.openEditor(new EntityDetailEditorInput(entry.resource, name), { pinned: true }, group);
			}
		} catch (err) {
			this._notificationService.warn(`Could not open ${entry.ticketId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _load(): Promise<void> {
		if (this._loading) {
			return this._loading;
		}
		this._stale = false;
		const loading = this._workspacesExplorerService.getTicketSearchIndex().then(index => {
			const byId = new Map<string, ITicketSearchEntry>();
			for (const entry of index.entries) {
				const id = (entry.ticketId || '').trim().toUpperCase();
				if (!id) {
					continue;
				}
				const existing = byId.get(id);
				// the same ID twice (copied workspace): prefer a ticket that is not removed
				if (!existing || (existing.removedInPath && !entry.removedInPath)) {
					byId.set(id, entry);
				}
			}
			const signature = Array.from(byId.values(), e => `${e.ticketId}\u0000${e.title}\u0000${e.status ?? ''}\u0000${e.type ?? ''}\u0000${e.removedInPath}\u0000${e.resource.toString()}`).sort().join('\u0001');
			this._byId = byId;
			this._loaded = true;
			if (signature !== this._signature) {
				this._signature = signature;
				this._onDidChange.fire();
			}
		}, () => {
			this._loaded = true;
		}).finally(() => {
			this._loading = undefined;
		});
		this._loading = loading;
		return loading;
	}

	private _loadIcons(key: string, entry: ITicketSearchEntry): void {
		this._iconMaps.set(key, undefined);
		this._customModulesService.getCustomModules(entry.workspaceResource).then(mods => {
			const map = new Map<string, ThemeIcon>();
			for (const m of mods) {
				const id = (m.id || '').toLowerCase();
				const name = (m.name || '').toLowerCase();
				if (!id && !name) {
					continue;
				}
				const icon = resolveCustomModuleIcon(m.icon, id || name);
				if (id) {
					map.set(id, icon);
				}
				if (name) {
					map.set(name, icon);
				}
			}
			if (this._iconMaps.has(key)) {
				this._iconMaps.set(key, map);
				if (map.size > 0) {
					this._onDidChange.fire();
				}
			}
		}, () => {
			if (this._iconMaps.has(key)) {
				this._iconMaps.set(key, new Map());
			}
		});
	}
}

// ---------------------------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------------------------

const CHIP_CLASS = 'ticket-mention-chip';
const ROW_CLASS = 'ticket-mention-row';
const STYLE_CLASS = 'ticket-mention-style';
/** Mark an element (and its sub-tree) with this attribute to keep its text and text boxes as they are. */
export const NO_TICKET_MENTIONS_ATTRIBUTE = 'data-no-ticket-mentions';

/** Text under these is never linkified: code, links and controls, our own chips, and the page's navigation. */
const TEXT_SKIP_SELECTOR = [
	'code', 'pre.wf-step-code:not(.wf-value-pre)', 'a', 'button', 'select', 'option', 'textarea', 'input', 'label',
	'script', 'style', '[contenteditable="true"]', '[contenteditable=""]', '.monaco-editor', '.codicon',
	'.prompt-tokenized-display', '.python-code-display', '.python-line-numbers-gutter', '.header-breadcrumb',
	`.${CHIP_CLASS}`, `.${ROW_CLASS}`, `[${NO_TICKET_MENTIONS_ATTRIBUTE}]`
].join(', ');

/** Text boxes that hold code, commands or search queries get no "Mentions" row. */
const INPUT_SKIP_SELECTOR = [
	'.ssh-cmd-row', '.monaco-editor', '.monaco-inputbox', `[${NO_TICKET_MENTIONS_ATTRIBUTE}]`, `.${ROW_CLASS}`
].join(', ');
const INPUT_SKIP_CLASS_RE = /code|script|sql|search|cmd|command|json|interpreter|model|rename|raw|regex|path|url/i;

const MENTION_CSS = `
.${CHIP_CLASS} {
	display: inline-flex;
	align-items: center;
	gap: 3px;
	padding: 0 6px 0 4px;
	margin: 0 1px;
	border-radius: 9px;
	border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 35%, transparent);
	background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent);
	color: var(--vscode-textLink-foreground);
	font-size: 0.92em;
	font-weight: 500;
	line-height: 1.5;
	white-space: nowrap;
	vertical-align: baseline;
	cursor: pointer;
	text-decoration: none;
}
.${CHIP_CLASS}:hover {
	background: color-mix(in srgb, var(--vscode-textLink-foreground) 22%, transparent);
	color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
}
.${CHIP_CLASS}:focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: 1px;
}
.${CHIP_CLASS}.removed {
	opacity: 0.7;
	text-decoration: line-through;
}
.${CHIP_CLASS} .codicon {
	font-size: 12px !important;
	pointer-events: none;
}
.${ROW_CLASS} {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
	margin: 4px 0 2px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	user-select: none;
}
.${ROW_CLASS} > .label {
	opacity: 0.85;
	margin-right: 2px;
}
`;

/** The HTML elements below `root` (not `root` itself) for which `accept` is true, in document order. */
function elementsUnder(root: HTMLElement, accept: (el: HTMLElement) => boolean): HTMLElement[] {
	const out: HTMLElement[] = [];
	const walker = root.ownerDocument.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (isHTMLElement(n) && accept(n)) {
			out.push(n);
		}
	}
	return out;
}

export interface ITicketMentionControllerOptions {
	/** The ID of the ticket the page shows: it is never turned into a chip. */
	readonly selfId?: () => string | undefined;
}

/**
 * Turns the known ticket IDs in the text under `root` into chips and adds "Mentions" rows / Cmd+click to its text
 * boxes, for as long as the controller lives (see the file comment).
 */
export class TicketMentionController extends Disposable {
	private static readonly ROW_DEBOUNCE_MS = 250;

	/** The "Mentions" row of each text box that has one. */
	private readonly _rows = new Map<HTMLInputElement | HTMLTextAreaElement, HTMLElement>();
	private readonly _rowTimers = new Map<HTMLInputElement | HTMLTextAreaElement, number>();
	private readonly _observer: MutationObserver;

	constructor(
		private readonly _root: HTMLElement,
		private readonly _options: ITicketMentionControllerOptions,
		@ITicketMentionService private readonly _mentionService: ITicketMentionService
	) {
		super();
		append(_root, $(`style.${STYLE_CLASS}`, undefined, MENTION_CSS));

		this._observer = new MutationObserver(records => this._mutate(() => this._process(records)));
		this._observer.observe(_root, { childList: true, subtree: true });
		this._register(toDisposable(() => this._observer.disconnect()));

		this._register(this._mentionService.onDidChange(() => this.rescan()));
		this._register(addDisposableListener(_root, EventType.INPUT, e => {
			const box = this._eligibleBox(e.target);
			if (box) {
				this._scheduleRow(box);
			}
		}));
		this._register(addDisposableListener(_root, EventType.FOCUS_IN, e => {
			const box = this._eligibleBox(e.target);
			if (box) {
				this._mutate(() => this._updateRow(box));
			}
		}));
		this._register(addDisposableListener(_root, EventType.CLICK, e => this._onBoxClick(e)));
		this._register(toDisposable(() => {
			const win = getWindow(_root);
			for (const timer of this._rowTimers.values()) {
				win.clearTimeout(timer);
			}
			this._rowTimers.clear();
		}));

		this._mentionService.ensureIndex();
		this.rescan();
	}

	/** Re-applies the known tickets to the whole page: new chips, refreshed / dropped old ones, all rows. */
	rescan(): void {
		this._mutate(() => {
			for (const chip of elementsUnder(this._root, el => el.classList.contains(CHIP_CLASS))) {
				if (!chip.closest(`.${ROW_CLASS}`)) {
					this._refreshChip(chip);
				}
			}
			this._linkify(this._root);
			for (const box of this._boxesUnder(this._root)) {
				this._updateRow(box);
			}
			this._pruneRows();
		});
	}

	/** Linkifies what the page added (text and text boxes). */
	private _process(records: MutationRecord[]): void {
		this._mentionService.ensureIndex();
		const boxes = new Set<HTMLInputElement | HTMLTextAreaElement>();
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (!node.isConnected) {
					continue;
				}
				this._linkify(node);
				for (const box of this._boxesUnder(node)) {
					boxes.add(box);
				}
			}
		}
		for (const box of boxes) {
			this._updateRow(box);
		}
		this._pruneRows();
	}

	/**
	 * Runs `fn`, which changes the DOM, without handling those changes again: page changes still queued are handled
	 * first, the records of our own chips and rows are dropped afterwards.
	 */
	private _mutate(fn: () => void): void {
		const pending = this._observer.takeRecords();
		if (pending.length > 0) {
			this._process(pending);
		}
		fn();
		this._observer.takeRecords();
	}

	private _selfId(): string | undefined {
		return (this._options.selfId?.() || '').trim().toUpperCase() || undefined;
	}

	private _known(id: string): ITicketSearchEntry | undefined {
		return id === this._selfId() ? undefined : this._mentionService.lookup(id);
	}

	// --- read-only text -------------------------------------------------------------------------------------------

	private _linkify(node: Node): void {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			const parent = node.parentElement;
			if (parent && !parent.closest(TEXT_SKIP_SELECTOR)) {
				this._linkifyText(node as Text);
			}
			return;
		}
		if (!isHTMLElement(node) || node.closest(TEXT_SKIP_SELECTOR)) {
			return;
		}
		const doc = node.ownerDocument;
		const walker = doc.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
		const texts: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const text = n as Text;
			if (text.data.length >= 5 && /\d{3}/.test(text.data) && !text.parentElement?.closest(TEXT_SKIP_SELECTOR)) {
				texts.push(text);
			}
		}
		for (const text of texts) {
			this._linkifyText(text);
		}
	}

	private _linkifyText(text: Text): void {
		const parts = splitTicketIdMentions(text.data, id => !!this._known(id));
		const parent = text.parentNode;
		if (!parts || !parent) {
			return;
		}
		const fragment = text.ownerDocument.createDocumentFragment();
		for (const part of parts) {
			if (part.kind === 'text') {
				fragment.appendChild(text.ownerDocument.createTextNode(part.text));
			} else {
				const entry = this._known(part.id);
				fragment.appendChild(entry ? this._createChip(entry, false) : text.ownerDocument.createTextNode(part.text));
			}
		}
		parent.replaceChild(fragment, text);
	}

	/** A chip: type icon + ID (its text is exactly the ID, so the text of the surrounding element does not change). */
	private _createChip(entry: ITicketSearchEntry, inRow: boolean): HTMLElement {
		const chip = $(`span.${CHIP_CLASS}`, { role: 'link', 'data-mention-id': entry.ticketId.toUpperCase() });
		if (!inRow) {
			chip.tabIndex = 0;
		}
		this._decorateChip(chip, entry);
		if (inRow) {
			// keep focus (and caret) in the text box above
			chip.addEventListener('mousedown', e => e.preventDefault());
		}
		chip.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
			const current = this._known(chip.getAttribute('data-mention-id') || '');
			if (current) {
				this._mentionService.open(current, e.altKey);
			}
		});
		chip.addEventListener('keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				const current = this._known(chip.getAttribute('data-mention-id') || '');
				if (current) {
					this._mentionService.open(current, e.altKey);
				}
			}
		});
		return chip;
	}

	private _decorateChip(chip: HTMLElement, entry: ITicketSearchEntry): void {
		const id = entry.ticketId.toUpperCase();
		const icon = $('span' + ThemeIcon.asCSSSelector(this._mentionService.iconFor(entry)));
		chip.replaceChildren(icon, chip.ownerDocument.createTextNode(id));
		chip.classList.toggle('removed', entry.removedInPath);
		const status = entry.status ? `${entry.status}${entry.removed ? '' : entry.removedInPath ? ' (under a removed ticket)' : ''}` : 'None';
		chip.title = `${id}${entry.title ? ` · ${entry.title}` : ''}\nStatus: ${status}${entry.type ? ` · ${entry.type}` : ''}\nClick to open in a new tab, Alt+click to open to the side`;
		chip.setAttribute('aria-label', `Open ticket ${id}${entry.title ? ` ${entry.title}` : ''}`);
	}

	/** Updates a chip after the index changed; a chip whose ticket is gone turns back into plain text. */
	private _refreshChip(chip: HTMLElement): void {
		const id = chip.getAttribute('data-mention-id') || '';
		const entry = this._known(id);
		if (entry) {
			this._decorateChip(chip, entry);
		} else {
			chip.replaceWith(chip.ownerDocument.createTextNode(id));
		}
	}

	// --- text boxes -----------------------------------------------------------------------------------------------

	private _isTextBox(el: EventTarget | Node | null): el is HTMLInputElement | HTMLTextAreaElement {
		if (isHTMLTextAreaElement(el)) {
			return true;
		}
		if (isHTMLInputElement(el)) {
			const type = (el.getAttribute('type') || 'text').toLowerCase();
			return type === 'text';
		}
		return false;
	}

	/** A text box of the page that gets a "Mentions" row (not code / search / hidden / read-only boxes). */
	private _eligibleBox(el: EventTarget | Node | null): HTMLInputElement | HTMLTextAreaElement | undefined {
		if (!this._isTextBox(el) || el.readOnly || el.disabled || el.hidden || !this._root.contains(el)) {
			return undefined;
		}
		if (INPUT_SKIP_CLASS_RE.test(el.className) || el.closest(INPUT_SKIP_SELECTOR)) {
			return undefined;
		}
		return el;
	}

	private _boxesUnder(node: Node): Array<HTMLInputElement | HTMLTextAreaElement> {
		if (!isHTMLElement(node)) {
			return [];
		}
		const out: Array<HTMLInputElement | HTMLTextAreaElement> = [];
		for (const el of [node, ...elementsUnder(node, e => e.tagName === 'TEXTAREA' || e.tagName === 'INPUT')]) {
			const box = this._eligibleBox(el);
			if (box) {
				out.push(box);
			}
		}
		return out;
	}

	private _scheduleRow(box: HTMLInputElement | HTMLTextAreaElement): void {
		const win = getWindow(this._root);
		const pending = this._rowTimers.get(box);
		if (pending !== undefined) {
			win.clearTimeout(pending);
		}
		this._rowTimers.set(box, win.setTimeout(() => {
			this._rowTimers.delete(box);
			this._mutate(() => this._updateRow(box));
		}, TicketMentionController.ROW_DEBOUNCE_MS));
	}

	/** Shows, updates or removes the "Mentions" row of a text box. */
	private _updateRow(box: HTMLInputElement | HTMLTextAreaElement): void {
		const existing = this._rows.get(box);
		const visible = box.isConnected && box.getClientRects().length > 0;
		const entries = visible
			? uniqueTicketIds(findTicketIdMentions(box.value)).map(id => this._known(id)).filter((e): e is ITicketSearchEntry => !!e)
			: [];
		if (entries.length === 0) {
			if (existing) {
				existing.remove();
				this._rows.delete(box);
			}
			return;
		}
		const signature = entries.map(e => `${e.ticketId}|${e.title}|${e.status ?? ''}`).join(',');
		if (existing && existing.isConnected && existing.getAttribute('data-signature') === signature) {
			return;
		}
		const row = existing ?? $(`div.${ROW_CLASS}`, { 'aria-label': 'Ticket mentions' });
		row.setAttribute('data-signature', signature);
		row.replaceChildren(
			$('span.label', { title: `Tickets mentioned in this field (${isMacintosh ? 'Cmd' : 'Ctrl'}+click an ID in the text to open it)` }, 'Mentions:'),
			...entries.map(e => this._createChip(e, true))
		);
		if (!row.isConnected) {
			const anchor = this._rowAnchor(box);
			anchor.after(row);
			this._rows.set(box, row);
		}
	}

	/** The row goes right under the text box, or under its line when the box sits in a horizontal flex row. */
	private _rowAnchor(box: HTMLElement): HTMLElement {
		const parent = box.parentElement;
		if (!parent || parent === this._root) {
			return box;
		}
		const style = getWindow(box).getComputedStyle(parent);
		const horizontal = (style.display === 'flex' || style.display === 'inline-flex') && !style.flexDirection.startsWith('column');
		return horizontal && parent.parentElement && parent !== this._root ? parent : box;
	}

	private _pruneRows(): void {
		for (const [box, row] of this._rows) {
			if (!box.isConnected) {
				row.remove();
				this._rows.delete(box);
			}
		}
	}

	/** Cmd+click (macOS) / Ctrl+click on an ID inside a text box opens that ticket. */
	private _onBoxClick(e: MouseEvent): void {
		if (!(isMacintosh ? e.metaKey : e.ctrlKey) || !this._isTextBox(e.target)) {
			return;
		}
		const box = e.target;
		if (box.closest(`[${NO_TICKET_MENTIONS_ATTRIBUTE}]`)) {
			return;
		}
		const offset = box.selectionStart;
		if (typeof offset !== 'number') {
			return;
		}
		const mention = ticketIdMentionAt(box.value, offset);
		const entry = mention ? this._known(mention.id) : undefined;
		if (entry) {
			e.preventDefault();
			e.stopPropagation();
			this._mentionService.open(entry, e.altKey);
		}
	}
}
