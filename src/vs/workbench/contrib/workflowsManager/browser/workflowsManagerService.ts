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

		for (const ws of workspaces) {
			try {
				const children = await this.workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'workflow') {
						workflows.push({
							id: child.uri.toString(),
							name: child.name,
							createdAt: '',
							belongsToWorkspaceUri: ws.uri.toString(),
							belongsToWorkspaceName: ws.name,
							isMissing: false
						});
					}
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
