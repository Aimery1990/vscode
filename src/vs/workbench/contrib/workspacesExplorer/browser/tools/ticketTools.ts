/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { TicketDataEngine } from './ticketDataEngine.js';

export const GetTicketDataToolId = 'anyagent_get_ticket_data';
export const CreateTicketToolId = 'anyagent_create_ticket';
export const DeleteTicketToolId = 'anyagent_delete_ticket';
export const UpdateTicketToolId = 'anyagent_update_ticket';
export const ManageLinksToolId = 'anyagent_manage_links';

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
// 1. anyagent_get_ticket_data
// -------------------------------------------------------------
export class GetTicketDataTool implements IToolImpl {

	constructor(
		private readonly ticketEngine: TicketDataEngine
	) { }

	getToolData(): IToolData {
		return {
			id: GetTicketDataToolId,
			toolReferenceName: 'getTicketData',
			displayName: localize('ticket.tool.get.displayName', "Get Ticket Data"),
			userDescription: localize('ticket.tool.get.userDescription', "Get ticket field values and schema metadata"),
			modelDescription: 'Retrieve actual values, field types, and allowed scopes of a ticket. If field_path is omitted, returns the entire ticket values alongside its complete YAML type schema definition and workspace status mapping.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.search,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "The root workspace ID (e.g. 'FNDJ1-0000')."
					},
					ticket_id: {
						type: 'string',
						description: "The target ticket ID (e.g. 'FNDJ1-0001', or root 'FNDJ1-0000')."
					},
					field_path: {
						type: 'string',
						description: "Optional target path (e.g. '/Status', '/Attributes/Priority', '/Custom/education/LU Edu/degree', '/Custom/education')."
					}
				},
				required: ['workspace_id', 'ticket_id']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const ticketId = context.parameters?.ticket_id || '';
		return {
			invocationMessage: localize('ticket.tool.get.invoking', "Fetching ticket data for {0}...", ticketId),
			pastTenseMessage: localize('ticket.tool.get.done', "Fetched ticket data for {0}", ticketId)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const { workspace_id, ticket_id, field_path } = invocation.parameters;
			if (!workspace_id || !ticket_id) {
				return toolError("'workspace_id' and 'ticket_id' are required.");
			}
			const data = await this.ticketEngine.getTicketData(workspace_id, ticket_id, field_path);
			return toolResult(data, `Retrieved data for ticket ${ticket_id}`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 2. anyagent_create_ticket
// -------------------------------------------------------------
export class CreateTicketTool implements IToolImpl {

	constructor(
		private readonly ticketEngine: TicketDataEngine
	) { }

	getToolData(): IToolData {
		return {
			id: CreateTicketToolId,
			toolReferenceName: 'createTicket',
			displayName: localize('ticket.tool.create.displayName', "Create Ticket"),
			userDescription: localize('ticket.tool.create.userDescription', "Create a new ticket and initialize standard 4-MD files"),
			modelDescription: 'Create a new ticket under a workspace or parent ticket. Automatically initializes all 4 MD files (.agents/README.md, ticket.md, instruction.md, worklog.md), sets status (defaulting to the workspace initial status e.g. Todo), and writes the mandatory initial record to worklog.md.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.plus,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "The root workspace ID (e.g. 'FNDJ1-0000')."
					},
					parent_path: {
						type: 'string',
						description: "Relative parent path from workspace root: '/' for top-level child, or '/FNDJ1-0001' for sub-tickets."
					},
					ticket_type: {
						type: 'string',
						description: "Entity type matching an existing type definition (e.g. 'job', 'task', 'note', 'resume', 'education')."
					},
					title: {
						type: 'string',
						description: "Mandatory business title for README.md."
					},
					description: {
						type: 'string',
						description: "Optional detailed description text."
					},
					status: {
						type: 'string',
						description: "Initial status name. If omitted, defaults to the status mapped to 'INITIAL' in the current workspace."
					},
					priority: {
						type: 'string',
						enum: ['Very High', 'High', 'Medium', 'Low', 'Very Low'],
						default: 'Medium',
						description: "Priority level. Defaults to 'Medium'."
					},
					ticket_prompt: {
						type: 'string',
						description: "Optional custom prompt tailored specifically for this ticket instance."
					},
					assigned_agent: {
						type: 'string',
						description: "Optional AI Agent ID/Name to assign, or 'None'."
					},
					link_to: {
						type: 'string',
						description: "Optional comma-separated Ticket IDs to link to (e.g. 'FNDJ1-0002')."
					},
					attachments: {
						type: 'array',
						items: { type: 'string' },
						description: "Optional array of attachment file paths or URLs."
					},
					custom_values: {
						type: 'object',
						description: "Initial key-value map for self-defined fields defined in the type YAML schema."
					},
					worklog_record: {
						type: 'object',
						description: "Mandatory initial execution log written to worklog.md.",
						properties: {
							user_request: { type: 'string', description: "Polished and clear user requirement in fluent language." },
							update_summary: { type: 'string', description: "1-sentence summary of ticket creation." },
							update_details: { type: 'string', description: "Detailed bullet points of initial parameters and assigned values." },
							update_conclusion: { type: 'string', description: "Evaluation confirming successful ticket initialization." },
							commit: {
								type: 'object',
								description: "Explicit git commit info if code was committed during this task, or omitted/null if no commit was performed.",
								properties: {
									repo: { type: 'string' },
									branch: { type: 'string' },
									commit_id: { type: 'string' },
									comment: { type: 'string' },
									committed_by: { type: 'string' }
								}
							}
						},
						required: ['user_request', 'update_summary', 'update_details', 'update_conclusion']
					}
				},
				required: ['workspace_id', 'parent_path', 'ticket_type', 'title', 'worklog_record']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const title = context.parameters?.title || 'new ticket';
		return {
			invocationMessage: localize('ticket.tool.create.invoking', "Creating ticket '{0}'...", title),
			pastTenseMessage: localize('ticket.tool.create.done', "Created ticket '{0}'", title)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const res = await this.ticketEngine.createTicket(invocation.parameters as any);
			return toolResult(res, `Ticket '${res.ticket_id}' (${res.title}) created successfully.`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 3. anyagent_delete_ticket
// -------------------------------------------------------------
export class DeleteTicketTool implements IToolImpl {

	constructor(
		private readonly ticketEngine: TicketDataEngine
	) { }

	getToolData(): IToolData {
		return {
			id: DeleteTicketToolId,
			toolReferenceName: 'deleteTicket',
			displayName: localize('ticket.tool.delete.displayName', "Delete Ticket"),
			userDescription: localize('ticket.tool.delete.userDescription', "Remove ticket and cascade clean references"),
			modelDescription: 'Remove a ticket from active workspace. Marks the ticket (and recursively all its child tickets) as the workspace status mapped to REMOVED, automatically cleans up bidirectional references in other tickets Link To/Linked By, and appends deletion logs to worklog.md.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.trash,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "The root workspace ID (e.g. 'FNDJ1-0000')."
					},
					ticket_id: {
						type: 'string',
						description: "The target ticket ID to remove (e.g. 'FNDJ1-0004')."
					},
					worklog_record: {
						type: 'object',
						description: "Mandatory execution log recorded in worklog.md of the removed ticket (and cascaded children).",
						properties: {
							user_request: { type: 'string', description: "User requirement explaining why the ticket is being removed." },
							update_summary: { type: 'string', description: "1-sentence summary of removal." },
							update_details: { type: 'string', description: "Details of removed entity, cascaded child tickets, and unlinked references." },
							update_conclusion: { type: 'string', description: "Confirmation of safe removal and link cleanup." },
							commit: {
								type: 'object',
								description: "Explicit git commit info if code was committed during this task, or omitted/null if no commit was performed.",
								properties: {
									repo: { type: 'string' },
									branch: { type: 'string' },
									commit_id: { type: 'string' },
									comment: { type: 'string' },
									committed_by: { type: 'string' }
								}
							}
						},
						required: ['user_request', 'update_summary', 'update_details', 'update_conclusion']
					}
				},
				required: ['workspace_id', 'ticket_id', 'worklog_record']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const ticketId = context.parameters?.ticket_id || '';
		return {
			invocationMessage: localize('ticket.tool.delete.invoking', "Removing ticket {0} from active workspace...", ticketId),
			pastTenseMessage: localize('ticket.tool.delete.done', "Removed ticket {0}", ticketId)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const res = await this.ticketEngine.deleteTicket(invocation.parameters as any);
			return toolResult(res, `Ticket '${res.removed_ticket_id}' marked as '${res.status_set_to}' and links cleaned up.`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 4. anyagent_update_ticket
// -------------------------------------------------------------
export class UpdateTicketTool implements IToolImpl {

	constructor(
		private readonly ticketEngine: TicketDataEngine
	) { }

	getToolData(): IToolData {
		return {
			id: UpdateTicketToolId,
			toolReferenceName: 'updateTicket',
			displayName: localize('ticket.tool.update.displayName', "Update Ticket"),
			userDescription: localize('ticket.tool.update.userDescription', "Update standard fields, prompts, custom properties, or dynamic cards"),
			modelDescription: 'Update or clear standard attributes, prompts, custom fields, and dynamic list cards using exact field paths (e.g. /Custom/education/LU Edu/degree or /Custom/education/add). Automatically appends structured execution details into worklog.md.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.edit,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "The root workspace ID (e.g. 'FNDJ1-0000')."
					},
					ticket_id: {
						type: 'string',
						description: "The target ticket ID to update (e.g. 'FNDJ1-0001')."
					},
					updates: {
						type: 'object',
						description: "Path-to-value map. Set value to null to clear a field or delete a dynamic list card. Path rules:\n- Standard fields: '/Title': 'New Title', '/Status': 'In Dev', '/Priority': 'High'\n- Instruction prompt: '/Instructions/Ticket Prompt': 'Specific rules...'\n- Clear field: '/Custom/expected_salary': null\n- Dynamic list update item: '/Custom/education/LU Edu/degree': 'Master of Computer Science'\n- Dynamic list delete card: '/Custom/education/HNU Edu': null\n- Dynamic list add new card: '/Custom/education/add': { 'key': 'Stanford Edu', 'school': 'Stanford University', 'degree': 'PhD', 'period': '2026-09 ~ 2030-06' }"
					},
					worklog_record: {
						type: 'object',
						description: "Mandatory execution log to append to worklog.md.",
						properties: {
							user_request: { type: 'string', description: "Polished, fluent user requirement in clean language." },
							update_summary: { type: 'string', description: "1-sentence concise summary of modifications." },
							update_details: { type: 'string', description: "Detailed bullet points of modified fields and files." },
							update_conclusion: { type: 'string', description: "Evaluation comparing user request vs actual outcome." },
							commit: {
								type: 'object',
								description: "Explicit git commit info if code was committed during this task, or omitted/null if no commit was performed.",
								properties: {
									repo: { type: 'string' },
									branch: { type: 'string' },
									commit_id: { type: 'string' },
									comment: { type: 'string' },
									committed_by: { type: 'string' }
								}
							}
						},
						required: ['user_request', 'update_summary', 'update_details', 'update_conclusion']
					}
				},
				required: ['workspace_id', 'ticket_id', 'updates', 'worklog_record']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const ticketId = context.parameters?.ticket_id || '';
		return {
			invocationMessage: localize('ticket.tool.update.invoking', "Updating ticket {0}...", ticketId),
			pastTenseMessage: localize('ticket.tool.update.done', "Updated ticket {0}", ticketId)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const res = await this.ticketEngine.updateTicket(invocation.parameters as any);
			return toolResult(res, `Ticket '${res.ticket_id}' updated successfully.`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}

// -------------------------------------------------------------
// 5. anyagent_manage_links
// -------------------------------------------------------------
export class ManageLinksTool implements IToolImpl {

	constructor(
		private readonly ticketEngine: TicketDataEngine
	) { }

	getToolData(): IToolData {
		return {
			id: ManageLinksToolId,
			toolReferenceName: 'manageLinks',
			displayName: localize('ticket.tool.links.displayName', "Manage Ticket Links"),
			userDescription: localize('ticket.tool.links.userDescription', "Batch manage bi-directional links between tickets"),
			modelDescription: 'Batch manage bi-directional links between tickets. Supports 1-to-N, N-to-1, and N-to-M link/unlink operations, validates active status (non-REMOVED), atomically updates Link To / Linked By on both sides, and synchronizes the transaction worklog.md across all involved tickets.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.link,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "The root workspace ID (e.g. 'FNDJ1-0000')."
					},
					source_ticket_ids: {
						type: 'array',
						items: { type: 'string' },
						description: "List of source ticket IDs initiating or modifying the links (e.g. ['FNDJ1-0001'])."
					},
					action: {
						type: 'string',
						enum: ['add_links', 'remove_links', 'set_links'],
						description: "'add_links': append targets to existing links; 'remove_links': unlink specific targets; 'set_links': overwrite full Link To list."
					},
					target_ticket_ids: {
						type: 'array',
						items: { type: 'string' },
						description: "List of target ticket IDs to link/unlink (e.g. ['FNDJ1-0002', 'FNDJ1-0003'])."
					},
					worklog_record: {
						type: 'object',
						description: "Mandatory transaction execution log broadcasted to worklog.md of all involved tickets.",
						properties: {
							user_request: { type: 'string', description: "Polished, clear user requirement explaining why links are being modified." },
							update_summary: { type: 'string', description: "1-sentence concise summary of link additions/removals." },
							update_details: { type: 'string', description: "Detailed bullet points of source tickets, target tickets, and action performed." },
							update_conclusion: { type: 'string', description: "Evaluation confirming successful link synchronization across all parties." },
							commit: {
								type: 'object',
								description: "Explicit git commit info if code was committed during this task, or omitted/null if no commit was performed.",
								properties: {
									repo: { type: 'string' },
									branch: { type: 'string' },
									commit_id: { type: 'string' },
									comment: { type: 'string' },
									committed_by: { type: 'string' }
								}
							}
						},
						required: ['user_request', 'update_summary', 'update_details', 'update_conclusion']
					}
				},
				required: ['workspace_id', 'source_ticket_ids', 'action', 'target_ticket_ids', 'worklog_record']
			}
		};
	}

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation> {
		const action = context.parameters?.action || 'modify';
		return {
			invocationMessage: localize('ticket.tool.links.invoking', "Synchronizing bi-directional ticket links ({0})...", action),
			pastTenseMessage: localize('ticket.tool.links.done', "Synchronized bi-directional ticket links ({0})", action)
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		try {
			const res = await this.ticketEngine.manageLinks(invocation.parameters as any);
			return toolResult(res, `Bi-directional links updated: action '${res.action}' synchronized across ${res.synchronized_tickets_count} ticket(s).`);
		} catch (err: any) {
			return toolError(err.message || String(err));
		}
	}
}
