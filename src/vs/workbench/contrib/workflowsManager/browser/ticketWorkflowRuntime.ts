/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEntityPersistenceService, IBaseEntitySnapshot, ICustomField, ICustomModule, IOutputSpec } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { IAgentCredentialService } from '../../agentsManager/common/agentsManager.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';

export const ITicketWorkflowRuntimeService = createDecorator<ITicketWorkflowRuntimeService>('ticketWorkflowRuntimeService');

export interface ITicketCreateOptions {
	workspaceUri: string | URI;
	targetPath?: string;
	ticketType: string;
	title: string;
	description?: string;
	status?: string;
	priority?: string;
	parameters?: Record<string, any>;
	fieldValues?: Record<string, any>;
}

export interface ITicketCreateResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	ticketType: string;
	entityUri: string;
	targetFolder: string;
	fields: Record<string, any>;
	error?: string;
}

export interface ITicketGetResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	ticketType: string;
	entityUri: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	customMetadata: Record<string, string>;
	output?: any;
	schema?: ICustomModule;
	error?: string;
}

export interface ITicketRunOptions {
	workspaceUri: string | URI;
	ticketIdOrPath: string;
	inputParams?: Record<string, any>;
}

export interface IPrimitiveExecutionStepResult {
	fieldId: string;
	fieldLabel: string;
	fieldType: string;
	output?: any;
	status: 'success' | 'skipped' | 'failed';
	durationMs: number;
	error?: string;
}

export interface ITicketRunResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	ticketType: string;
	entityUri: string;
	status: 'success' | 'failed';
	output: any;
	stepResults: IPrimitiveExecutionStepResult[];
	contextVariables: Record<string, any>;
	durationMs: number;
	error?: string;
}

export interface IPrimitiveCatalogItem {
	type: string;
	label: string;
	icon: string;
	category: 'input' | 'processing' | 'output' | 'data' | 'composite';
	description: string;
	executionBehavior: string;
	supportedInputs?: string[];
	supportedOutputs?: string[];
}

export interface ITicketWorkflowRuntimeService {
	readonly _serviceBrand: undefined;

