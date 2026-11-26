/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILanguageModelToolsService, IToolData, IToolImpl } from '../../../chat/common/tools/languageModelToolsService.js';
import { IWorkflowExecutionService } from '../../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from '../ticketWorkflowRuntime.js';
import {
	ExecuteWorkflowTool,
	GetWorkflowStateTool,
	ResumeWorkflowStepTool,
	StopWorkflowTool,
	CreateTicketTool,
	GetTicketTool,
	GetOutputsTool,
	RunTicketTool,
	GetPrimitivesCatalogTool,
	GetTicketsTool
} from './workflowTools.js';

export class WorkflowToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workflowTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IWorkflowExecutionService executionService: IWorkflowExecutionService,
		@ITicketWorkflowRuntimeService ticketRuntimeService: ITicketWorkflowRuntimeService
	) {
		super();

		const executeTool = new ExecuteWorkflowTool(executionService);
		const stateTool = new GetWorkflowStateTool(executionService);
		const resumeTool = new ResumeWorkflowStepTool(executionService);
		const stopTool = new StopWorkflowTool(executionService);

		const createTicketTool = new CreateTicketTool(ticketRuntimeService);
		const getTicketTool = new GetTicketTool(ticketRuntimeService);
		const getOutputsTool = new GetOutputsTool(ticketRuntimeService);
		const runTicketTool = new RunTicketTool(ticketRuntimeService);
		const getCatalogTool = new GetPrimitivesCatalogTool(ticketRuntimeService);
		const getTicketsTool = new GetTicketsTool(ticketRuntimeService);

		const registerSafe = (data: IToolData, impl: IToolImpl) => {
			if (!toolsService.getTool(data.id)) {
				this._register(toolsService.registerTool(data, impl));
			}
		};

		registerSafe(executeTool.getToolData(), executeTool);
		registerSafe(stateTool.getToolData(), stateTool);
		registerSafe(resumeTool.getToolData(), resumeTool);
		registerSafe(stopTool.getToolData(), stopTool);

		// One id per tool (no aliases); ids match the workflow Python built-ins
		registerSafe(createTicketTool.getToolData(), createTicketTool);
		registerSafe(getTicketTool.getToolData(), getTicketTool);
		registerSafe(getTicketsTool.getToolData(), getTicketsTool);
		registerSafe(getOutputsTool.getToolData(), getOutputsTool);
		registerSafe(runTicketTool.getToolData(), runTicketTool);
		registerSafe(getCatalogTool.getToolData(), getCatalogTool);
	}
}


registerWorkbenchContribution2(WorkflowToolsContribution.ID, WorkflowToolsContribution, WorkbenchPhase.Eventually);

