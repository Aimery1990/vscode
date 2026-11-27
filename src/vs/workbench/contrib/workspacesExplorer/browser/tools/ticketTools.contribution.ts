/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';
import { TicketDataEngine } from './ticketDataEngine.js';
import { CreateTicketTool, DeleteTicketTool, GetTicketDataTool, GetTicketHistoryTool, ManageLinksTool, OperateTicketTableTool, QueryWorkspaceTreeTool, UpdateTicketTool } from './ticketTools.js';

export class TicketToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.ticketTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const engine = instantiationService.createInstance(TicketDataEngine);

		const getTool = new GetTicketDataTool(engine);
		const createTool = new CreateTicketTool(engine);
		const deleteTool = new DeleteTicketTool(engine);
		const updateTool = new UpdateTicketTool(engine);
		const linkTool = new ManageLinksTool(engine);
		const queryTreeTool = new QueryWorkspaceTreeTool(engine);
		const operateTableTool = new OperateTicketTableTool(engine);
		const historyTool = new GetTicketHistoryTool(engine);

		this._register(toolsService.registerTool(getTool.getToolData(), getTool));
		this._register(toolsService.registerTool(createTool.getToolData(), createTool));
		this._register(toolsService.registerTool(deleteTool.getToolData(), deleteTool));
		this._register(toolsService.registerTool(updateTool.getToolData(), updateTool));
		this._register(toolsService.registerTool(linkTool.getToolData(), linkTool));
		this._register(toolsService.registerTool(queryTreeTool.getToolData(), queryTreeTool));
		this._register(toolsService.registerTool(operateTableTool.getToolData(), operateTableTool));
		this._register(toolsService.registerTool(historyTool.getToolData(), historyTool));
	}
}

// Register contribution at Eventually phase (or BlockRestore)
registerWorkbenchContribution2(TicketToolsContribution.ID, TicketToolsContribution, WorkbenchPhase.Eventually);
