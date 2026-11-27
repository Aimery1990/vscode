/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IWorkflowItem, ISavedWorkflowRecord, IWorkflowsManagerService } from '../common/workflowsManager.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { WorkflowEditorInput } from './workflowEditorInput.js';

const SAVED_WORKFLOWS_STORAGE_KEY = 'workflowsManager.savedWorkflows';
const REMOVED_WORKFLOWS_STORAGE_KEY = 'workflowsManager.removedWorkflows';

export class WorkflowsManagerService extends Disposable implements IWorkflowsManagerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows: Event<void> = this._onDidChangeWorkflows.event;

	private readonly _onDidExpandPane = this._register(new Emitter<string>());
	readonly onDidExpandPane: Event<string> = this._onDidExpandPane.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService
	) {
		super();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === this.savedWorkflowsKey || e.key === this.removedWorkflowsKey || e.key === SAVED_WORKFLOWS_STORAGE_KEY || e.key === REMOVED_WORKFLOWS_STORAGE_KEY) {
				this._invalidateCacheAndFire();
			}
		}));

		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => {
			this._invalidateCacheAndFire();
		}));

		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(() => {
			this._invalidateCacheAndFire();
		}));

		// Auto-track workflows when opened in editor (active / viewed workflows)
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const active = this.editorService.activeEditor;
			if (active instanceof WorkflowEditorInput) {
				const norm = this.normalizeUriString(active.workflowUri).toLowerCase();
				const saved = this.getSavedWorkflows();
				if (!saved.some(w => this.normalizeUriString(w.uri).toLowerCase() === norm)) {
					this.saveWorkflow({
						uri: active.workflowUri.toString(),
						name: active.workflowName
					});
				}
			}
		}));
	}

	private _cachedWorkflows: IWorkflowItem[] | null = null;
	private _cachedWorkflowsTimestamp = 0;
	private _inflightGetWorkflows: Promise<IWorkflowItem[]> | null = null;

	private _invalidateCacheAndFire(): void {
		this._cachedWorkflows = null;
		this._cachedWorkflowsTimestamp = 0;
		this._onDidChangeWorkflows.fire();
	}

	notifyPaneExpanded(paneId: string): void {
		this._onDidExpandPane.fire(paneId);
	}

	refresh(): void {
		this._invalidateCacheAndFire();
	}

	private get savedWorkflowsKey(): string {
		const email = this.workspacesExplorerService.getActiveUserEmail();
		return `${SAVED_WORKFLOWS_STORAGE_KEY}:${email || 'unauthenticated'}`;
	}

	private get removedWorkflowsKey(): string {
		const email = this.workspacesExplorerService.getActiveUserEmail();
		return `${REMOVED_WORKFLOWS_STORAGE_KEY}:${email || 'unauthenticated'}`;
	}

	private normalizeUriString(uri: URI | string): string {
		const str = typeof uri === 'string' ? uri : uri.toString();
		try {
			return decodeURIComponent(str).replace(/\/+$/, '');
		} catch {
			return str.replace(/\/+$/, '');
		}
	}

	private getSavedWorkflows(): ISavedWorkflowRecord[] {
		let raw = this.storageService.get(this.savedWorkflowsKey, StorageScope.PROFILE, '');
		if (!raw) {
			const legacyRaw = this.storageService.get(SAVED_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE, '');
			if (legacyRaw) {
				try {
					raw = legacyRaw;
					this.storageService.store(this.savedWorkflowsKey, raw, StorageScope.PROFILE, StorageTarget.USER);
				} catch {
					// ignore
				}
			}
		}
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw) as ISavedWorkflowRecord[];
			if (!Array.isArray(parsed)) {
				return [];
			}
			const seen = new Set<string>();
			const deduped: ISavedWorkflowRecord[] = [];
			for (const item of parsed) {
				if (!item || !item.uri) {
					continue;
				}
				const key = this.normalizeUriString(item.uri).toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					deduped.push(item);
				}
			}
			// Self-heal storage if duplicate records accumulated previously
			if (deduped.length !== parsed.length) {
				const cleanJson = JSON.stringify(deduped);
				this.storageService.store(this.savedWorkflowsKey, cleanJson, StorageScope.PROFILE, StorageTarget.USER);
				if (this.storageService.get(SAVED_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE, '')) {
					this.storageService.store(SAVED_WORKFLOWS_STORAGE_KEY, cleanJson, StorageScope.PROFILE, StorageTarget.USER);
				}
			}
			return deduped;
		} catch {
			return [];
		}
	}

	private getRemovedWorkflowUris(): string[] {
		let raw = this.storageService.get(this.removedWorkflowsKey, StorageScope.PROFILE, '');
		if (!raw) {
			raw = this.storageService.get(REMOVED_WORKFLOWS_STORAGE_KEY, StorageScope.PROFILE, '[]');
		}
		try {
			return (JSON.parse(raw) as string[]).map(u => this.normalizeUriString(u));
		} catch {
			return [];
		}
	}

	async saveWorkflow(record: ISavedWorkflowRecord): Promise<void> {
		const normUriStr = this.normalizeUriString(record.uri);
		const normLower = normUriStr.toLowerCase();
		const saved = this.getSavedWorkflows();
		const existingIdx = saved.findIndex(w => this.normalizeUriString(w.uri).toLowerCase() === normLower);
		if (existingIdx >= 0) {
			const existing = saved[existingIdx];
			if (existing.name === record.name &&
				existing.belongsToWorkspaceUri === record.belongsToWorkspaceUri &&
				existing.belongsToWorkspaceName === record.belongsToWorkspaceName) {
				return;
			}
			saved[existingIdx] = {
				...existing,
				...record,
				uri: record.uri
			};
		} else {
			saved.push(record);
		}

		// Also remove from removed list if user reopened it
		const removed = this.getRemovedWorkflowUris().filter(u => u.toLowerCase() !== normLower);
		this.storageService.store(this.removedWorkflowsKey, JSON.stringify(removed), StorageScope.PROFILE, StorageTarget.USER);

		this.storageService.store(this.savedWorkflowsKey, JSON.stringify(saved), StorageScope.PROFILE, StorageTarget.USER);
		this._invalidateCacheAndFire();
	}

	async removeSavedWorkflow(uri: URI | string): Promise<void> {
		const normUriStr = this.normalizeUriString(uri);
		const normLower = normUriStr.toLowerCase();
		const saved = this.getSavedWorkflows().filter(w => this.normalizeUriString(w.uri).toLowerCase() !== normLower);
		this.storageService.store(this.savedWorkflowsKey, JSON.stringify(saved), StorageScope.PROFILE, StorageTarget.USER);

		const removed = this.getRemovedWorkflowUris();
		if (!removed.some(u => u.toLowerCase() === normLower)) {
			removed.push(normUriStr);
			this.storageService.store(this.removedWorkflowsKey, JSON.stringify(removed), StorageScope.PROFILE, StorageTarget.USER);
		}

		this._invalidateCacheAndFire();
	}

	async getWorkflows(): Promise<IWorkflowItem[]> {
		if (this._cachedWorkflows && (Date.now() - this._cachedWorkflowsTimestamp) < 400) {
			return this._cachedWorkflows;
		}
		if (this._inflightGetWorkflows) {
			return this._inflightGetWorkflows;
		}
		this._inflightGetWorkflows = this._doGetWorkflows().finally(() => {
			this._inflightGetWorkflows = null;
		});
		return this._inflightGetWorkflows;
	}

	private async _doGetWorkflows(): Promise<IWorkflowItem[]> {
		const workflows: IWorkflowItem[] = [];
		const seenUris = new Set<string>();
		const removedUris = new Set(this.getRemovedWorkflowUris().map(u => u.toLowerCase()));

		const addWorkflow = (uri: URI, name: string, description?: string, createdAt?: string, wsUri?: string, wsName?: string, ticketId?: string, title?: string) => {
			const norm = this.normalizeUriString(uri).toLowerCase();
			if (removedUris.has(norm)) {
				return;
			}
			const snap = this.workspacesExplorerService.getMetadataSnapshot(uri);
			const resolvedTicketId = ticketId || snap?.ticketId || name;
			const resolvedTitle = title || snap?.title || name;
			const rawWsUri = wsUri || snap?.belongsToWorkspaceUri || '';
			if (!seenUris.has(norm)) {
				seenUris.add(norm);
				workflows.push({
					id: uri.toString(),
					name,
					ticketId: resolvedTicketId,
					title: resolvedTitle,
					description: description || snap?.description,
					createdAt: createdAt || snap?.createdAt || '',
					belongsToWorkspaceUri: rawWsUri,
					belongsToWorkspaceName: wsName || snap?.scopeName || '',
					isMissing: false
				});
			}
		};

		// 1. Check currently active/open editors (actively viewed workflows) - READ ONLY, NO STATE MUTATION
		const openEditors = this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
		for (const editor of openEditors) {
			if (editor instanceof WorkflowEditorInput) {
				addWorkflow(editor.workflowUri, editor.workflowName);
			}
		}

		// 2. Check direct workflows in currently open workspaces (in parallel)
		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		await Promise.all(workspaces.map(async ws => {
			try {
				const children = await this.workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'workflow') {
						addWorkflow(child.uri, child.name, undefined, undefined, ws.uri.toString(), ws.name, child.ticketId, child.title);
					}
				}
			} catch {
				// ignore
			}
		}));

		// 3. Check user saved/opened workflows from StorageService (in parallel)
		const savedList = this.getSavedWorkflows();
		await Promise.all(savedList.map(async item => {
			try {
				const uri = URI.parse(item.uri);
				const norm = this.normalizeUriString(uri).toLowerCase();
				if (seenUris.has(norm) || removedUris.has(norm)) {
					return;
				}
				const exists = await this.fileService.exists(uri);
				if (exists) {
					addWorkflow(uri, item.name, item.description, item.createdAt, item.belongsToWorkspaceUri, item.belongsToWorkspaceName);
				}
			} catch {
				// ignore
			}
		}));

		this._cachedWorkflows = workflows;
		this._cachedWorkflowsTimestamp = Date.now();
		return workflows;
	}

	async getWorkflowsByWorkspace(workspaceUri: URI): Promise<IWorkflowItem[]> {
		const all = await this.getWorkflows();
		const workspaceUriStr = workspaceUri.toString().toLowerCase();
		return all.filter(w => w.belongsToWorkspaceUri && w.belongsToWorkspaceUri.toLowerCase() === workspaceUriStr);
	}

	async deleteWorkflow(id: string): Promise<void> {
		const uri = URI.parse(id);
		await this.removeSavedWorkflow(uri);
		await this.entityPersistenceService.removeSnapshot(uri);
		this._onDidChangeWorkflows.fire();
	}
}
