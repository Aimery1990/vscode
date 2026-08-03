/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export const WORKSPACES_EXPLORER_VIEWLET_ID = 'workbench.view.workspacesExplorer';
export const WORKSPACE_PANE_VIEW_ID = 'workbench.workspacesExplorer.mainPane';

export interface IWorkspaceItem {
	id: string;
	name: string;
	uri: URI;
	isCurrent?: boolean;
	jobCount?: number;
	isMissing?: boolean;
	missingReason?: string;
	detectedType?: ResourceType;
}

export type ResourceType = 'workspace' | 'job' | 'project' | 'task' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file';

export interface IWorkspaceChildItem {
	id: string;
	name: string;
	uri: URI;
	type: ResourceType;
	children?: IWorkspaceChildItem[];
}

export interface ICreateResourceOptions {
	workspaceUri: URI;
	type: ResourceType;
	name: string;
	description?: string;
	parentEntityUri?: URI;
}

export interface ICreateWorkspaceResult {
	alreadyExists: boolean;
	uri: URI;
}

export interface IEntityGitSnapshot {
	remoteUrl?: string;
	branch?: string;
	lastCommitHash?: string;
	lastCommitMsg?: string;
	hasUncommittedChanges?: boolean;
	stashCount?: number;
}

export interface IEntityMetadataSnapshot {
	entityUri: string;
	entityName: string;
	entityType: ResourceType;
	ownerAccount: string;
	createdAt: string;
	description?: string;
	belongsToWorkspaceUri?: string;
	primaryLanguage?: string;
	lastKnownChildren?: string[];
	git?: IEntityGitSnapshot;
}

export const IWorkspacesExplorerService = createDecorator<IWorkspacesExplorerService>('workspacesExplorerService');

export interface IWorkspacesExplorerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorkspaces: Event<void>;

	getWorkspaces(): Promise<IWorkspaceItem[]>;
	addWorkspace(uri: URI, name?: string): Promise<void>;
	removeWorkspace(uri: URI): Promise<void>;
	scanWorkspaceChildren(workspaceUri: URI): Promise<IWorkspaceChildItem[]>;
	createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<URI>;
	createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description?: string): Promise<ICreateWorkspaceResult>;
	reinitializeWorkspaceMd(workspaceUri: URI): Promise<void>;
	reorderWorkspaces(sourceId: string, targetId: string): Promise<void>;
	getMetadataSnapshot(uri: URI | string): IEntityMetadataSnapshot | undefined;
	saveMetadataSnapshot(snapshot: IEntityMetadataSnapshot): Promise<void>;
	repairEntityFromSnapshot(uri: URI): Promise<void>;
}
