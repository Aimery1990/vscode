/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export type EntityType = 'workspace' | 'job' | 'project' | 'task' | 'workflow' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file' | string;

export interface IEntityGitSnapshot {
	remoteUrl?: string;
	branch?: string;
	lastCommitHash?: string;
	lastCommitMsg?: string;
	hasUncommittedChanges?: boolean;
	stashCount?: number;
}

export interface ICustomField {
	id: string;
	label: string;
	type: 'text' | 'textarea' | 'select' | 'multiselect' | 'switch';
	options?: string[];
}

export interface ICustomModule {
	id: string;
	name: string;
	isDeprecated?: boolean;
	color: string;
	storageScope?: 'global' | 'workspace';
	fields?: ICustomField[];
}

export interface IBaseEntitySnapshot {
	entityUri: string;
	entityName: string;
	entityType: EntityType;
	entityCode?: string;
	ownerAccount?: string;
	createdAt?: string;
	description?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	belongsToWorkspaceUri?: string;

	// Specialized properties for AI Agent
	systemPrompt?: string;
	role?: string;
	modelName?: string;
	avatarIcon?: string;
	scopeType?: string;
	scopeId?: string;
	scopeName?: string;

	// Git metadata snapshot
	git?: IEntityGitSnapshot;
	customMetadata?: { [key: string]: string };
}

export const IEntityPersistenceService = createDecorator<IEntityPersistenceService>('entityPersistenceService');

export interface IEntityPersistenceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSnapshots: Event<void>;

	saveSnapshot(snapshot: IBaseEntitySnapshot): Promise<void>;
	getSnapshot(uri: URI | string): IBaseEntitySnapshot | undefined;
	getAllSnapshots(): IBaseEntitySnapshot[];
	removeSnapshot(uri: URI | string): Promise<void>;

	inspectEntityHealth(uri: URI | string): Promise<{ isMissing: boolean; missingReason?: string; snapshot?: IBaseEntitySnapshot }>;
	repairEntityFromSnapshot(uri: URI | string): Promise<void>;
	writeEntity4MDFiles(snapshot: IBaseEntitySnapshot, targetFolderUri: URI, isNewFolder?: boolean): Promise<URI>;
}
