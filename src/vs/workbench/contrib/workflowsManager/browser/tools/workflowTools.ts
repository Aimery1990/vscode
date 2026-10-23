/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { IWorkflowExecutionService } from '../../common/workflowExecutionService.js';
import { ITicketWorkflowRuntimeService } from '../ticketWorkflowRuntime.js';

export const ExecuteWorkflowToolId = 'anyagent_execute_workflow';
export const GetWorkflowStateToolId = 'anyagent_get_workflow_state';
export const ResumeWorkflowStepToolId = 'anyagent_resume_workflow_step';
export const StopWorkflowToolId = 'anyagent_stop_workflow';

export const CreateTicketsToolId = 'CREATE_TICKETS';
export const GetTicketsToolId = 'GET_TICKETS';
export const RunTicketsToolId = 'RUN_TICKETS';
export const GetPrimitivesCatalogToolId = 'GET_PRIMITIVES_CATALOG';

// Backwards-compatible aliases
export const CreateTicketToolId = CreateTicketsToolId;
export const GetTicketToolId = GetTicketsToolId;
export const RunTicketToolId = RunTicketsToolId;
export const LegacyCreateTicketToolId = 'anyagent_create_ticket';
export const LegacyGetTicketToolId = 'anyagent_get_ticket';
export const LegacyRunTicketToolId = 'anyagent_run_ticket';
export const LegacyGetPrimitivesCatalogToolId = 'anyagent_get_primitives_catalog';


function toolResult(data: any, message?: string): IToolResult {
	return {
		content: [{
			kind: 'text',
			value: typeof data === 'string' ? data : JSON.stringify(data, undefined, 2)
		}],
		toolResultMessage: message
	};
}

function toolError(errorMessage: string): IToolResult {
	return {
		content: [{
			kind: 'text',
			value: JSON.stringify({ error: errorMessage }, undefined, 2)
		}],
		toolResultError: errorMessage,
		toolResultMessage: `Error: ${errorMessage}`
	};
}

// -------------------------------------------------------------
// 1. anyagent_execute_workflow
// -------------------------------------------------------------
export class ExecuteWorkflowTool implements IToolImpl {
	constructor(
		private readonly executionService: IWorkflowExecutionService
	) { }

