/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IDiagramItem, IDiagramsManagerService, ICreateDiagramOptions } from '../common/diagramsManager.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath, dirname } from '../../../../base/common/resources.js';

const STORAGE_CUSTOM_DIAGRAM_DIRS = 'anyagent.diagrams.customDirectories';

export class DiagramsManagerService extends Disposable implements IDiagramsManagerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDiagrams = this._register(new Emitter<void>());
	readonly onDidChangeDiagrams: Event<void> = this._onDidChangeDiagrams.event;

	private readonly _onDidExpandPane = this._register(new Emitter<string>());
	readonly onDidExpandPane: Event<string> = this._onDidExpandPane.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._onDidChangeDiagrams.fire();
		}));

		this._register(this.fileService.onDidFilesChange(() => {
			this._onDidChangeDiagrams.fire();
		}));
	}

	notifyPaneExpanded(paneId: string): void {
		this._onDidExpandPane.fire(paneId);
	}

	private async getGlobalDiagramsDir(): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return joinPath(userHome, '.anyagent', 'diagrams');
	}

	private getTrackedCustomDirs(): URI[] {
		try {
			const raw = this.storageService.get(STORAGE_CUSTOM_DIAGRAM_DIRS, StorageScope.APPLICATION, '[]');
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.map((s: string) => URI.parse(s));
			}
		} catch { }
		return [];
	}

	private saveTrackedCustomDir(dir: URI): void {
		try {
			const existing = this.getTrackedCustomDirs();
			const dirStr = dir.toString();
			if (!existing.some(d => d.toString() === dirStr)) {
				existing.push(dir);
				this.storageService.store(
					STORAGE_CUSTOM_DIAGRAM_DIRS,
					JSON.stringify(existing.map(d => d.toString())),
					StorageScope.APPLICATION,
					StorageTarget.USER
				);
			}
		} catch { }
	}

	async getDiagrams(): Promise<IDiagramItem[]> {
		const items: IDiagramItem[] = [];
		const seenUris = new Set<string>();

		const addItem = (item: IDiagramItem) => {
			const key = item.uri.toString().toLowerCase();
			if (!seenUris.has(key)) {
				seenUris.add(key);
				items.push(item);
			}
		};

		const folders = this.workspaceContextService.getWorkspace().folders;

		// 1. Scan workspace folders (both visible diagrams/ and .anyagent/diagrams/ and root)
		for (const folder of folders) {
			const visibleDir = joinPath(folder.uri, 'diagrams');
			const visibleItems = await this.scanDirectoryForDiagrams(visibleDir, folder.uri, folder.name);
			visibleItems.forEach(addItem);

			const hiddenDir = joinPath(folder.uri, '.anyagent', 'diagrams');
			const hiddenItems = await this.scanDirectoryForDiagrams(hiddenDir, folder.uri, folder.name);
			hiddenItems.forEach(addItem);

			const rootItems = await this.scanDirectoryForDiagrams(folder.uri, folder.uri, folder.name);
			rootItems.forEach(addItem);
		}

		// 2. Scan custom user-selected directories
		const customDirs = this.getTrackedCustomDirs();
		for (const cDir of customDirs) {
			const cItems = await this.scanDirectoryForDiagrams(cDir, undefined, 'Custom');
			cItems.forEach(addItem);
		}

		// 3. Scan global fallback folder
		const globalDir = await this.getGlobalDiagramsDir();
		const globalItems = await this.scanDirectoryForDiagrams(globalDir, undefined, 'Global');
		globalItems.forEach(addItem);

		return items;
	}

	async getDiagramsByWorkspace(workspaceUri: URI): Promise<IDiagramItem[]> {
		const all = await this.getDiagrams();
		const wsStr = workspaceUri.toString().toLowerCase();
		return all.filter(d => d.belongsToWorkspaceUri && d.belongsToWorkspaceUri.toLowerCase() === wsStr);
	}

	private async scanDirectoryForDiagrams(dirUri: URI, workspaceUri?: URI, workspaceName?: string): Promise<IDiagramItem[]> {
		const result: IDiagramItem[] = [];
		try {
			const exists = await this.fileService.exists(dirUri);
			if (!exists) {
				return result;
			}
			const stat = await this.fileService.resolve(dirUri);
			if (stat.children) {
				for (const child of stat.children) {
					const name = child.name;
					if (name.endsWith('.diagram.json') || name.endsWith('.flowchart.json')) {
						let displayName = name.replace(/\.diagram\.json$/, '').replace(/\.flowchart\.json$/, '');
						let desc = '';
						let createdAt = '';
						try {
							const contentBuffer = await this.fileService.readFile(child.resource);
							const parsed = JSON.parse(contentBuffer.value.toString());
							if (parsed.metadata?.name) {
								displayName = parsed.metadata.name;
							}
							if (parsed.metadata?.description) {
								desc = parsed.metadata.description;
							}
							if (parsed.metadata?.createdAt) {
								createdAt = parsed.metadata.createdAt;
							}
						} catch {
							// fallback to default name
						}
						result.push({
							id: child.resource.toString(),
							name: displayName,
							uri: child.resource,
							description: desc,
							createdAt,
							belongsToWorkspaceUri: workspaceUri ? workspaceUri.toString() : undefined,
							belongsToWorkspaceName: workspaceName
						});
					}
				}
			}
		} catch {
			// ignore directory read errors
		}
		return result;
	}

	async createDiagram(options: ICreateDiagramOptions): Promise<URI> {
		let targetDir: URI;
		if (options.targetFolderUri) {
			targetDir = options.targetFolderUri;
			this.saveTrackedCustomDir(targetDir);
		} else if (options.targetWorkspaceUri) {
			targetDir = joinPath(options.targetWorkspaceUri, 'diagrams');
		} else {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length > 0) {
				targetDir = joinPath(folders[0].uri, 'diagrams');
			} else {
				targetDir = await this.getGlobalDiagramsDir();
			}
		}

		if (!await this.fileService.exists(targetDir)) {
			await this.fileService.createFolder(targetDir);
		}

		const cleanName = options.name.trim().replace(/[\\/:*?"<>|]/g, '_');
		const fileUri = joinPath(targetDir, `${cleanName}.diagram.json`);

		const initialData = {
			metadata: {
				name: options.name.trim(),
				description: options.description || '',
				createdAt: new Date().toISOString()
			},
			nodes: [
				{
					id: 'node_1',
					type: 'round-rect',
					label: options.name.trim(),
					x: 240,
					y: 160,
					width: 140,
					height: 48
				}
			],
			links: []
		};

		const buffer = VSBuffer.fromString(JSON.stringify(initialData, null, 2));
		await this.fileService.writeFile(fileUri, buffer);
		this._onDidChangeDiagrams.fire();
		return fileUri;
	}

	async deleteDiagram(uri: URI): Promise<void> {
		if (await this.fileService.exists(uri)) {
			await this.fileService.del(uri, { recursive: false, useTrash: true });
			this._onDidChangeDiagrams.fire();
		}
	}

	async renameDiagram(uri: URI, newName: string): Promise<URI> {
		const targetDir = dirname(uri);
		const cleanName = newName.trim().replace(/[\\/:*?"<>|]/g, '_');
		const targetUri = joinPath(targetDir, `${cleanName}.diagram.json`);

		if (targetUri.toString() === uri.toString()) {
			return uri;
		}

		await this.fileService.move(uri, targetUri);
		this._onDidChangeDiagrams.fire();
		return targetUri;
	}
}
