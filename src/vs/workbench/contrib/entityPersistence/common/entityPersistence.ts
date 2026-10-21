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

export type CustomFieldType =
	| 'text'
	| 'number'
	| 'textarea'
	| 'select'
	| 'multiselect'
	| 'switch'
	| 'date'
	| 'time'
	| 'datetime'
	| 'date_range'
	| 'time_range'
	| 'datetime_range'
	| 'dynamic_list'
	| 'attachment'
	| 'button_group'
	| 'button'
	| 'browser'
	| 'git';

export interface IActionButton {
	id: string;
	label: string;
	color?: string;
	targetStatus?: string;
}

export interface ICredentialPair {
	id: string;
	key: string;
	value: string;
}

export interface ICustomField {
	id: string;
	label: string;
	type: CustomFieldType;
	options?: string[];
	itemFields?: ICustomField[];
	componentRef?: string;
	buttons?: IActionButton[];
	unit?: string;
	precision?: number;
	min?: number;
	max?: number;
	step?: number;
	required?: boolean;
	defaultUrl?: string;
	defaultContent?: string;
	credentials?: ICredentialPair[];
	gitRemoteUrl?: string;
	gitBranch?: string;
}

export interface ICompositeComponent {
	id: string;
	name: string;
	description?: string;
	itemFields: ICustomField[];
	storageScope?: 'global' | 'workspace';
}

export interface IStatusDefinition {
	id: string;
	label: string;
	color: string;
	category: 'Todo' | 'In Progress' | 'Done' | 'Blocked' | 'Removed';
	description?: string;
}

export const DEFAULT_STATUS_DEFINITIONS: IStatusDefinition[] = [
	{ id: 'todo', label: 'Todo', color: '#818cf8', category: 'Todo', description: 'Initial backlog / pending' },
	{ id: 'in_progress', label: 'In Progress', color: '#fbbf24', category: 'In Progress', description: 'Active development' },
	{ id: 'done', label: 'Done', color: '#34d399', category: 'Done', description: 'Completed & delivered' },
	{ id: 'blocked', label: 'Blocked', color: '#f43f5e', category: 'Blocked', description: 'Waiting / on hold' },
	{ id: 'removed', label: 'Removed', color: '#94a3b8', category: 'Removed', description: 'Archived / purged' }
];

export interface ICustomModule {
	id: string;
	name: string;
	description?: string;
	prompt?: string;
	isDeprecated?: boolean;
	color: string;
	storageScope?: 'global' | 'workspace';
	fields?: ICustomField[];
	statuses?: IStatusDefinition[];
}

export interface IBaseEntitySnapshot {
	entityUri: string;
	entityName: string;
	title?: string;
	ticketId?: string;
	workspaceId?: string;
	entityType: EntityType;
	entityCode?: string;
	ownerAccount?: string;
	createdAt?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	typeDefinition?: string;
	typePrompt?: string;
	ticketPrompt?: string;
	linkTo?: string;
	linkedBy?: string;
	attachments?: string[];
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

	writeEntity4MDFiles(snapshot: IBaseEntitySnapshot, targetFolderUri: URI, isNewFolder?: boolean): Promise<URI>;
}
