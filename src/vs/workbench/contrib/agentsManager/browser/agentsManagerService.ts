/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAgentItem, IAgentsManagerService, AgentScopeType } from '../common/agentsManager.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';

const STORAGE_KEY = 'workbench.agentsManager.agents';

export class AgentsManagerService extends Disposable implements IAgentsManagerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

	private readonly _onDidExpandPane = this._register(new Emitter<string>());
	readonly onDidExpandPane: Event<string> = this._onDidExpandPane.event;

	private _agents: IAgentItem[] = [];
	private _initialized = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService
	) {
		super();
		this._loadAgents();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, STORAGE_KEY, this._store)(_e => {
			this._loadAgents();
			this._onDidChangeAgents.fire();
		}));

		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => {
			this._onDidChangeAgents.fire();
		}));
	}

	notifyPaneExpanded(paneId: string): void {
		this._onDidExpandPane.fire(paneId);
	}

	private _loadAgents(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as IAgentItem[];
				// Keep only real agents created by user that have a physical folderPath on disk
				this._agents = parsed.filter(a => !!a.folderPath);
				this._saveAgents();
				this._initialized = true;
				return;
			} catch (e) {
				console.error('Failed to parse stored agents', e);
			}
		}

		if (!this._initialized) {
			this._agents = [];
			this._saveAgents();
			this._initialized = true;
		}
	}

	private _saveAgents(): void {
		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify(this._agents),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}

	async getAgents(): Promise<IAgentItem[]> {
		return [...this._agents];
	}

	async getAgentsByScope(scopeType: AgentScopeType, scopeId?: string): Promise<IAgentItem[]> {
		return this._agents.filter(a => a.scopeType === scopeType && (!scopeId || a.scopeId === scopeId));
	}

	async getAgent(id: string): Promise<IAgentItem | undefined> {
		return this._agents.find(a => a.id === id);
	}

	async addAgent(agentData: Omit<IAgentItem, 'id' | 'createdAt' | 'updatedAt'>, targetParentUri?: URI): Promise<IAgentItem> {
		const newAgent: IAgentItem = {
			...agentData,
			modelName: agentData.modelName || 'gemini-2.0-flash',
			id: generateUuid(),
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		// 1. Determine parent URI for physical 4-MD folder creation
		let parentUri = targetParentUri;
		if (!parentUri) {
			const activeFolder = this.workspaceContextService.getWorkspace().folders[0];
			if (activeFolder) {
				parentUri = activeFolder.uri;
			}
		}

		// 2. Write physical 4-MD files using unified EntityPersistenceService
		if (parentUri) {
			try {
				const folderUri = await this.entityPersistenceService.writeEntity4MDFiles({
					entityUri: parentUri.toString(),
					entityName: newAgent.name,
					entityType: 'agent',
					ownerAccount: 'aimery.wei@gmail.com',
					description: newAgent.role,
					systemPrompt: newAgent.systemPrompt,
					role: newAgent.role,
					modelName: newAgent.modelName,
					avatarIcon: newAgent.avatarIcon,
					scopeType: newAgent.scopeType,
					scopeId: newAgent.scopeId,
					scopeName: newAgent.scopeName
				}, parentUri, true);
				newAgent.folderPath = folderUri.fsPath;
			} catch (err) {
				console.error('Failed to create agent 4-MD folder via persistence engine', err);
			}
		}

		this._agents.push(newAgent);
		this._saveAgents();
		this._onDidChangeAgents.fire();
		return newAgent;
	}

	async updateAgent(updated: IAgentItem): Promise<void> {
		const idx = this._agents.findIndex(a => a.id === updated.id);
		if (idx !== -1) {
			this._agents[idx] = {
				...updated,
				updatedAt: Date.now()
			};

			// Sync changes to physical 4-MD files if folderPath exists
			if (updated.folderPath) {
				try {
					const folderUri = URI.file(updated.folderPath);
					await this.entityPersistenceService.writeEntity4MDFiles({
						entityUri: folderUri.toString(),
						entityName: updated.name,
						entityType: 'agent',
						ownerAccount: 'aimery.wei@gmail.com',
						description: updated.role,
						systemPrompt: updated.systemPrompt,
						role: updated.role,
						modelName: updated.modelName,
						avatarIcon: updated.avatarIcon,
						scopeType: updated.scopeType,
						scopeId: updated.scopeId,
						scopeName: updated.scopeName
					}, folderUri, false);
				} catch (err) {
					console.error('Failed to update agent 4-MD files via persistence engine', err);
				}
			}

			this._saveAgents();
			this._onDidChangeAgents.fire();
		}
	}

	async removeAgent(id: string): Promise<void> {
		const idx = this._agents.findIndex(a => a.id === id);
		if (idx !== -1) {
			const agent = this._agents[idx];
			if (agent.folderPath) {
				await this.entityPersistenceService.removeSnapshot(agent.folderPath);
			}
			this._agents.splice(idx, 1);
			this._saveAgents();
			this._onDidChangeAgents.fire();
		}
	}

	async repairAgent(id: string): Promise<void> {
		const agent = await this.getAgent(id);
		if (!agent) {
			return;
		}

		let folderUri: URI | undefined;
		if (agent.folderPath) {
			folderUri = URI.file(agent.folderPath);
		} else {
			const activeFolder = this.workspaceContextService.getWorkspace().folders[0];
			if (activeFolder) {
				const cleanName = agent.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
				folderUri = URI.joinPath(activeFolder.uri, `agent_${cleanName}`);
			}
		}

		if (folderUri) {
			try {
				await this.entityPersistenceService.repairEntityFromSnapshot(folderUri);
				agent.folderPath = folderUri.fsPath;
				agent.status = 'idle';
				await this.updateAgent(agent);
			} catch (err) {
				console.error('Failed to repair agent files via persistence engine', err);
			}
		}

		this._onDidChangeAgents.fire();
	}

	async assignTaskToAgent(agentId: string, taskTitle: string, taskDescription = ''): Promise<void> {
		const agent = await this.getAgent(agentId);
		if (!agent) {
			return;
		}

		agent.status = 'busy';
		agent.updatedAt = Date.now();
		await this.updateAgent(agent);

		// Append to work_log.md if folderPath exists
		if (agent.folderPath) {
			try {
				const workLogUri = URI.file(`${agent.folderPath}/work_log.md`);
				if (await this.fileService.exists(workLogUri)) {
					const dateFormatted = new Date().toISOString().slice(0, 19).replace('T', ' ');
					const logEntry = `\n## ${dateFormatted} - Task Assigned\n\n### Task Title\n\n${taskTitle}\n\n### Task Details\n\n${taskDescription || 'No details provided'}\n\n### Status\n\nTask dispatched to Agent '${agent.name}'. Processing...\n`;

					const existingContent = (await this.fileService.readFile(workLogUri)).value.toString();
					await this.fileService.writeFile(workLogUri, VSBuffer.fromString(existingContent + logEntry));
				}
			} catch (err) {
				console.error('Failed to log task assignment in agent work_log.md', err);
			}
		}

		this._onDidChangeAgents.fire();
	}
}
