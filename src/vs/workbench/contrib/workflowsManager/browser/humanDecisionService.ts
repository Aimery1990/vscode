/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EntityDetailEditorInput } from '../../workspacesExplorer/browser/entityDetailEditorInput.js';
import { IHumanDecision, IHumanDecisionRequest, IHumanDecisionService, IPendingHumanDecision, PendingHumanDecisions } from '../common/humanDecision.js';

/**
 * Pending human decisions of Button Group gates (CI-25). Shows a sticky notification per waiting gate with an action
 * that opens the ticket; the ticket page, the workflow canvas and resumeWorkflow resolve the decision.
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
		@IEditorService private readonly _editorService: IEditorService
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

	async request(request: IHumanDecisionRequest, isCancelled?: () => boolean): Promise<IHumanDecision | undefined> {
		const { entry, promise } = this._pending.add(request);
		this._notify(entry);
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
			? [{
				label: 'Open Ticket',
				run: () => {
					const uri = URI.parse(entry.ticketUri!);
					this._editorService.openEditor(new EntityDetailEditorInput(uri, entry.ticketTitle || entry.ticketId || 'Ticket'), { pinned: true });
				}
			}]
			: [];
		const handle = this._notificationService.prompt(Severity.Info, entry.prompt, choices, { sticky: true });
		this._notifications.set(entry.id, handle);
	}

	override dispose(): void {
		this.cancelAll();
		super.dispose();
	}
}
