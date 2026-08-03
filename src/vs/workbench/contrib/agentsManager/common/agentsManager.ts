/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export type AgentScopeType = 'workspace' | 'project' | 'job' | 'workflow' | 'none';

export interface IAgentItem {
	id: string;
	name: string;
	role: string;
	description?: string;
	systemPrompt: string;
	modelName?: string;
	avatarIcon: string;
	scopeType: AgentScopeType;
	scopeId: string;
	scopeName: string;
	folderPath?: string;
	status: 'idle' | 'busy' | 'offline';
	createdAt: number;
	updatedAt: number;
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
	assignTaskToAgent(agentId: string, taskTitle: string, taskDescription?: string): Promise<void>;
}
