/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export interface ISavedWorkflowRecord {
	uri: string; // Workflow directory URI string
	name: string;
	description?: string;
	belongsToWorkspaceUri?: string;
	belongsToWorkspaceName?: string;
	createdAt?: string;
}

export interface IWorkflowItem {
	id: string; // Workflow directory URI string
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
	saveWorkflow(record: ISavedWorkflowRecord): Promise<void>;
	removeSavedWorkflow(uri: URI | string): Promise<void>;
	deleteWorkflow(id: string): Promise<void>;
}
