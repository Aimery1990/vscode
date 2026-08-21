/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export const IDiagramsManagerService = createDecorator<IDiagramsManagerService>('diagramsManagerService');

export const DIAGRAMS_MANAGER_VIEWLET_ID = 'workbench.view.diagramsManager';
export const DIAGRAMS_MANAGER_PANE_ID = 'workbench.view.diagramsManager.all';

export interface IDiagramItem {
	id: string; // uri string
	name: string;
	uri: URI;
	description?: string;
	createdAt?: string;
	belongsToWorkspaceUri?: string;
	belongsToWorkspaceName?: string;
	isMissing?: boolean;
}

export interface ICreateDiagramOptions {
	name: string;
	description?: string;
	targetWorkspaceUri?: URI;
}

export interface IDiagramsManagerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDiagrams: Event<void>;
	readonly onDidExpandPane: Event<string>;

	notifyPaneExpanded(paneId: string): void;
	getDiagrams(): Promise<IDiagramItem[]>;
	getDiagramsByWorkspace(workspaceUri: URI): Promise<IDiagramItem[]>;
	createDiagram(options: ICreateDiagramOptions): Promise<URI>;
	deleteDiagram(uri: URI): Promise<void>;
	renameDiagram(uri: URI, newName: string): Promise<URI>;
}
