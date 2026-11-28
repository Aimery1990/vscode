/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { writeTicketFile } from '../../workspacesExplorer/browser/ticketChangeRecorder.js';
import {
	DEPENDENCY_OUTCOME_FILE_NAME, DependencyEvaluation, evaluateDependencies, IDependencyState, IOutcomeRecord, IPropagationStep, buildDependentsIndex,
	latestOutcome, MAX_DEPENDENCY_DEPTH, parseDerivedOutcome, propagateDependencies, readDependsOn, readFollowDependencies, readResultFieldValue, resultValueFor,
	serializeDerivedOutcome, setResultFieldValue, workflowRunOutcome
} from '../../workspacesExplorer/common/ticketDependencies.js';
import {
	buildFollowersIndex, canFollow, childOutcome, evaluateFollowedTickets, explicitDependencyOutcome, followersAfterTicketChange, IFollowedState, readFollowChildren
} from '../../workspacesExplorer/common/ticketFollowChildren.js';
import { detectTicketFailure, lastRunOutcome, parseTicketLastRunRecord, parseWorkflowRunsHead, TICKET_LAST_RUN_FILE_NAME } from '../../workspacesExplorer/common/ticketFailure.js';
import { readTicketStatus, readTopLevelMetadata, setTicketStatusLine } from '../../workspacesExplorer/common/workspaceLifecycle.js';
import { CanonicalStatusCategory, IWorkspaceStatusesInfo } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { decideStatusAfterRun } from '../common/runCompletionStatus.js';
import { IRunCompletionStatusDeps, loadTicketStatusSettings } from './runCompletionStatus.js';

/**
 * Depends On (CI-59), the live side: when a ticket gets a new run outcome (its `last_run.json`, its workflow run, or a
 * derived outcome), every ticket depending on it is re-evaluated and moved to its CI-58 "on successful / failed run"
 * status (Result Pass / Fail too), recorded through writeTicketFile as the Workflow with a summary naming the trigger.
 * Chains propagate (see `propagateDependencies`). Work is queued (one evaluation at a time); the same outcome of a
 * ticket is processed once, whether it is reported by the run code or by the file watcher.
 *
 * Follow Children (CI-62): a ticket's direct children are implicit dependencies (see ticketFollowChildren.ts). A
 * child's ticket.md whose Status or Result changed (compared with the last version seen: only NEW changes count, the
 * baseline is taken by {@link TicketDependencyUpdater.prime} at startup without changing anything), a child added or
 * a child removed re-evaluates the parent, and up the chain.
 */

interface ITicketIndexEntry {
	readonly id: string;
	readonly folder: URI;
	readonly dependsOn: readonly string[];
	/** The nearest ticket folder above this one (its parent ticket), if any. */
	readonly parentId?: string;
	/** Status / Result signature when scanned (the change baseline). */
	readonly signature: string;
}

interface IWorkspaceIndex {
	readonly builtAt: number;
	readonly root: URI;
	readonly byId: Map<string, ITicketIndexEntry>;
	readonly byFolder: Map<string, ITicketIndexEntry>;
	/** Explicit Depends On: dependency → dependents. */
	readonly dependents: Map<string, string[]>;
	readonly parentOf: Map<string, string>;
	readonly childrenOf: Map<string, string[]>;
	/** Propagation graph: ticket → explicit dependents + parent. */
	readonly followers: Map<string, string[]>;
}

/** Status / Result of a ticket.md: what a "child change" (CI-62) compares. */
function ticketSignature(text: string): string {
	return `${(readTicketStatus(text) || '').trim().toLowerCase()}\u0000${(readResultFieldValue(text) ?? '\u0001').trim().toLowerCase()}`;
}

/** Category of a status by its name when the workspace lifecycle does not know it. */
function guessCategory(status: string | undefined): CanonicalStatusCategory {
	const s = (status || '').toLowerCase();
	if (/remove|cancel|archive|discard/.test(s)) { return 'Removed'; }
	if (/block|fail/.test(s)) { return 'Blocked'; }
	if (/done|complete|closed|resolved|finish/.test(s)) { return 'Done'; }
	if (/progress|review|verif|doing|testing/.test(s)) { return 'In Progress'; }
	return 'Todo';
}

