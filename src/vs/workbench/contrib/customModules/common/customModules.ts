/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
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

	getCategories(): Promise<string[]>;
	addCategory(category: string): Promise<void>;
	deleteCategory(category: string): Promise<void>;
	renameCategory(oldName: string, newName: string): Promise<void>;
	setModuleCategory(moduleId: string, category?: string): Promise<void>;

	getCompositeComponents(workspaceUri?: URI): Promise<ICompositeComponent[]>;
	saveCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void>;
	deleteCompositeComponent(component: ICompositeComponent, workspaceUri?: URI): Promise<void>;

	openSchemaDesigner(options?: { targetModuleId?: string; workspaceUri?: URI; onUpdate?: () => void }): Promise<void>;
	openModuleTicketPreview(moduleOrId: string | ICustomModule, workspaceUri?: URI): Promise<void>;
}
