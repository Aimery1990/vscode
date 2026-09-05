/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
				this._onDidChangeWorkflows.fire();
			}
		}));

		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => {
			this._onDidChangeWorkflows.fire();
		}));

		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(() => {
			this._onDidChangeWorkflows.fire();
		}));

		// Auto-track workflows when opened in editor (active / viewed workflows)
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const active = this.editorService.activeEditor;
			if (active instanceof WorkflowEditorInput) {
				const norm = this.normalizeUriString(active.workflowUri);
				const saved = this.getSavedWorkflows();
				if (!saved.some(w => this.normalizeUriString(w.uri) === norm)) {
					this.saveWorkflow({
						uri: active.workflowUri.toString(),
						name: active.workflowName
					});
				}
			}
		}));
	}

	notifyPaneExpanded(paneId: string): void {
		this._onDidExpandPane.fire(paneId);
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
			return JSON.parse(raw) as ISavedWorkflowRecord[];
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
		const saved = this.getSavedWorkflows();
		const existingIdx = saved.findIndex(w => this.normalizeUriString(w.uri) === normUriStr);
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
		const removed = this.getRemovedWorkflowUris().filter(u => u !== normUriStr);
		this.storageService.store(this.removedWorkflowsKey, JSON.stringify(removed), StorageScope.PROFILE, StorageTarget.USER);

		this.storageService.store(this.savedWorkflowsKey, JSON.stringify(saved), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeWorkflows.fire();
	}

	async removeSavedWorkflow(uri: URI | string): Promise<void> {
		const normUriStr = this.normalizeUriString(uri);
		const saved = this.getSavedWorkflows().filter(w => this.normalizeUriString(w.uri) !== normUriStr);
		this.storageService.store(this.savedWorkflowsKey, JSON.stringify(saved), StorageScope.PROFILE, StorageTarget.USER);

		const removed = this.getRemovedWorkflowUris();
		if (!removed.includes(normUriStr)) {
			removed.push(normUriStr);
			this.storageService.store(this.removedWorkflowsKey, JSON.stringify(removed), StorageScope.PROFILE, StorageTarget.USER);
		}

		this._onDidChangeWorkflows.fire();
	}

	async getWorkflows(): Promise<IWorkflowItem[]> {
		const workflows: IWorkflowItem[] = [];
		const seenUris = new Set<string>();
		const removedUris = new Set(this.getRemovedWorkflowUris());

		const addWorkflow = (uri: URI, name: string, description?: string, createdAt?: string, wsUri?: string, wsName?: string) => {
			const norm = this.normalizeUriString(uri).toLowerCase();
			if (removedUris.has(norm)) {
				return;
			}
			if (!seenUris.has(norm)) {
				seenUris.add(norm);
				workflows.push({
					id: uri.toString(),
					name,
					description,
					createdAt: createdAt || '',
					belongsToWorkspaceUri: wsUri || '',
					belongsToWorkspaceName: wsName || '',
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

		// 2. Check direct workflows in currently open workspaces (direct children only)
		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		for (const ws of workspaces) {
			try {
				const children = await this.workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'workflow') {
						addWorkflow(child.uri, child.name, undefined, undefined, ws.uri.toString(), ws.name);
					}
				}
			} catch {
				// ignore
			}
		}

		// 3. Check user saved/opened workflows from StorageService - READ ONLY, NO STATE MUTATION
		const savedList = this.getSavedWorkflows();
		for (const item of savedList) {
			try {
				const uri = URI.parse(item.uri);
				const exists = await this.fileService.exists(uri);
				if (exists) {
					addWorkflow(uri, item.name, item.description, item.createdAt, item.belongsToWorkspaceUri, item.belongsToWorkspaceName);
				}
			} catch {
				// ignore
			}
		}

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
