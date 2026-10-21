/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ICustomModule, ICompositeComponent } from '../../entityPersistence/common/entityPersistence.js';

export const ICustomModulesService = createDecorator<ICustomModulesService>('customModulesService');

export interface ICustomModulesService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeModules: Event<void>;

	getCustomModules(workspaceUri?: URI): Promise<ICustomModule[]>;
	getSystemModules(): ICustomModule[];
	saveCustomModules(modules: ICustomModule[], workspaceUri?: URI): Promise<void>;
	deleteCustomModule(moduleId: string, workspaceUri?: URI): Promise<void>;

	getCompositeComponents(workspaceUri?: URI): Promise<ICompositeComponent[]>;
	saveCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void>;
	deleteCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void>;

	openSchemaDesigner(options?: { targetModuleId?: string; workspaceUri?: URI; onUpdate?: () => void }): Promise<void>;
}
