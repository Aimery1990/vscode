/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IEntityPersistenceService, IBaseEntitySnapshot } from '../common/entityPersistence.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { dirname } from '../../../../base/common/resources.js';

const SNAPSHOTS_STORAGE_KEY = 'anyagent.entityPersistence.snapshots';
export const SYSTEM_CONFIG_DIR_NAME = '.agents';

export class EntityPersistenceService extends Disposable implements IEntityPersistenceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSnapshots = this._register(new Emitter<void>());
	readonly onDidChangeSnapshots: Event<void> = this._onDidChangeSnapshots.event;

	private activeUserEmail: string = '';
	private readonly _memorySnapshots = new Map<string, IBaseEntitySnapshot>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService
	) {
		super();

		// Clean up any legacy snapshot keys from storageService to ensure no phantom cache remains in SQLite
		try {
			this.storageService.remove(this.snapshotsStorageKey, StorageScope.PROFILE);
			this.storageService.remove(`${SNAPSHOTS_STORAGE_KEY}:unauthenticated`, StorageScope.PROFILE);
		} catch {
			// ignore cleanup error
		}

		this._register(this.authenticationService.onDidChangeSessions(async (e: any) => {
			await this.updateActiveUser();
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async (e: any) => {
			await this.updateActiveUser();
		}));

		this.updateActiveUser();
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
				this._onDidChangeSnapshots.fire();
			}
		} catch (err) {
			console.error('Failed to update active user in EntityPersistenceService:', err);
		}
	}

	private get snapshotsStorageKey(): string {
		return `${SNAPSHOTS_STORAGE_KEY}:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private normalizeUriString(uri: URI | string): string {
		const str = typeof uri === 'string' ? uri : uri.toString();
		return str.replace(/\/+$/, '');
	}

	async saveSnapshot(snapshot: IBaseEntitySnapshot): Promise<void> {
		const key = this.normalizeUriString(snapshot.entityUri);
		this._memorySnapshots.set(key, {
			...snapshot,
			entityUri: key
		});
		this._onDidChangeSnapshots.fire();
	}

	getSnapshot(uri: URI | string): IBaseEntitySnapshot | undefined {
		const key = this.normalizeUriString(uri);
		return this._memorySnapshots.get(key) || this._memorySnapshots.get(key.toLowerCase());
	}

	getAllSnapshots(): IBaseEntitySnapshot[] {
		return Array.from(this._memorySnapshots.values());
	}

	async removeSnapshot(uri: URI | string): Promise<void> {
		const key = this.normalizeUriString(uri);
		this._memorySnapshots.delete(key);
		this._memorySnapshots.delete(key.toLowerCase());
		this._onDidChangeSnapshots.fire();
	}

	private async getSystemConfigDirUri(targetUri: URI): Promise<URI> {
		const agentsUri = URI.joinPath(targetUri, SYSTEM_CONFIG_DIR_NAME);
		const anyagentUri = URI.joinPath(targetUri, '.anyagent');
		const dunderUri = URI.joinPath(targetUri, '__agent__');

		if (await this.fileService.exists(anyagentUri)) return anyagentUri;
		if (await this.fileService.exists(dunderUri)) return dunderUri;

		return agentsUri;
	}

	private async migrateLegacyEntityFilesIfNeeded(targetUri: URI): Promise<URI> {
		const configDir = await this.getSystemConfigDirUri(targetUri);
		if (!await this.fileService.exists(configDir)) {
			try {
				await this.fileService.createFolder(configDir);
			} catch {
				// ignore
			}
		}

		const legacyFiles = [
			'workspace.md', 'job.md', 'project.md', 'task.md', 'agent.md', 'workflow.md',
			'case.md', 'issue.md', 'analysis.md', 'instruction.md', 'README.md', 'work_log.md'
		];

		for (const fileName of legacyFiles) {
			const oldUri = URI.joinPath(targetUri, fileName);
			const newUri = URI.joinPath(configDir, fileName);
			if (await this.fileService.exists(oldUri) && !await this.fileService.exists(newUri)) {
				try {
					await this.fileService.move(oldUri, newUri, true);
				} catch {
					// ignore
				}
			}
		}

		return configDir;
	}

	async writeEntity4MDFiles(snapshot: IBaseEntitySnapshot, targetFolderUri: URI, isNewFolder = false): Promise<URI> {
		const folderName = snapshot.entityName.replace(/[^a-zA-Z0-9_-]/g, '-');
		const type = snapshot.entityType;
		const entityFolderUri = isNewFolder ? URI.joinPath(targetFolderUri, folderName) : targetFolderUri;

		if (!await this.fileService.exists(entityFolderUri)) {
			await this.fileService.createFolder(entityFolderUri);
		}

		const configDir = await this.migrateLegacyEntityFilesIfNeeded(entityFolderUri);
		const dateTimeFormatted = snapshot.createdAt || this.getFormattedDateTime();
		const ownerAccount = (snapshot.ownerAccount && snapshot.ownerAccount !== 'unauthenticated')
			? snapshot.ownerAccount
			: (this.activeUserEmail || 'unauthenticated');
		snapshot.ownerAccount = ownerAccount;
		const description = snapshot.description || `${type} description`;

		const mainMdFileName = 'ticket.md';
		const mainMdUri = URI.joinPath(configDir, mainMdFileName);
		const instructionUri = URI.joinPath(configDir, 'instruction.md');
		const readmeUri = URI.joinPath(configDir, 'README.md');
		const workLogUri = URI.joinPath(configDir, 'worklog.md');

		const getRelativePath = (uri: URI, baseUri: URI): string => {
			const uriPath = uri.path;
			const basePath = baseUri.path;
			if (uriPath.startsWith(basePath)) {
				let rel = uriPath.substring(basePath.length);
				if (rel.startsWith('/')) rel = rel.substring(1);
				return rel;
			}
			return uriPath;
		};

		const baseUri = URI.parse(snapshot.belongsToWorkspaceUri || targetFolderUri.toString());
		const parentUri = isNewFolder ? targetFolderUri : dirname(entityFolderUri);
		const parentRelPath = getRelativePath(parentUri, baseUri) || '.';

		const instructionRel = getRelativePath(instructionUri, baseUri);
		const readmeRel = getRelativePath(readmeUri, baseUri);
		const ticketRel = getRelativePath(mainMdUri, baseUri);
		const worklogRel = getRelativePath(workLogUri, baseUri);

		const builtInTypeDefs: Record<string, string> = {
			workspace: 'A Workspace is the top-level root environment and repository container.',
			job: 'A Job is a high-level goal-oriented operational workflow or container.',
			project: 'A Project represents a structured software project or sub-system.',
			task: 'A Task represents a specific, actionable unit of engineering work.',
			workflow: 'A Workflow coordinates automated execution nodes and AI pipelines.',
			case: 'A Case encapsulates specific test scenarios, verification runs, or business cases.',
			agent: 'An AI Agent represents an autonomous role-based assistant entity.',
			issue: 'An Issue tracks defects, bugs, and incident remediation items.',
			analysis: 'An Analysis stores diagnostic findings, telemetry, and architectural studies.',
			note: 'A Note stores unstructured research, memos, and knowledge-base items.',
			folder: 'A standard directory container for grouping items.',
			file: 'A standalone document or data asset.'
		};

		// Auto-materialize custom module YAML into target workspace .agents/entity_type/ if it exists globally
		if (snapshot.typeDefinition && snapshot.typeDefinition !== 'Built-in (System)' && snapshot.typeDefinition !== 'None') {
			const directYamlUri = URI.joinPath(baseUri, snapshot.typeDefinition);
			if (!await this.fileService.exists(directYamlUri)) {
				try {
					const filename = snapshot.typeDefinition.split('/').filter(Boolean).pop() || `${type}.yaml`;
					let savedPath = '~/.anyagent/entity_type';
					try {
						if (this.storageService) {
							savedPath = this.storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
						}
					} catch {}
					const userHome = this.environmentService.userHome.fsPath;
					const resolvedGlobalDir = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : (savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_type'));
					const globalYamlUri = URI.file(`${resolvedGlobalDir}/${filename}`);
					if (await this.fileService.exists(globalYamlUri)) {
						const parentDir = dirname(directYamlUri);
						if (!await this.fileService.exists(parentDir)) {
							await this.fileService.createFolder(parentDir);
						}
						await this.fileService.copy(globalYamlUri, directYamlUri, true);
					}
				} catch (err) {
					console.error('Failed to materialize custom type YAML to workspace:', err);
				}
			}
		}

		let customDefFromYaml: string | undefined;
		try {
			const yamlLocalUri = URI.joinPath(baseUri, '.agents', 'entity_type', `${type}.yaml`);
			const yamlLocalUriPlural = URI.joinPath(baseUri, '.agents', 'entity_types', `${type}.yaml`);
			if (await this.fileService.exists(yamlLocalUri)) {
				const yamlContent = (await this.fileService.readFile(yamlLocalUri)).value.toString();
				const descMatch = yamlContent.match(/^description:\s*(.+)$/m);
				if (descMatch && descMatch[1]) {
					customDefFromYaml = descMatch[1].trim();
				}
			} else if (await this.fileService.exists(yamlLocalUriPlural)) {
				const yamlContent = (await this.fileService.readFile(yamlLocalUriPlural)).value.toString();
				const descMatch = yamlContent.match(/^description:\s*(.+)$/m);
				if (descMatch && descMatch[1]) {
					customDefFromYaml = descMatch[1].trim();
				}
			}
		} catch {}

		const typeDefStr = (snapshot as any).typeDefinition || customDefFromYaml || builtInTypeDefs[type.toLowerCase()] || `${type.toUpperCase()} module entity definition.`;

		let workspaceId = snapshot.workspaceId;
		if (!workspaceId) {
			if (type === 'workspace') {
				const wsCode = snapshot.entityCode || (snapshot.entityName.length >= 3 ? snapshot.entityName.slice(0, 5).toUpperCase() : 'PRJ1');
				workspaceId = `${wsCode}-0000`;
			} else {
				try {
					const rootTicketUri = URI.joinPath(baseUri, '.agents', 'ticket.md');
					if (await this.fileService.exists(rootTicketUri)) {
						const rootContent = (await this.fileService.readFile(rootTicketUri)).value.toString();
						const wsIdMatch = rootContent.match(/-\s+\*\*Workspace\s+ID\*\*:\s*([^\n\r]+)/i);
						if (wsIdMatch && wsIdMatch[1] && wsIdMatch[1].trim() !== 'None') {
							workspaceId = wsIdMatch[1].trim();
						} else {
							const ticketCodeMatch = rootContent.match(/-\s+\*\*Ticket\s+Code\*\*:\s*([^\n\r]+)/i);
							if (ticketCodeMatch && ticketCodeMatch[1] && ticketCodeMatch[1].trim() !== 'None') {
								workspaceId = `${ticketCodeMatch[1].trim()}-0000`;
							}
						}
					}
				} catch {}
				if (!workspaceId && snapshot.entityCode) {
					workspaceId = `${snapshot.entityCode}-0000`;
				}
				if (!workspaceId) {
					workspaceId = 'None';
				}
			}
		}

		// Determine canonical ticket ID (For workspace root, ticket ID matches workspace ID)
		let ticketId = snapshot.entityName;
		if (type === 'workspace') {
			ticketId = (workspaceId && workspaceId !== 'None') ? workspaceId : snapshot.entityName;
		} else if (snapshot.ticketId) {
			ticketId = snapshot.ticketId;
		}

		// 1. Primary Entity MD (ticket.md)
		let mainMdContent = `# ${snapshot.entityName}\n\n## Overview\n\n`;
		mainMdContent += `- **Workspace ID**: ${workspaceId}\n`;
		mainMdContent += `- **Ticket ID**: ${ticketId}\n`;
		mainMdContent += `- **Ticket Type**: ${type}\n`;
		mainMdContent += `- **Type Definition**: ${typeDefStr}\n\n`;

		mainMdContent += `### Profile Data\n`;
		mainMdContent += `- **Created By**: User\n`;
		mainMdContent += `- **Owner Account**: ${ownerAccount}\n`;
		mainMdContent += `- **Created At**: ${dateTimeFormatted}\n`;
		mainMdContent += `- **Ticket Code**: ${snapshot.entityCode || 'None'}\n`;
		if (type === 'workspace' || (snapshot.customMetadata && (snapshot.customMetadata['Ticket Statuses'] || snapshot.customMetadata['Removed Status']))) {
			const statusesVal = (snapshot.customMetadata && snapshot.customMetadata['Ticket Statuses']) || 'Todo, In Progress, Done, Blocked, Removed';
			const removedVal = (snapshot.customMetadata && snapshot.customMetadata['Removed Status']) || 'Removed';
			mainMdContent += `- **Ticket Statuses**: ${statusesVal}\n`;
			mainMdContent += `- **Removed Status**: ${removedVal}\n`;
		}
		mainMdContent += `- **Last Updated At**: ${dateTimeFormatted}\n`;
		mainMdContent += `- **Last Updated By**: User\n\n`;

		mainMdContent += `### Self Defined Data (If any)\n`;
		const schemaRelPath = (snapshot.typeDefinition && snapshot.typeDefinition !== 'Built-in (System)' && snapshot.typeDefinition !== 'None')
			? snapshot.typeDefinition
			: ((snapshot.customMetadata && Object.keys(snapshot.customMetadata).length > 0) ? `.agents/entity_type/${type}.yaml` : 'None');
		if (schemaRelPath !== 'None' && snapshot.customMetadata && Object.keys(snapshot.customMetadata).length > 0) {
			mainMdContent += `- **Self Defined Data Structure**: ${schemaRelPath}\n`;
			mainMdContent += `- **Self Defined Data Value**:\n`;
			for (const [k, v] of Object.entries(snapshot.customMetadata)) {
				mainMdContent += `  - **${k}**: ${v}\n`;
			}
		} else {
			mainMdContent += `- **Self Defined Data Structure**: None\n`;
			mainMdContent += `- **Self Defined Data Value**: None\n`;
		}
		mainMdContent += `\n`;

		const statusStr = snapshot.status || 'Todo';
		const linkToStr = snapshot.linkTo || 'None';
		const linkedByStr = snapshot.linkedBy || 'None';

		mainMdContent += `- **Current AI Agent**: ${snapshot.assignedAgentName || 'None'}\n`;
		mainMdContent += `- **Status**: ${statusStr}\n`;
		mainMdContent += `- **Priority**: ${snapshot.priority || 'Medium'}\n`;
		mainMdContent += `- **Parent Path**: ${parentRelPath}\n`;
		mainMdContent += `- **Ego MDs Paths**:\n`;
		mainMdContent += `  - [instruction.md](${instructionRel})\n`;
		mainMdContent += `  - [README.md](${readmeRel})\n`;
		mainMdContent += `  - [ticket.md](${ticketRel})\n`;
		mainMdContent += `  - [worklog.md](${worklogRel})\n\n`;

		mainMdContent += `### Link\n`;
		mainMdContent += `- **Link To**: ${linkToStr}\n`;
		mainMdContent += `- **Linked By**: ${linkedByStr}\n\n`;

		mainMdContent += `### Attachments Links\n`;
		if (snapshot.attachments && snapshot.attachments.length > 0) {
			for (const att of snapshot.attachments) {
				const attName = att.split('/').filter(Boolean).pop() || att;
				mainMdContent += `- [${attName}](attachments/${attName})\n`;
			}
		} else {
			mainMdContent += `- None\n`;
		}
		await this.fileService.writeFile(mainMdUri, VSBuffer.fromString(mainMdContent));

		let customPromptFromYaml: string | undefined;
		try {
			if (snapshot.typeDefinition && snapshot.typeDefinition !== 'Built-in (System)' && snapshot.typeDefinition !== 'None') {
				const directYamlUri = URI.joinPath(baseUri, snapshot.typeDefinition);
				if (await this.fileService.exists(directYamlUri)) {
					const yamlContent = (await this.fileService.readFile(directYamlUri)).value.toString();
					const promptMatch = yamlContent.match(/^prompt:\s*(.+)$/m);
					if (promptMatch && promptMatch[1]) {
						customPromptFromYaml = promptMatch[1].trim();
					}
				}
			}
			if (!customPromptFromYaml) {
				const yamlLocalUri = URI.joinPath(baseUri, '.agents', 'entity_type', `${type}.yaml`);
				const yamlLocalUriPlural = URI.joinPath(baseUri, '.agents', 'entity_types', `${type}.yaml`);
				if (await this.fileService.exists(yamlLocalUri)) {
					const yamlContent = (await this.fileService.readFile(yamlLocalUri)).value.toString();
					const promptMatch = yamlContent.match(/^prompt:\s*(.+)$/m);
					if (promptMatch && promptMatch[1]) {
						customPromptFromYaml = promptMatch[1].trim();
					}
				} else if (await this.fileService.exists(yamlLocalUriPlural)) {
					const yamlContent = (await this.fileService.readFile(yamlLocalUriPlural)).value.toString();
					const promptMatch = yamlContent.match(/^prompt:\s*(.+)$/m);
					if (promptMatch && promptMatch[1]) {
						customPromptFromYaml = promptMatch[1].trim();
					}
				}
			}
		} catch {}

		const builtInTypePrompts: Record<string, string> = {
			workspace: 'A workspace is the root environment container. Manage sub-entities, repository structure, and lifecycle.',
			job: 'A job represents a high-level goal-oriented operational workflow. Break down tasks and record progress.',
			project: 'A project coordinates architecture, modules, implementation code, and verification.',
			task: 'A task is an actionable unit of engineering work. Implement changes cleanly and verify.',
			workflow: 'A workflow executes automated nodes, transitions, and AI pipelines.',
			agent: 'An AI agent operates autonomously following role constraints and tools.',
			case: 'A case verifies business scenarios, validation runs, and test plans.',
			issue: 'An issue tracks defects, root causes, and remediation actions.',
			analysis: 'An analysis documents architectural telemetry, research, and diagnostic findings.',
			note: 'A note captures memos, references, and knowledge-base items.',
			folder: 'A standard directory container for grouping items.',
			file: 'A standalone document or data asset.'
		};

		const typePromptStr = (snapshot as any).typePrompt || customPromptFromYaml || builtInTypePrompts[type.toLowerCase()] || `${type.toUpperCase()} module processing guidelines.`;
		const ticketPromptStr = (snapshot as any).ticketPrompt || (snapshot as any).agentRulePrompt || 'None';

		// 2. instruction.md
		let instructionContent = `# Instruction - ${snapshot.entityName}\n\n## Overview\n\n`;
		instructionContent += `- **Workspace ID**: ${workspaceId}\n`;
		instructionContent += `- **Ticket ID**: ${ticketId}\n`;
		instructionContent += `- **Ticket Type**: ${type}\n`;
		instructionContent += `- **Ticket Type Prompt**: ${typePromptStr}\n`;
		instructionContent += `- **Ticket Prompt**: ${ticketPromptStr}\n`;
		instructionContent += `- **Parent Path**: ${parentRelPath}\n`;
		instructionContent += `- **Ego MDs Paths**:\n`;
		instructionContent += `  - [instruction.md](${instructionRel})\n`;
		instructionContent += `  - [README.md](${readmeRel})\n`;
		instructionContent += `  - [ticket.md](${ticketRel})\n`;
		instructionContent += `  - [worklog.md](${worklogRel})\n`;
		await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));

		// 3. README.md
		let readmeContent = `# ${snapshot.entityName}\n\n`;
		readmeContent += `- **Workspace ID**: ${workspaceId}\n`;
		readmeContent += `- **Ticket ID**: ${ticketId}\n`;
		readmeContent += `- **Ticket Type**: ${type}\n`;
		readmeContent += `- **Title**: ${snapshot.title || snapshot.entityName}\n`;
		readmeContent += `- **Description**: ${description || 'None'}\n`;
		readmeContent += `- **Parent Path**: ${parentRelPath}\n`;
		readmeContent += `- **Ego MDs Paths**:\n`;
		readmeContent += `  - [instruction.md](${instructionRel})\n`;
		readmeContent += `  - [README.md](${readmeRel})\n`;
		readmeContent += `  - [ticket.md](${ticketRel})\n`;
		readmeContent += `  - [worklog.md](${worklogRel})\n`;
		await this.fileService.writeFile(readmeUri, VSBuffer.fromString(readmeContent));

		// 4. worklog.md
		if (!await this.fileService.exists(workLogUri)) {
			const fullLogDateTime = this.getFormattedDateTimeWithSecondsAndTz();
			let workLogContent = `# Work Log - ${snapshot.entityName}\n\n## Overview\n\n`;
			workLogContent += `- **Workspace ID**: ${workspaceId}\n`;
			workLogContent += `- **Ticket ID**: ${ticketId}\n`;
			workLogContent += `- **Ticket Type**: ${type}\n`;
			workLogContent += `- **Parent Path**: ${parentRelPath}\n`;
			workLogContent += `- **Ego MDs Paths**:\n`;
			workLogContent += `  - [instruction.md](${instructionRel})\n`;
			workLogContent += `  - [README.md](${readmeRel})\n`;
			workLogContent += `  - [ticket.md](${ticketRel})\n`;
			workLogContent += `  - [worklog.md](${worklogRel})\n\n`;
			workLogContent += `---\n\n`;
			workLogContent += `## ${fullLogDateTime}\n\n`;
			workLogContent += `- **Update Datetime**: ${fullLogDateTime}\n`;
			workLogContent += `- **Update By**: User\n\n`;
			workLogContent += `### User Request\n`;
			workLogContent += `Initialize standard 4-MD files for ${type} '${snapshot.entityName}'.\n\n`;
			workLogContent += `### Update Summary\n`;
			workLogContent += `Created standard ticket configuration and documentation files in .agents directory.\n\n`;
			workLogContent += `### Update Details\n`;
			workLogContent += `- Initialized \`ticket.md\` with standard entity metadata.\n`;
			workLogContent += `- Initialized \`instruction.md\` with execution prompts.\n`;
			workLogContent += `- Initialized \`README.md\` with ticket overview.\n`;
			workLogContent += `- Initialized \`worklog.md\` work log record.\n\n`;
			workLogContent += `### Update Conclusion\n`;
			workLogContent += `Standard 4-MD files initialized successfully.\n\n`;
			workLogContent += `### Commit\n`;
			workLogContent += `- **Repo**: None\n`;
			workLogContent += `- **Branch**: None\n`;
			workLogContent += `- **ID**: None\n`;
			workLogContent += `- **comment**: None\n`;
			workLogContent += `- **committed by**: None\n`;
			await this.fileService.writeFile(workLogUri, VSBuffer.fromString(workLogContent));
		}

		// 5. If workflow, ensure workflow_flowchart.json exists and is intact
		if (type === 'workflow') {
			const flowchartUri = URI.joinPath(configDir, 'workflow_flowchart.json');
			if (!await this.fileService.exists(flowchartUri)) {
				let flowchartContent: string;
				if (snapshot.customMetadata && snapshot.customMetadata['flowchartJson']) {
					flowchartContent = snapshot.customMetadata['flowchartJson'];
				} else {
					const initialFlowchart = {
						nodes: [
							{
								id: 'start',
								type: 'circle',
								x: 80,
								y: 150,
								width: 64,
								height: 64,
								label: 'Start'
							},
							{
								id: 'step1',
								type: 'round-rect',
								x: 240,
								y: 142,
								width: 180,
								height: 80,
								label: '1. Process Pipeline'
							}
						],
						links: [
							{
								id: 'link1',
								from: 'start',
								to: 'step1',
								style: 'arrow-single',
								label: 'Proceed'
							}
						],
						routingMode: 'orthogonal'
					};
					flowchartContent = JSON.stringify(initialFlowchart, null, 2);
				}
				await this.fileService.writeFile(flowchartUri, VSBuffer.fromString(flowchartContent));
			}
		}

		// Also persist snapshot into SQLite engine
		await this.saveSnapshot({
			...snapshot,
			ticketId: ticketId,
			workspaceId: workspaceId !== 'None' ? workspaceId : undefined,
			entityUri: entityFolderUri.toString()
		});

		return entityFolderUri;
	}

	private getFormattedDateTime(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}

	private getFormattedDateTimeWithSecondsAndTz(): string {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const year = now.getFullYear();
		const month = pad(now.getMonth() + 1);
		const day = pad(now.getDate());
		const hours = pad(now.getHours());
		const minutes = pad(now.getMinutes());
		const seconds = pad(now.getSeconds());
		const tzOffset = -now.getTimezoneOffset();
		const tzSign = tzOffset >= 0 ? '+' : '-';
		const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
		const tzMins = pad(Math.abs(tzOffset) % 60);
		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${tzSign}${tzHours}:${tzMins}`;
	}
}
