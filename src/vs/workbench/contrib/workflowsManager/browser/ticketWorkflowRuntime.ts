/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEntityPersistenceService, IBaseEntitySnapshot, ICustomField, ICustomModule, IOutputSpec, ITableColumnDefinition, generateSmartPythonVarName, detectMediaFileInfo } from '../../entityPersistence/common/entityPersistence.js';
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
	isCancelled?: () => boolean;
}

export interface IPrimitiveExecutionStepResult {
	fieldId: string;
	fieldLabel: string;
	fieldType: string;
	output?: any;
	status: 'success' | 'skipped' | 'failed';
	durationMs: number;
	error?: string;
	details?: Record<string, any>;
}

export interface ITicketRunResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	title?: string;
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
	result?: any;
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

export interface ISqliteTableOperationOptions {
	workspaceUri?: string | URI;
	ticketUri?: string | URI;
	workingDirUri?: string | URI;
	dbPath?: string;
	tableName: string;
	action: 'init_db' | 'save' | 'update' | 'insert' | 'update_header' | 'inspect_schema' | 'load' | 'load_schema' | 'delete_data' | 'drop_table' | 'list_tables' | 'query';
	columns?: ITableColumnDefinition[];
	rows?: Array<Record<string, any>>;
	whereClause?: string;
	sqlQuery?: string;
	limit?: number;
	offset?: number;
}

export interface ISqliteTableOperationResult {
	success: boolean;
	dbPath: string;
	tableName: string;
	action: string;
	tableExists?: boolean;
	addedColumns?: string[];
	removedColumns?: string[];
	columns?: ITableColumnDefinition[];
	rows?: Array<Record<string, any>>;
	isSelectQuery?: boolean;
	isPragmaQuery?: boolean;
	queryColumns?: ITableColumnDefinition[];
	queryRows?: Array<Record<string, any>>;
	tables?: string[];
	rowCount?: number;
	affectedRows?: number;
	message?: string;
	error?: string;
}

export interface ITicketWorkflowRuntimeService {
	readonly _serviceBrand: undefined;

	createTickets(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	createTicket(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	CREATE_TICKETS(options: ITicketCreateOptions): Promise<ITicketCreateResult>;

	getTickets(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult>;
	getTicket(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult>;
	GET_TICKETS(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult>;

	getOutputs(workspaceUri: string | URI, ticketOrId: any): Promise<Record<string, any> | null>;
	GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: any): Promise<Record<string, any> | null>;

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
		contextVariables?: Record<string, any>,
		externalScripts?: string[]
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

	executeSqliteTableOperation(
		options: ISqliteTableOperationOptions
	): Promise<ISqliteTableOperationResult>;

	executeNodeComponent(
		workspaceUri: string | URI,
		workingDirUri: string | URI,
		field: ICustomField,
		contextVariables: Record<string, any>
	): Promise<IPrimitiveExecutionStepResult>;

	cancelAllActiveOperations(reason?: string): Promise<number>;
	resetCancellation(): void;

	analyzeWorkflowPythonNodesWithAst(
		workspaceUri: string | URI,
		pythonPath: string | undefined,
		nodes: Array<{ nodeId: string; title: string; code: string; codeStartLine: number }>
	): Promise<{
		invoked: boolean;
		spansByNodeId: Map<string, Array<{ lineno: number; end_lineno: number }>>;
		syntaxErrors: Array<{ nodeId: string; title: string; line: number; message: string }>;
	}>;
}


export class TicketWorkflowRuntime implements ITicketWorkflowRuntimeService {
	declare readonly _serviceBrand: undefined;

	private _cancelEpoch = 0;
	private readonly _activeTerminals = new Set<{ terminal: any; abort: () => void; label: string }>();
	private readonly _activeAbortControllers = new Set<AbortController>();

	constructor(
		@IEntityPersistenceService private readonly entityPersistenceService: IEntityPersistenceService,
		@ICustomModulesService private readonly customModulesService: ICustomModulesService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@ITerminalService private readonly terminalService: ITerminalService
	) { }

	resetCancellation(): void {
		// Cancellation uses monotonic _cancelEpoch so new operations are automatically valid
	}

	async cancelAllActiveOperations(reason?: string): Promise<number> {
		this._cancelEpoch++;
		const cancelReason = reason || 'Execution stopped by user';
		let terminatedCount = 0;

		if (this._activeAbortControllers.size > 0) {
			for (const controller of Array.from(this._activeAbortControllers)) {
				try {
					controller.abort(new Error(cancelReason));
					terminatedCount++;
				} catch { }
			}
			this._activeAbortControllers.clear();
		}

		if (this._activeTerminals.size > 0) {
			for (const entry of Array.from(this._activeTerminals)) {
				terminatedCount++;
				try {
					entry.terminal.sendText?.('\x03', false);
				} catch { }
				try {
					entry.abort();
				} catch { }
				try {
					entry.terminal.dispose?.();
				} catch { }
			}
			this._activeTerminals.clear();
		}

		this.logService.info(`[TicketWorkflowRuntime] cancelAllActiveOperations (${cancelReason}): terminated ${terminatedCount} in-flight task(s)/terminal(s).`);
		return terminatedCount;
	}

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
			const lookupInitialField = (key?: string): any => {
				if (!key) return undefined;
				if (initialFields[key] !== undefined) return initialFields[key];
				const norm = key.trim().toLowerCase().replace(/_/g, ' ');
				for (const [ik, iv] of Object.entries(initialFields)) {
					if (ik.trim().toLowerCase().replace(/_/g, ' ') === norm) {
						return iv;
					}
				}
				return undefined;
			};

			if (matchedModule?.fields && Array.isArray(matchedModule.fields)) {
				for (const f of matchedModule.fields) {
					const fKey = f.label || f.id;
					if (f.type === 'parameters' && f.parameters) {
						const paramObj: Record<string, any> = {};
						for (const p of f.parameters) {
							const pKey = p.name || p.id;
							const matchedVal = lookupInitialField(pKey) ?? lookupInitialField(p.label);
							const pVal = matchedVal !== undefined ? matchedVal : (p.defaultValue !== undefined ? p.defaultValue : '');
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
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						const preInjectedPrompt = f.defaultContent || '';
						let userPrompts: string[] = (Array.isArray(f.defaultUserPrompts) && f.defaultUserPrompts.length > 0)
							? [...f.defaultUserPrompts]
							: [f.defaultUserPrompt || ''];
						if (Array.isArray(passedVal)) {
							userPrompts = passedVal.map(item => String(item ?? ''));
						} else if (typeof passedVal === 'string' && passedVal.trim()) {
							userPrompts = [passedVal];
						} else if (passedVal && typeof passedVal === 'object') {
							if (Array.isArray((passedVal as any).userPrompts)) {
								userPrompts = (passedVal as any).userPrompts.map((item: any) => String(item ?? ''));
							} else if ((passedVal as any).userPrompt !== undefined) {
								userPrompts = [String((passedVal as any).userPrompt)];
							}
						}
						const nonEmpty = userPrompts.map(s => (s || '').trim()).filter(s => s.length > 0);
						const userPrompt = userPrompts.length <= 1
							? (userPrompts[0] || '')
							: nonEmpty.map((s, i) => `[User Input #${i + 1}]:\n${s}`).join('\n\n');
						customMetadata[fKey] = JSON.stringify({
							userPrompt,
							userPrompts,
							preInjectedPrompt,
							prompt: String(preInjectedPrompt || userPrompt),
							targetMode: f.targetMode || 'model',
							targetProvider: f.targetProvider || '',
							targetModel: f.targetModel || 'gpt-4o',
							targetAgentId: f.targetAgentId || '',
							targetAgentName: f.targetAgentName || '',
							output: ''
						});
					} else if (f.type === 'tts') {
						let ttsVal = f.defaultContent || '';
						let ttsDisplayVal = (f as any).ttsDisplayText || '';
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (typeof passedVal === 'string' && passedVal.trim()) {
							ttsVal = passedVal;
						} else if (passedVal && typeof passedVal === 'object') {
							if ((passedVal as any).text !== undefined) ttsVal = String((passedVal as any).text);
							if ((passedVal as any).displayText !== undefined) ttsDisplayVal = String((passedVal as any).displayText);
							else if ((passedVal as any).ttsDisplayText !== undefined) ttsDisplayVal = String((passedVal as any).ttsDisplayText);
						}
						customMetadata[fKey] = JSON.stringify({
							text: String(ttsVal),
							displayText: String(ttsDisplayVal),
							ttsShowSpeechTextInTicket: Boolean((f as any).ttsShowSpeechTextInTicket),
							targetCredentialId: f.targetCredentialId || '',
							targetProvider: f.targetProvider || 'gemini',
							targetModel: f.targetModel || 'gemini-2.5-flash-preview-tts',
							ttsFormat: f.ttsFormat || 'mp3',
							ttsVoice: f.ttsVoice || 'Kore',
							ttsAutoPlay: Boolean(f.ttsAutoPlay),
							audioFileName: '',
							audioRelativePath: '',
							lastGenerated: '',
							lastSynthesizedText: ''
						});
					} else if (f.type === 'media_player') {
						let mediaPath = f.mediaFilePath || '';
						let mediaName = f.mediaFileName || '';
						let mediaRate = typeof f.mediaPlaybackRate === 'number' ? f.mediaPlaybackRate : 1.0;
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (typeof passedVal === 'string' && passedVal.trim()) {
							mediaPath = passedVal.trim();
							mediaName = mediaPath.split(/[\\/]/).pop() || mediaPath;
						} else if (passedVal && typeof passedVal === 'object') {
							if ((passedVal as any).mediaFilePath !== undefined) mediaPath = String((passedVal as any).mediaFilePath);
							else if ((passedVal as any).filePath !== undefined) mediaPath = String((passedVal as any).filePath);
							if ((passedVal as any).mediaFileName !== undefined) mediaName = String((passedVal as any).mediaFileName);
							else if ((passedVal as any).fileName !== undefined) mediaName = String((passedVal as any).fileName);
							if (typeof (passedVal as any).mediaPlaybackRate === 'number') mediaRate = (passedVal as any).mediaPlaybackRate;
						}
						const detected = detectMediaFileInfo(mediaName || mediaPath, f.mediaMimeType);
						customMetadata[fKey] = JSON.stringify({
							mediaFilePath: mediaPath,
							mediaFileName: mediaName || (mediaPath ? (mediaPath.split(/[\\/]/).pop() || mediaPath) : ''),
							mediaKind: f.mediaKind || detected.kind,
							mediaMimeType: f.mediaMimeType || detected.mimeType,
							mediaPlaybackRate: mediaRate,
							mediaAutoPlay: Boolean(f.mediaAutoPlay)
						});
					} else if (f.type === 'output' || f.type === 'result') {
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (passedVal !== undefined) {
							customMetadata[fKey] = typeof passedVal === 'object' ? JSON.stringify(passedVal) : String(passedVal);
						} else {
							customMetadata[fKey] = JSON.stringify({});
						}
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
	 * Fetches detailed ticket data, custom metadata, and execution outputs by ticketId, name, path, or ticket handle.
	 */
	async getTicket(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult> {
		let rawIdentifier = '';
		try {
			const wsUri = this._toUri(workspaceUri);
			let directEntityUri: URI | undefined;

			if (ticketIdOrPath && typeof ticketIdOrPath === 'object') {
				rawIdentifier = String(
					ticketIdOrPath.ticketId ||
					ticketIdOrPath.ticketName ||
					ticketIdOrPath.ticket_id ||
					ticketIdOrPath.ticket_name ||
					ticketIdOrPath.id ||
					ticketIdOrPath.title ||
					''
				).trim();
				const uriCand = ticketIdOrPath.entityUri || ticketIdOrPath.targetFolder || ticketIdOrPath.path;
				if (uriCand && typeof uriCand === 'string' && uriCand.trim()) {
					const parsedCand = this._toUri(uriCand.trim());
					if (await this.fileService.exists(parsedCand)) {
						directEntityUri = parsedCand;
					}
				}
			} else {
				rawIdentifier = String(ticketIdOrPath ?? '').trim();
			}

			const needle = rawIdentifier.toLowerCase();

			// Build prioritized search roots: current dir, parent workspace root, up to 3 parent folders, and all registered workspaces
			const searchRoots: URI[] = [];
			const seenRoots = new Set<string>();
			const addRoot = (u?: URI) => {
				if (!u) return;
				const cleanU = u.path.endsWith('/.agents') ? URI.joinPath(u, '..') : u;
				const key = cleanU.toString().toLowerCase();
				if (!seenRoots.has(key)) {
					seenRoots.add(key);
					searchRoots.push(cleanU);
				}
			};

			addRoot(wsUri);
			try {
				const rootWs = await this.workspacesExplorerService.findWorkspaceRootUri(wsUri);
				addRoot(rootWs);
			} catch { }
			let curParent = wsUri.path.endsWith('/.agents') ? URI.joinPath(wsUri, '..') : wsUri;
			for (let depth = 0; depth < 3; depth++) {
				const nextParent = URI.joinPath(curParent, '..');
				if (nextParent.toString() === curParent.toString()) break;
				addRoot(nextParent);
				curParent = nextParent;
			}
			try {
				const allWs = await this.workspacesExplorerService.getWorkspaces();
				for (const w of allWs) {
					if (w.uri) addRoot(w.uri);
				}
			} catch { }

			// 1. Search in cached snapshots first
			const allSnapshots = this.entityPersistenceService.getAllSnapshots();
			let matched = needle ? allSnapshots.find(s => s.ticketId?.toLowerCase() === needle) : undefined;
			if (!matched && directEntityUri) {
				const directStr = directEntityUri.toString().toLowerCase();
				matched = allSnapshots.find(s => s.entityUri?.toLowerCase() === directStr);
			}

			if (!matched && needle) {
				const isMatch = (s: IBaseEntitySnapshot) =>
					s.ticketId?.toLowerCase() === needle ||
					s.entityName.toLowerCase() === needle ||
					s.title?.toLowerCase() === needle ||
					s.entityUri.toLowerCase() === needle ||
					s.entityUri.toLowerCase().endsWith('/' + needle);

				const rootPrefixes = searchRoots.map(r => r.toString().toLowerCase());
				const wsMatches = allSnapshots.filter(s => {
					const sWs = (s.belongsToWorkspaceUri || '').toLowerCase();
					const sUri = (s.entityUri || '').toLowerCase();
					const inWs = rootPrefixes.some(prefix => sWs === prefix || sUri.startsWith(prefix));
					return inWs && isMatch(s);
				});

				const candidates = wsMatches.length > 0 ? wsMatches : allSnapshots.filter(isMatch);
				if (candidates.length > 1) {
					const exactIdMatch = candidates.find(c => c.ticketId?.toLowerCase() === needle || c.entityName.toLowerCase() === needle);
					if (exactIdMatch) {
						matched = exactIdMatch;
					} else {
						const matchedIds = candidates.map(c => c.ticketId || c.entityName);
						return {
							success: false,
							ticketId: rawIdentifier,
							ticketName: '',
							ticketType: '',
							entityUri: '',
							title: '',
							description: '',
							status: '',
							priority: '',
							customMetadata: {},
							error: `Ambiguous ticket: found ${candidates.length} tickets matching name '${rawIdentifier}' (${matchedIds.join(', ')}). Please use ticket='<ticket_id>' (e.g. ticket='${candidates[0].ticketId}') or pass variable (e.g. ticket=@new_ticket) instead.`
						};
					}
				} else if (candidates.length === 1) {
					matched = candidates[0];
				}
			}

			// 2. If not found in snapshot cache, try direct path in searchRoots or scan workspace children
			let ticketUri: URI | undefined = directEntityUri || (matched ? URI.parse(matched.entityUri) : undefined);
			if (ticketUri && !(await this.fileService.exists(ticketUri))) {
				ticketUri = undefined;
			}

			if (!ticketUri && rawIdentifier) {
				// 2a. Check if rawIdentifier is already an absolute path or file:// URI
				if (rawIdentifier.startsWith('file://') || rawIdentifier.startsWith('/')) {
					const absCand = this._toUri(rawIdentifier);
					if (await this.fileService.exists(absCand)) {
						ticketUri = absCand;
					}
				}

				// 2b. Check direct subfolder under each searchRoot (e.g. <workspace>/FINDJ-0002)
				if (!ticketUri) {
					for (const rootUri of searchRoots) {
						const candidateUri = URI.joinPath(rootUri, rawIdentifier);
						if (await this.fileService.exists(candidateUri)) {
							const hasAgentsTicket = await this.fileService.exists(URI.joinPath(candidateUri, '.agents', 'ticket.md'));
							const hasRootTicket = await this.fileService.exists(URI.joinPath(candidateUri, 'ticket.md'));
							const hasReadme = await this.fileService.exists(URI.joinPath(candidateUri, '.agents', 'README.md'));
							if (hasAgentsTicket || hasRootTicket || hasReadme) {
								ticketUri = candidateUri;
								break;
							}
						}
					}
				}

				// 2c. Scan children across searchRoots
				if (!ticketUri) {
					for (const rootUri of searchRoots) {
						try {
							const wsChildren = await this.workspacesExplorerService.scanWorkspaceChildren(rootUri, true);
							const matchingChildren: { id: string; name: string; uri: URI }[] = [];
							for (const child of wsChildren) {
								if (child.type === 'file' || child.type === 'folder') continue;
								const snap = this.workspacesExplorerService.getMetadataSnapshot(child.uri);
								const titleMatch = snap?.title?.toLowerCase() === needle;
								const idMatch = child.name.toLowerCase() === needle || snap?.ticketId?.toLowerCase() === needle;
								if (titleMatch || idMatch) {
									matchingChildren.push(child);
								}
							}
							if (matchingChildren.length === 1) {
								ticketUri = matchingChildren[0].uri;
								break;
							} else if (matchingChildren.length > 1) {
								const exactChild = matchingChildren.find(c => c.name.toLowerCase() === needle);
								if (exactChild) {
									ticketUri = exactChild.uri;
									break;
								}
							}
						} catch { }
					}
				}
			}

			if (!ticketUri) {
				return {
					success: false,
					ticketId: rawIdentifier,
					ticketName: '',
					ticketType: '',
					entityUri: '',
					title: '',
					description: '',
					status: '',
					priority: '',
					customMetadata: {},
					error: `Ticket '${rawIdentifier}' not found in workspace '${wsUri.fsPath}'.`
				};
			}

			// Read ticket files
			const ticketData = await this._readTicketFiles(ticketUri, matched);

			// Load schema definition (search ticket's parent workspace first, then wsUri)
			let schema: ICustomModule | undefined;
			if (ticketData.ticketType) {
				const targetTypeLower = ticketData.ticketType.toLowerCase();
				let ticketWsUri = URI.joinPath(ticketUri, '..');
				try {
					ticketWsUri = await this.workspacesExplorerService.findWorkspaceRootUri(ticketUri);
				} catch { }
				const modules = await this.customModulesService.getCustomModules(ticketWsUri);
				schema = modules.find(m => m.id.toLowerCase() === targetTypeLower || m.name.toLowerCase() === targetTypeLower);
				if (!schema && ticketWsUri.toString() !== wsUri.toString()) {
					const fallbackModules = await this.customModulesService.getCustomModules(wsUri);
					schema = fallbackModules.find(m => m.id.toLowerCase() === targetTypeLower || m.name.toLowerCase() === targetTypeLower);
				}
			}

			const strictOutputs = this._extractStrictOutputsComponent(ticketData.customMetadata, schema);
			const ticketOutputs = strictOutputs !== null ? strictOutputs : this._extractTicketOutputs(ticketData.customMetadata, schema);

			// Sanitize customMetadata to strip massive internal debug payloads (e.g. 500KB+ lastSentPayload)
			const sanitizedCustomMetadata: Record<string, string> = {};
			for (const [k, v] of Object.entries(ticketData.customMetadata || {})) {
				if (typeof v === 'string' && v.length > 2000 && v.includes('"lastSentPayload"')) {
					try {
						const parsed = JSON.parse(v);
						if (parsed && typeof parsed === 'object' && 'lastSentPayload' in parsed) {
							delete parsed.lastSentPayload;
							sanitizedCustomMetadata[k] = JSON.stringify(parsed);
							continue;
						}
					} catch { }
				}
				sanitizedCustomMetadata[k] = v;
			}

			const ticketResult: ITicketGetResult = {
				success: true,
				ticketId: ticketData.ticketId,
				ticketName: ticketData.entityName,
				ticketType: ticketData.ticketType,
				entityUri: ticketUri.toString(),
				title: ticketData.title,
				description: ticketData.description,
				status: ticketData.status,
				priority: ticketData.priority,
				customMetadata: sanitizedCustomMetadata,
				outputs: ticketOutputs
			};
			try {
				Object.defineProperty(ticketResult, 'output', {
					value: ticketData.customMetadata['Output'] || ticketData.customMetadata['Output 1'] || ticketData.customMetadata['output'] || ticketData.customMetadata['Result'] || ticketData.customMetadata['result'],
					enumerable: false,
					configurable: true,
					writable: true
				});
				Object.defineProperty(ticketResult, 'schema', {
					value: schema,
					enumerable: false,
					configurable: true,
					writable: true
				});
			} catch { }

			return ticketResult;
		} catch (err: any) {
			return {
				success: false,
				ticketId: rawIdentifier || String(ticketIdOrPath ?? ''),
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
	 * 2b. getOutputs / GET_OUTPUTS:
	 * Returns ONLY the dictionary of output fields configured in the ticket's OUTPUT component (outputSpecs).
	 * - If the ticket's template does NOT have an OUTPUT component, returns null (None).
	 * - If the ticket's template HAS an OUTPUT component, returns an object mapping each output field label
	 *   to its parsed value (JSON object/array if valid JSON, string if text, or null/None if empty/missing).
	 */
	async getOutputs(workspaceUri: string | URI, ticketOrId: any): Promise<Record<string, any> | null> {
		try {
			if (ticketOrId === undefined || ticketOrId === null || ticketOrId === '') {
				return null;
			}
			const ticketRes = await this.getTicket(workspaceUri, ticketOrId);
			if (!ticketRes.success) {
				// Fallback if ticketOrId is an in-memory ticket handle with customMetadata/fields and schema
				if (ticketOrId && typeof ticketOrId === 'object' && (ticketOrId.customMetadata || ticketOrId.fields)) {
					const meta = ticketOrId.customMetadata || ticketOrId.fields || {};
					return this._extractStrictOutputsComponent(meta, ticketOrId.schema);
				}
				return null;
			}
			return this._extractStrictOutputsComponent(ticketRes.customMetadata, ticketRes.schema);
		} catch (err) {
			this.logService.warn(`[TicketWorkflowRuntime] getOutputs failed:`, err);
			return null;
		}
	}

	async GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: any): Promise<Record<string, any> | null> {
		return this.getOutputs(workspaceUri, ticketOrId);
	}

	/**
	 * 3. runTicket:
	 * Sequentially executes each primitive on a ticket schema from top to bottom.
	 * Resolves parameters, performs browser extractions, executes AI prompts, formats outputs, and returns result.
	 */
	async runTicket(options: ITicketRunOptions): Promise<ITicketRunResult> {
		const startTime = Date.now();
		const startEpoch = this._cancelEpoch;
		const isCancelled = () => this._cancelEpoch !== startEpoch || Boolean(options.isCancelled?.());
		const stepResults: IPrimitiveExecutionStepResult[] = [];
		const contextVariables: Record<string, any> = {};

		try {
			if (isCancelled()) {
				throw new Error('Ticket execution cancelled by Stop request');
			}
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

			// Pre-populate context with static defaults and contents from all fields
			for (const f of fieldsToRun) {
				const fKey = f.label || f.id;
				if (contextVariables[fKey] === undefined) {
					let defaultVal: any = f.defaultContent ?? f.defaultValue ?? '';
					if (f.type === 'parameters' && f.parameters) {
						const pMap: Record<string, any> = {};
						f.parameters.forEach(p => { if (p.name) pMap[p.name] = p.defaultValue ?? ''; });
						defaultVal = pMap;
					} else if (f.type === 'browser') {
						defaultVal = f.defaultContent || f.defaultUrl || '';
					}
					if (defaultVal) {
						contextVariables[fKey] = defaultVal;
						contextVariables[this._cleanKey(fKey)] = defaultVal;
					}
				}
			}

			this.logService.info(`[TicketWorkflowRuntime] Running ticket '${ticketResult.ticketId}' with ${fieldsToRun.length} primitive(s)...`);

			let finalOutput: any = undefined;

			// Step-by-step sequential primitive execution
			for (const field of fieldsToRun) {
				if (isCancelled()) {
					throw new Error('Ticket execution cancelled by Stop request');
				}
				const stepStart = Date.now();
				const fieldLabel = field.label || field.id;
				const fieldType = field.type;

				// Record root fields title and description as explicit step results for complete visibility
				if (field.id === 'title') {
					const titleVal = inputOverrides['title'] || customMetadata['title'] || ticketResult.ticketName || '';
					stepResults.push({
						fieldId: field.id,
						fieldLabel: field.label || 'Title',
						fieldType: 'text',
						output: titleVal,
						status: 'success',
						durationMs: 0,
						details: {
							fieldLabel: field.label || 'Title',
							type: 'text',
							initialValue: titleVal,
							runtimeValue: titleVal,
							value: titleVal
						}
					});
					contextVariables['title'] = titleVal;
					continue;
				}
				if (field.id === 'description') {
					const descVal = inputOverrides['description'] || customMetadata['description'] || (field as any).defaultContent || '';
					stepResults.push({
						fieldId: field.id,
						fieldLabel: field.label || 'Description',
						fieldType: 'textarea',
						output: descVal,
						status: 'success',
						durationMs: 0,
						details: {
							fieldLabel: field.label || 'Description',
							type: 'textarea',
							initialValue: descVal,
							runtimeValue: descVal,
							value: descVal
						}
					});
					contextVariables['description'] = descVal;
					continue;
				}

				let stepOutput: any = undefined;
				let stepDetails: Record<string, any> = {};

				try {
					switch (fieldType) {
						case 'parameters': {
							// 1. Parameters Primitive: resolve runtime arguments, saved ticket parameters, and defaults
							const resolvedParams: Record<string, any> = {};
							let savedParamObj: Record<string, any> = {};
							const rawSavedParams = customMetadata[fieldLabel] ?? customMetadata[field.id];
							if (typeof rawSavedParams === 'string' && rawSavedParams.trim().startsWith('{')) {
								try {
									const parsed = JSON.parse(rawSavedParams.trim());
									if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
										savedParamObj = parsed;
									}
								} catch { }
							} else if (rawSavedParams && typeof rawSavedParams === 'object' && !Array.isArray(rawSavedParams)) {
								savedParamObj = rawSavedParams as Record<string, any>;
							}

							const lookupFromMap = (map: Record<string, any>, key?: string): any => {
								if (!key) return undefined;
								if (map[key] !== undefined) return map[key];
								const norm = key.trim().toLowerCase().replace(/_/g, ' ');
								for (const [mk, mv] of Object.entries(map)) {
									if (mk.trim().toLowerCase().replace(/_/g, ' ') === norm) {
										return mv;
									}
								}
								return undefined;
							};

							if (field.parameters && Array.isArray(field.parameters)) {
								for (const p of field.parameters) {
									const pKey = p.name || p.id;
									const overrideVal = lookupFromMap(inputOverrides, pKey) ?? lookupFromMap(inputOverrides, p.label);
									const savedVal = lookupFromMap(savedParamObj, pKey) ?? lookupFromMap(savedParamObj, p.label);
									const ctxVal = contextVariables[pKey];
									const val = overrideVal !== undefined
										? overrideVal
										: (savedVal !== undefined && savedVal !== ''
											? savedVal
											: (ctxVal !== undefined
												? ctxVal
												: (p.defaultValue ?? '')));
									resolvedParams[pKey] = val;
									contextVariables[pKey] = val;
									if (p.label) {
										contextVariables[p.label] = val;
									}
								}
							}
							customMetadata[fieldLabel] = JSON.stringify(resolvedParams);
							stepOutput = resolvedParams;
							contextVariables[fieldLabel] = resolvedParams;
							contextVariables[this._cleanKey(fieldLabel)] = resolvedParams;
							stepDetails = {
								parameters: resolvedParams,
								parameterCount: Object.keys(resolvedParams).length,
								schema: (field.parameters || []).map(p => ({ name: p.name || p.id, type: p.type, defaultValue: p.defaultValue }))
							};
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

							stepDetails = {
								targetUrl: targetUrl,
								requestedUrl: interpolatedUrl || targetUrl,
								content: stepOutput,
								contentLength: typeof stepOutput === 'string' ? stepOutput.length : 0,
								credentials: browserCreds || []
							};
							break;
						}

						case 'prompt': {
							// 3. AI Prompt Primitive: combine Pre-Injected Prompt (field.defaultContent) + User Prompt(s) in order, interpolate variables, and call LLM
							let preInjectedPrompt = (field.defaultContent || '').trim();
							const isUserInputVisible = field.promptUserInputVisible !== false;
							let userPrompt = isUserInputVisible ? (field.defaultUserPrompt || '').trim() : '';
							let userPrompts: string[] = (isUserInputVisible && Array.isArray(field.defaultUserPrompts) && field.defaultUserPrompts.length > 0)
								? [...field.defaultUserPrompts]
								: [];
							let legacySavedPrompt = '';
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
											if (parsed.preInjectedPrompt !== undefined && String(parsed.preInjectedPrompt).trim()) {
												preInjectedPrompt = String(parsed.preInjectedPrompt).trim();
											}
											if (isUserInputVisible) {
												if (Array.isArray(parsed.userPrompts)) {
													userPrompts = parsed.userPrompts.map((item: any) => String(item ?? ''));
												}
												if (parsed.userPrompt !== undefined) userPrompt = String(parsed.userPrompt).trim();
											}
											if (parsed.prompt !== undefined) legacySavedPrompt = String(parsed.prompt).trim();
											if (parsed.targetModel) promptModel = String(parsed.targetModel);
											if (parsed.targetProvider) promptProvider = String(parsed.targetProvider);
											if (parsed.output) existingPromptOutput = String(parsed.output);
										} catch {
											legacySavedPrompt = trimmed;
										}
									} else {
										legacySavedPrompt = trimmed;
									}
								} else if (typeof metaVal === 'object' && metaVal !== null) {
									if ((metaVal as any).preInjectedPrompt !== undefined && String((metaVal as any).preInjectedPrompt).trim()) {
										preInjectedPrompt = String((metaVal as any).preInjectedPrompt).trim();
									}
									if (isUserInputVisible) {
										if (Array.isArray((metaVal as any).userPrompts)) {
											userPrompts = (metaVal as any).userPrompts.map((item: any) => String(item ?? ''));
										}
										if ((metaVal as any).userPrompt !== undefined) userPrompt = String((metaVal as any).userPrompt).trim();
									}
									if ((metaVal as any).prompt !== undefined) legacySavedPrompt = String((metaVal as any).prompt).trim();
									if ((metaVal as any).targetModel) promptModel = String((metaVal as any).targetModel);
									if ((metaVal as any).targetProvider) promptProvider = String((metaVal as any).targetProvider);
									if ((metaVal as any).output) existingPromptOutput = String((metaVal as any).output);
								}
							}

							if (!userPrompt && legacySavedPrompt && legacySavedPrompt !== preInjectedPrompt && !legacySavedPrompt.startsWith(preInjectedPrompt)) {
								userPrompt = legacySavedPrompt;
							}

							const nonEmptyUserInputs = userPrompts.map(s => (s || '').trim()).filter(s => s.length > 0);
							let rawPrompt = '';
							if (nonEmptyUserInputs.length > 1 || (userPrompts.length > 1 && nonEmptyUserInputs.length >= 1)) {
								const multiBody = [
									`The user has provided ${nonEmptyUserInputs.length} separate input segment(s) in sequential order below. Please process all ${nonEmptyUserInputs.length} user input(s) together according to the instructions:`,
									'',
									...nonEmptyUserInputs.map((seg, idx) => `[User Input #${idx + 1} of ${nonEmptyUserInputs.length}]:\n${seg}`)
								].join('\n\n');
								userPrompt = nonEmptyUserInputs.map((seg, idx) => `[User Input #${idx + 1}]:\n${seg}`).join('\n\n');
								rawPrompt = preInjectedPrompt
									? `${preInjectedPrompt}\n\n--- [USER PROMPT INPUTS (${nonEmptyUserInputs.length} SEPARATE USER INPUTS IN ORDER)] ---\n${multiBody}`
									: `--- [USER PROMPT INPUTS (${nonEmptyUserInputs.length} SEPARATE USER INPUTS IN ORDER)] ---\n${multiBody}`;
							} else {
								const singleUser = nonEmptyUserInputs[0] || userPrompt;
								rawPrompt = (preInjectedPrompt && singleUser)
									? `${preInjectedPrompt}\n\n--- [USER PROMPT / INSTRUCTIONS] ---\n${singleUser}`
									: (preInjectedPrompt || singleUser || legacySavedPrompt);
							}

							const interpolatedPrompt = this._interpolateVariables(rawPrompt, contextVariables);

							this.logService.info(`[TicketWorkflowRuntime] Executing AI Prompt with model '${promptModel}' (provider: ${promptProvider || 'auto'})...`);
							let aiResponse = '';
							const directTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, customMetadata, false);
							if (directTableJson !== undefined) {
								this.logService.info(`[TicketWorkflowRuntime] Deterministically extracted full JSON array from referenced table for prompt '${fieldLabel}' (${directTableJson.length} chars).`);
								aiResponse = directTableJson;
							} else {
								try {
									aiResponse = await this._executePrompt(promptModel, interpolatedPrompt, promptProvider);
								} catch (promptErr) {
									this.logService.warn(`[TicketWorkflowRuntime] AI Prompt call failed, checking for existing output:`, promptErr);
								}
								if (!aiResponse || /"error"\s*:\s*"[^"]*(?:rows|records|preview|omitted|batches)/i.test(aiResponse) || aiResponse.startsWith('[AI ')) {
									const fallbackTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, customMetadata, true);
									if (fallbackTableJson !== undefined) {
										this.logService.info(`[TicketWorkflowRuntime] Recovered full table records after LLM truncation/error for '${fieldLabel}'.`);
										aiResponse = fallbackTableJson;
									}
								}
							}

							const nowIso = new Date().toISOString();
							stepOutput = aiResponse || existingPromptOutput || 'No output generated from AI model';
							customMetadata[fieldLabel] = JSON.stringify({
								userPrompt,
								userPrompts: userPrompts.length > 0 ? userPrompts : [userPrompt],
								preInjectedPrompt,
								prompt: rawPrompt,
								interpolatedPrompt: interpolatedPrompt,
								targetMode: field.targetMode || 'model',
								targetModel: promptModel,
								targetProvider: promptProvider,
								output: stepOutput,
								lastExecuted: nowIso,
								executedAt: nowIso,
								lastSentPayload: {
									model: promptModel,
									provider: promptProvider || 'auto',
									sentAt: nowIso,
									combinedPrompt: interpolatedPrompt
								}
							});
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;

							stepDetails = {
								rawPrompt: rawPrompt,
								sentPrompt: interpolatedPrompt,
								model: promptModel,
								provider: promptProvider || 'auto',
								response: stepOutput
							};
							break;
						}

						case 'tts': {
							// 3.5 Audio / TTS Primitive: check cached local MP3 file or synthesize speech via LLM API
							let rawText = field.defaultContent || '';
							let displayText = (field as any).ttsDisplayText || '';
							let targetCredId = field.targetCredentialId || '';
							let targetProvider = field.targetProvider || 'gemini';
							let targetModel = field.targetModel || (targetProvider === 'openai' ? 'tts-1' : 'gemini-2.5-flash-preview-tts');
							let ttsFormat = (field.ttsFormat || 'mp3').toLowerCase();
							let ttsVoice = field.ttsVoice || (targetProvider === 'openai' ? 'alloy' : 'Kore');
							let ttsAutoPlay = Boolean(field.ttsAutoPlay);
							let audioFileName = '';
							let audioRelativePath = '';
							let lastGenerated = '';
							let lastSynthesizedText = '';

							if (customMetadata[fieldLabel]) {
								const metaVal = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.text !== undefined) rawText = String(parsed.text);
											if (parsed.displayText !== undefined) displayText = String(parsed.displayText);
											else if (parsed.ttsDisplayText !== undefined) displayText = String(parsed.ttsDisplayText);
											if (parsed.targetCredentialId) targetCredId = String(parsed.targetCredentialId);
											if (parsed.targetProvider) targetProvider = String(parsed.targetProvider);
											if (parsed.targetModel) targetModel = String(parsed.targetModel);
											if (parsed.ttsFormat) ttsFormat = String(parsed.ttsFormat).toLowerCase();
											if (parsed.ttsVoice) ttsVoice = String(parsed.ttsVoice);
											if (parsed.ttsAutoPlay !== undefined) ttsAutoPlay = Boolean(parsed.ttsAutoPlay);
											if (parsed.audioFileName) audioFileName = String(parsed.audioFileName);
											if (parsed.audioRelativePath) audioRelativePath = String(parsed.audioRelativePath);
											if (parsed.lastGenerated) lastGenerated = String(parsed.lastGenerated);
											if (parsed.lastSynthesizedText !== undefined) lastSynthesizedText = String(parsed.lastSynthesizedText);
										} catch {
											rawText = trimmed;
										}
									} else {
										rawText = trimmed;
									}
								}
							}

							const effectiveSynthSource = rawText.trim() ? rawText : displayText;
							const interpolatedText = this._interpolateVariables(effectiveSynthSource, contextVariables).trim();

							// Check if MP3 already exists on disk and text has not changed
							let isCachedOnDisk = false;
							if (audioRelativePath && interpolatedText && lastSynthesizedText === interpolatedText) {
								const existingAudioUri = URI.joinPath(ticketUri, audioRelativePath);
								if (await this.fileService.exists(existingAudioUri)) {
									isCachedOnDisk = true;
								}
							}

							if (isCachedOnDisk) {
								this.logService.info(`[TicketWorkflowRuntime] Reusing existing saved TTS audio '${audioRelativePath}' without repeating LLM API call.`);
								stepOutput = audioRelativePath;
							} else if (interpolatedText) {
								const credService = this.instantiationService.invokeFunction(accessor => {
									try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
								});
								if (credService && credService.synthesizeSpeech) {
									const ttsRes = await credService.synthesizeSpeech({
										text: interpolatedText,
										modelId: targetModel,
										credentialId: targetCredId || undefined,
										providerId: targetProvider,
										format: ttsFormat,
										voice: ttsVoice
									});
									if (ttsRes.success && ttsRes.audioBuffer) {
										const attachDir = URI.joinPath(ticketUri, 'attachments');
										if (!(await this.fileService.exists(attachDir))) {
											await this.fileService.createFolder(attachDir);
										}
										const safeKey = this._cleanKey(fieldLabel) || 'tts_audio';
										audioFileName = `tts_${safeKey}.${ttsFormat}`;
										audioRelativePath = `attachments/${audioFileName}`;
										const audioUri = URI.joinPath(ticketUri, audioRelativePath);
										await this.fileService.writeFile(audioUri, VSBuffer.wrap(ttsRes.audioBuffer));
										lastGenerated = new Date().toISOString();
										lastSynthesizedText = interpolatedText;
										stepOutput = audioRelativePath;
									} else {
										stepOutput = `[TTS Error: ${ttsRes.error || 'Synthesis failed'}]`;
									}
								} else {
									stepOutput = '[TTS Error: Credential service unavailable]';
								}
							} else {
								stepOutput = '[TTS Skipped: Empty text]';
							}

							customMetadata[fieldLabel] = JSON.stringify({
								text: rawText,
								displayText: displayText,
								ttsShowSpeechTextInTicket: Boolean((field as any).ttsShowSpeechTextInTicket),
								targetCredentialId: targetCredId,
								targetProvider,
								targetModel,
								ttsFormat,
								ttsVoice,
								ttsAutoPlay,
								audioFileName,
								audioRelativePath,
								lastGenerated,
								lastSynthesizedText
							});
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;

							stepDetails = {
								text: interpolatedText,
								model: targetModel,
								provider: targetProvider,
								format: ttsFormat,
								audioFile: audioRelativePath,
								cached: isCachedOnDisk
							};
							break;
						}

						case 'media_player': {
							let mediaFilePath = field.mediaFilePath || '';
							let mediaFileName = field.mediaFileName || '';
							let mediaPlaybackRate = typeof field.mediaPlaybackRate === 'number' ? field.mediaPlaybackRate : 1.0;
							let mediaAutoPlay = Boolean(field.mediaAutoPlay);
							let mediaMimeType = field.mediaMimeType || '';

							if (customMetadata[fieldLabel]) {
								const metaVal = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.mediaFilePath !== undefined) mediaFilePath = String(parsed.mediaFilePath);
											else if (parsed.filePath !== undefined) mediaFilePath = String(parsed.filePath);
											if (parsed.mediaFileName !== undefined) mediaFileName = String(parsed.mediaFileName);
											else if (parsed.fileName !== undefined) mediaFileName = String(parsed.fileName);
											if (parsed.mediaMimeType !== undefined) mediaMimeType = String(parsed.mediaMimeType);
											if (typeof parsed.mediaPlaybackRate === 'number') mediaPlaybackRate = parsed.mediaPlaybackRate;
											if (parsed.mediaAutoPlay !== undefined) mediaAutoPlay = Boolean(parsed.mediaAutoPlay);
										} catch {
											mediaFilePath = trimmed;
										}
									} else {
										mediaFilePath = trimmed;
									}
								}
							}

							const interpolatedPath = this._interpolateVariables(mediaFilePath, contextVariables).trim();
							const resolvedName = mediaFileName || (interpolatedPath ? (interpolatedPath.split(/[\\/]/).pop() || interpolatedPath) : '');
							const detected = detectMediaFileInfo(resolvedName || interpolatedPath, mediaMimeType);
							stepOutput = interpolatedPath || resolvedName || '';

							customMetadata[fieldLabel] = JSON.stringify({
								mediaFilePath: interpolatedPath,
								mediaFileName: resolvedName,
								mediaKind: detected.kind,
								mediaMimeType: detected.mimeType,
								mediaPlaybackRate,
								mediaAutoPlay
							});
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;

							stepDetails = {
								filePath: interpolatedPath,
								fileName: resolvedName,
								mediaKind: detected.kind,
								mimeType: detected.mimeType,
								playbackRate: mediaPlaybackRate
							};
							break;
						}

