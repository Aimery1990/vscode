/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEntityPersistenceService, IBaseEntitySnapshot, EntityType } from '../common/entityPersistence.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { dirname } from '../../../../base/common/resources.js';

const SNAPSHOTS_STORAGE_KEY = 'anyagent.entityPersistence.snapshots';
export const SYSTEM_CONFIG_DIR_NAME = '.agents';

export class EntityPersistenceService extends Disposable implements IEntityPersistenceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSnapshots = this._register(new Emitter<void>());
	readonly onDidChangeSnapshots: Event<void> = this._onDidChangeSnapshots.event;

	private activeUserEmail: string = '';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService
	) {
		super();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === this.snapshotsStorageKey) {
				this._onDidChangeSnapshots.fire();
			}
		}));

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

	private getSnapshotsMap(emailKey?: string): Record<string, IBaseEntitySnapshot> {
		const key = emailKey !== undefined ? `${SNAPSHOTS_STORAGE_KEY}:${emailKey || 'unauthenticated'}` : this.snapshotsStorageKey;
		const raw = this.storageService.get(key, StorageScope.PROFILE, '{}');
		try {
			return JSON.parse(raw) as Record<string, IBaseEntitySnapshot>;
		} catch {
			return {};
		}
	}

	private saveSnapshotsMap(map: Record<string, IBaseEntitySnapshot>): void {
		this.storageService.store(
			this.snapshotsStorageKey,
			JSON.stringify(map),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._onDidChangeSnapshots.fire();
	}

	async saveSnapshot(snapshot: IBaseEntitySnapshot): Promise<void> {
		const map = this.getSnapshotsMap();
		const key = this.normalizeUriString(snapshot.entityUri);
		map[key] = {
			...snapshot,
			entityUri: key
		};
		this.saveSnapshotsMap(map);
	}

	getSnapshot(uri: URI | string): IBaseEntitySnapshot | undefined {
		const key = this.normalizeUriString(uri);
		const map = this.getSnapshotsMap();
		let found = map[key] || map[key.toLowerCase()];
		if (!found && this.activeUserEmail) {
			const unauthMap = this.getSnapshotsMap('unauthenticated');
			found = unauthMap[key] || unauthMap[key.toLowerCase()];
		}
		return found;
	}

	getAllSnapshots(): IBaseEntitySnapshot[] {
		const map = this.getSnapshotsMap();
		if (this.activeUserEmail) {
			const unauthMap = this.getSnapshotsMap('unauthenticated');
			return Object.values({ ...unauthMap, ...map });
		}
		return Object.values(map);
	}

	async removeSnapshot(uri: URI | string): Promise<void> {
		const key = this.normalizeUriString(uri);
		const map = this.getSnapshotsMap();
		if (map[key]) {
			delete map[key];
			this.saveSnapshotsMap(map);
		}
		if (this.activeUserEmail) {
			const unauthMap = this.getSnapshotsMap('unauthenticated');
			if (unauthMap[key]) {
				delete unauthMap[key];
				this.storageService.store(
					`${SNAPSHOTS_STORAGE_KEY}:unauthenticated`,
					JSON.stringify(unauthMap),
					StorageScope.PROFILE,
					StorageTarget.USER
				);
				this._onDidChangeSnapshots.fire();
			}
		}
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

	private async detectEntityType(targetUri: URI): Promise<EntityType> {
		const configDir = await this.migrateLegacyEntityFilesIfNeeded(targetUri);
		const ticketUri = URI.joinPath(configDir, 'ticket.md');

		try {
			if (await this.fileService.exists(ticketUri)) {
				const content = await this.fileService.readFile(ticketUri);
				const text = content.value.toString();
				const typeMatch = text.match(/-\s+\*\*Ticket\s+Type\*\*:\s*([a-zA-Z0-9_-]+)/i) || text.match(/-\s+\*\*Entity\s+Type\*\*:\s*([a-zA-Z0-9_-]+)/i);
				if (typeMatch && typeMatch[1]) {
					return typeMatch[1].trim().toLowerCase() as EntityType;
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
								return child.name.substring(0, child.name.length - 3) as EntityType;
							}
						}
					}
				}
			}
		} catch {}

		if (await this.fileService.exists(URI.joinPath(configDir, 'job.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'job.md'))) return 'job';
		if (await this.fileService.exists(URI.joinPath(configDir, 'project.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'project.md'))) return 'project';
		if (await this.fileService.exists(URI.joinPath(configDir, 'task.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'task.md'))) return 'task';
		if (await this.fileService.exists(URI.joinPath(configDir, 'agent.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'agent.md'))) return 'agent';
		if (await this.fileService.exists(URI.joinPath(configDir, 'workflow.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'workflow.md'))) return 'workflow';
		if (await this.fileService.exists(URI.joinPath(configDir, 'workspace.md')) || await this.fileService.exists(URI.joinPath(targetUri, 'workspace.md'))) return 'workspace';

		const folderName = targetUri.path.split('/').filter(Boolean).pop()?.toLowerCase() || '';
		if (folderName.includes('job')) return 'job';
		if (folderName.includes('project')) return 'project';
		if (folderName.includes('task')) return 'task';
		if (folderName.includes('agent')) return 'agent';
		if (folderName.includes('workflow')) return 'workflow';
		if (folderName.includes('workspace')) return 'workspace';

		return 'workspace';
	}

	async inspectEntityHealth(uri: URI | string): Promise<{ isMissing: boolean; missingReason?: string; snapshot?: IBaseEntitySnapshot }> {
		const key = this.normalizeUriString(uri);
		const targetUri = URI.parse(key);
		const snapshot = this.getSnapshot(key);

		if (snapshot && snapshot.ownerAccount && this.activeUserEmail) {
			const extractEmail = (str: string): string => {
				const clean = str.includes(':') ? str.split(':')[1] : str;
				const match = clean.match(/\(([^)]+)\)/);
				return (match ? match[1] : clean).trim().toLowerCase();
			};

			const cleanActiveUser = this.activeUserEmail.trim().toLowerCase();
			const cleanOwner = extractEmail(snapshot.ownerAccount);

			// Only treat as unauthorized if owner is explicitly another real user email (not unauthenticated or local)
			if (cleanOwner && cleanOwner !== 'unauthenticated' && cleanOwner !== 'local' && cleanActiveUser && cleanActiveUser !== 'unauthenticated') {
				if (cleanActiveUser !== cleanOwner) {
					return {
						isMissing: true,
						missingReason: `Unauthorized Workspace: Belongs to ${snapshot.ownerAccount}`,
						snapshot
					};
				}
			} else if ((cleanOwner === 'unauthenticated' || !cleanOwner) && cleanActiveUser) {
				// Auto-claim local/unauthenticated entity to active user
				snapshot.ownerAccount = this.activeUserEmail;
				this.saveSnapshot(snapshot);
			}
		}

		try {
			const folderExists = await this.fileService.exists(targetUri);
			if (!folderExists) {
				return {
					isMissing: true,
					missingReason: snapshot ? `Physical directory deleted on disk. Snapshot: ${snapshot.entityType.toUpperCase()}` : 'Physical directory does not exist',
					snapshot
				};
			}

			const configDir = await this.migrateLegacyEntityFilesIfNeeded(targetUri);
			const type: EntityType = snapshot ? snapshot.entityType : await this.detectEntityType(targetUri);
			const mainMdUri = URI.joinPath(configDir, 'ticket.md');
			const instructionUri = URI.joinPath(configDir, 'instruction.md');

			const hasMainMd = await this.fileService.exists(mainMdUri) ||
				await this.fileService.exists(URI.joinPath(configDir, `${type}.md`)) ||
				await this.fileService.exists(URI.joinPath(configDir, 'workspace.md')) ||
				await this.fileService.exists(URI.joinPath(targetUri, 'ticket.md')) ||
				await this.fileService.exists(URI.joinPath(targetUri, `${type}.md`));
			const hasInstruction = await this.fileService.exists(instructionUri) || await this.fileService.exists(URI.joinPath(targetUri, 'instruction.md'));

			if (!hasMainMd || !hasInstruction) {
				return {
					isMissing: true,
					missingReason: `Standard 4-MD files missing or damaged inside ${SYSTEM_CONFIG_DIR_NAME} (ticket.md / instruction.md)`,
					snapshot
				};
			}

			return { isMissing: false, snapshot };
		} catch (err) {
			return {
				isMissing: true,
				missingReason: `Inaccessible entity path: ${err}`,
				snapshot
			};
		}
	}

	async repairEntityFromSnapshot(uri: URI | string): Promise<void> {
		const key = this.normalizeUriString(uri);
		const targetFolderUri = URI.parse(key);
		let snapshot = this.getSnapshot(key);

		if (!await this.fileService.exists(targetFolderUri)) {
			await this.fileService.createFolder(targetFolderUri);
		}

		if (snapshot) {
			if (this.activeUserEmail && (!snapshot.ownerAccount || snapshot.ownerAccount === 'unauthenticated')) {
				snapshot.ownerAccount = this.activeUserEmail;
			}
			await this.writeEntity4MDFiles(snapshot, targetFolderUri, false);
		} else {
			const folderName = targetFolderUri.path.split('/').filter(Boolean).pop() || 'Entity';
			const detectedType = await this.detectEntityType(targetFolderUri);
			const defaultSnapshot: IBaseEntitySnapshot = {
				entityUri: key,
				entityName: folderName,
				entityType: detectedType,
				ownerAccount: this.activeUserEmail || 'unauthenticated',
				createdAt: this.getFormattedDateTime(),
				description: `${detectedType} ${folderName}`
			};
			await this.writeEntity4MDFiles(defaultSnapshot, targetFolderUri, false);
			await this.saveSnapshot(defaultSnapshot);
		}

		this._onDidChangeSnapshots.fire();
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
		const modelStr = snapshot.modelName || 'gemini-2.0-flash';
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

		// 1. Primary Entity MD (ticket.md)
		let mainMdContent = `# ${snapshot.entityName}\n\n## Metadata\n\n`;
		mainMdContent += `- **Ticket ID**: ${snapshot.entityName}\n`;
		mainMdContent += `- **Ticket Type**: ${type}\n`;
		mainMdContent += `- **Type Definition**: ${typeDefStr}\n\n`;

		mainMdContent += `### Profile Data\n`;
		mainMdContent += `- **Created By**: User\n`;
		mainMdContent += `- **Owner Account**: ${ownerAccount}\n`;
		mainMdContent += `- **Created At**: ${dateTimeFormatted}\n`;
		mainMdContent += `- **Ticket Code**: ${snapshot.entityCode || 'None'}\n`;
		mainMdContent += `- **Last Updated At**: ${dateTimeFormatted}\n`;
		mainMdContent += `- **Last Updated By**: User\n\n`;

		mainMdContent += `### Self Defined Data (If any)\n`;
		const schemaRelPath = `.agents/entity_type/${type}.yaml`;
		if (snapshot.customMetadata && Object.keys(snapshot.customMetadata).length > 0) {
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

		mainMdContent += `- **Current AI Agent**: ${snapshot.assignedAgentName || 'None'}\n`;
		mainMdContent += `- **Status**: Todo\n`;
		mainMdContent += `- **Priority**: ${snapshot.priority || 'Medium'}\n`;
		mainMdContent += `- **Parent Path**: ${parentRelPath}\n`;
		mainMdContent += `- **Ego MDs Paths**:\n`;
		mainMdContent += `  - [instruction.md](${instructionRel})\n`;
		mainMdContent += `  - [README.md](${readmeRel})\n`;
		mainMdContent += `  - [ticket.md](${ticketRel})\n`;
		mainMdContent += `  - [worklog.md](${worklogRel})\n\n`;

		mainMdContent += `### Link\n`;
		mainMdContent += `- **Link To**: None\n`;
		mainMdContent += `- **Linked By**: None\n\n`;

		mainMdContent += `### Attachments Links\n`;
		mainMdContent += `- None\n`;
		await this.fileService.writeFile(mainMdUri, VSBuffer.fromString(mainMdContent));

		// 2. instruction.md
		let instructionContent = `# Instruction - ${snapshot.entityName}\n\n## Metadata\n\n- **Ticket ID**: ${snapshot.entityName}\n- **Ticket Type**: ${type}\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n`;
		instructionContent += `- **Parent Path**: ${parentRelPath}\n`;
		instructionContent += `- **Ego MDs Paths**:\n`;
		instructionContent += `  - [instruction.md](${instructionRel})\n`;
		instructionContent += `  - [README.md](${readmeRel})\n`;
		instructionContent += `  - [ticket.md](${ticketRel})\n`;
		instructionContent += `  - [worklog.md](${worklogRel})\n`;

		if (type === 'agent') {
			instructionContent += `- **AI Model**: \`${modelStr}\`\n\n## System Prompt\n\n\`\`\`\n${snapshot.systemPrompt || 'You are a specialized AI Agent.'}\n\`\`\`\n\n## Operational Role & Guidelines\n\n- **Role**: ${snapshot.role || 'AI Agent'}\n- **Work Scope**: ${snapshot.scopeName || 'Workspace'} (${snapshot.scopeType || 'workspace'})\n- **Core Instructions**: Follow clean code principles, modular domain architecture, and clear progress reporting.\n`;
		} else {
			instructionContent += `\n## Guidelines & Rules\n\nDocument operational procedures, guidelines, and execution rules for this ${type}.\n`;
		}
		await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));

		// 3. README.md
		let readmeContent = `# ${snapshot.entityName}\n\n`;
		readmeContent += `- **Ticket ID**: ${snapshot.entityName}\n`;
		readmeContent += `- **Ticket Type**: ${type}\n`;
		readmeContent += `- **Title**: ${snapshot.entityName}\n`;
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
			let workLogContent = `# Work Log - ${snapshot.entityName}\n\n## Metadata\n\n- **Ticket ID**: ${snapshot.entityName}\n- **Ticket Type**: ${type}\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n`;
			workLogContent += `- **Parent Path**: ${parentRelPath}\n`;
			workLogContent += `- **Ego MDs Paths**:\n`;
			workLogContent += `  - [instruction.md](${instructionRel})\n`;
			workLogContent += `  - [README.md](${readmeRel})\n`;
			workLogContent += `  - [ticket.md](${ticketRel})\n`;
			workLogContent += `  - [worklog.md](${worklogRel})\n`;
			workLogContent += `\n## ${dateTimeFormatted.slice(0, 10)}\n\n### Initialization & Restoration\n\n- Initialized standard 4-MD files in ${SYSTEM_CONFIG_DIR_NAME} for ${type} '${snapshot.entityName}'\n`;
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
}
