/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { ICustomModulesService } from '../../common/customModules.js';
import { IWorkspacesExplorerService } from '../../../workspacesExplorer/common/workspacesExplorer.js';
import { CustomFieldType, ICustomField, ICustomModule, IActionButton, IStatusDefinition, DEFAULT_STATUS_DEFINITIONS } from '../../../entityPersistence/common/entityPersistence.js';

export const ListCustomModulesToolId = 'anyagent_list_custom_modules';
export const GenerateCustomModuleToolId = 'anyagent_generate_custom_module';
export const ToggleCustomModuleStatusToolId = 'anyagent_toggle_custom_module_status';
export const DeleteCustomModuleToolId = 'anyagent_delete_custom_module';

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

const VALID_FIELD_TYPES: Set<CustomFieldType> = new Set([
	'text',
	'number',
	'textarea',
	'select',
	'multiselect',
	'switch',
	'date',
	'time',
	'datetime',
	'date_range',
	'time_range',
	'datetime_range',
	'dynamic_list',
	'attachment',
	'button_group',
	'button',
	'browser',
	'git',
	'parameters',
	'prompt',
	'result'
]);

const BASE_PRIMITIVES_CATALOG = [
	{
		type: 'parameters',
		label: 'Input Parameters (Runtime Variables)',
		description: 'Runtime input parameters and variables for tickets with optional choices. Interpolated via {{param_name}} in URLs and prompts.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'runtime_params',
			label: 'Input Parameters',
			type: 'parameters',
			parameters: [
				{ id: 'param_1', name: 'start', label: 'Start Offset', defaultValue: '0' },
				{ id: 'param_2', name: 'env', label: 'Environment', defaultValue: 'testing', options: ['testing', 'developing', 'production'] }
			]
		}
	},
	{
		type: 'prompt',
		label: 'AI Prompt (Model / Agent)',
		description: 'Instruction prompt input box primitive. Dispatches instructions and inputs to either a selected Large Language Model or an autonomous AI Agent to process information.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'analysis_prompt',
			label: 'AI Analysis Prompt',
			type: 'prompt',
			defaultContent: 'Please summarize the following ticket requirements and identify key risks.',
			targetMode: 'model',
			targetModel: 'gemini-1.5-flash',
			targetAgentId: ''
		}
	},
	{
		type: 'browser',
		label: 'Browser (Web Navigation & Data Extraction)',
		description: 'Embedded web browser primitive for navigating URLs, extracting web content/HTML for AI consumption, and managing credentials.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'web_browser',
			label: 'Browser',
			type: 'browser',
			defaultUrl: 'https://example.com',
			credentials: [
				{ id: 'cred_1', key: 'username', value: 'admin' },
				{ id: 'cred_2', key: 'password', value: 'secret' }
			]
		}
	},
	{
		type: 'git',
		label: 'Git Repository & Branch Binding',
		description: 'Git source control integration module for binding a repository URL, branch, and status verification.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'git_binding',
			label: 'Git Repository',
			type: 'git',
			gitRemoteUrl: 'git@github.com:org/repo.git',
			gitBranch: 'main'
		}
	},
	{
		type: 'result',
		label: 'Return / Result / Output',
		description: 'Captures, formats, and visualizes ticket pipeline execution results (Table, Markdown, JSON, Text) for inspection or inter-ticket reference.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'pipeline_result',
			label: 'Pipeline Result',
			type: 'result',
			defaultContent: ''
		}
	},
	{
		type: 'text',
		label: 'Single-line Input (Text)',
		description: 'Short strings, titles, codes, currency amounts as string, invoice numbers, person names.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'expense_title', label: 'Title / Subject', type: 'text' }
	},
	{
		type: 'number',
		label: 'Number Input (Numeric)',
		description: 'Numeric quantities, amounts, measurements, percentages, or rates. Supports custom unit (e.g. $, kg, %, hours) and defaults to 2 decimal places.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'budget_amount', label: 'Budget Amount', type: 'number', unit: '$', precision: 2 }
	},
	{
		type: 'textarea',
		label: 'Textarea (Multiline)',
		description: 'Long descriptions, justifications, remarks, multiline comments, reasoning.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'business_reason', label: 'Business Justification', type: 'textarea' }
	},
	{
		type: 'select',
		label: 'Dropdown (Select)',
		description: 'Single-choice dropdown menu. MUST supply options array of strings.',
		requiresOptions: true,
		supportsItemFields: false,
		example: { id: 'category', label: 'Expense Category', type: 'select', options: ['Travel', 'Meals & Entertainment', 'Office Supplies', 'Software Subscriptions', 'Other'] }
	},
	{
		type: 'multiselect',
		label: 'Checkboxes (Multiselect)',
		description: 'Multi-choice tags or checkboxes. MUST supply options array of strings.',
		requiresOptions: true,
		supportsItemFields: false,
		example: { id: 'tags', label: 'Compliance Tags', type: 'multiselect', options: ['Urgent', 'Over-Budget', 'Client-Rebillable', 'Receipt-Verified'] }
	},
	{
		type: 'switch',
		label: 'Switch (Toggle)',
		description: 'Boolean flag toggle (true/false).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'requires_cfo_approval', label: 'Requires CFO Sign-off', type: 'switch' }
	},
	{
		type: 'date',
		label: 'Single Date Picker',
		description: 'Calendar date selection (YYYY-MM-DD).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'expense_date', label: 'Expense Date', type: 'date' }
	},
	{
		type: 'time',
		label: 'Single Time Picker',
		description: 'Time selection (HH:MM).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'incident_time', label: 'Incident Time', type: 'time' }
	},
	{
		type: 'datetime',
		label: 'Single DateTime Picker',
		description: 'Combined date and time timestamp.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'submission_time', label: 'Submission Timestamp', type: 'datetime' }
	},
	{
		type: 'date_range',
		label: 'Date Range (Start ~ End)',
		description: 'Range of dates (e.g. travel period, event dates).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'travel_period', label: 'Travel Dates', type: 'date_range' }
	},
	{
		type: 'time_range',
		label: 'Time Range (Start ~ End)',
		description: 'Range of times (e.g. scheduled hours).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'working_hours', label: 'Shift Hours', type: 'time_range' }
	},
	{
		type: 'datetime_range',
		label: 'DateTime Range (Start ~ End)',
		description: 'Range of date and time timestamps.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'booking_window', label: 'Booking Window', type: 'datetime_range' }
	},
	{
		type: 'dynamic_list',
		label: 'Container (Nested Subfields / Repeating Items)',
		description: 'Nested repeatable line items or sub-table. Supports itemFields (array of sub-fields) or componentRef (reusable class ID).',
		requiresOptions: false,
		supportsItemFields: true,
		example: {
			id: 'expense_items',
			label: 'Expense Items',
			type: 'dynamic_list',
			itemFields: [
				{ id: 'item_name', label: 'Item Name', type: 'text' },
				{ id: 'item_date', label: 'Date', type: 'date' },
				{ id: 'item_amount', label: 'Amount ($)', type: 'text' },
				{ id: 'item_notes', label: 'Notes', type: 'textarea' }
			]
		}
	},
	{
		type: 'attachment',
		label: 'Attachment (Files / Images / PDF / Receipts)',
		description: 'File upload field for invoices, PDF documents, proof receipts, or images.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'receipt_files', label: 'Receipts & Invoices', type: 'attachment' }
	},
	{
		type: 'button_group',
		label: 'Action Buttons (Horizontal)',
		description: 'Horizontal row of action transition buttons. Each button can be customized with a label, theme color, and an optional target status transition.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'review_actions',
			label: 'Approval Actions',
			type: 'button_group',
			buttons: [
				{ id: 'btn_approve', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
				{ id: 'btn_reject', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
			]
		}
	}
];