	getToolData(): IToolData {
		return {
			id: ExecuteWorkflowToolId,
			toolReferenceName: 'executeWorkflow',
			displayName: localize('workflow.tool.execute.displayName', "Execute Workflow"),
			userDescription: localize('workflow.tool.execute.userDescription', "Start running an AnyAgent flowchart workflow"),
			modelDescription: 'Execute a visual flowchart workflow DAG from start to finish. Sequentially executes nodes, imported tickets, and embedded agents, while handling conditions, sub-workflows, and human-in-the-loop steps. Supports standard, daemon, and step modes.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.play,
			inputSchema: {
				type: 'object',
				properties: {
					workflow_uri: {
						type: 'string',
						description: "The workflow URI or workflow name to execute (e.g. 'vscode-userdata:/.../MyWorkflow.workflow' or 'MyWorkflow')."
					},
					mode: {
						type: 'string',
						enum: ['standard', 'daemon', 'step'],
						description: "Execution mode: 'standard' runs one-shot from start to finish; 'daemon' runs as a continuous long-running background service; 'step' pauses at each node for single-stepping."
					},
					initial_inputs: {
						type: 'object',
						description: "Optional key-value context variables passed to the entry node."
					}
				},
				required: ['workflow_uri']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const wf = context.parameters?.workflow_uri || '';
		return {
			invocationMessage: localize('workflow.tool.execute.invoking', "Executing workflow {0}...", wf),
			pastTenseMessage: localize('workflow.tool.execute.done', "Executed workflow {0}", wf)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workflow_uri, mode, initial_inputs } = invocation.parameters;
			if (!workflow_uri) {
				return toolError("'workflow_uri' is required.");
			}
			const run = await this.executionService.executeWorkflow(workflow_uri, {
				mode: mode || 'standard',
				initialInputs: initial_inputs
			});

			return toolResult({
				runId: run.runId,
				workflowName: run.workflowName,
				status: run.status,
				mode: run.mode,
				startedAt: run.startedAt,
				visitedNodeIds: run.visitedNodeIds,
				contextVariables: run.contextVariables
			}, `Workflow '${run.workflowName}' started with Run ID: ${run.runId} (Status: ${run.status})`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 2. anyagent_get_workflow_state
// -------------------------------------------------------------
export class GetWorkflowStateTool implements IToolImpl {
	constructor(
		private readonly executionService: IWorkflowExecutionService
	) { }

	getToolData(): IToolData {
		return {
			id: GetWorkflowStateToolId,
			toolReferenceName: 'getWorkflowState',
			displayName: localize('workflow.tool.state.displayName', "Get Workflow State"),
			userDescription: localize('workflow.tool.state.userDescription', "Get execution state, current node, logs, and human approval prompts of a workflow"),
			modelDescription: 'Retrieve current running status, node outputs, visited nodes, executed tickets, logs, and any waiting human approval prompt for a given run ID or workflow URI.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.info,
			inputSchema: {
				type: 'object',
				properties: {
					run_id: {
						type: 'string',
						description: "The specific workflow run ID."
					},
					workflow_uri: {
						type: 'string',
						description: "Optional workflow URI to fetch the active or most recent run."
					}
				}
			}
		};
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		return {
			invocationMessage: localize('workflow.tool.state.invoking', "Checking workflow state..."),
			pastTenseMessage: localize('workflow.tool.state.done', "Checked workflow state")
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { run_id, workflow_uri } = invocation.parameters;
			let run = run_id ? this.executionService.getRun(run_id) : undefined;
			if (!run && workflow_uri) {
				run = this.executionService.getActiveRun(workflow_uri);
			}

			if (!run) {
				return toolError(`No active or existing workflow run found for parameters: ${JSON.stringify(invocation.parameters)}`);
			}

			return toolResult({
				runId: run.runId,
				workflowName: run.workflowName,
				status: run.status,
				mode: run.mode,
				currentNodeId: run.currentNodeId,
				visitedNodeIds: run.visitedNodeIds,
				nodeStates: run.nodeStates,
				recentLogs: run.logs.slice(-15),
				contextVariables: run.contextVariables
			}, `Retrieved state for run ${run.runId} (${run.status})`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 3. anyagent_resume_workflow_step
// -------------------------------------------------------------
export class ResumeWorkflowStepTool implements IToolImpl {
	constructor(
		private readonly executionService: IWorkflowExecutionService
	) { }

	getToolData(): IToolData {
		return {
			id: ResumeWorkflowStepToolId,
			toolReferenceName: 'resumeWorkflowStep',
			displayName: localize('workflow.tool.resume.displayName', "Resume Workflow Step"),
			userDescription: localize('workflow.tool.resume.userDescription', "Resume a paused or human-waiting workflow with optional input"),
			modelDescription: 'Resume a workflow that is either paused in single-step mode or waiting for human interaction/approval. Pass user input or approval decision to continue.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.debugContinue,
			inputSchema: {
				type: 'object',
				properties: {
					run_id: {
						type: 'string',
						description: "The workflow run ID to resume."
					},
					user_input: {
						type: 'object',
						description: "Optional user input, parameters, or approval payload (e.g. { approved: true, comment: 'LGTM' })."
					}
				},
				required: ['run_id']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const runId = context.parameters?.run_id || '';
		return {
			invocationMessage: localize('workflow.tool.resume.invoking', "Resuming workflow run {0}...", runId),
			pastTenseMessage: localize('workflow.tool.resume.done', "Resumed workflow run {0}", runId)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { run_id, user_input } = invocation.parameters;
			if (!run_id) {
				return toolError("'run_id' is required.");
			}
			await this.executionService.resumeWorkflow(run_id, user_input);
			return toolResult({ runId: run_id, status: 'resumed' }, `Successfully resumed workflow run ${run_id}`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 4. anyagent_stop_workflow
// -------------------------------------------------------------
export class StopWorkflowTool implements IToolImpl {
	constructor(
		private readonly executionService: IWorkflowExecutionService
	) { }

	getToolData(): IToolData {
		return {
			id: StopWorkflowToolId,
			toolReferenceName: 'stopWorkflow',
			displayName: localize('workflow.tool.stop.displayName', "Stop Workflow"),
			userDescription: localize('workflow.tool.stop.userDescription', "Cancel or terminate a running or daemon workflow"),
			modelDescription: 'Stop an active, paused, or daemon workflow run immediately.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.debugStop,
			inputSchema: {
				type: 'object',
				properties: {
					run_id: {
						type: 'string',
						description: "The workflow run ID to terminate."
					}
				},
				required: ['run_id']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const runId = context.parameters?.run_id || '';
		return {
			invocationMessage: localize('workflow.tool.stop.invoking', "Stopping workflow run {0}...", runId),
			pastTenseMessage: localize('workflow.tool.stop.done', "Stopped workflow run {0}", runId)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { run_id } = invocation.parameters;
			if (!run_id) {
				return toolError("'run_id' is required.");
			}
			await this.executionService.stopWorkflow(run_id);
			return toolResult({ runId: run_id, status: 'stopped' }, `Workflow run ${run_id} was stopped.`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 5. anyagent_create_ticket
// -------------------------------------------------------------
export class CreateTicketTool implements IToolImpl {
	constructor(
		private readonly ticketRuntimeService: ITicketWorkflowRuntimeService
	) { }

	getToolData(): IToolData {
		return {
			id: CreateTicketsToolId,
			toolReferenceName: 'CREATE_TICKETS',
			displayName: localize('workflow.tool.createTickets.displayName', "CREATE_TICKETS"),
			userDescription: localize('workflow.tool.createTicket.userDescription', "Create a new ticket from a schema template in the workspace"),
			modelDescription: 'Create a new ticket entity in the workspace based on a schema (custom module or built-in type). Initializes fields, parameters, and 4 markdown files (instruction.md, README.md, work_log.md, metadata.json).',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.add,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_uri: {
						type: 'string',
						description: "The root workspace URI or folder path where tickets are managed."
					},
					target_path: {
						type: 'string',
						description: "Optional relative subfolder path within the workspace (e.g. 'jobs', 'jobs/fino3', 'tasks')."
					},
					ticket_type: {
						type: 'string',
						description: "The schema type ID or name (e.g. 'task', 'job', 'analysis', or custom module ID)."
					},
					title: {
						type: 'string',
						description: "The title of the ticket."
					},
					description: {
						type: 'string',
						description: "Optional description or summary of the ticket."
					},
					parameters: {
						type: 'object',
						description: "Optional dictionary of initial parameter and variable values."
					},
					field_values: {
						type: 'object',
						description: "Optional initial values for specific schema fields."
					}
				},
				required: ['workspace_uri', 'ticket_type', 'title']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const title = context.parameters?.title || 'New Ticket';
		return {
			invocationMessage: localize('workflow.tool.createTicket.invoking', "Creating ticket '{0}'...", title),
			pastTenseMessage: localize('workflow.tool.createTicket.done', "Created ticket '{0}'", title)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workspace_uri, target_path, ticket_type, title, description, parameters, field_values } = invocation.parameters;
			if (!workspace_uri || !ticket_type || !title) {
				return toolError("'workspace_uri', 'ticket_type', and 'title' are required.");
			}
			const res = await this.ticketRuntimeService.createTicket({
				workspaceUri: workspace_uri,
				targetPath: target_path,
				ticketType: ticket_type,
				title: title,
				description: description,
				parameters: parameters,
				fieldValues: field_values
			});
			if (!res.success) {
				return toolError(res.error || 'Failed to create ticket.');
			}
			return toolResult(res, `Successfully created ticket '${res.ticketId}' (${res.ticketName}) at ${res.targetFolder}`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 6. anyagent_get_ticket
// -------------------------------------------------------------
export class GetTicketTool implements IToolImpl {
	constructor(
		private readonly ticketRuntimeService: ITicketWorkflowRuntimeService
	) { }

	getToolData(): IToolData {
		return {
			id: GetTicketsToolId,
			toolReferenceName: 'GET_TICKETS',
			displayName: localize('workflow.tool.getTickets.displayName', "GET_TICKETS"),
			userDescription: localize('workflow.tool.getTicket.userDescription', "Retrieve ticket details, fields, custom metadata, and output"),
			modelDescription: 'Query and fetch ticket details including current field values, customMetadata, execution outputs, and schema configuration by ticketId, name, or path.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.info,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_uri: {
						type: 'string',
						description: "The root workspace URI or path."
					},
					ticket_id_or_path: {
						type: 'string',
						description: "Ticket identifier, ticket code, folder name, or relative path."
					}
				},
				required: ['workspace_uri', 'ticket_id_or_path']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const tid = context.parameters?.ticket_id_or_path || '';
		return {
			invocationMessage: localize('workflow.tool.getTicket.invoking', "Fetching ticket '{0}'...", tid),
			pastTenseMessage: localize('workflow.tool.getTicket.done', "Fetched ticket '{0}'", tid)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workspace_uri, ticket_id_or_path } = invocation.parameters;
			if (!workspace_uri || !ticket_id_or_path) {
				return toolError("'workspace_uri' and 'ticket_id_or_path' are required.");
			}
			const res = await this.ticketRuntimeService.getTicket(workspace_uri, ticket_id_or_path);
			if (!res.success) {
				return toolError(res.error || `Ticket '${ticket_id_or_path}' not found.`);
			}
			return toolResult(res, `Retrieved ticket '${res.ticketId}' (Type: ${res.ticketType}, Status: ${res.status})`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 7. RUN_TICKETS
// -------------------------------------------------------------
export class RunTicketTool implements IToolImpl {
	constructor(
		private readonly ticketRuntimeService: ITicketWorkflowRuntimeService
	) { }

	getToolData(): IToolData {
		return {
			id: RunTicketsToolId,
			toolReferenceName: 'RUN_TICKETS',
			displayName: localize('workflow.tool.runTickets.displayName', "RUN_TICKETS"),
			userDescription: localize('workflow.tool.runTicket.userDescription', "Sequentially execute all primitives on a ticket schema from top to bottom"),
			modelDescription: 'Execute a ticket as an autonomous runtime unit. Evaluates parameters, performs browser navigations/extractions, triggers AI prompts, aggregates outputs, and persists state.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.playCircle,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_uri: {
						type: 'string',
						description: "The root workspace URI or path."
					},
					ticket_id_or_path: {
						type: 'string',
						description: "Ticket identifier, code, folder name, or relative path."
					},
					input_params: {
						type: 'object',
						description: "Optional runtime parameter overrides or context variables passed from workflow."
					}
				},
				required: ['workspace_uri', 'ticket_id_or_path']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const tid = context.parameters?.ticket_id_or_path || '';
		return {
			invocationMessage: localize('workflow.tool.runTicket.invoking', "Running ticket '{0}' pipeline...", tid),
			pastTenseMessage: localize('workflow.tool.runTicket.done', "Finished running ticket '{0}'", tid)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workspace_uri, ticket_id_or_path, input_params } = invocation.parameters;
			if (!workspace_uri || !ticket_id_or_path) {
				return toolError("'workspace_uri' and 'ticket_id_or_path' are required.");
			}
			const res = await this.ticketRuntimeService.runTicket({
				workspaceUri: workspace_uri,
				ticketIdOrPath: ticket_id_or_path,
				inputParams: input_params
			});
			if (!res.success) {
				return toolError(res.error || `Execution of ticket '${ticket_id_or_path}' failed.`);
			}
			return toolResult(res, `Ticket '${res.ticketId}' executed successfully in ${res.durationMs}ms`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 8. GET_PRIMITIVES_CATALOG
// -------------------------------------------------------------
export class GetPrimitivesCatalogTool implements IToolImpl {
	constructor(
		private readonly ticketRuntimeService: ITicketWorkflowRuntimeService
	) { }

	getToolData(): IToolData {
		return {
			id: GetPrimitivesCatalogToolId,
			toolReferenceName: 'GET_PRIMITIVES_CATALOG',
			displayName: localize('workflow.tool.catalog.displayName', "GET_PRIMITIVES_CATALOG"),
			userDescription: localize('workflow.tool.catalog.userDescription', "Get all Base Primitives and Reusable Classes with their runtime execution specifications"),
			modelDescription: 'Retrieve the latest catalog of all 18 Base Primitives and Reusable Classes, including their data categories, supported inputs, outputs, and execution behaviors.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.library,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_uri: {
						type: 'string',
						description: "Optional workspace URI to include workspace-specific Reusable Classes."
					}
				}
			}
		};
	}

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		return {
			invocationMessage: localize('workflow.tool.catalog.invoking', "Retrieving primitives catalog..."),
			pastTenseMessage: localize('workflow.tool.catalog.done', "Retrieved primitives catalog")
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workspace_uri } = invocation.parameters;
			const catalog = await this.ticketRuntimeService.getPrimitivesCatalog(workspace_uri);
			return toolResult({ total: catalog.length, primitives: catalog }, `Retrieved catalog with ${catalog.length} primitives and classes.`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

