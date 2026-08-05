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

const SNAPSHOTS_STORAGE_KEY = 'anyagent.entityPersistence.snapshots';

export class EntityPersistenceService extends Disposable implements IEntityPersistenceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSnapshots = this._register(new Emitter<void>());
	readonly onDidChangeSnapshots: Event<void> = this._onDidChangeSnapshots.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService
	) {
		super();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, SNAPSHOTS_STORAGE_KEY, this._store)(() => {
			this._onDidChangeSnapshots.fire();
		}));
	}

	private normalizeUriString(uri: URI | string): string {
		const str = typeof uri === 'string' ? uri : uri.toString();
		return str.replace(/\/+$/, '');
	}

	private getSnapshotsMap(): Record<string, IBaseEntitySnapshot> {
		const raw = this.storageService.get(SNAPSHOTS_STORAGE_KEY, StorageScope.PROFILE, '{}');
		try {
			return JSON.parse(raw) as Record<string, IBaseEntitySnapshot>;
		} catch {
			return {};
		}
	}

	private saveSnapshotsMap(map: Record<string, IBaseEntitySnapshot>): void {
		this.storageService.store(
			SNAPSHOTS_STORAGE_KEY,
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
		return map[key] || map[key.toLowerCase()];
	}

	getAllSnapshots(): IBaseEntitySnapshot[] {
		const map = this.getSnapshotsMap();
		return Object.values(map);
	}

	async removeSnapshot(uri: URI | string): Promise<void> {
		const key = this.normalizeUriString(uri);
		const map = this.getSnapshotsMap();
		if (map[key]) {
			delete map[key];
			this.saveSnapshotsMap(map);
		}
	}

	private async detectEntityType(targetUri: URI): Promise<EntityType> {
		if (await this.fileService.exists(URI.joinPath(targetUri, 'job.md'))) return 'job';
		if (await this.fileService.exists(URI.joinPath(targetUri, 'project.md'))) return 'project';
		if (await this.fileService.exists(URI.joinPath(targetUri, 'task.md'))) return 'task';
		if (await this.fileService.exists(URI.joinPath(targetUri, 'agent.md'))) return 'agent';
		if (await this.fileService.exists(URI.joinPath(targetUri, 'workflow.md'))) return 'workflow';
		if (await this.fileService.exists(URI.joinPath(targetUri, 'workspace.md'))) return 'workspace';

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

		try {
			const folderExists = await this.fileService.exists(targetUri);
			if (!folderExists) {
				return {
					isMissing: true,
					missingReason: snapshot ? `Physical directory deleted on disk. Snapshot: ${snapshot.entityType.toUpperCase()}` : 'Physical directory does not exist',
					snapshot
				};
			}

			const type: EntityType = snapshot ? snapshot.entityType : await this.detectEntityType(targetUri);
			const mainMdFileName = type === 'workspace' ? 'workspace.md' : `${type}.md`;
			const mainMdUri = URI.joinPath(targetUri, mainMdFileName);
			const instructionUri = URI.joinPath(targetUri, 'instruction.md');

			const hasMainMd = await this.fileService.exists(mainMdUri);
			const hasInstruction = await this.fileService.exists(instructionUri);

			if (!hasMainMd || !hasInstruction) {
				return {
					isMissing: true,
					missingReason: `Standard 4-MD files missing or damaged (${mainMdFileName})`,
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
		const snapshot = this.getSnapshot(key);

		if (!await this.fileService.exists(targetFolderUri)) {
			await this.fileService.createFolder(targetFolderUri);
		}

		if (snapshot) {
			await this.writeEntity4MDFiles(snapshot, targetFolderUri, false);
		} else {
			const folderName = targetFolderUri.path.split('/').filter(Boolean).pop() || 'Entity';
			const detectedType = await this.detectEntityType(targetFolderUri);
			const defaultSnapshot: IBaseEntitySnapshot = {
				entityUri: key,
				entityName: folderName,
				entityType: detectedType,
				ownerAccount: 'aimery.wei@gmail.com',
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

		const dateTimeFormatted = snapshot.createdAt || this.getFormattedDateTime();
		const ownerAccount = snapshot.ownerAccount || 'aimery.wei@gmail.com';
		const modelStr = snapshot.modelName || 'gemini-2.0-flash';
		const description = snapshot.description || `${type} description`;

		const mainMdFileName = type === 'workspace' ? 'workspace.md' : `${type}.md`;
		const mainMdUri = URI.joinPath(entityFolderUri, mainMdFileName);
		const instructionUri = URI.joinPath(entityFolderUri, 'instruction.md');
		const readmeUri = URI.joinPath(entityFolderUri, 'README.md');
		const workLogUri = URI.joinPath(entityFolderUri, 'work_log.md');

		// 1. Primary Entity MD
		let mainMdContent = `# ${snapshot.entityName} (${type.toUpperCase()})\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n- **Entity Type**: ${type}\n- **Status**: active\n`;

		if (type === 'agent') {
			mainMdContent += `- **Role**: ${snapshot.role || 'AI Agent'}\n- **Model**: \`${modelStr}\`\n- **Scope Type**: ${snapshot.scopeType || 'workspace'}\n- **Scope Name**: ${snapshot.scopeName || 'Workspace'}\n`;
		}

		mainMdContent += `\n## Description\n\n${description}\n\n## Linked System Files\n\n- [instruction.md](file://${instructionUri.fsPath})\n- [README.md](file://${readmeUri.fsPath})\n- [work_log.md](file://${workLogUri.fsPath})\n`;
		await this.fileService.writeFile(mainMdUri, VSBuffer.fromString(mainMdContent));

		// 2. instruction.md
		let instructionContent = `# Instruction - ${snapshot.entityName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n- **Entity Type**: ${type}\n`;

		if (type === 'agent') {
			instructionContent += `- **AI Model**: \`${modelStr}\`\n\n## System Prompt\n\n\`\`\`\n${snapshot.systemPrompt || 'You are a specialized AI Agent.'}\n\`\`\`\n\n## Operational Role & Guidelines\n\n- **Role**: ${snapshot.role || 'AI Agent'}\n- **Work Scope**: ${snapshot.scopeName || 'Workspace'} (${snapshot.scopeType || 'workspace'})\n- **Core Instructions**: Follow clean code principles, modular domain architecture, and clear progress reporting.\n`;
		} else {
			instructionContent += `\n## Guidelines & Rules\n\nDocument operational procedures, guidelines, and execution rules for this ${type}.\n`;
		}
		await this.fileService.writeFile(instructionUri, VSBuffer.fromString(instructionContent));

		// 3. README.md
		const readmeContent = `# ${snapshot.entityName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n${description}\n\n## Document Navigation\n\n- [${mainMdFileName}](file://${mainMdUri.fsPath})\n- [instruction.md](file://${instructionUri.fsPath})\n- [work_log.md](file://${workLogUri.fsPath})\n`;
		await this.fileService.writeFile(readmeUri, VSBuffer.fromString(readmeContent));

		// 4. work_log.md
		if (!await this.fileService.exists(workLogUri)) {
			const workLogContent = `# Work Log - ${snapshot.entityName}\n\n## Metadata\n\n- **Created By**: User\n- **Owner Account**: ${ownerAccount}\n- **Created At**: ${dateTimeFormatted}\n\n## ${dateTimeFormatted.slice(0, 10)}\n\n### Initialization & Restoration\n\n- Initialized standard 4-MD files for ${type} '${snapshot.entityName}'\n`;
			await this.fileService.writeFile(workLogUri, VSBuffer.fromString(workLogContent));
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
		const seconds = String(now.getSeconds()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}
}
