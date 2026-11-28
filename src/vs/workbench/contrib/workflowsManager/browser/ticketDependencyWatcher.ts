/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { getTicketDependencyUpdater, TicketDependencyUpdater } from './ticketDependencyUpdater.js';

/**
 * Depends On (CI-59): new run outcomes written outside the run code of this window (another window, a tool) reach the
 * dependents too. The file watchers cover every managed workspace (UI-30): a changed `.agents/last_run.json` or
 * `.agents/workflow_runs.json` re-evaluates the dependents of that ticket (debounced per ticket; the updater skips an
 * outcome it already processed), and a changed ticket.md drops the cached Depends On index.
 *
 * Follow Children (CI-62): a written ticket.md (a manual edit in the UI, an AI edit, an external edit) is handed to the
 * updater, which re-evaluates the parent when the Status or Result changed; a created ticket.md is a new child, a
 * deleted ticket folder a removed one. The baseline of the existing tickets is taken once after startup (read only),
 * so nothing changes until a ticket changes.
 */
class TicketDependencyWatcher extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.ticketDependencyWatcher';
	private static readonly DELAY_MS = 1500;
	private static readonly PRIME_DELAY_MS = 4000;

	private readonly _updater: TicketDependencyUpdater;
	private readonly _pending = new Map<string, ReturnType<typeof setTimeout>>();
	/** Change keys whose ticket.md was created (a new child) within the debounce window. */
	private readonly _created = new Set<string>();

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspacesExplorerService workspacesExplorerService: IWorkspacesExplorerService,
		@ICustomModulesService customModulesService: ICustomModulesService,
		@ILogService logService: ILogService
	) {
		super();
		this._updater = getTicketDependencyUpdater({ fileService, workspacesExplorerService, customModulesService, logService });
		this._register(fileService.onDidFilesChange(e => {
			const added = new Set(e.rawAdded.map(u => u.toString()));
			for (const uri of [...e.rawAdded, ...e.rawUpdated]) {
				const m = /^(.*)\/\.agents\/(last_run\.json|workflow_runs\.json|ticket\.md)$/i.exec(uri.path);
				if (!m) {
					continue;
				}
				const folder = uri.with({ path: m[1] });
				if (m[2].toLowerCase() === 'ticket.md') {
					this._updater.invalidate();
					const key = `change:${folder.toString()}`;
					if (added.has(uri.toString())) {
						this._created.add(key);
					}
					this._schedule(key, () => this._updater.onTicketChanged(folder, this._created.delete(key)));
					continue;
				}
				this._schedule(`outcome:${folder.toString()}`, () => this._updater.onOutcome(folder));
			}
			for (const uri of e.rawDeleted) {
				const m = /^(.*?)(\/\.agents(\/ticket\.md)?)?$/i.exec(uri.path);
				const folder = uri.with({ path: m ? m[1] : uri.path });
				if (this._updater.isKnownTicketFolder(folder)) {
					this._updater.invalidate();
					this._schedule(`removed:${folder.toString()}`, () => this._updater.onTicketRemoved(folder));
				}
			}
		}));
		const primeTimer = setTimeout(() => {
			workspacesExplorerService.getWorkspaces()
				.then(workspaces => this._updater.prime(workspaces.map(w => w.uri)))
				.catch(err => logService.warn('[TicketDependencies] Failed to take the ticket baseline:', err));
		}, TicketDependencyWatcher.PRIME_DELAY_MS);
		this._register({ dispose: () => { clearTimeout(primeTimer); for (const t of this._pending.values()) { clearTimeout(t); } this._pending.clear(); } });
	}

	private _schedule(key: string, work: () => Promise<void>): void {
		const existing = this._pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this._pending.set(key, setTimeout(() => {
			this._pending.delete(key);
			void work();
		}, TicketDependencyWatcher.DELAY_MS));
	}
}

registerWorkbenchContribution2(TicketDependencyWatcher.ID, TicketDependencyWatcher, WorkbenchPhase.Eventually);