async function resolveWorkspaceUri(workspacesExplorerService: IWorkspacesExplorerService, workspaceId?: string): Promise<URI | undefined> {
	try {
		const workspaces = await workspacesExplorerService.getWorkspaces();
		if (!workspaces || workspaces.length === 0) return undefined;

		const trimmedId = (workspaceId || '').trim();
		if (!trimmedId || trimmedId === 'current' || trimmedId === 'active' || trimmedId === 'default' || trimmedId === '/' || trimmedId === '.') {
			const current = workspaces.find(w => w.isCurrent) || workspaces[0];
			return current?.uri;
		}

		// Match by code or id or name
		for (const w of workspaces) {
			if (!w.code) {
				try {
					w.code = await workspacesExplorerService.resolveEntityCode(w.uri);
				} catch { }
			}
			if ((w.code && w.code.toLowerCase() === trimmedId.toLowerCase()) ||
				(w.id && w.id.toLowerCase() === trimmedId.toLowerCase()) ||
				(w.name && w.name.toLowerCase() === trimmedId.toLowerCase())) {
				return w.uri;
			}
		}

		const current = workspaces.find(w => w.isCurrent) || workspaces[0];
		return current?.uri;
	} catch {
		return undefined;
	}
}

// -------------------------------------------------------------
// 1. anyagent_list_custom_modules
// -------------------------------------------------------------
export class ListCustomModulesTool implements IToolImpl {

