/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { writeTicketFile } from '../../workspacesExplorer/browser/ticketChangeRecorder.js';
import {
	DEPENDENCY_OUTCOME_FILE_NAME, DependencyEvaluation, evaluateDependencies, IDependencyState, IOutcomeRecord, IPropagationStep, buildDependentsIndex,
	latestOutcome, parseDerivedOutcome, propagateDependencies, readDependsOn, readFollowDependencies, readResultFieldValue, resultValueFor,
	serializeDerivedOutcome, setResultFieldValue, workflowRunOutcome
} from '../../workspacesExplorer/common/ticketDependencies.js';
import { lastRunOutcome, parseTicketLastRunRecord, parseWorkflowRunsHead, TICKET_LAST_RUN_FILE_NAME } from '../../workspacesExplorer/common/ticketFailure.js';
import { readTicketStatus, readTopLevelMetadata, setTicketStatusLine } from '../../workspacesExplorer/common/workspaceLifecycle.js';
import { decideStatusAfterRun } from '../common/runCompletionStatus.js';
import { IRunCompletionStatusDeps, loadTicketStatusSettings } from './runCompletionStatus.js';

/**
 * Depends On (CI-59), the live side: when a ticket gets a new run outcome (its `last_run.json`, its workflow run, or a
 * derived outcome), every ticket depending on it is re-evaluated and moved to its CI-58 "on successful / failed run"
 * status (Result Pass / Fail too), recorded through writeTicketFile as the Workflow with a summary naming the trigger.
 * Chains propagate (see `propagateDependencies`). Work is queued (one evaluation at a time); the same outcome of a
 * ticket is processed once, whether it is reported by the run code or by the file watcher.
 */

interface ITicketIndexEntry {
	readonly id: string;
	readonly folder: URI;
	readonly dependsOn: readonly string[];
}

interface IWorkspaceIndex {
	readonly builtAt: number;
	readonly byId: Map<string, ITicketIndexEntry>;
	readonly byFolder: Map<string, ITicketIndexEntry>;
	readonly dependents: Map<string, string[]>;
}

/** One change made by the updater (for logs and tests). */
export interface IDependencyUpdate {
	readonly ticketId: string;
	readonly triggerId: string;
	readonly depth: number;
	readonly evaluation: DependencyEvaluation['result'];
	readonly status?: string;
	readonly result?: string;
	readonly summary: string;
}

const INDEX_TTL_MS = 15000;
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_NODES = 5000;
const SKIPPED_FOLDERS = new Set(['node_modules', 'attachments', 'worklogs', 'fields', '__pycache__']);
const TICKET_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const folderKey = (uri: URI) => uri.toString().replace(/\/+$/, '').toLowerCase();

export class TicketDependencyUpdater {
	private _queue: Promise<unknown> = Promise.resolve();
	private readonly _indexes = new Map<string, IWorkspaceIndex>();
	/** Outcomes reported by the run code before they are on disk (a workflow run's), by folder key. */
	private readonly _overrides = new Map<string, IOutcomeRecord>();
	/** Last outcome processed per folder key (`status@at`). */
	private readonly _processed = new Map<string, string>();
	/** Every change made, newest last (capped). */
	readonly updates: IDependencyUpdate[] = [];

	constructor(private readonly _deps: IRunCompletionStatusDeps) { }

	/** Drops the cached ticket indexes (a ticket.md changed: Depends On may have changed). */
	invalidate(): void {
		this._indexes.clear();
	}

	/** Resolves when every queued evaluation has finished. */
	whenIdle(): Promise<void> {
		return this._queue.then(() => undefined, () => undefined);
	}

	/**
	 * `ticketFolder` got a new outcome: re-evaluates its dependents (queued). `override` is the outcome when the caller
	 * knows it before it is written (a workflow run). Never throws.
	 */
	onOutcome(ticketFolder: URI, override?: IOutcomeRecord): Promise<void> {
		if (override) {
			this._overrides.set(folderKey(ticketFolder), override);
		}
		const run = () => this._process(ticketFolder).catch(err => this._deps.logService.warn('[TicketDependencies] Failed to update the dependents:', err));
		const next = this._queue.then(run, run);
		this._queue = next;
		return next;
	}

