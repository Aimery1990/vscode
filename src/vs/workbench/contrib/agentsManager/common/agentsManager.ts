/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export type AgentScopeType = 'workspace' | 'project' | 'job' | 'workflow' | 'none';

export interface IAgentModelReference {
	readonly providerId: string;
	readonly modelId: string;
	readonly credentialId?: string;
}

export interface IAgentItem {
	id: string;
	name: string;
	role: string;
	description?: string;
	systemPrompt: string;
	model?: IAgentModelReference;
	avatarIcon: string;
	scopeType: AgentScopeType;
	scopeId: string;
	scopeName: string;
	folderPath?: string;
	status: 'idle' | 'busy' | 'offline';
	createdAt: number;
	updatedAt: number;
}

export interface IAgentCredential {
	readonly id: string;
	readonly name: string;
	readonly providerId: string; // 'gemini' | 'openai' | 'anthropic' | 'custom-openai'
	readonly customUrl?: string; // Endpoint URL
	readonly isEnabled?: boolean;
	readonly lastVerifiedAt?: number;
	readonly connectionStatus?: 'connected' | 'error' | 'unverified';
	readonly connectionMessage?: string;
	readonly cachedModels?: string[];
	readonly createdAt: number;
}

export const IAgentCredentialService = createDecorator<IAgentCredentialService>('agentCredentialService');

export interface IAgentCredentialService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCredentials: Event<void>;

	getCredentials(): Promise<IAgentCredential[]>;
	addCredential(name: string, providerId: string, apiKey: string, customUrl?: string): Promise<IAgentCredential>;
	updateCredential(credential: IAgentCredential): Promise<void>;
	removeCredential(id: string): Promise<void>;
	getCredential(id: string): Promise<IAgentCredential | undefined>;
	getApiKey(id: string): Promise<string | undefined>;
	testConnection(providerId: string, apiKey: string, modelId: string, customUrl?: string): Promise<{ success: boolean; message: string }>;
	fetchModels(providerId: string, apiKey: string, customUrl?: string): Promise<string[]>;
	refreshCredential(id: string): Promise<void>;
}

export const IAgentsManagerService = createDecorator<IAgentsManagerService>('agentsManagerService');

export interface IAgentsManagerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAgents: Event<void>;
	readonly onDidExpandPane: Event<string>;

	notifyPaneExpanded(paneId: string): void;
	getAgents(): Promise<IAgentItem[]>;
	getAgentsByScope(scopeType: AgentScopeType, scopeId?: string): Promise<IAgentItem[]>;
	getAgent(id: string): Promise<IAgentItem | undefined>;
	addAgent(agent: Omit<IAgentItem, 'id' | 'createdAt' | 'updatedAt'>, targetParentUri?: URI): Promise<IAgentItem>;
	updateAgent(agent: IAgentItem): Promise<void>;
	removeAgent(id: string): Promise<void>;
	repairAgent(id: string): Promise<void>;
	ensureAgentFolder(id: string): Promise<URI | undefined>;
	assignTaskToAgent(agentId: string, taskTitle: string, taskDescription?: string): Promise<void>;
}
