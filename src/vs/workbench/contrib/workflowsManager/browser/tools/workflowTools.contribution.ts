/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../../../chat/common/tools/languageModelToolsService.js';
import { IWorkflowExecutionService } from '../../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from '../ticketWorkflowRuntime.js';
import {
	ExecuteWorkflowTool,
	GetWorkflowStateTool,
	ResumeWorkflowStepTool,
	StopWorkflowTool,
	CreateTicketTool,
	GetTicketTool,
	RunTicketTool,
	GetPrimitivesCatalogTool
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
		const runTicketTool = new RunTicketTool(ticketRuntimeService);
		const getCatalogTool = new GetPrimitivesCatalogTool(ticketRuntimeService);

		this._register(toolsService.registerTool(executeTool.getToolData(), executeTool));
		this._register(toolsService.registerTool(stateTool.getToolData(), stateTool));
		this._register(toolsService.registerTool(resumeTool.getToolData(), resumeTool));
		this._register(toolsService.registerTool(stopTool.getToolData(), stopTool));

		this._register(toolsService.registerTool(createTicketTool.getToolData(), createTicketTool));
		this._register(toolsService.registerTool(getTicketTool.getToolData(), getTicketTool));
		this._register(toolsService.registerTool(runTicketTool.getToolData(), runTicketTool));
		this._register(toolsService.registerTool(getCatalogTool.getToolData(), getCatalogTool));
	}
}

registerWorkbenchContribution2(WorkflowToolsContribution.ID, WorkflowToolsContribution, WorkbenchPhase.Eventually);