						case 'python': {
							// 4. Python Primitive: execute automation script using specified interpreter or virtualenv
							let rawCode = field.pythonCode || '';
							let pythonPath = field.pythonPath || '';
							let existingOutput = '';
							let externalScripts: string[] = Array.isArray(field.externalScripts) ? [...field.externalScripts] : [];

							const rawMetaVal = customMetadata[fieldLabel];
							if (rawMetaVal) {
								if (typeof rawMetaVal === 'string') {
									const trimmed = rawMetaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.code !== undefined) rawCode = String(parsed.code);
											if (parsed.pythonCode !== undefined) rawCode = String(parsed.pythonCode);
											if (parsed.pythonPath !== undefined) pythonPath = String(parsed.pythonPath);
											if (parsed.output !== undefined) existingOutput = String(parsed.output);
											if (Array.isArray(parsed.externalScripts)) externalScripts = parsed.externalScripts;
										} catch {
											rawCode = trimmed;
										}
									} else {
										rawCode = trimmed;
									}
								} else if (typeof rawMetaVal === 'object' && rawMetaVal !== null) {
									if ((rawMetaVal as any).code !== undefined) rawCode = String((rawMetaVal as any).code);
									if ((rawMetaVal as any).pythonCode !== undefined) rawCode = String((rawMetaVal as any).pythonCode);
									if ((rawMetaVal as any).pythonPath !== undefined) {
										const p = (rawMetaVal as any).pythonPath;
										if (typeof p === 'object' && p !== null) {
											pythonPath = String(p.interpreterPath || p.pythonPath || '');
										} else {
											const s = String(p);
											pythonPath = s === '[object Object]' ? '' : s;
										}
									}
									if ((rawMetaVal as any).output !== undefined) existingOutput = String((rawMetaVal as any).output);
									if (Array.isArray((rawMetaVal as any).externalScripts)) {
										externalScripts = (rawMetaVal as any).externalScripts;
									}
								}
							}

							if (!rawCode && field.defaultContent) {
								rawCode = field.defaultContent;
							}

							const interpolatedCode = this._interpolateVariables(rawCode, contextVariables);

							this.logService.info(`[TicketWorkflowRuntime] Executing Python primitive '${fieldLabel}'...`);
							const execResult = await this.executePythonScript(wsUri, ticketUri, pythonPath, interpolatedCode, contextVariables, externalScripts);

							const returnVal = execResult.result !== undefined ? execResult.result : (execResult.output || existingOutput || 'Script completed with no output.');
							stepOutput = returnVal;
							customMetadata[fieldLabel] = JSON.stringify({
								pythonPath: execResult.pythonPath || pythonPath,
								externalScripts,
								code: rawCode,
								interpolatedCode: interpolatedCode,
								result: execResult.result,
								output: execResult.output,
								exitCode: execResult.exitCode,
								durationMs: execResult.durationMs,
								lastExecuted: new Date().toISOString()
							});
							contextVariables[fieldLabel] = returnVal;
							contextVariables[this._cleanKey(fieldLabel)] = returnVal;
							contextVariables[`${this._cleanKey(fieldLabel)}_result`] = execResult.result;
							contextVariables[`${this._cleanKey(fieldLabel)}_output`] = returnVal;
							contextVariables[`${this._cleanKey(fieldLabel)}_logs`] = execResult.output;
							contextVariables[`${this._cleanKey(fieldLabel)}_code`] = rawCode;

							stepDetails = {
								pythonPath: execResult.pythonPath || pythonPath,
								rawCode: rawCode,
								executedCode: interpolatedCode,
								commandLogs: execResult.output, // stdout & stderr
								result: execResult.result,
								exitCode: execResult.exitCode,
								durationMs: execResult.durationMs
							};
							break;
						}

						case 'table': {
							// 4.5 Data Table (SQLite / Structured Grid) Primitive
							let tableColumns: ITableColumnDefinition[] = Array.isArray(field.tableColumns) ? [...field.tableColumns] : [];
							let tableRows: Record<string, any>[] = Array.isArray(field.tableRows) ? [...field.tableRows] : [];
							let dbEngine: 'sqlite' | 'none' = field.tableDbEngine || 'sqlite';
							let dbPath = field.tableDbPath || '';
							let dbTableName = field.tableDbTableName || this._cleanKey(fieldLabel) || 'ticket_table';
							let autoSyncDb = Boolean(field.tableAutoSyncDb);
							let sqlQuery = field.tableSqlQuery || '';

							const rawTableMeta = customMetadata[fieldLabel];
							if (rawTableMeta) {
								if (typeof rawTableMeta === 'string') {
									const trimmed = rawTableMeta.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (Array.isArray(parsed.columns)) tableColumns = parsed.columns;
											if (Array.isArray(parsed.rows)) tableRows = parsed.rows;
											if (parsed.dbEngine) dbEngine = parsed.dbEngine;
											if (parsed.dbPath !== undefined) dbPath = String(parsed.dbPath);
											if (parsed.tableName !== undefined) dbTableName = String(parsed.tableName);
											if (parsed.autoSyncDb !== undefined) autoSyncDb = Boolean(parsed.autoSyncDb);
											if (parsed.sqlQuery !== undefined) sqlQuery = String(parsed.sqlQuery);
										} catch { }
									}
								} else if (typeof rawTableMeta === 'object' && rawTableMeta !== null) {
									if (Array.isArray((rawTableMeta as any).columns)) tableColumns = (rawTableMeta as any).columns;
									if (Array.isArray((rawTableMeta as any).rows)) tableRows = (rawTableMeta as any).rows;
									if ((rawTableMeta as any).dbEngine) dbEngine = (rawTableMeta as any).dbEngine;
									if ((rawTableMeta as any).dbPath !== undefined) dbPath = String((rawTableMeta as any).dbPath);
									if ((rawTableMeta as any).tableName !== undefined) dbTableName = String((rawTableMeta as any).tableName);
									if ((rawTableMeta as any).autoSyncDb !== undefined) autoSyncDb = Boolean((rawTableMeta as any).autoSyncDb);
									if ((rawTableMeta as any).sqlQuery !== undefined) sqlQuery = String((rawTableMeta as any).sqlQuery);
								}
							}

							const rawDbTableName = dbTableName.trim();
							const isParamTableExpr = /\{[^{}]+\}/.test(rawDbTableName);
							const resolvedDbPath = this._interpolateVariables(dbPath.trim(), contextVariables).trim() || dbPath.trim();
							let resolvedTableName = this._interpolateVariables(rawDbTableName, contextVariables).trim();
							if (!resolvedTableName || /\{[^{}]+\}/.test(resolvedTableName)) {
								resolvedTableName = rawDbTableName.replace(/\{|\}/g, '').trim();
							}
							resolvedTableName = resolvedTableName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'ticket_table';
							const hasConfiguredSqlQuery = Boolean(sqlQuery && sqlQuery.trim());

							let sqliteSyncResult: ISqliteTableOperationResult | undefined;
							if (dbEngine === 'sqlite' && resolvedDbPath && resolvedTableName) {
								if (hasConfiguredSqlQuery) {
									// When sqlQuery is configured, execute the SQL statement according to its own semantics
									// (INSERT, SELECT, UPDATE, DELETE) without pre-syncing static tableRows into SQLite.
									if ((isParamTableExpr || autoSyncDb) && tableColumns.length > 0) {
										const inspectRes = await this.executeSqliteTableOperation({
											workspaceUri: wsUri,
											ticketUri,
											dbPath: resolvedDbPath,
											tableName: resolvedTableName,
											action: 'inspect_schema'
										});
										if (inspectRes.success && !inspectRes.tableExists) {
											const createRes = await this.executeSqliteTableOperation({
												workspaceUri: wsUri,
												ticketUri,
												dbPath: resolvedDbPath,
												tableName: resolvedTableName,
												action: 'update_header',
												columns: tableColumns,
												rows: []
											});
											if (createRes.success) {
												sqliteSyncResult = createRes;
											}
										}
									}
								} else {
									// Never auto-push static template/ticket tableRows into an external SQLite database on workflow run.
									// Instead, inspect the SQLite table: if it exists, load its current schema & rows; if not, create empty header when configured.
									const inspectRes = await this.executeSqliteTableOperation({
										workspaceUri: wsUri,
										ticketUri,
										dbPath: resolvedDbPath,
										tableName: resolvedTableName,
										action: 'inspect_schema'
									});
									if (inspectRes.success && inspectRes.tableExists) {
										if (Array.isArray(inspectRes.columns) && inspectRes.columns.length > 0) {
											tableColumns = inspectRes.columns;
										}
										const loadRes = await this.executeSqliteTableOperation({
											workspaceUri: wsUri,
											ticketUri,
											dbPath: resolvedDbPath,
											tableName: resolvedTableName,
											action: 'load'
										});
										if (loadRes.success) {
											if (Array.isArray(loadRes.columns) && loadRes.columns.length > 0) {
												tableColumns = loadRes.columns;
											}
											if (Array.isArray(loadRes.rows)) {
												tableRows = loadRes.rows;
											}
											sqliteSyncResult = loadRes;
										}
									} else if ((isParamTableExpr || autoSyncDb) && tableColumns.length > 0) {
										const createRes = await this.executeSqliteTableOperation({
											workspaceUri: wsUri,
											ticketUri,
											dbPath: resolvedDbPath,
											tableName: resolvedTableName,
											action: 'update_header',
											columns: tableColumns,
											rows: []
										});
										if (createRes.success) {
											sqliteSyncResult = createRes;
										}
									}
								}
							}

							let sqlOutputText = '';
							if (sqlQuery.trim()) {
								let interpolatedSql = this._interpolateVariables(sqlQuery.trim(), contextVariables);
								if (isParamTableExpr && rawDbTableName && interpolatedSql.includes(rawDbTableName)) {
									interpolatedSql = interpolatedSql.split(rawDbTableName).join(resolvedTableName);
								}
								const cleanedInterpolatedSql = interpolatedSql
									.replace(/^```(?:sql|sqlite|sqlite3)?\s*\n?/i, '')
									.replace(/\n?```\s*$/i, '')
									.trim();
								const sqlStartMs = Date.now();
								const sqlRes = await this.executeSqliteTableOperation({
									workspaceUri: wsUri,
									ticketUri,
									dbPath: resolvedDbPath,
									tableName: resolvedTableName,
									action: 'query',
									columns: tableColumns,
									rows: tableRows,
									sqlQuery: cleanedInterpolatedSql || interpolatedSql
								});
								const elapsedSec = ((Date.now() - sqlStartMs) / 1000).toFixed(1);
								if (sqlRes.success) {
									// Never overwrite tableColumns with arbitrary query result columns (e.g. PRAGMA or partial SELECT).
									// Always synchronize tableColumns from the actual SQLite table schema (sqlRes.columns / sqlRes.tableExists).
									if (sqlRes.tableExists === false) {
										tableColumns = [];
									} else if (Array.isArray(sqlRes.columns) && sqlRes.columns.length > 0) {
										tableColumns = sqlRes.columns;
									}
									if (sqlRes.isSelectQuery && !sqlRes.isPragmaQuery && Array.isArray(sqlRes.queryRows)) {
										tableRows = sqlRes.queryRows;
									} else if (!sqlRes.isPragmaQuery && Array.isArray(sqlRes.rows)) {
										tableRows = sqlRes.rows;
									} else if (sqlRes.isPragmaQuery) {
										tableRows = [];
									}
									sqliteSyncResult = sqlRes;
									const summaryLines: string[] = [
										`Status: SUCCESS (${elapsedSec}s)`,
										`Database: ${resolvedDbPath || ':memory:'}`,
										`Target Table: ${resolvedTableName}${rawDbTableName && rawDbTableName !== resolvedTableName ? ` (resolved from ${rawDbTableName})` : ''}`,
										`Result: ${sqlRes.message || 'SQL statement executed successfully.'}`,
										'',
										'--- [Resolved SQL Statement] ---',
										cleanedInterpolatedSql || interpolatedSql
									];
									if (sqlRes.isSelectQuery && Array.isArray(sqlRes.queryRows)) {
										if (!sqlRes.isPragmaQuery && sqlRes.queryRows.length > 10) {
											const previewSlice = sqlRes.queryRows.slice(0, 10);
											const omittedCount = sqlRes.queryRows.length - previewSlice.length;
											summaryLines.push('', `--- [Query Rows Preview (Showing first ${previewSlice.length} of ${sqlRes.queryRows.length} row(s))] ---`);
											summaryLines.push(JSON.stringify(previewSlice, null, 2));
											summaryLines.push(`... (${omittedCount} more row(s) omitted in text preview; all ${sqlRes.queryRows.length} rows are preserved in runtime data)`);
										} else {
											summaryLines.push('', `--- [Query Rows Preview (${sqlRes.queryRows.length} row(s))] ---`);
											summaryLines.push(JSON.stringify(sqlRes.queryRows, null, 2));
										}
									}
									sqlOutputText = summaryLines.join('\n');
								} else {
									sqlOutputText = [
										`Status: FAILED (${elapsedSec}s)`,
										`Database: ${resolvedDbPath || ':memory:'}`,
										`Target Table: ${resolvedTableName}`,
										`SQL Error: ${sqlRes.error || 'Execution failed'}`,
										'',
										'--- [Resolved SQL Statement] ---',
										cleanedInterpolatedSql || interpolatedSql
									].join('\n');
								}
							} else if (sqliteSyncResult) {
								sqlOutputText = sqliteSyncResult.message || JSON.stringify(sqliteSyncResult.rows || []);
							}

							const tablePayload = {
								columns: tableColumns,
								rows: tableRows,
								dbEngine,
								dbPath,
								tableName: dbTableName,
								autoSyncDb,
								sqlQuery,
								sqlOutput: sqlOutputText,
								output: sqlOutputText || JSON.stringify(tableRows),
								lastSynced: sqliteSyncResult?.success ? new Date().toISOString() : undefined
							};
							customMetadata[fieldLabel] = JSON.stringify(tablePayload);
							stepOutput = sqlOutputText || tableRows;
							contextVariables[fieldLabel] = tablePayload;
							contextVariables[this._cleanKey(fieldLabel)] = tablePayload;
							contextVariables[`${this._cleanKey(fieldLabel)}_output`] = sqlOutputText;
							contextVariables[`${this._cleanKey(fieldLabel)}_rows`] = tableRows;
							contextVariables[`${this._cleanKey(fieldLabel)}_columns`] = tableColumns;
							contextVariables[`${this._cleanKey(fieldLabel)}_db_path`] = dbPath;
							contextVariables[`${this._cleanKey(fieldLabel)}_table_name`] = dbTableName;

							stepDetails = {
								columns: tableColumns,
								rowCount: tableRows.length,
								dbEngine,
								dbPath,
								tableName: dbTableName,
								sqliteSync: sqliteSyncResult
							};
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
								for (const sr of stepResults) {
									if (sr.fieldType !== 'output' && sr.fieldType !== 'result' && sr.fieldLabel && sr.output !== undefined) {
										aggregatedMap[sr.fieldLabel] = sr.output;
									}
								}
								stepOutput = Object.keys(aggregatedMap).length > 0
									? aggregatedMap
									: (contextVariables['prompt'] || contextVariables['AI Prompt 1'] || contextVariables['browser'] || contextVariables['Browser 1'] || 'Processed successfully');
								finalOutput = stepOutput;
							}

							if (field.id && fieldLabel && field.id.toLowerCase().replace(/_/g, ' ') !== fieldLabel.toLowerCase().replace(/_/g, ' ')) {
								for (const existingKey of Object.keys(customMetadata)) {
									const ekNorm = existingKey.toLowerCase().replace(/_/g, ' ');
									if (existingKey.toLowerCase() === field.id.toLowerCase() || ekNorm === field.id.toLowerCase().replace(/_/g, ' ')) {
										delete customMetadata[existingKey];
									}
								}
							}
							delete customMetadata['outputSpecs'];
							delete customMetadata['output_specs'];
							const outputPayloadToPersist = (typeof stepOutput === 'object' && stepOutput !== null && !Array.isArray(stepOutput))
								? { ...stepOutput, lastUpdated: new Date().toISOString() }
								: stepOutput;
							customMetadata[fieldLabel] = typeof outputPayloadToPersist === 'object' ? JSON.stringify(outputPayloadToPersist) : String(outputPayloadToPersist);
							contextVariables[fieldLabel] = stepOutput;
							contextVariables['output'] = stepOutput;

							stepDetails = {
								outputSpecs: field.outputSpecs || [],
								aggregatedOutputs: aggregatedMap
							};
							break;
						}

						case 'create_tickets': {
							const tType = this._interpolateVariables(field.wfTicketType || 'Task', contextVariables).trim();
							const tTitle = this._interpolateVariables(field.wfTicketTitle || `Ticket ${fieldLabel}`, contextVariables).trim();
							const tPath = this._interpolateVariables(field.wfTicketPath || '.', contextVariables).trim();
							const resolvedParams: Record<string, any> = {};
							if (field.wfTicketParams && typeof field.wfTicketParams === 'object') {
								for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
									if (pv === undefined || pv === '') continue;
									const singleVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
									resolvedParams[pk] = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
										? contextVariables[singleVar[1].trim()]
										: this._interpolateVariables(String(pv), contextVariables);
								}
							}
							const createdRes = await this.createTicket({
								workspaceUri: wsUri,
								targetPath: tPath,
								ticketType: tType,
								title: tTitle,
								parameters: resolvedParams
							});
							stepOutput = createdRes;
							contextVariables[fieldLabel] = createdRes;
							contextVariables[this._cleanKey(fieldLabel)] = createdRes;
							customMetadata[fieldLabel] = JSON.stringify(createdRes);
							stepDetails = { ticketType: tType, title: tTitle, path: tPath, parameters: resolvedParams, createdTicket: createdRes };
							break;
						}

						case 'run_tickets': {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
							let resolvedTarget: any = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(rawTarget, contextVariables).trim();
							if (resolvedTarget && typeof resolvedTarget === 'object') {
								resolvedTarget = resolvedTarget.ticketId || resolvedTarget.entityUri || resolvedTarget.ticketName || '';
							}
							const resolvedParams: Record<string, any> = {};
							if (field.wfTicketParams && typeof field.wfTicketParams === 'object') {
								for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
									if (pv === undefined || pv === '') continue;
									const pVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
									resolvedParams[pk] = (pVar && contextVariables[pVar[1].trim()] !== undefined)
										? contextVariables[pVar[1].trim()]
										: this._interpolateVariables(String(pv), contextVariables);
								}
							}
							const runRes = await this.runTicket({
								workspaceUri: wsUri,
								ticketIdOrPath: String(resolvedTarget || ''),
								inputParams: { ...contextVariables, ...resolvedParams }
							});
							stepOutput = runRes;
							contextVariables[fieldLabel] = runRes;
							contextVariables[this._cleanKey(fieldLabel)] = runRes;
							customMetadata[fieldLabel] = JSON.stringify({ ticketId: runRes.ticketId, status: runRes.status, output: runRes.output });
							stepDetails = { targetTicket: resolvedTarget, parameters: resolvedParams, result: runRes };
							break;
						}

						case 'get_outputs': {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
							const resolvedTarget: any = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(rawTarget, contextVariables).trim();
							const outMap = await this.getOutputs(wsUri, resolvedTarget);
							stepOutput = outMap;
							contextVariables[fieldLabel] = outMap;
							contextVariables[this._cleanKey(fieldLabel)] = outMap;
							customMetadata[fieldLabel] = JSON.stringify(outMap);
							stepDetails = { targetTicket: resolvedTarget, outputs: outMap };
							break;
						}

						case 'get_tickets': {
							const querySpec: Record<string, any> = {};
							if (field.wfTicketType) querySpec.ticket_type = this._interpolateVariables(field.wfTicketType, contextVariables).trim();
							if (field.wfTicketStatus) querySpec.status = this._interpolateVariables(field.wfTicketStatus, contextVariables).trim();
							if (field.wfTicketTitle) querySpec.title = this._interpolateVariables(field.wfTicketTitle, contextVariables).trim();
							if (field.wfTicketPath) querySpec.path = this._interpolateVariables(field.wfTicketPath, contextVariables).trim();
							const foundRes = await this.getTickets(wsUri, querySpec);
							stepOutput = foundRes;
							contextVariables[fieldLabel] = foundRes;
							contextVariables[this._cleanKey(fieldLabel)] = foundRes;
							customMetadata[fieldLabel] = JSON.stringify(foundRes);
							stepDetails = { filter: querySpec, result: foundRes };
							break;
						}

						case 'display': {
							const rawDisp = (field.wfDisplayValue || '').trim();
							const singleVar = rawDisp.match(/^\{([^{}]+)\}$/);
							const resolvedVal = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(rawDisp, contextVariables);
							stepOutput = resolvedVal;
							stepDetails = { displayExpr: rawDisp, value: resolvedVal };
							break;
						}

						default: {
							// 5. Standard field (text, textarea, number, select, multiselect, date, switch, classes, etc.)
							const rawVal = inputOverrides[fieldLabel] !== undefined
								? inputOverrides[fieldLabel]
								: (customMetadata[fieldLabel] !== undefined ? customMetadata[fieldLabel] : (field.defaultContent || ''));
							const resolvedVal = typeof rawVal === 'string'
								? this._interpolateVariables(rawVal, contextVariables)
								: rawVal;
							stepOutput = resolvedVal;
							contextVariables[fieldLabel] = resolvedVal;
							contextVariables[this._cleanKey(fieldLabel)] = resolvedVal;

							stepDetails = {
								fieldLabel: fieldLabel,
								type: fieldType,
								initialValue: rawVal,
								runtimeValue: resolvedVal,
								value: resolvedVal,
								options: (field as any).options,
								defaultValue: (field as any).defaultValue
							};
							break;
						}
					}

					if (stepOutput !== undefined) {
						const outVarName = (field.outputVariableName || '').trim() || generateSmartPythonVarName(fieldLabel, fieldType);
						if (outVarName && fieldType !== 'parameters' && fieldType !== 'output' && fieldType !== 'result' && fieldType !== 'display') {
							contextVariables[outVarName] = stepOutput;
						}
						if (field.id) {
							contextVariables[field.id] = stepOutput;
						}
						const prevLabels = Array.isArray((field as any).previousLabels) ? (field as any).previousLabels : [];
						for (const pl of prevLabels) {
							if (pl && typeof pl === 'string') {
								contextVariables[pl] = stepOutput;
								contextVariables[this._cleanKey(pl)] = stepOutput;
							}
						}
					}

					stepResults.push({
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						output: stepOutput,
						status: 'success',
						durationMs: Date.now() - stepStart,
						details: stepDetails
					});
				} catch (stepErr: any) {
					if (isCancelled()) {
						throw stepErr;
					}
					this.logService.error(`[TicketWorkflowRuntime] Step '${fieldLabel}' failed:`, stepErr);
					stepResults.push({
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						status: 'failed',
						error: stepErr.message || String(stepErr),
						durationMs: Date.now() - stepStart,
						details: stepDetails
					});
				}
			}

			if (isCancelled()) {
				throw new Error('Ticket execution cancelled by Stop request');
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

			const outField = schema?.fields?.find(f => f.type === 'output' || f.type === 'result');
			return {
				success: true,
				ticketId: ticketResult.ticketId,
				ticketName: ticketResult.ticketName,
				title: ticketResult.title,
				ticketType: ticketResult.ticketType,
				entityUri: ticketResult.entityUri,
				status: 'success',
				output: finalOutput,
				outputSpecs: outField?.outputSpecs || [],
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

	async executeNodeComponent(
		workspaceUri: string | URI,
		workingDirUri: string | URI,
		field: ICustomField,
		contextVariables: Record<string, any>
	): Promise<IPrimitiveExecutionStepResult> {
		const stepStart = Date.now();
		const executedAt = new Date().toLocaleTimeString();
		const wsUri = typeof workspaceUri === 'string' ? URI.parse(workspaceUri) : workspaceUri;
		const workUri = typeof workingDirUri === 'string' ? URI.parse(workingDirUri) : workingDirUri;
		const fieldLabel = (field.label || field.id || field.type || 'Component').trim();
		const fieldType = field.type;
		let stepOutput: any = undefined;
		let stepDetails: Record<string, any> | undefined = undefined;

		const describeRuntimeValue = (val: any): { typeTag: string; preview: string } => {
			if (val === null || val === undefined) {
				return { typeTag: 'None', preview: 'None' };
			}
			if (Array.isArray(val)) {
				const jsonStr = JSON.stringify(val, null, 2);
				return {
					typeTag: `list (${val.length} item${val.length === 1 ? '' : 's'})`,
					preview: jsonStr.length > 4000 ? jsonStr.substring(0, 4000) + '\n... [truncated]' : jsonStr
				};
			}
			if (typeof val === 'object') {
				const keys = Object.keys(val);
				const jsonStr = JSON.stringify(val, null, 2);
				return {
					typeTag: `dict (${keys.length} key${keys.length === 1 ? '' : 's'})`,
					preview: jsonStr.length > 4000 ? jsonStr.substring(0, 4000) + '\n... [truncated]' : jsonStr
				};
			}
			const strVal = String(val);
			return {
				typeTag: `${typeof val}${typeof val === 'string' ? ` (${strVal.length} chars)` : ''}`,
				preview: strVal.length > 4000 ? strVal.substring(0, 4000) + '\n... [truncated]' : strVal
			};
		};

		try {
			const startEpoch = this._cancelEpoch;
			const ensureNotCancelled = () => {
				if (this._cancelEpoch !== startEpoch) {
					throw new Error('Component execution cancelled by Stop request');
				}
			};
			ensureNotCancelled();
			switch (fieldType) {
				case 'parameters': {
					const resolvedParams: Record<string, any> = {};
					const traceLines: string[] = [
						`>>> Executing Component [INPUTS]: "${fieldLabel}"`,
						`Timestamp: ${executedAt}`
					];
					if (Array.isArray(field.parameters)) {
						for (const p of field.parameters) {
							const pKey = (p.name || p.id || '').trim();
							if (!pKey) continue;
							const rawDef = p.defaultValue ?? '';
							const singleVar = typeof rawDef === 'string' ? rawDef.trim().match(/^\{([^{}]+)\}$/) : null;
							let val: any;
							if (singleVar && contextVariables[singleVar[1].trim()] !== undefined) {
								val = contextVariables[singleVar[1].trim()];
							} else if (typeof rawDef === 'string' && rawDef.includes('{')) {
								val = this._interpolateVariables(rawDef, contextVariables);
							} else if (rawDef !== '' && rawDef !== undefined) {
								val = rawDef;
							} else if (contextVariables[pKey] !== undefined) {
								val = contextVariables[pKey];
							} else {
								val = '';
							}
							resolvedParams[pKey] = val;
							contextVariables[pKey] = val;
							const desc = describeRuntimeValue(val);
							traceLines.push(`\n• ${pKey} <= ${rawDef || `(context['${pKey}'])`}  [Type: ${desc.typeTag}]`);
							traceLines.push(desc.preview);
						}
					}
					stepOutput = resolvedParams;
					contextVariables['Parameters'] = { ...(contextVariables['Parameters'] || {}), ...resolvedParams };
					contextVariables['Inputs'] = { ...(contextVariables['Inputs'] || {}), ...resolvedParams };
					contextVariables[fieldLabel] = resolvedParams;
					contextVariables[this._cleanKey(fieldLabel)] = resolvedParams;
					stepDetails = { parameters: resolvedParams };
					(field as any).lastExecutionLog = traceLines.join('\n');
					(field as any).lastExecutionOutput = resolvedParams;
					break;
				}
				case 'prompt': {
					const preInjected = (field.defaultContent || '').trim();
					const userPromptList = Array.isArray((field as any).defaultUserPrompts) && (field as any).defaultUserPrompts.length > 0
						? (field as any).defaultUserPrompts.map((s: string) => (s || '').trim()).filter(Boolean)
						: ((field.defaultUserPrompt || '').trim() ? [(field.defaultUserPrompt || '').trim()] : []);
					const userPrompt = userPromptList.join('\n\n');
					const rawPrompt = (preInjected && userPrompt)
						? `${preInjected}\n\n--- [USER PROMPT / INSTRUCTIONS] ---\n${userPrompt}`
						: (preInjected || userPrompt);
					const interpolatedPrompt = this._interpolateVariables(rawPrompt, contextVariables);
					const promptModel = field.targetModel || 'gemini-1.5-flash';
					const promptProvider = field.targetProvider;
					let rawAiResp = '';
					const directTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, undefined, false);
					if (directTableJson !== undefined) {
						rawAiResp = directTableJson;
					} else {
						rawAiResp = await this._executePrompt(promptModel, interpolatedPrompt, promptProvider);
						if (!rawAiResp || /"error"\s*:\s*"[^"]*(?:rows|records|preview|omitted|batches)/i.test(rawAiResp) || rawAiResp.startsWith('[AI ')) {
							const fallbackTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, undefined, true);
							if (fallbackTableJson !== undefined) {
								rawAiResp = fallbackTableJson;
							}
						}
					}
					let parsedOutput: any = rawAiResp;
					if (typeof rawAiResp === 'string') {
						let candidateJson = rawAiResp.trim();
						if (candidateJson.startsWith('```')) {
							candidateJson = candidateJson.replace(/^```(?:json)?\s*\r?\n?/i, '').replace(/\r?\n?```\s*$/, '').trim();
						}
						if ((candidateJson.startsWith('{') && candidateJson.endsWith('}')) || (candidateJson.startsWith('[') && candidateJson.endsWith(']'))) {
							try {
								parsedOutput = JSON.parse(candidateJson);
							} catch {
								parsedOutput = rawAiResp;
							}
						}
					}
					stepOutput = parsedOutput;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					const formattedResp = typeof rawAiResp === 'string' ? rawAiResp : JSON.stringify(stepOutput, null, 2);
					field.debugPromptOutput = formattedResp;
					(field as any).lastSentPrompt = interpolatedPrompt;
					(field as any).lastExecutionLog = formattedResp;
					(field as any).lastExecutionOutput = stepOutput;
					stepDetails = { model: promptModel, provider: promptProvider, prompt: interpolatedPrompt, response: stepOutput };
					break;
				}
				case 'python': {
					const rawCode = field.pythonCode || field.defaultValue || field.defaultContent || '';
					const interpolatedCode = this._interpolateVariables(rawCode, contextVariables);
					const pyRes = await this.executePythonScript(wsUri, workUri, field.pythonPath || '', interpolatedCode, contextVariables, field.externalScripts);
					stepOutput = pyRes.result !== undefined ? pyRes.result : pyRes.output;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					field.pythonOutput = pyRes.output ? pyRes.output : '(Script pipeline completed with no stdout/stderr output)';
					field.pythonResult = pyRes.result;
					(field as any).lastExecutionLog = field.pythonOutput;
					(field as any).lastExecutionOutput = stepOutput;
					(field as any).lastExecutionExitCode = pyRes.exitCode;
					(field as any).lastExecutionStatus = pyRes.success ? 'success' : 'failed';
					(field as any).lastExecutionDurationMs = pyRes.durationMs || (Date.now() - stepStart);
					(field as any).lastExecutedAt = executedAt;
					stepDetails = { pythonPath: pyRes.pythonPath, executedCode: interpolatedCode, output: pyRes.output, result: pyRes.result, exitCode: pyRes.exitCode };
					if (!pyRes.success) {
						return {
							fieldId: field.id,
							fieldLabel,
							fieldType,
							output: stepOutput,
							status: 'failed',
							error: pyRes.error || `Python script exited with code ${pyRes.exitCode}`,
							durationMs: pyRes.durationMs || (Date.now() - stepStart),
							details: stepDetails
						};
					}
					break;
				}
				case 'table': {
					const dbPath = this._interpolateVariables(field.tableDbPath || '', contextVariables).trim();
					const tblName = this._interpolateVariables(field.tableDbTableName || this._cleanKey(fieldLabel) || 'node_table', contextVariables).trim();
					const sqlQuery = this._interpolateVariables(field.tableSqlQuery || '', contextVariables).trim();
					const sqlRes = await this.executeSqliteTableOperation({
						workspaceUri: wsUri,
						ticketUri: workUri,
						dbPath,
						tableName: tblName,
						action: sqlQuery ? 'query' : 'load',
						columns: field.tableColumns || [],
						rows: field.tableRows || [],
						sqlQuery: sqlQuery || undefined
					});
					stepOutput = sqlRes.isSelectQuery && Array.isArray(sqlRes.queryRows) ? sqlRes.queryRows : (sqlRes.rows || []);
					if (!dbPath || (field.tableDbEngine || 'sqlite') === 'none') {
						if (sqlRes.isSelectQuery && Array.isArray(sqlRes.queryRows)) {
							field.tableRows = sqlRes.queryRows;
						} else if (Array.isArray(sqlRes.rows)) {
							field.tableRows = sqlRes.rows;
						}
					} else {
						// Do not persist database snapshots into workflow_flowchart.json
						field.tableRows = [];
					}
					const elapsedSec = ((Date.now() - stepStart) / 1000).toFixed(2);
					const sqlSummaryLines: string[] = [
						`Status: ${sqlRes.success ? 'SUCCESS' : 'FAILED'} (${elapsedSec}s)`,
						`Database: ${dbPath || ':memory:'}`,
						`Target Table: ${tblName}`,
						`Result: ${sqlRes.message || (sqlRes.success ? 'SQL statement executed successfully.' : (sqlRes.error || 'Execution failed'))}`,
						'',
						'--- [Resolved SQL Statement] ---',
						sqlQuery || `SELECT * FROM "${tblName}"`
					];
					if (Array.isArray(stepOutput)) {
						const previewSlice = stepOutput.slice(0, 10);
						const omittedCount = stepOutput.length - previewSlice.length;
						sqlSummaryLines.push('', `--- [Result Rows (Showing ${previewSlice.length} of ${stepOutput.length} row(s))] ---`);
						sqlSummaryLines.push(JSON.stringify(previewSlice, null, 2));
						if (omittedCount > 0) {
							sqlSummaryLines.push(`... (${omittedCount} more row(s) omitted in text preview; all ${stepOutput.length} rows are preserved in runtime data)`);
						}
					}
					field.debugSqlOutput = sqlSummaryLines.join('\n');
					(field as any).lastExecutionLog = field.debugSqlOutput;
					(field as any).lastExecutionOutput = stepOutput;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { dbPath, tableName: tblName, sqlQuery, rowCount: Array.isArray(stepOutput) ? stepOutput.length : 0 };
					if (!sqlRes.success) {
						(field as any).lastExecutionStatus = 'failed';
						(field as any).lastExecutionDurationMs = Date.now() - stepStart;
						(field as any).lastExecutedAt = executedAt;
						return {
							fieldId: field.id,
							fieldLabel,
							fieldType,
							output: stepOutput,
							status: 'failed',
							error: sqlRes.error || 'SQL execution failed',
							durationMs: Date.now() - stepStart,
							details: stepDetails
						};
					}
					break;
				}
				case 'browser': {
					const interpolatedUrl = this._interpolateVariables(field.defaultUrl || '', contextVariables).trim();
					const extracted = interpolatedUrl ? await this._extractWebContent(interpolatedUrl, field.credentials) : { title: '', content: '' };
					stepOutput = extracted.content || '';
					field.defaultContent = stepOutput;
					(field as any).lastExecutionLog = `>>> Fetched URL: ${interpolatedUrl || '(empty)'}\nExtracted Length: ${stepOutput.length} chars\n\n${stepOutput}`;
					(field as any).lastExecutionOutput = stepOutput;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { url: interpolatedUrl, contentLength: stepOutput.length };
					break;
				}
				case 'media_player': {
					const rawPath = field.mediaFilePath || field.defaultContent || '';
					const interpolatedPath = this._interpolateVariables(rawPath, contextVariables).trim();
					const resolvedName = field.mediaFileName || (interpolatedPath ? (interpolatedPath.split(/[\\/]/).pop() || interpolatedPath) : '');
					const detected = detectMediaFileInfo(resolvedName || interpolatedPath, field.mediaMimeType);
					const rate = typeof field.mediaPlaybackRate === 'number' ? field.mediaPlaybackRate : 1.0;
					stepOutput = interpolatedPath || resolvedName || '';
					field.mediaFilePath = interpolatedPath;
					if (resolvedName) {
						field.mediaFileName = resolvedName;
					}
					field.mediaKind = detected.kind;
					field.mediaMimeType = detected.mimeType;
					(field as any).lastExecutionLog = `>>> MP3 / MP4 Player [${detected.kind.toUpperCase()}]: ${resolvedName || '(no file selected)'}\nPath: ${interpolatedPath || '(none)'}\nFormat: ${detected.ext.toUpperCase()} (${detected.mimeType})\nPlayback Speed: ${rate}x`;
					(field as any).lastExecutionOutput = stepOutput;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = {
						filePath: interpolatedPath,
						fileName: resolvedName,
						mediaKind: detected.kind,
						mimeType: detected.mimeType,
						playbackRate: rate
					};
					break;
				}
				case 'create_tickets': {
					const tType = this._interpolateVariables(field.wfTicketType || 'Task', contextVariables).trim();
					const tTitle = this._interpolateVariables(field.wfTicketTitle || `Ticket ${fieldLabel}`, contextVariables).trim();
					const tPath = this._interpolateVariables(field.wfTicketPath || '.', contextVariables).trim();
					const resolvedParams: Record<string, any> = {};
					if (field.wfTicketParams && typeof field.wfTicketParams === 'object') {
						for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
							if (pv === undefined || pv === '') continue;
							const singleVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
							resolvedParams[pk] = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(String(pv), contextVariables);
						}
					}
					stepOutput = await this.createTicket({
						workspaceUri: wsUri,
						targetPath: tPath,
						ticketType: tType,
						title: tTitle,
						parameters: resolvedParams
					});
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { ticketType: tType, title: tTitle, path: tPath, parameters: resolvedParams, createdTicket: stepOutput };
					(field as any).lastExecutionLog = `>>> CREATE_TICKETS -> ${fieldLabel}\nTicket Type: ${tType}\nTitle: ${tTitle}\nResult:\n${JSON.stringify(stepOutput, null, 2)}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
				case 'run_tickets': {
					const rawTarget = (field.wfTicketTarget || '').trim();
					const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
					let resolvedTarget: any = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: this._interpolateVariables(rawTarget, contextVariables).trim();
					if (resolvedTarget && typeof resolvedTarget === 'object') {
						resolvedTarget = resolvedTarget.ticketId || resolvedTarget.entityUri || resolvedTarget.ticketName || '';
					}
					const resolvedParams: Record<string, any> = {};
					if (field.wfTicketParams && typeof field.wfTicketParams === 'object') {
						for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
							if (pv === undefined || pv === '') continue;
							const pVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
							resolvedParams[pk] = (pVar && contextVariables[pVar[1].trim()] !== undefined)
								? contextVariables[pVar[1].trim()]
								: this._interpolateVariables(String(pv), contextVariables);
						}
					}
					stepOutput = await this.runTicket({
						workspaceUri: wsUri,
						ticketIdOrPath: String(resolvedTarget || ''),
						inputParams: { ...contextVariables, ...resolvedParams }
					});
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { targetTicket: resolvedTarget, parameters: resolvedParams, result: stepOutput };
					(field as any).lastExecutionLog = `>>> RUN_TICKETS (${resolvedTarget})\nResult:\n${JSON.stringify(stepOutput, null, 2)}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
				case 'get_outputs': {
					const rawTarget = (field.wfTicketTarget || '').trim();
					const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
					const resolvedTarget: any = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: this._interpolateVariables(rawTarget, contextVariables).trim();
					stepOutput = await this.getOutputs(wsUri, resolvedTarget);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { targetTicket: resolvedTarget, outputs: stepOutput };
					(field as any).lastExecutionLog = `>>> GET_OUTPUTS (${typeof resolvedTarget === 'object' ? JSON.stringify(resolvedTarget) : resolvedTarget}) -> ${fieldLabel}\n${JSON.stringify(stepOutput, null, 2)}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
				case 'get_tickets': {
					const querySpec: Record<string, any> = {};
					if (field.wfTicketType) querySpec.ticket_type = this._interpolateVariables(field.wfTicketType, contextVariables).trim();
					if (field.wfTicketStatus) querySpec.status = this._interpolateVariables(field.wfTicketStatus, contextVariables).trim();
					if (field.wfTicketTitle) querySpec.title = this._interpolateVariables(field.wfTicketTitle, contextVariables).trim();
					if (field.wfTicketPath) querySpec.path = this._interpolateVariables(field.wfTicketPath, contextVariables).trim();
					stepOutput = await this.getTickets(wsUri, querySpec);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { filter: querySpec, result: stepOutput };
					(field as any).lastExecutionLog = `>>> GET_TICKETS (${JSON.stringify(querySpec)}) -> ${fieldLabel}\n${JSON.stringify(stepOutput, null, 2)}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
				case 'display': {
					const rawDisp = (field.wfDisplayValue || '').trim();
					const singleVar = rawDisp.match(/^\{([^{}]+)\}$/);
					stepOutput = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: this._interpolateVariables(rawDisp, contextVariables);
					stepDetails = { displayExpr: rawDisp, value: stepOutput };
					const desc = describeRuntimeValue(stepOutput);
					(field as any).lastExecutionLog = `>>> DISPLAY (${rawDisp}) [Type: ${desc.typeTag}]\n${desc.preview}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
				case 'output': {
					const outMap: Record<string, any> = {};
					const enabledSpecs = (field.outputSpecs || []).filter(s => s.enabled);
					const traceLines: string[] = [
						`>>> Executing Component [OUTPUT]: "${fieldLabel}" (${enabledSpecs.length} exported field(s))`,
						`Timestamp: ${executedAt}`
					];
					for (const spec of enabledSpecs) {
						const k = spec.label || spec.fieldKey;
						const val = contextVariables[k] ?? contextVariables[spec.fieldKey];
						outMap[k] = val;
						const desc = describeRuntimeValue(val);
						traceLines.push(`\n• ${k} [Type: ${desc.typeTag}]`);
						traceLines.push(desc.preview);
					}
					stepOutput = outMap;
					contextVariables[fieldLabel] = outMap;
					contextVariables['OUTPUT'] = outMap;
					stepDetails = { outputs: outMap };
					(field as any).lastExecutionLog = traceLines.join('\n');
					(field as any).lastExecutionOutput = outMap;
					break;
				}
				default: {
					const rawVal = field.defaultContent || '';
					stepOutput = this._interpolateVariables(rawVal, contextVariables);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { value: stepOutput };
					const desc = describeRuntimeValue(stepOutput);
					(field as any).lastExecutionLog = `>>> Component [${fieldType}] "${fieldLabel}" [Type: ${desc.typeTag}]\n${desc.preview}`;
					(field as any).lastExecutionOutput = stepOutput;
					break;
				}
			}

			if (stepOutput !== undefined) {
				const outVarName = (field.outputVariableName || '').trim() || generateSmartPythonVarName(fieldLabel, fieldType);
				if (outVarName && fieldType !== 'parameters' && fieldType !== 'output' && fieldType !== 'result' && fieldType !== 'display') {
					contextVariables[outVarName] = stepOutput;
				}
				if (field.id) {
					contextVariables[field.id] = stepOutput;
				}
				const prevLabels = Array.isArray((field as any).previousLabels) ? (field as any).previousLabels : [];
				for (const pl of prevLabels) {
					if (pl && typeof pl === 'string') {
						contextVariables[pl] = stepOutput;
						contextVariables[this._cleanKey(pl)] = stepOutput;
					}
				}
			}

			const durationMs = Date.now() - stepStart;
			(field as any).lastExecutionStatus = 'success';
			(field as any).lastExecutionDurationMs = durationMs;
			(field as any).lastExecutedAt = executedAt;

			return {
				fieldId: field.id,
				fieldLabel,
				fieldType,
				output: stepOutput,
				status: 'success',
				durationMs,
				details: stepDetails
			};
		} catch (err: any) {
			const durationMs = Date.now() - stepStart;
			const errMsg = err?.message || String(err);
			(field as any).lastExecutionStatus = 'failed';
			(field as any).lastExecutionDurationMs = durationMs;
			(field as any).lastExecutedAt = executedAt;
			(field as any).lastExecutionLog = `[Execution Error]: ${errMsg}`;
			if (fieldType === 'python') {
				field.pythonOutput = `[Execution Error]: ${errMsg}`;
			}
			return {
				fieldId: field.id,
				fieldLabel,
				fieldType,
				status: 'failed',
				error: errMsg,
				durationMs,
				details: stepDetails
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
				label: 'Inputs (Runtime Variables)',
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
				type: 'tts',
				label: 'Audio / TTS (Text-to-Speech)',
				icon: 'unmute',
				category: 'processing',
				description: 'Converts multilingual text into persistent audio files (default MP3) using AI voice models from Agent Central.',
				executionBehavior: 'Checks if audio file is already cached in ticket folder; otherwise synthesizes speech via LLM API and saves MP3 locally.',
				supportedInputs: ['multilingual text', 'interpolated variables', 'target voice model', 'audio format'],
				supportedOutputs: ['saved audio file path (e.g. attachments/tts_audio.mp3)']
			},
			{
				type: 'media_player',
				label: 'MP3 / MP4 Player',
				icon: 'device-camera-video',
				category: 'processing',
				description: 'Local HTML5 Audio & Video media player supporting MP3, MP4, WAV, M4A, AAC, OGG, FLAC, WebM, MOV, and more with 0.25x-2.0x speed control.',
				executionBehavior: 'Resolves imported local audio/video file path, auto-detects Audio vs. Video mode, and exposes media path to workflow context.',
				supportedInputs: ['local audio/video file (click to select or drag-and-drop)', 'playback speed (0.25x - 2.0x)'],
				supportedOutputs: ['local media file path']
			},
			{
				type: 'browser',
				label: 'Browser (Web Application)',
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
				type: 'table',
				label: 'Data Table (SQLite / Grid)',
				icon: 'table',
				category: 'data',
				description: 'Typed relational data table with customizable column headers, SQL/SQLite data types, manual/paste/AI row editing, and direct SQLite database storage/sync.',
				executionBehavior: 'Resolves typed columns and rows, optionally syncs or loads from a bound SQLite database file, and exposes tabular rows to downstream steps.',
				supportedInputs: ['table columns', 'table rows', 'SQLite database path & table name'],
				supportedOutputs: ['array of row objects', 'Markdown table', 'SQLite sync status']
			},
			{
				type: 'attachment',
				label: 'Attachment (Files)',
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

	async getTickets(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult> {
		return this.getTicket(workspaceUri, ticketIdOrPath);
	}

	async GET_TICKETS(workspaceUri: string | URI, ticketIdOrPath: string | any): Promise<ITicketGetResult> {
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

	private _formatTablePayloadAsMarkdown(columns: ITableColumnDefinition[] | undefined, rows: Record<string, any>[]): string {
		const colNames = (Array.isArray(columns) && columns.length > 0)
			? columns.map(c => c.name || c.id)
			: (rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null ? Object.keys(rows[0]) : []);
		if (colNames.length === 0) {
			return JSON.stringify(rows, null, 2);
		}
		const headerLine = `| ${colNames.join(' | ')} |`;
		const dividerLine = `| ${colNames.map(() => '---').join(' | ')} |`;
		const bodyLines = rows.map(row => {
			const cells = colNames.map(col => {
				const val = row && typeof row === 'object' ? row[col] : '';
				return val === undefined || val === null ? '' : String(val).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
			});
			return `| ${cells.join(' | ')} |`;
		});
		return [headerLine, dividerLine, ...bodyLines].join('\n');
	}

	private _getCleanPrimitiveContent(rawVal: any): string {
		if (rawVal === undefined || rawVal === null) return '';
		if (typeof rawVal === 'string') {
			const trimmed = rawVal.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					if (Array.isArray(parsed.rows)) {
						if (typeof parsed.sqlOutput === 'string' && parsed.sqlOutput.trim() !== '') {
							return parsed.sqlOutput.trim();
						}
						return this._formatTablePayloadAsMarkdown(parsed.columns, parsed.rows);
					}
					if (parsed.content !== undefined && String(parsed.content).trim() !== '') return String(parsed.content);
					if (parsed.result !== undefined && parsed.result !== null && String(parsed.result).trim() !== '') {
						return typeof parsed.result === 'object' ? JSON.stringify(parsed.result) : String(parsed.result).trim();
					}
					if (parsed.output !== undefined) return String(parsed.output);
					if (parsed.url !== undefined && parsed.content === undefined) return String(parsed.url);
				} catch { }
			}
			return rawVal;
		}
		if (typeof rawVal === 'object') {
			if (Array.isArray(rawVal.rows)) {
				if (typeof rawVal.sqlOutput === 'string' && rawVal.sqlOutput.trim() !== '') {
					return rawVal.sqlOutput.trim();
				}
				return this._formatTablePayloadAsMarkdown(rawVal.columns, rawVal.rows);
			}
			if (rawVal.content !== undefined && String(rawVal.content).trim() !== '') return String(rawVal.content);
			if (rawVal.result !== undefined && rawVal.result !== null && String(rawVal.result).trim() !== '') {
				return typeof rawVal.result === 'object' ? JSON.stringify(rawVal.result) : String(rawVal.result).trim();
			}
			if (rawVal.output !== undefined) return String(rawVal.output);
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
			// 2.5 Case-insensitive match
			const lowerKey = trimmedKey.toLowerCase();
			for (const [ck, cv] of Object.entries(context)) {
				if (ck.toLowerCase() === lowerKey && cv !== undefined) {
					return this._getCleanPrimitiveContent(cv);
				}
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
				result = result.replace(atPattern, () => cleanVal);
			}
		}

		return result;
	}

	private async _extractWebContent(targetUrl: string, credentials?: Array<{ key: string; value: string }>): Promise<{ title: string; content: string }> {
		const startEpoch = this._cancelEpoch;
		const controller = new AbortController();
		this._activeAbortControllers.add(controller);
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(new Error('Web extraction cancelled by Stop request'));
				return;
			}
			controller.signal.addEventListener('abort', () => {
				reject(new Error('Web extraction cancelled by Stop request'));
			}, { once: true });
		});

		try {
			// 1. Try IWebContentExtractorService first
			try {
				const extractorService = this.instantiationService.invokeFunction(accessor => {
					try { return accessor.get(IWebContentExtractorService); } catch { return undefined; }
				});
				if (extractorService) {
					const uri = URI.parse(targetUrl);
					const results: WebContentExtractResult[] = await Promise.race([
						extractorService.extract([uri], { followRedirects: true, bypassCache: true }),
						abortPromise,
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
			} catch (e: any) {
				if (this._cancelEpoch !== startEpoch || controller.signal.aborted) {
					throw new Error('Web extraction cancelled by Stop request');
				}
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

				const resp = await fetch(targetUrl, { headers, signal: controller.signal });
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
				if (this._cancelEpoch !== startEpoch || controller.signal.aborted) {
					throw new Error('Web extraction cancelled by Stop request');
				}
				return {
					title: targetUrl,
					content: `[Fetch Failed: ${err.message || String(err)}]`
				};
			}
		} finally {
			this._activeAbortControllers.delete(controller);
		}
	}

	private async _executePrompt(modelId: string, promptText: string, targetProviderId?: string): Promise<string> {
		const startEpoch = this._cancelEpoch;
		const controller = new AbortController();
		this._activeAbortControllers.add(controller);
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(new Error('AI Prompt execution cancelled by Stop request'));
				return;
			}
			controller.signal.addEventListener('abort', () => {
				reject(new Error('AI Prompt execution cancelled by Stop request'));
			}, { once: true });
		});

		try {
			const credService = this.instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (credService && credService.executePrompt) {
				const res = await Promise.race([
					credService.executePrompt(modelId, promptText, undefined, targetProviderId),
					abortPromise
				]);
				if (res.success && res.text) {
					return res.text;
				} else if (res.error) {
					this.logService.warn(`[TicketWorkflowRuntime] AI Prompt execution warning: ${res.error}`);
					return `[AI Execution Error: ${res.error}]`;
				}
			}
		} catch (e: any) {
			if (this._cancelEpoch !== startEpoch || controller.signal.aborted) {
				throw new Error('AI Prompt execution cancelled by Stop request');
			}
			this.logService.warn(`[TicketWorkflowRuntime] IAgentCredentialService error:`, e);
			return `[AI Service Error: ${e.message || String(e)}]`;
		} finally {
			this._activeAbortControllers.delete(controller);
		}

		return `[AI Execution Notice: Credential not configured for ${modelId}]`;
	}

	private _parseJsonOrPythonListField(val: any): any[] {
		if (Array.isArray(val)) return val;
		if (val === null || val === undefined) return [];
		const s = String(val).trim();
		if (!s || s === '[]' || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') return [];
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) return parsed;
		} catch { }
		if (s.startsWith('[') && s.endsWith(']')) {
			const inner = s.slice(1, -1).trim();
			if (!inner) return [];
			const items: string[] = [];
			let i = 0;
			while (i < inner.length) {
				while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t' || inner[i] === '\n' || inner[i] === '\r' || inner[i] === ',')) {
					i++;
				}
				if (i >= inner.length) break;
				const quote = inner[i];
				if (quote === '\'' || quote === '"') {
					i++;
					let buf = '';
					while (i < inner.length) {
						if (inner[i] === '\\' && i + 1 < inner.length) {
							const nextCh = inner[i + 1];
							if (nextCh === 'n') buf += '\n';
							else if (nextCh === 't') buf += '\t';
							else if (nextCh === 'r') buf += '\r';
							else buf += nextCh;
							i += 2;
						} else if (inner[i] === quote) {
							i++;
							break;
						} else {
							buf += inner[i];
							i++;
						}
					}
					items.push(buf);
				} else {
					let end = i;
					while (end < inner.length && inner[end] !== ',') end++;
					const token = inner.slice(i, end).trim();
					if (token) items.push(token);
					i = end + 1;
				}
			}
			return items;
		}
		return [s];
	}

	private _tryExtractJsonRecordsFromTablePrompt(
		rawPrompt: string,
		contextVariables: Record<string, any>,
		customMetadata?: Record<string, string>,
		forceFallback: boolean = false
	): string | undefined {
		if (!rawPrompt) return undefined;
		const isDbResultJsonArrayParser =
			/(?:parse|extract)[\s\S]*?(?:database\s+query\s+result|query\s+result|returned\s+[\w\s]*records?|table\s+rows?)[\s\S]*?json\s+array/i.test(rawPrompt) ||
			(/(?:extract\s+all\s+returned|into\s+a\s+json\s+array)/i.test(rawPrompt) && /(?:do\s+not\s+omit\s+records|output\s+only\s+valid\s+json)/i.test(rawPrompt));
		if (!isDbResultJsonArrayParser && !forceFallback) {
			return undefined;
		}

		const tokenRegex = /@?\{\{?([^{}]+)\}?\}/g;
		let match: RegExpExecArray | null;
		let foundTableRows: any[] | undefined;
		let foundTableSuccess = true;
		let foundTableRef = false;

		while ((match = tokenRegex.exec(rawPrompt)) !== null) {
			const rawKey = match[1].trim();
			const cleanK = this._cleanKey(rawKey);
			let candidate = contextVariables[rawKey] ?? contextVariables[cleanK];
			if (candidate === undefined && customMetadata) {
				candidate = customMetadata[rawKey] ?? customMetadata[cleanK];
			}
			if (candidate === undefined) {
				const lowerKey = rawKey.toLowerCase();
				for (const [ck, cv] of Object.entries(contextVariables)) {
					if (ck.toLowerCase() === lowerKey && cv !== undefined) {
						candidate = cv;
						break;
					}
				}
			}
			if (candidate === undefined) continue;

			let parsedCand = candidate;
			if (typeof candidate === 'string') {
				const trimmed = candidate.trim();
				if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
					try { parsedCand = JSON.parse(trimmed); } catch { }
				}
			}

			if (Array.isArray(parsedCand)) {
				foundTableRef = true;
				foundTableRows = parsedCand;
				foundTableSuccess = true;
				break;
			} else if (parsedCand && typeof parsedCand === 'object' && ('rows' in parsedCand || 'sqlOutput' in parsedCand || 'dbEngine' in parsedCand)) {
				foundTableRef = true;
				const sqlOut = String(parsedCand.sqlOutput || parsedCand.output || '').trim();
				foundTableSuccess = !/^Status:\s*FAILED\b/i.test(sqlOut);
				if (Array.isArray(parsedCand.rows) && parsedCand.rows.length > 0) {
					foundTableRows = parsedCand.rows;
				} else {
					const rowsKey = `${cleanK}_rows`;
					if (Array.isArray(contextVariables[rowsKey]) && contextVariables[rowsKey].length > 0) {
						foundTableRows = contextVariables[rowsKey];
					} else {
						foundTableRows = [];
					}
				}
				break;
			}
		}

		if (!foundTableRef) return undefined;
		if (!foundTableSuccess || !Array.isArray(foundTableRows) || foundTableRows.length === 0) {
			return '[]';
		}

		let templateObj: Record<string, any> | undefined;
		const structMatch = rawPrompt.match(/\[\s*(\{\s*"[^"]+"\s*:[\s\S]*?\})\s*\]/);
		if (structMatch && structMatch[1]) {
			try {
				const parsed = JSON.parse(structMatch[1]);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					templateObj = parsed;
				}
			} catch { }
		}

		const arrayFields = new Set<string>(['what_to_do', 'require_base', 'require_bonus', 'keywords']);
		if (templateObj) {
			for (const [tk, tv] of Object.entries(templateObj)) {
				if (Array.isArray(tv)) {
					arrayFields.add(tk);
				}
			}
		}
		const ruleMatches = rawPrompt.matchAll(/`([a-zA-Z0-9_]+)`/g);
		if (/from\s+json\s+strings\s+into\s+arrays/i.test(rawPrompt)) {
			for (const rm of ruleMatches) {
				if (rm[1] && templateObj && Array.isArray(templateObj[rm[1]])) {
					arrayFields.add(rm[1]);
				}
			}
		}

		const sampleRow = foundTableRows[0] && typeof foundTableRows[0] === 'object' ? foundTableRows[0] : {};
		const templateKeys = templateObj ? Object.keys(templateObj) : [];
		const matchingTemplateKeys = templateKeys.filter(k => k in sampleRow);
		const useTemplateKeys = templateKeys.length >= 2 && matchingTemplateKeys.length >= 2;

		const normalizedRows = foundTableRows.map(row => {
			if (!row || typeof row !== 'object') return row;
			const outRow: Record<string, any> = {};
			const keysToCopy = useTemplateKeys ? templateKeys : Object.keys(row).filter(k => !(k === 'id' && row.id === null));
			for (const k of keysToCopy) {
				const rawV = row[k];
				if (arrayFields.has(k)) {
					outRow[k] = this._parseJsonOrPythonListField(rawV);
				} else {
					outRow[k] = (rawV !== undefined && rawV !== null) ? rawV : null;
				}
			}
			return outRow;
		});

		return JSON.stringify(normalizedRows, null, 2);
	}

	private _formatOutputValue(rawVal: any, format: string): any {
		if (rawVal === undefined || rawVal === null) return '';
		if (typeof rawVal === 'object') {
			if (!Array.isArray(rawVal) && ('sqlOutput' in rawVal || ('columns' in rawVal && 'rows' in rawVal) || 'dbEngine' in rawVal)) {
				if (Array.isArray(rawVal.rows) && rawVal.rows.length > 0) {
					return rawVal.rows;
				}
				if (typeof rawVal.sqlOutput === 'string' && rawVal.sqlOutput.trim() !== '') {
					return rawVal.sqlOutput.trim();
				}
				if (typeof rawVal.output === 'string' && rawVal.output.trim() !== '' && !rawVal.output.trim().startsWith('{"columns":')) {
					return rawVal.output.trim();
				}
				if (Array.isArray(rawVal.rows)) {
					return this._formatTablePayloadAsMarkdown(rawVal.columns, rawVal.rows);
				}
				return '';
			}
			return rawVal;
		}

		const str = String(rawVal).trim();
		if (/^Status:\s*(SUCCESS|FAILED)\b/i.test(str) || str.includes('--- [Resolved SQL Statement] ---')) {
			return str;
		}
		if (format === 'json' || format === 'table') {
			try {
				return JSON.parse(str);
			} catch {
				const match = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (match && match[1]) {
					try {
						return JSON.parse(match[1].trim());
					} catch { }
				}
				const firstBrace = str.indexOf('{');
				const lastBrace = str.lastIndexOf('}');
				if (firstBrace !== -1 && lastBrace > firstBrace) {
					try {
						return JSON.parse(str.substring(firstBrace, lastBrace + 1));
					} catch { }
				}
				const firstBracket = str.indexOf('[');
				const lastBracket = str.lastIndexOf(']');
				if (firstBracket !== -1 && lastBracket > firstBracket) {
					try {
						return JSON.parse(str.substring(firstBracket, lastBracket + 1));
					} catch { }
				}
			}
		}
		return str;
	}

	private _parseOutputFieldValue(rawVal: any): any {
		if (rawVal === undefined || rawVal === null) return null;
		if (typeof rawVal === 'object') return rawVal;
		const str = String(rawVal).trim();
		if (!str || str.startsWith('(Pending AI Execution') || str === '(Python script ready)') {
			return null;
		}
		if (/^Status:\s*(SUCCESS|FAILED)\b/i.test(str) || str.includes('--- [Resolved SQL Statement] ---')) {
			return str;
		}
		if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
			try {
				return JSON.parse(str);
			} catch { }
		}
		const fenceMatch = str.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i) || str.match(/```json\s*([\s\S]*?)\s*```/i);
		if (fenceMatch && fenceMatch[1]) {
			const inner = fenceMatch[1].trim();
			if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) {
				try {
					return JSON.parse(inner);
				} catch { }
			}
		}
		return str;
	}

	private _extractCleanRealizedValueFromMeta(rawMeta: any): any {
		if (rawMeta === undefined || rawMeta === null) return null;
		if (typeof rawMeta === 'object') {
			if (Array.isArray(rawMeta)) return rawMeta.length > 0 ? rawMeta : null;
			if (Array.isArray(rawMeta.rows) || 'sqlOutput' in rawMeta || ('columns' in rawMeta && 'dbEngine' in rawMeta)) {
				if (Array.isArray(rawMeta.rows) && rawMeta.rows.length > 0) {
					return rawMeta.rows;
				}
				if (typeof rawMeta.sqlOutput === 'string' && rawMeta.sqlOutput.trim() !== '') {
					return rawMeta.sqlOutput.trim();
				}
				return Array.isArray(rawMeta.rows) && rawMeta.rows.length > 0 ? rawMeta.rows : null;
			}
			if (rawMeta.prompt !== undefined || rawMeta.preInjectedPrompt !== undefined || rawMeta.userPrompt !== undefined || rawMeta.userPrompts !== undefined) {
				const out = rawMeta.output !== undefined ? String(rawMeta.output).trim() : '';
				return out ? this._parseOutputFieldValue(out) : null;
			}
			if (rawMeta.pythonCode !== undefined || rawMeta.code !== undefined || rawMeta.pythonPath !== undefined) {
				if (rawMeta.result !== undefined && rawMeta.result !== null && String(rawMeta.result).trim() !== '') {
					return this._parseOutputFieldValue(rawMeta.result);
				}
				const out = rawMeta.output !== undefined ? String(rawMeta.output).trim() : '';
				return out ? this._parseOutputFieldValue(out) : null;
			}
			if (rawMeta.url !== undefined && rawMeta.content !== undefined) {
				const c = String(rawMeta.content).trim();
				return c ? this._parseOutputFieldValue(c) : null;
			}
			if (rawMeta.text !== undefined) {
				const t = String(rawMeta.text).trim();
				return t ? this._parseOutputFieldValue(t) : null;
			}
			if (rawMeta.output !== undefined) {
				const o = String(rawMeta.output).trim();
				return o ? this._parseOutputFieldValue(o) : null;
			}
			if (rawMeta.result !== undefined) {
				return this._parseOutputFieldValue(rawMeta.result);
			}
			return rawMeta;
		}
		if (typeof rawMeta === 'string') {
			const trimmed = rawMeta.trim();
			if (!trimmed) return null;
			if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
				try {
					const parsed = JSON.parse(trimmed);
					return this._extractCleanRealizedValueFromMeta(parsed);
				} catch { }
			}
			return this._parseOutputFieldValue(trimmed);
		}
		return rawMeta;
	}

	/**
	 * Strictly extracts the OUTPUT component's fields if and only if the ticket template (or metadata) defines an OUTPUT component.
	 * - Returns null (None) if the ticket's template has NO 'output'/'result' component.
	 * - Returns a dictionary mapping each output field label to its value (or null/None if that field's value is missing/empty).
	 */
	private _extractStrictOutputsComponent(metadata: Record<string, string>, schema?: ICustomModule): Record<string, any> | null {
		const outputFields = schema?.fields?.filter(f => f.type === 'output' || f.type === 'result') || [];

		// Collect any saved Output JSON maps in customMetadata (e.g. "Output", "Output 1", "output_1")
		const savedOutputRecords: Record<string, any> = {};
		const candidateOutKeys = new Set<string>(['Output', 'Output 1', 'output', 'output_1', 'Result', 'result']);
		for (const ofield of outputFields) {
			if (ofield.label) candidateOutKeys.add(ofield.label);
			if (ofield.id) {
				candidateOutKeys.add(ofield.id);
				candidateOutKeys.add(ofield.id.replace(/_/g, ' '));
			}
		}
		for (const [mk, mv] of Object.entries(metadata || {})) {
			const isOutKey = candidateOutKeys.has(mk) || /^output(\s+\d+|_\d+)?$/i.test(mk.trim());
			if (isOutKey && typeof mv === 'string' && mv.trim().startsWith('{')) {
				try {
					const parsed = JSON.parse(mv.trim());
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						for (const [k, v] of Object.entries(parsed)) {
							if (k === 'outputSpecs' || k === 'output_specs') continue;
							savedOutputRecords[k] = v;
						}
					}
				} catch { }
			}
		}

		// If schema is loaded and has NO output/result component, return null (None)
		if (schema && Array.isArray(schema.fields) && outputFields.length === 0) {
			return null;
		}

		// If schema was not found, check if metadata has an explicit Output component record
		if (outputFields.length === 0 && Object.keys(savedOutputRecords).length === 0) {
			return null;
		}

		const result: Record<string, any> = {};
		const lookupFieldMeta = (fieldKey: string, label: string): string | undefined => {
			const candidates: string[] = [];
			const pushCand = (c?: string) => {
				const t = (c || '').trim();
				if (t && !candidates.includes(t)) candidates.push(t);
			};
			pushCand(label);
			pushCand(fieldKey);

			if (schema?.fields) {
				const matchedField = schema.fields.find(f => {
					if (f.type === 'output' || f.type === 'result') return false;
					const prevs: string[] = Array.isArray((f as any).previousLabels) ? (f as any).previousLabels : [];
					return (
						f.label === label ||
						f.label === fieldKey ||
						f.id === fieldKey ||
						f.id === label ||
						prevs.includes(label) ||
						prevs.includes(fieldKey) ||
						f.id.replace(/_/g, ' ').toLowerCase() === fieldKey.replace(/_/g, ' ').toLowerCase() ||
						f.id.replace(/_/g, ' ').toLowerCase() === label.replace(/_/g, ' ').toLowerCase()
					);
				});
				if (matchedField) {
					pushCand(matchedField.label);
					pushCand(matchedField.id);
					pushCand(matchedField.id.replace(/_/g, ' '));
					const prevs: string[] = Array.isArray((matchedField as any).previousLabels) ? (matchedField as any).previousLabels : [];
					for (const pl of prevs) {
						pushCand(pl);
					}
				}
			}

			for (const c of candidates) {
				if (metadata[c] !== undefined && String(metadata[c]).trim() !== '') {
					return metadata[c];
				}
			}
			const lowerSet = new Set(candidates.map(c => c.toLowerCase()));
			const normSet = new Set(candidates.map(c => c.replace(/_/g, ' ').toLowerCase()));
			for (const [mk, mv] of Object.entries(metadata)) {
				if (mv !== undefined && String(mv).trim() !== '') {
					const ml = mk.toLowerCase();
					const mn = mk.replace(/_/g, ' ').toLowerCase();
					if (lowerSet.has(ml) || normSet.has(mn)) {
						return mv;
					}
				}
			}
			return undefined;
		};

		const lookupSavedRecord = (fieldKey: string, label: string): any => {
			const candidates = [label, fieldKey];
			if (schema?.fields) {
				const mf = schema.fields.find(f =>
					f.type !== 'output' && f.type !== 'result' && (
						f.label === label || f.label === fieldKey || f.id === fieldKey || f.id === label
					)
				);
				if (mf) {
					if (mf.label) candidates.push(mf.label);
					if (mf.id) {
						candidates.push(mf.id);
						candidates.push(mf.id.replace(/_/g, ' '));
					}
				}
			}
			for (const c of candidates) {
				if (c && savedOutputRecords[c] !== undefined) return savedOutputRecords[c];
			}
			const lowerSet = new Set(candidates.filter(Boolean).map(c => c.toLowerCase()));
			for (const [sk, sv] of Object.entries(savedOutputRecords)) {
				if (lowerSet.has(sk.toLowerCase()) || lowerSet.has(sk.replace(/_/g, ' ').toLowerCase())) {
					return sv;
				}
			}
			return undefined;
		};

		// Collect all enabled outputSpecs across output fields
		const specsToProcess: IOutputSpec[] = [];
		for (const ofield of outputFields) {
			if (Array.isArray(ofield.outputSpecs) && ofield.outputSpecs.length > 0) {
				for (const s of ofield.outputSpecs) {
					if (s.enabled !== false) {
						specsToProcess.push(s);
					}
				}
			} else if (schema?.fields) {
				// Default when outputSpecs was not explicitly customized: include all non-output fields in schema
				for (const f of schema.fields) {
					if (f.type !== 'output' && f.type !== 'result') {
						specsToProcess.push({
							fieldKey: f.label || f.id,
							label: f.label || f.id,
							enabled: true,
							defaultFormat: 'table'
						});
					}
				}
			}
		}

		if (specsToProcess.length > 0) {
			const fieldAliases: Record<string, string> = {};
			for (const spec of specsToProcess) {
				let outKey = spec.label || spec.fieldKey;
				if (schema?.fields) {
					const mf = schema.fields.find(f => {
						if (f.type === 'output' || f.type === 'result') return false;
						const prevs: string[] = Array.isArray((f as any).previousLabels) ? (f as any).previousLabels : [];
						return (
							f.label === outKey ||
							f.label === spec.fieldKey ||
							f.id === spec.fieldKey ||
							f.id === outKey ||
							prevs.includes(outKey) ||
							prevs.includes(spec.fieldKey)
						);
					});
					if (mf) {
						const canonicalLabel = mf.label || outKey;
						if (outKey !== canonicalLabel) {
							fieldAliases[outKey] = canonicalLabel;
						}
						if (spec.fieldKey && spec.fieldKey !== canonicalLabel) {
							fieldAliases[spec.fieldKey] = canonicalLabel;
						}
						if (mf.id && mf.id !== canonicalLabel) {
							fieldAliases[mf.id] = canonicalLabel;
						}
						const prevs: string[] = Array.isArray((mf as any).previousLabels) ? (mf as any).previousLabels : [];
						for (const pl of prevs) {
							if (pl && pl !== canonicalLabel) {
								fieldAliases[pl] = canonicalLabel;
							}
						}
						outKey = canonicalLabel;
					}
				}
				let resolvedVal: any = null;

				// 1. Check live primitive field metadata first so manual runs in the ticket UI are always reflected
				const rawMeta = lookupFieldMeta(spec.fieldKey, outKey);
				if (rawMeta !== undefined) {
					resolvedVal = this._extractCleanRealizedValueFromMeta(rawMeta);
				}

				// 2. Fallback to saved Output record if live field metadata was empty
				if (resolvedVal === null || resolvedVal === undefined || resolvedVal === '') {
					const savedRec = lookupSavedRecord(spec.fieldKey, outKey);
					if (savedRec !== undefined && savedRec !== null) {
						resolvedVal = this._extractCleanRealizedValueFromMeta(savedRec);
					}
				}

				result[outKey] = (resolvedVal !== undefined && resolvedVal !== '') ? resolvedVal : null;
			}
			if (Object.keys(fieldAliases).length > 0) {
				result['__field_aliases__'] = fieldAliases;
			}
			return result;
		}

		// Fallback if schema wasn't available but savedOutputRecords exists
		if (Object.keys(savedOutputRecords).length > 0) {
			for (const [k, v] of Object.entries(savedOutputRecords)) {
				const resolved = this._extractCleanRealizedValueFromMeta(v);
				result[k] = (resolved !== undefined && resolved !== '') ? resolved : null;
			}
			return result;
		}

		return null;
	}

	private _extractTicketOutputs(metadata: Record<string, string>, schema?: ICustomModule): Record<string, any> {
		const strict = this._extractStrictOutputsComponent(metadata, schema);
		if (strict !== null) {
			return strict;
		}

		const outputs: Record<string, any> = {};

		// Fallback: extract output from any browser, prompt, or output fields in metadata
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
						if (parsed.result !== undefined) {
							return parsed.result;
						}
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
					// TTS primitive
					if (parsed.ttsFormat !== undefined || parsed.audioRelativePath !== undefined) {
						return parsed.audioRelativePath || parsed.text || '';
					}
					// Output / Result primitive
					if (parsed.result !== undefined) {
						return parsed.result;
					}
					return parsed;
				} catch { }
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
		let title = snapshot?.title || '';
		let description = snapshot?.description || '';
		let status = snapshot?.status || 'Todo';
		let priority = snapshot?.priority || 'Medium';
		let ticketId = snapshot?.ticketId || snapshot?.entityCode || '';
		let ticketType = snapshot?.entityType || '';

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
								if (val) ticketId = val;
							} else if (key === 'Ticket Type') {
								if (val) ticketType = val;
							} else if (key === 'Title') {
								if (val) title = val;
							} else if (key === 'Description') {
								if (val) description = val;
							} else if (key === 'Status') {
								if (val) status = val;
							} else if (key === 'Priority') {
								if (val) priority = val;
							}
						}
					}
				} catch {
					// ignore
				}
				break;
			}
		}

		// Read README.md for Title / Description / Ticket Type / Status fallback
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
						const idMatch = line.match(/^\s*-\s*\*\*Ticket ID\*\*:\s*(.*)$/i);
						if (idMatch && idMatch[1].trim() && !ticketId) ticketId = idMatch[1].trim();
						const typeMatch = line.match(/^\s*-\s*\*\*Ticket Type\*\*:\s*(.*)$/i);
						if (typeMatch && typeMatch[1].trim() && !ticketType) ticketType = typeMatch[1].trim();
					}
				} catch {
					// ignore
				}
				break;
			}
		}

		if (!title && customMetadata['Title']) {
			title = customMetadata['Title'];
		}
		if (!description && customMetadata['Description']) {
			description = customMetadata['Description'];
		}

		const folderName = ticketUri.path.split('/').filter(Boolean).pop() || 'ticket';

		return {
			ticketId: ticketId || folderName,
			entityName: folderName,
			ticketType: ticketType || 'task',
			title: title || snapshot?.entityName || folderName,
			description: description,
			status: status || 'Todo',
			priority: priority || 'Medium',
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
			// Ensure Output field is populated in customMetadata even if schema didn't explicitly run an output step
			if (finalOutput !== undefined && customMetadata['Output'] === undefined && customMetadata['output'] === undefined) {
				const outPayload = (typeof finalOutput === 'object' && finalOutput !== null && !Array.isArray(finalOutput))
					? { ...finalOutput, lastUpdated: new Date().toISOString() }
					: finalOutput;
				customMetadata['Output'] = typeof outPayload === 'object' ? JSON.stringify(outPayload) : String(outPayload);
			}

			// 1. Update in-memory snapshot
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

			// 2. Persist updated customMetadata & Status directly to .agents/ticket.md (and root ticket.md if present)
			const ticketMdCandidates = [
				URI.joinPath(ticketUri, '.agents', 'ticket.md'),
				URI.joinPath(ticketUri, 'ticket.md')
			];
			const selfDefinedLines = Object.entries(customMetadata)
				.filter(([k]) => k !== 'outputSpecs' && k !== 'output_specs')
				.map(([k, v]) => {
					const singleLineVal = typeof v === 'string' ? v.replace(/\r?\n/g, ' ') : JSON.stringify(v);
					return `  - **${k}**: ${singleLineVal}`;
				});

			for (const tMdUri of ticketMdCandidates) {
				try {
					if (await this.fileService.exists(tMdUri)) {
						const mdText = (await this.fileService.readFile(tMdUri)).value.toString();
						const lines = mdText.split(/\r?\n/);
						const newLines: string[] = [];
						let inSelfDefined = false;
						let replacedSelfDefined = false;
						let savedStructureLine: string | null = null;

						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							if (/^\s*-\s+\*\*Status\*\*:/i.test(line) && !inSelfDefined) {
								newLines.push(line.replace(/(^\s*-\s+\*\*Status\*\*:\s*)([^\r\n]*)/i, (_, p1) => `${p1}Completed`));
								continue;
							}
							if (line.startsWith('### Self Defined Data')) {
								inSelfDefined = true;
								newLines.push(line);
								// Scan ahead inside Self Defined Data to preserve Structure line if present, and skip old custom value lines
								while (i + 1 < lines.length) {
									const nextLine = lines[i + 1];
									if (nextLine.startsWith('- **Self Defined Data Structure**:')) {
										savedStructureLine = nextLine;
										i++;
										continue;
									}
									if (nextLine.startsWith('- **Self Defined Data Value**:')) {
										i++;
										continue;
									}
									if (
										nextLine.startsWith('#') ||
										nextLine.startsWith('---') ||
										(nextLine.startsWith('- **') && !nextLine.startsWith('- **Self Defined Data'))
									) {
										break;
									}
									i++;
								}
								if (savedStructureLine) {
									newLines.push(savedStructureLine);
								}
								if (selfDefinedLines.length > 0) {
									newLines.push('- **Self Defined Data Value**:');
									for (const sl of selfDefinedLines) {
										newLines.push(sl);
									}
								} else {
									newLines.push('- **Self Defined Data Value**: None');
								}
								newLines.push('');
								inSelfDefined = false;
								replacedSelfDefined = true;
								continue;
							}
							newLines.push(line);
						}

						let updatedMd = newLines.join('\n');
						if (!replacedSelfDefined && selfDefinedLines.length > 0) {
							updatedMd = updatedMd.trimEnd() + `\n\n### Self Defined Data (If any)\n- **Self Defined Data Value**:\n${selfDefinedLines.join('\n')}\n`;
						}
						await this.fileService.writeFile(tMdUri, VSBuffer.fromString(updatedMd));
					}
				} catch (mdErr) {
					this.logService.warn(`[TicketWorkflowRuntime] Failed to update ${tMdUri.fsPath}:`, mdErr);
				}
			}

			// 3. Append execution record to .agents/worklog.md or worklog.md
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
			const rawOutSummary = typeof finalOutput === 'object' ? JSON.stringify(finalOutput) : String(finalOutput);
			const truncatedOutSummary = rawOutSummary.length > 500 ? `${rawOutSummary.substring(0, 500)}... (${rawOutSummary.length} chars total)` : rawOutSummary;
			const logBody = `- **Execution Status**: Completed\n- **Output Summary**: ${truncatedOutSummary}\n`;

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
		contextVariables?: Record<string, any>,
		externalScripts?: string[]
	): Promise<IPythonExecutionResult> {
		const startTime = Date.now();
		const startEpoch = this._cancelEpoch;
		const wsUri = this._toUri(workspaceUri);
		const tUri = this._toUri(ticketUri);

		const timestamp = Date.now();
		const randSuffix = Math.random().toString(36).substring(2, 7);
		const tmpDirPath = (typeof process !== 'undefined' && process.env && (process.env.TMPDIR || process.env.TEMP))
			? (process.env.TMPDIR || process.env.TEMP)!.replace(/\/+$/, '')
			: '/tmp';
		const scriptUri = URI.file(`${tmpDirPath}/.anyagent_py_${timestamp}_${randSuffix}.py`);
		const logUri = URI.file(`${tmpDirPath}/.anyagent_py_${timestamp}_${randSuffix}.log`);
		const resultUri = URI.file(`${tmpDirPath}/.anyagent_py_${timestamp}_${randSuffix}.result.json`);

		try {
			if (this._cancelEpoch !== startEpoch) {
				return {
					success: false,
					output: '[Cancelled]',
					exitCode: 130,
					durationMs: 0,
					pythonPath,
					error: 'Python script execution cancelled by Stop request'
				};
			}

			// 2. Prepare script with injected context variables, return value capture, and TICKET_CONTEXT dictionary
			// Pre-resolve any ticket IDs or handles referenced by GET_OUTPUTS / get_outputs / GET_TICKETS / get_tickets
			const preResolvedOutputs: Record<string, any> = {};
			const preResolvedTickets: Record<string, any> = {};
			try {
				const candidateTicketIds = new Set<string>();
				const idMatches = (code || '').matchAll(/["']([A-Za-z0-9_]+-\d+)["']/g);
				for (const m of idMatches) {
					if (m[1]) candidateTicketIds.add(m[1].trim());
				}
				const fnCallMatches = (code || '').matchAll(/\b(?:GET_OUTPUTS|get_outputs|GET_TICKETS|get_tickets)\s*\(\s*(?:(?:ticket_id|ticket|tickets|ticket_name)\s*=\s*)?["']([^"']+)["']/g);
				for (const m of fnCallMatches) {
					if (m[1]) candidateTicketIds.add(m[1].trim());
				}
				if (contextVariables && typeof contextVariables === 'object') {
					for (const val of Object.values(contextVariables)) {
						if (val && typeof val === 'object' && val.ticketId) {
							candidateTicketIds.add(String(val.ticketId).trim());
						}
					}
				}
				for (const tid of candidateTicketIds) {
					if (!tid) continue;
					const tRes = await this.getTicket(wsUri, tid);
					if (tRes.success) {
						const outDict = await this.getOutputs(wsUri, tRes);
						preResolvedOutputs[tid] = outDict;
						preResolvedOutputs[tid.toLowerCase()] = outDict;
						if (tRes.ticketId) {
							preResolvedOutputs[tRes.ticketId] = outDict;
							preResolvedOutputs[tRes.ticketId.toLowerCase()] = outDict;
						}
						const cleanTicket = { ...tRes, schema: undefined };
						preResolvedTickets[tid] = cleanTicket;
						preResolvedTickets[tid.toLowerCase()] = cleanTicket;
					}
				}
			} catch { }

			// Strip nested contextVariables / stepResults and duplicate @-prefixed keys to prevent exponential script bloat in loops
			const sanitizedCtx: Record<string, any> = {};
			if (contextVariables && typeof contextVariables === 'object') {
				for (const [k, v] of Object.entries(contextVariables)) {
					if (k === 'contextVariables' || k === 'stepResults') continue;
					if (v && typeof v === 'object' && !Array.isArray(v) && ('contextVariables' in v || 'stepResults' in v)) {
						const { contextVariables: _cv, stepResults: _sr, ...rest } = v;
						sanitizedCtx[k] = rest;
					} else {
						sanitizedCtx[k] = v;
					}
				}
			}
			const ctxJson = JSON.stringify(sanitizedCtx);
			const preOutputsJson = JSON.stringify(preResolvedOutputs);
			const preTicketsJson = JSON.stringify(preResolvedTickets);
			const wsPathStr = wsUri.fsPath.replace(/\\/g, '\\\\');
			const ticketPathStr = tUri.fsPath.replace(/\\/g, '\\\\');
			const resultFilePathStr = resultUri.fsPath.replace(/\\/g, '\\\\');
			const header = `# -*- coding: utf-8 -*-
import os, sys, json, re, atexit

_ANYAGENT_RESULT_FILE = "${resultFilePathStr}"
_ANYAGENT_WS_DIR = "${wsPathStr}"
_ANYAGENT_TICKET_DIR = "${ticketPathStr}"
_ANYAGENT_HAS_EXPLICIT_OUTPUT = False

def set_output(val):
    global _ANYAGENT_HAS_EXPLICIT_OUTPUT
    _ANYAGENT_HAS_EXPLICIT_OUTPUT = True
    try:
        with open(_ANYAGENT_RESULT_FILE, "w", encoding="utf-8") as _f:
            json.dump({"hasOutput": True, "value": val}, _f, ensure_ascii=False, default=str)
    except Exception:
        pass

def return_output(val):
    set_output(val)

try:
    _raw_context = json.loads(${JSON.stringify(ctxJson)})
except Exception:
    _raw_context = {}

try:
    _pre_resolved_outputs = json.loads(${JSON.stringify(preOutputsJson)})
except Exception:
    _pre_resolved_outputs = {}

try:
    _pre_resolved_tickets = json.loads(${JSON.stringify(preTicketsJson)})
except Exception:
    _pre_resolved_tickets = {}

def _anyagent_smart_parse(v):
    if isinstance(v, str):
        s = v.strip()
        if (s.startswith('{') and s.endswith('}')) or (s.startswith('[') and s.endswith(']')):
            try:
                return json.loads(s)
            except Exception:
                pass
        if '\`\`\`json' in s:
            try:
                part = s.split('\`\`\`json', 1)[1].split('\`\`\`', 1)[0].strip()
                return json.loads(part)
            except Exception:
                pass
        elif '\`\`\`' in s:
            try:
                part = s.split('\`\`\`', 1)[1].split('\`\`\`', 1)[0].strip()
                return json.loads(part)
            except Exception:
                pass
        return v
    elif isinstance(v, dict):
        return {k: _anyagent_smart_parse(sub_v) for k, sub_v in v.items()}
    elif isinstance(v, list):
        return [_anyagent_smart_parse(sub_v) for sub_v in v]
    return v

def _anyagent_find_ticket_dir(ticket_id_or_obj):
    if isinstance(ticket_id_or_obj, dict):
        for k in ('targetFolder', 'entityUri', 'path'):
            p = ticket_id_or_obj.get(k)
            if isinstance(p, str) and p.strip():
                clean_p = p.replace('file://', '')
                if os.path.isdir(clean_p):
                    return clean_p
        tid = ticket_id_or_obj.get('ticketId') or ticket_id_or_obj.get('ticket_id') or ticket_id_or_obj.get('ticketName') or ticket_id_or_obj.get('id')
    else:
        tid = str(ticket_id_or_obj or '').strip()
    if not tid:
        return None
    if os.path.isdir(tid):
        return tid
    roots = []
    for base in (_ANYAGENT_WS_DIR, _ANYAGENT_TICKET_DIR):
        cur = base
        for _ in range(4):
            if cur and cur not in roots and os.path.isdir(cur):
                roots.append(cur)
            parent = os.path.dirname(cur) if cur else ''
            if not parent or parent == cur:
                break
            cur = parent
    for r in roots:
        cand = os.path.join(r, tid)
        if os.path.isdir(cand) and (os.path.exists(os.path.join(cand, '.agents', 'ticket.md')) or os.path.exists(os.path.join(cand, 'ticket.md'))):
            return cand
    return None

def _anyagent_extract_clean_meta_val(raw_val):
    if raw_val is None:
        return None
    if isinstance(raw_val, (list, dict)):
        if isinstance(raw_val, list):
            return raw_val if len(raw_val) > 0 else None
        if 'rows' in raw_val and isinstance(raw_val['rows'], list):
            sql_out = str(raw_val.get('sqlOutput') or '').strip()
            if sql_out:
                return sql_out
            return raw_val['rows'] if len(raw_val['rows']) > 0 else None
        if any(k in raw_val for k in ('prompt', 'preInjectedPrompt', 'userPrompt', 'userPrompts')):
            out = str(raw_val.get('output') or '').strip()
            return _anyagent_smart_parse(out) if out else None
        if any(k in raw_val for k in ('pythonCode', 'code', 'pythonPath')):
            res = raw_val.get('result')
            if res is not None and str(res).strip() != '':
                return _anyagent_smart_parse(res)
            out = str(raw_val.get('output') or '').strip()
            return _anyagent_smart_parse(out) if out else None
        if 'url' in raw_val and 'content' in raw_val:
            c = str(raw_val.get('content') or '').strip()
            return _anyagent_smart_parse(c) if c else None
        if 'text' in raw_val:
            t = str(raw_val.get('text') or '').strip()
            return _anyagent_smart_parse(t) if t else None
        if 'output' in raw_val:
            o = str(raw_val.get('output') or '').strip()
            return _anyagent_smart_parse(o) if o else None
        if 'result' in raw_val:
            return _anyagent_smart_parse(raw_val.get('result'))
        return raw_val
    if isinstance(raw_val, str):
        s = raw_val.strip()
        if not s or s.startswith('(Pending AI Execution') or s == '(Python script ready)':
            return None
        if (s.startswith('{') and s.endswith('}')) or (s.startswith('[') and s.endswith(']')):
            try:
                parsed = json.loads(s)
                return _anyagent_extract_clean_meta_val(parsed)
            except Exception:
                pass
        return _anyagent_smart_parse(s)
    return raw_val

def get_outputs(ticket=None, *, ticket_id=None, ticket_name=None, tickets=None):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (ticket_name if ticket_name is not None else tickets))
    if target is None:
        return None
    lookup_key = None
    if isinstance(target, str):
        lookup_key = target.strip()
    elif isinstance(target, dict):
        lookup_key = str(target.get('ticketId') or target.get('ticket_id') or target.get('ticketName') or target.get('id') or '').strip()
    if lookup_key:
        if lookup_key in _pre_resolved_outputs:
            return _pre_resolved_outputs[lookup_key]
        if lookup_key.lower() in _pre_resolved_outputs:
            return _pre_resolved_outputs[lookup_key.lower()]
    if isinstance(target, dict) and 'outputs' in target and isinstance(target['outputs'], dict):
        return _anyagent_smart_parse(target['outputs'])
    t_dir = _anyagent_find_ticket_dir(target)
    if not t_dir:
        return None
    md_path = os.path.join(t_dir, '.agents', 'ticket.md')
    if not os.path.exists(md_path):
        md_path = os.path.join(t_dir, 'ticket.md')
    if not os.path.exists(md_path):
        return None
    custom_meta = {}
    ticket_type = ''
    in_self = False
    try:
        with open(md_path, 'r', encoding='utf-8') as f:
            for line in f:
                rline = line.rstrip('\\r\\n')
                if rline.startswith('### Self Defined Data'):
                    in_self = True
                    continue
                if rline.startswith('### ') or (rline.startswith('## ') and not rline.startswith('## Overview')):
                    in_self = False
                m = re.match(r'^\\s*-\\s*\\*\\*([^*]+)\\*\\*:\\s*(.*)$', rline)
                if m:
                    k = m.group(1).strip()
                    v = m.group(2).strip()
                    if in_self and rline.startswith('  -'):
                        custom_meta[k] = v
                    elif k == 'Ticket Type' and v:
                        ticket_type = v
    except Exception:
        return None
    # Locate schema yaml to check for output component and outputSpecs
    schema_paths = []
    if ticket_type:
        cur = t_dir
        for _ in range(4):
            schema_paths.append(os.path.join(cur, '.agents', 'entity_type', f'{ticket_type}.yaml'))
            schema_paths.append(os.path.join(cur, '.agents', 'entity_type', f'{ticket_type}.yml'))
            parent = os.path.dirname(cur)
            if not parent or parent == cur:
                break
            cur = parent
        home_dir = os.path.expanduser('~')
        schema_paths.append(os.path.join(home_dir, '.anyagent', 'entity_type', f'{ticket_type}.yaml'))
        schema_paths.append(os.path.join(home_dir, '.anyagent', 'entity_type', f'{ticket_type}.yml'))
    has_output_comp = False
    output_specs = []
    for sp in schema_paths:
        if os.path.exists(sp):
            try:
                with open(sp, 'r', encoding='utf-8') as sf:
                    ytext = sf.read()
                if re.search(r'^\\s*type:\\s*(output|result)\\s*$', ytext, re.MULTILINE):
                    has_output_comp = True
                    in_specs = False
                    cur_spec = {}
                    for yline in ytext.splitlines():
                        if re.match(r'^\\s*outputSpecs:\\s*$', yline):
                            in_specs = True
                            continue
                        if in_specs:
                            if re.match(r'^\\s*-\\s+fieldKey:\\s*(.+)$', yline):
                                if cur_spec.get('fieldKey') and cur_spec.get('enabled', True) is not False:
                                    output_specs.append(cur_spec)
                                fk = re.match(r'^\\s*-\\s+fieldKey:\\s*(.+)$', yline).group(1).strip().strip('"').strip("'")
                                cur_spec = {'fieldKey': fk, 'label': fk, 'enabled': True}
                            elif re.match(r'^\\s+label:\\s*(.+)$', yline) and cur_spec:
                                cur_spec['label'] = re.match(r'^\\s+label:\\s*(.+)$', yline).group(1).strip().strip('"').strip("'")
                            elif re.match(r'^\\s+enabled:\\s*(.+)$', yline) and cur_spec:
                                cur_spec['enabled'] = re.match(r'^\\s+enabled:\\s*(.+)$', yline).group(1).strip().lower() != 'false'
                            elif re.match(r'^\\s{0,4}[a-zA-Z_-]+:', yline) and not yline.strip().startswith('-'):
                                in_specs = False
                    if cur_spec.get('fieldKey') and cur_spec.get('enabled', True) is not False:
                        output_specs.append(cur_spec)
                break
            except Exception:
                pass
    saved_outputs = {}
    for mk, mv in custom_meta.items():
        if re.match(r'^output(\\s+\\d+|_\\d+)?$', mk.strip(), re.IGNORECASE) and mv.startswith('{'):
            try:
                parsed_out = json.loads(mv)
                if isinstance(parsed_out, dict):
                    for ok, ov in parsed_out.items():
                        if ok not in ('outputSpecs', 'output_specs'):
                            saved_outputs[ok] = ov
            except Exception:
                pass
    if not has_output_comp and not saved_outputs:
        return None
    res = {}
    if output_specs:
        for spec in output_specs:
            lbl = spec.get('label') or spec.get('fieldKey')
            fk = spec.get('fieldKey') or lbl
            val = None
            raw_m = custom_meta.get(lbl) or custom_meta.get(fk)
            if raw_m is not None:
                val = _anyagent_extract_clean_meta_val(raw_m)
            if val is None or val == '':
                if lbl in saved_outputs:
                    val = _anyagent_extract_clean_meta_val(saved_outputs[lbl])
                elif fk in saved_outputs:
                    val = _anyagent_extract_clean_meta_val(saved_outputs[fk])
            res[lbl] = val
        return res
    for ok, ov in saved_outputs.items():
        res[ok] = _anyagent_extract_clean_meta_val(ov)
    return res if res else None

GET_OUTPUTS = get_outputs

def get_tickets(ticket=None, *, ticket_id=None, ticket_name=None, tickets=None):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (ticket_name if ticket_name is not None else tickets))
    if isinstance(target, str) and target.strip() in _pre_resolved_tickets:
        return _pre_resolved_tickets[target.strip()]
    if isinstance(target, str) and target.strip().lower() in _pre_resolved_tickets:
        return _pre_resolved_tickets[target.strip().lower()]
    return target

GET_TICKETS = get_tickets

def _anyagent_extract_sql_preview_rows(text):
    if not isinstance(text, str) or '--- [Query Rows Preview' not in text:
        return None
    try:
        after_hdr = text.split('--- [Query Rows Preview', 1)[1]
        nl_idx = after_hdr.find('\\n')
        if nl_idx != -1:
            json_part = after_hdr[nl_idx + 1:].strip()
            if json_part.startswith('[') and json_part.endswith(']'):
                return json.loads(json_part)
    except Exception:
        pass
    return None

def _anyagent_unwrap_primitive_val(k, v):
    if k in ('Parameters', 'parameters'):
        if isinstance(v, str) and v.strip().startswith('{'):
            try:
                return json.loads(v.strip())
            except Exception:
                pass
        return v if isinstance(v, dict) else _anyagent_smart_parse(v)
    if isinstance(v, str):
        s = v.strip()
        if not str(k).endswith('.sqlOutput') and not str(k).endswith('_output'):
            preview_rows = _anyagent_extract_sql_preview_rows(s)
            if preview_rows is not None:
                return preview_rows
        if s.startswith('{') and s.endswith('}'):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, dict):
                    return _anyagent_unwrap_primitive_val(k, parsed)
            except Exception:
                pass
        return _anyagent_smart_parse(v)
    if isinstance(v, dict):
        if any(pk in v for pk in ('preInjectedPrompt', 'userPrompts', 'targetModel', 'targetMode')):
            out = str(v.get('output') or '').strip()
            return _anyagent_smart_parse(out) if out else {}
        if any(pk in v for pk in ('pythonCode', 'pythonPath', 'pythonEnvMode', 'externalScripts')):
            res = v.get('result')
            if res is not None and str(res).strip() != '':
                return _anyagent_smart_parse(res)
            out = str(v.get('output') or '').strip()
            return _anyagent_smart_parse(out) if out else {}
        if 'url' in v and 'content' in v and ('credentials' in v or 'lastFetched' in v):
            c = str(v.get('content') or '').strip()
            return _anyagent_smart_parse(c) if c else ''
        if 'rows' in v and isinstance(v['rows'], list) and ('columns' in v or 'dbEngine' in v or 'sqlOutput' in v):
            if len(v['rows']) > 0:
                return v['rows']
            sql_out = str(v.get('sqlOutput') or '').strip()
            preview_rows = _anyagent_extract_sql_preview_rows(sql_out)
            if preview_rows is not None:
                return preview_rows
            return v['rows']
        return {sub_k: _anyagent_smart_parse(sub_v) for sub_k, sub_v in v.items()}
    return _anyagent_smart_parse(v)

TICKET_CONTEXT = {k: _anyagent_unwrap_primitive_val(k, v) for k, v in _raw_context.items()}
if 'Parameters' in TICKET_CONTEXT and 'Inputs' not in TICKET_CONTEXT:
    TICKET_CONTEXT['Inputs'] = TICKET_CONTEXT['Parameters']
elif 'Inputs' in TICKET_CONTEXT and 'Parameters' not in TICKET_CONTEXT:
    TICKET_CONTEXT['Parameters'] = TICKET_CONTEXT['Inputs']
ticket_context = TICKET_CONTEXT
context = TICKET_CONTEXT

# Expose valid Python identifiers from TICKET_CONTEXT and TICKET_CONTEXT['Parameters'] directly into globals()
import builtins as _py_builtins, keyword as _py_keyword
_py_reserved = set(dir(_py_builtins)) | set(_py_keyword.kwlist) | {'TICKET_CONTEXT', 'ticket_context', 'context', 'OUTPUT', 'RESULT', 'GET_OUTPUTS', 'get_outputs', 'GET_TICKETS', 'get_tickets', 'set_output', 'return_output'}
for _ctx_k, _ctx_v in list(TICKET_CONTEXT.items()):
    if isinstance(_ctx_k, str) and _ctx_k.isidentifier() and _ctx_k not in _py_reserved and _ctx_k not in globals():
        globals()[_ctx_k] = _ctx_v
_params_dict = TICKET_CONTEXT.get('Parameters')
if isinstance(_params_dict, dict):
    for _pk, _pv in list(_params_dict.items()):
        if isinstance(_pk, str) and _pk.isidentifier() and _pk not in _py_reserved:
            globals()[_pk] = _pv
            if _pk not in TICKET_CONTEXT:
                TICKET_CONTEXT[_pk] = _pv

try:
    os.environ['ANY_AGENT_CONTEXT'] = json.dumps(_raw_context)
except Exception:
    pass

def _anyagent_capture_exit_output():
    if _ANYAGENT_HAS_EXPLICIT_OUTPUT or os.path.exists(_ANYAGENT_RESULT_FILE):
        return
    gl = globals()
    for candidate in ['OUTPUT', 'RESULT', 'output', 'result', 'RETURN_VALUE', 'return_value']:
        if candidate in gl and gl[candidate] is not None:
            try:
                with open(_ANYAGENT_RESULT_FILE, "w", encoding="utf-8") as _f:
                    json.dump({"hasOutput": True, "value": gl[candidate]}, _f, ensure_ascii=False, default=str)
                break
            except Exception:
                pass

atexit.register(_anyagent_capture_exit_output)

`;
			await this.fileService.writeFile(scriptUri, VSBuffer.fromString(header + code));
			try {
				await this.fileService.writeFile(logUri, VSBuffer.fromString(''));
			} catch { }

			// 3. Resolve Python interpreter and virtualenv environment variables
			let cleanPyPath = '';
			if (typeof pythonPath === 'string') {
				cleanPyPath = pythonPath.trim();
			} else if (pythonPath && typeof pythonPath === 'object') {
				cleanPyPath = String((pythonPath as any).interpreterPath || (pythonPath as any).pythonPath || '').trim();
			}
			if (cleanPyPath === '[object Object]' || cleanPyPath === 'undefined' || cleanPyPath === 'null') {
				cleanPyPath = '';
			}

			const envDetection = await this.detectPythonEnvironment(wsUri, cleanPyPath);
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

			// Pipeline: Execute external scripts in order first, then inline script
			const commands: string[] = [];
			const validExtScripts = (Array.isArray(externalScripts) ? externalScripts : []).map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
			const hasInlineCode = Boolean(code && code.trim().length > 0);
			const totalSteps = validExtScripts.length + (hasInlineCode ? 1 : 0);
			let stepIdx = 0;

			for (let i = 0; i < validExtScripts.length; i++) {
				stepIdx++;
				const rawScript = validExtScripts[i];
				let targetPath = rawScript;
				if (!rawScript.startsWith('/') && !/^[a-zA-Z]:[/\\]/.test(rawScript)) {
					targetPath = URI.joinPath(wsUri, rawScript).fsPath;
				}
				const escExt = `"${targetPath}"`;
				const banner = `>>> [Pipeline Step ${stepIdx}/${totalSteps}] External Script: ${rawScript}`;
				commands.push(`echo ${JSON.stringify(banner)} >> ${escapedLog}`);
				commands.push(`${escapedPy} -u ${escExt} >> ${escapedLog} 2>&1`);
				commands.push(`echo "[✓ Step ${stepIdx} finished with exit code 0]\n" >> ${escapedLog}`);
			}

			if (hasInlineCode || commands.length === 0) {
				stepIdx++;
				const banner = totalSteps > 1
					? `>>> [Pipeline Step ${stepIdx}/${totalSteps}] Inline Python Code`
					: `>>> Running Python Script`;
				commands.push(`echo ${JSON.stringify(banner)} >> ${escapedLog}`);
				commands.push(`${escapedPy} -u ${escapedScript} >> ${escapedLog} 2>&1`);
				commands.push(`echo "[✓ Step ${stepIdx} finished with exit code 0]" >> ${escapedLog}`);
			}

			const chained = commands.join(' && ');
			const runCmd = `${venvPrefix}${chained}; echo "${sentinel}:$?"`;

			let exitCode = 0;
			let finished = false;
			let activeEntry: { terminal: any; abort: () => void; label: string } | undefined;

			const waitPromise = new Promise<void>((resolve) => {
				let dataListener: { dispose(): void } | undefined;
				let exitListener: { dispose(): void } | undefined;
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') {
							exitCode = codeOverride;
						}
						finished = true;
						dataListener?.dispose();
						exitListener?.dispose();
						resolve();
					}
				};
				activeEntry = {
					terminal,
					abort: () => finishOnce(130),
					label: 'AnyAgent Python Runner'
				};
				this._activeTerminals.add(activeEntry);

				const regex = new RegExp(`${sentinel}:(\\d+)`);
				dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				exitListener = terminal.onExit(code => {
					finishOnce(typeof code === 'number' ? code : exitCode);
				});

				setTimeout(() => {
					finishOnce();
				}, 60000);
			});

			try {
				if (this._cancelEpoch !== startEpoch) {
					activeEntry?.abort();
				} else {
					await terminal.sendText(runCmd, true);
					await waitPromise;
				}
			} finally {
				if (activeEntry) {
					this._activeTerminals.delete(activeEntry);
				}
			}

			// 5. Read output log and result JSON
			let output = '';
			if (await this.fileService.exists(logUri)) {
				try {
					output = (await this.fileService.readFile(logUri)).value.toString();
				} catch { }
			}

			let scriptResult: any = undefined;
			if (await this.fileService.exists(resultUri)) {
				try {
					const resultRaw = (await this.fileService.readFile(resultUri)).value.toString();
					const parsed = JSON.parse(resultRaw);
					if (parsed && parsed.hasOutput) {
						scriptResult = parsed.value;
					}
				} catch { }
			}

			// Fallback: If no explicit OUTPUT was set, check if stdout contains JSON or markdown json
			if (scriptResult === undefined && output.trim()) {
				const trimmed = output.trim();
				if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
					try {
						scriptResult = JSON.parse(trimmed);
					} catch { }
				} else {
					const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
					if (match && match[1]) {
						try {
							scriptResult = JSON.parse(match[1].trim());
						} catch { }
					}
				}
			}

			try {
				terminal.dispose();
			} catch { }
			for (const tmpUri of [scriptUri, logUri, resultUri]) {
				try {
					if (await this.fileService.exists(tmpUri)) {
						await this.fileService.del(tmpUri);
					}
				} catch { }
			}

			if (this._cancelEpoch !== startEpoch) {
				return {
					success: false,
					output: output.trim() || '[Terminated by Stop]',
					result: undefined,
					exitCode: 130,
					durationMs: Date.now() - startTime,
					pythonPath: resolvedPython,
					error: 'Python script execution cancelled by Stop request'
				};
			}

			return {
				success: exitCode === 0,
				output: output.trim(),
				result: scriptResult,
				exitCode,
				durationMs: Date.now() - startTime,
				pythonPath: resolvedPython
			};
		} catch (err: any) {
			for (const tmpUri of [scriptUri, logUri, resultUri]) {
				try {
					if (await this.fileService.exists(tmpUri)) {
						await this.fileService.del(tmpUri);
					}
				} catch { }
			}
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
				let dataListener: { dispose(): void } | undefined;
				let exitListener: { dispose(): void } | undefined;
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') exitCode = codeOverride;
						finished = true;
						dataListener?.dispose();
						exitListener?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				exitListener = terminal.onExit(code => {
					finishOnce(typeof code === 'number' ? code : undefined);
				});

				setTimeout(() => {
					finishOnce();
				}, 60000);
			});

			await terminal.sendText(cmd, true);
			await waitPromise;

			let logOutput = '';
			if (await this.fileService.exists(logUri)) {
				try {
					logOutput = (await this.fileService.readFile(logUri)).value.toString();
					await this.fileService.del(logUri);
				} catch { }
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

		const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const tmpDirUri = URI.file('/tmp');
		const logUri = URI.joinPath(tmpDirUri, `.anyagent_py_test_${timestamp}.log`);

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
				let dataListener: { dispose(): void } | undefined;
				let exitListener: { dispose(): void } | undefined;
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') exitCode = codeOverride;
						finished = true;
						dataListener?.dispose();
						exitListener?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				exitListener = terminal.onExit(code => {
					finishOnce(typeof code === 'number' ? code : undefined);
				});

				setTimeout(() => {
					finishOnce();
				}, 15000);
			});

			await terminal.sendText(cmd, true);
			await waitPromise;

			let output = '';
			if (await this.fileService.exists(logUri)) {
				try {
					output = (await this.fileService.readFile(logUri)).value.toString().trim();
					await this.fileService.del(logUri);
				} catch { }
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

	async analyzeWorkflowPythonNodesWithAst(
		workspaceUri: string | URI,
		pythonPath: string | undefined,
		nodes: Array<{ nodeId: string; title: string; code: string; codeStartLine: number }>
	): Promise<{
		invoked: boolean;
		spansByNodeId: Map<string, Array<{ lineno: number; end_lineno: number }>>;
		syntaxErrors: Array<{ nodeId: string; title: string; line: number; message: string }>;
	}> {
		const spansByNodeId = new Map<string, Array<{ lineno: number; end_lineno: number }>>();
		const syntaxErrors: Array<{ nodeId: string; title: string; line: number; message: string }> = [];
		const nonEmptyNodes = nodes.filter(n => n.code && n.code.trim().length > 0);
		if (nonEmptyNodes.length === 0) {
			return { invoked: true, spansByNodeId, syntaxErrors };
		}

		const wsUri = this._toUri(workspaceUri);
		const envDetection = await this.detectPythonEnvironment(wsUri, pythonPath);
		const resolved = (envDetection.isValid && envDetection.interpreterPath) ? envDetection.interpreterPath : 'python3';
		const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const tmpDir = URI.file('/tmp');
		const inputUri = URI.joinPath(tmpDir, `.anyagent_wf_ast_in_${timestamp}.json`);
		const scriptUri = URI.joinPath(tmpDir, `.anyagent_wf_ast_parse_${timestamp}.py`);
		const outUri = URI.joinPath(tmpDir, `.anyagent_wf_ast_out_${timestamp}.json`);

		const pyScript = [
			'import ast, json, sys',
			'in_path, out_path = sys.argv[1], sys.argv[2]',
			'with open(in_path, "r", encoding="utf-8") as f:',
			'    items = json.load(f)',
			'res = {"spans": {}, "errors": []}',
			'for item in items:',
			'    nid = item.get("nodeId", "")',
			'    title = item.get("title", "")',
			'    code = item.get("code", "")',
			'    base_line = int(item.get("codeStartLine", 1))',
			'    try:',
			'        tree = ast.parse(code)',
			'        spans = []',
			'        for stmt in tree.body:',
			'            decs = getattr(stmt, "decorator_list", []) or []',
			'            start_ln = min([stmt.lineno] + [d.lineno for d in decs if hasattr(d, "lineno")])',
			'            end_ln = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno',
			'            spans.append({"lineno": start_ln, "end_lineno": end_ln})',
			'        res["spans"][nid] = spans',
			'    except SyntaxError as e:',
			'        err_ln = base_line + ((e.lineno or 1) - 1)',
			'        res["errors"].append({"nodeId": nid, "title": title, "line": err_ln, "message": f"{type(e).__name__}: {e.msg}"})',
			'with open(out_path, "w", encoding="utf-8") as f:',
			'    json.dump(res, f, ensure_ascii=False)',
		].join('\n');

		try {
			await this.fileService.writeFile(inputUri, VSBuffer.fromString(JSON.stringify(nonEmptyNodes)));
			await this.fileService.writeFile(scriptUri, VSBuffer.fromString(pyScript));

			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent Python AST Parser',
					cwd: wsUri,
					hideFromUser: true
				}
			});

			const sentinel = `___PY_AST_${timestamp}___`;
			const escapedPy = resolved.includes(' ') ? `"${resolved}"` : resolved;
			const cmd = `${escapedPy} "${scriptUri.fsPath}" "${inputUri.fsPath}" "${outUri.fsPath}"; echo "${sentinel}:$?"`;

			let finished = false;
			const waitPromise = new Promise<void>((resolve) => {
				let dataListener: { dispose(): void } | undefined;
				let exitListener: { dispose(): void } | undefined;
				const finishOnce = () => {
					if (!finished) {
						finished = true;
						dataListener?.dispose();
						exitListener?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				dataListener = terminal.onData(data => {
					if (regex.test(data)) {
						finishOnce();
					}
				});
				exitListener = terminal.onExit(() => {
					finishOnce();
				});
				setTimeout(() => {
					finishOnce();
				}, 4000);
			});

			await terminal.sendText(cmd, true);
			await waitPromise;
			terminal.dispose();

			let invoked = false;
			if (await this.fileService.exists(outUri)) {
				const rawOut = (await this.fileService.readFile(outUri)).value.toString();
				const parsedOut = JSON.parse(rawOut);
				invoked = true;
				if (parsedOut && typeof parsedOut.spans === 'object') {
					for (const [nid, spArr] of Object.entries(parsedOut.spans)) {
						if (Array.isArray(spArr)) {
							spansByNodeId.set(nid, spArr as Array<{ lineno: number; end_lineno: number }>);
						}
					}
				}
				if (parsedOut && Array.isArray(parsedOut.errors)) {
					for (const e of parsedOut.errors) {
						syntaxErrors.push(e);
					}
				}
			}

			try { await this.fileService.del(inputUri); } catch { }
			try { await this.fileService.del(scriptUri); } catch { }
			try { await this.fileService.del(outUri); } catch { }

			return { invoked, spansByNodeId, syntaxErrors };
		} catch {
			try { await this.fileService.del(inputUri); } catch { }
			try { await this.fileService.del(scriptUri); } catch { }
			try { await this.fileService.del(outUri); } catch { }
			return { invoked: false, spansByNodeId, syntaxErrors };
		}
	}

	async detectPythonEnvironment(workspaceUri: string | URI, candidatePath?: string | any): Promise<IPythonEnvironmentDetectionResult> {
		const wsUri = this._toUri(workspaceUri);
		let rawPath = '';
		if (typeof candidatePath === 'string') {
			rawPath = candidatePath.trim();
		} else if (candidatePath && typeof candidatePath === 'object') {
			rawPath = String(candidatePath.interpreterPath || candidatePath.pythonPath || '').trim();
		}
		if (rawPath === '[object Object]' || rawPath === 'undefined' || rawPath === 'null') {
			rawPath = '';
		}
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

	async executeSqliteTableOperation(options: ISqliteTableOperationOptions): Promise<ISqliteTableOperationResult> {
		const rawDbPath = (options.dbPath || '').trim();
		const rawTableName = (options.tableName || 'ticket_table').trim() || 'ticket_table';
		const action = options.action || 'save';

		if (!rawDbPath && action !== 'query') {
			return {
				success: false,
				dbPath: '',
				tableName: rawTableName,
				action,
				error: 'SQLite database path is empty. Please specify or create a .sqlite / .db file first.'
			};
		}

		let baseUri: URI;
		if (options.ticketUri) {
			baseUri = this._toUri(options.ticketUri);
		} else if (options.workingDirUri) {
			baseUri = this._toUri(options.workingDirUri);
		} else if (options.workspaceUri) {
			baseUri = this._toUri(options.workspaceUri);
		} else {
			baseUri = URI.file('/tmp');
		}

		let resolvedDbPath = ':memory:';
		let workDirUri = baseUri;
		if (rawDbPath && rawDbPath !== ':memory:') {
			let resolvedDbUri: URI;
			if (rawDbPath.startsWith('file://')) {
				resolvedDbUri = URI.parse(rawDbPath);
			} else if (rawDbPath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(rawDbPath)) {
				resolvedDbUri = URI.file(rawDbPath);
			} else {
				resolvedDbUri = URI.joinPath(baseUri, rawDbPath);
			}
			resolvedDbPath = resolvedDbUri.fsPath;
			workDirUri = (await this.fileService.exists(baseUri)) ? baseUri : URI.joinPath(resolvedDbUri, '..');
		} else if (!(await this.fileService.exists(workDirUri))) {
			workDirUri = URI.file('/tmp');
		}
		if (!(await this.fileService.exists(workDirUri))) {
			try {
				await this.fileService.createFolder(workDirUri);
			} catch { }
		}

		const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const tmpDirUri = URI.file('/tmp');
		const inJsonUri = URI.joinPath(tmpDirUri, `.anyagent_sqlite_op_in_${timestamp}.json`);
		const outJsonUri = URI.joinPath(tmpDirUri, `.anyagent_sqlite_op_out_${timestamp}.json`);
		const runnerPyUri = URI.joinPath(tmpDirUri, `.anyagent_sqlite_op_runner_${timestamp}.py`);
		const logUri = URI.joinPath(tmpDirUri, `.anyagent_sqlite_op_log_${timestamp}.log`);

		const payload = {
			dbPath: resolvedDbPath,
			tableName: rawTableName,
			action,
			columns: Array.isArray(options.columns) ? options.columns : [],
			rows: Array.isArray(options.rows) ? options.rows : [],
			whereClause: options.whereClause || '',
			sqlQuery: options.sqlQuery || '',
			limit: typeof options.limit === 'number' && options.limit > 0 ? options.limit : 1000,
			offset: typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0
		};

		const pythonRunner = [
			'import sys, os, json, sqlite3, re',
			'',
			`IN_PATH = ${JSON.stringify(inJsonUri.fsPath)}`,
			`OUT_PATH = ${JSON.stringify(outJsonUri.fsPath)}`,
			'',
			'def quote_ident(name):',
			'    s = str(name or "").strip()',
			'    if not s:',
			'        s = "col"',
			'    return \'"\' + s.replace(\'"\', \'""\') + \'"\'',
			'',
			'def normalize_sql_type(dt):',
			'    u = str(dt or "TEXT").strip().upper()',
			'    valid = ["TEXT", "VARCHAR(255)", "INTEGER", "REAL", "NUMERIC", "BOOLEAN", "DATE", "DATETIME", "JSON", "BLOB"]',
			'    if u in valid:',
			'        return u',
			'    if "INT" in u:',
			'        return "INTEGER"',
			'    if "CHAR" in u or "CLOB" in u or "TEXT" in u:',
			'        return "TEXT"',
			'    if "BLOB" in u:',
			'        return "BLOB"',
			'    if "REAL" in u or "FLOA" in u or "DOUB" in u:',
			'        return "REAL"',
			'    if "BOOL" in u:',
			'        return "BOOLEAN"',
			'    if "DATE" in u or "TIME" in u:',
			'        return "DATETIME"',
			'    if "JSON" in u:',
			'        return "JSON"',
			'    return "NUMERIC"',
			'',
			'def coerce_cell_value(val, dt):',
			'    if val is None:',
			'        return None',
			'    u = normalize_sql_type(dt)',
			'    if isinstance(val, (dict, list)):',
			'        return json.dumps(val, ensure_ascii=False)',
			'    s = str(val)',
			'    if s == "" and u in ("INTEGER", "REAL", "NUMERIC", "BOOLEAN"):',
			'        return None',
			'    if u == "INTEGER":',
			'        try:',
			'            return int(float(s)) if "." in s else int(s)',
			'        except Exception:',
			'            return s',
			'    if u in ("REAL", "NUMERIC"):',
			'        try:',
			'            return float(s)',
			'        except Exception:',
			'            return s',
			'    if u == "BOOLEAN":',
			'        if isinstance(val, bool):',
			'            return 1 if val else 0',
			'        low = s.strip().lower()',
			'        if low in ("1", "true", "yes", "on"):',
			'            return 1',
			'        if low in ("0", "false", "no", "off"):',
			'            return 0',
			'        return s',
			'    return s',
			'',
			'def main():',
			'    with open(IN_PATH, "r", encoding="utf-8") as f:',
			'        req = json.load(f)',
			'    db_path = req.get("dbPath", "")',
			'    table_name = req.get("tableName", "ticket_table") or "ticket_table"',
			'    action = req.get("action", "save")',
			'    columns = req.get("columns") or []',
			'    rows = req.get("rows") or []',
			'    where_clause = req.get("whereClause") or ""',
			'    sql_query = req.get("sqlQuery") or ""',
			'    limit_val = int(req.get("limit") or 1000)',
			'    offset_val = int(req.get("offset") or 0)',
			'',
			'    res = {',
			'        "success": False,',
			'        "dbPath": db_path,',
			'        "tableName": table_name,',
			'        "action": action,',
			'        "columns": columns,',
			'        "rows": rows,',
			'        "rowCount": 0,',
			'        "affectedRows": 0,',
			'        "tables": [],',
			'        "message": ""',
			'    }',
			'',
			'    try:',
			'        if db_path != ":memory:":',
			'            parent_dir = os.path.dirname(os.path.abspath(db_path))',
			'            if parent_dir and not os.path.exists(parent_dir):',
			'                os.makedirs(parent_dir, exist_ok=True)',
			'',
			'        if action in ("load", "load_schema", "list_tables", "inspect_schema") and (db_path == ":memory:" or not os.path.exists(db_path)):',
			'            res["error"] = f"SQLite file does not exist yet: {db_path}"',
			'            with open(OUT_PATH, "w", encoding="utf-8") as out_f:',
			'                json.dump(res, out_f, ensure_ascii=False)',
			'            return',
			'',
			'        conn = sqlite3.connect(db_path)',
			'        conn.row_factory = sqlite3.Row',
			'        cur = conn.cursor()',
			'',
			'        def list_user_tables():',
			'            cur.execute("SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name")',
			'            return [r[0] for r in cur.fetchall()]',
			'',
			'        def inspect_table_columns(tbl):',
			'            cur.execute(f"PRAGMA table_info({quote_ident(tbl)})")',
			'            info = cur.fetchall()',
			'            out_cols = []',
			'            for idx, r in enumerate(info):',
			'                cname = r[1]',
			'                ctype = normalize_sql_type(r[2] or "TEXT")',
			'                notnull = bool(r[3])',
			'                dflt = r[4]',
			'                pk = bool(r[5])',
			'                out_cols.append({',
			'                    "id": f"col_{idx + 1}",',
			'                    "name": cname,',
			'                    "label": cname,',
			'                    "dataType": ctype,',
			'                    "primaryKey": pk,',
			'                    "nullable": not notnull,',
			'                    "defaultValue": str(dflt) if dflt is not None else ""',
			'                })',
			'            return out_cols',
			'',
			'        def normalize_col_defs(col_defs, sample_rows=None):',
			'            effective_cols = []',
			'            seen = set()',
			'            for idx, c in enumerate(col_defs or []):',
			'                cname = str(c.get("name") or c.get("label") or c.get("id") or f"col_{idx+1}").strip()',
			'                if not cname or cname.lower() in seen:',
			'                    continue',
			'                seen.add(cname.lower())',
			'                effective_cols.append({',
			'                    "id": c.get("id") or f"col_{idx+1}",',
			'                    "name": cname,',
			'                    "label": c.get("label") or cname,',
			'                    "dataType": normalize_sql_type(c.get("dataType") or "TEXT"),',
			'                    "primaryKey": bool(c.get("primaryKey")),',
			'                    "nullable": c.get("nullable", True) is not False,',
			'                    "defaultValue": c.get("defaultValue")',
			'                })',
			'            if not effective_cols and sample_rows and isinstance(sample_rows[0], dict):',
			'                for idx, k in enumerate(sample_rows[0].keys()):',
			'                    cname = str(k).strip()',
			'                    if not cname or cname.lower() in seen:',
			'                        continue',
			'                    seen.add(cname.lower())',
			'                    effective_cols.append({',
			'                        "id": f"col_{idx+1}",',
			'                        "name": cname,',
			'                        "label": cname,',
			'                        "dataType": "TEXT",',
			'                        "primaryKey": False,',
			'                        "nullable": True',
			'                    })',
			'            if not effective_cols:',
			'                effective_cols = [',
			'                    {"id": "col_1", "name": "id", "label": "id", "dataType": "INTEGER", "primaryKey": True, "nullable": False},',
			'                    {"id": "col_2", "name": "name", "label": "name", "dataType": "TEXT", "primaryKey": False, "nullable": True}',
			'                ]',
			'            return effective_cols',
			'',
			'        def build_create_table_sql(tbl, effective_cols, if_not_exists=True):',
			'            pk_cols = [c["name"] for c in effective_cols if c.get("primaryKey")]',
			'            col_sql_parts = []',
			'            for c in effective_cols:',
			'                part = f"{quote_ident(c[\'name\'])} {c[\'dataType\']}"',
			'                if len(pk_cols) == 1 and c.get("primaryKey"):',
			'                    part += " PRIMARY KEY"',
			'                col_sql_parts.append(part)',
			'            if len(pk_cols) > 1:',
			'                pk_expr = ", ".join(quote_ident(pk) for pk in pk_cols)',
			'                col_sql_parts.append(f"PRIMARY KEY ({pk_expr})")',
			'            ine = "IF NOT EXISTS " if if_not_exists else ""',
			'            return f"CREATE TABLE {ine}{quote_ident(tbl)} ({\', \'.join(col_sql_parts)})"',
			'',
			'        def ensure_table_and_columns(tbl, col_defs, sample_rows):',
			'            effective_cols = normalize_col_defs(col_defs, sample_rows)',
			'            pk_cols = [c["name"] for c in effective_cols if c.get("primaryKey")]',
			'            create_sql = build_create_table_sql(tbl, effective_cols, True)',
			'            cur.execute(create_sql)',
			'            existing_cols = inspect_table_columns(tbl)',
			'            existing_names_lower = {ec["name"].lower(): ec for ec in existing_cols}',
			'            for c in effective_cols:',
			'                if c["name"].lower() not in existing_names_lower:',
			'                    alter_sql = f"ALTER TABLE {quote_ident(tbl)} ADD COLUMN {quote_ident(c[\'name\'])} {c[\'dataType\']}"',
			'                    cur.execute(alter_sql)',
			'            existing_cols = inspect_table_columns(tbl)',
			'            existing_pks = [ec["name"].lower() for ec in existing_cols if ec.get("primaryKey")]',
			'            if existing_pks:',
			'                existing_pk_set = set(existing_pks)',
			'                for c in effective_cols:',
			'                    if c["name"].lower() in existing_pk_set:',
			'                        c["primaryKey"] = True',
			'            return effective_cols',
			'',
			'        if action == "init_db":',
			'            conn.commit()',
			'            tbls = list_user_tables()',
			'            res["success"] = True',
			'            res["tables"] = tbls',
			'            res["message"] = f"Initialized SQLite database file \'{os.path.basename(db_path)}\' ({len(tbls)} existing table(s))."',
			'        elif action == "list_tables":',
			'            tbls = list_user_tables()',
			'            res["success"] = True',
			'            res["tables"] = tbls',
			'            res["message"] = f"Found {len(tbls)} table(s) in {os.path.basename(db_path)}."',
			'        elif action == "inspect_schema":',
			'            tbls = list_user_tables()',
			'            res["tables"] = tbls',
			'            lower_map = {t.lower(): t for t in tbls}',
			'            if table_name in tbls or table_name.lower() in lower_map:',
			'                actual_tbl = table_name if table_name in tbls else lower_map[table_name.lower()]',
			'                res["tableName"] = actual_tbl',
			'                res["tableExists"] = True',
			'                db_cols = inspect_table_columns(actual_tbl)',
			'                cur.execute(f"SELECT COUNT(*) FROM {quote_ident(actual_tbl)}")',
			'                total_cnt = cur.fetchone()[0]',
			'                res["columns"] = db_cols',
			'                res["rowCount"] = total_cnt',
			'                res["success"] = True',
			'                res["message"] = f"Table \'{actual_tbl}\' exists with {len(db_cols)} column(s) and {total_cnt} row(s)."',
			'            else:',
			'                res["tableExists"] = False',
			'                res["columns"] = []',
			'                res["rowCount"] = 0',
			'                res["success"] = True',
			'                res["message"] = f"Table \'{table_name}\' does not exist yet in {os.path.basename(db_path)}."',
			'        elif action == "update_header":',
			'            effective_cols = normalize_col_defs(columns, rows)',
			'            tbls = list_user_tables()',
			'            lower_map = {t.lower(): t for t in tbls}',
			'            exists_already = (table_name in tbls) or (table_name.lower() in lower_map)',
			'            if not exists_already:',
			'                create_sql = build_create_table_sql(table_name, effective_cols, False)',
			'                cur.execute(create_sql)',
			'                conn.commit()',
			'                updated_cols = inspect_table_columns(table_name)',
			'                res["success"] = True',
			'                res["tableExists"] = False',
			'                res["addedColumns"] = [c["name"] for c in updated_cols]',
			'                res["removedColumns"] = []',
			'                res["columns"] = updated_cols',
			'                res["rows"] = []',
			'                res["rowCount"] = 0',
			'                res["tables"] = list_user_tables()',
			'                res["message"] = f"Created table \'{table_name}\' in {os.path.basename(db_path)} with {len(updated_cols)} column(s): {\', \'.join(c[\'name\'] for c in updated_cols)}."',
			'            else:',
			'                actual_tbl = table_name if table_name in tbls else lower_map[table_name.lower()]',
			'                table_name = actual_tbl',
			'                res["tableName"] = actual_tbl',
			'                old_cols = inspect_table_columns(actual_tbl)',
			'                old_map = {c["name"].lower(): c for c in old_cols}',
			'                new_map = {c["name"].lower(): c for c in effective_cols}',
			'                added_cols = [c["name"] for c in effective_cols if c["name"].lower() not in old_map]',
			'                removed_cols = [c["name"] for c in old_cols if c["name"].lower() not in new_map]',
			'                cur.execute(f"SELECT * FROM {quote_ident(actual_tbl)}")',
			'                existing_db_rows = [dict(r) for r in cur.fetchall()]',
			'                cur.execute(f"DROP TABLE {quote_ident(actual_tbl)}")',
			'                create_sql = build_create_table_sql(actual_tbl, effective_cols, False)',
			'                cur.execute(create_sql)',
			'                if existing_db_rows:',
			'                    col_names_mig = [c["name"] for c in effective_cols]',
			'                    col_types_mig = {c["name"]: c["dataType"] for c in effective_cols}',
			'                    pk_cols_mig = [c["name"] for c in effective_cols if c.get("primaryKey")]',
			'                    q_cols_mig = ", ".join(quote_ident(cn) for cn in col_names_mig)',
			'                    ph_mig = ", ".join("?" for _ in col_names_mig)',
			'                    verb_mig = "INSERT OR REPLACE" if pk_cols_mig else "INSERT"',
			'                    ins_mig = f"{verb_mig} INTO {quote_ident(actual_tbl)} ({q_cols_mig}) VALUES ({ph_mig})"',
			'                    mig_vals = []',
			'                    for orow in existing_db_rows:',
			'                        orow_lower = {str(k).lower(): v for k, v in orow.items()}',
			'                        mig_vals.append(tuple(coerce_cell_value(orow_lower.get(cn.lower()), col_types_mig.get(cn, "TEXT")) for cn in col_names_mig))',
			'                    cur.executemany(ins_mig, mig_vals)',
			'                conn.commit()',
			'                updated_cols = inspect_table_columns(actual_tbl)',
			'                cur.execute(f"SELECT COUNT(*) FROM {quote_ident(actual_tbl)}")',
			'                total_cnt = cur.fetchone()[0]',
			'                cur.execute(f"SELECT * FROM {quote_ident(actual_tbl)} LIMIT {max(1, limit_val)} OFFSET {max(0, offset_val)}")',
			'                fetched_rows = [dict(r) for r in cur.fetchall()]',
			'                res["success"] = True',
			'                res["tableExists"] = True',
			'                res["addedColumns"] = added_cols',
			'                res["removedColumns"] = removed_cols',
			'                res["columns"] = updated_cols',
			'                res["rows"] = fetched_rows',
			'                res["rowCount"] = total_cnt',
			'                res["tables"] = list_user_tables()',
			'                diff_parts = []',
			'                if added_cols:',
			'                    diff_parts.append(f"added: {\', \'.join(added_cols)}")',
			'                if removed_cols:',
			'                    diff_parts.append(f"removed: {\', \'.join(removed_cols)}")',
			'                diff_suffix = f" ({(\'; \').join(diff_parts)})" if diff_parts else " (columns updated)"',
			'                res["message"] = f"Updated header for table \'{actual_tbl}\' in {os.path.basename(db_path)}{diff_suffix}."',
			'        elif action in ("load", "load_schema"):',
			'            tbls = list_user_tables()',
			'            res["tables"] = tbls',
			'            if table_name not in tbls:',
			'                lower_map = {t.lower(): t for t in tbls}',
			'                if table_name.lower() in lower_map:',
			'                    table_name = lower_map[table_name.lower()]',
			'                    res["tableName"] = table_name',
			'                elif tbls:',
			'                    res["tableExists"] = False',
			'                    res["columns"] = []',
			'                    res["error"] = f"Table \'{table_name}\' not found in database. Available tables: {\', \'.join(tbls)}"',
			'                    conn.close()',
			'                    with open(OUT_PATH, "w", encoding="utf-8") as out_f:',
			'                        json.dump(res, out_f, ensure_ascii=False)',
			'                    return',
			'                else:',
			'                    res["tableExists"] = False',
			'                    res["columns"] = []',
			'                    res["error"] = f"No tables found in database {os.path.basename(db_path)}."',
			'                    conn.close()',
			'                    with open(OUT_PATH, "w", encoding="utf-8") as out_f:',
			'                        json.dump(res, out_f, ensure_ascii=False)',
			'                    return',
			'            loaded_cols = inspect_table_columns(table_name)',
			'            cur.execute(f"SELECT COUNT(*) FROM {quote_ident(table_name)}")',
			'            total_cnt = cur.fetchone()[0]',
			'            res["success"] = True',
			'            res["tableExists"] = True',
			'            res["columns"] = loaded_cols',
			'            res["rowCount"] = total_cnt',
			'            if action == "load_schema":',
			'                res["message"] = f"Queried {len(loaded_cols)} column header(s) from table \'{table_name}\' ({total_cnt} total row(s) in DB)."',
			'            else:',
			'                cur.execute(f"SELECT * FROM {quote_ident(table_name)} LIMIT {max(1, limit_val)} OFFSET {max(0, offset_val)}")',
			'                fetched = [dict(r) for r in cur.fetchall()]',
			'                res["rows"] = fetched',
			'                res["message"] = f"Loaded {len(fetched)} row(s) (offset {offset_val}, total {total_cnt}) and {len(loaded_cols)} column(s) from table \'{table_name}\'."',
			'        elif action in ("save", "update", "insert"):',
			'            effective_cols = ensure_table_and_columns(table_name, columns, rows)',
			'            col_names = [c["name"] for c in effective_cols]',
			'            col_types = {c["name"]: c["dataType"] for c in effective_cols}',
			'            db_cols_now = inspect_table_columns(table_name)',
			'            has_pk = any(c.get("primaryKey") for c in effective_cols) or any(ec.get("primaryKey") for ec in db_cols_now)',
			'            if action == "update" and not has_pk:',
			'                res["success"] = False',
			'                res["tableExists"] = True',
			'                res["columns"] = db_cols_now or effective_cols',
			'                res["error"] = f"Cannot perform \'update\' on table \'{table_name}\' because no primary key column is defined to identify target rows. Please define a primary key column or execute an explicit INSERT / UPDATE ... WHERE SQL statement."',
			'                conn.close()',
			'                with open(OUT_PATH, "w", encoding="utf-8") as out_f:',
			'                    json.dump(res, out_f, ensure_ascii=False)',
			'                return',
			'            replace_all = bool(req.get("replaceAll", False))',
			'            if action == "save" and replace_all:',
			'                cur.execute(f"DELETE FROM {quote_ident(table_name)}")',
			'            affected = 0',
			'            if rows and col_names:',
			'                quoted_cols = ", ".join(quote_ident(cn) for cn in col_names)',
			'                placeholders = ", ".join("?" for _ in col_names)',
			'                verb = "INSERT OR REPLACE" if (action in ("save", "update") and has_pk) else "INSERT"',
			'                insert_sql = f"{verb} INTO {quote_ident(table_name)} ({quoted_cols}) VALUES ({placeholders})"',
			'                existing_row_tuples = set()',
			'                if action == "save" and not has_pk and not replace_all:',
			'                    cur.execute(f"SELECT {quoted_cols} FROM {quote_ident(table_name)}")',
			'                    for erow in cur.fetchall():',
			'                        existing_row_tuples.add(tuple(erow[cn] for cn in col_names))',
			'                batch_vals = []',
			'                for r in rows:',
			'                    if not isinstance(r, dict):',
			'                        continue',
			'                    row_tuple = tuple(coerce_cell_value(r.get(cn), col_types.get(cn, "TEXT")) for cn in col_names)',
			'                    if existing_row_tuples and row_tuple in existing_row_tuples:',
			'                        continue',
			'                    batch_vals.append(row_tuple)',
			'                if batch_vals:',
			'                    cur.executemany(insert_sql, batch_vals)',
			'                    affected = len(batch_vals)',
			'            conn.commit()',
			'            cur.execute(f"SELECT * FROM {quote_ident(table_name)} LIMIT 1000")',
			'            stored_rows = [dict(r) for r in cur.fetchall()]',
			'            cur.execute(f"SELECT COUNT(*) FROM {quote_ident(table_name)}")',
			'            total_cnt = cur.fetchone()[0]',
			'            res["success"] = True',
			'            res["columns"] = effective_cols',
			'            res["rows"] = stored_rows',
			'            res["rowCount"] = total_cnt',
			'            res["affectedRows"] = affected',
			'            res["tables"] = list_user_tables()',
			'            verb_label = "Saved" if action == "save" else ("Inserted into" if action == "insert" else "Updated")',
			'            res["message"] = f"{verb_label} table \'{table_name}\' in {os.path.basename(db_path)} ({total_cnt} row(s), {len(effective_cols)} column(s))."',
			'        elif action == "delete_data":',
			'            tbls = list_user_tables()',
			'            if table_name in tbls:',
			'                if where_clause.strip():',
			'                    cur.execute(f"DELETE FROM {quote_ident(table_name)} WHERE {where_clause}")',
			'                else:',
			'                    cur.execute(f"DELETE FROM {quote_ident(table_name)}")',
			'                deleted_cnt = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0',
			'                conn.commit()',
			'                cur.execute(f"SELECT COUNT(*) FROM {quote_ident(table_name)}")',
			'                rem_cnt = cur.fetchone()[0]',
			'                cur.execute(f"SELECT * FROM {quote_ident(table_name)} LIMIT 1000")',
			'                rem_rows = [dict(r) for r in cur.fetchall()]',
			'                res["success"] = True',
			'                res["rows"] = rem_rows',
			'                res["rowCount"] = rem_cnt',
			'                res["affectedRows"] = deleted_cnt',
			'                res["tables"] = tbls',
			'                res["message"] = f"Deleted {deleted_cnt} row(s) from table \'{table_name}\' in {os.path.basename(db_path)}."',
			'            else:',
			'                res["success"] = True',
			'                res["rows"] = []',
			'                res["rowCount"] = 0',
			'                res["affectedRows"] = 0',
			'                res["tables"] = tbls',
			'                res["message"] = f"Table \'{table_name}\' did not exist in {os.path.basename(db_path)}; nothing to delete."',
			'        elif action == "drop_table":',
			'            cur.execute(f"DROP TABLE IF EXISTS {quote_ident(table_name)}")',
			'            conn.commit()',
			'            res["success"] = True',
			'            res["rows"] = []',
			'            res["rowCount"] = 0',
			'            res["tables"] = list_user_tables()',
			'            res["message"] = f"Dropped table \'{table_name}\' from {os.path.basename(db_path)}."',
			'        elif action == "query":',
			'            cleaned_sql = sql_query.strip()',
			'            fence_match = re.match(r"^```(?:sql|sqlite|sqlite3)?\\s*\\n([\\s\\S]*?)\\n```\\s*$", cleaned_sql, re.IGNORECASE)',
			'            if fence_match:',
			'                cleaned_sql = fence_match.group(1).strip()',
			'            else:',
			'                cleaned_sql = re.sub(r"^```(?:sql|sqlite|sqlite3)?\\s*", "", cleaned_sql, flags=re.IGNORECASE)',
			'                cleaned_sql = re.sub(r"\\s*```\\s*$", "", cleaned_sql).strip()',
			'            if not cleaned_sql:',
			'                res["error"] = "sqlQuery is required when action is \'query\'."',
			'            else:',
			'                # Only seed in-memory database when no external SQLite file is bound',
			'                if db_path == ":memory:":',
			'                    effective_cols = ensure_table_and_columns(table_name, columns, rows)',
			'                    if rows and effective_cols:',
			'                        cur.execute(f"DELETE FROM {quote_ident(table_name)}")',
			'                        col_names_seed = [c["name"] for c in effective_cols]',
			'                        col_types_seed = {c["name"]: c["dataType"] for c in effective_cols}',
			'                        q_cols_seed = ", ".join(quote_ident(cn) for cn in col_names_seed)',
			'                        ph_seed = ", ".join("?" for _ in col_names_seed)',
			'                        has_pk_seed = any(c.get("primaryKey") for c in effective_cols)',
			'                        verb_seed = "INSERT OR REPLACE" if has_pk_seed else "INSERT"',
			'                        seed_sql = f"{verb_seed} INTO {quote_ident(table_name)} ({q_cols_seed}) VALUES ({ph_seed})"',
			'                        seed_vals = [tuple(coerce_cell_value(r.get(cn), col_types_seed.get(cn, "TEXT")) for cn in col_names_seed) for r in rows if isinstance(r, dict)]',
			'                        if seed_vals:',
			'                            cur.executemany(seed_sql, seed_vals)',
			'                            conn.commit()',
			'',
			'                # Split into complete SQL statements so multi-statement scripts and single statements both work',
			'                stmts = []',
			'                buf = ""',
			'                for line in cleaned_sql.splitlines(True):',
			'                    buf += line',
			'                    if sqlite3.complete_statement(buf):',
			'                        if buf.strip():',
			'                            stmts.append(buf.strip())',
			'                        buf = ""',
			'                if buf.strip():',
			'                    stmts.append(buf.strip())',
			'                if not stmts:',
			'                    stmts = [cleaned_sql]',
			'',
			'                last_desc = None',
			'                last_fetched = []',
			'                last_stmt_was_pragma = False',
			'                total_affected = 0',
			'                for st in stmts:',
			'                    cur.execute(st)',
			'                    if cur.description:',
			'                        last_desc = cur.description',
			'                        last_fetched = [dict(r) for r in cur.fetchall()]',
			'                        st_clean = re.sub(r"^(?:--[^\\n]*\\n|/\\*[\\s\\S]*?\\*/|\\s)+", "", st, flags=re.MULTILINE).strip()',
			'                        last_stmt_was_pragma = bool(re.match(r"^PRAGMA\\b", st_clean, re.IGNORECASE))',
			'                    else:',
			'                        last_desc = None',
			'                        last_stmt_was_pragma = False',
			'                        if cur.rowcount is not None and cur.rowcount > 0:',
			'                            total_affected += cur.rowcount',
			'                conn.commit()',
			'',
			'                updated_tbls = list_user_tables()',
			'                res["tables"] = updated_tbls',
			'                lower_updated = {t.lower(): t for t in updated_tbls}',
			'                if table_name in updated_tbls or table_name.lower() in lower_updated:',
			'                    actual_tbl = table_name if table_name in updated_tbls else lower_updated[table_name.lower()]',
			'                    tbl_cols = inspect_table_columns(actual_tbl)',
			'                    cur.execute(f"SELECT * FROM {quote_ident(actual_tbl)} LIMIT 1000")',
			'                    tbl_rows = [dict(r) for r in cur.fetchall()]',
			'                    cur.execute(f"SELECT COUNT(*) FROM {quote_ident(actual_tbl)}")',
			'                    tbl_cnt = cur.fetchone()[0]',
			'                    res["tableExists"] = True',
			'                    res["tableName"] = actual_tbl',
			'                    res["columns"] = tbl_cols',
			'                    res["rows"] = tbl_rows',
			'                    res["rowCount"] = tbl_cnt',
			'                else:',
			'                    res["tableExists"] = False',
			'                    res["columns"] = []',
			'                    res["rows"] = []',
			'                    res["rowCount"] = 0',
			'',
			'                if last_desc is not None:',
			'                    q_cols = [{"id": f"col_{i+1}", "name": d[0], "label": d[0], "dataType": "TEXT"} for i, d in enumerate(last_desc)]',
			'                    res["isSelectQuery"] = True',
			'                    res["isPragmaQuery"] = last_stmt_was_pragma',
			'                    res["queryColumns"] = q_cols',
			'                    res["queryRows"] = last_fetched',
			'                    res["affectedRows"] = total_affected',
			'                    res["message"] = f"Query returned {len(last_fetched)} row(s)."',
			'                else:',
			'                    res["isSelectQuery"] = False',
			'                    res["isPragmaQuery"] = False',
			'                    res["affectedRows"] = total_affected',
			'                    if res.get("tableExists"):',
			'                        res["message"] = f"SQL statement executed ({total_affected} row(s) affected, table \'{res.get(\'tableName\', table_name)}\' now has {res.get(\'rowCount\', len(res.get(\'rows\', [])))} row(s))."',
			'                    else:',
			'                        res["message"] = f"SQL statement executed ({total_affected} row(s) affected; table \'{table_name}\' does not exist in DB)."',
			'                res["success"] = True',
			'        else:',
			'            res["error"] = f"Unsupported SQLite table action: {action}"',
			'',
			'        conn.close()',
			'    except Exception as e:',
			'        res["success"] = False',
			'        res["error"] = str(e)',
			'',
			'    with open(OUT_PATH, "w", encoding="utf-8") as out_f:',
			'        json.dump(res, out_f, ensure_ascii=False)',
			'',
			'if __name__ == "__main__":',
			'    main()',
			''
		].join('\n');

		try {
			await this.fileService.writeFile(inJsonUri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
			await this.fileService.writeFile(runnerPyUri, VSBuffer.fromString(pythonRunner));

			const envDetection = await this.detectPythonEnvironment(workDirUri);
			const pythonCmd = envDetection.interpreterPath || 'python3';
			const escapedPython = pythonCmd.includes(' ') ? `"${pythonCmd}"` : pythonCmd;

			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent SQLite Engine',
					cwd: workDirUri,
					hideFromUser: true
				}
			});

			const sentinel = `___SQLITE_OP_${timestamp}___`;
			const cmd = `${escapedPython} "${runnerPyUri.fsPath}" > "${logUri.fsPath}" 2>&1; echo "${sentinel}:$?"`;

			let finished = false;
			let activeEntry: { terminal: any; abort: () => void; label: string } | undefined;
			const waitPromise = new Promise<void>((resolve) => {
				let dataListener: { dispose(): void } | undefined;
				let exitListener: { dispose(): void } | undefined;
				const finishOnce = () => {
					if (!finished) {
						finished = true;
						dataListener?.dispose();
						exitListener?.dispose();
						resolve();
					}
				};
				activeEntry = {
					terminal,
					abort: finishOnce,
					label: 'AnyAgent SQLite Engine'
				};
				this._activeTerminals.add(activeEntry);
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				dataListener = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce();
					}
				});
				exitListener = terminal.onExit(() => {
					finishOnce();
				});
				setTimeout(() => {
					finishOnce();
				}, 25000);
			});

			try {
				await terminal.sendText(cmd, true);
				await waitPromise;
			} finally {
				if (activeEntry) {
					this._activeTerminals.delete(activeEntry);
				}
			}

			let resultObj: ISqliteTableOperationResult | undefined;
			if (await this.fileService.exists(outJsonUri)) {
				try {
					const rawOut = (await this.fileService.readFile(outJsonUri)).value.toString();
					resultObj = JSON.parse(rawOut);
				} catch { }
			}

			let logText = '';
			if (await this.fileService.exists(logUri)) {
				try {
					logText = (await this.fileService.readFile(logUri)).value.toString().trim();
				} catch { }
			}

			// Cleanup temp files
			for (const tmpUri of [inJsonUri, outJsonUri, runnerPyUri, logUri]) {
				try {
					if (await this.fileService.exists(tmpUri)) {
						await this.fileService.del(tmpUri);
					}
				} catch { }
			}
			terminal.dispose();

			if (resultObj) {
				return resultObj;
			}
			return {
				success: false,
				dbPath: resolvedDbPath,
				tableName: rawTableName,
				action,
				error: logText || 'SQLite operation failed to produce an output payload.'
			};
		} catch (err: any) {
			for (const tmpUri of [inJsonUri, outJsonUri, runnerPyUri, logUri]) {
				try {
					if (await this.fileService.exists(tmpUri)) {
						await this.fileService.del(tmpUri);
					}
				} catch { }
			}
			return {
				success: false,
				dbPath: resolvedDbPath,
				tableName: rawTableName,
				action,
				error: err.message || String(err)
			};
		}
	}
}
