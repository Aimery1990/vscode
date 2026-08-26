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
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IDebugService } from '../../debug/common/debug.js';

const SAVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.savedWorkspaces';
const REMOVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.removedWorkspaces';

export class WorkspacesExplorerService extends Disposable implements IWorkspacesExplorerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces: Event<void> = this._onDidChangeWorkspaces.event;

	private activeUserEmail: string = '';
	private activeUserInitPromise: Promise<void>;

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
		@IDebugService private readonly debugService: IDebugService
	) {
		super();
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === this.savedWorkspacesKey || e.key === this.removedWorkspacesKey) {
				this._onDidChangeWorkspaces.fire();
			}
		}));
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this._onDidChangeWorkspaces.fire()));
		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => this._onDidChangeWorkspaces.fire()));

		this._register(this.authenticationService.onDidChangeSessions(async (e: any) => {
			await this.updateActiveUser();
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async (e: any) => {
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
				let timeoutId: any;
				try {
					const sessionsPromise = this.authenticationService.getSessions(providerId);
					const timeoutPromise = new Promise<readonly any[]>(resolve => {
						timeoutId = setTimeout(() => resolve([]), 1000);
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
				const label = activeResult.session.account.label;
				const match = label.match(/\(([^)]+)\)/);
				newUserIdentifier = (match ? match[1] : label).trim().toLowerCase();
			}

			if (newUserIdentifier !== this.activeUserEmail) {
				this.activeUserEmail = newUserIdentifier;

				// 1. Close all active editors on account switch/sandbox change to prevent data leaks
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

			console.log(`[WorkspaceMetadataCheck] Compare cleanActiveUser: "${cleanActiveUser}" with cleanOwner: "${cleanOwner}". Full raw activeUser: "${this.activeUserEmail}", owner: "${snapshot.ownerAccount}"`);
			if (cleanActiveUser !== cleanOwner) {
				return undefined;
			}
		}
		return {
			entityUri: snapshot.entityUri,
			entityName: snapshot.entityName,
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
		await this.entityPersistenceService.saveSnapshot({
			...snapshot,
			entityType: snapshot.entityType as any
		});
	}

	async repairEntityFromSnapshot(uri: URI): Promise<void> {
		await this.entityPersistenceService.repairEntityFromSnapshot(uri);
		this._onDidChangeWorkspaces.fire();
	}

	async removeSnapshot(uri: URI): Promise<void> {
		await this.entityPersistenceService.removeSnapshot(uri);
		this._onDidChangeWorkspaces.fire();
	}

	private getSavedWorkspaceUris(): string[] {
		const raw = this.storageService.get(this.savedWorkspacesKey, StorageScope.PROFILE, '[]');
		try {
			return (JSON.parse(raw) as string[]).map(u => this.normalizeUriString(u));
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
		const raw = this.storageService.get(this.removedWorkspacesKey, StorageScope.PROFILE, '[]');
		try {
			return (JSON.parse(raw) as string[]).map(u => this.normalizeUriString(u));
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
		if (!this.activeUserEmail) {
			return [];
		}

		const currentWorkspace = this.workspaceContextService.getWorkspace();
		const currentFolderUris = new Set(currentWorkspace.folders.map(f => this.normalizeUriString(f.uri)));

		const savedUris = this.getSavedWorkspaceUris();
		const removedUris = this.getRemovedWorkspaceUris();
		const resultItems: IWorkspaceItem[] = [];

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

			// Pre-check snapshot ownership to skip workspaces belonging to other accounts entirely
			const snapshotCheck = this.entityPersistenceService.getSnapshot(targetBase);
			if (snapshotCheck && snapshotCheck.ownerAccount && this.activeUserEmail) {
				const extractEmail = (str: string): string => {
					const clean = str.includes(':') ? str.split(':')[1] : str;
					const match = clean.match(/\(([^)]+)\)/);
					return (match ? match[1] : clean).trim().toLowerCase();
				};
				const cleanActiveUser = this.activeUserEmail;
				const cleanOwner = extractEmail(snapshotCheck.ownerAccount);
				if (cleanActiveUser !== cleanOwner) {
					return;
				}
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

				const workspaceMdUri = URI.joinPath(targetBase, '.agents', 'workspace.md');
				const ticketMdUri = URI.joinPath(targetBase, '.agents', 'ticket.md');
				const hasWorkspaceMd = await this.fileService.exists(ticketMdUri) ||
					await this.fileService.exists(workspaceMdUri) ||
					await this.fileService.exists(URI.joinPath(targetBase, 'ticket.md')) ||
					await this.fileService.exists(URI.joinPath(targetBase, 'workspace.md'));

				if (!hasWorkspaceMd) {
					// If this is not a genuine managed workspace (no workspace.md) and not explicitly saved as a workspace,
					// skip it so arbitrary explorer browsing folders (e.g. Downloads, Desktop) do not pollute Managed Workspaces!
					if (!item.isSaved && !snapshot) {
						return;
					}

					let detectedType: ResourceType | undefined = snapshot?.entityType;
					if (!detectedType) {
						detectedType = await this.detectCustomEntityTypeFromDisk(targetBase);
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
		const rootPath = options.targetParentUri ? options.targetParentUri.fsPath : '/Users/aimery/repos/jobs';

		const parentFolderUri = URI.file(rootPath);
		const sanitizedName = options.name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const targetBaseUri = URI.joinPath(parentFolderUri, sanitizedName);

		const wsCode = options.code ? options.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : this.generateWorkspaceCodeFromName(options.name);

		const alreadyExists = await this.fileService.exists(targetBaseUri);

		if (!alreadyExists) {
			await this.fileService.createFolder(targetBaseUri);
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
				} catch (err) {
					console.error('Failed to copy attachment:', err);
				}
			}
		}

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: targetBaseUri.toString(),
			entityName: options.name,
			title: options.title || options.name,
			workspaceId: options.workspaceId || (wsCode ? `${wsCode}-0000` : undefined),
			entityType: 'workspace',
			entityCode: wsCode,
			ownerAccount: this.activeUserEmail || 'unauthenticated',
			description: options.description || `Workspace ${options.name}`,
			status: options.status || 'Todo',
			priority: options.priority || 'Medium',
			assignedAgentId: options.assignedAgentId,
			assignedAgentName: options.assignedAgentName,
			linkTo: options.linkTo,
			attachments: attachmentNames,
			typePrompt: options.typePrompt,
			ticketPrompt: options.ticketPrompt
		}, targetBaseUri, false);

		await this.saveWorkspace(targetBaseUri);
		await this.addWorkspace(targetBaseUri, options.name);
		return { alreadyExists, uri: targetBaseUri };
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
			ownerAccount: this.activeUserEmail || 'unauthenticated',
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
				if (child.name.startsWith('.') || child.name.startsWith('~')) {
					continue;
				}

				if (child.isDirectory) {
					const childUri = child.resource;

					let childType: ResourceType = 'folder';
					const snapshot = this.entityPersistenceService.getSnapshot(childUri);
					if (snapshot) {
						childType = snapshot.entityType;
					} else {
						childType = await this.detectCustomEntityTypeFromDisk(childUri);
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

	public async detectCustomEntityTypeFromDisk(childUri: URI): Promise<ResourceType> {
		const configDir = URI.joinPath(childUri, '.agents');
		const ticketUri = URI.joinPath(configDir, 'ticket.md');
		try {
			if (await this.fileService.exists(ticketUri)) {
				const content = await this.fileService.readFile(ticketUri);
				const text = content.value.toString();
				const typeMatch = text.match(/-\s+\*\*Ticket\s+Type\*\*:\s*([a-zA-Z0-9_-]+)/i) || text.match(/-\s+\*\*Entity\s+Type\*\*:\s*([a-zA-Z0-9_-]+)/i);
				if (typeMatch && typeMatch[1]) {
					return typeMatch[1].trim().toLowerCase() as ResourceType;
				}
			}
		} catch {
			// ignore
		}

		try {
			if (await this.fileService.exists(configDir)) {
				const stat = await this.fileService.resolve(configDir);
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory && child.name.endsWith('.md')) {
							const nameLower = child.name.toLowerCase();
							if (nameLower !== 'instruction.md' && nameLower !== 'readme.md' && nameLower !== 'work_log.md' && nameLower !== 'worklog.md' && nameLower !== 'ticket.md') {
								return child.name.substring(0, child.name.length - 3) as ResourceType;
							}
						}
					}
				}
			}
		} catch {
			// ignore
		}

		// Fallback checking folder names
		const folderName = childUri.path.split('/').filter(Boolean).pop()?.toLowerCase() || '';
		if (folderName.includes('job')) return 'job';
		if (folderName.includes('project')) return 'project';
		if (folderName.includes('task')) return 'task';
		if (folderName.includes('agent')) return 'agent';
		if (folderName.includes('workflow')) return 'workflow';
		if (folderName.includes('workspace')) return 'workspace';

		return 'folder';
	}

	private async checkHasDamagedDescendant(dirUri: URI): Promise<boolean> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) return false;
			for (const child of stat.children) {
				if (child.isDirectory && !child.name.startsWith('.') && !child.name.startsWith('~')) {
					const childUri = child.resource;
					let childType: ResourceType = 'folder';
					const snapshot = this.entityPersistenceService.getSnapshot(childUri);
					if (snapshot) {
						childType = snapshot.entityType;
					} else {
						childType = await this.detectCustomEntityTypeFromDisk(childUri);
					}

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
			if (sanitized) return sanitized;
		}

		const pathLower = targetParentUri.path.toLowerCase();
		if (pathLower === '/users/aimery/repos/jobs' || pathLower.endsWith('/repos/jobs')) {
			return 'GLOBAL';
		}

		// Look up snapshot hierarchy or .agents/*.md on disk
		let curr: URI | undefined = targetParentUri;
		while (curr) {
			const snapshot = this.getMetadataSnapshot(curr);
			if (snapshot && snapshot.entityCode) {
				return snapshot.entityCode;
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
								if (nameLower !== 'instruction.md' && nameLower !== 'readme.md' && nameLower !== 'work_log.md' && nameLower !== 'worklog.md') {
									foundMdUri = child.resource;
									break;
								}
							}
						}
					}
				}
			} catch {}

			if (foundMdUri) {
				try {
					const content = (await this.fileService.readFile(foundMdUri)).value.toString();
					const match = content.match(/-\s*\*\*Entity Code\*\*:\s*`?([A-Za-z0-9_-]+)`?/) || content.match(/-\s*\*\*Ticket Code\*\*:\s*`?([A-Za-z0-9_-]+)`?/);
					if (match && match[1]) {
						const code = match[1].trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
						if (code) return code;
					}
				} catch {}
			}

			const parentPath = dirname(curr);
			if (!parentPath || parentPath.path === curr.path) break;
			curr = parentPath;
		}

		// Fallback code derived from parent folder name
		const folderName = targetParentUri.path.split('/').filter(Boolean).pop() || 'WS';
		return this.generateWorkspaceCodeFromName(folderName);
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

		let maxNum = 0;
		const regex = new RegExp(`^(?:${activeCode}|${fallbackPrefix}|${type})(?:[-_]?(?:${fallbackPrefix}|${type}))?[-_]?(\\d+)$`, 'i');

		// 1. Check existing snapshots globally to avoid duplicate IDs/names
		try {
			const snapshots = this.entityPersistenceService.getAllSnapshots();
			for (const snap of snapshots) {
				if (snap.entityCode?.toLowerCase() === activeCode.toLowerCase() || snap.entityName.toLowerCase().startsWith(activeCode.toLowerCase() + '-')) {
					const match = snap.entityName.match(regex);
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

		// 2. Check filesystem children under the immediate parent folder
		try {
			const stat = await this.fileService.resolve(targetParentUri);
			if (stat.children) {
				for (const child of stat.children) {
					const match = child.name.match(regex);
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
		const targetBaseUri = options.workspaceUri || options.targetParentUri || URI.file('/Users/aimery/repos/jobs');
		const type = options.type;
		const description = options.description;

		let name = options.name ? options.name.trim() : '';

		if (type === 'folder') {
			const folderName = name || 'new_folder';
			const folderUri = URI.joinPath(targetBaseUri, folderName);
			const alreadyExists = await this.fileService.exists(folderUri);
			if (!alreadyExists) {
				await this.fileService.createFolder(folderUri);
			}
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists, uri: folderUri };
		}

		if (type === 'file') {
			const fileName = name || 'new_file.md';
			const fileUri = URI.joinPath(targetBaseUri, fileName);
			const alreadyExists = await this.fileService.exists(fileUri);
			if (!alreadyExists) {
				const { VSBuffer } = await import('../../../../base/common/buffer.js');
				await this.fileService.createFile(fileUri, VSBuffer.fromString(description || `# ${fileName}\n`));
			}
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists, uri: fileUri };
		}

		const activeCode = await this.resolveEntityCode(targetBaseUri, options.code);

		if (!name || name === 'AUTO') {
			const seq = await this.generateNextSequentialName(targetBaseUri, type, options.code);
			name = seq.name;
		}

		// Preserve exact case and hyphens (-), avoiding extra lowercasing or type prefix prepending
		const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '-');
		const folderName = sanitizedName;
		const entityFolderUri = URI.joinPath(targetBaseUri, folderName);
		const mainMdFileName = 'ticket.md';
		const mainMdUri = URI.joinPath(entityFolderUri, '.agents', mainMdFileName);

		const alreadyExists = await this.fileService.exists(mainMdUri) || await this.fileService.exists(entityFolderUri);

		if (alreadyExists) {
			this._onDidChangeWorkspaces.fire();
			return { alreadyExists: true, uri: mainMdUri };
		}

		const parentSnapshot = this.entityPersistenceService.getSnapshot(targetBaseUri);
		let parentType = parentSnapshot ? parentSnapshot.entityType : 'workspace';
		if (!parentSnapshot) {
			const detected = await this.detectCustomEntityTypeFromDisk(targetBaseUri);
			if (detected && detected !== 'folder' && detected !== 'file') {
				parentType = detected;
			}
		}
		const parentName = parentSnapshot ? parentSnapshot.entityName : (targetBaseUri.path.split('/').filter(Boolean).pop() || 'Workspace');

		let finalModel = { providerId: 'gemini', modelId: 'gemini-1.5-flash', credentialId: undefined as string | undefined };
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

		await this.entityPersistenceService.writeEntity4MDFiles({
			entityUri: entityFolderUri.toString(),
			entityName: name,
			entityType: type as any,
			entityCode: activeCode,
			priority: options.priority || 'Medium',
			assignedAgentId: options.assignedAgentId,
			assignedAgentName: options.assignedAgentName,
			agentRulePrompt: options.agentRulePrompt,
			ownerAccount: this.activeUserEmail || 'unauthenticated',
			description: description || `${parentType} Agent`,
			belongsToWorkspaceUri: targetBaseUri.toString(),
			role: description || `${parentType} Agent`,
			modelName: finalModel.modelId,
			systemPrompt: finalSystemPrompt,
			scopeType: parentType as any,
			scopeId: targetBaseUri.toString(),
			scopeName: parentName,
			typeDefinition: options.typeDefinition,
			typePrompt: options.typePrompt,
			ticketPrompt: options.ticketPrompt || options.agentRulePrompt,
			customMetadata: options.customMetadata
		}, targetBaseUri, true);

		if (type === 'agent' && this.agentsManagerService) {
			await this.agentsManagerService.addAgent({
				name,
				role: description || `${parentType} Agent`,
				description: description || `${parentType} Agent`,
				systemPrompt: finalSystemPrompt,
				model: finalModel,
				avatarIcon: 'robot',
				scopeType: parentType as any,
				scopeId: targetBaseUri.toString(),
				scopeName: parentName,
				folderPath: entityFolderUri.fsPath,
				status: 'idle'
			}, targetBaseUri);
		}

		this._onDidChangeWorkspaces.fire();
		return { alreadyExists: false, uri: entityFolderUri };
	}
}
