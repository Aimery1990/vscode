/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspacesExplorerService, IWorkspaceItem, IWorkspaceChildItem, ICreateResourceOptions, ICreateWorkspaceResult, ResourceType } from '../common/workspacesExplorer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

import { IAgentsManagerService } from '../../agentsManager/common/agentsManager.js';

const SAVED_WORKSPACES_STORAGE_KEY = 'workspacesExplorer.savedWorkspaces';

export class WorkspacesExplorerService extends Disposable implements IWorkspacesExplorerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkspaces = this._register(new Emitter<void>());
	readonly onDidChangeWorkspaces: Event<void> = this._onDidChangeWorkspaces.event;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService
	) {
		super();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._onDidChangeWorkspaces.fire()));
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => this._onDidChangeWorkspaces.fire()));
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
		this.storageService.store(SAVED_WORKSPACES_STORAGE_KEY, JSON.stringify(uris), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeWorkspaces.fire();
	}

	async addWorkspace(uri: URI, _name?: string): Promise<void> {
		const current = this.getSavedWorkspaceUris();
		const strUri = uri.toString();
		if (!current.includes(strUri)) {
			current.push(strUri);
			this.saveWorkspaceUris(current);
		}
	}

	async removeWorkspace(uri: URI): Promise<void> {
		const current = this.getSavedWorkspaceUris();
		const strUri = uri.toString();
		const next = current.filter(u => u !== strUri && u !== uri.fsPath);
		this.saveWorkspaceUris(next);
		try {
			await this.workspacesService.removeRecentlyOpened([uri]);
		} catch {
			// Ignore recents error
		}
		this._onDidChangeWorkspaces.fire();
	}

	async reorderWorkspaces(sourceId: string, targetId: string): Promise<void> {
		const currentWorkspaces = await this.getWorkspaces();
		const canonicalSource = sourceId.toLowerCase();
		const canonicalTarget = targetId.toLowerCase();

		const sourceItem = currentWorkspaces.find(w => w.id.toLowerCase() === canonicalSource || w.uri.toString().toLowerCase() === canonicalSource || w.uri.fsPath.toLowerCase() === canonicalSource);
		const targetItem = currentWorkspaces.find(w => w.id.toLowerCase() === canonicalTarget || w.uri.toString().toLowerCase() === canonicalTarget || w.uri.fsPath.toLowerCase() === canonicalTarget);

		if (!sourceItem || !targetItem || sourceItem.id === targetItem.id) {
			return;
		}

		const sourceIdx = currentWorkspaces.indexOf(sourceItem);
		const targetIdx = currentWorkspaces.indexOf(targetItem);

		if (sourceIdx !== -1 && targetIdx !== -1) {
			currentWorkspaces.splice(sourceIdx, 1);
			currentWorkspaces.splice(targetIdx, 0, sourceItem);

			const newOrderUris = currentWorkspaces.map(w => w.uri.toString());
			this.saveWorkspaceUris(newOrderUris);
		}
	}

	async getWorkspaces(): Promise<IWorkspaceItem[]> {
		const map = new Map<string, IWorkspaceItem>();

		// 1. Current Active Workspace
		const currentWorkspace = this.workspaceContextService.getWorkspace();
		for (const folder of currentWorkspace.folders) {
			map.set(folder.uri.toString(), {
				id: folder.uri.toString(),
				name: folder.name,
				uri: folder.uri,
				isCurrent: true
			});
		}

		// 2. Saved Workspaces
		const saved = this.getSavedWorkspaceUris();
		for (const s of saved) {
			if (!map.has(s)) {
				const uri = URI.parse(s);
				map.set(s, {
					id: s,
					name: uri.path.split('/').filter(Boolean).pop() || 'Workspace',
					uri: uri,
					isCurrent: false
				});
			}
		}

		// 3. Recently Opened Workspaces
		try {
			const recentlyOpened = await this.workspacesService.getRecentlyOpened();
			for (const item of recentlyOpened.workspaces) {
				let uri: URI | undefined;
				let name = '';

				if (isRecentFolder(item)) {
					uri = item.folderUri;
					name = item.label || item.folderUri.path.split('/').filter(Boolean).pop() || 'Folder';
				} else if (isRecentWorkspace(item)) {
					uri = item.workspace.configPath;
					name = item.label || item.workspace.configPath.path.split('/').filter(Boolean).pop() || 'Workspace';
				}

				if (uri && !map.has(uri.toString())) {
					map.set(uri.toString(), {
						id: uri.toString(),
						name,
						uri,
						isCurrent: false
					});
				}
			}
		} catch {
			// Ignore recents error
		}

		// Check for missing workspace.md or inaccessible path for each workspace item
		const rawItems: IWorkspaceItem[] = Array.from(map.values());
		const savedOrder = this.getSavedWorkspaceUris();

		if (savedOrder.length > 0) {
			rawItems.sort((a, b) => {
				const idxA = savedOrder.indexOf(a.uri.toString());
				const idxB = savedOrder.indexOf(b.uri.toString());
				if (idxA !== -1 && idxB !== -1) return idxA - idxB;
				if (idxA !== -1) return -1;
				if (idxB !== -1) return 1;
				return 0;
			});
		}

		const resultItems: IWorkspaceItem[] = [];
		for (const item of rawItems) {
			let targetBase = item.uri;
			if (item.uri.path.endsWith('.code-workspace')) {
				targetBase = dirname(item.uri);
			}

			try {
				const folderExists = await this.fileService.exists(targetBase);
				if (!folderExists) {
					resultItems.push({
						...item,
						isMissing: true,
						missingReason: 'Workspace folder path does not exist'
					});
					continue;
				}

				const workspaceMdUri = URI.joinPath(targetBase, 'workspace.md');
				const hasWorkspaceMd = await this.fileService.exists(workspaceMdUri);

				if (!hasWorkspaceMd && !item.isCurrent) {
					let detectedType: ResourceType | undefined;
					const hasJobMd = await this.fileService.exists(URI.joinPath(targetBase, 'job.md'));
					const hasProjectMd = await this.fileService.exists(URI.joinPath(targetBase, 'project.md'));
					const hasTaskMd = await this.fileService.exists(URI.joinPath(targetBase, 'task.md'));
					const hasAgentMd = await this.fileService.exists(URI.joinPath(targetBase, 'agent.md'));
					const hasInstructionMd = await this.fileService.exists(URI.joinPath(targetBase, 'instruction.md'));

					if (hasJobMd || hasInstructionMd || item.name.toLowerCase().includes('job')) {
						detectedType = 'job';
					} else if (hasProjectMd || item.name.toLowerCase().includes('project')) {
						detectedType = 'project';
					} else if (hasTaskMd || item.name.toLowerCase().includes('task')) {
						detectedType = 'task';
					} else if (hasAgentMd || item.name.toLowerCase().includes('agent')) {
						detectedType = 'agent';
					}

					resultItems.push({
						...item,
						isMissing: true,
						detectedType,
						missingReason: detectedType ? `Entity folder (${detectedType}), not a Workspace` : 'workspace.md is missing'
					});
				} else {
					resultItems.push(item);
				}
			} catch {
				resultItems.push({
					...item,
					isMissing: true,
					missingReason: 'Inaccessible workspace path'
				});
			}
		}

		return resultItems;
	}

	async scanWorkspaceChildren(workspaceUri: URI): Promise<IWorkspaceChildItem[]> {
		const results: IWorkspaceChildItem[] = [];
		let targetBaseUri = workspaceUri;
		if (workspaceUri.path.endsWith('.code-workspace')) {
			targetBaseUri = dirname(workspaceUri);
		}

		try {
			const stat = await this.fileService.resolve(targetBaseUri, { resolveSingleChildDescendants: false });
			if (stat.children) {
				for (const child of stat.children) {
					if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'out' || child.name === 'dist') {
						continue;
					}

					let itemType: ResourceType = child.isDirectory ? 'folder' : 'file';

					if (child.isDirectory) {
						if (await this.fileService.exists(URI.joinPath(child.resource, 'workspace.md'))) {
							itemType = 'workspace';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'job.md'))) {
							itemType = 'job';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'project.md'))) {
							itemType = 'project';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'task.md'))) {
							itemType = 'task';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'case.md'))) {
							itemType = 'case';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'agent.md'))) {
							itemType = 'agent';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'issue.md'))) {
							itemType = 'issue';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'analysis.md'))) {
							itemType = 'analysis';
						} else if (await this.fileService.exists(URI.joinPath(child.resource, 'instruction.md')) || child.name.includes('_202')) {
							itemType = 'job';
						}
					} else {
						if (child.name.endsWith('.task.md') || child.name.endsWith('.task')) {
							itemType = 'task';
						} else if (child.name.endsWith('.case.md') || child.name.endsWith('.case')) {
							itemType = 'case';
						} else if (child.name.endsWith('.agent.md') || child.name.endsWith('.agent.json')) {
							itemType = 'agent';
						} else if (child.name.endsWith('.issue.md')) {
							itemType = 'issue';
						} else if (child.name.endsWith('.analysis.md')) {
							itemType = 'analysis';
						}
					}

					results.push({
						id: child.resource.toString(),
						name: child.name,
						uri: child.resource,
						type: itemType
					});
				}
			}
		} catch {
			// Ignore resolve error
		}

		const orderMap: Record<string, number> = {
			workspace: 1,
			job: 2,
			project: 3,
			task: 4,
			case: 5,
			agent: 6,
			issue: 7,
			analysis: 8,
			folder: 9,
			file: 10
		};
		results.sort((a, b) => {
			const diff = (orderMap[a.type] || 10) - (orderMap[b.type] || 10);
			if (diff !== 0) {
				return diff;
			}
			return a.name.localeCompare(b.name);
		});

		return results;
	}

	private getFormattedDateTime(): string {
		const now = new Date();
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, '0');
		const dd = String(now.getDate()).padStart(2, '0');
		const hh = String(now.getHours()).padStart(2, '0');
		const min = String(now.getMinutes()).padStart(2, '0');
		const ss = String(now.getSeconds()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
	}

	async createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description = ''): Promise<ICreateWorkspaceResult> {
		const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
		const targetFolderUri = URI.joinPath(parentLocationUri, cleanName);

		// Check if target folder already has workspace.md
		const existingWorkspaceMd = URI.joinPath(targetFolderUri, 'workspace.md');
		if (await this.fileService.exists(existingWorkspaceMd)) {
			await this.addWorkspace(targetFolderUri, name);
			return { alreadyExists: true, uri: targetFolderUri };
		}

		// Also check if parentLocationUri itself has workspace.md
		const parentWorkspaceMd = URI.joinPath(parentLocationUri, 'workspace.md');
		if (await this.fileService.exists(parentWorkspaceMd)) {
			await this.addWorkspace(parentLocationUri, name);
			return { alreadyExists: true, uri: parentLocationUri };
		}

		// Create workspace folder and 4-MD files
		await this.fileService.createFolder(targetFolderUri);
		await this.reinitializeWorkspaceMd(targetFolderUri);
		await this.addWorkspace(targetFolderUri, name);

		return { alreadyExists: false, uri: targetFolderUri };
	}

	async reinitializeWorkspaceMd(workspaceUri: URI): Promise<void> {
		let targetBaseUri = workspaceUri;
		if (workspaceUri.path.endsWith('.code-workspace')) {
			targetBaseUri = dirname(workspaceUri);
		}

		const dateTimeFormatted = this.getFormattedDateTime();
		const ownerAccount = 'aimery.wei@gmail.com';
		const wsName = targetBaseUri.path.split('/').filter(Boolean).pop() || 'workspace';

		const workspaceMdUri = URI.joinPath(targetBaseUri, 'workspace.md');
		const instructionUri = URI.joinPath(targetBaseUri, 'instruction.md');
		const readmeUri = URI.joinPath(targetBaseUri, 'README.md');
		const workLogUri = URI.joinPath(targetBaseUri, 'work_log.md');

		const workspaceMdContent = `# Workspace: ${wsName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n- **Entity Type**: workspace\n- **Root Path**: \`${targetBaseUri.fsPath}\`\n- **Status**: active\n\n## Workspace Index & Child Map\n\n- **Managed Jobs**: None\n- **Managed Projects**: None\n- **Managed Agents**: None\n- **Managed Tasks**: None\n`;
		await this.fileService.writeFile(workspaceMdUri, VSBuffer.fromString(workspaceMdContent));

		if (!await this.fileService.exists(instructionUri)) {
			const instructionContent = `# Instruction - ${wsName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## Workspace Guidelines\n\nDocument global instructions and guidelines for this workspace.\n`;
			await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));
		}

		if (!await this.fileService.exists(readmeUri)) {
			const readmeContent = `# Workspace ${wsName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## Document Navigation\n\n- [workspace.md](file://${workspaceMdUri.fsPath})\n- [instruction.md](file://${instructionUri.fsPath})\n- [work_log.md](file://${workLogUri.fsPath})\n`;
			await this.fileService.writeFile(readmeUri, VSBuffer.fromString(readmeContent));
		}

		if (!await this.fileService.exists(workLogUri)) {
			const workLogContent = `# Work Log - ${wsName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## ${dateTimeFormatted.slice(0, 10)}\n\n### Initialization\n\n- Initialized 4-MD standard files for workspace '${wsName}'\n`;
			await this.fileService.writeFile(workLogUri, VSBuffer.fromString(workLogContent));
		}

		this._onDidChangeWorkspaces.fire();
	}

	async createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<URI> {
		const { workspaceUri, type, name, description = '' } = options;
		const dateTimeFormatted = this.getFormattedDateTime();
		const ownerAccount = 'aimery.wei@gmail.com';

		// Resolve actual target directory if workspaceUri points to a .code-workspace file
		let targetBaseUri = workspaceUri;
		if (workspaceUri.path.endsWith('.code-workspace')) {
			targetBaseUri = dirname(workspaceUri);
		}

		if (type === 'file') {
			const fileUri = URI.joinPath(targetBaseUri, name);
			const defaultContent = `# ${name}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n`;
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(defaultContent));
			this._onDidChangeWorkspaces.fire();
			return fileUri;
		}

		if (type === 'workspace') {
			const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
			const targetFolderUri = URI.joinPath(targetBaseUri, cleanName);
			if (!await this.fileService.exists(targetFolderUri)) {
				await this.fileService.createFolder(targetFolderUri);
			}
			await this.reinitializeWorkspaceMd(targetFolderUri);
			this._onDidChangeWorkspaces.fire();
			return URI.joinPath(targetFolderUri, 'workspace.md');
		}

		// EVERY entity type (job, project, task, case, agent, issue, analysis, folder) is created as a DEDICATED FOLDER containing 4-MD files
		const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
		const entityFolderUri = URI.joinPath(targetBaseUri, cleanName);

		await this.fileService.createFolder(entityFolderUri);

		const mainMdFileName = `${type}.md`;
		const mainMdUri = URI.joinPath(entityFolderUri, mainMdFileName);
		const instructionUri = URI.joinPath(entityFolderUri, 'instruction.md');
		const readmeUri = URI.joinPath(entityFolderUri, 'README.md');
		const workLogUri = URI.joinPath(entityFolderUri, 'work_log.md');

		const mainMdContent = `# ${name} (${type.toUpperCase()})\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n- **Entity Type**: ${type}\n- **Belongs To Workspace**: \`${targetBaseUri.fsPath}\`\n- **Status**: active\n\n## Description\n\n${description || `${type} description`}\n\n## Index & Linked Entities\n\n- **Linked Items**: None\n`;
		await this.fileService.writeFile(mainMdUri, VSBuffer.fromString(mainMdContent));

		const instructionContent = `# Instruction - ${name}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## Guidelines & Rules\n\nDocument operational procedures, workflow rules, and guidelines for this ${type}.\n`;
		await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));

		const readmeContent = `# ${name}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n${description || `${type} Overview`}\n\n## Document Navigation\n\n- [${mainMdFileName}](file://${mainMdUri.fsPath})\n- [instruction.md](file://${instructionUri.fsPath})\n- [work_log.md](file://${workLogUri.fsPath})\n`;
		await this.fileService.writeFile(readmeUri, VSBuffer.fromString(readmeContent));

		const workLogContent = `# Work Log - ${name}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## ${dateTimeFormatted.slice(0, 10)}\n\n### User Request\n\nInitialize ${type} '${name}'\n\n### AI Execution\n\n- Created ${type} folder: \`${cleanName}\`\n- Initialized 4-MD standard files: \`${mainMdFileName}\`, \`instruction.md\`, \`README.md\`, \`work_log.md\`\n`;
		await this.fileService.writeFile(workLogUri, VSBuffer.fromString(workLogContent));

		if (type === 'agent' && this.agentsManagerService) {
			const wsName = targetBaseUri.path.split('/').filter(Boolean).pop() || 'Workspace';
			await this.agentsManagerService.addAgent({
				name: name,
				role: description || 'Specialized AI Agent',
				systemPrompt: `System Prompt and Core Instructions for ${name}. Scoped to ${wsName}.`,
				avatarIcon: 'robot',
				scopeType: 'workspace',
				scopeId: targetBaseUri.toString(),
				scopeName: wsName,
				status: 'idle',
				description: description || `AI Agent for ${wsName}`,
				folderPath: entityFolderUri.fsPath
			});
		}

		this._onDidChangeWorkspaces.fire();
		return mainMdUri;
	}
}
