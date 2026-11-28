/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IWorkspacesExplorerService, IWorkspaceItem, IWorkspaceChildItem, IWorkspaceChildrenPage, ICreateResourceOptions, ICreateResourceResult, ICreateWorkspaceResult, ResourceType, IEntityMetadataSnapshot, CanonicalStatusCategory, IWorkspaceStatusesInfo, IWorkspaceLifecycleUpdate } from '../common/workspacesExplorer.js';
import { ITicketSubtreeNode, ITicketSubtreeSummary } from '../common/ticketSubtreeCount.js';
import { canonicalTreeKey, flattenTicketSubtree, ITicketSearchEntry, ITicketSearchIndex } from '../common/ticketSearch.js';
import { readIndependentFromParent } from '../common/ticketFollowChildren.js';
import { detectTicketFailure, ITicketFailure, ITicketLastRunRecord, IWorkflowRunHead, parseTicketLastRunRecord, parseWorkflowRunsHead, readTestResultField, TICKET_LAST_RUN_FILE_NAME } from '../common/ticketFailure.js';
import { ITicketLabelDefinition, parseLabelDefinitions, renameTicketLabels, serializeLabelDefinitions, TICKET_LABELS_METADATA_KEY } from '../common/ticketLabels.js';
import { migrateStatus, readTicketLabels, readTicketStatus, REMOVED_STATUS_KEY, setTicketLabelsLine, setTicketStatusLine, STATUS_MAPPING_KEY, TICKET_STATUSES_KEY, upsertWorkspaceMetadata } from '../common/workspaceLifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { FileOperation, IFileService } from '../../../../platform/files/common/files.js';
import { computeExternalWatchRoots, MANAGED_WORKSPACE_WATCH_EXCLUDES } from '../common/workspaceWatchRoots.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { writeTicketFile } from './ticketChangeRecorder.js';
import { findStatusOption, ITemplateStatusLike, resolveEffectiveStatusOptions, setTicketPriorityLine } from '../common/ticketStatusPicker.js';
import { ITicketRestoreResult, resolveRestoreStatus } from '../common/ticketRestore.js';
import { ITicketChangeRecord, parseTicketChangeRecords, TICKET_CHANGE_RECORDS_HEADING, TicketChangeActorInput } from '../common/ticketChangeLog.js';
import { TicketWorklogStorage } from './ticketWorklogStorage.js';
import { AgentScopeType, IAgentsManagerService, getGlobalDefaultModel } from '../../agentsManager/common/agentsManager.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { FREESTYLE_PROGRAMMATIC_CREATE_ERROR, ensureFreestyleSchema, isFreestyleTicketType } from '../../customModules/common/freestyleTicket.js';
import { isSubWorkflowTicketType } from '../../customModules/common/subWorkflowType.js';
import { ISubWorkflowDefinition } from '../../workflowsManager/common/workflowExecutionModel.js';
import { buildSubWorkflowDraftFromInput, findEnclosingWorkflowFolder, buildSubWorkflowTicketDescription, buildSubWorkflowTicketMetadata, getSubWorkflowDefinitionUri, getSubWorkflowParentError, normalizeSubWorkflowDefinition, serializeSubWorkflowDefinition } from '../../workflowsManager/common/subWorkflowTicket.js';
import { AuthenticationSession, AuthenticationSessionAccount, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IDebugService } from '../../debug/common/debug.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { toFolderAccessError } from '../../customModules/common/anyagentGlobalPaths.js';

const SAVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.savedWorkspaces';
const REMOVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.removedWorkspaces';

/** One child ticket folder of a cached sub-tree level (UI-17), with its failure signals (UI-20). */
interface ISubtreeLevelEntry {
	readonly uri: URI;
	readonly status?: string;
	readonly label: string;
	/** UI-21: search index fields. */
	readonly ticketId: string;
	readonly title?: string;
	readonly type: string;
	readonly resultField?: { readonly label: string; readonly value: string };
	readonly lastRun?: ITicketLastRunRecord;
	readonly workflowRun?: IWorkflowRunHead;
	/** CI-64: Independent from Parent. */
	readonly independent?: boolean;
}

