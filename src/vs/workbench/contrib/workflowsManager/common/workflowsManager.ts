/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export interface IWorkflowItem {
	id: string; // 工作流实体目录的 URI 字符串
	name: string;
	description?: string;
	createdAt: string;
	ownerAccount?: string;
	belongsToWorkspaceUri?: string;
	belongsToWorkspaceName?: string;
	isMissing: boolean;
	missingReason?: string;
}

export const IWorkflowsManagerService = createDecorator<IWorkflowsManagerService>('workflowsManagerService');

export interface IWorkflowsManagerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorkflows: Event<void>;
	readonly onDidExpandPane: Event<string>;

	notifyPaneExpanded(paneId: string): void;
	getWorkflows(): Promise<IWorkflowItem[]>;
	getWorkflowsByWorkspace(workspaceUri: URI): Promise<IWorkflowItem[]>;
	deleteWorkflow(id: string): Promise<void>;
	repairWorkflow(id: string): Promise<void>;
}
