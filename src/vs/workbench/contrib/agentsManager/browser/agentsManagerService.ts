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
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) {
		super();
		this._loadAgents();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, STORAGE_KEY, this._store)(_e => {
			this._loadAgents();
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
			// No built-in virtual demo seed agents. Only user-created agents are stored.
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

		// 2. Write physical 4-MD files if parentUri is available
		if (parentUri) {
			try {
				const folderUri = await this._writeAgent4MDFiles(newAgent, parentUri);
				newAgent.folderPath = folderUri.fsPath;
			} catch (err) {
				console.error('Failed to create agent 4-MD folder', err);
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
					if (await this.fileService.exists(folderUri)) {
						await this._writeAgent4MDFiles(updated, folderUri, false);
					}
				} catch (err) {
					console.error('Failed to update agent 4-MD files', err);
				}
			}

			this._saveAgents();
			this._onDidChangeAgents.fire();
		}
	}

	async removeAgent(id: string): Promise<void> {
		const idx = this._agents.findIndex(a => a.id === id);
		if (idx !== -1) {
			this._agents.splice(idx, 1);
			this._saveAgents();
			this._onDidChangeAgents.fire();
		}
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

	private async _writeAgent4MDFiles(agent: IAgentItem, baseParentUri: URI, isNewFolder = true): Promise<URI> {
		const cleanName = agent.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
		const agentFolderUri = isNewFolder ? URI.joinPath(baseParentUri, `agent_${cleanName}`) : baseParentUri;

		if (isNewFolder) {
			await this.fileService.createFolder(agentFolderUri);
		}

		const dateFormatted = new Date().toISOString().slice(0, 10);
		const modelStr = agent.modelName || 'gemini-2.0-flash';

		// 1. agent.md (Index & Metadata)
		const agentMdUri = URI.joinPath(agentFolderUri, 'agent.md');
		const agentMdContent = `# Agent Metadata: ${agent.name}\n\n## Metadata\n\n- **Entity Type**: agent\n- **Agent ID**: \`${agent.id}\`\n- **Title**: ${agent.name}\n- **Role**: ${agent.role}\n- **Model**: \`${modelStr}\`\n- **Scope Type**: ${agent.scopeType}\n- **Scope Name**: ${agent.scopeName}\n- **Scope ID**: \`${agent.scopeId}\`\n- **Avatar Icon**: ${agent.avatarIcon}\n- **Status**: ${agent.status}\n- **Created At**: ${dateFormatted}\n\n## Scope & Target Service\n\nThis agent is configured to serve **${agent.scopeName}** at the \`${agent.scopeType}\` level.\n\n## Linked System Files\n\n- [instruction.md](file://${URI.joinPath(agentFolderUri, 'instruction.md').fsPath})\n- [README.md](file://${URI.joinPath(agentFolderUri, 'README.md').fsPath})\n- [work_log.md](file://${URI.joinPath(agentFolderUri, 'work_log.md').fsPath})\n`;
		await this.fileService.writeFile(agentMdUri, VSBuffer.fromString(agentMdContent));

		// 2. instruction.md (System Prompt & Guidelines)
		const instructionUri = URI.joinPath(agentFolderUri, 'instruction.md');
		const instructionContent = `# Instruction - ${agent.name}\n\n## AI Model\n\n- **Configured Model**: \`${modelStr}\`\n\n## System Prompt\n\n\`\`\`\n${agent.systemPrompt}\n\`\`\`\n\n## Operational Role & Guidelines\n\n- **Role**: ${agent.role}\n- **Work Scope**: ${agent.scopeName} (${agent.scopeType})\n- **Core Instructions**: Follow clean code principles, modular domain architecture, and clear progress reporting.\n`;
		await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));

		// 3. README.md (Overview & Navigation)
		const readmeUri = URI.joinPath(agentFolderUri, 'README.md');
		const readmeContent = `# AI Agent: ${agent.name}\n\n${agent.description || agent.role}\n\n## Configuration\n\n- **Model**: \`${modelStr}\`\n- **Scope**: ${agent.scopeName}\n\n## Quick Navigation\n\n- [agent.md](file://${agentMdUri.fsPath})\n- [instruction.md](file://${instructionUri.fsPath})\n- [work_log.md](file://${URI.joinPath(agentFolderUri, 'work_log.md').fsPath})\n`;
		await this.fileService.writeFile(readmeUri, VSBuffer.fromString(readmeContent));

		// 4. work_log.md (Execution History)
		const workLogUri = URI.joinPath(agentFolderUri, 'work_log.md');
		if (!await this.fileService.exists(workLogUri)) {
			const workLogContent = `# Work Log - ${agent.name}\n\n## ${dateFormatted}\n\n### Agent Creation\n\n- Initialized AI Agent '${agent.name}' with standard files\n- Assigned Model: \`${modelStr}\`\n- Assigned Scope: ${agent.scopeName} (${agent.scopeType})\n`;
			await this.fileService.writeFile(workLogUri, VSBuffer.fromString(workLogContent));
		}

		return agentFolderUri;
	}
}
