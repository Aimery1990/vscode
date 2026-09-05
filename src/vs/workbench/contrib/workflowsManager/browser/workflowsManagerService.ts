/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkflowItem, IWorkflowsManagerService } from '../common/workflowsManager.js';
import { IEntityPersistenceService } from '../../entityPersistence/common/entityPersistence.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';

export class WorkflowsManagerService extends Disposable implements IWorkflowsManagerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows: Event<void> = this._onDidChangeWorkflows.event;

	private readonly _onDidExpandPane = this._register(new Emitter<string>());
	readonly onDidExpandPane: Event<string> = this._onDidExpandPane.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService
	) {
		super();

		this._register(this.entityPersistenceService.onDidChangeSnapshots(() => {
			this._onDidChangeWorkflows.fire();
		}));

		this._register(this.workspacesExplorerService.onDidChangeWorkspaces(() => {
			this._onDidChangeWorkflows.fire();
		}));
	}

	notifyPaneExpanded(paneId: string): void {
		this._onDidExpandPane.fire(paneId);
	}

	async getWorkflows(): Promise<IWorkflowItem[]> {
		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		const workflows: IWorkflowItem[] = [];
		const seenUris = new Set<string>();

		const addWorkflow = (uri: URI, name: string, wsUri?: string, wsName?: string) => {
			const norm = uri.toString().toLowerCase();
			if (!seenUris.has(norm)) {
				seenUris.add(norm);
				workflows.push({
					id: uri.toString(),
					name,
					createdAt: '',
					belongsToWorkspaceUri: wsUri || '',
					belongsToWorkspaceName: wsName || '',
					isMissing: false
				});
			}
		};

		// 1. Recursive scan across all workspaces to discover nested workflows
		const scanRecursively = async (folderUri: URI, wsUri: URI, wsName: string, depth = 0) => {
			if (depth > 4) {
				return;
			}
			try {
				const children = await this.workspacesExplorerService.scanWorkspaceChildren(folderUri);
				for (const child of children) {
					if (child.type === 'workflow') {
						addWorkflow(child.uri, child.name, wsUri.toString(), wsName);
					} else if (child.type === 'folder' || child.type === 'job' || child.type === 'project' || child.type === 'task') {
						await scanRecursively(child.uri, wsUri, wsName, depth + 1);
					}
				}
			} catch {
				// ignore
			}
		};

		for (const ws of workspaces) {
			await scanRecursively(ws.uri, ws.uri, ws.name, 0);
		}

		// 2. Discover workflows in entityPersistenceService snapshots
		const snapshots = this.entityPersistenceService.getAllSnapshots();
		for (const snap of snapshots) {
			if (snap.entityType === 'workflow') {
				try {
					const uri = URI.parse(snap.entityUri);
					addWorkflow(uri, snap.entityName);
				} catch {
					// ignore
				}
			}
		}

		// 3. Discover workflows in ~/Documents/workflows and ~/Documents/Find_Jobs_WSP if present
		const extraPaths = [
			'/Users/aimery/Documents/workflows',
			'/Users/aimery/Documents/Find_Jobs_WSP'
		];
		for (const p of extraPaths) {
			try {
				const dirUri = URI.file(p);
				if (await this.fileService.exists(dirUri)) {
					await scanRecursively(dirUri, dirUri, p.split('/').pop() || 'Workflows', 0);
				}
			} catch {
				// ignore
			}
		}

		return workflows;
	}

	async getWorkflowsByWorkspace(workspaceUri: URI): Promise<IWorkflowItem[]> {
		const all = await this.getWorkflows();
		const workspaceUriStr = workspaceUri.toString().toLowerCase();
		return all.filter(w => w.belongsToWorkspaceUri && w.belongsToWorkspaceUri.toLowerCase() === workspaceUriStr);
	}

	async deleteWorkflow(id: string): Promise<void> {
		const uri = URI.parse(id);
		await this.entityPersistenceService.removeSnapshot(uri);
		try {
			if (await this.fileService.exists(uri)) {
				await this.fileService.del(uri, { recursive: true, useTrash: true });
			}
		} catch {
			// ignore cleanup error
		}
		this._onDidChangeWorkflows.fire();
	}
}
