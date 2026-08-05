/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspacesExplorerService, IWorkspaceItem, IWorkspaceChildItem, ICreateResourceOptions, ICreateResourceResult, ICreateWorkspaceResult, ResourceType, IEntityMetadataSnapshot } from '../common/workspacesExplorer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { IAgentsManagerService } from '../../agentsManager/common/agentsManager.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';

const SAVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.savedWorkspaces';
const REMOVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.removedWorkspaces';

export class WorkspacesExplorerService extends Disposable implements IWorkspacesExplorerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces: Event<void> = this._onDidChangeWorkspaces.event;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService
	) {
		super();
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, SAVED_WORKSPACES_STORAGE_KEY, this._store)(() => this._onDidChangeWorkspaces.fire()));
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, REMOVED_WORKSPACES_STORAGE_KEY, this._store)(() => this._onDidChangeWorkspaces.fire()));
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this._onDidChangeWorkspaces.fire()));
		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => this._onDidChangeWorkspaces.fire()));
	}

	getMetadataSnapshot(uri: URI | string): IEntityMetadataSnapshot | undefined {
		const snapshot = this.entityPersistenceService.getSnapshot(uri);
		if (!snapshot) {
			return undefined;
		}
		return {
			entityUri: snapshot.entityUri,
			entityName: snapshot.entityName,
			entityType: snapshot.entityType as ResourceType,
			ownerAccount: snapshot.ownerAccount || 'aimery.wei@gmail.com',
			createdAt: snapshot.createdAt || '',
			description: snapshot.description,
			belongsToWorkspaceUri: snapshot.belongsToWorkspaceUri,
			git: snapshot.git
		};
	}

	async saveMetadataSnapshot(snapshot: IEntityMetadataSnapshot): Promise<void> {
		await this.entityPersistenceService.saveSnapshot({
			...snapshot,
			entityType: snapshot.entityType as any
		});
	}

	async repairEntityFromSnapshot(uri: URI): Promise<void> {
		await this.entityPersistenceService.repairEntityFromSnapshot(uri);
		this._onDidChangeWorkspaces.fire();
	}

	private getSavedWorkspaceUris(): string[] {
		const raw = this.storageService.get(SAVED_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE, '[]');
		try {
			return JSON.parse(raw) as string[];
		} catch {
			return [];
		}
	}

	private saveWorkspaceUris(uris: string[]): void {
		const uniqueUris = Array.from(new Set(uris.map(u => URI.parse(u).toString())));
		this.storageService.store(
			SAVED_WORKSPACES_STORAGE_KEY,
			JSON.stringify(uniqueUris),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeWorkspaces.fire();
	}

	private getRemovedWorkspaceUris(): string[] {
		const raw = this.storageService.get(REMOVED_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE, '[]');
		try {
			return JSON.parse(raw) as string[];
		} catch {
			return [];
		}
	}

	private saveRemovedWorkspaceUris(uris: string[]): void {
		const uniqueUris = Array.from(new Set(uris.map(u => URI.parse(u).toString())));
		this.storageService.store(
			REMOVED_WORKSPACES_STORAGE_KEY,
			JSON.stringify(uniqueUris),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeWorkspaces.fire();
	}

	async getWorkspaces(): Promise<IWorkspaceItem[]> {
		const currentWorkspace = this.workspaceContextService.getWorkspace();
		const currentFolderUris = new Set(currentWorkspace.folders.map(f => f.uri.toString()));

		const savedUris = this.getSavedWorkspaceUris();
		const removedUris = this.getRemovedWorkspaceUris();
		const resultItems: IWorkspaceItem[] = [];

		const processUri = async (uri: URI, isFromRecents = false) => {
			const uriStr = uri.toString();
			if (removedUris.includes(uriStr) && !currentFolderUris.has(uriStr)) {
				// User explicitly removed this entry from explorer, skip rendering!
				return;
			}

			const isCurrent = currentFolderUris.has(uriStr);

			let targetBase = uri;
			if (uri.path.endsWith('.code-workspace')) {
				targetBase = dirname(uri);
			}

			const name = targetBase.path.split('/').filter(Boolean).pop() || 'Untitled Workspace';
			const item: IWorkspaceItem = {
				id: uri.toString(),
				name,
				uri,
				isCurrent,
				isSaved: savedUris.includes(uriStr)
			};

			try {
				const folderExists = await this.fileService.exists(targetBase);
				const snapshot = this.getMetadataSnapshot(targetBase);

				if (!folderExists) {
					resultItems.push({
						...item,
						name: snapshot ? snapshot.entityName : item.name,
						detectedType: snapshot?.entityType,
						isMissing: true,
						missingReason: snapshot ? `Physical directory deleted. Snapshot: ${snapshot.entityType.toUpperCase()} (${snapshot.createdAt})` : 'Workspace folder path does not exist'
					});
					return;
				}

				const workspaceMdUri = URI.joinPath(targetBase, 'workspace.md');
				const hasWorkspaceMd = await this.fileService.exists(workspaceMdUri);

				if (!hasWorkspaceMd && !item.isCurrent) {
					let detectedType: ResourceType | undefined = snapshot?.entityType;
					const hasJobMd = await this.fileService.exists(URI.joinPath(targetBase, 'job.md'));
					const hasProjectMd = await this.fileService.exists(URI.joinPath(targetBase, 'project.md'));
					const hasTaskMd = await this.fileService.exists(URI.joinPath(targetBase, 'task.md'));
					const hasAgentMd = await this.fileService.exists(URI.joinPath(targetBase, 'agent.md'));
					const hasWorkflowMd = await this.fileService.exists(URI.joinPath(targetBase, 'workflow.md'));

					if (hasJobMd || targetBase.path.toLowerCase().includes('job')) {
						detectedType = 'job';
					} else if (hasProjectMd) {
						detectedType = 'project';
					} else if (hasTaskMd) {
						detectedType = 'task';
					} else if (hasAgentMd) {
						detectedType = 'agent';
					} else if (hasWorkflowMd) {
						detectedType = 'workflow';
					}

					resultItems.push({
						...item,
						name: snapshot ? snapshot.entityName : item.name,
						isMissing: true,
						detectedType,
						missingReason: detectedType ? `Entity folder (${detectedType}), not a Workspace` : 'workspace.md is missing'
					});
				} else {
					resultItems.push(item);
				}
			} catch {
				const snapshot = this.getMetadataSnapshot(targetBase);
				resultItems.push({
					...item,
					name: snapshot ? snapshot.entityName : item.name,
					detectedType: snapshot?.entityType,
					isMissing: true,
					missingReason: 'Inaccessible workspace path'
				});
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
				if (uri && !currentFolderUris.has(uri.toString()) && !savedUris.includes(uri.toString())) {
					await processUri(uri, true);
				}
			}
		} catch {
			// ignore
		}

		// Filter out items that are sub-directories of another valid workspace in resultItems
		const workspaceBases = resultItems
			.filter(item => !item.isMissing)
			.map(item => item.uri.path.endsWith('.code-workspace') ? dirname(item.uri).path : item.uri.path);

		const finalItems = resultItems.filter(item => {
			const itemBase = item.uri.path.endsWith('.code-workspace') ? dirname(item.uri).path : item.uri.path;
			const isSubOfAnother = workspaceBases.some(parentBase => parentBase !== itemBase && itemBase.startsWith(parentBase + '/'));
			return !isSubOfAnother;
		});

		for (const item of finalItems) {
			if (!item.isMissing) {
				item.hasDamagedDescendant = await this.checkHasDamagedDescendant(item.uri);
			}
		}

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
		const uriStr = uri.toString();

		// Remove from removed blacklist if re-added explicitly
		const removed = this.getRemovedWorkspaceUris();
		if (removed.includes(uriStr)) {
			const updatedRemoved = removed.filter(u => u !== uriStr);
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

		if (!uris.includes(uriStr)) {
			uris.push(uriStr);
			this.saveWorkspaceUris(uris);
		}
		this._onDidChangeWorkspaces.fire();
	}

	async removeSavedWorkspace(uri: URI): Promise<void> {
		const uriStr = uri.toString();
		const uris = this.getSavedWorkspaceUris();
		const updated = uris.filter(u => u !== uriStr);
		this.saveWorkspaceUris(updated);

		const removed = this.getRemovedWorkspaceUris();
		if (!removed.includes(uriStr)) {
			removed.push(uriStr);
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

	async createWorkspace(options: ICreateResourceOptions): Promise<ICreateWorkspaceResult> {
		const rootPath = options.targetParentUri ? options.targetParentUri.fsPath : '/Users/aimery/repos/jobs';

		const parentFolderUri = URI.file(rootPath);
		const folderName = options.name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const targetBaseUri = URI.joinPath(parentFolderUri, folderName);

		const alreadyExists = await this.fileService.exists(targetBaseUri);

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: targetBaseUri.toString(),
			entityName: options.name,
			entityType: 'workspace',
			ownerAccount: 'aimery.wei@gmail.com',
			description: options.description || `Workspace ${options.name}`
		}, targetBaseUri, false);

		await this.saveWorkspace(targetBaseUri);
		return { alreadyExists, uri: targetBaseUri, name: options.name };
	}

	async createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description?: string): Promise<ICreateWorkspaceResult> {
		return this.createWorkspace({ name, targetParentUri: parentLocationUri, description, type: 'workspace' });
	}

	async reinitializeWorkspaceMd(targetBaseUri: URI): Promise<void> {
		const wsName = targetBaseUri.path.split('/').filter(Boolean).pop() || 'Workspace';
		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: targetBaseUri.toString(),
			entityName: wsName,
			entityType: 'workspace',
			ownerAccount: 'aimery.wei@gmail.com',
			description: `Workspace ${wsName}`
		}, targetBaseUri, false);

		this._onDidChangeWorkspaces.fire();
	}

	async reorderWorkspaces(sourceId: string, targetId: string): Promise<void> {
		// optional order persistence logic
	}

	async scanWorkspaceChildren(workspaceUri: URI): Promise<IWorkspaceChildItem[]> {
		return this.getWorkspaceChildren(workspaceUri);
	}

	async getWorkspaceChildren(workspaceUri: URI): Promise<IWorkspaceChildItem[]> {
		let targetBase = workspaceUri;
		if (workspaceUri.path.endsWith('.code-workspace')) {
			targetBase = dirname(workspaceUri);
		}

		try {
			if (!await this.fileService.exists(targetBase)) {
				return [];
			}

			const stat = await this.fileService.resolve(targetBase);
			if (!stat.children) {
				return [];
			}

			const childrenItems: IWorkspaceChildItem[] = [];

			for (const child of stat.children) {
				if (child.name.startsWith('.')) {
					continue;
				}

				if (child.isDirectory) {
					const childUri = child.resource;

					let childType: ResourceType = 'folder';
					const hasJobMd = await this.fileService.exists(URI.joinPath(childUri, 'job.md'));
					const hasProjectMd = await this.fileService.exists(URI.joinPath(childUri, 'project.md'));
					const hasTaskMd = await this.fileService.exists(URI.joinPath(childUri, 'task.md'));
					const hasAgentMd = await this.fileService.exists(URI.joinPath(childUri, 'agent.md'));
					const hasWorkflowMd = await this.fileService.exists(URI.joinPath(childUri, 'workflow.md'));
					const hasWorkspaceMd = await this.fileService.exists(URI.joinPath(childUri, 'workspace.md'));

					if (hasJobMd || child.name.toLowerCase().includes('job')) {
						childType = 'job';
					} else if (hasProjectMd) {
						childType = 'project';
					} else if (hasTaskMd) {
						childType = 'task';
					} else if (hasAgentMd) {
						childType = 'agent';
					} else if (hasWorkflowMd) {
						childType = 'workflow';
					} else if (hasWorkspaceMd) {
						childType = 'workspace';
					}

					let isMissing = false;
					let missingReason: string | undefined;
					let hasDamagedDescendant = false;
					if (childType !== 'folder') {
						const health = await this.entityPersistenceService.inspectEntityHealth(childUri);
						isMissing = health.isMissing;
						missingReason = health.missingReason;
					}

					if (!isMissing) {
						hasDamagedDescendant = await this.checkHasDamagedDescendant(childUri);
					}

					childrenItems.push({
						id: childUri.toString(),
						name: child.name,
						type: childType,
						uri: childUri,
						isMissing,
						missingReason,
						hasDamagedDescendant
					});
				} else {
					if (child.name.endsWith('.md') || child.name.endsWith('.json') || child.name.endsWith('.sh') || child.name.endsWith('.py')) {
						childrenItems.push({
							id: child.resource.toString(),
							name: child.name,
							type: 'file',
							uri: child.resource
						});
					}
				}
			}

			return childrenItems;
		} catch {
			return [];
		}
	}

	private async checkHasDamagedDescendant(dirUri: URI): Promise<boolean> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) return false;
			for (const child of stat.children) {
				if (child.isDirectory && !child.name.startsWith('.')) {
					const childUri = child.resource;
					let childType: ResourceType = 'folder';
					const hasJobMd = await this.fileService.exists(URI.joinPath(childUri, 'job.md'));
					const hasProjectMd = await this.fileService.exists(URI.joinPath(childUri, 'project.md'));
					const hasTaskMd = await this.fileService.exists(URI.joinPath(childUri, 'task.md'));
					const hasAgentMd = await this.fileService.exists(URI.joinPath(childUri, 'agent.md'));
					const hasWorkflowMd = await this.fileService.exists(URI.joinPath(childUri, 'workflow.md'));
					const hasWorkspaceMd = await this.fileService.exists(URI.joinPath(childUri, 'workspace.md'));

					if (hasJobMd || child.name.toLowerCase().includes('job')) childType = 'job';
					else if (hasProjectMd) childType = 'project';
					else if (hasTaskMd) childType = 'task';
					else if (hasAgentMd) childType = 'agent';
					else if (hasWorkflowMd) childType = 'workflow';
					else if (hasWorkspaceMd) childType = 'workspace';

					if (childType !== 'folder') {
						const health = await this.entityPersistenceService.inspectEntityHealth(childUri);
						if (health.isMissing) return true;
					}
					if (await this.checkHasDamagedDescendant(childUri)) return true;
				}
			}
		} catch {
			// ignore
		}
		return false;
	}

	async createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<ICreateResourceResult> {
		const targetBaseUri = options.workspaceUri || options.targetParentUri || URI.file('/Users/aimery/repos/jobs');
		const type = options.type;
		const name = options.name.trim();
		const description = options.description;

		// Preserve exact case and hyphens (-), avoiding extra lowercasing or type prefix prepending
		const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const folderName = sanitizedName;
		const entityFolderUri = URI.joinPath(targetBaseUri, folderName);
		const mainMdFileName = `${type}.md`;
		const mainMdUri = URI.joinPath(entityFolderUri, mainMdFileName);

		const alreadyExists = await this.fileService.exists(mainMdUri) || await this.fileService.exists(entityFolderUri);

		if (alreadyExists) {
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists: true, uri: mainMdUri };
		}

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: entityFolderUri.toString(),
			entityName: name,
			entityType: type as any,
			ownerAccount: 'aimery.wei@gmail.com',
			description: description || `${type} description`,
			belongsToWorkspaceUri: targetBaseUri.toString()
		}, targetBaseUri, true);

		if (type === 'agent' && this.agentsManagerService) {
			const wsName = targetBaseUri.path.split('/').filter(Boolean).pop() || 'Workspace';
			await this.agentsManagerService.addAgent({
				name,
				role: description || 'Workspace Agent',
				description: description || 'Workspace Agent',
				systemPrompt: `# Agent: ${name}\n\nYou are a specialized AI Agent serving '${wsName}'.`,
				modelName: 'gemini-2.0-flash',
				avatarIcon: 'robot',
				scopeType: 'workspace',
				scopeId: targetBaseUri.toString(),
				scopeName: wsName,
				folderPath: entityFolderUri.fsPath,
				status: 'idle'
			});
		}

		this._onDidChangeWorkspaces.fire();
		return { alreadyExists: false, uri: entityFolderUri };
	}
}