	private async _process(folder: URI): Promise<void> {
		const outcome = await this._readOutcome(folder);
		const key = folderKey(folder);
		if (!outcome) {
			return;
		}
		const stamp = `${outcome.status}@${outcome.at}`;
		if (this._processed.get(key) === stamp) {
			return;
		}
		this._processed.set(key, stamp);
		const index = await this._indexFor(folder);
		const self = index.byFolder.get(key);
		const selfId = self?.id ?? await this._ticketIdOf(folder);
		if (!selfId || !index.dependents.has(selfId)) {
			return;
		}
		await propagateDependencies(selfId, index.dependents, step => this._evaluate(index, step));
	}

	/** Re-evaluates one dependent; true when its (derived) outcome changed, so its own dependents follow. */
	private async _evaluate(index: IWorkspaceIndex, step: IPropagationStep): Promise<boolean> {
		const entry = index.byId.get(step.ticketId);
		if (!entry) {
			return false;
		}
		const ticketMdUri = URI.joinPath(entry.folder, '.agents', 'ticket.md');
		let text: string;
		try {
			text = (await this._deps.fileService.readFile(ticketMdUri)).value.toString();
		} catch {
			return false;
		}
		if (!readFollowDependencies(text)) {
			return false;
		}
		const states: IDependencyState[] = [];
		for (const id of readDependsOn(text)) {
			const dep = index.byId.get(id);
			states.push({ id, outcome: dep ? await this._readOutcome(dep.folder) : undefined });
		}
		const evaluation = evaluateDependencies(states);
		if (evaluation.result !== 'success' && evaluation.result !== 'failed') {
			return false;
		}
		const trigger = evaluation.result === 'failed' ? (evaluation.failedIds.includes(step.triggerId) ? step.triggerId : evaluation.failedIds[0]) : step.triggerId;
		const settings = await loadTicketStatusSettings(this._deps, entry.folder, text);
		const decision = decideStatusAfterRun({
			outcome: evaluation.result,
			setting: settings.success,
			failureSetting: settings.failure,
			currentStatus: readTicketStatus(text),
			templateStatuses: settings.templateStatuses,
			lifecycle: settings.lifecycle
		});
		let next = text;
		let status: string | undefined;
		if (decision.action === 'set') {
			next = setTicketStatusLine(next, decision.status) ?? next;
			status = decision.status;
		}
		const wantedResult = resultValueFor(evaluation);
		const currentResult = readResultFieldValue(next);
		let result: string | undefined;
		if (wantedResult && currentResult !== undefined && currentResult !== wantedResult) {
			next = setResultFieldValue(next, wantedResult);
			result = wantedResult;
		}
		const what = evaluation.result === 'failed' ? 'last run failed' : (step.depth > 1 || states.length > 1 ? 'all dependencies succeeded' : 'last run succeeded');
		const changes = [status, result ? `Result ${result}` : undefined].filter(Boolean).join(', ');
		const summary = `Depends On ${trigger}: ${what} → ${changes || `no change (${decision.action === 'keep' ? decision.reason : 'already set'})`}`;
		if (next !== text) {
			await writeTicketFile(this._deps.fileService, ticketMdUri, next, { kind: 'Workflow', name: summary });
		}
		this._deps.logService.info(`[TicketDependencies] ${entry.id}: ${summary}`);
		this.updates.push({ ticketId: entry.id, triggerId: trigger, depth: step.depth, evaluation: evaluation.result, status, result, summary });
		if (this.updates.length > 200) {
			this.updates.shift();
		}
		// The dependency-driven outcome of this ticket, for the tickets that depend on it (chains)
		const before = await this._readOutcome(entry.folder);
		const derivedUri = URI.joinPath(entry.folder, '.agents', DEPENDENCY_OUTCOME_FILE_NAME);
		await this._deps.fileService.writeFile(derivedUri, VSBuffer.fromString(serializeDerivedOutcome(evaluation.result, new Date(), trigger)));
		return before?.status !== evaluation.result;
	}