function categoryOf(status: string | undefined, lifecycle: IWorkspaceStatusesInfo | undefined): CanonicalStatusCategory {
	if (lifecycle) {
		try {
			return lifecycle.getCategory(status);
		} catch {
			// fall back to the name
		}
	}
	return guessCategory(status);
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
	/** Last seen Status / Result signature per ticket folder key (CI-62 change baseline). */
	private readonly _signatures = new Map<string, string>();
	/** Workspace roots whose baseline was taken (a ticket.md first seen there later is new). */
	private readonly _primedRoots = new Set<string>();
	/** Every change made, newest last (capped). */
	readonly updates: IDependencyUpdate[] = [];

	constructor(private readonly _deps: IRunCompletionStatusDeps) { }

	/** Drops the cached ticket indexes (a ticket.md changed: Depends On may have changed). */
	invalidate(): void {
		this._indexes.clear();
	}

	/** Whether `folder` is a ticket folder seen by a scan or a change (a deleted folder that was a ticket, CI-62). */
	isKnownTicketFolder(folder: URI): boolean {
		return this._signatures.has(folderKey(folder));
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
		return this._enqueue(() => this._process(ticketFolder));
	}

	/**
	 * CI-62: `ticketFolder`'s ticket.md was written (`added`: created). When its Status or Result changed since it was
	 * last seen, its parent (and, for a Result change, its explicit dependents) are re-evaluated, then up the chain.
	 * A ticket first seen in a workspace whose baseline was not taken yet only records the baseline. Never throws.
	 */
	onTicketChanged(ticketFolder: URI, added = false): Promise<void> {
		return this._enqueue(() => this._processTicketChange(ticketFolder, added));
	}

	/** CI-62: a ticket folder (or its ticket.md) was deleted: the nearest ticket above it is re-evaluated. */
	onTicketRemoved(removed: URI): Promise<void> {
		return this._enqueue(() => this._processRemoval(removed));
	}

	/**
	 * Takes the Status / Result baseline of every ticket under these workspace roots (read only, nothing changes), so
	 * only changes made from now on count (no sweep of existing tickets).
	 */
	prime(roots: readonly URI[]): Promise<void> {
		return this._enqueue(async () => {
			for (const root of roots) {
				await this._indexForRoot(root);
				this._primedRoots.add(folderKey(root));
			}
		});
	}

	private _enqueue(work: () => Promise<void>): Promise<void> {
		const run = () => work().catch(err => this._deps.logService.warn('[TicketDependencies] Failed to update the followers:', err));
		const next = this._queue.then(run, run);
		this._queue = next;
		return next;
	}

	private async _readTicketMd(folder: URI): Promise<string | undefined> {
		try {
			return (await this._deps.fileService.readFile(URI.joinPath(folder, '.agents', 'ticket.md'))).value.toString();
		} catch {
			return undefined;
		}
	}

	private async _processTicketChange(folder: URI, added: boolean): Promise<void> {
		const text = await this._readTicketMd(folder);
		if (text === undefined) {
			return;
		}
		const key = folderKey(folder);
		const signature = ticketSignature(text);
		const previous = this._signatures.get(key);
		this._signatures.set(key, signature);
		if (previous === signature) {
			return;
		}
		if (added) {
			this.invalidate();
		}
		const index = await this._indexFor(folder);
		if (previous === undefined && !added && !this._primedRoots.has(folderKey(index.root))) {
			return; // no baseline yet: this version is the baseline
		}
		const selfId = index.byFolder.get(key)?.id ?? await this._ticketIdOf(folder);
		if (!selfId) {
			return;
		}
		const resultNow = signature.split('\u0000')[1];
		const resultChanged = resultNow !== '\u0001' && (previous === undefined || previous.split('\u0000')[1] !== resultNow);
		const first = followersAfterTicketChange(selfId, index.parentOf, index.dependents, resultChanged);
		if (first.length > 0) {
			await propagateDependencies(selfId, index.followers, step => this._evaluate(index, step), MAX_DEPENDENCY_DEPTH, first);
		}
	}

	private async _processRemoval(removed: URI): Promise<void> {
		let folder = removed;
		while (/\/(\.agents|ticket\.md)$/i.test(folder.path)) {
			folder = dirname(folder);
		}
		const removedName = folder.path.split('/').filter(Boolean).pop() || '';
		this._signatures.delete(folderKey(folder));
		this.invalidate();
		// the nearest folder above with a ticket.md (not the workspace root: a root ticket never follows)
		let root: URI | undefined;
		try {
			root = await this._deps.workspacesExplorerService.findWorkspaceRootUri(folder);
		} catch {
			root = undefined;
		}
		for (let i = 0; i < MAX_SCAN_DEPTH; i++) {
			const up = dirname(folder);
			if (up.path === folder.path || (root && folderKey(up) === folderKey(root))) {
				return;
			}
			folder = up;
			if (await this._readTicketMd(folder) !== undefined) {
				break;
			}
		}
		const index = await this._indexFor(folder);
		const parent = index.byFolder.get(folderKey(folder));
		if (!parent) {
			return;
		}
		const trigger = TICKET_ID_RE.test(removedName) ? removedName.toUpperCase() : `${parent.id}/${removedName}`;
		await propagateDependencies(trigger, index.followers, step => this._evaluate(index, step), MAX_DEPENDENCY_DEPTH, [parent.id]);
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
		// the run already wrote this ticket's status: that version is seen (the watcher's event is no new change)
		const selfText = await this._readTicketMd(folder);
		if (selfText !== undefined) {
			this._signatures.set(key, ticketSignature(selfText));
		}
		if (!selfId || !index.followers.has(selfId)) {
			return;
		}
		await propagateDependencies(selfId, index.followers, step => this._evaluate(index, step));
	}

	/**
	 * Re-evaluates one ticket from its explicit dependencies (CI-59) and its children (CI-62); true when its status /
	 * Result or its (derived) outcome changed, so its own followers are visited.
	 */
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
		const followDeps = readFollowDependencies(text);
		const followChildren = readFollowChildren(text);
		if (!followDeps && !followChildren) {
			return false;
		}
		const settings = await loadTicketStatusSettings(this._deps, entry.folder, text);
		const type = readTopLevelMetadata(text, 'Ticket Type') || readTopLevelMetadata(text, 'Type');
		if (!canFollow(type, categoryOf(readTicketStatus(text), settings.lifecycle))) {
			return false; // a workspace root ticket, or a Removed ticket: never changed automatically
		}
		const dependencies: IFollowedState[] = [];
		const states: IDependencyState[] = [];
		if (followDeps) {
			for (const id of readDependsOn(text)) {
				const dep = index.byId.get(id);
				const outcome = dep ? await this._readOutcome(dep.folder) : undefined;
				const depText = dep ? await this._readTicketMd(dep.folder) : undefined;
				states.push({ id, outcome });
				dependencies.push({ id, outcome: explicitDependencyOutcome(outcome, depText !== undefined ? readResultFieldValue(depText) : undefined) });
			}
		}
		const children: IFollowedState[] = [];
		if (followChildren) {
			for (const childId of index.childrenOf.get(entry.id) ?? []) {
				const child = index.byId.get(childId);
				const childText = child ? await this._readTicketMd(child.folder) : undefined;
				if (!child || childText === undefined) {
					continue;
				}
				const status = readTicketStatus(childText);
				const category = categoryOf(status, settings.lifecycle);
				const resultValue = readResultFieldValue(childText);
				let failing = false;
				if (resultValue === undefined && category !== 'Removed') {
					const lastRun = parseTicketLastRunRecord(await this._readAgentsFile(child.folder, TICKET_LAST_RUN_FILE_NAME, 16384));
					const workflowRun = parseWorkflowRunsHead(await this._readAgentsFile(child.folder, 'workflow_runs.json', 4096));
					failing = !!detectTicketFailure({ status, removed: false, lastRun, workflowRun });
				}
				const outcome = childOutcome({ resultValue, statusCategory: category, failing });
				if (outcome !== 'ignored') {
					children.push({ id: childId, outcome });
				}
			}
		}
		// Without children (and no test-case Result overriding a run outcome) the CI-59 rules and wording apply unchanged
		const legacy = children.length === 0 && dependencies.every((d, i) => d.outcome === (states[i].outcome?.status ?? 'unfinished'));
		const evaluation = legacy ? evaluateDependencies(states) : evaluateFollowedTickets(children, dependencies);
		if (evaluation.result !== 'success' && evaluation.result !== 'failed') {
			return false;
		}
		const trigger = evaluation.result === 'failed' ? (evaluation.failedIds.includes(step.triggerId) ? step.triggerId : evaluation.failedIds[0]) : step.triggerId;
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
		const changes = [status, result ? `Result ${result}` : undefined].filter(Boolean).join(', ');
		const outcomeText = changes || `no change (${decision.action === 'keep' ? decision.reason : 'already set'})`;
		let summary: string;
		if (!legacy) {
			summary = `${evaluation.summary} → ${outcomeText}`;
		} else {
			const what = evaluation.result === 'failed' ? 'last run failed' : (step.depth > 1 || states.length > 1 ? 'all dependencies succeeded' : 'last run succeeded');
			summary = `Depends On ${trigger}: ${what} → ${outcomeText}`;
		}
		if (next !== text) {
			// this version is seen: the watcher's event for it is no new change (the chain continues here)
			this._signatures.set(folderKey(entry.folder), ticketSignature(next));
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
		return before?.status !== evaluation.result || next !== text;
	}

	private async _readAgentsFile(folder: URI, name: string, length: number): Promise<string | undefined> {
		try {
			return (await this._deps.fileService.readFile(URI.joinPath(folder, '.agents', name), { length })).value.toString();
		} catch {
			return undefined;
		}
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
		return this._indexForRoot(root);
	}

	private async _indexForRoot(root: URI): Promise<IWorkspaceIndex> {
		const key = folderKey(root);
		const cached = this._indexes.get(key);
		if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
			return cached;
		}
		const index = await this._scan(root);
		this._indexes.set(key, index);
		// baseline of tickets not seen yet (a version already seen is never overwritten: its change is pending)
		for (const [folder, entry] of index.byFolder) {
			if (!this._signatures.has(folder)) {
				this._signatures.set(folder, entry.signature);
			}
		}
		return index;
	}

	/** Every ticket folder under the workspace root (ID, Depends On) and the reverse index. */
	private async _scan(root: URI): Promise<IWorkspaceIndex> {
		const fileService: IFileService = this._deps.fileService;
		const byId = new Map<string, ITicketIndexEntry>();
		const byFolder = new Map<string, ITicketIndexEntry>();
		let nodes = 0;
		const parentOf = new Map<string, string>();
		const walk = async (dir: URI, depth: number, parentId: string | undefined): Promise<void> => {
			if (depth > MAX_SCAN_DEPTH || nodes >= MAX_SCAN_NODES) {
				return;
			}
			let selfId: string | undefined;
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
						const entry: ITicketIndexEntry = { id, folder: dir, dependsOn: readDependsOn(text), parentId, signature: ticketSignature(text) };
						byId.set(id, entry);
						byFolder.set(folderKey(dir), entry);
						selfId = id;
						if (parentId && parentId !== id) {
							parentOf.set(id, parentId);
						}
					}
				} catch {
					// a folder without ticket.md
				}
			}
			await Promise.all(children.filter(c => c.isDirectory && !c.name.startsWith('.') && !SKIPPED_FOLDERS.has(c.name.toLowerCase())).map(c => walk(c.resource, depth + 1, selfId ?? parentId)));
		};
		await walk(root, 0, undefined);
		const dependsOn = new Map<string, readonly string[]>();
		for (const e of byId.values()) {
			if (e.dependsOn.length > 0) {
				dependsOn.set(e.id, e.dependsOn);
			}
		}
		const childrenOf = new Map<string, string[]>();
		for (const [child, parent] of parentOf) {
			const l = childrenOf.get(parent) ?? [];
			l.push(child);
			childrenOf.set(parent, l);
		}
		for (const l of childrenOf.values()) {
			l.sort();
		}
		const dependents = buildDependentsIndex(dependsOn);
		return { builtAt: Date.now(), root, byId, byFolder, dependents, parentOf, childrenOf, followers: buildFollowersIndex(dependents, parentOf) };
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
