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
	code?: string;
	isCurrent?: boolean;
	isSaved?: boolean;
	jobCount?: number;
	isMissing?: boolean;
	missingReason?: string;
	hasDamagedDescendant?: boolean;
	detectedType?: ResourceType;
}

export type ResourceType = 'workspace' | 'job' | 'project' | 'task' | 'workflow' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file' | string;

export interface IWorkspaceChildItem {
	id: string;
	name: string;
	uri: URI;
	type: ResourceType;
	code?: string;
	isMissing?: boolean;
	missingReason?: string;
	hasDamagedDescendant?: boolean;
	children?: IWorkspaceChildItem[];
}

export interface ICreateResourceOptions {
	workspaceUri?: URI;
	targetParentUri?: URI;
	type: ResourceType;
	name: string;
	title?: string;
	workspaceId?: string;
	description?: string;
	code?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	parentEntityUri?: URI;
	agentModel?: {
		providerId: string;
		modelId: string;
		credentialId?: string;
	};
	agentSystemPrompt?: string;
	typeDefinition?: string;
	typePrompt?: string;
	ticketPrompt?: string;
	customMetadata?: { [key: string]: string };
}

export interface ICreateResourceResult {
	alreadyExists?: boolean;
	uri: URI;
}

export interface ICreateWorkspaceResult {
	alreadyExists?: boolean;
	name?: string;
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
	entityCode?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	primaryLanguage?: string;
	lastKnownChildren?: string[];
	git?: IEntityGitSnapshot;
}

export const IWorkspacesExplorerService = createDecorator<IWorkspacesExplorerService>('workspacesExplorerService');

export interface IWorkspacesExplorerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorkspaces: Event<void>;

	getActiveUserEmail(): string;
	getWorkspaces(): Promise<IWorkspaceItem[]>;
	addWorkspace(uri: URI, name?: string): Promise<void>;
	removeWorkspace(uri: URI): Promise<void>;
	scanWorkspaceChildren(workspaceUri: URI): Promise<IWorkspaceChildItem[]>;
	detectCustomEntityTypeFromDisk(childUri: URI): Promise<ResourceType>;
	createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<ICreateResourceResult>;
	createWorkspace(options: ICreateResourceOptions): Promise<ICreateWorkspaceResult>;
	createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description?: string): Promise<ICreateWorkspaceResult>;
	generateNextSequentialName(targetParentUri: URI, type: ResourceType, customCode?: string): Promise<{ name: string; code: string }>;
	reinitializeWorkspaceMd(workspaceUri: URI): Promise<void>;
	reorderWorkspaces(sourceId: string, targetId: string): Promise<void>;
	getMetadataSnapshot(uri: URI | string): IEntityMetadataSnapshot | undefined;
	saveMetadataSnapshot(snapshot: IEntityMetadataSnapshot): Promise<void>;
	repairEntityFromSnapshot(uri: URI): Promise<void>;
	removeSnapshot(uri: URI): Promise<void>;
}