	/** The latest outcome of a ticket: its own run, its workflow run, a derived one, or one reported by the run code. */
	private async _readOutcome(folder: URI): Promise<IOutcomeRecord | undefined> {
		const read = async (name: string, length: number) => {
			try {
				return (await this._deps.fileService.readFile(URI.joinPath(folder, '.agents', name), { length })).value.toString();
			} catch {
				return undefined;
			}
		};
		const lastRun = parseTicketLastRunRecord(await read(TICKET_LAST_RUN_FILE_NAME, 16384));
		// a run stopped by a person is no outcome (not a failure)
		const ownStatus = lastRunOutcome(lastRun);
		const own: IOutcomeRecord | undefined = lastRun && ownStatus ? { status: ownStatus, at: Date.parse(lastRun.at), source: 'run' } : undefined;
		const head = parseWorkflowRunsHead(await read('workflow_runs.json', 4096));
		const derivedText = await read(DEPENDENCY_OUTCOME_FILE_NAME, 4096);
		return latestOutcome([own, workflowRunOutcome(head?.status, head?.at), derivedText ? parseDerivedOutcome(derivedText) : undefined, this._overrides.get(folderKey(folder))]);
	}

	private async _ticketIdOf(folder: URI): Promise<string | undefined> {
		try {
			const text = (await this._deps.fileService.readFile(URI.joinPath(folder, '.agents', 'ticket.md'), { length: 4096 })).value.toString();
			const id = readTopLevelMetadata(text, 'Ticket ID');
			if (id) {
				return id.trim().toUpperCase();
			}
		} catch {
			// no ticket.md
		}
		const name = folder.path.split('/').filter(Boolean).pop() || '';
		return TICKET_ID_RE.test(name) ? name.toUpperCase() : undefined;
	}

	private async _indexFor(folder: URI): Promise<IWorkspaceIndex> {
		let root: URI;
		try {
			root = await this._deps.workspacesExplorerService.findWorkspaceRootUri(folder);
		} catch {
			root = URI.joinPath(folder, '..');
		}
		const key = folderKey(root);
		const cached = this._indexes.get(key);
		if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
			return cached;
		}
		const index = await this._scan(root);
		this._indexes.set(key, index);
		return index;
	}

	/** Every ticket folder under the workspace root (ID, Depends On) and the reverse index. */
	private async _scan(root: URI): Promise<IWorkspaceIndex> {
		const fileService: IFileService = this._deps.fileService;
		const byId = new Map<string, ITicketIndexEntry>();
		const byFolder = new Map<string, ITicketIndexEntry>();
		let nodes = 0;
		const walk = async (dir: URI, depth: number): Promise<void> => {
			if (depth > MAX_SCAN_DEPTH || nodes >= MAX_SCAN_NODES) {
				return;
			}
			nodes++;
			let children;
			try {
				children = (await fileService.resolve(dir)).children ?? [];
			} catch {
				return;
			}
			if (depth > 0 && children.some(c => c.isDirectory && c.name === '.agents')) {
				try {
					const text = (await fileService.readFile(URI.joinPath(dir, '.agents', 'ticket.md'))).value.toString();
					const name = dir.path.split('/').filter(Boolean).pop() || '';
					const id = (readTopLevelMetadata(text, 'Ticket ID') || (TICKET_ID_RE.test(name) ? name : '')).trim().toUpperCase();
					if (id) {
						const entry: ITicketIndexEntry = { id, folder: dir, dependsOn: readDependsOn(text) };
						byId.set(id, entry);
						byFolder.set(folderKey(dir), entry);
					}
				} catch {
					// a folder without ticket.md
				}
			}
			await Promise.all(children.filter(c => c.isDirectory && !c.name.startsWith('.') && !SKIPPED_FOLDERS.has(c.name.toLowerCase())).map(c => walk(c.resource, depth + 1)));
		};
		await walk(root, 0);
		const dependsOn = new Map<string, readonly string[]>();
		for (const e of byId.values()) {
			if (e.dependsOn.length > 0) {
				dependsOn.set(e.id, e.dependsOn);
			}
		}
		return { builtAt: Date.now(), byId, byFolder, dependents: buildDependentsIndex(dependsOn) };
	}
}

const updaters = new WeakMap<IFileService, TicketDependencyUpdater>();

/** The updater of these services (one per file service, so the run code and the file watcher share it). */
export function getTicketDependencyUpdater(deps: IRunCompletionStatusDeps): TicketDependencyUpdater {
	let updater = updaters.get(deps.fileService);
	if (!updater) {
		updater = new TicketDependencyUpdater(deps);
		updaters.set(deps.fileService, updater);
	}
	return updater;
}

/** Drops the cached Depends On index of these services, if an updater exists (after a Depends On edit). */
export function invalidateTicketDependencyIndex(fileService: IFileService): void {
	updaters.get(fileService)?.invalidate();
}
