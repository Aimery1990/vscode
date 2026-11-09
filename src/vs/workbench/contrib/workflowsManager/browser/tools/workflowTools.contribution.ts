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
	GetOutputsTool,
	RunTicketTool,
	GetPrimitivesCatalogTool,
	LegacyCreateTicketToolId,
	LegacyGetTicketToolId,
	LegacyGetOutputsToolId,
	LegacyRunTicketToolId,
	LegacyGetPrimitivesCatalogToolId
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

		const registerSafe = (data: any, impl: any) => {
			if (!toolsService.getTool(data.id)) {
				this._register(toolsService.registerTool(data, impl));
			}
		};

		registerSafe(executeTool.getToolData(), executeTool);
		registerSafe(stateTool.getToolData(), stateTool);
		registerSafe(resumeTool.getToolData(), resumeTool);
		registerSafe(stopTool.getToolData(), stopTool);

		// Primary UPPERCASE tools
		registerSafe(createTicketTool.getToolData(), createTicketTool);
		registerSafe(getTicketTool.getToolData(), getTicketTool);
		registerSafe(getOutputsTool.getToolData(), getOutputsTool);
		registerSafe(runTicketTool.getToolData(), runTicketTool);
		registerSafe(getCatalogTool.getToolData(), getCatalogTool);

		// Legacy & lowercase aliases
		registerSafe({ ...createTicketTool.getToolData(), id: LegacyCreateTicketToolId, toolReferenceName: 'createTickets' }, createTicketTool);
		registerSafe({ ...getTicketTool.getToolData(), id: LegacyGetTicketToolId, toolReferenceName: 'getTickets' }, getTicketTool);
		registerSafe({ ...getOutputsTool.getToolData(), id: LegacyGetOutputsToolId, toolReferenceName: 'getOutputs' }, getOutputsTool);
		registerSafe({ ...getOutputsTool.getToolData(), id: 'get_outputs', toolReferenceName: 'get_outputs' }, getOutputsTool);
		registerSafe({ ...runTicketTool.getToolData(), id: LegacyRunTicketToolId, toolReferenceName: 'runTickets' }, runTicketTool);
		registerSafe({ ...getCatalogTool.getToolData(), id: LegacyGetPrimitivesCatalogToolId, toolReferenceName: 'getPrimitivesCatalog' }, getCatalogTool);
	}
}


registerWorkbenchContribution2(WorkflowToolsContribution.ID, WorkflowToolsContribution, WorkbenchPhase.Eventually);

