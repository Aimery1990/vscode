/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
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
 */
class TicketDependencyWatcher extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.ticketDependencyWatcher';
	private static readonly DELAY_MS = 1500;

	private readonly _updater: TicketDependencyUpdater;
	private readonly _pending = new Map<string, { folder: URI; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspacesExplorerService workspacesExplorerService: IWorkspacesExplorerService,
		@ICustomModulesService customModulesService: ICustomModulesService,
		@ILogService logService: ILogService
	) {
		super();
		this._updater = getTicketDependencyUpdater({ fileService, workspacesExplorerService, customModulesService, logService });
		this._register(fileService.onDidFilesChange(e => {
			for (const uri of [...e.rawAdded, ...e.rawUpdated]) {
				const m = /^(.*)\/\.agents\/(last_run\.json|workflow_runs\.json|ticket\.md)$/i.exec(uri.path);
				if (!m) {
					continue;
				}
				if (m[2].toLowerCase() === 'ticket.md') {
					this._updater.invalidate();
					continue;
				}
				this._schedule(uri.with({ path: m[1] }));
			}
		}));
		this._register({ dispose: () => { for (const p of this._pending.values()) { clearTimeout(p.timer); } this._pending.clear(); } });
	}

	private _schedule(folder: URI): void {
		const key = folder.toString();
		const existing = this._pending.get(key);
		if (existing) {
			clearTimeout(existing.timer);
		}
		const timer = setTimeout(() => {
			this._pending.delete(key);
			void this._updater.onOutcome(folder);
		}, TicketDependencyWatcher.DELAY_MS);
		this._pending.set(key, { folder, timer });
	}
}

registerWorkbenchContribution2(TicketDependencyWatcher.ID, TicketDependencyWatcher, WorkbenchPhase.Eventually);
