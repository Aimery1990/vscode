/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';
import { ICustomModulesService } from '../../common/customModules.js';
import { IWorkspacesExplorerService } from '../../../workspacesExplorer/common/workspacesExplorer.js';
import { DeleteCustomModuleTool, GenerateCustomModuleTool, ListCustomModulesTool, ToggleCustomModuleStatusTool } from './customModuleTools.js';

export class CustomModuleToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.customModuleTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@ICustomModulesService customModulesService: ICustomModulesService,
		@IWorkspacesExplorerService workspacesExplorerService: IWorkspacesExplorerService,
	) {
		super();

		const listTool = new ListCustomModulesTool(customModulesService, workspacesExplorerService);
		const genTool = new GenerateCustomModuleTool(customModulesService, workspacesExplorerService);
		const toggleTool = new ToggleCustomModuleStatusTool(customModulesService, workspacesExplorerService);
		const deleteTool = new DeleteCustomModuleTool(customModulesService, workspacesExplorerService);

		this._register(toolsService.registerTool(listTool.getToolData(), listTool));
		this._register(toolsService.registerTool(genTool.getToolData(), genTool));
		this._register(toolsService.registerTool(toggleTool.getToolData(), toggleTool));
		this._register(toolsService.registerTool(deleteTool.getToolData(), deleteTool));
	}
}

registerWorkbenchContribution2(CustomModuleToolsContribution.ID, CustomModuleToolsContribution, WorkbenchPhase.Eventually);