	createTickets(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	createTicket(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	CREATE_TICKETS(options: ITicketCreateOptions): Promise<ITicketCreateResult>;

	getTickets(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult>;
	getTicket(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult>;
	GET_TICKETS(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult>;

	runTickets(options: ITicketRunOptions): Promise<ITicketRunResult>;
	runTicket(options: ITicketRunOptions): Promise<ITicketRunResult>;
	RUN_TICKETS(options: ITicketRunOptions): Promise<ITicketRunResult>;

	getPrimitivesCatalog(workspaceUri?: string | URI): Promise<IPrimitiveCatalogItem[]>;
	GET_PRIMITIVES_CATALOG(workspaceUri?: string | URI): Promise<IPrimitiveCatalogItem[]>;
}


export class TicketWorkflowRuntime implements ITicketWorkflowRuntimeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService
	) { }

	/**
	 * 1. createTicket:
	 * Creates a new ticket entity in the workspace based on a schema (custom module or built-in).
	 */
	async createTicket(options: ITicketCreateOptions): Promise<ITicketCreateResult> {
		try {
			const wsUri = this._toUri(options.workspaceUri);
			const title = options.title?.trim() || 'New Ticket';
			const ticketType = options.ticketType?.trim() || 'task';

			// 1. Locate schema definition
			const allModules = await this.customModulesService.getCustomModules(wsUri);
			const matchedModule = allModules.find(m =>
				m.id.toLowerCase() === ticketType.toLowerCase() ||
				m.name.toLowerCase() === ticketType.toLowerCase()
			);

			// 2. Prepare target folder path
			const targetSubPath = (options.targetPath || '').trim().replace(/^\/+|\/+$/g, '');
			const safeFolderName = title.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `ticket-${Date.now()}`;
			const parentFolderUri = targetSubPath ? URI.joinPath(wsUri, targetSubPath) : wsUri;
			const ticketFolderUri = URI.joinPath(parentFolderUri, safeFolderName);

			// 3. Generate sequential ticket ID
			const existingSnapshots = this.entityPersistenceService.getAllSnapshots();
			const count = existingSnapshots.filter(s => s.entityType === ticketType).length + 1;
			const prefix = (matchedModule?.name || ticketType).substring(0, 4).toUpperCase();
			const ticketCode = `${prefix}-${String(count).padStart(4, '0')}`;

			// 4. Initialize field values and customMetadata
			const customMetadata: Record<string, string> = {};
			const initialFields = { ...(options.parameters || {}), ...(options.fieldValues || {}) };

			if (matchedModule?.fields && Array.isArray(matchedModule.fields)) {
				for (const f of matchedModule.fields) {
					const fKey = f.label || f.id;
					if (f.type === 'parameters' && f.parameters) {
						const paramObj: Record<string, any> = {};
						for (const p of f.parameters) {
							const pKey = p.name || p.id;
							const pVal = initialFields[pKey] !== undefined ? initialFields[pKey] : (p.label && initialFields[p.label] !== undefined ? initialFields[p.label] : (p.defaultValue !== undefined ? p.defaultValue : ''));
							paramObj[pKey] = pVal;
						}
						customMetadata[fKey] = JSON.stringify(paramObj);
					} else if (f.type === 'browser') {
						const urlVal = initialFields[fKey] || f.defaultUrl || '';
						customMetadata[fKey] = String(urlVal);
					} else if (f.type === 'prompt') {
						const promptVal = initialFields[fKey] || f.defaultContent || '';
						customMetadata[fKey] = String(promptVal);
					} else if (initialFields[fKey] !== undefined) {
						customMetadata[fKey] = typeof initialFields[fKey] === 'object' ? JSON.stringify(initialFields[fKey]) : String(initialFields[fKey]);
					} else if (initialFields[f.id] !== undefined) {
						customMetadata[fKey] = typeof initialFields[f.id] === 'object' ? JSON.stringify(initialFields[f.id]) : String(initialFields[f.id]);
					}
				}
			}

			// Apply any additional passed-in custom fields (exclude parameter names that belong to parameters primitives)
			const knownParamNames = new Set<string>();
			if (matchedModule?.fields) {
				for (const f of matchedModule.fields) {
					if (f.type === 'parameters' && Array.isArray(f.parameters)) {
						for (const p of f.parameters) {
							if (p.name) knownParamNames.add(p.name);
							if (p.id) knownParamNames.add(p.id);
							if (p.label) knownParamNames.add(p.label);
						}
					}
				}
			}

			for (const [k, v] of Object.entries(initialFields)) {
				if (customMetadata[k] === undefined && !knownParamNames.has(k)) {
					customMetadata[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
				}
			}

			// 5. Persist entity files via entityPersistenceService
			const snapshot: IBaseEntitySnapshot = {
				entityUri: ticketFolderUri.toString(),
				entityName: safeFolderName,
				title: title,
				ticketId: ticketCode,
				entityCode: ticketCode,
				entityType: ticketType,
				status: options.status || (matchedModule?.statuses?.[0]?.label) || 'Todo',
				priority: options.priority || 'Medium',
				description: options.description || `${matchedModule?.name || ticketType}: ${title}`,
				belongsToWorkspaceUri: wsUri.toString(),
				typeDefinition: matchedModule ? `.agents/entity_type/${matchedModule.id}.yaml` : undefined,
				typePrompt: matchedModule?.prompt,
				customMetadata: customMetadata
			};

			await this.entityPersistenceService.writeEntity4MDFiles(snapshot, parentFolderUri, true);

			this.logService.info(`[TicketWorkflowRuntime] Created ticket '${ticketCode}' (${title}) at ${ticketFolderUri.fsPath}`);

			return {
				success: true,
				ticketId: ticketCode,
				ticketName: safeFolderName,
				ticketType: ticketType,
				entityUri: ticketFolderUri.toString(),
				targetFolder: ticketFolderUri.fsPath,
				fields: customMetadata
			};
		} catch (err: any) {
			this.logService.error(`[TicketWorkflowRuntime] Failed to create ticket:`, err);
			return {
				success: false,
				ticketId: '',
				ticketName: '',
				ticketType: options.ticketType,
				entityUri: '',
				targetFolder: '',
				fields: {},
				error: err.message || String(err)
			};
		}
	}

	/**
	 * 2. getTicket:
	 * Fetches detailed ticket data, custom metadata, and execution outputs by ticketId, name, or path.
	 */
	async getTicket(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult> {
		try {
			const wsUri = this._toUri(workspaceUri);
			const needle = ticketIdOrPath.trim().toLowerCase();

			// 1. Search in cached snapshots first
			const allSnapshots = this.entityPersistenceService.getAllSnapshots();
			let matched = allSnapshots.find(s =>
				s.ticketId?.toLowerCase() === needle ||
				s.entityName.toLowerCase() === needle ||
				s.title?.toLowerCase() === needle ||
				s.entityUri.toLowerCase() === needle ||
				s.entityUri.toLowerCase().endsWith('/' + needle)
			);

			// 2. If not found in snapshot cache, try scanning folder path directly
			let ticketUri: URI | undefined = matched ? URI.parse(matched.entityUri) : undefined;
			if (!ticketUri) {
				const candidateUri = URI.joinPath(wsUri, ticketIdOrPath.trim());
				if (await this.fileService.exists(candidateUri)) {
					ticketUri = candidateUri;
				}
			}

			if (!ticketUri) {
				return {
					success: false,
					ticketId: ticketIdOrPath,
					ticketName: '',
					ticketType: '',
					entityUri: '',
					title: '',
					description: '',
					status: '',
					priority: '',
					customMetadata: {},
					error: `Ticket '${ticketIdOrPath}' not found in workspace '${wsUri.fsPath}'.`
				};
			}

			// Read ticket files
			const ticketData = await this._readTicketFiles(ticketUri, matched);

			// Load schema definition
			let schema: ICustomModule | undefined;
			if (ticketData.ticketType) {
				const modules = await this.customModulesService.getCustomModules(wsUri);
				schema = modules.find(m => m.id.toLowerCase() === ticketData.ticketType.toLowerCase());
			}

			return {
				success: true,
				ticketId: ticketData.ticketId,
				ticketName: ticketData.entityName,
				ticketType: ticketData.ticketType,
				entityUri: ticketUri.toString(),
				title: ticketData.title,
				description: ticketData.description,
				status: ticketData.status,
				priority: ticketData.priority,
				customMetadata: ticketData.customMetadata,
				output: ticketData.customMetadata['Output'] || ticketData.customMetadata['output'] || ticketData.customMetadata['Result'] || ticketData.customMetadata['result'],
				schema: schema
			};
		} catch (err: any) {
			return {
				success: false,
				ticketId: ticketIdOrPath,
				ticketName: '',
				ticketType: '',
				entityUri: '',
				title: '',
				description: '',
				status: '',
				priority: '',
				customMetadata: {},
				error: err.message || String(err)
			};
		}
	}

	/**
	 * 3. runTicket:
	 * Sequentially executes each primitive on a ticket schema from top to bottom.
	 * Resolves parameters, performs browser extractions, executes AI prompts, formats outputs, and returns result.
	 */
	async runTicket(options: ITicketRunOptions): Promise<ITicketRunResult> {
		const startTime = Date.now();
		const stepResults: IPrimitiveExecutionStepResult[] = [];
		const contextVariables: Record<string, any> = {};

		try {
			const ticketResult = await this.getTicket(options.workspaceUri, options.ticketIdOrPath);
			if (!ticketResult.success) {
				throw new Error(ticketResult.error || `Unable to locate ticket '${options.ticketIdOrPath}'`);
			}

			const wsUri = this._toUri(options.workspaceUri);
			const ticketUri = URI.parse(ticketResult.entityUri);
			const schema = ticketResult.schema;
			const customMetadata = { ...ticketResult.customMetadata };
			const inputOverrides = options.inputParams || {};

			// Pre-populate context variables with initial ticket metadata
			contextVariables['title'] = ticketResult.title;
			contextVariables['description'] = ticketResult.description;
			contextVariables['ticketId'] = ticketResult.ticketId;
			contextVariables['ticketName'] = ticketResult.ticketName;
			contextVariables['status'] = ticketResult.status;

			// Add customMetadata entries into context
			for (const [k, v] of Object.entries(customMetadata)) {
				contextVariables[k] = v;
				contextVariables[this._cleanKey(k)] = v;
			}

			// Add input overrides into context
			for (const [k, v] of Object.entries(inputOverrides)) {
				contextVariables[k] = v;
				contextVariables[this._cleanKey(k)] = v;
			}

			// Determine execution sequence from schema fields, or fallback to known metadata keys
			const fieldsToRun: ICustomField[] = (schema?.fields && Array.isArray(schema.fields) && schema.fields.length > 0)
				? schema.fields
				: this._synthesizeFieldsFromMetadata(customMetadata);

			this.logService.info(`[TicketWorkflowRuntime] Running ticket '${ticketResult.ticketId}' with ${fieldsToRun.length} primitive(s)...`);

			let finalOutput: any = undefined;

			// Step-by-step sequential primitive execution
			for (const field of fieldsToRun) {
				const stepStart = Date.now();
				const fieldLabel = field.label || field.id;
				const fieldType = field.type;

				// Skip mandatory root fields that require no execution
				if (field.id === 'title' || field.id === 'description') {
					continue;
				}

				try {
					let stepOutput: any = undefined;

					switch (fieldType) {
						case 'parameters': {
							// 1. Parameters Primitive: resolve runtime arguments and defaults
							const resolvedParams: Record<string, any> = {};
							if (field.parameters && Array.isArray(field.parameters)) {
								for (const p of field.parameters) {
									const pKey = p.name || p.id;
									const val = inputOverrides[pKey] !== undefined
										? inputOverrides[pKey]
										: (inputOverrides[p.label || ''] !== undefined
											? inputOverrides[p.label || '']
											: (contextVariables[pKey] !== undefined
												? contextVariables[pKey]
												: (p.defaultValue || '')));
									resolvedParams[pKey] = val;
									contextVariables[pKey] = val;
									if (p.label) {
										contextVariables[p.label] = val;
									}
									customMetadata[pKey] = String(val);
								}
							}
							stepOutput = resolvedParams;
							contextVariables[fieldLabel] = resolvedParams;
							contextVariables[this._cleanKey(fieldLabel)] = resolvedParams;
							break;
						}

						case 'browser': {
							// 2. Browser Primitive: interpolate URL template and fetch web content
							const rawUrl = inputOverrides[fieldLabel] || customMetadata[fieldLabel] || field.defaultUrl || '';
							const interpolatedUrl = this._interpolateVariables(rawUrl, contextVariables);

							if (interpolatedUrl && /^https?:\/\//i.test(interpolatedUrl.trim())) {
								this.logService.info(`[TicketWorkflowRuntime] Fetching web content from: ${interpolatedUrl}`);
								const extracted = await this._extractWebContent(interpolatedUrl, field.credentials);
								stepOutput = extracted.content;
								customMetadata[fieldLabel] = extracted.content;
								customMetadata[`${fieldLabel}_url`] = interpolatedUrl;
								contextVariables[fieldLabel] = extracted.content;
								contextVariables[this._cleanKey(fieldLabel)] = extracted.content;
								contextVariables[`${this._cleanKey(fieldLabel)}_url`] = interpolatedUrl;
							} else {
								stepOutput = `[Browser: Skipped - Invalid or empty URL: '${rawUrl}']`;
								contextVariables[fieldLabel] = stepOutput;
							}
							break;
						}

						case 'prompt': {
							// 3. AI Prompt Primitive: interpolate template with variables and call LLM
							const rawPrompt = customMetadata[fieldLabel] || field.defaultContent || '';
							const interpolatedPrompt = this._interpolateVariables(rawPrompt, contextVariables);
							const modelId = field.targetModel || 'gemini-1.5-flash';

							this.logService.info(`[TicketWorkflowRuntime] Executing AI Prompt with model '${modelId}'...`);
							const aiResponse = await this._executePrompt(modelId, interpolatedPrompt);

							stepOutput = aiResponse;
							customMetadata[fieldLabel] = aiResponse;
							contextVariables[fieldLabel] = aiResponse;
							contextVariables[this._cleanKey(fieldLabel)] = aiResponse;
							break;
						}

						case 'output':
						case 'result': {
							// 4. Output Manifest Primitive: aggregate enabled primitive outputs
							const aggregatedMap: Record<string, any> = {};
							const specs: IOutputSpec[] = field.outputSpecs || [];
							const enabledSpecs = specs.filter(s => s.enabled);

							if (enabledSpecs.length > 0) {
								for (const spec of enabledSpecs) {
									const specKey = spec.label || spec.fieldKey;
									const rawVal = contextVariables[specKey] ?? contextVariables[spec.fieldKey] ?? contextVariables[this._cleanKey(specKey)];
									aggregatedMap[specKey] = this._formatOutputValue(rawVal, spec.defaultFormat || 'table');
								}
								stepOutput = aggregatedMap;
								finalOutput = aggregatedMap;
							} else {
								// Fallback: take latest significant output from context
								stepOutput = contextVariables['prompt'] || contextVariables['AI Prompt 1'] || contextVariables['browser'] || contextVariables['Browser 1'] || 'Processed successfully';
								finalOutput = stepOutput;
							}

							customMetadata[fieldLabel] = typeof stepOutput === 'object' ? JSON.stringify(stepOutput, null, 2) : String(stepOutput);
							contextVariables[fieldLabel] = stepOutput;
							contextVariables['output'] = stepOutput;
							break;
						}

						default: {
							// 5. Standard field (text, number, select, date, classes, etc.)
							const currentVal = inputOverrides[fieldLabel] !== undefined
								? inputOverrides[fieldLabel]
								: (customMetadata[fieldLabel] !== undefined ? customMetadata[fieldLabel] : (field.defaultContent || ''));
							stepOutput = currentVal;
							contextVariables[fieldLabel] = currentVal;
							contextVariables[this._cleanKey(fieldLabel)] = currentVal;
							break;
						}
					}

					stepResults.push({
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						output: stepOutput,
						status: 'success',
						durationMs: Date.now() - stepStart
					});
				} catch (stepErr: any) {
					this.logService.error(`[TicketWorkflowRuntime] Step '${fieldLabel}' failed:`, stepErr);
					stepResults.push({
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						status: 'failed',
						error: stepErr.message || String(stepErr),
						durationMs: Date.now() - stepStart
					});
				}
			}

			// If no explicit output primitive was present, fallback to the last step's output
			if (finalOutput === undefined) {
				const lastSuccessful = [...stepResults].reverse().find(s => s.status === 'success' && s.output !== undefined);
				finalOutput = lastSuccessful ? lastSuccessful.output : 'Ticket completed without explicit output.';
			}

			// Save updated ticket metadata and append worklog entry
			await this._persistExecutionState(ticketUri, ticketResult, customMetadata, finalOutput);

			const totalDuration = Date.now() - startTime;
			this.logService.info(`[TicketWorkflowRuntime] Finished running ticket '${ticketResult.ticketId}' in ${totalDuration}ms`);

			return {
				success: true,
				ticketId: ticketResult.ticketId,
				ticketName: ticketResult.ticketName,
				ticketType: ticketResult.ticketType,
				entityUri: ticketResult.entityUri,
				status: 'success',
				output: finalOutput,
				stepResults: stepResults,
				contextVariables: contextVariables,
				durationMs: totalDuration
			};
		} catch (err: any) {
			this.logService.error(`[TicketWorkflowRuntime] Execution failed:`, err);
			return {
				success: false,
				ticketId: options.ticketIdOrPath,
				ticketName: '',
				ticketType: '',
				entityUri: '',
				status: 'failed',
				output: undefined,
				stepResults: stepResults,
				contextVariables: contextVariables,
				durationMs: Date.now() - startTime,
				error: err.message || String(err)
			};
		}
	}

	/**
	 * 4. getPrimitivesCatalog:
	 * Returns full catalog of Base Primitives and Reusable Classes with execution capabilities.
	 */
	async getPrimitivesCatalog(workspaceUri?: string | URI): Promise<IPrimitiveCatalogItem[]> {
		const baseCatalog: IPrimitiveCatalogItem[] = [
			{
				type: 'parameters',
				label: 'Input Parameters (Runtime Variables)',
				icon: 'symbol-parameter',
				category: 'input',
				description: 'Defines runtime input parameters and default values accessible by subsequent primitives via variable interpolation.',
				executionBehavior: 'Evaluates passed arguments, matches default values, and registers values into execution context variables.',
				supportedInputs: ['runtime arguments', 'workflow context variables'],
				supportedOutputs: ['dictionary of resolved parameter values']
			},
			{
				type: 'prompt',
				label: 'AI Prompt (Model / Agent)',
				icon: 'sparkle',
				category: 'processing',
				description: 'Configures prompt templates dispatched to Large Language Models (Gemini, GPT-4o, Claude) or Autonomous Agents.',
				executionBehavior: 'Interpolates {{variables}}, calls LLM inference API synchronously, captures generated text, and records telemetry.',
				supportedInputs: ['prompt template', 'interpolated variables', 'target model/agent'],
				supportedOutputs: ['model response text', 'token telemetry']
			},
			{
				type: 'browser',
				label: 'Browser (Web Navigation & Data)',
				icon: 'globe',
				category: 'processing',
				description: 'Automated web navigation and readable content extraction with optional credential authentication.',
				executionBehavior: 'Interpolates target URL, performs headless extraction or fetch, strips noise, and exposes readable text to prompt.',
				supportedInputs: ['URL template', 'credentials'],
				supportedOutputs: ['extracted markdown text', 'page title', 'metadata']
			},
			{
				type: 'git',
				label: 'Git Repository & Branch Binding',
				icon: 'source-control',
				category: 'data',
				description: 'Binds ticket to specific git repository URL and active branch for contextual workspace operations.',
				executionBehavior: 'Verifies remote URL, checkout branch, and provides git context metadata to workflow.',
				supportedInputs: ['git remote URL', 'branch name'],
				supportedOutputs: ['commit hash', 'branch status']
			},
			{
				type: 'output',
				label: 'Output',
				icon: 'output',
				category: 'output',
				description: 'Central Output Manifest & Export Selection specifying which primitive values to expose for inspection or downstream workflows.',
				executionBehavior: 'Collects outputs of enabled primitives, formats as Table/Markdown/JSON/Text, writes to ticket storage, and returns final payload.',
				supportedInputs: ['output specs', 'format selections'],
				supportedOutputs: ['aggregated output object', 'formatted CSV/Markdown']
			},
			{
				type: 'text',
				label: 'Single-line Input (Text)',
				icon: 'symbol-string',
				category: 'input',
				description: 'Single-line text input string.',
				executionBehavior: 'Stores text value in variable context.',
				supportedOutputs: ['string']
			},
			{
				type: 'textarea',
				label: 'Textarea (Multiline)',
				icon: 'list-flat',
				category: 'input',
				description: 'Multiline text content such as descriptions or markdown documents.',
				executionBehavior: 'Stores multiline text in variable context.',
				supportedOutputs: ['multiline string']
			},
			{
				type: 'number',
				label: 'Number Input (Numeric)',
				icon: 'symbol-number',
				category: 'input',
				description: 'Floating point or integer numbers with configurable precision and unit.',
				executionBehavior: 'Stores numerical value in context, supporting arithmetic expressions in workflows.',
				supportedOutputs: ['number']
			},
			{
				type: 'select',
				label: 'Dropdown (Select)',
				icon: 'chevron-down',
				category: 'input',
				description: 'Single option selection from a predefined choice list.',
				executionBehavior: 'Resolves selected option and exposes string value.',
				supportedOutputs: ['selected string']
			},
			{
				type: 'multiselect',
				label: 'Checkboxes (Multiselect)',
				icon: 'checklist',
				category: 'input',
				description: 'Multiple tag or item selection.',
				executionBehavior: 'Resolves selected items into an array of strings.',
				supportedOutputs: ['array of strings']
			},
			{
				type: 'switch',
				label: 'Switch (Toggle)',
				icon: 'circle-filled',
				category: 'input',
				description: 'Boolean true/false flag.',
				executionBehavior: 'Exposes boolean value for condition nodes in workflow.',
				supportedOutputs: ['boolean']
			},
			{
				type: 'date',
				label: 'Single Date Picker',
				icon: 'calendar',
				category: 'input',
				description: 'ISO 8601 calendar date.',
				executionBehavior: 'Exposes formatted date string (YYYY-MM-DD).',
				supportedOutputs: ['date string']
			},
			{
				type: 'time',
				label: 'Single Time Picker',
				icon: 'watch',
				category: 'input',
				description: '24-hour time picker.',
				executionBehavior: 'Exposes formatted time string (HH:mm).',
				supportedOutputs: ['time string']
			},
			{
				type: 'datetime',
				label: 'Single DateTime Picker',
				icon: 'history',
				category: 'input',
				description: 'Combined timestamp picker.',
				executionBehavior: 'Exposes ISO timestamp string.',
				supportedOutputs: ['ISO timestamp']
			},
			{
				type: 'date_range',
				label: 'Date Range (Start ~ End)',
				icon: 'calendar',
				category: 'input',
				description: 'Start and end date boundaries.',
				executionBehavior: 'Exposes date range tuple.',
				supportedOutputs: ['start date', 'end date']
			},
			{
				type: 'time_range',
				label: 'Time Range (Start ~ End)',
				icon: 'watch',
				category: 'input',
				description: 'Time interval window.',
				executionBehavior: 'Exposes time interval pair.',
				supportedOutputs: ['start time', 'end time']
			},
			{
				type: 'datetime_range',
				label: 'DateTime Range (Start ~ End)',
				icon: 'history',
				category: 'input',
				description: 'Full timestamp interval span.',
				executionBehavior: 'Exposes datetime range tuple.',
				supportedOutputs: ['start datetime', 'end datetime']
			},
			{
				type: 'dynamic_list',
				label: 'Container (Nested Subfields)',
				icon: 'layers',
				category: 'data',
				description: 'Dynamic repeating rows of nested subfields (e.g. table entries, itemized lines).',
				executionBehavior: 'Parses tabular or row items into an array of structured JSON objects.',
				supportedOutputs: ['array of objects']
			},
			{
				type: 'attachment',
				label: 'Attachment (Files Upload)',
				icon: 'paperclip',
				category: 'data',
				description: 'Attached files, PDFs, images, or documents.',
				executionBehavior: 'Provides file paths and URIs for downstream agent processing.',
				supportedOutputs: ['array of file paths']
			}
		];

		// Include Reusable Classes (Composite Components) if available
		try {
			const wsUri = workspaceUri ? this._toUri(workspaceUri) : undefined;
			const classes = await this.customModulesService.getCompositeComponents(wsUri);
			for (const c of classes) {
				baseCatalog.push({
					type: `class_${c.id}`,
					label: c.name,
					icon: 'extensions',
					category: 'composite',
					description: `Reusable Class component: encapsulates ${c.fields?.length || 0} subfields.`,
					executionBehavior: 'Resolves all encapsulated subfields and exposes them as a nested object namespace.',
					supportedOutputs: ['object with subfield properties']
				});
			}
		} catch {
			// ignore class lookup errors
		}

		return baseCatalog;
	}

	async createTickets(options: ITicketCreateOptions): Promise<ITicketCreateResult> {
		return this.createTicket(options);
	}

	async CREATE_TICKETS(options: ITicketCreateOptions): Promise<ITicketCreateResult> {
		return this.createTicket(options);
	}

	async getTickets(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult> {
		return this.getTicket(workspaceUri, ticketIdOrPath);
	}

	async GET_TICKETS(workspaceUri: string | URI, ticketIdOrPath: string): Promise<ITicketGetResult> {
		return this.getTicket(workspaceUri, ticketIdOrPath);
	}

	async runTickets(options: ITicketRunOptions): Promise<ITicketRunResult> {
		return this.runTicket(options);
	}

	async RUN_TICKETS(options: ITicketRunOptions): Promise<ITicketRunResult> {
		return this.runTicket(options);
	}

	async GET_PRIMITIVES_CATALOG(workspaceUri?: string | URI): Promise<IPrimitiveCatalogItem[]> {
		return this.getPrimitivesCatalog(workspaceUri);
	}

	// -------------------------------------------------------------
	// Private Helper Functions
	// -------------------------------------------------------------


	private _toUri(u: string | URI): URI {
		if (typeof u === 'string') {
			return u.startsWith('file://') ? URI.parse(u) : URI.file(u);
		}
		return u;
	}

	private _cleanKey(k: string): string {
		return k.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
	}

	private _interpolateVariables(text: string, context: Record<string, any>): string {
		if (!text) return '';
		// Supports both {{var}} and {var}, as well as dot-notation: {ticketId.Field Label}
		return text.replace(/\{\{?([a-zA-Z0-9_.\-\s]+)\}?\}/g, (match, rawKey) => {
			const trimmedKey = rawKey.trim();
			// 1. Direct match
			if (context[trimmedKey] !== undefined) {
				return typeof context[trimmedKey] === 'object' ? JSON.stringify(context[trimmedKey]) : String(context[trimmedKey]);
			}
			// 2. Cleaned key match
			const clean = this._cleanKey(trimmedKey);
			if (context[clean] !== undefined) {
				return typeof context[clean] === 'object' ? JSON.stringify(context[clean]) : String(context[clean]);
			}
			// 3. Dot-notation match (e.g. "output.Browser 1" or "FNDJ1-0008.AI Prompt 1")
			if (trimmedKey.includes('.')) {
				const parts = trimmedKey.split('.');
				const root = parts[0].trim();
				const sub = parts.slice(1).join('.').trim();
				const rootObj = context[root] ?? context[this._cleanKey(root)];
				if (rootObj && typeof rootObj === 'object') {
					const subVal = rootObj[sub] ?? rootObj[this._cleanKey(sub)];
					if (subVal !== undefined) {
						return typeof subVal === 'object' ? JSON.stringify(subVal) : String(subVal);
					}
				}
				if (context[sub] !== undefined) {
					return typeof context[sub] === 'object' ? JSON.stringify(context[sub]) : String(context[sub]);
				}
			}
			return match;
		});
	}

	private async _extractWebContent(targetUrl: string, credentials?: Array<{ key: string; value: string }>): Promise<{ title: string; content: string }> {
		// 1. Try IWebContentExtractorService first
		try {
			const extractorService = this.instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IWebContentExtractorService); } catch { return undefined; }
			});
			if (extractorService) {
				const uri = URI.parse(targetUrl);
				const results: WebContentExtractResult[] = await Promise.race([
					extractorService.extract([uri], { followRedirects: true, bypassCache: true }),
					new Promise<WebContentExtractResult[]>((_, reject) => setTimeout(() => reject(new Error('Extraction timed out')), 20000))
				]);
				if (results && results.length > 0 && results[0].status === 'ok') {
					const r = results[0];
					return {
						title: r.title || targetUrl,
						content: r.result || ''
					};
				}
			}
		} catch (e) {
			this.logService.warn(`[TicketWorkflowRuntime] IWebContentExtractorService failed, falling back to HTTP fetch:`, e);
		}

		// 2. Fallback HTTP fetch
		try {
			const headers: Record<string, string> = {
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			};
			if (credentials && credentials.length > 0) {
				for (const cred of credentials) {
					if (cred.key && cred.value) {
						headers[cred.key] = cred.value;
					}
				}
			}

			const resp = await fetch(targetUrl, { headers });
			if (!resp.ok) {
				return { title: targetUrl, content: `HTTP Error: ${resp.status} ${resp.statusText}` };
			}
			const html = await resp.text();
			const cleanText = html
				.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
				.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();

			return {
				title: targetUrl,
				content: cleanText.substring(0, 50000)
			};
		} catch (err: any) {
			return {
				title: targetUrl,
				content: `[Fetch Failed: ${err.message || String(err)}]`
			};
		}
	}

	private async _executePrompt(modelId: string, promptText: string): Promise<string> {
		try {
			const credService = this.instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (credService && credService.executePrompt) {
				const res = await credService.executePrompt(modelId, promptText);
				if (res.success && res.text) {
					return res.text;
				} else if (res.error) {
					this.logService.warn(`[TicketWorkflowRuntime] AI Prompt execution warning: ${res.error}`);
					return `[AI Generation Notice: ${res.error}]`;
				}
			}
		} catch (e: any) {
			this.logService.warn(`[TicketWorkflowRuntime] IAgentCredentialService error:`, e);
		}

		return `[AI Response (${modelId}) for: ${promptText.substring(0, 80)}...]`;
	}

	private _formatOutputValue(rawVal: any, format: string): any {
		if (rawVal === undefined || rawVal === null) return '';
		const str = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal, null, 2);
		switch (format) {
			case 'json':
				try { return JSON.parse(str); } catch { return { raw: str }; }
			case 'markdown':
			case 'table':
			case 'text':
			default:
				return str;
		}
	}

	private async _readTicketFiles(ticketUri: URI, snapshot?: IBaseEntitySnapshot): Promise<{
		ticketId: string;
		entityName: string;
		ticketType: string;
		title: string;
		description: string;
		status: string;
		priority: string;
		customMetadata: Record<string, string>;
	}> {
		const customMetadata: Record<string, string> = { ...(snapshot?.customMetadata || {}) };
		let title = snapshot?.title || snapshot?.entityName || 'Untitled';
		let description = snapshot?.description || '';
		let status = snapshot?.status || 'Todo';
		let priority = snapshot?.priority || 'Medium';
		let ticketId = snapshot?.ticketId || snapshot?.entityCode || '';
		let ticketType = snapshot?.entityType || 'task';

		// Read .agents/ticket.md or ticket.md if it exists
		const candidateTicketMd = [
			URI.joinPath(ticketUri, '.agents', 'ticket.md'),
			URI.joinPath(ticketUri, 'ticket.md')
		];

		for (const uri of candidateTicketMd) {
			if (await this.fileService.exists(uri)) {
				try {
					const content = (await this.fileService.readFile(uri)).value.toString();
					let inSelfDefined = false;
					for (const line of content.split(/\r?\n/)) {
						if (line.startsWith('### Self Defined Data')) {
							inSelfDefined = true;
							continue;
						}
						if (line.startsWith('### ') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
							inSelfDefined = false;
						}
						const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
						if (match) {
							const key = match[1].trim();
							const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
							if (inSelfDefined && line.startsWith('  -')) {
								customMetadata[key] = val;
							} else if (key === 'Ticket ID') {
								if (!ticketId) ticketId = val;
							} else if (key === 'Ticket Type') {
								if (!ticketType) ticketType = val;
							} else if (key === 'Status') {
								status = val;
							} else if (key === 'Priority') {
								priority = val;
							}
						}
					}
				} catch {
					// ignore
				}
				break;
			}
		}

		// Read README.md if title / desc still empty
		const candidateReadme = [
			URI.joinPath(ticketUri, '.agents', 'README.md'),
			URI.joinPath(ticketUri, 'README.md')
		];
		for (const uri of candidateReadme) {
			if (await this.fileService.exists(uri)) {
				try {
					const content = (await this.fileService.readFile(uri)).value.toString();
					for (const line of content.split(/\r?\n/)) {
						const tMatch = line.match(/^\s*-\s*\*\*Title\*\*:\s*(.*)$/i);
						if (tMatch && tMatch[1].trim()) title = tMatch[1].trim();
						const dMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)$/i);
						if (dMatch && dMatch[1].trim()) description = dMatch[1].trim();
					}
				} catch {
					// ignore
				}
				break;
			}
		}