	constructor(
		private readonly customModulesService: ICustomModulesService,
		private readonly workspacesExplorerService: IWorkspacesExplorerService
	) { }

	getToolData(): IToolData {
		return {
			id: ListCustomModulesToolId,
			toolReferenceName: 'listCustomModules',
			displayName: localize('customModules.tool.list.displayName', "List Custom Modules & Component Library"),
			userDescription: localize('customModules.tool.list.userDescription', "List existing custom modules, base primitives, and reusable classes"),
			modelDescription: "List all existing Custom Modules, available Base Primitives (text, textarea, select, multiselect, switch, date, time, datetime, date_range, time_range, datetime_range, dynamic_list container, attachment, browser, git), and reusable composite component classes. Use this to discover available field building blocks before synthesizing a custom module schema.",
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.layout,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: "Optional workspace identifier or name to scope lookup."
					}
				}
			}
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const params = (invocation.parameters || {}) as { workspace_id?: string };
			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);

			const [modules, compositeComponents] = await Promise.all([
				this.customModulesService.getCustomModules(workspaceUri),
				this.customModulesService.getCompositeComponents(workspaceUri)
			]);

			const modulesSummary = modules.map(m => ({
				id: m.id,
				name: m.name,
				color: m.color,
				storageScope: m.storageScope || 'global',
				type_definition: m.description || '',
				type_prompt: m.prompt || '',
				field_count: m.fields?.length || 0,
				fields: m.fields || []
			}));

			const reusableClassesSummary = compositeComponents.map(c => ({
				id: c.id,
				name: c.name,
				description: c.description || '',
				itemFields: c.itemFields || []
			}));

			return toolResult({
				custom_modules: modulesSummary,
				base_primitives: BASE_PRIMITIVES_CATALOG,
				reusable_classes: reusableClassesSummary
			}, `Found ${modules.length} custom module(s), ${BASE_PRIMITIVES_CATALOG.length} base primitive types, and ${reusableClassesSummary.length} reusable class(es).`);
		} catch (err: any) {
			return toolError(`Failed to list custom modules: ${err.message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

// -------------------------------------------------------------
// 2. anyagent_generate_custom_module
// -------------------------------------------------------------
export interface IGenerateCustomModuleParameters {
	module_id: string;
	module_name: string;
	color?: string;
	type_definition: string;
	type_prompt: string;
	storage_scope?: 'global' | 'workspace';
	fields: Array<{
		id: string;
		label: string;
		type: CustomFieldType;
		options?: string[];
		itemFields?: ICustomField[];
		componentRef?: string;
		buttons?: IActionButton[];
		unit?: string;
		precision?: number;
		min?: number;
		max?: number;
		step?: number;
	}>;
	statuses?: IStatusDefinition[];
	workspace_id?: string;
	auto_open?: boolean;
}

export class GenerateCustomModuleTool implements IToolImpl {

	constructor(
		private readonly customModulesService: ICustomModulesService,
		private readonly workspacesExplorerService: IWorkspacesExplorerService
	) { }

	getToolData(): IToolData {
		return {
			id: GenerateCustomModuleToolId,
			toolReferenceName: 'generateCustomModule',
			displayName: localize('customModules.tool.generate.displayName', "Generate Custom Module"),
			userDescription: localize('customModules.tool.generate.userDescription', "Create or synthesize a custom module schema with Type Definition, Type Prompt, and fields"),
			modelDescription: "Synthesize and register a new Custom Module (entity type schema) or update an existing module in AnyAgent. Extracts Type Definition (business purpose) and Type Prompt (system instructions for AI processing tickets of this type) from user voice/text description, structures appropriate fields using Base Primitives and Reusable Classes, writes YAML definition, and opens Schema Designer for interactive visual review.",
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.extensions,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: "Unique kebab-case or snake-case identifier for the module (e.g. 'expense_reimbursement', 'reimbursement_approval', 'contract_review')."
					},
					module_name: {
						type: 'string',
						description: "Human-readable display name for the module (e.g. 'Expense Reimbursement', 'Leave Request', 'Purchase Order')."
					},
					color: {
						type: 'string',
						description: "Theme hex color code for this module badge (e.g. '#10b981' emerald/finance, '#3b82f6' blue/process, '#8b5cf6' purple/workflow, '#f59e0b' amber, '#ef4444' red). Defaults to '#10b981'."
					},
					type_definition: {
						type: 'string',
						description: "Business purpose and semantic definition of this entity type extracted from user description. Explains what this entity is, why it is used, and its role in business operations."
					},
					type_prompt: {
						type: 'string',
						description: "AI system instruction / prompt specifically guiding AI agents on how to process, audit, validate, calculate, and route tickets of this module type."
					},
					storage_scope: {
						type: 'string',
						enum: ['global', 'workspace'],
						description: "Storage scope: 'global' applies across all workspaces, 'workspace' stores within current workspace. Defaults to 'global'."
					},
					fields: {
						type: 'array',
						description: "Array of fields composing this entity type.",
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description: "Field identifier (e.g. 'total_amount', 'category', 'expense_items', 'receipts')."
								},
								label: {
									type: 'string',
									description: "Display label for the field (e.g. 'Total Amount', 'Expense Category', 'Line Items', 'Receipts')."
								},
								type: {
									type: 'string',
									enum: [
										'text',
										'number',
										'textarea',
										'select',
										'multiselect',
										'switch',
										'date',
										'time',
										'datetime',
										'date_range',
										'time_range',
										'datetime_range',
										'dynamic_list',
										'attachment',
										'button_group',
										'button',
										'browser',
										'git',
										'parameters',
										'prompt'
									],
									description: "Component type from Base Primitives catalog."
								},
								options: {
									type: 'array',
									items: { type: 'string' },
									description: "Options array for 'select' or 'multiselect' fields."
								},
								itemFields: {
									type: 'array',
									description: "Sub-fields array if type is 'dynamic_list' (nested sub-table / repeating items)."
								},
								componentRef: {
									type: 'string',
									description: "Optional ID of a reusable class if referencing a composite component."
								},
								unit: {
									type: 'string',
									description: "Optional unit or currency/measurement symbol for numeric fields (e.g. '$', 'kg', '%', 'hours', 'pts')."
								},
								precision: {
									type: 'number',
									description: "Decimal places precision for numeric fields. Defaults to 2 (e.g. 0.00)."
								},
								min: { type: 'number', description: "Minimum allowed value for numeric fields." },
								max: { type: 'number', description: "Maximum allowed value for numeric fields." },
								step: { type: 'number', description: "Stepping increment for numeric fields." },
								buttons: {
									type: 'array',
									description: "Array of action transition buttons if type is 'button_group'.",
									items: {
										type: 'object',
										properties: {
											id: { type: 'string', description: "Button identifier" },
											label: { type: 'string', description: "Button display label" },
											color: { type: 'string', description: "Hex color for button" },
											targetStatus: { type: 'string', description: "Target status stage to transition ticket to upon click" }
										},
										required: ['id', 'label']
									}
								}
							},
							required: ['id', 'label', 'type']
						}
					},
					statuses: {
						type: 'array',
						description: "Custom operational lifecycle statuses for tickets of this module type. If omitted, defaults to the 5 canonical stages (Todo, In Progress, Done, Blocked, Removed).",
						items: {
							type: 'object',
							properties: {
								id: { type: 'string', description: "Unique status stage identifier" },
								label: { type: 'string', description: "Status stage display name" },
								color: { type: 'string', description: "Hex color code for status stage badge" },
								category: {
									type: 'string',
									enum: ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'],
									description: "Canonical lifecycle bucket to map this custom status into"
								},
								description: { type: 'string', description: "Optional description of what this stage represents" }
							},
							required: ['id', 'label', 'color', 'category']
						}
					},
					workspace_id: {
						type: 'string',
						description: "Target workspace ID or name if scoping to a specific workspace."
					},
					auto_open: {
						type: 'boolean',
						description: "Whether to automatically open the visual Schema Designer editor in Workbench upon creation. Defaults to true."
					}
				},
				required: ['module_id', 'module_name', 'type_definition', 'type_prompt', 'fields']
			}
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const params = invocation.parameters as IGenerateCustomModuleParameters;
			if (!params || !params.module_id || !params.module_name) {
				return toolError("Missing required parameters: 'module_id' and 'module_name' must be provided.");
			}

			const rawId = params.module_id.trim();
			const cleanId = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
			if (!cleanId) {
				return toolError(`Invalid module_id '${params.module_id}'. Must contain valid letters or numbers.`);
			}

			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);

			// Clean and validate fields
			const rawFields = Array.isArray(params.fields) ? params.fields : [];
			const cleanedFields: ICustomField[] = [];

			for (let idx = 0; idx < rawFields.length; idx++) {
				const f = rawFields[idx];
				if (!f || !f.id || !f.label || !f.type) {
					continue;
				}
				const fieldType = f.type.toLowerCase().trim() as CustomFieldType;
				if (!VALID_FIELD_TYPES.has(fieldType)) {
					return toolError(`Field '${f.id}' has invalid type '${f.type}'. Allowed types: ${Array.from(VALID_FIELD_TYPES).join(', ')}`);
				}

				const fieldId = f.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
				const cleanField: ICustomField = {
					id: fieldId,
					label: f.label.trim(),
					type: fieldType
				};

				if (fieldType === 'select' || fieldType === 'multiselect') {
					if (Array.isArray(f.options) && f.options.length > 0) {
						cleanField.options = f.options.map(opt => String(opt).trim()).filter(Boolean);
					} else {
						// Supply sensible default options if omitted
						cleanField.options = ['Option 1', 'Option 2', 'Option 3'];
					}
				}

				if (fieldType === 'dynamic_list') {
					if (Array.isArray(f.itemFields) && f.itemFields.length > 0) {
						cleanField.itemFields = f.itemFields.map((sub: any, sIdx: number) => {
							const subType = (sub.type ? sub.type.toLowerCase().trim() : 'text') as CustomFieldType;
							const subClean: ICustomField = {
								id: (sub.id || `sub_${sIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
								label: (sub.label || `Item ${sIdx + 1}`).trim(),
								type: VALID_FIELD_TYPES.has(subType) ? subType : 'text'
							};
							if ((subType === 'select' || subType === 'multiselect') && Array.isArray(sub.options)) {
								subClean.options = sub.options.map((o: any) => String(o).trim()).filter(Boolean);
							}
							return subClean;
						});
					} else if (f.componentRef) {
						cleanField.componentRef = f.componentRef.trim();
					} else {
						// Default container subfields
						cleanField.itemFields = [
							{ id: 'item_name', label: 'Item Name', type: 'text' },
							{ id: 'description', label: 'Description', type: 'textarea' }
						];
					}
				}

				if (fieldType === 'button_group' || fieldType === 'button') {
					if (Array.isArray(f.buttons) && f.buttons.length > 0) {
						cleanField.buttons = f.buttons.map((b: any, bIdx: number) => ({
							id: (b.id || `btn_${bIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
							label: (b.label || `Action ${bIdx + 1}`).trim(),
							color: b.color && /^#[0-9a-fA-F]{3,8}$/.test(b.color.trim()) ? b.color.trim() : '#3b82f6',
							targetStatus: b.targetStatus ? String(b.targetStatus).trim() : undefined
						}));
					} else {
						cleanField.buttons = [
							{ id: 'btn_approve', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
							{ id: 'btn_reject', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
						];
					}
				}

				if (fieldType === 'number') {
					cleanField.unit = f.unit ? String(f.unit).trim() : undefined;
					cleanField.precision = typeof f.precision === 'number' ? f.precision : 2;
					if (typeof f.min === 'number') cleanField.min = f.min;
					if (typeof f.max === 'number') cleanField.max = f.max;
					if (typeof f.step === 'number') cleanField.step = f.step;
				}

				cleanedFields.push(cleanField);
			}

			// Enforce Title and Description as mandatory root fields at index 0 and 1
			const titleField: ICustomField = {
				id: 'title',
				label: 'Title',
				type: 'text',
				required: true
			};
			const descField: ICustomField = {
				id: 'description',
				label: 'Description',
				type: 'textarea',
				required: true
			};
			const finalFields: ICustomField[] = [
				titleField,
				descField,
				...cleanedFields.filter(f =>
					f.id.toLowerCase() !== 'title' &&
					f.label.toLowerCase() !== 'title' &&
					f.id.toLowerCase() !== 'description' &&
					f.label.toLowerCase() !== 'description'
				)
			];

			const color = params.color && /^#[0-9a-fA-F]{3,8}$/.test(params.color.trim())
				? params.color.trim()
				: '#10b981';

			let cleanedStatuses: IStatusDefinition[] | undefined;
			if (Array.isArray(params.statuses) && params.statuses.length > 0) {
				cleanedStatuses = params.statuses.map((st: any, sIdx: number) => {
					const cat = ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'].includes(st.category) ? st.category : 'Todo';
					return {
						id: (st.id || `status_${sIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
						label: (st.label || st.id || `Status ${sIdx + 1}`).trim(),
						color: st.color && /^#[0-9a-fA-F]{3,8}$/.test(st.color.trim()) ? st.color.trim() : '#818cf8',
						category: cat,
						description: st.description ? String(st.description).trim() : undefined
					};
				});
			} else {
				cleanedStatuses = DEFAULT_STATUS_DEFINITIONS.map(d => ({ ...d }));
			}

			const newModule: ICustomModule = {
				id: cleanId,
				name: params.module_name.trim(),
				color: color,
				storageScope: params.storage_scope === 'workspace' ? 'workspace' : 'global',
				description: (params.type_definition || '').trim(),
				prompt: (params.type_prompt || '').trim(),
				fields: finalFields,
				statuses: cleanedStatuses
			};

			// CRITICAL: getCustomModules first to prevent saveCustomModules from deleting other modules
			const existingModules = await this.customModulesService.getCustomModules(workspaceUri);
			const updatedModules: ICustomModule[] = [];
			let replaced = false;

			for (const mod of existingModules) {
				if (mod.id.toLowerCase() === cleanId.toLowerCase()) {
					updatedModules.push(newModule);
					replaced = true;
				} else {
					updatedModules.push(mod);
				}
			}
			if (!replaced) {
				updatedModules.push(newModule);
			}

			await this.customModulesService.saveCustomModules(updatedModules, workspaceUri);

			// Open Schema Designer editor if auto_open is not explicitly false
			let designerOpened = false;
			if (params.auto_open !== false) {
				try {
					await this.customModulesService.openSchemaDesigner({
						targetModuleId: cleanId,
						workspaceUri: workspaceUri
					});
					designerOpened = true;
				} catch (openErr) {
					console.warn('Failed to open Schema Designer automatically:', openErr);
				}
			}

			return toolResult({
				status: 'success',
				action: replaced ? 'updated' : 'created',
				module: {
					id: newModule.id,
					name: newModule.name,
					color: newModule.color,
					storageScope: newModule.storageScope,
					type_definition: newModule.description,
					type_prompt: newModule.prompt,
					fields_count: newModule.fields?.length || 0,
					fields: newModule.fields
				},
				designer_opened: designerOpened,
				total_custom_modules: updatedModules.length
			}, `Custom Module '${newModule.name}' (${newModule.id}) successfully ${replaced ? 'updated' : 'created'} with ${cleanedFields.length} field(s). Type Definition and Type Prompt are configured.`);
		} catch (err: any) {
			return toolError(`Failed to generate custom module: ${err.message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

// -------------------------------------------------------------
// 3. anyagent_toggle_custom_module_status
// -------------------------------------------------------------
export class ToggleCustomModuleStatusTool implements IToolImpl {

	constructor(
		private readonly customModulesService: ICustomModulesService,
		private readonly workspacesExplorerService: IWorkspacesExplorerService
	) { }

	getToolData(): IToolData {
		return {
			id: ToggleCustomModuleStatusToolId,
			toolReferenceName: 'toggleCustomModuleStatus',
			displayName: localize('customModules.tool.toggle.displayName', "Disable/Enable Custom Module"),
			userDescription: localize('customModules.tool.toggle.userDescription', "Disable (deactivate) or re-enable a custom module"),
			modelDescription: "Disable (deactivate) or re-enable a Custom Module in AnyAgent. When disabled, the module will be hidden from the new ticket type options. Existing tickets remain preserved.",
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.circleSlash,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: "The identifier of the custom module (e.g. 'expense_reimbursement')."
					},
					action: {
						type: 'string',
						enum: ['disable', 'enable'],
						description: "Action to perform: 'disable' (deactivate) or 'enable' (activate)."
					},
					workspace_id: {
						type: 'string',
						description: "Optional workspace identifier or name."
					}
				},
				required: ['module_id', 'action']
			}
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const params = (invocation.parameters || {}) as { module_id: string; action: 'disable' | 'enable'; workspace_id?: string };
			if (!params.module_id || !params.action) {
				return toolError("Missing required parameters: 'module_id' and 'action' ('disable' | 'enable') must be provided.");
			}

			const cleanId = params.module_id.trim().toLowerCase();
			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);
			const modules = await this.customModulesService.getCustomModules(workspaceUri);

			const targetMod = modules.find(m => m.id.toLowerCase() === cleanId);
			if (!targetMod) {
				return toolError(`Custom Module '${params.module_id}' was not found in workspace.`);
			}

			targetMod.isDeprecated = (params.action === 'disable');
			await this.customModulesService.saveCustomModules(modules, workspaceUri);

			return toolResult({
				status: 'success',
				module_id: targetMod.id,
				module_name: targetMod.name,
				is_deprecated: targetMod.isDeprecated,
				message: `Module '${targetMod.name}' is now ${targetMod.isDeprecated ? 'Disabled' : 'Active'}.`
			}, `Custom Module '${targetMod.name}' successfully ${targetMod.isDeprecated ? 'disabled' : 'enabled'}.`);
		} catch (err: any) {
			return toolError(`Failed to toggle custom module status: ${err.message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

// -------------------------------------------------------------
// 4. anyagent_delete_custom_module
// -------------------------------------------------------------
export class DeleteCustomModuleTool implements IToolImpl {

	constructor(
		private readonly customModulesService: ICustomModulesService,
		private readonly workspacesExplorerService: IWorkspacesExplorerService
	) { }

	getToolData(): IToolData {
		return {
			id: DeleteCustomModuleToolId,
			toolReferenceName: 'deleteCustomModule',
			displayName: localize('customModules.tool.delete.displayName', "Delete Custom Module"),
			userDescription: localize('customModules.tool.delete.userDescription', "Delete a custom module schema YAML file"),
			modelDescription: "Permanently delete a Custom Module definition from AnyAgent. This removes the schema YAML file. Existing tickets of this type will preserve their data.",
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.trash,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: "The identifier of the custom module to delete (e.g. 'expense_reimbursement')."
					},
					workspace_id: {
						type: 'string',
						description: "Optional workspace identifier or name."
					}
				},
				required: ['module_id']
			}
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const params = (invocation.parameters || {}) as { module_id: string; workspace_id?: string };
			if (!params.module_id) {
				return toolError("Missing required parameter: 'module_id' must be provided.");
			}

			const cleanId = params.module_id.trim();
			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);

			await this.customModulesService.deleteCustomModule(cleanId, workspaceUri);

			return toolResult({
				status: 'success',
				deleted_module_id: cleanId,
				message: `Custom module '${cleanId}' has been deleted.`
			}, `Custom Module '${cleanId}' was successfully deleted.`);
		} catch (err: any) {
			return toolError(`Failed to delete custom module: ${err.message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