export class WorkspacesExplorerService extends Disposable implements IWorkspacesExplorerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces: Event<void> = this._onDidChangeWorkspaces.event;

	private readonly _onDidCreateSubWorkflowTicket = this._register(new Emitter<URI>());
	readonly onDidCreateSubWorkflowTicket: Event<URI> = this._onDidCreateSubWorkflowTicket.event;

	private activeUserEmail: string = '';
	private activeUserInitPromise: Promise<void>;

	private readonly _childEntityMetaCache = new Map<string, {
		type: ResourceType;
		status?: string;
		labels?: string[];
		ticketId?: string;
		title?: string;
		/** UI-20: the test result field found in the 8KB head of ticket.md. */
		resultField?: { label: string; value: string };
		/** UI-20: ticket.md is longer than the head read (a result field may follow). */
		headTruncated?: boolean;
		/** CI-64: Independent from Parent (found in the head, or in the full read when the head was truncated). */
		independent?: boolean;
		timestamp: number;
	}>();
	private readonly _workspaceStatusesCache = new Map<string, {
		info: IWorkspaceStatusesInfo;
		timestamp: number;
	}>();

	/** UI-17: per folder, its direct child ticket folders with their raw status (ticket folders only). */
	private readonly _subtreeLevelCache = new Map<string, { entries: readonly ISubtreeLevelEntry[]; timestamp: number }>();
	private readonly _subtreeLevelInFlight = new Map<string, Promise<readonly ISubtreeLevelEntry[]>>();
	/** UI-20: failing tickets (normalized folder URI), refreshed whenever a sub-tree summary containing them is built. */
	private readonly _ticketFailures = new Map<string, ITicketFailure>();
	/** UI-23: result fields of test-case tickets (normalized folder URI), refreshed like {@link _ticketFailures}. */
	private readonly _ticketTestResults = new Map<string, { label: string; value: string }>();
	/** CI-64: ticket folders flagged Independent from Parent (filled with the sub-tree levels, like the test results). */
	private readonly _ticketIndependent = new Map<string, true>();
	/** UI-17: assembled sub-tree summaries; a stale entry is still served by peek (no flicker) until recomputed. */
	private readonly _subtreeSummaryCache = new Map<string, { summary: ITicketSubtreeSummary; timestamp: number; stale: boolean }>();
	private readonly _subtreeSummaryInFlight = new Map<string, Promise<ITicketSubtreeSummary>>();
	/** Running level / summary computations; one hit by an invalidation is returned but not cached. */
	private readonly _subtreeComputations = new Set<{ readonly key: string; readonly isSummary: boolean; dirty: boolean }>();
	private static readonly SUBTREE_MAX_DEPTH = 12;
	private static readonly SUBTREE_MAX_NODES = 5000;
	private static readonly SUBTREE_CACHE_TTL = 300000;

	/**
	 * Drops the cached levels of `uri`, its ancestors and its descendants (a listing or a child status changed) and
	 * marks the summaries of those folders stale.
	 */
	private _invalidateSubtreeCaches(uri: URI | string): void {
		const key = this.normalizeUriString(uri);
		const affects = (k: string) => key === k || key.startsWith(k + '/') || k.startsWith(key + '/');
		for (const computation of this._subtreeComputations) {
			if (affects(computation.key)) {
				computation.dirty = true;
			}
		}
		for (const k of Array.from(this._subtreeLevelCache.keys())) {
			if (affects(k)) {
				this._subtreeLevelCache.delete(k);
			}
		}
		for (const [k, entry] of this._subtreeSummaryCache) {
			if (affects(k)) {
				entry.stale = true;
			}
		}
		for (const k of Array.from(this._subtreeLevelInFlight.keys())) {
			if (affects(k)) {
				this._subtreeLevelInFlight.delete(k);
			}
		}
		for (const k of Array.from(this._subtreeSummaryInFlight.keys())) {
			if (affects(k)) {
				this._subtreeSummaryInFlight.delete(k);
			}
		}
	}

	/** Status categories may have changed (workspace lifecycle edit): summaries are reassembled from the cached levels. */
	private _markAllSubtreeSummariesStale(): void {
		for (const computation of this._subtreeComputations) {
			if (computation.isSummary) {
				computation.dirty = true;
			}
		}
		for (const entry of this._subtreeSummaryCache.values()) {
			entry.stale = true;
		}
		this._subtreeSummaryInFlight.clear();
	}

	private _invalidateCacheForUri(uri: URI | string): void {
		this._invalidateSubtreeCaches(uri);
		const norm = this.normalizeUriString(uri);
		this._childEntityMetaCache.delete(norm);
		const uriObj = typeof uri === 'string' ? URI.parse(uri) : uri;
		const parentDir = dirname(uriObj);
		const parentNorm = this.normalizeUriString(parentDir);
		this._childEntityMetaCache.delete(parentNorm);
		if (parentDir.path.endsWith('/.agents') || parentDir.path.endsWith('.agents')) {
			const grandParentNorm = this.normalizeUriString(dirname(parentDir));
			this._childEntityMetaCache.delete(grandParentNorm);
		}
	}

	private _fileChangeTimer: ReturnType<typeof setTimeout> | undefined;

	/** UI-30: recursive watchers of the managed workspaces outside the opened folders, by normalized root URI. */
	private readonly _externalWatchers = this._register(new DisposableMap<string>());

	/**
	 * Invalidates the tree caches for changed files and folders (watcher events, UI-30 also the app's own file
	 * operations) and re-renders the tree when the change matters to it.
	 */
	private _applyFileChanges(added: readonly URI[], updated: readonly URI[], deleted: readonly URI[]): void {
		const isRelevantMetaFile = (u: URI) => u.path.endsWith('/ticket.md') || u.path.endsWith('/README.md') || u.path.endsWith('/workspace.md');
		// UI-20: run outcomes read by the sub-tree scan (failing tickets)
		const isFailureSignalFile = (u: URI) => u.path.endsWith(`/.agents/${TICKET_LAST_RUN_FILE_NAME}`) || u.path.endsWith('/.agents/workflow_runs.json');
		const deletedSet = new Set(deleted);
		let failureSignalChanged = false;
		for (const u of [...added, ...updated, ...deleted]) {
			if (isFailureSignalFile(u)) {
				this._invalidateSubtreeCaches(u);
				failureSignalChanged = true;
			} else if (isRelevantMetaFile(u)) {
				this._invalidateCacheForUri(u);
				if (u.path.endsWith('/ticket.md') || u.path.endsWith('/workspace.md')) {
					this._workspaceStatusesCache.clear();
					this._markAllSubtreeSummariesStale();
				}
			} else if (deletedSet.has(u)) {
				this._invalidateCacheForUri(u);
			}
		}
		// UI-17: a folder created / moved in changes the child lists of its ancestors
		// (files inside a ticket's .agents folder never change child lists; ticket.md is handled above)
		for (const u of added) {
			if (!u.path.includes('/.agents/')) {
				this._invalidateSubtreeCaches(u);
			}
		}
		if (added.some(isRelevantMetaFile) || deleted.length > 0) {
			if (this._fileChangeTimer) {
				clearTimeout(this._fileChangeTimer);
				this._fileChangeTimer = undefined;
			}
			this._onDidChangeWorkspaces.fire();
		} else if (updated.some(isRelevantMetaFile) || failureSignalChanged) {
			if (this._fileChangeTimer) {
				clearTimeout(this._fileChangeTimer);
			}
			this._fileChangeTimer = setTimeout(() => {
				this._fileChangeTimer = undefined;
				this._onDidChangeWorkspaces.fire();
			}, failureSignalChanged ? 400 : 150);
		}
	}

	/**
	 * UI-30: keeps one recursive watcher per managed workspace root outside the opened folders (those are watched by
	 * the workbench already) and disposes the watchers of workspaces no longer listed.
	 */
	private _syncExternalWatchers(workspaces: readonly IWorkspaceItem[]): void {
		const roots = workspaces.map(w => w.uri.path.endsWith('.code-workspace') ? dirname(w.uri) : w.uri);
		const opened = this.workspaceContextService.getWorkspace().folders.map(f => f.uri);
		const wanted = new Map(computeExternalWatchRoots(roots, opened).map(root => [this.normalizeUriString(root), root]));
		for (const key of Array.from(this._externalWatchers.keys())) {
			if (!wanted.has(key)) {
				this._externalWatchers.deleteAndDispose(key);
			}
		}
		for (const [key, root] of wanted) {
			if (!this._externalWatchers.has(key)) {
				try {
					this._externalWatchers.set(key, this.fileService.watch(root, { recursive: true, excludes: [...MANAGED_WORKSPACE_WATCH_EXCLUDES] }));
				} catch (err) {
					console.error(`Failed to watch managed workspace ${root.toString()}:`, err);
				}
			}
		}
	}

	refreshCaches(uri?: URI): void {
		if (!uri) {
			this._workspaceStatusesCache.clear();
			this._childEntityMetaCache.clear();
			this._subtreeLevelCache.clear();
			this._subtreeLevelInFlight.clear();
			this._subtreeSummaryCache.clear();
			this._subtreeSummaryInFlight.clear();
			this._ticketFailures.clear();
			this._ticketTestResults.clear();
			this._ticketIndependent.clear();
			for (const computation of this._subtreeComputations) {
				computation.dirty = true;
			}
		} else {
			const base = uri.path.endsWith('.code-workspace') ? dirname(uri) : uri;
			const key = this.normalizeUriString(base);
			const under = (k: string) => k === key || k.startsWith(key + '/');
			this._invalidateCacheForUri(base);
			// the summaries of the folder and its descendants are recomputed (not served stale) so the pills re-read disk
			for (const k of Array.from(this._subtreeSummaryCache.keys())) {
				if (under(k)) {
					this._subtreeSummaryCache.delete(k);
				}
			}
			for (const map of [this._childEntityMetaCache, this._ticketFailures, this._ticketTestResults, this._ticketIndependent]) {
				for (const k of Array.from(map.keys())) {
					if (under(k)) {
						map.delete(k);
					}
				}
			}
			this._workspaceStatusesCache.clear();
		}
		this._onDidChangeWorkspaces.fire();
	}

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IEditorService private readonly editorService: IEditorService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IDebugService private readonly debugService: IDebugService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === this.savedWorkspacesKey || e.key === this.removedWorkspacesKey) {
				this._onDidChangeWorkspaces.fire();
			}
		}));
		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => {
			this._onDidChangeWorkspaces.fire();
		}));
		this._register({
			dispose: () => {
				if (this._fileChangeTimer) {
					clearTimeout(this._fileChangeTimer);
					this._fileChangeTimer = undefined;
				}
			}
		});
		this._register(this.fileService.onDidFilesChange(e => this._applyFileChanges(e.rawAdded, e.rawUpdated, e.rawDeleted)));
		// UI-30: the app's own creates / deletes / moves / writes refresh the tree right away, also in workspaces the
		// watchers report late or not at all (an event a watcher reports again only re-invalidates the same entries)
		this._register(this.fileService.onDidRunOperation(e => {
			switch (e.operation) {
				case FileOperation.CREATE:
				case FileOperation.COPY:
					this._applyFileChanges([e.target?.resource ?? e.resource], [], []);
					break;
				case FileOperation.DELETE:
					this._applyFileChanges([], [], [e.resource]);
					break;
				case FileOperation.MOVE:
					this._applyFileChanges(e.target ? [e.target.resource] : [], [], [e.resource]);
					break;
				case FileOperation.WRITE:
					this._applyFileChanges([], [e.resource], []);
					break;
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._onDidChangeWorkspaces.fire()));

		this._register(this.authenticationService.onDidChangeSessions(async () => {
			await this.updateActiveUser();
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async () => {
			await this.updateActiveUser();
		}));

		this.activeUserInitPromise = this.updateActiveUser();
	}

	getActiveUserEmail(): string {
		return this.activeUserEmail;
	}


	private async updateActiveUser(): Promise<void> {
		try {
			const providers = ['google', 'github', 'microsoft', 'apple', ...this.authenticationService.declaredProviders.map(p => p.id)];
			const uniqueProviders = Array.from(new Set(providers));

			const sessionPromises = uniqueProviders.map(async providerId => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				try {
					const sessionsPromise = this.authenticationService.getSessions(providerId, undefined, undefined, true);
					const timeoutPromise = new Promise<readonly AuthenticationSession[]>(resolve => {
						timeoutId = setTimeout(() => resolve([]), 5000);
					});
					const sessions = await Promise.race([sessionsPromise, timeoutPromise]);
					clearTimeout(timeoutId);
					if (sessions && sessions.length > 0) {
						return { providerId, session: sessions[0] };
					}
				} catch {
					clearTimeout(timeoutId);
				}
				return null;
			});

			const results = await Promise.all(sessionPromises);
			const activeResult = results.find(r => r !== null && r !== undefined);
			let newUserIdentifier = '';

			if (activeResult) {
				const account: AuthenticationSessionAccount & { email?: string } = activeResult.session.account;
				const label = account.label || account.email || '';
				const match = label.match(/\(([^)]+)\)/);
				newUserIdentifier = (match ? match[1] : label).trim().toLowerCase();
			}

			if (newUserIdentifier !== this.activeUserEmail) {
				const oldUser = this.activeUserEmail;
				this.activeUserEmail = newUserIdentifier;

				// 1. Only close active editors on TRUE account switch (User A -> User B) to prevent data leaks.
				// Cold startup resolution (when oldUser was empty) MUST NEVER close user tabs!
				if (oldUser && newUserIdentifier && oldUser !== newUserIdentifier) {
					try {
						const openEditors = this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
						if (openEditors.length > 0) {
							await this.editorService.closeEditors(openEditors);
						}
					} catch (err) {
						console.error('Failed to close active editors on user switch:', err);
					}

					// 2. Kill all active terminal instances
					try {
						const instances = this.terminalService.instances;
						for (const inst of instances) {
							inst.dispose();
						}
					} catch (err) {
						console.error('Failed to dispose active terminals on user switch:', err);
					}

					// 3. Stop all active debug sessions
					try {
						const sessions = this.debugService.getModel().getSessions();
						for (const s of sessions) {
							this.debugService.stopSession(s).catch(() => { });
						}
					} catch (err) {
						console.error('Failed to stop active debug sessions on user switch:', err);
					}
				}

				this._onDidChangeWorkspaces.fire();
			}
		} catch (err) {
			console.error('Failed to update active user in WorkspacesExplorerService:', err);
		}
	}

	private get savedWorkspacesKey(): string {
		return `${SAVED_WORKSPACES_STORAGE_KEY}:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private get removedWorkspacesKey(): string {
		return `${REMOVED_WORKSPACES_STORAGE_KEY}:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private normalizeUriString(uri: URI | string): string {
		const str = typeof uri === 'string' ? uri : uri.toString();
		try {
			return decodeURIComponent(str).replace(/\/+$/, '');
		} catch {
			return str.replace(/\/+$/, '');
		}
	}

	getMetadataSnapshot(uri: URI | string): IEntityMetadataSnapshot | undefined {
		const snapshot = this.entityPersistenceService.getSnapshot(uri);
		if (!snapshot) {
			return undefined;
		}
		if (snapshot.ownerAccount && this.activeUserEmail) {
			const extractEmail = (str: string): string => {
				const clean = str.includes(':') ? str.split(':')[1] : str;
				const match = clean.match(/\(([^)]+)\)/);
				return (match ? match[1] : clean).trim().toLowerCase();
			};

			const cleanActiveUser = this.activeUserEmail;
			const cleanOwner = extractEmail(snapshot.ownerAccount);

			if (cleanActiveUser !== cleanOwner) {
				return undefined;
			}
		}
		return {
			entityUri: snapshot.entityUri,
			entityName: snapshot.entityName,
			title: snapshot.title,
			ticketId: snapshot.ticketId,
			workspaceId: snapshot.workspaceId,
			entityType: snapshot.entityType as ResourceType,
			ownerAccount: snapshot.ownerAccount || this.activeUserEmail || 'unauthenticated',
			createdAt: snapshot.createdAt || '',
			description: snapshot.description,
			belongsToWorkspaceUri: snapshot.belongsToWorkspaceUri,
			entityCode: snapshot.entityCode,
			priority: snapshot.priority,
			assignedAgentId: snapshot.assignedAgentId,
			assignedAgentName: snapshot.assignedAgentName,
			agentRulePrompt: snapshot.agentRulePrompt,
			git: snapshot.git
		};
	}

	async saveMetadataSnapshot(snapshot: IEntityMetadataSnapshot): Promise<void> {
		if (snapshot.entityUri) {
			this._invalidateCacheForUri(snapshot.entityUri);
		}
		await this.entityPersistenceService.saveSnapshot({
			...snapshot,
			entityType: snapshot.entityType
		});
	}

	async removeSnapshot(uri: URI): Promise<void> {
		this._invalidateCacheForUri(uri);
		await this.entityPersistenceService.removeSnapshot(uri);
		this._onDidChangeWorkspaces.fire();
	}

	private getSavedWorkspaceUris(): string[] {
		let raw = this.storageService.get(this.savedWorkspacesKey, StorageScope.PROFILE, '');
		if (!raw && this.activeUserEmail) {
			// Check legacy account key format
			const legacyKey = `${SAVED_WORKSPACES_STORAGE_KEY}:google:Aimery Wei (${this.activeUserEmail})`;
			const legacyRaw = this.storageService.get(legacyKey, StorageScope.PROFILE, '');
			if (legacyRaw) {
				raw = legacyRaw;
				this.storageService.store(this.savedWorkspacesKey, raw, StorageScope.PROFILE, StorageTarget.USER);
			}
		}
		try {
			return (JSON.parse(raw || '[]') as string[]).map(u => this.normalizeUriString(u));
		} catch {
			return [];
		}
	}

	private saveWorkspaceUris(uris: string[]): void {
		const uniqueUris = Array.from(new Set(uris.map(u => this.normalizeUriString(u))));
		this.storageService.store(
			this.savedWorkspacesKey,
			JSON.stringify(uniqueUris),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeWorkspaces.fire();
	}

	private getRemovedWorkspaceUris(): string[] {
		let raw = this.storageService.get(this.removedWorkspacesKey, StorageScope.PROFILE, '');
		if (!raw && this.activeUserEmail) {
			const legacyKey = `${REMOVED_WORKSPACES_STORAGE_KEY}:google:Aimery Wei (${this.activeUserEmail})`;
			const legacyRaw = this.storageService.get(legacyKey, StorageScope.PROFILE, '');
			if (legacyRaw) {
				raw = legacyRaw;
				this.storageService.store(this.removedWorkspacesKey, raw, StorageScope.PROFILE, StorageTarget.USER);
			}
		}
		try {
			return (JSON.parse(raw || '[]') as string[]).map(u => this.normalizeUriString(u));
		} catch {
			return [];
		}
	}

	private saveRemovedWorkspaceUris(uris: string[]): void {
		const uniqueUris = Array.from(new Set(uris.map(u => this.normalizeUriString(u))));
		this.storageService.store(
			this.removedWorkspacesKey,
			JSON.stringify(uniqueUris),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeWorkspaces.fire();
	}


	async getWorkspaces(): Promise<IWorkspaceItem[]> {
		await this.activeUserInitPromise;

		const currentWorkspace = this.workspaceContextService.getWorkspace();
		const currentFolderUris = new Set(currentWorkspace.folders.map(f => this.normalizeUriString(f.uri)));

		let savedUris = this.getSavedWorkspaceUris();
		const removedUris = this.getRemovedWorkspaceUris();
		const resultItems: IWorkspaceItem[] = [];
		const invalidSavedUris: string[] = [];

		const processUri = async (uri: URI, isFromRecents = false) => {
			const normUriStr = this.normalizeUriString(uri);
			if (removedUris.includes(normUriStr) && !currentFolderUris.has(normUriStr)) {
				// User explicitly removed this entry from explorer, skip rendering!
				return;
			}

			let targetBase = uri;
			if (uri.path.endsWith('.code-workspace')) {
				targetBase = dirname(uri);
			}

			const isCurrent = currentFolderUris.has(normUriStr);
			const name = targetBase.path.split('/').filter(Boolean).pop() || 'Untitled Workspace';
			const item: IWorkspaceItem = {
				id: uri.toString(),
				name,
				uri,
				isCurrent,
				isSaved: savedUris.includes(normUriStr)
			};

			try {
				const folderExists = await this.fileService.exists(targetBase);
				if (!folderExists) {
					// Physical directory deleted on disk, clean up from saved list and do not render ghost card
					if (savedUris.includes(normUriStr)) {
						invalidSavedUris.push(normUriStr);
					}
					return;
				}

				const workspaceMdUri = URI.joinPath(targetBase, '.agents', 'workspace.md');
				const ticketMdUri = URI.joinPath(targetBase, '.agents', 'ticket.md');
				const hasWorkspaceMd = await this.fileService.exists(ticketMdUri) ||
					await this.fileService.exists(workspaceMdUri) ||
					await this.fileService.exists(URI.joinPath(targetBase, 'ticket.md')) ||
					await this.fileService.exists(URI.joinPath(targetBase, 'workspace.md'));

				if (!hasWorkspaceMd && !item.isSaved && !isCurrent) {
					return;
				}

				const detectedType = await this.detectCustomEntityTypeFromDisk(targetBase);
				item.detectedType = detectedType;
				if (!item.isSaved && detectedType !== 'workspace' && detectedType !== 'folder') {
					return;
				}

				try {
					item.code = await this.resolveEntityCode(targetBase);
				} catch {
					// Inaccessible or unresolvable code
				}

				resultItems.push(item);
			} catch {
				// Inaccessible path, ignore
			}
		};

		// 1. Process current workspace folders
		for (const folder of currentWorkspace.folders) {
			await processUri(folder.uri);
		}

		// 2. Process user-saved workspaces
		for (const uriStr of savedUris) {
			if (!currentFolderUris.has(uriStr)) {
				await processUri(URI.parse(uriStr));
			}
		}

		// 3. Process recent workspaces
		try {
			const recents = await this.workspacesService.getRecentlyOpened();
			for (const r of recents.workspaces) {
				const uri = isRecentFolder(r) ? r.folderUri : isRecentWorkspace(r) ? r.workspace.configPath : undefined;
				if (uri) {
					const normUriStr = this.normalizeUriString(uri);
					if (!currentFolderUris.has(normUriStr) && !savedUris.includes(normUriStr)) {
						await processUri(uri, true);
					}
				}
			}
		} catch {
			// ignore
		}

		// Clean up non-existent saved URIs
		if (invalidSavedUris.length > 0) {
			savedUris = savedUris.filter(u => !invalidSavedUris.includes(u));
			this.saveWorkspaceUris(savedUris);
		}

		// Filter out items that are sub-directories of another valid workspace in resultItems
		const workspaceBases = resultItems
			.map(item => item.uri.path.endsWith('.code-workspace') ? dirname(item.uri).path : item.uri.path);

		const finalItems = resultItems.filter(item => {
			const itemBase = item.uri.path.endsWith('.code-workspace') ? dirname(item.uri).path : item.uri.path;
			const isSubOfAnother = workspaceBases.some(parentBase => parentBase !== itemBase && itemBase.startsWith(parentBase + '/'));
			return !isSubOfAnother;
		});

		this._syncExternalWatchers(finalItems);
		return finalItems;
	}

	async addWorkspace(uri: URI, name?: string): Promise<void> {
		await this.saveWorkspace(uri);
	}

	async removeWorkspace(uri: URI): Promise<void> {
		await this.removeSavedWorkspace(uri);
	}

	async saveWorkspace(uri: URI): Promise<void> {
		const uris = this.getSavedWorkspaceUris();
		const normUriStr = this.normalizeUriString(uri);

		// Remove from removed blacklist if re-added explicitly
		const removed = this.getRemovedWorkspaceUris();
		if (removed.includes(normUriStr)) {
			const updatedRemoved = removed.filter(u => u !== normUriStr);
			this.saveRemovedWorkspaceUris(updatedRemoved);
		}

		// Check if uri is a sub-directory of another saved workspace or current workspace folder
		const targetPath = uri.path.endsWith('.code-workspace') ? dirname(uri).path : uri.path;
		const currentWorkspace = this.workspaceContextService.getWorkspace();
		const allRootPaths = [
			...currentWorkspace.folders.map(f => f.uri.path),
			...uris.map(u => {
				const p = URI.parse(u);
				return p.path.endsWith('.code-workspace') ? dirname(p).path : p.path;
			})
		];

		const isSubFolder = allRootPaths.some(rootPath => rootPath !== targetPath && targetPath.startsWith(rootPath + '/'));
		if (isSubFolder) {
			// Sub-folders are managed inside parent workspace tree, never registered as top-level root cards!
			return;
		}

		if (!uris.includes(normUriStr)) {
			uris.push(normUriStr);
			this.saveWorkspaceUris(uris);
		}
		this._onDidChangeWorkspaces.fire();
	}

	async removeSavedWorkspace(uri: URI): Promise<void> {
		const normUriStr = this.normalizeUriString(uri);
		const uris = this.getSavedWorkspaceUris();
		const updated = uris.filter(u => u !== normUriStr);
		this.saveWorkspaceUris(updated);

		const removed = this.getRemovedWorkspaceUris();
		if (!removed.includes(normUriStr)) {
			removed.push(normUriStr);
			this.saveRemovedWorkspaceUris(removed);
		}

		await this.entityPersistenceService.removeSnapshot(uri);
		try {
			await this.workspacesService.removeRecentlyOpened([uri]);
		} catch {
			// ignore
		}
		this._onDidChangeWorkspaces.fire();
	}

	async createWorkspace(options: ICreateResourceOptions): Promise<ICreateResourceResult> {
		// A workspace is only created where the user chose (CI-26): there is no default location
		if (!options.targetParentUri) {
			throw new Error('No location was chosen for the new workspace. Pick the parent folder with the folder picker and try again.');
		}
		const parentFolderUri = URI.file(options.targetParentUri.fsPath);
		const sanitizedName = options.name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const targetBaseUri = URI.joinPath(parentFolderUri, sanitizedName);

		const wsCode = options.code ? options.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : this.generateWorkspaceCodeFromName(options.name);

		const alreadyExists = await this.fileService.exists(targetBaseUri);

		// If git repository is specified, ensure Git is cloned / initialized and ready BEFORE creating files
		if (options.gitRepoUrl) {
			await this.ensureGitRepositoryReady(targetBaseUri, options.gitRepoUrl, options.gitBranch);
		} else {
			if (!alreadyExists) {
				try {
					await this.fileService.createFolder(targetBaseUri);
				} catch (err) {
					// Permission denied (e.g. macOS privacy): stop with a clear error, never fall back to another folder
					throw toFolderAccessError(err, targetBaseUri);
				}
			}
		}

		let attachmentNames: string[] | undefined;
		if (options.attachments && options.attachments.length > 0) {
			const attachmentsDir = URI.joinPath(targetBaseUri, 'attachments');
			if (!await this.fileService.exists(attachmentsDir)) {
				await this.fileService.createFolder(attachmentsDir);
			}
			attachmentNames = [];
			for (const attUri of options.attachments) {
				const fileName = attUri.path.split('/').filter(Boolean).pop() || 'attachment';
				const destUri = URI.joinPath(attachmentsDir, fileName);
				try {
					await this.fileService.copy(attUri, destUri, true);
					attachmentNames.push(fileName);
				} catch {
					// ignore
				}
			}
		}

		const customMetadata = options.customMetadata || {};
		if (options.customStatuses && options.customStatuses.length > 0) {
			customMetadata['Ticket Statuses'] = options.customStatuses.join(', ');
		}
		if (options.statusMapping && Object.keys(options.statusMapping).length > 0) {
			customMetadata['Status Mapping'] = JSON.stringify(options.statusMapping);
		}
		if (options.removedStatus) {
			customMetadata['Removed Status'] = options.removedStatus;
		}
		if (options.labelDefinitions && options.labelDefinitions.length > 0) {
			customMetadata[TICKET_LABELS_METADATA_KEY] = serializeLabelDefinitions(options.labelDefinitions);
		}

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: targetBaseUri.toString(),
			entityName: options.name,
			title: options.title || options.name,
			entityType: 'workspace',
			entityCode: wsCode,
			ownerAccount: this.activeUserEmail || 'unauthenticated',
			createdAt: '',
			description: options.description || `Workspace for ${options.name}`,
			status: options.status || (options.customStatuses && options.customStatuses.length > 0 ? options.customStatuses[0] : 'open'),
			priority: options.priority || 'Medium',
			assignedAgentId: options.assignedAgentId,
			assignedAgentName: options.assignedAgentName,
			agentRulePrompt: options.agentRulePrompt,
			attachments: attachmentNames,
			typeDefinition: options.typeDefinition,
			typePrompt: options.typePrompt,
			ticketPrompt: options.ticketPrompt,
			git: (options.gitRepoUrl || options.gitBranch) ? { remoteUrl: options.gitRepoUrl, branch: options.gitBranch } : undefined,
			customMetadata
		}, targetBaseUri, false);

		await this.addWorkspace(targetBaseUri, options.name);
		return { alreadyExists, uri: targetBaseUri };
	}

	async createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description?: string): Promise<ICreateWorkspaceResult> {
		return this.createWorkspace({ name, targetParentUri: parentLocationUri, description, type: 'workspace' });
	}

	private async ensureGitRepositoryReady(targetFolderUri: URI, gitRepoUrl: string, gitBranch?: string): Promise<void> {
		const targetPath = targetFolderUri.fsPath;
		const dotGitUri = URI.joinPath(targetFolderUri, '.git');

		// 1. If .git already exists in target folder, ensure remote & branch are aligned
		if (await this.fileService.exists(dotGitUri)) {
			await this._configureExistingGitRepo(dotGitUri, gitRepoUrl, gitBranch);
			try {
				await this.commandService.executeCommand('git.openRepository', targetPath);
			} catch { }
			return;
		}

		// 2. Check if target folder exists
		const folderExists = await this.fileService.exists(targetFolderUri);
		if (folderExists) {
			const stat = await this.fileService.resolve(targetFolderUri);
			const children = (stat.children || []).filter(c => c.name !== '.DS_Store');
			if (children.length > 0) {
				// Non-empty folder without git: initialize git directly in this folder
				await this._initGitInExistingFolder(targetFolderUri, gitRepoUrl, gitBranch);
				try {
					await this.commandService.executeCommand('git.openRepository', targetPath);
				} catch { }
				return;
			} else {
				// Empty folder: remove it so git clone can create it cleanly without collision
				try {
					await this.fileService.del(targetFolderUri, { recursive: true });
				} catch { }
			}
		}

		// 3. Ensure parent folder exists before clone
		const parentUri = dirname(targetFolderUri);
		if (!await this.fileService.exists(parentUri)) {
			await this.fileService.createFolder(parentUri);
		}

		// 4. Execute clone via VS Code's git extension command
		let cloneError: unknown = null;
		try {
			await this.commandService.executeCommand('_git.cloneRepository', gitRepoUrl, targetPath);
		} catch (err) {
			cloneError = err;
		}

		// 5. Verify whether .git exists
		const gitCreated = await this.fileService.exists(dotGitUri);
		if (!gitCreated) {
			// If clone command was unavailable or failed, attempt direct repo init fallback
			try {
				await this._initGitInExistingFolder(targetFolderUri, gitRepoUrl, gitBranch);
			} catch (fallbackErr) {
				const errMsg = cloneError ? ((cloneError as { message?: unknown }).message || cloneError) : ((fallbackErr as { message?: unknown }).message || fallbackErr);
				throw new Error(`Git clone failed for '${gitRepoUrl}': ${errMsg}`);
			}
		} else {
			if (gitBranch) {
				await this._ensureGitBranch(dotGitUri, gitBranch);
			}
		}

		// 6. Tell VS Code Git extension to immediately open and manage this repository
		try {
			await this.commandService.executeCommand('git.openRepository', targetPath);
		} catch { }
	}

	private async _initGitInExistingFolder(folderUri: URI, gitRepoUrl: string, gitBranch?: string): Promise<void> {
		if (!await this.fileService.exists(folderUri)) {
			await this.fileService.createFolder(folderUri);
		}
		const dotGitUri = URI.joinPath(folderUri, '.git');
		if (!await this.fileService.exists(dotGitUri)) {
			await this.fileService.createFolder(dotGitUri);
		}
		const objectsUri = URI.joinPath(dotGitUri, 'objects');
		if (!await this.fileService.exists(objectsUri)) {
			await this.fileService.createFolder(objectsUri);
		}
		const refsHeadsUri = URI.joinPath(dotGitUri, 'refs', 'heads');
		if (!await this.fileService.exists(refsHeadsUri)) {
			await this.fileService.createFolder(refsHeadsUri);
		}
		const refsTagsUri = URI.joinPath(dotGitUri, 'refs', 'tags');
		if (!await this.fileService.exists(refsTagsUri)) {
			await this.fileService.createFolder(refsTagsUri);
		}

		const branch = gitBranch || 'main';
		const headUri = URI.joinPath(dotGitUri, 'HEAD');
		await this.fileService.writeFile(headUri, VSBuffer.fromString(`ref: refs/heads/${branch}\n`));

		const configUri = URI.joinPath(dotGitUri, 'config');
		const configStr = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true\n[remote "origin"]\n\turl = ${gitRepoUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${branch}\n`;
		await this.fileService.writeFile(configUri, VSBuffer.fromString(configStr));

		const descUri = URI.joinPath(dotGitUri, 'description');
		await this.fileService.writeFile(descUri, VSBuffer.fromString('Unnamed repository\n'));
	}

	private async _configureExistingGitRepo(dotGitUri: URI, gitRepoUrl: string, gitBranch?: string): Promise<void> {
		try {
			const configUri = URI.joinPath(dotGitUri, 'config');
			if (await this.fileService.exists(configUri)) {
				let content = (await this.fileService.readFile(configUri)).value.toString();
				if (!content.includes('[remote "origin"]')) {
					content += `\n[remote "origin"]\n\turl = ${gitRepoUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
					await this.fileService.writeFile(configUri, VSBuffer.fromString(content));
				}
			}
			if (gitBranch) {
				await this._ensureGitBranch(dotGitUri, gitBranch);
			}
		} catch (err) {
			console.warn('Failed to configure existing git repo:', err);
		}
	}

	private async _ensureGitBranch(dotGitUri: URI, gitBranch: string): Promise<void> {
		try {
			const headUri = URI.joinPath(dotGitUri, 'HEAD');
			if (await this.fileService.exists(headUri)) {
				const currentHead = (await this.fileService.readFile(headUri)).value.toString().trim();
				if (currentHead.startsWith('ref: refs/heads/') && currentHead !== `ref: refs/heads/${gitBranch}`) {
					await this.fileService.writeFile(headUri, VSBuffer.fromString(`ref: refs/heads/${gitBranch}\n`));
				}
			}
		} catch (err) {
			console.warn('Failed to ensure git branch:', err);
		}
	}

	async reorderWorkspaces(sourceId: string, targetId: string): Promise<void> {
		// optional order persistence logic
	}

	private async _readChildEntityMetadataFast(
		childUri: URI,
		fallbackName: string
	): Promise<{ type: ResourceType; status?: string; labels?: string[]; ticketId?: string; title?: string; resultField?: { label: string; value: string }; headTruncated?: boolean; independent?: boolean }> {
		const cacheKey = this.normalizeUriString(childUri);
		const snap = this.getMetadataSnapshot(childUri);
		const cached = this._childEntityMetaCache.get(cacheKey);
		if (cached && (Date.now() - cached.timestamp) < 300000) {
			const resolvedId = cached.ticketId || snap?.ticketId || fallbackName;
			const resolvedTitle = cached.title || (snap?.title && snap.title !== resolvedId && snap.title !== fallbackName ? snap.title : undefined);
			return {
				type: cached.type !== 'folder' ? cached.type : (snap?.entityType || cached.type),
				status: cached.status,
				labels: cached.labels,
				ticketId: resolvedId,
				title: resolvedTitle,
				resultField: cached.resultField,
				headTruncated: cached.headTruncated,
				independent: cached.independent
			};
		}

		const configDir = URI.joinPath(childUri, '.agents');
		const ticketUris = [URI.joinPath(configDir, 'ticket.md'), URI.joinPath(childUri, 'ticket.md')];

		let detectedType: ResourceType | undefined;
		let detectedStatus: string | undefined;
		let detectedLabels: string[] | undefined;
		let ticketIdFromTicket = '';
		let titleFromTicket = '';
		let foundTicketFile = false;
		let resultField: { label: string; value: string } | undefined;
		let headTruncated = false;
		let independent = false;

		for (const uri of ticketUris) {
			try {
				const content = await this.fileService.readFile(uri, { length: 8192 });
				const text = content.value.toString();
				foundTicketFile = true;
				resultField = readTestResultField(text);
				headTruncated = content.value.byteLength >= 8192;
				independent = readIndependentFromParent(text);

				const typeMatch = text.match(/-\s+\*\*Ticket\s+Type\*\*:\s*([^\r\n]+)/i) || text.match(/-\s+\*\*Entity\s+Type\*\*:\s*([^\r\n]+)/i);
				if (typeMatch && typeMatch[1]) {
					const cleaned = typeMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
					if (cleaned && cleaned.toLowerCase() !== 'none') {
						detectedType = cleaned.toLowerCase() as ResourceType;
					}
				}

				const statusMatch = text.match(/-\s+\*\*Status\*\*:\s*([^\r\n]+)/i);
				if (statusMatch && statusMatch[1]) {
					detectedStatus = statusMatch[1].trim();
				}
				const labels = readTicketLabels(text);
				if (labels.length > 0) {
					detectedLabels = labels;
				}

				const idMatch = text.match(/-\s+\*\*(?:Ticket|Entity)\s+ID\*\*:\s*([^\r\n]+)/i);
				if (idMatch && idMatch[1]) {
					const v = idMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					if (v && v !== 'None') {
						ticketIdFromTicket = v;
					}
				}

				const tMatch = text.match(/-\s+\*\*Title\*\*:\s*([^\r\n]+)/i);
				if (tMatch && tMatch[1]) {
					const v = tMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					if (v && v !== 'None') {
						titleFromTicket = v;
					}
				}
				break;
			} catch {
				// file does not exist or unreadable, try next
			}
		}

		let ticketIdFromReadme = '';
		let titleFromReadme = '';
		let h1FromReadme = '';

		// Only read README.md if ticket.md did not already supply both ticketId and title
		if (!foundTicketFile || !ticketIdFromTicket || !titleFromTicket) {
			const readmeUris = [URI.joinPath(configDir, 'README.md'), URI.joinPath(childUri, 'README.md')];
			for (const uri of readmeUris) {
				try {
					const content = await this.fileService.readFile(uri, { length: 8192 });
					const text = content.value.toString();
					const idMatch = text.match(/-\s+\*\*(?:Ticket|Entity)\s+ID\*\*:\s*([^\r\n]+)/i);
					if (idMatch && idMatch[1]) {
						const v = idMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
						if (v && v !== 'None') {
							ticketIdFromReadme = v;
						}
					}
					const tMatch = text.match(/-\s+\*\*Title\*\*:\s*([^\r\n]+)/i);
					if (tMatch && tMatch[1]) {
						const v = tMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
						if (v && v !== 'None') {
							titleFromReadme = v;
						}
					}
					const h1Match = text.match(/^#\s+([^\r\n]+)/m);
					if (h1Match && h1Match[1]) {
						const v = h1Match[1].trim();
						if (v && v !== 'None') {
							h1FromReadme = v;
						}
					}
					break;
				} catch {
					// ignore
				}
			}
		}

		if (!detectedType) {
			if (snap?.entityType && snap.entityType !== 'folder') {
				detectedType = snap.entityType;
			} else {
				try {
					const stat = await this.fileService.resolve(configDir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && child.name.endsWith('.md')) {
								const nameLower = child.name.toLowerCase();
								if (nameLower !== 'instruction.md' && nameLower !== 'readme.md' && nameLower !== 'work_log.md' && nameLower !== 'worklog.md' && nameLower !== 'ticket.md' && nameLower !== 'tickets.md') {
									detectedType = child.name.substring(0, child.name.length - 3) as ResourceType;
									break;
								}
							}
						}
					}
				} catch {
					// ignore
				}
			}
		}

		const finalType: ResourceType = detectedType || 'folder';
		const resolvedTicketId = ticketIdFromTicket || ticketIdFromReadme || snap?.ticketId || fallbackName;
		let resolvedTitle = '';
		if (titleFromReadme && titleFromReadme !== resolvedTicketId && titleFromReadme !== fallbackName) {
			resolvedTitle = titleFromReadme;
		} else if (titleFromTicket && titleFromTicket !== resolvedTicketId && titleFromTicket !== fallbackName) {
			resolvedTitle = titleFromTicket;
		} else if (snap?.title && snap.title !== resolvedTicketId && snap.title !== fallbackName) {
			resolvedTitle = snap.title;
		} else if (h1FromReadme && h1FromReadme !== resolvedTicketId && h1FromReadme !== fallbackName) {
			resolvedTitle = h1FromReadme;
		} else {
			resolvedTitle = titleFromReadme || titleFromTicket || snap?.title || '';
		}

		const entry = {
			type: finalType,
			status: detectedStatus,
			labels: detectedLabels,
			ticketId: resolvedTicketId,
			title: resolvedTitle || undefined,
			resultField,
			headTruncated,
			independent,
			timestamp: Date.now()
		};
		this._childEntityMetaCache.set(cacheKey, entry);
		return entry;
	}

	async scanWorkspaceChildren(workspaceUri: URI, includeRemoved: boolean = false): Promise<IWorkspaceChildItem[]> {
		const page = await this.scanWorkspaceChildrenPaginated(workspaceUri, includeRemoved, undefined);
		return page.items;
	}

	async scanWorkspaceChildrenPaginated(
		workspaceUri: URI,
		includeRemoved: boolean = false,
		limit?: number
	): Promise<IWorkspaceChildrenPage> {
		let targetBase = workspaceUri;
		if (workspaceUri.path.endsWith('.code-workspace')) {
			targetBase = dirname(workspaceUri);
		}

		try {
			const stat = await this.fileService.resolve(targetBase);
			if (!stat.children || stat.children.length === 0) {
				return { items: [], totalCount: 0, hasMore: false };
			}

			const validChildren = stat.children.filter(child => {
				if (child.name.startsWith('.') || child.name.startsWith('~')) {
					return false;
				}
				if (!child.isDirectory && (child.name === 'desktop.ini' || child.name === 'Thumbs.db')) {
					return false;
				}
				return true;
			});

			if (validChildren.length === 0) {
				return { items: [], totalCount: 0, hasMore: false };
			}

			// Deterministic natural sort so paginated slices are stable
			validChildren.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

			const wsStatuses = await this.getWorkspaceStatuses(targetBase);
			const childrenItems: IWorkspaceChildItem[] = [];
			const BATCH_SIZE = 25;
			let processedCount = 0;

			for (let i = 0; i < validChildren.length; i += BATCH_SIZE) {
				const slice = validChildren.slice(i, i + BATCH_SIZE);
				const batchResults = await Promise.all(slice.map(async (child): Promise<IWorkspaceChildItem | null> => {
					if (!child.isDirectory) {
						return {
							id: child.resource.toString(),
							name: child.name,
							type: 'file',
							uri: child.resource
						};
					}

					const childUri = child.resource;
					const meta = await this._readChildEntityMetadataFast(childUri, child.name);
					const childStatus = meta.status;
					const isRemoved = this._isRemovedStatus(childStatus, wsStatuses);

					if (isRemoved && !includeRemoved) {
						return null;
					}

					return {
						id: childUri.toString(),
						name: child.name,
						type: meta.type,
						ticketId: meta.ticketId,
						title: meta.title,
						status: childStatus,
						labels: meta.labels,
						uri: childUri
					};
				}));

				for (const item of batchResults) {
					if (item) {
						childrenItems.push(item);
					}
				}
				processedCount += slice.length;

				if (limit !== undefined && limit > 0 && childrenItems.length >= limit) {
					break;
				}
			}

			const unscannedCount = Math.max(0, validChildren.length - processedCount);
			const totalCount = childrenItems.length + unscannedCount;
			const hasMore = limit !== undefined && limit > 0
				? (childrenItems.length > limit || unscannedCount > 0)
				: false;
			const finalItems = (limit !== undefined && limit > 0 && childrenItems.length > limit)
				? childrenItems.slice(0, limit)
				: childrenItems;

			return {
				items: finalItems,
				totalCount,
				hasMore
			};
		} catch {
			return { items: [], totalCount: 0, hasMore: false };
		}
	}

	/** Whether a ticket with `status` is hidden from the tree unless "show removed items" is on. */
	private _isRemovedStatus(status: string | undefined, wsStatuses: IWorkspaceStatusesInfo): boolean {
		if (!status) {
			return false;
		}
		const lower = status.toLowerCase();
		return wsStatuses.getCategory(status) === 'Removed' ||
			lower === wsStatuses.removedStatus.toLowerCase() ||
			lower === 'removed' ||
			lower === 'canceled' ||
			lower === 'cancelled' ||
			lower === 'archived';
	}

	/**
	 * UI-20: the failure signals of one ticket folder besides its status: the result field (from the cached 8KB head,
	 * or the whole ticket.md when the head was cut before one was found), last_run.json and the head of
	 * workflow_runs.json (workflow tickets only).
	 */
	private async _readTicketFailureSignals(ticketUri: URI, meta: { type: ResourceType; status?: string; resultField?: { label: string; value: string }; headTruncated?: boolean; independent?: boolean }): Promise<Pick<ISubtreeLevelEntry, 'resultField' | 'lastRun' | 'workflowRun' | 'independent'>> {
		const configDir = URI.joinPath(ticketUri, '.agents');
		let resultField = meta.resultField;
		let independent = meta.independent;
		// the Link section (CI-64 flag) and the result field may follow a truncated head
		if ((!resultField || !independent) && meta.headTruncated) {
			for (const uri of [URI.joinPath(configDir, 'ticket.md'), URI.joinPath(ticketUri, 'ticket.md')]) {
				try {
					const fullText = (await this.fileService.readFile(uri, { length: 1024 * 1024 })).value.toString();
					resultField = readTestResultField(fullText);
					independent = readIndependentFromParent(fullText);
					// remember the full read in the metadata cache (dropped with it when ticket.md changes)
					const cachedMeta = this._childEntityMetaCache.get(this.normalizeUriString(ticketUri));
					if (cachedMeta) {
						cachedMeta.resultField = resultField;
						cachedMeta.independent = independent;
						cachedMeta.headTruncated = false;
					}
					break;
				} catch {
					// try the next location
				}
			}
		}
		let lastRun: ITicketLastRunRecord | undefined;
		try {
			// The outcome of the last ticket run (CI-58: a run no longer writes its result into the Status)
			lastRun = parseTicketLastRunRecord((await this.fileService.readFile(URI.joinPath(configDir, TICKET_LAST_RUN_FILE_NAME), { length: 16384 })).value.toString());
		} catch {
			// never ran (or ran before UI-20: a legacy Status `Failed` alone explains the failure)
		}
		let workflowRun: IWorkflowRunHead | undefined;
		if (String(meta.type).toLowerCase() === 'workflow') {
			try {
				workflowRun = parseWorkflowRunsHead((await this.fileService.readFile(URI.joinPath(configDir, 'workflow_runs.json'), { length: 4096 })).value.toString());
			} catch {
				// never ran
			}
		}
		return { resultField, lastRun, workflowRun, independent };
	}

	/** The direct child ticket folders of `folderUri` (cached; reuses the cached 8KB ticket.md metadata reads). */
	private _loadSubtreeLevel(folderUri: URI): Promise<readonly ISubtreeLevelEntry[]> {
		const key = this.normalizeUriString(folderUri);
		const inFlight = this._subtreeLevelInFlight.get(key);
		if (inFlight) {
			return inFlight;
		}
		const computation = { key, isSummary: false, dirty: false };
		this._subtreeComputations.add(computation);
		const promise = (async () => {
			let children;
			try {
				children = (await this.fileService.resolve(folderUri)).children || [];
			} catch {
				return [];
			}
			const dirs = children.filter(c => c.isDirectory && !c.name.startsWith('.') && !c.name.startsWith('~') && c.name !== 'node_modules' && c.name !== 'attachments');
			const entries: ISubtreeLevelEntry[] = [];
			const BATCH_SIZE = 25;
			for (let i = 0; i < dirs.length; i += BATCH_SIZE) {
				const slice = dirs.slice(i, i + BATCH_SIZE);
				const levelEntries = await Promise.all(slice.map(async (d): Promise<ISubtreeLevelEntry | undefined> => {
					const meta = await this._readChildEntityMetadataFast(d.resource, d.name);
					if (meta.type === 'folder' || meta.type === 'file') {
						return undefined;
					}
					const ticketId = meta.ticketId || d.name;
					const label = meta.title && meta.title !== ticketId ? `${ticketId} ${meta.title}` : ticketId;
					return { uri: d.resource, status: meta.status, label, ticketId, title: meta.title, type: String(meta.type), ...await this._readTicketFailureSignals(d.resource, meta) };
				}));
				for (const entry of levelEntries) {
					if (entry) {
						entries.push(entry);
					}
				}
			}
			if (!computation.dirty) {
				this._subtreeLevelCache.set(key, { entries, timestamp: Date.now() });
			}
			return entries;
		})();
		this._subtreeLevelInFlight.set(key, promise);
		const done = () => {
			this._subtreeComputations.delete(computation);
			if (this._subtreeLevelInFlight.get(key) === promise) {
				this._subtreeLevelInFlight.delete(key);
			}
		};
		promise.then(done, done);
		return promise;
	}

	private _subtreeBaseUri(folderUri: URI): URI {
		return folderUri.path.endsWith('.code-workspace') ? dirname(folderUri) : folderUri;
	}

	peekTicketFailure(ticketUri: URI): ITicketFailure | undefined {
		return this._ticketFailures.get(this.normalizeUriString(ticketUri));
	}

	peekTicketTestResult(ticketUri: URI): { readonly label: string; readonly value: string } | undefined {
		return this._ticketTestResults.get(this.normalizeUriString(ticketUri));
	}

	peekTicketIndependentFromParent(ticketUri: URI): boolean {
		return this._ticketIndependent.has(this.normalizeUriString(ticketUri));
	}

	peekTicketSubtreeSummary(folderUri: URI): ITicketSubtreeSummary | undefined {
		return this._subtreeSummaryCache.get(this.normalizeUriString(this._subtreeBaseUri(folderUri)))?.summary;
	}

	/** UI-21: flattened rows per workspace sub-tree summary (a new summary object means its rows are rebuilt). */
	private readonly _ticketSearchRows = new WeakMap<ITicketSubtreeSummary, { workspaceKey: string; workspaceName: string; entries: readonly ITicketSearchEntry[] }>();

	async getTicketSearchIndex(): Promise<ITicketSearchIndex> {
		const workspaces = (await this.getWorkspaces()).filter(w => !w.isMissing);
		let truncated = false;
		const lists = await Promise.all(workspaces.map(async (ws): Promise<readonly ITicketSearchEntry[]> => {
			let summary: ITicketSubtreeSummary;
			try {
				summary = await this.getTicketSubtreeSummary(ws.uri);
			} catch {
				return [];
			}
			truncated ||= summary.truncated;
			const workspaceKey = canonicalTreeKey(ws.id);
			const workspaceName = this.getMetadataSnapshot(ws.uri)?.title || ws.name;
			const memo = this._ticketSearchRows.get(summary);
			if (memo && memo.workspaceKey === workspaceKey && memo.workspaceName === workspaceName) {
				return memo.entries;
			}
			const entries = flattenTicketSubtree(summary, { key: workspaceKey, name: workspaceName, resource: ws.uri });
			this._ticketSearchRows.set(summary, { workspaceKey, workspaceName, entries });
			return entries;
		}));
		return { entries: lists.flat(), truncated };
	}

	getTicketSubtreeSummary(folderUri: URI): Promise<ITicketSubtreeSummary> {
		const base = this._subtreeBaseUri(folderUri);
		const key = this.normalizeUriString(base);
		const cached = this._subtreeSummaryCache.get(key);
		if (cached && !cached.stale && (Date.now() - cached.timestamp) < WorkspacesExplorerService.SUBTREE_CACHE_TTL) {
			return Promise.resolve(cached.summary);
		}
		const inFlight = this._subtreeSummaryInFlight.get(key);
		if (inFlight) {
			return inFlight;
		}
		const computation = { key, isSummary: true, dirty: false };
		this._subtreeComputations.add(computation);
		const promise = (async (): Promise<ITicketSubtreeSummary> => {
			const wsStatuses = await this.getWorkspaceStatuses(base);
			const maxDepth = WorkspacesExplorerService.SUBTREE_MAX_DEPTH;
			const maxNodes = WorkspacesExplorerService.SUBTREE_MAX_NODES;
			let nodeCount = 0;
			let truncated = false;
			const visited = new Set<string>();
			const levelOf = (uri: URI) => {
				const level = this._subtreeLevelCache.get(this.normalizeUriString(uri));
				return level && (Date.now() - level.timestamp) < WorkspacesExplorerService.SUBTREE_CACHE_TTL ? level.entries : this._loadSubtreeLevel(uri);
			};
			const build = async (uri: URI, depth: number): Promise<ITicketSubtreeNode[]> => {
				const k = this.normalizeUriString(uri);
				if (visited.has(k)) {
					return [];
				}
				visited.add(k);
				if (depth > 0 && nodeCount >= maxNodes) {
					truncated = true;
					return [];
				}
				const level = await levelOf(uri);
				if (level.length === 0) {
					return [];
				}
				if (depth >= maxDepth) {
					truncated = true;
					return [];
				}
				// the direct children of the requested folder are always complete; deeper levels share the size budget
				let entries = level;
				if (depth > 0) {
					const room = Math.max(0, maxNodes - nodeCount);
					if (entries.length > room) {
						entries = entries.slice(0, room);
						truncated = true;
					}
				}
				nodeCount += entries.length;
				const childLists = await Promise.all(entries.map(e => build(e.uri, depth + 1)));
				return entries.map((e, i): ITicketSubtreeNode => {
					const removed = this._isRemovedStatus(e.status, wsStatuses);
					const failure = detectTicketFailure({ status: e.status, removed, resultField: e.resultField, lastRun: e.lastRun, workflowRun: e.workflowRun });
					const failureKey = this.normalizeUriString(e.uri);
					if (failure) {
						this._ticketFailures.set(failureKey, failure);
					} else {
						this._ticketFailures.delete(failureKey);
					}
					if (e.resultField && !removed) {
						this._ticketTestResults.set(failureKey, e.resultField);
					} else {
						this._ticketTestResults.delete(failureKey);
					}
					if (e.independent) {
						this._ticketIndependent.set(failureKey, true);
					} else {
						this._ticketIndependent.delete(failureKey);
					}
					return {
						category: e.status ? wsStatuses.getCategory(e.status) : undefined,
						removed,
						children: childLists[i],
						label: e.label,
						failure,
						resource: e.uri,
						ticketId: e.ticketId,
						title: e.title,
						type: e.type,
						status: e.status
					};
				});
			};
			const summary: ITicketSubtreeSummary = { children: await build(base, 0), truncated };
			if (!computation.dirty) {
				this._subtreeSummaryCache.set(key, { summary, timestamp: Date.now(), stale: false });
			}
			return summary;
		})();
		this._subtreeSummaryInFlight.set(key, promise);
		const done = () => {
			this._subtreeComputations.delete(computation);
			if (this._subtreeSummaryInFlight.get(key) === promise) {
				this._subtreeSummaryInFlight.delete(key);
			}
		};
		promise.then(done, done);
		return promise;
	}

	async getWorkspaceChildren(workspaceUri: URI, includeRemoved: boolean = false): Promise<IWorkspaceChildItem[]> {
		const page = await this.scanWorkspaceChildrenPaginated(workspaceUri, includeRemoved, undefined);
		return page.items;
	}

	public async getWorkspaceStatuses(targetUri: URI): Promise<IWorkspaceStatusesInfo> {
		const cacheKey = this.normalizeUriString(targetUri);
		const cached = this._workspaceStatusesCache.get(cacheKey);
		if (cached && (Date.now() - cached.timestamp) < 60000) {
			return cached.info;
		}

		const inferCategory = (name: string): CanonicalStatusCategory => {
			const lower = name.toLowerCase();
			if (lower.includes('progress') || lower.includes('dev') || lower.includes('doing') || lower.includes('test') || lower.includes('review') || lower.includes('deploy') || lower.includes('working') || lower.includes('wip')) {
				return 'In Progress';
			}
			if (lower.includes('done') || lower.includes('finish') || lower.includes('complete') || lower.includes('release') || lower.includes('close') || lower.includes('merged')) {
				return 'Done';
			}
			if (lower.includes('block') || lower.includes('fail') || lower.includes('hold') || lower.includes('pause') || lower.includes('wait') || lower.includes('reject') || lower.includes('issue')) {
				return 'Blocked';
			}
			if (lower.includes('remove') || lower.includes('cancel') || lower.includes('archive') || lower.includes('discard') || lower.includes('delete') || lower.includes('trash')) {
				return 'Removed';
			}
			return 'Todo';
		};

		const buildInfo = (statuses: string[], mapping: { [key: string]: CanonicalStatusCategory }, removedStatus?: string, labels: readonly ITicketLabelDefinition[] = []): IWorkspaceStatusesInfo => {
			const safeStatuses = statuses.length > 0 ? statuses : ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'];
			const safeMapping: { [key: string]: CanonicalStatusCategory } = { ...mapping };
			for (const st of safeStatuses) {
				if (!safeMapping[st]) {
					safeMapping[st] = inferCategory(st);
				}
			}

			let rem = removedStatus;
			if (!rem || !safeStatuses.some(s => s.toLowerCase() === rem!.toLowerCase())) {
				rem = safeStatuses.find(s => safeMapping[s] === 'Removed') || safeStatuses.find(s => /remove|cancel|archive|discard/i.test(s)) || safeStatuses[safeStatuses.length - 1];
			}

			const initial = safeStatuses.find(s => safeMapping[s] === 'Todo') || safeStatuses[0] || 'Todo';

			return {
				statuses: safeStatuses,
				mapping: safeMapping,
				removedStatus: rem || 'Removed',
				initialStatus: initial,
				labels,
				getCategory: (statusName?: string): CanonicalStatusCategory => {
					if (!statusName) { return 'Todo'; }
					if (safeMapping[statusName]) { return safeMapping[statusName]; }
					const matchedKey = Object.keys(safeMapping).find(k => k.toLowerCase() === statusName.toLowerCase());
					if (matchedKey) { return safeMapping[matchedKey]; }
					return inferCategory(statusName);
				}
			};
		};

		let fallbackLabels: ITicketLabelDefinition[] = [];
		try {
			const workspaces = await this.getWorkspaces();
			const targetPath = targetUri.path.toLowerCase();
			const matchedWs = workspaces
				.filter(ws => targetPath === ws.uri.path.toLowerCase() || targetPath.startsWith(ws.uri.path.toLowerCase() + '/'))
				.sort((a, b) => b.uri.path.length - a.uri.path.length)[0];

			if (matchedWs) {
				const wsCacheKey = this.normalizeUriString(matchedWs.uri);
				const wsCached = this._workspaceStatusesCache.get(wsCacheKey);
				if (wsCached && (Date.now() - wsCached.timestamp) < 60000) {
					this._workspaceStatusesCache.set(cacheKey, wsCached);
					return wsCached.info;
				}

				const wsTicketUri = URI.joinPath(matchedWs.uri, '.agents', 'ticket.md');
				const rootTicketUri = URI.joinPath(matchedWs.uri, 'ticket.md');
				for (const uri of [wsTicketUri, rootTicketUri]) {
					try {
						const content = (await this.fileService.readFile(uri, { length: 8192 })).value.toString();
						const statusesMatch = content.match(/-\s+\*\*Ticket\s+Statuses\*\*:\s*([^\r\n]+)/i);
						const mappingMatch = content.match(/-\s+\*\*Status\s+Mapping\*\*:\s*([^\r\n]+)/i);
						const removedMatch = content.match(/-\s+\*\*Removed\s+Status\*\*:\s*([^\r\n]+)/i);
						const labelsMatch = content.match(/-\s+\*\*Ticket\s+Labels\*\*:\s*([^\r\n]+)/i);
						const parsedLabels = parseLabelDefinitions(labelsMatch?.[1]);
						fallbackLabels = parsedLabels;

						let parsedStatuses: string[] = [];
						if (statusesMatch && statusesMatch[1]) {
							parsedStatuses = statusesMatch[1].split(/[,;\n\uFF0C]+/).map(s => s.trim()).filter(Boolean);
						}

						let parsedMapping: { [key: string]: CanonicalStatusCategory } = {};
						if (mappingMatch && mappingMatch[1]) {
							try {
								parsedMapping = JSON.parse(mappingMatch[1].trim());
							} catch {
								// ignore json parse error
							}
						}

						if (parsedStatuses.length > 0 || Object.keys(parsedMapping).length > 0) {
							if (parsedStatuses.length === 0) {
								parsedStatuses = Object.keys(parsedMapping);
							}
							const info = buildInfo(parsedStatuses, parsedMapping, removedMatch?.[1]?.trim(), parsedLabels);
							const entry = { info, timestamp: Date.now() };
							this._workspaceStatusesCache.set(wsCacheKey, entry);
							this._workspaceStatusesCache.set(cacheKey, entry);
							return info;
						}
						break;
					} catch {
						// file does not exist
					}
				}
			}
		} catch (err) {
			console.error('Failed to get workspace statuses:', err);
		}

		const fallbackInfo = buildInfo(
			['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'],
			{
				'Todo': 'Todo',
				'In Progress': 'In Progress',
				'Done': 'Done',
				'Blocked': 'Blocked',
				'Removed': 'Removed'
			},
			'Removed',
			fallbackLabels
		);
		this._workspaceStatusesCache.set(cacheKey, { info: fallbackInfo, timestamp: Date.now() });
		return fallbackInfo;
	}

	public async detectCustomEntityIdentityFromDisk(childUri: URI, fallbackName: string): Promise<{ ticketId?: string; title?: string }> {
		const meta = await this._readChildEntityMetadataFast(childUri, fallbackName);
		return {
			ticketId: meta.ticketId,
			title: meta.title
		};
	}

	public async detectCustomEntityStatusFromDisk(childUri: URI): Promise<string | undefined> {
		const fallbackName = childUri.path.split('/').filter(Boolean).pop() || '';
		const meta = await this._readChildEntityMetadataFast(childUri, fallbackName);
		return meta.status;
	}

	public async setEntityStatus(entityUri: URI, newStatus: string, actor?: TicketChangeActorInput): Promise<void> {
		this._invalidateCacheForUri(entityUri);
		const configDir = URI.joinPath(entityUri, '.agents');
		const ticketUri = URI.joinPath(configDir, 'ticket.md');
		const rootTicketUri = URI.joinPath(entityUri, 'ticket.md');
		let targetUri: URI | undefined;

		if (await this.fileService.exists(ticketUri)) {
			targetUri = ticketUri;
		} else if (await this.fileService.exists(rootTicketUri)) {
			targetUri = rootTicketUri;
		}

		if (targetUri) {
			try {
				const content = await this.fileService.readFile(targetUri);
				const text = content.value.toString();
				let updated = '';
				if (/-\s+\*\*Status\*\*:/i.test(text)) {
					updated = text.replace(/-\s+\*\*Status\*\*:\s*([^\r\n]*)/i, `- **Status**: ${newStatus}`);
				} else {
					updated = text + `\n- **Status**: ${newStatus}\n`;
				}
				await writeTicketFile(this.fileService, targetUri, updated, actor);
				this._invalidateCacheForUri(entityUri);
			} catch (err) {
				console.error('Failed to update status in ticket.md:', err);
			}
		}
		this._onDidChangeWorkspaces.fire();
	}

	private async _resolveTicketMdUri(entityUri: URI): Promise<URI | undefined> {
		const ticketUri = URI.joinPath(entityUri, '.agents', 'ticket.md');
		if (await this.fileService.exists(ticketUri)) {
			return ticketUri;
		}
		const rootTicketUri = URI.joinPath(entityUri, 'ticket.md');
		if (await this.fileService.exists(rootTicketUri)) {
			return rootTicketUri;
		}
		return undefined;
	}

	public async restoreEntity(entityUri: URI, actor?: TicketChangeActorInput, templateStatuses?: readonly ITemplateStatusLike[]): Promise<ITicketRestoreResult> {
		const ticketUri = await this._resolveTicketMdUri(entityUri);
		if (!ticketUri) {
			throw new Error(`No ticket.md found in '${entityUri.fsPath}'.`);
		}
		const current = readTicketStatus((await this.fileService.readFile(ticketUri)).value.toString());
		const wsStatuses = await this.getWorkspaceStatuses(entityUri);
		const lifecycle = resolveEffectiveStatusOptions(templateStatuses, wsStatuses);
		const isRemoved = (status: string): boolean => {
			const option = lifecycle.source === 'template' ? findStatusOption(lifecycle.options, status) : undefined;
			return option ? option.category === 'Removed' : this._isRemovedStatus(status, wsStatuses);
		};
		if (!current || !isRemoved(current)) {
			return { status: current ?? '', source: 'initial', changed: false, fromStatus: current };
		}

		const decision = resolveRestoreStatus(await this._readStatusChangeRecords(entityUri, isRemoved), {
			options: lifecycle.options,
			isRemoved,
			fallbackInitialStatus: wsStatuses.initialStatus || wsStatuses.statuses[0] || 'Todo'
		});
		await this.setEntityStatus(entityUri, decision.status, actor);
		return { ...decision, changed: true, fromStatus: current };
	}

	/**
	 * The `status` change records (CI-50) of a ticket's work log, newest entries first. Entries never overlap in time
	 * (a new entry ends coalescing), so reading stops after the first entry that holds a change from an active status
	 * into a removed one.
	 */
	private async _readStatusChangeRecords(entityUri: URI, isRemoved: (status: string) => boolean): Promise<ITicketChangeRecord[]> {
		const records: ITicketChangeRecord[] = [];
		try {
			const storage = new TicketWorklogStorage(this.fileService);
			for (const meta of await storage.listWorklogMetas(entityUri)) {
				const entry = await storage.readWorklogEntry(entityUri, meta);
				if (!entry.fullContent.includes(TICKET_CHANGE_RECORDS_HEADING)) {
					continue;
				}
				const statusRecords = parseTicketChangeRecords(entry.fullContent).filter(r => r.field === 'status');
				records.push(...statusRecords);
				if (statusRecords.some(r => typeof r.old === 'string' && typeof r.new === 'string' && r.old.trim() && isRemoved(r.new) && !isRemoved(r.old))) {
					break;
				}
			}
		} catch (err) {
			console.error('[WorkspacesExplorer] Failed to read the status change log:', err);
		}
		return records;
	}

	public async setEntityLabels(entityUri: URI, labels: string[], actor?: TicketChangeActorInput): Promise<void> {
		const ticketUri = await this._resolveTicketMdUri(entityUri);
		if (!ticketUri) {
			throw new Error(`No ticket.md found in '${entityUri.fsPath}'.`);
		}
		const text = (await this.fileService.readFile(ticketUri)).value.toString();
		const updated = setTicketLabelsLine(text, labels);
		if (updated !== text) {
			await writeTicketFile(this.fileService, ticketUri, updated, actor);
		}
		this._invalidateCacheForUri(entityUri);
		this._onDidChangeWorkspaces.fire();
	}

	public async setEntityPriority(entityUri: URI, priority: string, actor?: TicketChangeActorInput): Promise<void> {
		const ticketUri = await this._resolveTicketMdUri(entityUri);
		if (!ticketUri) {
			throw new Error(`No ticket.md found in '${entityUri.fsPath}'.`);
		}
		const text = (await this.fileService.readFile(ticketUri)).value.toString();
		const updated = setTicketPriorityLine(text, priority);
		if (updated !== text) {
			await writeTicketFile(this.fileService, ticketUri, updated, actor);
		}
		this._invalidateCacheForUri(entityUri);
		this._onDidChangeWorkspaces.fire();
	}

	/** The ticket.md files of the workspace: its root ticket and every ticket folder below it (dot folders skipped). */
	private async _collectWorkspaceTicketFiles(workspaceRootUri: URI): Promise<{ folderUri: URI; ticketUri: URI }[]> {
		const result: { folderUri: URI; ticketUri: URI }[] = [];
		const visited = new Set<string>();
		const visit = async (folderUri: URI, depth: number): Promise<void> => {
			const key = this.normalizeUriString(folderUri);
			if (depth > 12 || visited.has(key)) {
				return;
			}
			visited.add(key);
			const ticketUri = await this._resolveTicketMdUri(folderUri);
			if (ticketUri) {
				result.push({ folderUri, ticketUri });
			}
			let children;
			try {
				children = (await this.fileService.resolve(folderUri)).children;
			} catch {
				return;
			}
			for (const child of children || []) {
				if (child.isDirectory && !child.name.startsWith('.') && !child.name.startsWith('~') && child.name !== 'node_modules' && child.name !== 'attachments') {
					await visit(child.resource, depth + 1);
				}
			}
		};
		await visit(workspaceRootUri, 0);
		return result;
	}

	public async getWorkspaceStatusUsage(targetUri: URI): Promise<{ [status: string]: number }> {
		const rootUri = await this.findWorkspaceRootUri(targetUri);
		const usage: { [status: string]: number } = {};
		for (const { ticketUri } of await this._collectWorkspaceTicketFiles(rootUri)) {
			try {
				const status = readTicketStatus((await this.fileService.readFile(ticketUri)).value.toString());
				if (status) {
					usage[status] = (usage[status] || 0) + 1;
				}
			} catch {
				// unreadable ticket: not counted
			}
		}
		return usage;
	}

	public async updateWorkspaceLifecycle(workspaceUri: URI, update: IWorkspaceLifecycleUpdate, actor?: TicketChangeActorInput): Promise<{ migratedTickets: number }> {
		const rootUri = await this.findWorkspaceRootUri(workspaceUri);
		const rootTicketUri = await this._resolveTicketMdUri(rootUri);
		if (!rootTicketUri) {
			throw new Error(`The workspace '${rootUri.fsPath}' has no ticket.md.`);
		}

		let text = (await this.fileService.readFile(rootTicketUri)).value.toString();
		if (update.statuses && update.statuses.length > 0) {
			text = upsertWorkspaceMetadata(text, TICKET_STATUSES_KEY, update.statuses.join(', '));
		}
		if (update.mapping && Object.keys(update.mapping).length > 0) {
			text = upsertWorkspaceMetadata(text, STATUS_MAPPING_KEY, JSON.stringify(update.mapping));
		}
		if (update.removedStatus) {
			text = upsertWorkspaceMetadata(text, REMOVED_STATUS_KEY, update.removedStatus);
		}
		if (update.labels) {
			text = upsertWorkspaceMetadata(text, TICKET_LABELS_METADATA_KEY, serializeLabelDefinitions(update.labels));
		}
		await writeTicketFile(this.fileService, rootTicketUri, text, actor);

		let migratedTickets = 0;
		const statusMigration = update.statusMigration || {};
		const labelRenames = update.labelRenames || {};
		if (Object.keys(statusMigration).length > 0 || Object.keys(labelRenames).length > 0) {
			for (const { folderUri, ticketUri } of await this._collectWorkspaceTicketFiles(rootUri)) {
				try {
					const original = (await this.fileService.readFile(ticketUri)).value.toString();
					let next = original;
					const newStatus = migrateStatus(readTicketStatus(next), statusMigration);
					if (newStatus) {
						next = setTicketStatusLine(next, newStatus) ?? next;
					}
					const renamedLabels = renameTicketLabels(readTicketLabels(next), labelRenames);
					if (renamedLabels) {
						next = setTicketLabelsLine(next, renamedLabels);
					}
					if (next !== original) {
						await writeTicketFile(this.fileService, ticketUri, next, actor);
						this._invalidateCacheForUri(folderUri);
						migratedTickets++;
					}
				} catch (err) {
					console.error('Failed to migrate ticket status / labels:', err);
				}
			}
		}

		this._workspaceStatusesCache.clear();
		this._childEntityMetaCache.clear();
		this._subtreeLevelCache.clear();
		this._markAllSubtreeSummariesStale();
		this._onDidChangeWorkspaces.fire();
		return { migratedTickets };
	}

	public async detectCustomEntityTypeFromDisk(childUri: URI): Promise<ResourceType> {
		const fallbackName = childUri.path.split('/').filter(Boolean).pop() || '';
		const meta = await this._readChildEntityMetadataFast(childUri, fallbackName);
		return meta.type;
	}

	private generateWorkspaceCodeFromName(name: string): string {
		const clean = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (clean.length >= 3) {
			return clean.slice(0, 5);
		}
		return 'PRJ1';
	}

	async resolveEntityCode(targetParentUri: URI, customCode?: string): Promise<string> {
		if (customCode && customCode.trim()) {
			const sanitized = customCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
			if (sanitized) { return sanitized; }
		}

		// Look up snapshot hierarchy or .agents/*.md on disk
		let curr: URI | undefined = targetParentUri;
		while (curr) {
			const snapshot = this.getMetadataSnapshot(curr);
			if (snapshot && snapshot.entityCode) {
				const snapCode = snapshot.entityCode.replace(/-0000$/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
				if (snapCode && snapCode !== 'NONE') {
					return snapCode;
				}
			}
			if (snapshot && snapshot.workspaceId) {
				const snapWsCode = snapshot.workspaceId.replace(/-0000$/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
				if (snapWsCode && snapWsCode !== 'NONE') {
					return snapWsCode;
				}
			}

			// Disk fallback: check .agents for main md file
			const configDir = URI.joinPath(curr, '.agents');
			let foundMdUri: URI | undefined;
			try {
				if (await this.fileService.exists(configDir)) {
					const stat = await this.fileService.resolve(configDir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && child.name.endsWith('.md')) {
								const nameLower = child.name.toLowerCase();
								if (nameLower !== 'instruction.md' && nameLower !== 'readme.md' && nameLower !== 'work_log.md' && nameLower !== 'worklog.md' && nameLower !== 'ticket.md' && nameLower !== 'tickets.md') {
									foundMdUri = child.resource;
									break;
								}
							}
						}
					}
				}
			} catch { }

			if (foundMdUri) {
				try {
					const content = (await this.fileService.readFile(foundMdUri, { length: 8192 })).value.toString();
					const codeMatch = content.match(/-\s*\*\*(?:Entity|Ticket) Code\*\*:\s*`?([A-Za-z0-9_-]+)`?/i);
					if (codeMatch && codeMatch[1]) {
						const code = codeMatch[1].replace(/-0000$/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
						if (code && code !== 'NONE') { return code; }
					}
					const wsIdMatch = content.match(/-\s*\*\*Workspace ID\*\*:\s*`?([A-Za-z0-9_-]+)`?/i);
					if (wsIdMatch && wsIdMatch[1]) {
						const code = wsIdMatch[1].replace(/-0000$/i, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
						if (code && code !== 'NONE') { return code; }
					}
				} catch { }
			}

			const parentPath = dirname(curr);
			if (!parentPath || parentPath.path === curr.path) { break; }
			curr = parentPath;
		}

		// Fallback code derived from workspace root folder name
		const wsRoot = await this.findWorkspaceRootUri(targetParentUri);
		const folderName = wsRoot.path.split('/').filter(Boolean).pop() || targetParentUri.path.split('/').filter(Boolean).pop() || 'WS';
		return this.generateWorkspaceCodeFromName(folderName);
	}

	public async findWorkspaceRootUri(targetUri: URI): Promise<URI> {
		const savedUris = this.getSavedWorkspaceUris();
		const targetPath = targetUri.path;
		// 1. Check if targetUri is inside any registered workspace URI
		for (const wsUriStr of savedUris) {
			const wsUri = URI.parse(wsUriStr);
			if (targetPath === wsUri.path || targetPath.startsWith(wsUri.path + '/')) {
				return wsUri;
			}
		}

		// 2. Walk up targetUri to find .agents/workspace.md or top directory
		let curr = targetUri;
		let highestWorkspaceUri: URI = targetUri;
		while (curr) {
			const configDir = URI.joinPath(curr, '.agents');
			const wsMd = URI.joinPath(configDir, 'workspace.md');
			try {
				if (await this.fileService.exists(wsMd)) {
					return curr;
				}
			} catch { }

			const ticketMd = URI.joinPath(configDir, 'ticket.md');
			try {
				if (await this.fileService.exists(ticketMd)) {
					highestWorkspaceUri = curr;
				}
			} catch { }

			const parent = dirname(curr);
			if (!parent || parent.path === curr.path) { break; }
			curr = parent;
		}

		return highestWorkspaceUri;
	}

	public async getWorkspaceSequences(workspaceRootUri: URI): Promise<Record<string, number>> {
		try {
			const seqFileUri = URI.joinPath(workspaceRootUri, '.agents', 'sequences.json');
			if (await this.fileService.exists(seqFileUri)) {
				const content = (await this.fileService.readFile(seqFileUri)).value.toString();
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed === 'object') {
					const result: Record<string, number> = {};
					for (const [k, v] of Object.entries(parsed)) {
						if (typeof v === 'number' && !isNaN(v)) {
							result[k.toUpperCase()] = v;
						}
					}
					return result;
				}
			}
		} catch {
			// ignore
		}
		return {};
	}

	public async updateWorkspaceSequence(workspaceRootUri: URI, code: string, usedNumber: number): Promise<void> {
		if (!code || isNaN(usedNumber) || usedNumber <= 0) { return; }
		try {
			const configDir = URI.joinPath(workspaceRootUri, '.agents');
			if (!await this.fileService.exists(configDir)) {
				await this.fileService.createFolder(configDir);
			}

			const seqFileUri = URI.joinPath(configDir, 'sequences.json');
			const sequences = await this.getWorkspaceSequences(workspaceRootUri);
			const upperCode = code.toUpperCase();
			const currentMax = sequences[upperCode] || 0;
			if (usedNumber > currentMax) {
				sequences[upperCode] = usedNumber;
				const jsonStr = JSON.stringify(sequences, null, 2);
				const { VSBuffer } = await import('../../../../base/common/buffer.js');
				await this.fileService.writeFile(seqFileUri, VSBuffer.fromString(jsonStr));
			}
		} catch (err) {
			console.error('Failed to update workspace sequences.json:', err);
		}
	}

	async generateNextSequentialName(targetParentUri: URI, type: ResourceType, customCode?: string): Promise<{ name: string; code: string }> {
		const activeCode = await this.resolveEntityCode(targetParentUri, customCode);
		const prefixMap: Record<string, string> = {
			job: 'JOB',
			task: 'TASK',
			project: 'PROJECT',
			workflow: 'WORKFLOW',
			case: 'CASE',
			agent: 'AGENT',
			issue: 'ISSUE',
			analysis: 'ANALYSIS',
			workspace: 'WORKSPACE',
			folder: 'FOLDER',
			file: 'FILE'
		};
		const fallbackPrefix = prefixMap[type] || type.toUpperCase();

		const rootWsUri = await this.findWorkspaceRootUri(targetParentUri);

		// 1. Read persistent monotonic counter from .agents/sequences.json (never rolls back on deletion)
		const storedSequences = await this.getWorkspaceSequences(rootWsUri);
		let maxNum = storedSequences[activeCode.toUpperCase()] || 0;

		const regex = new RegExp(`^(?:${activeCode}|${fallbackPrefix}|${type})(?:[-_]?(?:${fallbackPrefix}|${type}))?[-_]?(\\d+)$`, 'i');
		const codeRegex = new RegExp(`^${activeCode}-(\\d+)$`, 'i');

		// 2. Check existing snapshots globally to avoid duplicate IDs/names
		try {
			const snapshots = this.entityPersistenceService.getAllSnapshots();
			for (const snap of snapshots) {
				if (snap.entityCode?.toLowerCase() === activeCode.toLowerCase() || snap.entityName.toLowerCase().startsWith(activeCode.toLowerCase() + '-')) {
					const match = snap.entityName.match(codeRegex) || snap.entityName.match(regex);
					if (match) {
						const num = parseInt(match[1], 10);
						if (!isNaN(num) && num > maxNum) {
							maxNum = num;
						}
					}
				}
			}
		} catch {
			// ignore
		}

		// 3. Recursively scan the entire workspace filesystem tree from root
		try {
			const queue: URI[] = [rootWsUri];
			const visited = new Set<string>();

			while (queue.length > 0) {
				const currentUri = queue.shift()!;
				const uriKey = currentUri.toString();
				if (visited.has(uriKey)) { continue; }
				visited.add(uriKey);

				try {
					const stat = await this.fileService.resolve(currentUri);
					if (stat.children) {
						for (const child of stat.children) {
							if (child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules' || child.name === 'attachments') {
								continue;
							}

							const match = child.name.match(codeRegex) || child.name.match(regex);
							if (match) {
								const num = parseInt(match[1], 10);
								if (!isNaN(num) && num > maxNum) {
									maxNum = num;
								}
							}

							if (child.isDirectory) {
								queue.push(child.resource);
							}
						}
					}
				} catch {
					// ignore
				}
			}
		} catch {
			// ignore
		}

		// 4. Fallback: also check immediate parent folder in case targetParentUri wasn't under rootWsUri
		try {
			const stat = await this.fileService.resolve(targetParentUri);
			if (stat.children) {
				for (const child of stat.children) {
					const match = child.name.match(codeRegex) || child.name.match(regex);
					if (match) {
						const num = parseInt(match[1], 10);
						if (!isNaN(num) && num > maxNum) {
							maxNum = num;
						}
					}
				}
			}
		} catch {
			// ignore
		}

		const nextNum = maxNum + 1;
		const formattedNum = String(nextNum).padStart(4, '0');
		return {
			name: `${activeCode}-${formattedNum}`,
			code: activeCode
		};
	}

	async createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<ICreateResourceResult> {
		// Freestyle tickets can only be created manually in the UI (the create dialog sets allowFreestyle)
		if (isFreestyleTicketType(options.type) && !options.allowFreestyle) {
			throw new Error(FREESTYLE_PROGRAMMATIC_CREATE_ERROR);
		}
		const targetFolderUri = options.targetParentUri || options.workspaceUri;
		if (!targetFolderUri) {
			throw new Error('No workspace or parent folder was given. Tickets are always created inside a workspace.');
		}
		let workspaceRootUri: URI;
		if (options.workspaceUri && !options.targetParentUri) {
			workspaceRootUri = await this.findWorkspaceRootUri(options.workspaceUri);
		} else if (options.workspaceUri) {
			workspaceRootUri = options.workspaceUri;
		} else if (options.targetParentUri) {
			workspaceRootUri = await this.findWorkspaceRootUri(options.targetParentUri);
		} else {
			workspaceRootUri = targetFolderUri;
		}
		const type = options.type;
		const description = options.description;

		let name = options.name ? options.name.trim() : '';

		if (type === 'folder') {
			const folderName = name || 'new_folder';
			const folderUri = URI.joinPath(targetFolderUri, folderName);
			const alreadyExists = await this.fileService.exists(folderUri);
			if (!alreadyExists) {
				await this.fileService.createFolder(folderUri);
			}
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists, uri: folderUri };
		}

		if (type === 'file') {
			const fileName = name || 'new_file.md';
			const fileUri = URI.joinPath(targetFolderUri, fileName);
			const alreadyExists = await this.fileService.exists(fileUri);
			if (!alreadyExists) {
				const { VSBuffer } = await import('../../../../base/common/buffer.js');
				await this.fileService.createFile(fileUri, VSBuffer.fromString(description || `# ${fileName}\n`));
			}
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists, uri: fileUri };
		}

		// A Sub-Workflow ticket (encapsulation, programs, AI) belongs to a workflow: validated before anything is written
		const subWorkflowDraft = isSubWorkflowTicketType(type) ? await this._prepareSubWorkflowDraft(options, targetFolderUri) : undefined;

		const activeCode = await this.resolveEntityCode(targetFolderUri, options.code);

		if (!name || name === 'AUTO') {
			const seq = await this.generateNextSequentialName(targetFolderUri, type, options.code);
			name = seq.name;
		}

		// Preserve exact case and hyphens (-), avoiding extra lowercasing or type prefix prepending
		const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const folderName = sanitizedName;
		const entityFolderUri = URI.joinPath(targetFolderUri, folderName);
		const mainMdFileName = 'ticket.md';
		const mainMdUri = URI.joinPath(entityFolderUri, '.agents', mainMdFileName);

		const alreadyExists = await this.fileService.exists(mainMdUri) || await this.fileService.exists(entityFolderUri);

		if (alreadyExists) {
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists: true, uri: mainMdUri };
		}

		const parentSnapshot = this.entityPersistenceService.getSnapshot(targetFolderUri);
		let parentType = parentSnapshot ? parentSnapshot.entityType : 'workspace';
		if (!parentSnapshot) {
			const detected = await this.detectCustomEntityTypeFromDisk(targetFolderUri);
			if (detected && detected !== 'folder' && detected !== 'file') {
				parentType = detected;
			}
		}
		const parentName = parentSnapshot ? parentSnapshot.entityName : (targetFolderUri.path.split('/').filter(Boolean).pop() || 'Workspace');

		const defaultAgentModel = getGlobalDefaultModel();
		let finalModel = { providerId: defaultAgentModel?.providerId || 'gemini', modelId: defaultAgentModel?.modelId || 'gemini-2.5-flash', credentialId: defaultAgentModel?.credentialId as string | undefined };
		let finalSystemPrompt = `# Agent: ${name}\n\nYou are a specialized AI Agent serving '${parentName}'.`;

		if (type === 'agent') {
			if (options.agentModel) {
				finalModel = {
					providerId: options.agentModel.providerId,
					modelId: options.agentModel.modelId,
					credentialId: options.agentModel.credentialId
				};
			}
			if (options.agentSystemPrompt) {
				finalSystemPrompt = options.agentSystemPrompt;
			}
		}

		if (type === 'agent' && !options.agentModel && options.assignedAgentId && this.agentsManagerService) {
			const baseAgent = await this.agentsManagerService.getAgent(options.assignedAgentId);
			if (baseAgent) {
				if (baseAgent.model) {
					finalModel = {
						providerId: baseAgent.model.providerId,
						modelId: baseAgent.model.modelId,
						credentialId: baseAgent.model.credentialId
					};
				}
				const basePrompt = baseAgent.systemPrompt || '';
				const specPrompt = options.agentRulePrompt || '';
				if (basePrompt && specPrompt) {
					finalSystemPrompt = `${basePrompt}\n\n## Custom Rules / Specific Prompt for this instance:\n${specPrompt}`;
				} else if (basePrompt) {
					finalSystemPrompt = basePrompt;
				} else if (specPrompt) {
					finalSystemPrompt = specPrompt;
				}
			}
		}

		let attachmentNames: string[] | undefined;
		if (options.attachments && options.attachments.length > 0) {
			const attachmentsDir = URI.joinPath(entityFolderUri, 'attachments');
			if (!await this.fileService.exists(attachmentsDir)) {
				await this.fileService.createFolder(attachmentsDir);
			}
			attachmentNames = [];
			for (const attUri of options.attachments) {
				const fileName = attUri.path.split('/').filter(Boolean).pop() || 'attachment';
				const destUri = URI.joinPath(attachmentsDir, fileName);
				try {
					await this.fileService.copy(attUri, destUri, true);
					attachmentNames.push(fileName);
				} catch (err) {
					console.error('Failed to copy attachment:', err);
				}
			}
		}

		// If git repository is specified, ensure Git is cloned / initialized and ready BEFORE creating files
		if (options.gitRepoUrl) {
			await this.ensureGitRepositoryReady(entityFolderUri, options.gitRepoUrl, options.gitBranch);
		}

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: entityFolderUri.toString(),
			entityName: name,
			title: options.title || subWorkflowDraft?.name || name,
			entityType: type,
			entityCode: activeCode,
			status: options.status || 'Todo',
			priority: options.priority || 'Medium',
			labels: options.labels,
			assignedAgentId: options.assignedAgentId,
			assignedAgentName: options.assignedAgentName,
			agentRulePrompt: options.agentRulePrompt,
			ownerAccount: this.activeUserEmail || 'unauthenticated',
			description: description || (subWorkflowDraft ? buildSubWorkflowTicketDescription(subWorkflowDraft) : (options.title ? options.title : `${parentType} ${type}`)),
			belongsToWorkspaceUri: workspaceRootUri.toString(),
			role: description || `${parentType} Agent`,
			modelName: finalModel.modelId,
			systemPrompt: finalSystemPrompt,
			scopeType: parentType,
			scopeId: targetFolderUri.toString(),
			scopeName: parentName,
			typeDefinition: (options.typeDefinition && options.typeDefinition !== 'Built-in (System)' && options.typeDefinition !== 'None') ? options.typeDefinition : undefined,
			typePrompt: options.typePrompt,
			ticketPrompt: options.ticketPrompt || options.agentRulePrompt,
			linkTo: options.linkTo,
			linkedBy: options.linkedBy,
			attachments: attachmentNames,
			git: (options.gitRepoUrl || options.gitBranch) ? { remoteUrl: options.gitRepoUrl, branch: options.gitBranch } : undefined,
			customMetadata: subWorkflowDraft ? { ...(options.customMetadata || {}), ...buildSubWorkflowTicketMetadata(subWorkflowDraft) } : options.customMetadata
		}, targetFolderUri, true).catch(err => {
			// Permission denied (e.g. macOS privacy): stop with a clear error, never fall back to another folder
			throw toFolderAccessError(err, entityFolderUri);
		});

		if (type === 'agent' && this.agentsManagerService) {
			await this.agentsManagerService.addAgent({
				name: options.title || name,
				ticketId: name,
				title: options.title || name,
				role: description || `${parentType} Agent`,
				description: description || `${parentType} Agent`,
				systemPrompt: finalSystemPrompt,
				model: finalModel,
				avatarIcon: 'robot',
				scopeType: parentType as AgentScopeType,
				scopeId: targetFolderUri.toString(),
				scopeName: parentName,
				folderPath: entityFolderUri.fsPath,
				status: 'idle'
			}, targetFolderUri);
		}

		// A Freestyle ticket (no template) starts with its own default structure: Title + Description
		if (isFreestyleTicketType(type)) {
			try {
				await ensureFreestyleSchema(this.fileService, entityFolderUri);
			} catch (err) {
				console.error('Failed to write the Freestyle ticket structure:', err);
			}
		}

		// A Sub-Workflow ticket stores its definition (with the ticket ID as id) in the ticket folder
		if (subWorkflowDraft) {
			const definition: ISubWorkflowDefinition = { ...subWorkflowDraft, id: name };
			await this.fileService.writeFile(getSubWorkflowDefinitionUri(entityFolderUri), VSBuffer.fromString(serializeSubWorkflowDefinition(definition)));
		}

		// Update persistent workspace sequence counter for activeCode (strictly monotonic)
		const matchNum = sanitizedName.match(/[-_](\d+)$/);
		if (matchNum) {
			const usedNum = parseInt(matchNum[1], 10);
			if (!isNaN(usedNum)) {
				await this.updateWorkspaceSequence(workspaceRootUri, activeCode, usedNum);
			}
		}

		this._onDidChangeWorkspaces.fire();
		if (subWorkflowDraft) {
			this._onDidCreateSubWorkflowTicket.fire(entityFolderUri);
		}
		return { alreadyExists: false, uri: entityFolderUri };
	}

	/**
	 * The definition of a new Sub-Workflow ticket. Encapsulation and the migration pass a complete definition whose
	 * source workflow is known; every other caller (programs, AI) must target a folder inside a workflow folder and
	 * may pass an optional definition, which is validated (none: an empty definition).
	 */
	private async _prepareSubWorkflowDraft(options: ICreateResourceOptions, targetFolderUri: URI): Promise<ISubWorkflowDefinition> {
		const defaultName = (options.title || '').trim() || 'Sub-Workflow';
		if (options.subWorkflowSourceKnown) {
			const draft = normalizeSubWorkflowDefinition(options.subWorkflowDefinition, 'pending');
			if (!draft) {
				throw new Error('Invalid sub_workflow definition: a nodes list is required.');
			}
			draft.id = '';
			return draft;
		}
		const workflowFolder = await findEnclosingWorkflowFolder(targetFolderUri, folder => this._isWorkflowFolder(folder));
		if (!workflowFolder) {
			throw new Error(getSubWorkflowParentError(targetFolderUri.fsPath));
		}
		const workflowSnapshot = this.entityPersistenceService.getSnapshot(workflowFolder);
		const result = buildSubWorkflowDraftFromInput(options.subWorkflowDefinition, {
			name: defaultName,
			sourceWorkflowUri: workflowFolder.toString(),
			sourceWorkflowName: workflowSnapshot?.title || workflowFolder.path.split('/').filter(Boolean).pop()
		});
		if (result.error !== undefined) {
			throw new Error(result.error);
		}
		return result.draft;
	}

	private async _isWorkflowFolder(folderUri: URI): Promise<boolean> {
		try {
			if (await this.fileService.exists(URI.joinPath(folderUri, '.agents', 'workflow_flowchart.json'))) {
				return true;
			}
			if (this.entityPersistenceService.getSnapshot(folderUri)?.entityType === 'workflow') {
				return true;
			}
			if (await this.fileService.exists(URI.joinPath(folderUri, '.agents', 'ticket.md'))) {
				return await this.detectCustomEntityTypeFromDisk(folderUri) === 'workflow';
			}
		} catch {
			// not readable: not a workflow folder
		}
		return false;
	}
}
