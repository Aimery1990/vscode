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
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

export const ITicketWorkflowRuntimeService = createDecorator<ITicketWorkflowRuntimeService>('ticketWorkflowRuntimeService');

export interface ITicketCreateOptions {
	workspaceUri: string | URI;
	targetPath?: string;
	ticketType: string;
	title: string;
	folderName?: string;
	name?: string;
	description?: string;
	status?: string;
	priority?: string;
	parameters?: Record<string, any>;
	fieldValues?: Record<string, any>;
	autoRun?: boolean;
}

export interface ITicketCreateResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	ticketType: string;
	title?: string;
	status?: string;
	createdAt?: string;
	entityUri: string;
	targetFolder: string;
	parameters?: Record<string, any>;
	fields: Record<string, any>;
	outputs?: Record<string, any>;
	isHandle?: boolean;
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
	outputs?: Record<string, any>;
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

export interface IPythonExecutionResult {
	success: boolean;
	output: string;
	exitCode: number;
	durationMs: number;
	pythonPath: string;
	error?: string;
}

export interface IVirtualEnvResult {
	success: boolean;
	venvPath: string;
	pythonPath: string;
	output: string;
	error?: string;
}

export interface IPythonTestResult {
	success: boolean;
	version: string;
	error?: string;
}

export interface IPythonEnvironmentDetectionResult {
	isValid: boolean;
	isVenv: boolean;
	interpreterPath: string;
	venvRoot?: string;
	version?: string;
	error?: string;
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

	executePythonScript(
		workspaceUri: string | URI,
		ticketUri: string | URI,
		pythonPath: string,
		code: string,
		contextVariables?: Record<string, any>
	): Promise<IPythonExecutionResult>;

	createVirtualEnv(
		workspaceUri: string | URI,
		venvName?: string
	): Promise<IVirtualEnvResult>;

	testPythonInterpreter(
		workspaceUri: string | URI,
		pythonPath: string
	): Promise<IPythonTestResult>;

	detectPythonEnvironment(
		workspaceUri: string | URI,
		candidatePath?: string
	): Promise<IPythonEnvironmentDetectionResult>;
}


