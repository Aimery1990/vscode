/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';
import { IHumanDecision, IHumanDecisionRequest, IHumanDecisionService, IPendingHumanDecision, PendingHumanDecisions, ticketKeyOf } from '../common/humanDecision.js';

/**
 * Pending human decisions of Button Group gates (CI-25). Reveals the waiting ticket (split right) and shows a sticky
 * notification whose action reveals it again; the ticket page, the workflow canvas and resumeWorkflow resolve the decision.
 * Pending decisions live in memory only: a reload ends the waiting runs (like the other human-in-the-loop waits).
 */
export class HumanDecisionService extends Disposable implements IHumanDecisionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _pending = new PendingHumanDecisions(() => this._onDidChange.fire());
	private readonly _notifications = new Map<string, INotificationHandle>();

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService
	) {
		super();
	}

	getPending(): readonly IPendingHumanDecision[] {
		return this._pending.list();
	}

	findForTicketField(ticket: { readonly uri?: string; readonly ticketId?: string }, field: { readonly id?: string; readonly label?: string }): IPendingHumanDecision | undefined {
		return this._pending.findForTicketField(ticket, field);
	}

	findForWorkflowRun(runId: string): IPendingHumanDecision | undefined {
		return this._pending.findForWorkflowRun(runId);
	}

	async request(request: IHumanDecisionRequest, isCancelled?: () => boolean, stopRun?: () => void): Promise<IHumanDecision | undefined> {
		const { entry, promise } = this._pending.add(request, Date.now(), stopRun);
		this._notify(entry);
		this._revealTicket(entry).catch(() => undefined);
		let timer: number | undefined;
		if (isCancelled) {
			timer = mainWindow.setInterval(() => {
				if (isCancelled()) {
					this.cancel(entry.id);
				}
			}, 400);
		}
		try {
			return await promise;
		} finally {
			if (timer) {
				mainWindow.clearInterval(timer);
			}
			this._notifications.get(entry.id)?.close();
			this._notifications.delete(entry.id);
		}
	}

	resolve(id: string, input: unknown, by = 'User'): IHumanDecision | undefined {
		return this._pending.resolve(id, input, by);
	}

	stopRun(id: string): void {
		this._pending.stopRun(id);
	}

	cancel(id: string): void {
		this._pending.cancel(id);
	}

	cancelForWorkflowRun(runId: string): void {
		for (const p of this._pending.list()) {
			if (p.workflowRunId === runId) {
				this._pending.cancel(p.id);
			}
		}
	}

	cancelAll(): void {
		for (const p of this._pending.list()) {
			this._pending.cancel(p.id);
		}
	}

	private _notify(entry: IPendingHumanDecision): void {
		const choices = entry.ticketUri
			? [{ label: 'Show Ticket', run: () => { this._revealTicket(entry, true).catch(() => undefined); } }]
			: [];
		const handle = this._notificationService.prompt(Severity.Info, entry.prompt, choices, { sticky: true });
		this._notifications.set(entry.id, handle);
	}

	/**
	 * Shows the waiting ticket so the person sees what they approve: an open copy is revealed in its group (unless it is
	 * already visible); otherwise the ticket opens in the group to the right of the active one (split right), keeping
	 * the workflow canvas visible.
	 */
	private async _revealTicket(entry: IPendingHumanDecision, force = false): Promise<void> {
		if (!entry.ticketUri) {
			return;
		}
		const key = ticketKeyOf(entry.ticketUri);
		const isTicket = (editor: EditorInput): editor is EntityDetailEditorInput =>
			editor instanceof EntityDetailEditorInput && !editor.isDisposed() && !editor.previewModule && ticketKeyOf(editor.entityUri.toString()) === key;
		if (!force && this._editorService.visibleEditors.some(isTicket)) {
			return;
		}
		for (const group of this._editorGroupsService.groups) {
			const existing = group.editors.find(isTicket);
			if (existing) {
				await group.openEditor(existing, { preserveFocus: false });
				return;
			}
		}
		await this._editorService.openEditor(new EntityDetailEditorInput(URI.parse(entry.ticketUri), entry.ticketTitle || entry.ticketId || 'Ticket'), { pinned: true, preserveFocus: false }, SIDE_GROUP);
	}

	override dispose(): void {
		this.cancelAll();
		super.dispose();
	}
}
