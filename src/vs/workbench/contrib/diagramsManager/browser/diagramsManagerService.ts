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
import { IDiagramItem, IDiagramsManagerService, ICreateDiagramOptions } from '../common/diagramsManager.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath, dirname } from '../../../../base/common/resources.js';

export class DiagramsManagerService extends Disposable implements IDiagramsManagerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDiagrams = this._register(new Emitter<void>());
	readonly onDidChangeDiagrams: Event<void> = this._onDidChangeDiagrams.event;

	private readonly _onDidExpandPane = this._register(new Emitter<string>());
	readonly onDidExpandPane: Event<string> = this._onDidExpandPane.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService
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

	async getDiagrams(): Promise<IDiagramItem[]> {
		const items: IDiagramItem[] = [];
		const folders = this.workspaceContextService.getWorkspace().folders;

		// 1. Scan workspace folders
		for (const folder of folders) {
			const wsDiagramsDir = joinPath(folder.uri, '.anyagent', 'diagrams');
			const wsItems = await this.scanDirectoryForDiagrams(wsDiagramsDir, folder.uri, folder.name);
			items.push(...wsItems);
		}

		// 2. Scan global fallback folder
		const globalDir = await this.getGlobalDiagramsDir();
		const globalItems = await this.scanDirectoryForDiagrams(globalDir, undefined, 'Global');
		for (const gi of globalItems) {
			if (!items.some(i => i.id === gi.id)) {
				items.push(gi);
			}
		}

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
		if (options.targetWorkspaceUri) {
			targetDir = joinPath(options.targetWorkspaceUri, '.anyagent', 'diagrams');
		} else {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length > 0) {
				targetDir = joinPath(folders[0].uri, '.anyagent', 'diagrams');
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
		const dir = dirname(uri);
		const cleanName = newName.trim().replace(/[\\/:*?"<>|]/g, '_');
		const targetUri = joinPath(dir, `${cleanName}.diagram.json`);

		// update metadata if possible
		try {
			const contentBuffer = await this.fileService.readFile(uri);
			const parsed = JSON.parse(contentBuffer.value.toString());
			if (!parsed.metadata) parsed.metadata = {};
			parsed.metadata.name = newName.trim();
			const updated = VSBuffer.fromString(JSON.stringify(parsed, null, 2));
			await this.fileService.writeFile(uri, updated);
		} catch {
			// ignore metadata update error
		}

		await this.fileService.move(uri, targetUri, true);
		this._onDidChangeDiagrams.fire();
		return targetUri;
	}
}