export class TicketWorkflowRuntime implements ITicketWorkflowRuntimeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@ITerminalService private readonly terminalService: ITerminalService
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

			// 2. Prepare target parent folder path & find root workspace URI
			const targetSubPath = (options.targetPath || '').trim().replace(/^\/+|\/+$/g, '');
			const parentFolderUri = targetSubPath ? URI.joinPath(wsUri, targetSubPath) : wsUri;
			const rootWsUri = await this.workspacesExplorerService.findWorkspaceRootUri(parentFolderUri);

			// 3. Generate sequential ticket ID and code matching workspace convention (e.g. NEOWO-0011)
			const { name: seqCode, code: activeCode } = await this.workspacesExplorerService.generateNextSequentialName(parentFolderUri, ticketType as any);
			const ticketCode = seqCode; // e.g. "NEOWO-0011"
			const ticketEntityCode = activeCode; // e.g. "NEOWO"

			// Folder name: if user explicitly provided a folder name, use it; otherwise use the sequential ticket code (e.g. "NEOWO-0011")
			const folderName = (options.folderName || options.name || ticketCode).replace(/[^a-zA-Z0-9_-]/g, '-');
			const ticketFolderUri = URI.joinPath(parentFolderUri, folderName);

			// Collision check: verify if the target ticket folder already exists
			const folderExists = await this.fileService.exists(ticketFolderUri);
			if (folderExists) {
				const errMsg = `Ticket '${folderName}' already exists at path '${parentFolderUri.fsPath}'. Cannot create duplicate ticket with the same name. Please specify a different title or target path.`;
				this.logService.warn(`[TicketWorkflowRuntime] ${errMsg}`);
				return {
					success: false,
					ticketId: '',
					ticketName: folderName,
					ticketType: ticketType,
					entityUri: ticketFolderUri.toString(),
					targetFolder: ticketFolderUri.fsPath,
					fields: {},
					error: errMsg
				};
			}

			// Update persistent monotonic sequence in .agents/sequences.json
			const numMatch = ticketCode.match(/-(\d+)$/);
			if (numMatch) {
				const num = parseInt(numMatch[1], 10);
				if (!isNaN(num)) {
					await this.workspacesExplorerService.updateWorkspaceSequence(rootWsUri, activeCode, num);
				}
			}

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
						const contentVal = (initialFields[fKey] && typeof initialFields[fKey] === 'object' && initialFields[fKey].content)
							? initialFields[fKey].content
							: (typeof initialFields[fKey] === 'string' && initialFields[fKey].trim() ? initialFields[fKey] : '');
						customMetadata[fKey] = JSON.stringify({
							url: String(urlVal),
							content: String(contentVal),
							credentials: f.credentials || [],
							lastFetched: contentVal ? new Date().toISOString() : ''
						});
					} else if (f.type === 'python') {
						const codeVal = (typeof initialFields[fKey] === 'string' ? initialFields[fKey] : '') || f.pythonCode || f.defaultContent || '';
						customMetadata[fKey] = JSON.stringify({
							pythonPath: f.pythonPath || '',
							pythonEnvMode: f.pythonEnvMode || 'existing',
							code: String(codeVal),
							output: '',
							exitCode: undefined,
							durationMs: undefined,
							lastExecuted: ''
						});
					} else if (f.type === 'prompt') {
						const promptVal = (typeof initialFields[fKey] === 'string' ? initialFields[fKey] : '') || f.defaultContent || '';
						customMetadata[fKey] = JSON.stringify({
							prompt: String(promptVal),
							targetMode: f.targetMode || 'model',
							targetModel: f.targetModel || 'gpt-4o',
							targetAgentId: f.targetAgentId || '',
							targetAgentName: f.targetAgentName || '',
							output: ''
						});
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
				entityName: folderName,
				title: title,
				ticketId: ticketCode,
				entityCode: ticketEntityCode,
				entityType: ticketType,
				status: options.status || (matchedModule?.statuses?.[0]?.label) || 'Todo',
				priority: options.priority || 'Medium',
				description: options.description || `${matchedModule?.name || ticketType}: ${title}`,
				belongsToWorkspaceUri: rootWsUri.toString(),
				typeDefinition: matchedModule ? `.agents/entity_type/${matchedModule.id}.yaml` : undefined,
				typePrompt: matchedModule?.prompt,
				customMetadata: customMetadata
			};

			await this.entityPersistenceService.writeEntity4MDFiles(snapshot, parentFolderUri, true);

			this.logService.info(`[TicketWorkflowRuntime] Created ticket '${ticketCode}' (${title}) at ${ticketFolderUri.fsPath}`);

			const createdAt = new Date().toISOString();
			const ticketResult: ITicketCreateResult = {
				success: true,
				ticketId: ticketCode,
				ticketName: folderName,
				ticketType: ticketType,
				title: title,
				status: snapshot.status || 'Todo',
				createdAt: createdAt,
				entityUri: ticketFolderUri.toString(),
				targetFolder: ticketFolderUri.fsPath,
				parameters: initialFields,
				fields: customMetadata,
				isHandle: true
			};

			if (options.autoRun) {
				const runRes = await this.runTicket({
					workspaceUri: options.workspaceUri,
					ticketIdOrPath: ticketCode,
					inputParams: options.parameters || options.fieldValues
				});
				if (runRes.success) {
					return {
						...ticketResult,
						status: 'Success',
						fields: runRes.fields || customMetadata,
						outputs: (runRes.output !== undefined && typeof runRes.output === 'object') ? runRes.output : this._extractTicketOutputs(runRes.fields || customMetadata, matchedModule)
					};
				}
			}

			return ticketResult;
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

			const ticketOutputs = this._extractTicketOutputs(ticketData.customMetadata, schema);

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
				outputs: ticketOutputs,
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

			// Add customMetadata entries into context (clean primitive contents so variables interpolate properly)
			for (const [k, v] of Object.entries(customMetadata)) {
				const cleanVal = this._getCleanPrimitiveContent(v);
				contextVariables[k] = cleanVal;
				contextVariables[this._cleanKey(k)] = cleanVal;
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
							// 2. Browser Primitive: resolve URL template, existing content, credentials, and fetch
							let targetUrl = '';
							let existingContent = '';
							let browserCreds = field.credentials;

							if (inputOverrides[fieldLabel]) {
								targetUrl = String(inputOverrides[fieldLabel]).trim();
							} else if (customMetadata[fieldLabel]) {
								const metaVal = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.url) targetUrl = String(parsed.url).trim();
											if (parsed.content) existingContent = String(parsed.content);
											if (parsed.credentials && Array.isArray(parsed.credentials)) browserCreds = parsed.credentials;
										} catch {
											targetUrl = trimmed;
										}
									} else {
										targetUrl = trimmed;
									}
								} else if (typeof metaVal === 'object' && metaVal !== null) {
									if ((metaVal as any).url) targetUrl = String((metaVal as any).url).trim();
									if ((metaVal as any).content) existingContent = String((metaVal as any).content);
									if ((metaVal as any).credentials) browserCreds = (metaVal as any).credentials;
								}
							}

							if (!targetUrl && field.defaultUrl) {
								targetUrl = field.defaultUrl.trim();
							}

							const interpolatedUrl = this._interpolateVariables(targetUrl, contextVariables);

							if (interpolatedUrl && /^https?:\/\//i.test(interpolatedUrl.trim())) {
								this.logService.info(`[TicketWorkflowRuntime] Fetching web content from: ${interpolatedUrl}`);
								let extracted = await this._extractWebContent(interpolatedUrl, browserCreds);
								if ((!extracted.content || extracted.content.startsWith('[Fetch Failed') || extracted.content.startsWith('HTTP Error')) && existingContent) {
									this.logService.info(`[TicketWorkflowRuntime] Web fetch failed or rate-limited; using preloaded content (${existingContent.length} chars)`);
									stepOutput = existingContent;
								} else {
									stepOutput = extracted.content || existingContent;
								}

								customMetadata[fieldLabel] = JSON.stringify({
									url: interpolatedUrl,
									content: stepOutput,
									credentials: browserCreds || [],
									lastFetched: new Date().toISOString()
								});
								customMetadata[`${fieldLabel}_url`] = interpolatedUrl;
								contextVariables[fieldLabel] = stepOutput;
								contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
								contextVariables[`${this._cleanKey(fieldLabel)}_url`] = interpolatedUrl;
							} else if (existingContent) {
								stepOutput = existingContent;
								customMetadata[fieldLabel] = JSON.stringify({
									url: targetUrl || '',
									content: stepOutput,
									credentials: browserCreds || [],
									lastFetched: new Date().toISOString()
								});
								contextVariables[fieldLabel] = stepOutput;
								contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							} else {
								stepOutput = `[Browser: Skipped - Invalid or empty URL: '${targetUrl}']`;
								contextVariables[fieldLabel] = stepOutput;
							}
							break;
						}

						case 'prompt': {
							// 3. AI Prompt Primitive: interpolate template with variables and call LLM
							let rawPrompt = '';
							let promptModel = field.targetModel || 'gpt-4o';
							let promptProvider = field.targetProvider;
							let existingPromptOutput = '';

							if (customMetadata[fieldLabel]) {
								const metaVal = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.prompt !== undefined) rawPrompt = String(parsed.prompt);
											if (parsed.targetModel) promptModel = String(parsed.targetModel);
											if (parsed.targetProvider) promptProvider = String(parsed.targetProvider);
											if (parsed.output) existingPromptOutput = String(parsed.output);
										} catch {
											rawPrompt = trimmed;
										}
									} else {
										rawPrompt = trimmed;
									}
								} else if (typeof metaVal === 'object' && metaVal !== null) {
									if ((metaVal as any).prompt !== undefined) rawPrompt = String((metaVal as any).prompt);
									if ((metaVal as any).targetModel) promptModel = String((metaVal as any).targetModel);
									if ((metaVal as any).targetProvider) promptProvider = String((metaVal as any).targetProvider);
									if ((metaVal as any).output) existingPromptOutput = String((metaVal as any).output);
								}
							}

							if (!rawPrompt && field.defaultContent) {
								rawPrompt = field.defaultContent;
							}

							const interpolatedPrompt = this._interpolateVariables(rawPrompt, contextVariables);

							this.logService.info(`[TicketWorkflowRuntime] Executing AI Prompt with model '${promptModel}' (provider: ${promptProvider || 'auto'})...`);
							let aiResponse = '';
							try {
								aiResponse = await this._executePrompt(promptModel, interpolatedPrompt, promptProvider);
							} catch (promptErr) {
								this.logService.warn(`[TicketWorkflowRuntime] AI Prompt call failed, checking for existing output:`, promptErr);
							}

							stepOutput = aiResponse || existingPromptOutput || 'No output generated from AI model';
							customMetadata[fieldLabel] = JSON.stringify({
								prompt: rawPrompt,
								interpolatedPrompt: interpolatedPrompt,
								targetMode: field.targetMode || 'model',
								targetModel: promptModel,
								targetProvider: promptProvider,
								output: stepOutput,
								executedAt: new Date().toISOString()
							});
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							break;
						}

						case 'python': {
							// 4. Python Primitive: execute automation script using specified interpreter or virtualenv
							let rawCode = field.pythonCode || '';
							let pythonPath = field.pythonPath || '';
							let existingOutput = '';

							if (customMetadata[fieldLabel]) {
								const metaVal = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.code !== undefined) rawCode = String(parsed.code);
											if (parsed.pythonCode !== undefined) rawCode = String(parsed.pythonCode);
											if (parsed.pythonPath !== undefined) pythonPath = String(parsed.pythonPath);
											if (parsed.output !== undefined) existingOutput = String(parsed.output);
										} catch {
											rawCode = trimmed;
										}
									} else {
										rawCode = trimmed;
									}
								} else if (typeof metaVal === 'object' && metaVal !== null) {
									if ((metaVal as any).code !== undefined) rawCode = String((metaVal as any).code);
									if ((metaVal as any).pythonCode !== undefined) rawCode = String((metaVal as any).pythonCode);
									if ((metaVal as any).pythonPath !== undefined) pythonPath = String((metaVal as any).pythonPath);
									if ((metaVal as any).output !== undefined) existingOutput = String((metaVal as any).output);
								}
							}

							if (!rawCode && field.defaultContent) {
								rawCode = field.defaultContent;
							}

							const interpolatedCode = this._interpolateVariables(rawCode, contextVariables);

							this.logService.info(`[TicketWorkflowRuntime] Executing Python primitive '${fieldLabel}'...`);
							const execResult = await this.executePythonScript(wsUri, ticketUri, pythonPath, interpolatedCode, contextVariables);

							stepOutput = execResult.output || existingOutput || 'Script completed with no output.';
							customMetadata[fieldLabel] = JSON.stringify({
								pythonPath: execResult.pythonPath || pythonPath,
								code: rawCode,
								interpolatedCode: interpolatedCode,
								output: stepOutput,
								exitCode: execResult.exitCode,
								durationMs: execResult.durationMs,
								lastExecuted: new Date().toISOString()
							});
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							contextVariables[`${this._cleanKey(fieldLabel)}_output`] = stepOutput;
							contextVariables[`${this._cleanKey(fieldLabel)}_code`] = rawCode;
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
									const rawVal = contextVariables[specKey] ?? contextVariables[spec.fieldKey] ?? contextVariables[this._cleanKey(specKey)] ?? customMetadata[specKey] ?? customMetadata[spec.fieldKey];
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
				type: 'python',
				label: 'Python (Code Automation & Scripting)',
				icon: 'code',
				category: 'processing',
				description: 'Automated script execution using local Python interpreter or virtual environment with stdout/stderr logging.',
				executionBehavior: 'Interpolates variables, executes Python script in virtualenv or local interpreter, captures stdout/stderr, and registers output in context.',
				supportedInputs: ['script template', 'Python interpreter / venv path', 'workflow context variables'],
				supportedOutputs: ['execution output (stdout)', 'logs', 'exit code', 'execution duration']
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

	private _getCleanPrimitiveContent(rawVal: any): string {
		if (rawVal === undefined || rawVal === null) return '';
		if (typeof rawVal === 'string') {
			const trimmed = rawVal.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed.content !== undefined) return String(parsed.content);
					if (parsed.output !== undefined) return String(parsed.output);
					if (parsed.result !== undefined) return String(parsed.result);
				} catch {}
			}
			return rawVal;
		}
		if (typeof rawVal === 'object') {
			if (rawVal.content !== undefined) return String(rawVal.content);
			if (rawVal.output !== undefined) return String(rawVal.output);
			if (rawVal.result !== undefined) return String(rawVal.result);
			return JSON.stringify(rawVal, null, 2);
		}
		return String(rawVal);
	}

	private _interpolateVariables(text: string, context: Record<string, any>): string {
		if (!text) return '';

		const resolveVal = (key: string): string | undefined => {
			const trimmedKey = key.trim();
			// 1. Direct match
			if (context[trimmedKey] !== undefined) {
				return this._getCleanPrimitiveContent(context[trimmedKey]);
			}
			// 2. Cleaned key match
			const clean = this._cleanKey(trimmedKey);
			if (context[clean] !== undefined) {
				return this._getCleanPrimitiveContent(context[clean]);
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
						return this._getCleanPrimitiveContent(subVal);
					}
				}
				if (context[sub] !== undefined) {
					return this._getCleanPrimitiveContent(context[sub]);
				}
			}
			return undefined;
		};

		// 1. Replace {{...}}, {...}, @{...}
		let result = text.replace(/@?\{\{?([^{}]+)\}?\}/g, (match, rawKey) => {
			const resolved = resolveVal(rawKey);
			return resolved !== undefined ? resolved : match;
		});

		// 2. Replace @Field_Name or @FieldName when matching existing context keys
		for (const k of Object.keys(context)) {
			if (!k || k.length < 2) continue;
			const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const atPattern = new RegExp(`@${escaped}\\b`, 'g');
			if (atPattern.test(result)) {
				const cleanVal = this._getCleanPrimitiveContent(context[k]);
				result = result.replace(atPattern, cleanVal);
			}
		}

		return result;
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

	private async _executePrompt(modelId: string, promptText: string, targetProviderId?: string): Promise<string> {
		try {
			const credService = this.instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (credService && credService.executePrompt) {
				const res = await credService.executePrompt(modelId, promptText, undefined, targetProviderId);
				if (res.success && res.text) {
					return res.text;
				} else if (res.error) {
					this.logService.warn(`[TicketWorkflowRuntime] AI Prompt execution warning: ${res.error}`);
					return `[AI Execution Error: ${res.error}]`;
				}
			}
		} catch (e: any) {
			this.logService.warn(`[TicketWorkflowRuntime] IAgentCredentialService error:`, e);
			return `[AI Service Error: ${e.message || String(e)}]`;
		}

		return `[AI Execution Notice: Credential not configured for ${modelId}]`;
	}

	private _formatOutputValue(rawVal: any, format: string): any {
		if (rawVal === undefined || rawVal === null) return '';
		if (typeof rawVal === 'object') return rawVal;

		const str = String(rawVal).trim();
		if (format === 'json' || format === 'table') {
			try {
				return JSON.parse(str);
			} catch {
				const match = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (match && match[1]) {
					try {
						return JSON.parse(match[1].trim());
					} catch {}
				}
				const firstBrace = str.indexOf('{');
				const lastBrace = str.lastIndexOf('}');
				if (firstBrace !== -1 && lastBrace > firstBrace) {
					try {
						return JSON.parse(str.substring(firstBrace, lastBrace + 1));
					} catch {}
				}
				const firstBracket = str.indexOf('[');
				const lastBracket = str.lastIndexOf(']');
				if (firstBracket !== -1 && lastBracket > firstBracket) {
					try {
						return JSON.parse(str.substring(firstBracket, lastBracket + 1));
					} catch {}
				}
			}
		}
		return str;
	}

	private _extractTicketOutputs(metadata: Record<string, string>, schema?: ICustomModule): Record<string, any> {
		const outputs: Record<string, any> = {};

		// 1. Check if schema has an output / result primitive with outputSpecs
		const outputField = schema?.fields?.find(f => f.type === 'output' || f.type === 'result');
		if (outputField && Array.isArray(outputField.outputSpecs)) {
			const enabledSpecs = outputField.outputSpecs.filter(s => s.enabled !== false);
			for (const spec of enabledSpecs) {
				const key = spec.label || spec.fieldKey;
				const raw = metadata[key] || metadata[spec.fieldKey];
				outputs[key] = this._extractPrimitiveCleanValue(raw, spec.defaultFormat);
			}
			if (Object.keys(outputs).length > 0) {
				return outputs;
			}
		}

		// 2. Check if metadata directly has an 'Output' or 'output' field with outputSpecs
		const outMeta = metadata['Output'] || metadata['output'] || metadata['Result'] || metadata['result'];
		if (outMeta && typeof outMeta === 'string' && outMeta.trim().startsWith('{')) {
			try {
				const parsed = JSON.parse(outMeta);
				if (Array.isArray(parsed.outputSpecs)) {
					for (const spec of parsed.outputSpecs) {
						if (spec.enabled !== false) {
							const key = spec.label || spec.fieldKey;
							const raw = metadata[key] || metadata[spec.fieldKey];
							outputs[key] = this._extractPrimitiveCleanValue(raw, spec.defaultFormat);
						}
					}
					if (Object.keys(outputs).length > 0) {
						return outputs;
					}
				}
			} catch {}
		}

		// 3. Fallback: extract output from any browser, prompt, or output fields in metadata
		for (const [k, v] of Object.entries(metadata)) {
			if (k.toLowerCase().startsWith('param') || k === 'parameters') continue;
			const extracted = this._extractPrimitiveCleanValue(v);
			if (extracted !== undefined) {
				outputs[k] = extracted;
			}
		}

		return outputs;
	}

	private _extractPrimitiveCleanValue(rawMeta: any, defaultFormat?: string): any {
		if (rawMeta === undefined || rawMeta === null) return undefined;
		if (typeof rawMeta === 'string') {
			const trimmed = rawMeta.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// Python primitive
					if (parsed.pythonCode !== undefined || parsed.code !== undefined || parsed.pythonPath !== undefined) {
						return parsed.output && parsed.output.trim()
							? parsed.output
							: (parsed.code || '(Python script ready)');
					}
					// Browser primitive
					if (parsed.content !== undefined) {
						return parsed.content;
					}
					// Prompt primitive
					if (parsed.prompt !== undefined || parsed.output !== undefined) {
						return parsed.output && parsed.output.trim()
							? parsed.output
							: '(Pending AI Execution - Run ticket to generate output)';
					}
					// Output / Result primitive
					if (parsed.result !== undefined) {
						return parsed.result;
					}
					return parsed;
				} catch {}
			}
		}
		return rawMeta;
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
			} else if (k.toLowerCase().includes('python') || k.toLowerCase().includes('script')) {
				type = 'python';
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

	async executePythonScript(
		workspaceUri: string | URI,
		ticketUri: string | URI,
		pythonPath: string,
		code: string,
		contextVariables?: Record<string, any>
	): Promise<IPythonExecutionResult> {
		const startTime = Date.now();
		const wsUri = this._toUri(workspaceUri);
		const tUri = this._toUri(ticketUri);

		try {
			// 1. Prepare directory and script path under .agents/
			const agentsDirUri = URI.joinPath(tUri, '.agents');
			try {
				if (!await this.fileService.exists(agentsDirUri)) {
					await this.fileService.createFolder(agentsDirUri);
				}
			} catch {}

			const timestamp = Date.now();
			const scriptUri = URI.joinPath(agentsDirUri, `run_python_${timestamp}.py`);
			const logUri = URI.joinPath(agentsDirUri, `run_python_${timestamp}.log`);

			// 2. Prepare script with injected context variables
			const ctxJson = JSON.stringify(contextVariables || {});
			const header = `# -*- coding: utf-8 -*-
import os, sys, json
try:
    _ctx_data = json.loads(${JSON.stringify(ctxJson)})
    os.environ['ANY_AGENT_CONTEXT'] = json.dumps(_ctx_data)
except Exception:
    pass

`;
			await this.fileService.writeFile(scriptUri, VSBuffer.fromString(header + code));

			// 3. Resolve Python interpreter and virtualenv environment variables
			const envDetection = await this.detectPythonEnvironment(wsUri, pythonPath);
			const resolvedPython = envDetection.interpreterPath || 'python3';
			const venvRoot = envDetection.venvRoot;

			const isWin = typeof process !== 'undefined' && process.platform === 'win32';
			let venvPrefix = '';
			if (venvRoot) {
				const binDir = isWin
					? URI.joinPath(URI.file(venvRoot), 'Scripts').fsPath
					: URI.joinPath(URI.file(venvRoot), 'bin').fsPath;
				if (isWin) {
					venvPrefix = `set "VIRTUAL_ENV=${venvRoot}" && set "PATH=${binDir};%PATH%" && set "PYTHONHOME=" && `;
				} else {
					venvPrefix = `export VIRTUAL_ENV="${venvRoot}"; export PATH="${binDir}:$PATH"; unset PYTHONHOME; `;
				}
			}

			// 4. Run via background terminal
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent Python Runner',
					cwd: wsUri,
					hideFromUser: true
				}
			});

			const sentinel = `___ANY_AGENT_PY_${timestamp}___`;
			const escapedPy = resolvedPython.includes(' ') ? `"${resolvedPython}"` : resolvedPython;
			const escapedScript = `"${scriptUri.fsPath}"`;
			const escapedLog = `"${logUri.fsPath}"`;
			const runCmd = `${venvPrefix}${escapedPy} -u ${escapedScript} > ${escapedLog} 2>&1; echo "${sentinel}:$?"`;

			let exitCode = 0;
			let finished = false;

			const waitPromise = new Promise<void>((resolve) => {
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				const dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						exitCode = parseInt(match[1], 10);
						finished = true;
						dataListener.dispose();
						resolve();
					}
				});

				terminal.onExit(code => {
					if (!finished) {
						if (typeof code === 'number') exitCode = code;
						finished = true;
						resolve();
					}
				});

				setTimeout(() => {
					if (!finished) {
						finished = true;
						resolve();
					}
				}, 60000);
			});

			await terminal.sendText(runCmd, true);
			await waitPromise;

			// 5. Read output log
			let output = '';
			if (await this.fileService.exists(logUri)) {
				try {
					output = (await this.fileService.readFile(logUri)).value.toString();
				} catch {}
			}

			terminal.dispose();

			return {
				success: exitCode === 0,
				output: output.trim(),
				exitCode,
				durationMs: Date.now() - startTime,
				pythonPath: resolvedPython
			};
		} catch (err: any) {
			this.logService.error('[TicketWorkflowRuntime] executePythonScript error:', err);
			return {
				success: false,
				output: '',
				exitCode: 1,
				durationMs: Date.now() - startTime,
				pythonPath,
				error: err.message || String(err)
			};
		}
	}

	async createVirtualEnv(workspaceUri: string | URI, venvName: string = '.venv'): Promise<IVirtualEnvResult> {
		const wsUri = this._toUri(workspaceUri);
		const rawName = (venvName || '.venv').trim();
		let targetVenvUri: URI;
		if (rawName.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(rawName)) {
			targetVenvUri = URI.file(rawName);
		} else {
			targetVenvUri = URI.joinPath(wsUri, rawName);
		}

		const isWin = typeof process !== 'undefined' && process.platform === 'win32';
		const targetPythonUri = isWin
			? URI.joinPath(targetVenvUri, 'Scripts', 'python.exe')
			: URI.joinPath(targetVenvUri, 'bin', 'python');
		const timestamp = Date.now();
		const logUri = URI.joinPath(wsUri, `.venv_create_${timestamp}.log`);

		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent Venv Creator',
					cwd: wsUri,
					hideFromUser: true
				}
			});

			const sentinel = `___VENV_CREATE_${timestamp}___`;
			const cmd = `python3 -m venv "${targetVenvUri.fsPath}" > "${logUri.fsPath}" 2>&1; echo "${sentinel}:$?"`;

			let exitCode = 0;
			let finished = false;

			const waitPromise = new Promise<void>((resolve) => {
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				const dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						exitCode = parseInt(match[1], 10);
						finished = true;
						dataListener.dispose();
						resolve();
					}
				});

				terminal.onExit(code => {
					if (!finished) {
						if (typeof code === 'number') exitCode = code;
						finished = true;
						resolve();
					}
				});

				setTimeout(() => {
					if (!finished) {
						finished = true;
						resolve();
					}
				}, 60000);
			});

			await terminal.sendText(cmd, true);
			await waitPromise;

			let logOutput = '';
			if (await this.fileService.exists(logUri)) {
				try {
					logOutput = (await this.fileService.readFile(logUri)).value.toString();
					await this.fileService.del(logUri);
				} catch {}
			}

			terminal.dispose();

			const pyRelPath = targetPythonUri.fsPath;
			const exists = await this.fileService.exists(targetPythonUri);
			if (exists || exitCode === 0) {
				return {
					success: true,
					venvPath: targetVenvUri.fsPath,
					pythonPath: pyRelPath,
					output: `Virtual environment created successfully at ${targetVenvUri.fsPath}. Interpreter: ${pyRelPath}`
				};
			} else {
				return {
					success: false,
					venvPath: targetVenvUri.fsPath,
					pythonPath: '',
					output: logOutput,
					error: `Virtual environment creation exited with code ${exitCode}. ${logOutput}`
				};
			}
		} catch (err: any) {
			return {
				success: false,
				venvPath: targetVenvUri.fsPath,
				pythonPath: '',
				output: '',
				error: err.message || String(err)
			};
		}
	}

	async testPythonInterpreter(workspaceUri: string | URI, pythonPath: string): Promise<IPythonTestResult> {
		const wsUri = this._toUri(workspaceUri);
		const envDetection = await this.detectPythonEnvironment(wsUri, pythonPath);
		if (!envDetection.isValid && envDetection.error) {
			return {
				success: false,
				version: '',
				error: envDetection.error
			};
		}

		const resolved = envDetection.interpreterPath || 'python3';
		const venvRoot = envDetection.venvRoot;
		const isWin = typeof process !== 'undefined' && process.platform === 'win32';
		let venvPrefix = '';
		if (venvRoot) {
			const binDir = isWin
				? URI.joinPath(URI.file(venvRoot), 'Scripts').fsPath
				: URI.joinPath(URI.file(venvRoot), 'bin').fsPath;
			if (isWin) {
				venvPrefix = `set "VIRTUAL_ENV=${venvRoot}" && set "PATH=${binDir};%PATH%" && set "PYTHONHOME=" && `;
			} else {
				venvPrefix = `export VIRTUAL_ENV="${venvRoot}"; export PATH="${binDir}:$PATH"; unset PYTHONHOME; `;
			}
		}

		const timestamp = Date.now();
		const logUri = URI.joinPath(wsUri, `.py_test_${timestamp}.log`);

		try {
			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent Python Tester',
					cwd: wsUri,
					hideFromUser: true
				}
			});

			const sentinel = `___PY_TEST_${timestamp}___`;
			const escaped = resolved.includes(' ') ? `"${resolved}"` : resolved;
			const cmd = `${venvPrefix}${escaped} --version > "${logUri.fsPath}" 2>&1; echo "${sentinel}:$?"`;

			let exitCode = 0;
			let finished = false;

			const waitPromise = new Promise<void>((resolve) => {
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				const dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						exitCode = parseInt(match[1], 10);
						finished = true;
						dataListener.dispose();
						resolve();
					}
				});

				terminal.onExit(code => {
					if (!finished) {
						if (typeof code === 'number') exitCode = code;
						finished = true;
						resolve();
					}
				});

				setTimeout(() => {
					if (!finished) {
						finished = true;
						resolve();
					}
				}, 15000);
			});

			await terminal.sendText(cmd, true);
			await waitPromise;

			let output = '';
			if (await this.fileService.exists(logUri)) {
				try {
					output = (await this.fileService.readFile(logUri)).value.toString().trim();
					await this.fileService.del(logUri);
				} catch {}
			}

			terminal.dispose();

			if (exitCode === 0 && output) {
				const venvSuffix = envDetection.isVenv ? ` (venv: ${venvRoot})` : '';
				return { success: true, version: `${output}${venvSuffix}` };
			} else {
				return { success: false, version: '', error: output || `Interpreter test exited with code ${exitCode}` };
			}
		} catch (err: any) {
			return { success: false, version: '', error: err.message || String(err) };
		}
	}

	async detectPythonEnvironment(workspaceUri: string | URI, candidatePath?: string): Promise<IPythonEnvironmentDetectionResult> {
		const wsUri = this._toUri(workspaceUri);
		const rawPath = (candidatePath || '').trim();
		const isWin = typeof process !== 'undefined' && process.platform === 'win32';

		// Case 1: Empty candidate -> Check for standard .venv in workspace, else fallback to python3
		if (!rawPath) {
			const venvPy = isWin
				? URI.joinPath(wsUri, '.venv', 'Scripts', 'python.exe')
				: URI.joinPath(wsUri, '.venv', 'bin', 'python');
			if (await this.fileService.exists(venvPy)) {
				return {
					isValid: true,
					isVenv: true,
					interpreterPath: venvPy.fsPath,
					venvRoot: URI.joinPath(wsUri, '.venv').fsPath
				};
			}
			return {
				isValid: true,
				isVenv: false,
				interpreterPath: 'python3'
			};
		}

		// Case 2: Named system command without slashes (e.g. 'python3', 'python')
		if (!rawPath.includes('/') && !rawPath.includes('\\')) {
			return {
				isValid: true,
				isVenv: false,
				interpreterPath: rawPath
			};
		}

		// Case 3: Path provided (relative or absolute)
		let targetUri: URI;
		if (rawPath.startsWith('.')) {
			targetUri = URI.joinPath(wsUri, rawPath);
		} else if (rawPath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(rawPath)) {
			targetUri = URI.file(rawPath);
		} else {
			targetUri = URI.joinPath(wsUri, rawPath);
		}

		const exists = await this.fileService.exists(targetUri);
		if (!exists) {
			return {
				isValid: false,
				isVenv: false,
				interpreterPath: '',
				error: `Path '${rawPath}' does not exist.`
			};
		}

		// Check if it is a directory containing a virtual environment
		const candidateVenvPy = isWin
			? URI.joinPath(targetUri, 'Scripts', 'python.exe')
			: URI.joinPath(targetUri, 'bin', 'python');
		const candidateVenvPyAlt = isWin
			? URI.joinPath(targetUri, 'Scripts', 'python')
			: URI.joinPath(targetUri, 'bin', 'python3');

		if (await this.fileService.exists(candidateVenvPy)) {
			return {
				isValid: true,
				isVenv: true,
				interpreterPath: candidateVenvPy.fsPath,
				venvRoot: targetUri.fsPath
			};
		}
		if (await this.fileService.exists(candidateVenvPyAlt)) {
			return {
				isValid: true,
				isVenv: true,
				interpreterPath: candidateVenvPyAlt.fsPath,
				venvRoot: targetUri.fsPath
			};
		}

		// Check if targetUri itself is the python executable file
		const baseName = targetUri.path.split('/').pop()?.toLowerCase() || '';
		if (baseName === 'python' || baseName === 'python.exe' || baseName.startsWith('python3')) {
			const parentDir = URI.joinPath(targetUri, '..');
			const parentName = parentDir.path.split('/').pop()?.toLowerCase() || '';
			if (parentName === 'bin' || parentName === 'scripts') {
				const venvRootDir = URI.joinPath(parentDir, '..');
				return {
					isValid: true,
					isVenv: true,
					interpreterPath: targetUri.fsPath,
					venvRoot: venvRootDir.fsPath
				};
			}
			return {
				isValid: true,
				isVenv: false,
				interpreterPath: targetUri.fsPath
			};
		}

		// Target exists, but has no python in bin/ or Scripts/
		return {
			isValid: false,
			isVenv: false,
			interpreterPath: '',
			venvRoot: targetUri.fsPath,
			error: `Folder '${rawPath}' is not a valid Python virtual environment (missing bin/python or Scripts/python.exe).`
		};
	}
}