		const folderName = ticketUri.path.split('/').filter(Boolean).pop() || 'ticket';

		return {
			ticketId: ticketId || folderName,
			entityName: folderName,
			ticketType: ticketType,
			title: title,
			description: description,
			status: status,
			priority: priority,
			customMetadata: customMetadata
		};
	}

	private _synthesizeFieldsFromMetadata(meta: Record<string, string>): ICustomField[] {
		const fields: ICustomField[] = [];
		for (const [k, v] of Object.entries(meta)) {
			let type: any = 'text';
			if (k.toLowerCase().includes('browser') || /^https?:\/\//i.test(v)) {
				type = 'browser';
			} else if (k.toLowerCase().includes('prompt')) {
				type = 'prompt';
			} else if (k.toLowerCase().includes('output') || k.toLowerCase().includes('result')) {
				type = 'output';
			}
			fields.push({
				id: this._cleanKey(k),
				label: k,
				type: type,
				defaultContent: v
			});
		}
		return fields;
	}

	private async _persistExecutionState(ticketUri: URI, ticket: ITicketGetResult, customMetadata: Record<string, string>, finalOutput: any): Promise<void> {
		try {
			// 1. Update snapshot
			const snapshot = this.entityPersistenceService.getSnapshot(ticketUri) || {
				entityUri: ticketUri.toString(),
				entityName: ticket.ticketName,
				title: ticket.title,
				ticketId: ticket.ticketId,
				entityCode: ticket.ticketId,
				entityType: ticket.ticketType,
				status: 'Completed',
				description: ticket.description
			};
			snapshot.customMetadata = customMetadata;
			snapshot.status = 'Completed';
			await this.entityPersistenceService.saveSnapshot(snapshot);

			// 2. Append execution record to .agents/worklog.md or worklog.md
			const worklogUris = [
				URI.joinPath(ticketUri, '.agents', 'worklog.md'),
				URI.joinPath(ticketUri, 'work_log.md'),
				URI.joinPath(ticketUri, 'worklog.md')
			];

			let targetLogUri: URI | undefined;
			for (const u of worklogUris) {
				if (await this.fileService.exists(u)) {
					targetLogUri = u;
					break;
				}
			}
			if (!targetLogUri) {
				targetLogUri = worklogUris[0];
			}

			const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
			const logHeader = `\n\n## ${timeStr} - Workflow Execution\n\n`;
			const logBody = `- **Execution Status**: Completed\n- **Output Summary**: ${typeof finalOutput === 'object' ? JSON.stringify(finalOutput) : String(finalOutput).substring(0, 300)}\n`;

			let existingText = '';
			if (await this.fileService.exists(targetLogUri)) {
				existingText = (await this.fileService.readFile(targetLogUri)).value.toString();
			} else {
				existingText = `# Work Log: ${ticket.ticketName}\n`;
			}
			await this.fileService.writeFile(targetLogUri, VSBuffer.fromString(existingText + logHeader + logBody));
		} catch (err) {
			this.logService.warn(`[TicketWorkflowRuntime] Failed to persist execution state to worklog:`, err);
		}
	}
}
