/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEntityPersistenceService, IBaseEntitySnapshot, CustomFieldType, ICustomField, ICustomModule, IOutputSpec, ITableColumnDefinition, ISshRawCommandEntry, generateSmartPythonVarName, detectMediaFileInfo, normalizeSshQuickCommands, normalizeSshCommandsList, cleanInterpolatedSshCommand, buildSshCommandsJsonObject, formatSshCommandsJsonOutput, normalizeNumberFieldValue, normalizeHttpTicketValue, normalizeSshTicketValue, HTTP_REQUEST_CONFIG_KEYS, isHttpTicketValue, isSshTicketValue, httpTicketValueOutputText, sshTicketValueOutputText } from '../../entityPersistence/common/entityPersistence.js';
import { ICustomModulesService } from '../../customModules/common/customModules.js';
import { IAgentCredentialService, getGlobalDefaultModel, resolveDefaultModelId } from '../../agentsManager/common/agentsManager.js';
import { IWorkspacesExplorerService } from '../../workspacesExplorer/common/workspacesExplorer.js';
import { TicketWorklogStorage } from '../../workspacesExplorer/browser/ticketWorklogStorage.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { hasWorkflowProperty, isWorkflowRecord } from '../common/workflowExecutionModel.js';
import { mainWindow } from '../../../../base/browser/window.js';

export const ITicketWorkflowRuntimeService = createDecorator<ITicketWorkflowRuntimeService>('ticketWorkflowRuntimeService');

/**
 * Returns the variable placeholders (`{name}`, `{{name}}`, `@{name}`, optionally with `.field` / `["key"]` access) of
 * `template` that interpolation left unresolved in `rendered`.
 *
 * The template is aligned against the rendered text (literal text must match; each placeholder is either kept
 * verbatim or replaced by some value), so a placeholder that only appears in `rendered` because an inserted
 * VALUE contains it (e.g. a table output that logs "resolved from {Table_Name}") is not reported as missing.
 * JSON-like text such as `{"en": "..."}` is never reported because a placeholder must start with an identifier.
 */
export function findUnresolvedTemplateVariables(template: string, rendered: string): string[] {
	if (!template) {
		return [];
	}
	// Same brace syntax as the interpolators; only identifier-like names are reportable
	const tokenRe = /@?\{\{?([^{}]+)\}?\}/g;
	const reportableRe = /^\s*[A-Za-z_]\w*(?:\s*(?:\[[^\]\n{}]*\]|\.[A-Za-z_]\w*))*\s*$/;
	type LiteralToken = { lit: string };
	type PlaceholderToken = { ph: string; name: string };
	type Token = LiteralToken | PlaceholderToken;
	const isPlaceholder = (t: Token): t is PlaceholderToken => 'ph' in t;
	const isLiteral = (t: Token): t is LiteralToken => 'lit' in t;
	const tokens: Token[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(template)) !== null) {
		tokens.push({ lit: template.slice(last, m.index) });
		tokens.push({ ph: m[0], name: m[1].trim() });
		last = tokenRe.lastIndex;
	}
	tokens.push({ lit: template.slice(last) });
	const reportable = (t: { name: string }) => reportableRe.test(t.name);
	if (!tokens.some(t => isPlaceholder(t) && reportable(t) && rendered.includes(t.ph))) {
		return [];
	}

	// Backtracking alignment: tokens alternate lit, ph, lit, ph, ..., lit
	let budget = 20000;
	const align = (ti: number, pos: number): Set<string> | null => {
		if (--budget < 0) {
			return null;
		}
		const tok = tokens[ti];
		if (isLiteral(tok)) {
			if (!rendered.startsWith(tok.lit, pos)) {
				return null;
			}
			const next = pos + tok.lit.length;
			if (ti === tokens.length - 1) {
				return next === rendered.length ? new Set<string>() : null;
			}
			return align(ti + 1, next);
		}
		const following = tokens[ti + 1] as { lit: string };
		const isLastPh = ti + 1 === tokens.length - 1;
		// Option 1: the placeholder was left verbatim
		if (rendered.startsWith(tok.ph, pos)) {
			const res = align(ti + 1, pos + tok.ph.length);
			if (res) {
				if (reportable(tok)) {
					res.add(tok.name);
				}
				return res;
			}
		}
		// Option 2: the placeholder was replaced by some value ending where the following literal starts
		if (isLastPh) {
			const end = rendered.length - following.lit.length;
			return end >= pos ? align(ti + 1, end) : null;
		}
		if (!following.lit) {
			return null; // adjacent placeholders: ambiguous
		}
		let idx = rendered.indexOf(following.lit, pos);
		while (idx !== -1) {
			const res = align(ti + 1, idx);
			if (res) {
				return res;
			}
			if (budget < 0) {
				return null;
			}
			idx = rendered.indexOf(following.lit, idx + 1);
		}
		return null;
	};
	const aligned = align(0, 0);
	if (aligned) {
		return Array.from(aligned);
	}

	// Could not align (e.g. other rewriting such as @Field substitution): a placeholder is missing only if it
	// still appears at least as often as in the template (a resolved one can only reappear inside values)
	const count = (text: string, needle: string) => text.split(needle).length - 1;
	const missing = new Set<string>();
	for (const t of tokens) {
		if (isPlaceholder(t) && reportable(t) && count(rendered, t.ph) >= count(template, t.ph)) {
			missing.add(t.name);
		}
	}
	return Array.from(missing);
}

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
	parameters?: Record<string, unknown>;
	fieldValues?: Record<string, unknown>;
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
	parameters?: Record<string, unknown>;
	fields: Record<string, unknown>;
	outputs?: Record<string, unknown>;
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
	output?: unknown;
	outputs?: Record<string, unknown>;
	schema?: ICustomModule;
	error?: string;
}

export interface ITicketRunOptions {
	workspaceUri: string | URI;
	ticketIdOrPath: string;
	inputParams?: Record<string, unknown>;
	isCancelled?: () => boolean;
	onStepStart?: (info: { fieldId: string; fieldLabel: string; fieldType: string; stepIndex: number; totalSteps: number }) => void;
	onStepProgress?: (stepResult: IPrimitiveExecutionStepResult, index: number, total: number) => void;
}

export interface IPrimitiveExecutionStepResult {
	fieldId: string;
	fieldLabel: string;
	fieldType: string;
	output?: unknown;
	status: 'success' | 'skipped' | 'failed';
	durationMs: number;
	error?: string;
	details?: IPrimitiveExecutionStepDetails;
}

/** Free-form execution details of a primitive step; `commandLogs` / `logs` hold captured textual logs. */
export interface IPrimitiveExecutionStepDetails {
	commandLogs?: string;
	logs?: string;
	[key: string]: unknown;
}

/**
 * A component (`ICustomField`) together with the runtime-only execution state that the runtime records on the
 * component object while running it (shown by the editors, never part of the saved template schema).
 */
export interface IRuntimeCustomField extends ICustomField {
	previousLabels?: string[];
	lastExecutionStatus?: string;
	lastExecutionLog?: string;
	lastExecutionOutput?: unknown;
	lastExecutionDurationMs?: number;
	lastExecutionExitCode?: number;
	lastExecutedUrl?: string;
	lastExecutedAt?: string;
	lastQueryRows?: unknown;
	lastSentPrompt?: unknown;
	ttsLastAudioPath?: string;
	ttsLastCacheKey?: string;
}

/** The labels a component was previously known by (`previousLabels`), or `[]`. */
function getPreviousLabels(field: IRuntimeCustomField): string[] {
	return Array.isArray(field.previousLabels) ? field.previousLabels : [];
}

export interface IHttpRequestExecutionResult {
	status: number;
	statusText: string;
	ok: boolean;
	headers: Record<string, string>;
	body: unknown;
	data: unknown;
	rawText: string;
	url: string;
	method: string;
	durationMs: number;
	error?: string;
}

export interface ITicketRunResult {
	success: boolean;
	ticketId: string;
	ticketName: string;
	title?: string;
	ticketType: string;
	entityUri: string;
	status: 'success' | 'failed';
	output: unknown;
	stepResults: IPrimitiveExecutionStepResult[];
	contextVariables: Record<string, unknown>;
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
	/** Where the component can be placed. Omitted = both ticket templates and workflow nodes. */
	usableIn?: ('ticket' | 'node')[];
}

export interface IPythonExecutionResult {
	success: boolean;
	output: string;
	result?: unknown;
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
	rows?: Array<Record<string, unknown>>;
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
	rows?: Array<Record<string, unknown>>;
	isSelectQuery?: boolean;
	isPragmaQuery?: boolean;
	queryColumns?: ITableColumnDefinition[];
	queryRows?: Array<Record<string, unknown>>;
	tables?: string[];
	rowCount?: number;
	affectedRows?: number;
	message?: string;
	error?: string;
}

export interface ISshCommandOptions {
	workspaceUri?: string | URI;
	host: string;
	port?: number | string;
	user?: string;
	password?: string;
	command?: string;
	cwd?: string;
	action?: 'connect' | 'exec';
	timeoutSec?: number;
}

export interface ISshCommandResult {
	success: boolean;
	connectionFailed?: boolean;
	host: string;
	port: number;
	user: string;
	cwd: string;
	command: string;
	output: string;
	exitCode: number;
	durationMs: number;
	systemInfo?: string;
	error?: string;
}

export interface ISshBatchCommandProgress {
	index: number;
	total: number;
	command: string;
	phase: 'start' | 'done';
	cwd: string;
	rawOutput?: string;
	jsonOutput?: string;
	result?: ISshCommandResult;
}

export interface ISshBatchExecutionOptions {
	workspaceUri?: string | URI;
	host: string;
	port?: number | string;
	user?: string;
	password?: string;
	cwd?: string;
	commands: ReadonlyArray<string>;
	outputLines?: number;
	existingTerminalLog?: string;
	contextVariables?: Record<string, unknown>;
	isCancelled?: () => boolean;
	onCommandProgress?: (progress: ISshBatchCommandProgress) => void;
}

export interface ISshBatchExecutionResult {
	success: boolean;
	connectionFailed?: boolean;
	host: string;
	port: number;
	user: string;
	cwd: string;
	resolvedCommands: string[];
	rawEntries: ISshRawCommandEntry[];
	jsonOutput: string;
	terminalTranscript: string;
	exitCode: number;
	durationMs: number;
	error?: string;
	failedCommandIndex?: number;
	failedCommand?: string;
}

export interface ITicketWorkflowRuntimeService {
	readonly _serviceBrand: undefined;

	createTickets(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	createTicket(options: ITicketCreateOptions): Promise<ITicketCreateResult>;
	CREATE_TICKETS(options: ITicketCreateOptions): Promise<ITicketCreateResult>;

	/**
	 * Without `field`: a single ticket (`ITicketGetResult`), or an array of matching ticket summaries for a query object.
	 * With `field`: the value (or array of values) of that field.
	 */
	getTickets(workspaceUri: string | URI, querySpecOrTarget: unknown, field?: string): Promise<unknown>;
	/** Returns the ticket (`ticketIdOrPath` is an id / name / path string or a ticket handle object). */
	getTicket(workspaceUri: string | URI, ticketIdOrPath: unknown): Promise<ITicketGetResult>;
	/** Returns the value of `field` of the ticket, or the ticket itself when `field` is empty. */
	getTicket(workspaceUri: string | URI, ticketIdOrPath: unknown, field: string | undefined): Promise<unknown>;
	GET_TICKETS(workspaceUri: string | URI, querySpecOrTarget: unknown, field?: string): Promise<unknown>;
	GET_TICKET(workspaceUri: string | URI, ticketIdOrPath: unknown): Promise<ITicketGetResult>;
	GET_TICKET(workspaceUri: string | URI, ticketIdOrPath: unknown, field: string | undefined): Promise<unknown>;

	/** Returns the ticket's OUTPUT component values, or `null` when the ticket has none. */
	getOutputs(workspaceUri: string | URI, ticketOrId: unknown): Promise<Record<string, unknown> | null>;
	/** Returns the value of one output field (or all outputs when `field` is empty), or `null`. */
	getOutputs(workspaceUri: string | URI, ticketOrId: unknown, field: string | undefined): Promise<unknown>;
	GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: unknown): Promise<Record<string, unknown> | null>;
	GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: unknown, field: string | undefined): Promise<unknown>;

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
		contextVariables?: Record<string, unknown>,
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

	executeSshCommand(
		options: ISshCommandOptions
	): Promise<ISshCommandResult>;

	executeSshBatchCommands(
		options: ISshBatchExecutionOptions
	): Promise<ISshBatchExecutionResult>;

	openInteractiveSshTerminal(
		options: ISshCommandOptions
	): Promise<void>;

	executeHttpRequest(
		field: IRuntimeCustomField,
		contextVariables: Record<string, unknown>
	): Promise<IHttpRequestExecutionResult>;

	executeNodeComponent(
		workspaceUri: string | URI,
		workingDirUri: string | URI,
		field: IRuntimeCustomField,
		contextVariables: Record<string, unknown>
	): Promise<IPrimitiveExecutionStepResult>;

	validateAndSanitizeComponentOutput(
		fieldType: CustomFieldType | string,
		field: ICustomField | undefined,
		rawVal: unknown
	): unknown;

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
	private readonly _activeTerminals = new Set<{ terminal: ITerminalInstance; abort: () => void; label: string }>();
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

			// 1. Locate schema definition (normalize spaces, hyphens, and underscores so "Job_Filter", "Job Filter", and "job-filter" all match)
			const allModules = await this.customModulesService.getCustomModules(wsUri);
			const matchedModule = this._findMatchingCustomModule(allModules, ticketType);
			const canonicalTicketType = matchedModule ? matchedModule.id : ticketType;

			// 2. Prepare target parent folder path & find root workspace URI
			const targetSubPath = (options.targetPath || '').trim().replace(/^\/+|\/+$/g, '');
			const parentFolderUri = targetSubPath ? URI.joinPath(wsUri, targetSubPath) : wsUri;
			const rootWsUri = await this.workspacesExplorerService.findWorkspaceRootUri(parentFolderUri);

			// 3. Generate sequential ticket ID and code matching workspace convention (e.g. NEOWO-0011)
			const { name: seqCode, code: activeCode } = await this.workspacesExplorerService.generateNextSequentialName(parentFolderUri, ticketType);
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
			const normalizeKeyForLookup = (s: string) => s.trim().toLowerCase().replace(/[-_\s]+/g, '_');
			const lookupInitialField = (key?: string): unknown => {
				if (!key) { return undefined; }
				if (initialFields[key] !== undefined) { return initialFields[key]; }
				const norm = normalizeKeyForLookup(key);
				for (const [ik, iv] of Object.entries(initialFields)) {
					if (normalizeKeyForLookup(ik) === norm) {
						return iv;
					}
				}
				return undefined;
			};

			if (matchedModule?.fields && Array.isArray(matchedModule.fields)) {
				for (const f of matchedModule.fields) {
					const fKey = f.label || f.id;
					if (f.type === 'parameters' && f.parameters) {
						const paramObj: Record<string, unknown> = {};
						for (const p of f.parameters) {
							const pKey = p.name || p.id;
							const matchedVal = lookupInitialField(pKey) ?? lookupInitialField(p.label);
							const hasMatched = matchedVal !== undefined && matchedVal !== null && (typeof matchedVal !== 'string' || matchedVal.trim() !== '');
							const hasDefault = p.defaultValue !== undefined && p.defaultValue !== null && (typeof p.defaultValue !== 'string' || String(p.defaultValue).trim() !== '');
							const pVal = hasMatched ? matchedVal : (hasDefault ? p.defaultValue : (matchedVal ?? ''));
							paramObj[pKey] = pVal;
						}
						customMetadata[fKey] = JSON.stringify(paramObj);
					} else if (f.type === 'browser') {
						const urlVal = initialFields[fKey] || f.defaultUrl || '';
						const contentVal = (isWorkflowRecord(initialFields[fKey]) && initialFields[fKey].content)
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
						} else if (isWorkflowRecord(passedVal)) {
							if (Array.isArray(passedVal.userPrompts)) {
								userPrompts = passedVal.userPrompts.map((item: unknown) => String(item ?? ''));
							} else if (passedVal.userPrompt !== undefined) {
								userPrompts = [String(passedVal.userPrompt)];
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
							targetProvider: f.targetProvider || (f.targetModel ? '' : (getGlobalDefaultModel()?.providerId || '')),
							targetModel: f.targetModel || resolveDefaultModelId(f.targetProvider, 'gpt-4o'),
							targetAgentId: f.targetAgentId || '',
							targetAgentName: f.targetAgentName || '',
							output: ''
						});
					} else if (f.type === 'tts') {
						let ttsVal = f.defaultContent || '';
						let ttsDisplayVal = f.ttsDisplayText || '';
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (typeof passedVal === 'string' && passedVal.trim()) {
							ttsVal = passedVal;
						} else if (isWorkflowRecord(passedVal)) {
							if (passedVal.text !== undefined) { ttsVal = String(passedVal.text); }
							if (passedVal.displayText !== undefined) { ttsDisplayVal = String(passedVal.displayText); }
							else if (passedVal.ttsDisplayText !== undefined) { ttsDisplayVal = String(passedVal.ttsDisplayText); }
						}
						customMetadata[fKey] = JSON.stringify({
							text: String(ttsVal),
							displayText: String(ttsDisplayVal),
							ttsShowSpeechTextInTicket: Boolean(f.ttsShowSpeechTextInTicket),
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
						} else if (isWorkflowRecord(passedVal)) {
							if (passedVal.mediaFilePath !== undefined) { mediaPath = String(passedVal.mediaFilePath); }
							else if (passedVal.filePath !== undefined) { mediaPath = String(passedVal.filePath); }
							if (passedVal.mediaFileName !== undefined) { mediaName = String(passedVal.mediaFileName); }
							else if (passedVal.fileName !== undefined) { mediaName = String(passedVal.fileName); }
							if (typeof passedVal.mediaPlaybackRate === 'number') { mediaRate = passedVal.mediaPlaybackRate; }
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
					} else if (f.type === 'voice_note') {
						const clips = Array.isArray(f.voiceClips) ? f.voiceClips : [];
						const combinedTranscript = f.voiceTranscript || clips.map(c => (c.transcript || '').trim()).filter(Boolean).join('\n\n');
						customMetadata[fKey] = JSON.stringify({
							voiceClips: clips,
							voiceTranscript: combinedTranscript,
							voiceAutoTranscribe: f.voiceAutoTranscribe !== false,
							voicePlaybackRate: typeof f.voicePlaybackRate === 'number' ? f.voicePlaybackRate : 1.0
						});
					} else if (f.type === 'ssh') {
						let sshHost = f.sshHost || '';
						let sshPort: number | string = f.sshPort || 22;
						let sshUser = f.sshUser || 'root';
						let sshPassword = f.sshPassword || '';
						let sshCwd = f.sshCwd || '';
						let sshCommands = normalizeSshCommandsList(f.sshCommands, f.sshCommand || f.defaultContent || '');
						let sshOutputLines = typeof f.sshOutputLines === 'number' && f.sshOutputLines > 0 ? f.sshOutputLines : 50;
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (typeof passedVal === 'string' && passedVal.trim()) {
							sshCommands = [passedVal.trim()];
						} else if (Array.isArray(passedVal)) {
							sshCommands = normalizeSshCommandsList(passedVal);
						} else if (isWorkflowRecord(passedVal)) {
							const pv = normalizeSshTicketValue(passedVal) ?? {};
							if (pv.sshHost !== undefined) { sshHost = String(pv.sshHost ?? ''); }
							if (pv.sshPort !== undefined) { sshPort = pv.sshPort ?? 22; }
							if (pv.sshUser !== undefined) { sshUser = String(pv.sshUser ?? 'root'); }
							if (pv.sshPassword !== undefined) { sshPassword = String(pv.sshPassword ?? ''); }
							if (pv.sshCwd !== undefined) { sshCwd = String(pv.sshCwd ?? ''); }
							if (Array.isArray(pv.sshCommands)) {
								sshCommands = normalizeSshCommandsList(pv.sshCommands);
							} else if (pv.sshCommand !== undefined) {
								sshCommands = normalizeSshCommandsList(undefined, String(pv.sshCommand ?? ''));
							}
							if (pv.sshOutputLines !== undefined) {
								const parsedN = Number(pv.sshOutputLines);
								if (!isNaN(parsedN) && parsedN > 0) { sshOutputLines = Math.floor(parsedN); }
							}
						}
						customMetadata[fKey] = JSON.stringify({
							sshHost,
							sshPort: Number(sshPort) || 22,
							sshUser,
							sshPassword,
							sshCwd,
							sshCommand: sshCommands[0] || '',
							sshCommands,
							sshOutputLines,
							sshQuickCommands: normalizeSshQuickCommands(f.sshQuickCommands),
							sshOutput: '',
							sshLastRawOutput: '',
							sshLastRawEntries: [],
							sshLastOutput: '',
							history: []
						});
					} else if (f.type === 'http_request') {
						// Same property names as the template config; start from the template, then apply the passed value.
						const httpValue: Record<string, unknown> = {};
						for (const key of HTTP_REQUEST_CONFIG_KEYS) {
							const templateVal: unknown = Reflect.get(f, key);
							if (templateVal !== undefined) {
								httpValue[key] = templateVal;
							}
						}
						if (!httpValue.httpUrl && f.defaultUrl) {
							httpValue.httpUrl = f.defaultUrl;
						}
						const passedVal = initialFields[fKey] ?? initialFields[f.id];
						if (typeof passedVal === 'string' && /^https?:\/\//i.test(passedVal.trim())) {
							httpValue.httpUrl = passedVal.trim();
						} else if (isWorkflowRecord(passedVal)) {
							const pv = normalizeHttpTicketValue(passedVal) ?? {};
							for (const key of HTTP_REQUEST_CONFIG_KEYS) {
								if (pv[key] !== undefined) {
									httpValue[key] = key === 'httpBodyContent' && typeof pv[key] !== 'string' ? JSON.stringify(pv[key]) : pv[key];
								}
							}
							if (passedVal.body !== undefined && typeof passedVal.body !== 'string' && httpValue.httpBodyContent === undefined) {
								httpValue.httpBodyContent = JSON.stringify(passedVal.body);
							}
						}
						httpValue.httpMethod = String(httpValue.httpMethod || 'GET').toUpperCase();
						httpValue.httpUrl = httpValue.httpUrl || '';
						customMetadata[fKey] = JSON.stringify(httpValue);
					} else if (f.type === 'table') {
						const passedVal = lookupInitialField(fKey) ?? lookupInitialField(f.id) ?? lookupInitialField(f.outputVariableName);
						const isBoundSqlite = (f.tableDbEngine || 'sqlite') === 'sqlite' && Boolean(f.tableDbPath && f.tableDbPath.trim());
						let rowsVal: unknown[] = !isBoundSqlite && Array.isArray(f.tableRows) ? f.tableRows : [];
						if (Array.isArray(passedVal)) {
							rowsVal = passedVal;
						} else if (isWorkflowRecord(passedVal) && Array.isArray(passedVal.rows)) {
							rowsVal = passedVal.rows;
						}
						customMetadata[fKey] = JSON.stringify({
							columns: Array.isArray(f.tableColumns) ? f.tableColumns : [],
							rows: rowsVal,
							dbEngine: f.tableDbEngine || 'sqlite',
							dbPath: f.tableDbPath || '',
							tableName: f.tableDbTableName || this._cleanKey(fKey) || 'ticket_table',
							autoSyncDb: Boolean(f.tableAutoSyncDb),
							sqlQuery: f.tableSqlQuery || '',
							sqlOutput: ''
						});
					} else if (f.type === 'output') {
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
			const knownParamNorms = new Set<string>();
			if (matchedModule?.fields) {
				for (const f of matchedModule.fields) {
					if (f.type === 'parameters' && Array.isArray(f.parameters)) {
						for (const p of f.parameters) {
							if (p.name) { knownParamNames.add(p.name); knownParamNorms.add(normalizeKeyForLookup(p.name)); }
							if (p.id) { knownParamNames.add(p.id); knownParamNorms.add(normalizeKeyForLookup(p.id)); }
							if (p.label) { knownParamNames.add(p.label); knownParamNorms.add(normalizeKeyForLookup(p.label)); }
						}
					}
				}
			}

			for (const [k, v] of Object.entries(initialFields)) {
				if (customMetadata[k] === undefined && !knownParamNames.has(k) && !knownParamNorms.has(normalizeKeyForLookup(k))) {
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
				entityType: canonicalTicketType,
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
						// (a `null` output is passed through unchanged, as before)
						outputs: (runRes.output !== undefined && typeof runRes.output === 'object') ? runRes.output as Record<string, unknown> : this._extractTicketOutputs(runRes.fields || customMetadata, matchedModule)
					};
				}
			}

			return ticketResult;
		} catch (err) {
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
	async getTicket(workspaceUri: string | URI, ticketIdOrPath: unknown): Promise<ITicketGetResult>;
	async getTicket(workspaceUri: string | URI, ticketIdOrPath: unknown, field: string | undefined): Promise<unknown>;
	async getTicket(workspaceUri: string | URI, ticketIdOrPath: unknown, field?: string): Promise<unknown> {
		let rawIdentifier = '';
		try {
			const wsUri = this._toUri(workspaceUri);
			let directEntityUri: URI | undefined;

			if (isWorkflowRecord(ticketIdOrPath)) {
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
				if (!u) { return; }
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
				if (nextParent.toString() === curParent.toString()) { break; }
				addRoot(nextParent);
				curParent = nextParent;
			}
			try {
				const allWs = await this.workspacesExplorerService.getWorkspaces();
				for (const w of allWs) {
					if (w.uri) { addRoot(w.uri); }
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
								if (child.type === 'file' || child.type === 'folder') { continue; }
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
				let ticketWsUri = URI.joinPath(ticketUri, '..');
				try {
					ticketWsUri = await this.workspacesExplorerService.findWorkspaceRootUri(ticketUri);
				} catch { }
				const modules = await this.customModulesService.getCustomModules(ticketWsUri);
				schema = this._findMatchingCustomModule(modules, ticketData.ticketType);
				if (!schema && ticketWsUri.toString() !== wsUri.toString()) {
					const fallbackModules = await this.customModulesService.getCustomModules(wsUri);
					schema = this._findMatchingCustomModule(fallbackModules, ticketData.ticketType);
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
						if (isWorkflowRecord(parsed) && Reflect.has(parsed, 'lastSentPayload')) {
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

			if (field && typeof field === 'string' && field.trim()) {
				const fKey = field.trim();
				if (hasWorkflowProperty(ticketResult, fKey)) {
					return ticketResult[fKey];
				}
				if (isWorkflowRecord(ticketOutputs) && Reflect.has(ticketOutputs, fKey)) {
					return ticketOutputs[fKey];
				}
				if (ticketData.customMetadata && Reflect.has(ticketData.customMetadata, fKey)) {
					return ticketData.customMetadata[fKey];
				}
				const lowerKey = fKey.toLowerCase();
				for (const [k, v] of Object.entries(ticketOutputs || {})) {
					if (k.toLowerCase() === lowerKey) { return v; }
				}
				for (const [k, v] of Object.entries(ticketData.customMetadata || {})) {
					if (k.toLowerCase() === lowerKey) { return v; }
				}
				return undefined;
			}

			return ticketResult;
		} catch (err) {
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
	async getOutputs(workspaceUri: string | URI, ticketOrId: unknown): Promise<Record<string, unknown> | null>;
	async getOutputs(workspaceUri: string | URI, ticketOrId: unknown, field: string | undefined): Promise<unknown>;
	async getOutputs(workspaceUri: string | URI, ticketOrId: unknown, field?: string): Promise<unknown> {
		try {
			if (ticketOrId === undefined || ticketOrId === null || ticketOrId === '') {
				return null;
			}
			let outDict: Record<string, unknown> | null = null;
			const ticketRes = await this.getTicket(workspaceUri, ticketOrId);
			const targetSchema: ICustomModule | undefined = ticketRes?.schema || (isWorkflowRecord(ticketOrId) ? ticketOrId.schema as ICustomModule | undefined : undefined);
			if (!ticketRes.success) {
				// Fallback if ticketOrId is an in-memory ticket handle with customMetadata/fields and schema
				if (isWorkflowRecord(ticketOrId) && (ticketOrId.customMetadata || ticketOrId.fields)) {
					const meta = (ticketOrId.customMetadata || ticketOrId.fields || {}) as Record<string, string>;
					outDict = this._extractStrictOutputsComponent(meta, ticketOrId.schema as ICustomModule | undefined);
				}
			} else {
				outDict = this._extractStrictOutputsComponent(ticketRes.customMetadata, ticketRes.schema);
			}
			if (!outDict) {
				return null;
			}
			if (field && typeof field === 'string' && field.trim()) {
				const trimmedField = field.trim();
				const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
				const normField = norm(trimmedField);

				// 1. Direct key match
				if (outDict[trimmedField] !== undefined) {
					return outDict[trimmedField];
				}
				// 2. Case-insensitive key match
				const matchedKey = Object.keys(outDict).find(k => !k.startsWith('__') && k.toLowerCase() === trimmedField.toLowerCase());
				if (matchedKey && outDict[matchedKey] !== undefined) {
					return outDict[matchedKey];
				}
				// 3. Normalized key match (stripping spaces, underscores, symbols)
				const normKey = Object.keys(outDict).find(k => !k.startsWith('__') && norm(k) === normField);
				if (normKey && outDict[normKey] !== undefined) {
					return outDict[normKey];
				}
				// 4. Aliases dictionary
				if (isWorkflowRecord(outDict['__field_aliases__'])) {
					const aliases = outDict['__field_aliases__'];
					// Alias values are output keys (property-key coercion == String() for JSON values)
					if (aliases[trimmedField] && outDict[String(aliases[trimmedField])] !== undefined) {
						return outDict[String(aliases[trimmedField])];
					}
					const aliasKey = Object.keys(aliases).find(k => k.toLowerCase() === trimmedField.toLowerCase() || norm(k) === normField);
					if (aliasKey && aliases[aliasKey] && outDict[String(aliases[aliasKey])] !== undefined) {
						return outDict[String(aliases[aliasKey])];
					}
				}
				// 5. Schema fields matching (by outputVariableName, id, label, previousLabels)
				if (targetSchema?.fields && Array.isArray(targetSchema.fields)) {
					const matchedField = targetSchema.fields.find(f => {
						if (f.type === 'output') { return false; }
						const prevs: string[] = getPreviousLabels(f);
						return (
							f.label === trimmedField ||
							f.id === trimmedField ||
							f.outputVariableName === trimmedField ||
							norm(f.label || '') === normField ||
							norm(f.id || '') === normField ||
							norm(f.outputVariableName || '') === normField ||
							prevs.some(p => norm(p) === normField)
						);
					});
					if (matchedField) {
						const candKeys = [matchedField.label, matchedField.id, matchedField.outputVariableName].filter(Boolean) as string[];
						for (const ck of candKeys) {
							if (outDict[ck] !== undefined) { return outDict[ck]; }
							const mk = Object.keys(outDict).find(k => !k.startsWith('__') && (k.toLowerCase() === ck.toLowerCase() || norm(k) === norm(ck)));
							if (mk && outDict[mk] !== undefined) { return outDict[mk]; }
						}
						const customMeta = ticketRes?.customMetadata || (isWorkflowRecord(ticketOrId) ? (ticketOrId.customMetadata || ticketOrId.fields) : undefined);
						if (customMeta) {
							for (const ck of candKeys) {
								if (customMeta[ck] !== undefined) {
									return this._extractCleanRealizedValueFromMeta(customMeta[ck]);
								}
							}
						}
					}
				}
				// 6. Substring prefix match on outDict keys
				if (normField.length >= 3) {
					const subKey = Object.keys(outDict).find(k => !k.startsWith('__') && (norm(k).includes(normField) || normField.includes(norm(k))));
					if (subKey && outDict[subKey] !== undefined) {
						return outDict[subKey];
					}
				}
				return null;
			}
			const cleanOut: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(outDict)) {
				if (!k.startsWith('__')) {
					cleanOut[k] = v;
				}
			}
			return cleanOut;
		} catch (err) {
			this.logService.warn(`[TicketWorkflowRuntime] getOutputs failed:`, err);
			return null;
		}
	}

	async GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: unknown): Promise<Record<string, unknown> | null>;
	async GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: unknown, field: string | undefined): Promise<unknown>;
	async GET_OUTPUTS(workspaceUri: string | URI, ticketOrId: unknown, field?: string): Promise<unknown> {
		return this.getOutputs(workspaceUri, ticketOrId, field);
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
		const contextVariables: Record<string, unknown> = {};

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
			const fieldsToRun: IRuntimeCustomField[] = (schema?.fields && Array.isArray(schema.fields) && schema.fields.length > 0)
				? schema.fields
				: this._synthesizeFieldsFromMetadata(customMetadata);

			// Pre-populate context with static defaults and contents from all fields
			for (const f of fieldsToRun) {
				const fKey = f.label || f.id;
				if (contextVariables[fKey] === undefined) {
					let defaultVal: unknown = f.defaultContent ?? f.defaultValue ?? '';
					if (f.type === 'parameters' && f.parameters) {
						const pMap: Record<string, unknown> = {};
						f.parameters.forEach(p => {
							if (p.name) {
								const dVal = p.defaultValue;
								const hasVal = dVal !== undefined && dVal !== '' && dVal !== null;
								pMap[p.name] = hasVal ? dVal : null;
								if (hasVal && contextVariables[p.name] === undefined) {
									contextVariables[p.name] = dVal;
								}
							}
						});
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

			let finalOutput: unknown = undefined;
			let fieldIndex = 0;
			const totalFieldsCount = fieldsToRun.length;

			// Step-by-step sequential primitive execution
			for (const field of fieldsToRun) {
				fieldIndex++;
				if (isCancelled()) {
					throw new Error('Ticket execution cancelled by Stop request');
				}
				const stepStart = Date.now();
				const fieldLabel = field.label || field.id;
				const fieldType = field.type;

				try {
					options.onStepStart?.({
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						stepIndex: fieldIndex,
						totalSteps: totalFieldsCount
					});
				} catch { }

				// Record root fields title and description as explicit step results for complete visibility
				if (field.id === 'title') {
					const titleVal = inputOverrides['title'] || customMetadata['title'] || ticketResult.ticketName || '';
					const titleStepRes: IPrimitiveExecutionStepResult = {
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
					};
					stepResults.push(titleStepRes);
					try { options.onStepProgress?.(titleStepRes, fieldIndex, totalFieldsCount); } catch { }
					contextVariables['title'] = titleVal;
					continue;
				}
				if (field.id === 'description') {
					const descVal = inputOverrides['description'] || customMetadata['description'] || field.defaultContent || '';
					const descStepRes: IPrimitiveExecutionStepResult = {
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
					};
					stepResults.push(descStepRes);
					try { options.onStepProgress?.(descStepRes, fieldIndex, totalFieldsCount); } catch { }
					contextVariables['description'] = descVal;
					continue;
				}

				if (field.disabled) {
					const skipMsg = `>>> Component [${fieldType}] "${fieldLabel}" is DISABLED (skipped execution).`;
					field.lastExecutionStatus = 'skipped';
					field.lastExecutionLog = skipMsg;
					const skipStepRes: IPrimitiveExecutionStepResult = {
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						output: undefined,
						status: 'success',
						durationMs: 0,
						details: {
							fieldLabel: fieldLabel,
							type: fieldType,
							skipped: true,
							disabled: true,
							message: skipMsg
						}
					};
					stepResults.push(skipStepRes);
					try { options.onStepProgress?.(skipStepRes, fieldIndex, totalFieldsCount); } catch { }
					this.logService.info(`[TicketWorkflowRuntime] Component '${fieldLabel}' is disabled, skipping execution.`);
					continue;
				}

				let stepOutput: unknown = undefined;
				let stepDetails: Record<string, unknown> = {};

				try {
					switch (fieldType) {
						case 'parameters': {
							// 1. Parameters Primitive: resolve runtime arguments, saved ticket parameters, and defaults
							const resolvedParams: Record<string, unknown> = {};
							let savedParamObj: Record<string, unknown> = {};
							const rawSavedParams = customMetadata[fieldLabel] ?? customMetadata[field.id];
							if (typeof rawSavedParams === 'string' && rawSavedParams.trim().startsWith('{')) {
								try {
									const parsed = JSON.parse(rawSavedParams.trim());
									if (isWorkflowRecord(parsed) && !Array.isArray(parsed)) {
										savedParamObj = parsed;
									}
								} catch { }
							} else if (isWorkflowRecord(rawSavedParams) && !Array.isArray(rawSavedParams)) {
								savedParamObj = rawSavedParams as Record<string, unknown>;
							}

							const lookupFromMap = (map: Record<string, unknown>, key?: string): unknown => {
								if (!key) { return undefined; }
								if (map[key] !== undefined) { return map[key]; }
								const norm = key.trim().toLowerCase().replace(/[-_\s]+/g, '_');
								for (const [mk, mv] of Object.entries(map)) {
									if (mk.trim().toLowerCase().replace(/[-_\s]+/g, '_') === norm) {
										return mv;
									}
								}
								return undefined;
							};

							const isNonEmptyParam = (val: unknown): boolean => {
								if (val === undefined || val === null) { return false; }
								if (typeof val === 'string' && val.trim() === '') { return false; }
								return true;
							};

							if (field.parameters && Array.isArray(field.parameters)) {
								for (const p of field.parameters) {
									const pKey = p.name || p.id;
									const overrideVal = lookupFromMap(inputOverrides, pKey) ?? lookupFromMap(inputOverrides, p.label);
									const savedVal = lookupFromMap(savedParamObj, pKey)
										?? lookupFromMap(savedParamObj, p.label)
										?? lookupFromMap(customMetadata, pKey)
										?? lookupFromMap(customMetadata, p.label);
									const ctxVal = contextVariables[pKey];

									let val: unknown;
									if (isNonEmptyParam(overrideVal)) {
										val = overrideVal;
									} else if (isNonEmptyParam(savedVal)) {
										val = this._parseInputStringLiteral(savedVal);
									} else if (isNonEmptyParam(ctxVal)) {
										val = ctxVal;
									} else if (isNonEmptyParam(p.defaultValue)) {
										val = this._parseInputStringLiteral(p.defaultValue);
									} else {
										val = (overrideVal !== undefined && overrideVal !== null)
											? overrideVal
											: ((savedVal !== undefined && savedVal !== null)
												? this._parseInputStringLiteral(savedVal)
												: ((ctxVal !== undefined && ctxVal !== null)
													? ctxVal
													: undefined));
									}

									if (val !== undefined) {
										resolvedParams[pKey] = val;
										contextVariables[pKey] = val;
										if (p.label) {
											contextVariables[p.label] = val;
										}
									}
									// Clean up any loose top-level parameter entries in customMetadata from legacy ticket creation
									if (pKey && pKey !== fieldLabel && customMetadata[pKey] !== undefined) {
										delete customMetadata[pKey];
									}
									if (p.label && p.label !== fieldLabel && customMetadata[p.label] !== undefined) {
										delete customMetadata[p.label];
									}
								}
							}
							customMetadata[fieldLabel] = JSON.stringify(resolvedParams);
							stepOutput = resolvedParams;
							contextVariables['Parameters'] = { ...(contextVariables['Parameters'] || {}), ...resolvedParams };
							contextVariables['Inputs'] = { ...(contextVariables['Inputs'] || {}), ...resolvedParams };
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
								const metaVal: unknown = customMetadata[fieldLabel];
								if (typeof metaVal === 'string') {
									const trimmed = metaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.url) { targetUrl = String(parsed.url).trim(); }
											if (parsed.content) { existingContent = String(parsed.content); }
											if (parsed.credentials && Array.isArray(parsed.credentials)) { browserCreds = parsed.credentials; }
										} catch {
											targetUrl = trimmed;
										}
									} else {
										targetUrl = trimmed;
									}
								} else if (isWorkflowRecord(metaVal)) {
									if (metaVal.url) { targetUrl = String(metaVal.url).trim(); }
									if (metaVal.content) { existingContent = String(metaVal.content); }
									if (metaVal.credentials) { browserCreds = metaVal.credentials as typeof browserCreds; }
								}
							}

							if (!targetUrl && field.defaultUrl) {
								targetUrl = field.defaultUrl.trim();
							}

							const interpolatedUrl = this._interpolateVariables(targetUrl, contextVariables);
							if (interpolatedUrl) {
								field.lastResolvedUrl = interpolatedUrl;
								field.lastExecutedUrl = interpolatedUrl;
								field.lastExecutedAt = new Date().toLocaleTimeString();
								field.lastExecutionStatus = 'success';
							}

							let retryLogs: string[] = [];
							let fetchAttempts = 0;
							let finalFetchError: string | undefined;

							if (interpolatedUrl && /^https?:\/\//i.test(interpolatedUrl.trim())) {
								const maxRetries = (typeof field.browserMaxRetries === 'number' && Number.isFinite(field.browserMaxRetries))
									? Math.max(0, Math.min(10, Math.floor(field.browserMaxRetries)))
									: 3;
								const retryDelayMs = (typeof field.browserRetryDelayMs === 'number' && Number.isFinite(field.browserRetryDelayMs))
									? Math.max(0, Math.min(60000, Math.floor(field.browserRetryDelayMs)))
									: 1000;
								this.logService.info(`[TicketWorkflowRuntime] Fetching web content from: ${interpolatedUrl} (maxRetries=${maxRetries}, delay=${retryDelayMs}ms)`);
								const extracted = await this._extractWebContentWithRetry(interpolatedUrl, browserCreds, {
									maxRetries,
									retryDelayMs,
									label: fieldLabel,
									onRetryLog: (msg) => {
										this.logService.warn(`[TicketWorkflowRuntime] ${msg}`);
										options.onProgress?.({
											stepIndex: stepIdx,
											totalSteps: fieldsToRun.length,
											fieldId: field.id,
											fieldLabel,
											fieldType: fieldType,
											status: 'running',
											message: msg
										});
									},
									checkCancelled: () => {
										if (this._cancelEpoch !== startEpoch) {
											throw new Error('Ticket execution cancelled by Stop request');
										}
									}
								});
								retryLogs = extracted.retryLogs;
								fetchAttempts = extracted.attempts;
								finalFetchError = extracted.lastError;
								const fetchFailed = Boolean(finalFetchError) || !extracted.content || extracted.content.startsWith('[Fetch Failed') || extracted.content.startsWith('HTTP Error');
								if (fetchFailed && existingContent) {
									this.logService.info(`[TicketWorkflowRuntime] Web fetch failed after ${fetchAttempts} attempt(s); using preloaded content (${existingContent.length} chars)`);
									stepOutput = existingContent;
									finalFetchError = undefined;
								} else {
									stepOutput = extracted.content || existingContent || (finalFetchError ? `[Fetch Failed: ${finalFetchError}]` : '');
								}

								customMetadata[fieldLabel] = JSON.stringify({
									url: targetUrl || interpolatedUrl,
									resolvedUrl: interpolatedUrl,
									content: stepOutput,
									credentials: browserCreds || [],
									lastFetched: new Date().toISOString()
								});
								customMetadata[`${fieldLabel}_url`] = interpolatedUrl;
								customMetadata[`${fieldLabel}_resolved_url`] = interpolatedUrl;
								contextVariables[fieldLabel] = stepOutput;
								contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
								contextVariables[`${this._cleanKey(fieldLabel)}_url`] = interpolatedUrl;
								contextVariables[`${this._cleanKey(fieldLabel)}_resolved_url`] = interpolatedUrl;
							} else if (existingContent) {
								stepOutput = existingContent;
								customMetadata[fieldLabel] = JSON.stringify({
									url: targetUrl || '',
									content: stepOutput,
									credentials: browserCreds || [],
									lastFetched: new Date().toISOString()
								});
								customMetadata[`${fieldLabel}_resolved_url`] = targetUrl;
								contextVariables[fieldLabel] = stepOutput;
								contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							} else {
								stepOutput = `[Browser: Skipped - Invalid or empty URL: '${targetUrl}']`;
								contextVariables[fieldLabel] = stepOutput;
							}

							stepDetails = {
								targetUrl: targetUrl,
								requestedUrl: interpolatedUrl || targetUrl,
								resolvedUrl: interpolatedUrl || targetUrl,
								content: stepOutput,
								contentLength: typeof stepOutput === 'string' ? stepOutput.length : 0,
								credentials: browserCreds || [],
								attempts: fetchAttempts,
								retryLogs
							};

							if (finalFetchError || (typeof stepOutput === 'string' && (stepOutput.startsWith('[Fetch Failed') || stepOutput.startsWith('HTTP Error') || stepOutput.startsWith('[Browser: Skipped - Invalid or empty URL')))) {
								field.lastExecutionStatus = 'failed';
								const errSummary = finalFetchError || String(stepOutput);
								field.lastExecutionLog = [
									`>>> Browser Fetch Failed: ${interpolatedUrl || targetUrl}`,
									...retryLogs,
									`Final Error: ${errSummary}`
								].join('\n');
								throw new Error(errSummary);
							}
							if (retryLogs.length > 0) {
								field.lastExecutionLog = [
									`>>> Visited Target URL: ${interpolatedUrl || targetUrl}`,
									...retryLogs,
									`Extracted Length: ${typeof stepOutput === 'string' ? stepOutput.length : 0} chars`
								].join('\n');
							}
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
							let promptModel = field.targetModel || resolveDefaultModelId(field.targetProvider, 'gpt-4o');
							let promptProvider = field.targetProvider;
							let existingPromptOutput = '';

							if (customMetadata[fieldLabel]) {
								const metaVal: unknown = customMetadata[fieldLabel];
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
													userPrompts = parsed.userPrompts.map((item: unknown) => String(item ?? ''));
												}
												if (parsed.userPrompt !== undefined) { userPrompt = String(parsed.userPrompt).trim(); }
											}
											if (parsed.prompt !== undefined) { legacySavedPrompt = String(parsed.prompt).trim(); }
											if (parsed.targetModel) { promptModel = String(parsed.targetModel); }
											if (parsed.targetProvider) { promptProvider = String(parsed.targetProvider); }
											if (parsed.output) { existingPromptOutput = String(parsed.output); }
										} catch {
											legacySavedPrompt = trimmed;
										}
									} else {
										legacySavedPrompt = trimmed;
									}
								} else if (isWorkflowRecord(metaVal)) {
									if (metaVal.preInjectedPrompt !== undefined && String(metaVal.preInjectedPrompt).trim()) {
										preInjectedPrompt = String(metaVal.preInjectedPrompt).trim();
									}
									if (isUserInputVisible) {
										if (Array.isArray(metaVal.userPrompts)) {
											userPrompts = metaVal.userPrompts.map((item: unknown) => String(item ?? ''));
										}
										if (metaVal.userPrompt !== undefined) { userPrompt = String(metaVal.userPrompt).trim(); }
									}
									if (metaVal.prompt !== undefined) { legacySavedPrompt = String(metaVal.prompt).trim(); }
									if (metaVal.targetModel) { promptModel = String(metaVal.targetModel); }
									if (metaVal.targetProvider) { promptProvider = String(metaVal.targetProvider); }
									if (metaVal.output) { existingPromptOutput = String(metaVal.output); }
								}
							}
							const promptDefaultModel = getGlobalDefaultModel();
							if (!promptProvider && promptDefaultModel && promptModel === promptDefaultModel.modelId) {
								promptProvider = promptDefaultModel.providerId;
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
								this._assertPromptVariablesResolved(fieldLabel, rawPrompt, interpolatedPrompt);
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

							if (typeof stepOutput === 'string' && (stepOutput.startsWith('[AI Execution Error') || stepOutput.startsWith('[AI Service Error') || stepOutput.startsWith('[AI Execution Notice'))) {
								throw new Error(stepOutput);
							}
							break;
						}

						case 'tts': {
							// 3.5 Audio / TTS Primitive: check cached local MP3 file or synthesize speech via LLM API
							let rawText = field.defaultContent || '';
							let displayText = field.ttsDisplayText || '';
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
											if (parsed.text !== undefined) { rawText = String(parsed.text); }
											if (parsed.displayText !== undefined) { displayText = String(parsed.displayText); }
											else if (parsed.ttsDisplayText !== undefined) { displayText = String(parsed.ttsDisplayText); }
											if (parsed.targetCredentialId) { targetCredId = String(parsed.targetCredentialId); }
											if (parsed.targetProvider) { targetProvider = String(parsed.targetProvider); }
											if (parsed.targetModel) { targetModel = String(parsed.targetModel); }
											if (parsed.ttsFormat) { ttsFormat = String(parsed.ttsFormat).toLowerCase(); }
											if (parsed.ttsVoice) { ttsVoice = String(parsed.ttsVoice); }
											if (parsed.ttsAutoPlay !== undefined) { ttsAutoPlay = Boolean(parsed.ttsAutoPlay); }
											if (parsed.audioFileName) { audioFileName = String(parsed.audioFileName); }
											if (parsed.audioRelativePath) { audioRelativePath = String(parsed.audioRelativePath); }
											if (parsed.lastGenerated) { lastGenerated = String(parsed.lastGenerated); }
											if (parsed.lastSynthesizedText !== undefined) { lastSynthesizedText = String(parsed.lastSynthesizedText); }
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
								ttsShowSpeechTextInTicket: Boolean(field.ttsShowSpeechTextInTicket),
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
											if (parsed.mediaFilePath !== undefined) { mediaFilePath = String(parsed.mediaFilePath); }
											else if (parsed.filePath !== undefined) { mediaFilePath = String(parsed.filePath); }
											if (parsed.mediaFileName !== undefined) { mediaFileName = String(parsed.mediaFileName); }
											else if (parsed.fileName !== undefined) { mediaFileName = String(parsed.fileName); }
											if (parsed.mediaMimeType !== undefined) { mediaMimeType = String(parsed.mediaMimeType); }
											if (typeof parsed.mediaPlaybackRate === 'number') { mediaPlaybackRate = parsed.mediaPlaybackRate; }
											if (parsed.mediaAutoPlay !== undefined) { mediaAutoPlay = Boolean(parsed.mediaAutoPlay); }
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

						case 'voice_note': {
							if (!field.voiceRunInFlow) {
								// Voice Note is commentary-only by default — skip execution
								continue;
							}
							const clips = Array.isArray(field.voiceClips) ? field.voiceClips.filter(c => !!c?.audioDataUrl) : [];
							const rate = typeof field.voicePlaybackRate === 'number' && Number.isFinite(field.voicePlaybackRate) ? field.voicePlaybackRate : 1.0;
							const playedCount = await this._playVoiceNoteClipsSequentially(clips, rate);
							const combinedTranscript = (field.voiceTranscript || clips.map(c => (c.transcript || '').trim()).filter(Boolean).join('\n\n')).trim();
							stepOutput = combinedTranscript;
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							stepDetails = {
								clipCount: clips.length,
								playedCount,
								transcript: combinedTranscript
							};
							break;
						}

						case 'python': {
							// 4. Python Primitive: execute automation script using specified interpreter or virtualenv
							let rawCode = field.pythonCode || '';
							let pythonPath = field.pythonPath || '';
							let existingOutput = '';
							let externalScripts: string[] = Array.isArray(field.externalScripts) ? [...field.externalScripts] : [];

							const rawMetaVal: unknown = customMetadata[fieldLabel];
							if (rawMetaVal) {
								if (typeof rawMetaVal === 'string') {
									const trimmed = rawMetaVal.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											const parsed = JSON.parse(trimmed);
											if (parsed.code !== undefined) { rawCode = String(parsed.code); }
											if (parsed.pythonCode !== undefined) { rawCode = String(parsed.pythonCode); }
											if (parsed.pythonPath !== undefined) { pythonPath = String(parsed.pythonPath); }
											if (parsed.output !== undefined) { existingOutput = String(parsed.output); }
											if (Array.isArray(parsed.externalScripts)) { externalScripts = parsed.externalScripts; }
										} catch {
											rawCode = trimmed;
										}
									} else {
										rawCode = trimmed;
									}
								} else if (isWorkflowRecord(rawMetaVal)) {
									if (rawMetaVal.code !== undefined) { rawCode = String(rawMetaVal.code); }
									if (rawMetaVal.pythonCode !== undefined) { rawCode = String(rawMetaVal.pythonCode); }
									if (rawMetaVal.pythonPath !== undefined) {
										const p = rawMetaVal.pythonPath;
										if (isWorkflowRecord(p)) {
											pythonPath = String(p.interpreterPath || p.pythonPath || '');
										} else {
											const s = String(p);
											pythonPath = s === '[object Object]' ? '' : s;
										}
									}
									if (rawMetaVal.output !== undefined) { existingOutput = String(rawMetaVal.output); }
									if (Array.isArray(rawMetaVal.externalScripts)) {
										externalScripts = rawMetaVal.externalScripts;
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
								durationMs: execResult.durationMs,
								error: (execResult.exitCode !== 0 || !execResult.success) ? (execResult.error || `Python script exited with code ${execResult.exitCode}`) : undefined
							};

							if (execResult.exitCode !== 0 || !execResult.success) {
								const pyErrMsg = execResult.error || `Python script exited with code ${execResult.exitCode}${execResult.output ? `:\n${execResult.output}` : ''}`;
								throw new Error(pyErrMsg);
							}
							break;
						}

						case 'ssh': {
							let sshHost = field.sshHost || '';
							let sshPort: number | string = field.sshPort || 22;
							let sshUser = field.sshUser || 'root';
							let sshPassword = field.sshPassword || '';
							let sshCwd = field.sshCwd || '';
							let rawCommandsList: string[] = normalizeSshCommandsList(field.sshCommands, field.sshCommand || field.defaultContent || '');
							let existingOutput = field.sshOutput || '';
							let sshOutputLines: number = typeof field.sshOutputLines === 'number' && field.sshOutputLines > 0 ? field.sshOutputLines : 50;
							let history: unknown[] = [];

							const rawSshMeta = customMetadata[fieldLabel];
							const sshVal = normalizeSshTicketValue(rawSshMeta);
							if (sshVal) {
								// Ticket value uses the same names as the template config (sshHost, sshPort, ...).
								if (sshVal.sshHost !== undefined) { sshHost = String(sshVal.sshHost ?? ''); }
								if (sshVal.sshPort !== undefined) { sshPort = sshVal.sshPort ?? 22; }
								if (sshVal.sshUser !== undefined) { sshUser = String(sshVal.sshUser ?? 'root'); }
								if (sshVal.sshPassword !== undefined) { sshPassword = String(sshVal.sshPassword ?? ''); }
								if (sshVal.sshCwd !== undefined) { sshCwd = String(sshVal.sshCwd ?? ''); }
								if (Array.isArray(sshVal.sshCommands)) {
									rawCommandsList = normalizeSshCommandsList(sshVal.sshCommands);
								} else if (sshVal.sshCommand !== undefined) {
									rawCommandsList = normalizeSshCommandsList(undefined, String(sshVal.sshCommand ?? ''));
								}
								if (sshVal.sshOutput !== undefined) { existingOutput = String(sshVal.sshOutput); }
								if (sshVal.sshOutputLines !== undefined) {
									const parsedN = Number(sshVal.sshOutputLines);
									if (!isNaN(parsedN) && parsedN > 0) { sshOutputLines = Math.floor(parsedN); }
								}
								if (Array.isArray(sshVal.history)) { history = sshVal.history; }
							} else if (typeof rawSshMeta === 'string' && rawSshMeta.trim()) {
								rawCommandsList = [rawSshMeta.trim()];
							} else if (Array.isArray(rawSshMeta)) {
								rawCommandsList = normalizeSshCommandsList(rawSshMeta);
							}

							if (inputOverrides[fieldLabel] !== undefined) {
								const ovVal = inputOverrides[fieldLabel];
								if (typeof ovVal === 'string') {
									rawCommandsList = [ovVal];
								} else if (Array.isArray(ovVal)) {
									rawCommandsList = normalizeSshCommandsList(ovVal);
								} else if (isWorkflowRecord(ovVal)) {
									const ov = normalizeSshTicketValue(ovVal) ?? {};
									if (ov.sshHost) { sshHost = String(ov.sshHost); }
									if (ov.sshPort) { sshPort = ov.sshPort; }
									if (ov.sshUser) { sshUser = String(ov.sshUser); }
									if (ov.sshPassword) { sshPassword = String(ov.sshPassword); }
									if (ov.sshCwd) { sshCwd = String(ov.sshCwd); }
									if (Array.isArray(ov.sshCommands)) {
										rawCommandsList = normalizeSshCommandsList(ov.sshCommands);
									} else if (ov.sshCommand) {
										rawCommandsList = normalizeSshCommandsList(undefined, String(ov.sshCommand));
									}
									if (ov.sshOutputLines) {
										const parsedN = Number(ov.sshOutputLines);
										if (!isNaN(parsedN) && parsedN > 0) { sshOutputLines = Math.floor(parsedN); }
									}
								}
							}

							const batchRes = await this.executeSshBatchCommands({
								workspaceUri: wsUri,
								host: sshHost,
								port: sshPort,
								user: sshUser,
								password: sshPassword,
								cwd: sshCwd,
								commands: rawCommandsList,
								outputLines: sshOutputLines,
								existingTerminalLog: existingOutput,
								contextVariables,
								isCancelled,
								onCommandProgress: (prog) => {
									if (prog.phase === 'done' && prog.result) {
										history = [...history.slice(-49), {
											timestamp: new Date().toISOString(),
											cwd: prog.cwd || '~',
											command: prog.command,
											output: prog.rawOutput || '',
											exitCode: prog.result.exitCode,
											durationMs: prog.result.durationMs
										}];
									}
								}
							});

							if (!batchRes.success) {
								stepDetails = {
									host: batchRes.host,
									port: batchRes.port,
									user: batchRes.user,
									cwd: batchRes.cwd,
									commands: batchRes.resolvedCommands,
									failedCommandIndex: batchRes.failedCommandIndex,
									failedCommand: batchRes.failedCommand,
									error: batchRes.error
								};
								throw new Error(batchRes.error || `SSH Connection Failed (${batchRes.user}@${batchRes.host}:${batchRes.port})`);
							}

							stepOutput = batchRes.jsonOutput;
							// Saved with the template config names. Config values are kept RAW (e.g. `{SSH_PASSWORD}`), never the
							// resolved secret; resolved host/commands go to the run details only.
							customMetadata[fieldLabel] = JSON.stringify({
								sshHost,
								sshPort,
								sshUser,
								sshPassword,
								sshCwd: batchRes.cwd || sshCwd,
								sshCommand: rawCommandsList[0] || '',
								sshCommands: rawCommandsList,
								sshOutputLines,
								sshQuickCommands: normalizeSshQuickCommands((normalizeSshTicketValue(rawSshMeta)?.sshQuickCommands) ?? field.sshQuickCommands),
								sshOutput: batchRes.terminalTranscript,
								sshLastRawOutput: batchRes.rawEntries.length > 0 ? batchRes.rawEntries[batchRes.rawEntries.length - 1].rawOutput : '',
								sshLastRawEntries: batchRes.rawEntries,
								sshLastOutput: stepOutput,
								exitCode: batchRes.exitCode,
								durationMs: batchRes.durationMs,
								sshLastExecuted: new Date().toISOString(),
								history
							});
							stepDetails = {
								host: batchRes.host,
								port: batchRes.port,
								user: batchRes.user,
								cwd: batchRes.cwd,
								commands: batchRes.resolvedCommands,
								outputLines: sshOutputLines,
								output: stepOutput,
								exitCode: batchRes.exitCode,
								durationMs: batchRes.durationMs
							};
							if (batchRes.exitCode !== 0) {
								throw new Error(`SSH commands exited with code ${batchRes.exitCode}`);
							}
							contextVariables[fieldLabel] = stepOutput;
							contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
							contextVariables[`${this._cleanKey(fieldLabel)}_output`] = stepOutput;
							break;
						}

						case 'http_request': {
							const effectiveField: IRuntimeCustomField = { ...field };
							const rawHttpMeta = customMetadata[fieldLabel] ?? customMetadata[field.id];
							const httpVal = normalizeHttpTicketValue(rawHttpMeta);
							if (httpVal) {
								// The ticket value uses the template config names; every request setting saved on the ticket wins.
								for (const key of HTTP_REQUEST_CONFIG_KEYS) {
									const v = httpVal[key];
									if (v === undefined || v === null) {
										continue;
									}
									if ((key === 'httpParams' || key === 'httpHeaders') && !Array.isArray(v)) {
										continue;
									}
									if (key === 'httpTimeoutMs') {
										const n = Number(v);
										if (!isNaN(n) && n > 0) {
											effectiveField.httpTimeoutMs = n;
										}
										continue;
									}
									if (key === 'httpUrl' && String(v).trim() === '') {
										continue;
									}
									Reflect.set(effectiveField, key, v);
								}
							}
							const httpRes = await this.executeHttpRequest(effectiveField, contextVariables);
							field.httpResponseStatus = httpRes.status;
							field.httpResponseStatusText = httpRes.statusText;
							field.httpResponseHeaders = httpRes.headers;
							field.httpResponseBody = httpRes.rawText;
							field.httpResponseData = httpRes.data;
							field.defaultContent = typeof httpRes.data === 'object' ? JSON.stringify(httpRes.data, null, 2) : (httpRes.rawText || '');
							field.httpLastExecutionTime = new Date().toISOString();
							field.httpLastDurationMs = httpRes.durationMs;

							// Pure business output: ONLY the response payload, NEVER transport/HTTP metadata!
							const cleanHttpData = (httpRes.data !== undefined && httpRes.data !== null)
								? httpRes.data
								: (httpRes.body !== undefined && httpRes.body !== null ? httpRes.body : (httpRes.rawText || ''));
							stepOutput = cleanHttpData;

							// Keep the request settings (template config names) and add the response next to them, instead of
							// replacing the whole ticket value with the response.
							const savedHttp: Record<string, unknown> = { ...(httpVal ?? {}) };
							for (const key of HTTP_REQUEST_CONFIG_KEYS) {
								const effectiveVal: unknown = Reflect.get(effectiveField, key);
								if (savedHttp[key] === undefined && effectiveVal !== undefined) {
									savedHttp[key] = effectiveVal;
								}
							}
							Object.assign(savedHttp, {
								httpResponseStatus: httpRes.status,
								httpResponseStatusText: httpRes.statusText,
								httpResponseHeaders: httpRes.headers,
								httpResponseBody: httpRes.rawText,
								httpResponseData: httpRes.data,
								httpLastExecutionTime: new Date().toISOString(),
								httpLastDurationMs: httpRes.durationMs
							});
							customMetadata[fieldLabel] = JSON.stringify(savedHttp);
							customMetadata[`${fieldLabel}_status`] = String(httpRes.status);
							customMetadata[`${fieldLabel}_ok`] = String(httpRes.ok);

							contextVariables[fieldLabel] = cleanHttpData;
							contextVariables[this._cleanKey(fieldLabel)] = cleanHttpData;
							if (field.outputVariableName) {
								contextVariables[field.outputVariableName] = cleanHttpData;
								contextVariables[this._cleanKey(field.outputVariableName)] = cleanHttpData;
							}
							if (field.id) {
								contextVariables[field.id] = cleanHttpData;
							}
							const prevLabels = getPreviousLabels(field);
							for (const pl of prevLabels) {
								if (pl && typeof pl === 'string') {
									contextVariables[pl] = cleanHttpData;
									contextVariables[this._cleanKey(pl)] = cleanHttpData;
								}
							}
							contextVariables[`${fieldLabel}_status`] = httpRes.status;
							contextVariables[`${this._cleanKey(fieldLabel)}_status`] = httpRes.status;
							contextVariables[`${fieldLabel}_ok`] = httpRes.ok;
							contextVariables[`${this._cleanKey(fieldLabel)}_ok`] = httpRes.ok;
							if (httpRes.data !== null && httpRes.data !== undefined) {
								contextVariables[`${fieldLabel}_data`] = httpRes.data;
								contextVariables[`${this._cleanKey(fieldLabel)}_data`] = httpRes.data;
							}
							contextVariables[`${fieldLabel}_body`] = httpRes.body;
							contextVariables[`${this._cleanKey(fieldLabel)}_body`] = httpRes.body;
							contextVariables[`${fieldLabel}_raw`] = httpRes.rawText;
							contextVariables[`${this._cleanKey(fieldLabel)}_raw`] = httpRes.rawText;

							stepDetails = {
								method: httpRes.method,
								url: httpRes.url,
								status: httpRes.status,
								statusText: httpRes.statusText,
								ok: httpRes.ok,
								headers: httpRes.headers,
								durationMs: httpRes.durationMs,
								error: httpRes.error
							};

							if (!httpRes.ok) {
								const httpErrMsg = httpRes.error || `HTTP ${httpRes.method} to '${httpRes.url}' failed with status ${httpRes.status} ${httpRes.statusText || ''}`;
								throw new Error(httpErrMsg);
							}
							break;
						}

						case 'table': {
							// 4.5 Data Table (SQLite / Structured Grid) Primitive
							const defaultTableSlug = this._cleanKey(fieldLabel) || 'ticket_table';
							let tableColumns: ITableColumnDefinition[] = Array.isArray(field.tableColumns) ? [...field.tableColumns] : [];
							let tableRows: Record<string, unknown>[] = Array.isArray(field.tableRows) ? [...field.tableRows] : [];
							let dbEngine: 'sqlite' | 'none' = (field.tableDbEngine as 'sqlite' | 'none') || 'sqlite';
							let dbPath = field.tableDbPath || '';
							let dbTableName = field.tableDbTableName || defaultTableSlug;
							let autoSyncDb = Boolean(field.tableAutoSyncDb);
							let sqlQuery = field.tableSqlQuery || '';

							const rawTableMeta = customMetadata[fieldLabel];
							if (rawTableMeta) {
								let parsedObj: unknown = undefined;
								if (typeof rawTableMeta === 'string') {
									const trimmed = rawTableMeta.trim();
									if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
										try {
											parsedObj = JSON.parse(trimmed);
										} catch { }
									}
								} else if (isWorkflowRecord(rawTableMeta)) {
									parsedObj = rawTableMeta;
								}
								if (isWorkflowRecord(parsedObj)) {
									if (Array.isArray(parsedObj.columns) && parsedObj.columns.length > 0) { tableColumns = parsedObj.columns; }
									if (Array.isArray(parsedObj.rows) && parsedObj.rows.length > 0) { tableRows = parsedObj.rows; }
									if (parsedObj.dbEngine) { dbEngine = parsedObj.dbEngine as typeof dbEngine; }
									if (typeof parsedObj.dbPath === 'string' && parsedObj.dbPath.trim() !== '') { dbPath = parsedObj.dbPath; }
									if (typeof parsedObj.tableName === 'string' && parsedObj.tableName.trim() !== '') {
										if (!(field.tableDbTableName && parsedObj.tableName.trim() === defaultTableSlug && field.tableDbTableName !== defaultTableSlug)) {
											dbTableName = parsedObj.tableName;
										}
									}
									if (parsedObj.autoSyncDb !== undefined) { autoSyncDb = Boolean(parsedObj.autoSyncDb); }
									if (typeof parsedObj.sqlQuery === 'string' && parsedObj.sqlQuery.trim() !== '') { sqlQuery = parsedObj.sqlQuery; }
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
							let interpolatedSql = '';
							let cleanedInterpolatedSql = '';
							let sqlRes: ISqliteTableOperationResult | undefined = undefined;
							if (sqlQuery.trim()) {
								interpolatedSql = this._interpolateVariables(sqlQuery.trim(), contextVariables);
								if (isParamTableExpr && rawDbTableName && interpolatedSql.includes(rawDbTableName)) {
									interpolatedSql = interpolatedSql.split(rawDbTableName).join(resolvedTableName);
								}
								cleanedInterpolatedSql = interpolatedSql
									.replace(/^```(?:sql|sqlite|sqlite3)?\s*\n?/i, '')
									.replace(/\n?```\s*$/i, '')
									.trim();
								const sqlStartMs = Date.now();
								sqlRes = await this.executeSqliteTableOperation({
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
									const errTablePayload = {
										columns: tableColumns,
										rows: tableRows,
										dbEngine,
										dbPath,
										tableName: dbTableName,
										autoSyncDb,
										sqlQuery,
										sqlOutput: sqlOutputText,
										output: sqlOutputText
									};
									customMetadata[fieldLabel] = JSON.stringify(errTablePayload);
									throw new Error(sqlRes.error || 'SQL statement execution failed');
								}
							} else if (sqliteSyncResult) {
								sqlOutputText = sqliteSyncResult.message || JSON.stringify(sqliteSyncResult.rows || []);
								if (!sqliteSyncResult.success) {
									throw new Error(sqliteSyncResult.error || 'Database operation failed');
								}
							}

							const tablePayload = {
								columns: tableColumns,
								rows: tableRows,
								queryColumns: (sqliteSyncResult?.isSelectQuery && !sqliteSyncResult?.isPragmaQuery && Array.isArray(sqliteSyncResult?.queryColumns))
									? sqliteSyncResult.queryColumns
									: undefined,
								queryRows: (sqliteSyncResult?.isSelectQuery && !sqliteSyncResult?.isPragmaQuery && Array.isArray(sqliteSyncResult?.queryRows))
									? sqliteSyncResult.queryRows
									: undefined,
								dbEngine,
								dbPath,
								tableName: dbTableName,
								autoSyncDb,
								sqlQuery,
								sqlOutput: sqlOutputText,
								output: Array.isArray(tableRows) && tableRows.length > 0 ? JSON.stringify(tableRows) : (sqlOutputText || JSON.stringify(tableRows)),
								lastSynced: sqliteSyncResult?.success ? new Date().toISOString() : undefined
							};
							customMetadata[fieldLabel] = JSON.stringify(tablePayload);
							const tableOutputVal = (Array.isArray(tableRows) && tableRows.length > 0)
								? tableRows
								: (sqlOutputText && sqlOutputText.trim() !== '' ? sqlOutputText.trim() : tableRows);
							stepOutput = tableOutputVal;
							contextVariables[fieldLabel] = tablePayload;
							contextVariables[this._cleanKey(fieldLabel)] = tablePayload;
							contextVariables[`${fieldLabel}.output`] = sqlOutputText || tableRows;
							contextVariables[`${fieldLabel}.sqlOutput`] = sqlOutputText;
							contextVariables[`${fieldLabel}.table`] = this._formatTablePayloadAsMarkdown(tableColumns, tableRows);
							contextVariables[`${fieldLabel}.rows`] = tableRows;
							contextVariables[`${fieldLabel}.json`] = JSON.stringify(tableRows);
							contextVariables[`${fieldLabel}.columns`] = tableColumns;
							contextVariables[`${fieldLabel}.dbPath`] = dbPath;
							contextVariables[`${fieldLabel}.tableName`] = dbTableName;

							const cleanFieldLabel = this._cleanKey(fieldLabel);
							contextVariables[`${cleanFieldLabel}.output`] = sqlOutputText || tableRows;
							contextVariables[`${cleanFieldLabel}.sqlOutput`] = sqlOutputText;
							contextVariables[`${cleanFieldLabel}.table`] = this._formatTablePayloadAsMarkdown(tableColumns, tableRows);
							contextVariables[`${cleanFieldLabel}.rows`] = tableRows;
							contextVariables[`${cleanFieldLabel}.json`] = JSON.stringify(tableRows);
							contextVariables[`${cleanFieldLabel}.columns`] = tableColumns;
							contextVariables[`${cleanFieldLabel}.dbPath`] = dbPath;
							contextVariables[`${cleanFieldLabel}.tableName`] = dbTableName;
							contextVariables[`${cleanFieldLabel}_payload`] = tablePayload;
							contextVariables[`${cleanFieldLabel}_output`] = sqlOutputText;
							contextVariables[`${cleanFieldLabel}_rows`] = tableRows;
							contextVariables[`${cleanFieldLabel}_columns`] = tableColumns;
							contextVariables[`${cleanFieldLabel}_db_path`] = dbPath;
							contextVariables[`${cleanFieldLabel}_table_name`] = dbTableName;

							stepDetails = {
								columns: tableColumns,
								rowCount: tableRows.length,
								dbEngine,
								dbPath,
								tableName: dbTableName,
								sqlQuery: sqlQuery ? (cleanedInterpolatedSql || interpolatedSql || sqlQuery) : undefined,
								sqlOutput: sqlOutputText,
								error: (sqlRes && !sqlRes.success) ? (sqlRes.error || 'SQL statement execution failed') : undefined,
								sqliteSync: sqliteSyncResult ? {
									success: sqliteSyncResult.success,
									message: sqliteSyncResult.message,
									rowsAffected: sqliteSyncResult.rowsAffected,
									error: sqliteSyncResult.error
								} : undefined
							};

							if (sqlRes && !sqlRes.success) {
								const errMsg = sqlRes.error || `SQL Error: Execution failed on table '${resolvedTableName}' in '${resolvedDbPath}'`;
								throw new Error(errMsg);
							}
							break;
						}

						case 'output': {
							// 4. Output Manifest Primitive: aggregate enabled primitive outputs
							const aggregatedMap: Record<string, unknown> = {};
							const specs: IOutputSpec[] = field.outputSpecs || [];
							const enabledSpecs = specs.filter(s => s.enabled !== false);

							if (enabledSpecs.length > 0) {
								for (const spec of enabledSpecs) {
									const specKey = (spec.label || spec.varName || spec.fieldKey || '').trim();
									if (!specKey) {
										continue;
									}
									let rawVal: unknown;
									if (spec.isCustom || (spec.sourceExpression && spec.sourceExpression.trim().length > 0)) {
										rawVal = this._resolveOutputSpecValue(spec, contextVariables);
									} else {
										const matchedSchemaField = fieldsToRun.find(f =>
											f.type !== 'output' && (
												f.label === specKey ||
												f.label === spec.fieldKey ||
												f.id === spec.fieldKey ||
												f.id === specKey
											)
										);
										const outVarCand = matchedSchemaField
											? ((matchedSchemaField.outputVariableName || '').trim() || generateSmartPythonVarName(matchedSchemaField.label || matchedSchemaField.id, matchedSchemaField.type))
											: '';
										rawVal = contextVariables[specKey]
											?? contextVariables[spec.fieldKey]
											?? contextVariables[this._cleanKey(specKey)]
											?? (spec.fieldKey ? contextVariables[this._cleanKey(spec.fieldKey)] : undefined)
											?? (spec.varName ? contextVariables[spec.varName] : undefined)
											?? (matchedSchemaField?.label ? contextVariables[matchedSchemaField.label] : undefined)
											?? (matchedSchemaField?.id ? contextVariables[matchedSchemaField.id] : undefined)
											?? (outVarCand ? contextVariables[outVarCand] : undefined)
											?? customMetadata[specKey]
											?? customMetadata[spec.fieldKey];
									}
									const formattedVal = spec.isCustom ? rawVal : this._formatOutputValue(rawVal, spec.defaultFormat || 'table');
									aggregatedMap[specKey] = formattedVal;
									contextVariables[specKey] = formattedVal;
									contextVariables[this._cleanKey(specKey)] = formattedVal;
									if (spec.varName && spec.varName.trim()) {
										contextVariables[spec.varName.trim()] = formattedVal;
									}
								}
								stepOutput = aggregatedMap;
								finalOutput = aggregatedMap;
							} else {
								for (const sr of stepResults) {
									if (sr.fieldType !== 'output' && sr.fieldLabel && sr.output !== undefined) {
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
							const outputPayloadToPersist = (isWorkflowRecord(stepOutput) && !Array.isArray(stepOutput))
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
							const resolvedParams: Record<string, unknown> = {};
							if (isWorkflowRecord(field.wfTicketParams)) {
								for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
									if (pv === undefined || pv === '') { continue; }
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
							if (!createdRes || !createdRes.success) {
								const errMsg = createdRes?.error || `Failed to create ticket '${tTitle}'`;
								stepDetails.error = errMsg;
								throw new Error(errMsg);
							}
							break;
						}

						case 'run_tickets': {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
							let resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(rawTarget, contextVariables).trim();
							if (isWorkflowRecord(resolvedTarget)) {
								resolvedTarget = resolvedTarget.ticketId || resolvedTarget.entityUri || resolvedTarget.ticketName || '';
							}
							const resolvedParams: Record<string, unknown> = {};
							if (isWorkflowRecord(field.wfTicketParams)) {
								for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
									if (pv === undefined || pv === '') { continue; }
									const pVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
									resolvedParams[pk] = (pVar && contextVariables[pVar[1].trim()] !== undefined)
										? contextVariables[pVar[1].trim()]
										: this._interpolateVariables(String(pv), contextVariables);
								}
							}
							const runRes = await this.runTicket({
								workspaceUri: wsUri,
								ticketIdOrPath: String(resolvedTarget || ''),
								inputParams: resolvedParams
							});
							stepOutput = runRes;
							contextVariables[fieldLabel] = runRes;
							contextVariables[this._cleanKey(fieldLabel)] = runRes;
							customMetadata[fieldLabel] = JSON.stringify({ ticketId: runRes.ticketId, status: runRes.status, output: runRes.output });
							stepDetails = { targetTicket: resolvedTarget, parameters: resolvedParams, result: runRes };
							if (!runRes || !runRes.success || runRes.status === 'failed') {
								const errMsg = runRes?.error || `Run tickets failed for target '${resolvedTarget}'`;
								stepDetails.error = errMsg;
								throw new Error(errMsg);
							}
							break;
						}

						case 'get_outputs': {
							const rawTarget = (field.wfTicketTarget || '').trim();
							const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
							const resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(rawTarget, contextVariables).trim();
							const targetField = (field.wfTicketField || '').trim() || undefined;
							const outMap = await this.getOutputs(wsUri, resolvedTarget, targetField);
							stepOutput = outMap;
							contextVariables[fieldLabel] = outMap;
							contextVariables[this._cleanKey(fieldLabel)] = outMap;
							customMetadata[fieldLabel] = JSON.stringify(outMap);
							stepDetails = { targetTicket: resolvedTarget, field: targetField, outputs: outMap };
							break;
						}

						case 'get_ticket': {
							const targetId = field.wfTicketId ? this._interpolateVariables(field.wfTicketId, contextVariables).trim() : '';
							const targetVar = field.wfTicketVariable ? this._interpolateVariables(field.wfTicketVariable, contextVariables).trim() : '';
							const rawTarget = (field.wfTicketTarget ? this._interpolateVariables(field.wfTicketTarget, contextVariables).trim() : '') || targetId || targetVar;
							const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
							const resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: (contextVariables[rawTarget] !== undefined ? contextVariables[rawTarget] : rawTarget);
							const fieldName = field.wfTicketField ? this._interpolateVariables(field.wfTicketField, contextVariables).trim() : undefined;
							const foundRes = await this.getTicket(wsUri, resolvedTarget, fieldName);
							stepOutput = foundRes;
							contextVariables[fieldLabel] = foundRes;
							contextVariables[this._cleanKey(fieldLabel)] = foundRes;
							if (field.outputVariableName) {
								contextVariables[field.outputVariableName] = foundRes;
							}
							customMetadata[fieldLabel] = JSON.stringify(foundRes);
							stepDetails = { target: resolvedTarget, field: fieldName, result: foundRes };
							break;
						}

						case 'get_tickets': {
							const query = this._buildGetTicketsQuery(field, contextVariables);
							const found = await this.getTickets(wsUri, query);
							stepOutput = found;
							contextVariables[fieldLabel] = found;
							contextVariables[this._cleanKey(fieldLabel)] = found;
							if (field.outputVariableName) {
								contextVariables[field.outputVariableName] = found;
							}
							customMetadata[fieldLabel] = JSON.stringify(found);
							stepDetails = { query, count: Array.isArray(found) ? found.length : 0, result: found };
							break;
						}

						case 'display': {
							const rawDisp = (field.wfDisplayValue || '').trim();
							const resolvedVal = await this._evaluateDisplayExpression(wsUri, ticketUri, rawDisp, contextVariables);
							stepOutput = resolvedVal;
							stepDetails = { displayExpr: rawDisp, value: resolvedVal };
							break;
						}

						default: {
							// 5. Standard field (text, textarea, number, select, multiselect, date, switch, classes, etc.)
							const rawVal = inputOverrides[fieldLabel] !== undefined
								? inputOverrides[fieldLabel]
								: (customMetadata[fieldLabel] !== undefined ? customMetadata[fieldLabel] : (field.defaultContent || ''));
							let resolvedVal = typeof rawVal === 'string'
								? this._interpolateVariables(rawVal, contextVariables)
								: rawVal;
							if (fieldType === 'number') {
								// Enforce the component's range / precision on the final (interpolated) value
								const numCheck = normalizeNumberFieldValue({ label: fieldLabel, min: field.min, max: field.max, precision: field.precision }, resolvedVal);
								if (!numCheck.ok) {
									throw new Error(numCheck.error);
								}
								resolvedVal = numCheck.value;
							}
							stepOutput = resolvedVal;
							contextVariables[fieldLabel] = resolvedVal;
							contextVariables[this._cleanKey(fieldLabel)] = resolvedVal;

							stepDetails = {
								fieldLabel: fieldLabel,
								type: fieldType,
								initialValue: rawVal,
								runtimeValue: resolvedVal,
								value: resolvedVal,
								options: field.options,
								defaultValue: field.defaultValue
							};
							break;
						}
					}

					if (stepOutput !== undefined) {
						const sanitizedStepOut = this.validateAndSanitizeComponentOutput(fieldType, field, stepOutput);
						stepOutput = sanitizedStepOut;
						const outVarName = (field.outputVariableName || '').trim() || generateSmartPythonVarName(fieldLabel, fieldType);
						if (outVarName && fieldType !== 'parameters' && fieldType !== 'output' && fieldType !== 'display') {
							contextVariables[outVarName] = sanitizedStepOut;
							contextVariables[this._cleanKey(outVarName)] = sanitizedStepOut;
						}
						if (field.id) {
							contextVariables[field.id] = sanitizedStepOut;
						}
						const prevLabels = getPreviousLabels(field);
						for (const pl of prevLabels) {
							if (pl && typeof pl === 'string') {
								contextVariables[pl] = sanitizedStepOut;
								contextVariables[this._cleanKey(pl)] = sanitizedStepOut;
							}
						}
					}

					const successStepRes: IPrimitiveExecutionStepResult = {
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						output: stepOutput,
						status: 'success',
						durationMs: Date.now() - stepStart,
						details: stepDetails
					};
					stepResults.push(successStepRes);
					try { options.onStepProgress?.(successStepRes, fieldIndex, totalFieldsCount); } catch { }
				} catch (stepErr) {
					if (isCancelled()) {
						throw stepErr;
					}
					this.logService.error(`[TicketWorkflowRuntime] Step '${fieldLabel}' failed:`, stepErr);
					const failedStepRes: IPrimitiveExecutionStepResult = {
						fieldId: field.id,
						fieldLabel: fieldLabel,
						fieldType: fieldType,
						status: 'failed',
						error: stepErr.message || String(stepErr),
						durationMs: Date.now() - stepStart,
						details: stepDetails
					};
					stepResults.push(failedStepRes);
					try { options.onStepProgress?.(failedStepRes, fieldIndex, totalFieldsCount); } catch { }
					// Interrupt subsequent step execution on first failure
					break;
				}
			}

			if (isCancelled()) {
				throw new Error('Ticket execution cancelled by Stop request');
			}

			const hasFailedSteps = stepResults.some(s => s.status === 'failed');
			const executionStatus: 'Completed' | 'Failed' = hasFailedSteps ? 'Failed' : 'Completed';

			// If no explicit output primitive was present, fallback to the last step's output
			if (finalOutput === undefined) {
				const lastSuccessful = [...stepResults].reverse().find(s => s.status === 'success' && s.output !== undefined);
				finalOutput = lastSuccessful ? lastSuccessful.output : (hasFailedSteps ? 'Ticket execution aborted due to step failure.' : 'Ticket completed without explicit output.');
			}

			// Save updated ticket metadata and append worklog entry
			await this._persistExecutionState(ticketUri, ticketResult, customMetadata, finalOutput, executionStatus);

			const totalDuration = Date.now() - startTime;
			this.logService.info(`[TicketWorkflowRuntime] Finished running ticket '${ticketResult.ticketId}' in ${totalDuration}ms (status: ${executionStatus})`);

			const outField = schema?.fields?.find(f => f.type === 'output');
			if (hasFailedSteps) {
				const failedStep = stepResults.find(s => s.status === 'failed');
				const failureError = failedStep?.error || `Step '${failedStep?.fieldLabel || 'Unknown'}' failed`;
				return {
					success: false,
					ticketId: ticketResult.ticketId,
					ticketName: ticketResult.ticketName,
					title: ticketResult.title,
					ticketType: ticketResult.ticketType,
					entityUri: ticketResult.entityUri,
					status: 'failed',
					output: finalOutput,
					outputSpecs: outField?.outputSpecs || [],
					stepResults: stepResults,
					contextVariables: contextVariables,
					durationMs: totalDuration,
					error: failureError
				};
			}

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
		} catch (err) {
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

	private _parseInputStringLiteral(val: unknown): unknown {
		if (typeof val !== 'string') {
			return val;
		}
		const trimmed = val.trim();
		if (!trimmed) {
			return val;
		}
		// 1. Explicit quoted string literal (Python-style "..." or '...') -> always keep as string (e.g. '2' or "2" -> "2")
		if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === 'string') {
					return parsed;
				}
			} catch {
				// Keep original if not a valid single quoted string literal
			}
		}
		if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
			const inner = trimmed.slice(1, -1);
			if (!/(^|[^\\])'/.test(inner)) {
				return inner.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');
			}
		}
		// 2. Unquoted numeric literal (int / float) -> number (e.g. 2 -> 2, 3.14 -> 3.14)
		if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
			const num = Number(trimmed);
			if (Number.isFinite(num)) {
				return num;
			}
		}
		// 3. Unquoted boolean / None literals
		if (trimmed === 'true' || trimmed === 'True') {
			return true;
		}
		if (trimmed === 'false' || trimmed === 'False') {
			return false;
		}
		if (trimmed === 'null' || trimmed === 'None') {
			return null;
		}
		// 4. Unquoted JSON list / dict literals
		if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return val;
			}
		}
		return val;
	}

	async executeNodeComponent(
		workspaceUri: string | URI,
		workingDirUri: string | URI,
		field: IRuntimeCustomField,
		contextVariables: Record<string, unknown>
	): Promise<IPrimitiveExecutionStepResult> {
		const stepStart = Date.now();
		const executedAt = new Date().toLocaleTimeString();
		const wsUri = typeof workspaceUri === 'string' ? URI.parse(workspaceUri) : workspaceUri;
		const workUri = typeof workingDirUri === 'string' ? URI.parse(workingDirUri) : workingDirUri;
		const fieldLabel = (field.label || field.id || field.type || 'Component').trim();
		const fieldType = field.type;
		let stepOutput: unknown = undefined;
		let stepDetails: Record<string, unknown> | undefined = undefined;

		const describeRuntimeValue = (val: unknown): { typeTag: string; preview: string } => {
			if (val === null || val === undefined) {
				return { typeTag: 'None', preview: 'None' };
			}
			if (Array.isArray(val)) {
				const jsonStr = JSON.stringify(val, null, 2);
				return {
					typeTag: `list (${val.length} item${val.length === 1 ? '' : 's'})`,
					preview: jsonStr
				};
			}
			if (typeof val === 'object') {
				const keys = Object.keys(val);
				const jsonStr = JSON.stringify(val, null, 2);
				return {
					typeTag: `dict (${keys.length} key${keys.length === 1 ? '' : 's'})`,
					preview: jsonStr
				};
			}
			const strVal = String(val);
			return {
				typeTag: `${typeof val}${typeof val === 'string' ? ` (${strVal.length} chars)` : ''}`,
				preview: strVal
			};
		};

		if (field.disabled) {
			const durationMs = Date.now() - stepStart;
			const skipMsg = `>>> Component [${fieldType}] "${fieldLabel}" is DISABLED (skipped execution).`;
			field.lastExecutionStatus = 'skipped';
			field.lastExecutionLog = skipMsg;
			this.logService.info(`[TicketWorkflowRuntime] Node Component '${fieldLabel}' is disabled, skipping execution.`);
			return {
				fieldId: field.id,
				fieldLabel,
				fieldType,
				output: undefined,
				status: 'success',
				durationMs,
				details: { skipped: true, disabled: true, message: skipMsg }
			};
		}

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
					const resolvedParams: Record<string, unknown> = {};
					const traceLines: string[] = [
						`>>> Executing Component [INPUTS]: "${fieldLabel}"`,
						`Timestamp: ${executedAt}`
					];
					if (Array.isArray(field.parameters)) {
						const callerKeys: string[] = Array.isArray(contextVariables['__callerInputKeys__']) ? contextVariables['__callerInputKeys__'] : [];
						for (const p of field.parameters) {
							const pKey = (p.name || p.id || '').trim();
							if (!pKey) { continue; }
							const rawDef = p.defaultValue ?? '';
							const singleVar = typeof rawDef === 'string' ? rawDef.trim().match(/^\{([^{}]+)\}$/) : null;
							const isNonEmpty = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'string' || v.trim() !== '');
							const isCallerOverride = callerKeys.includes(pKey) && isNonEmpty(contextVariables[pKey]);
							let val: unknown;
							let sourceNote = '';
							if (isCallerOverride) {
								// Explicitly passed by Sub-Workflow caller: takes priority over default value
								val = contextVariables[pKey];
								sourceNote = '(from caller)';
							} else if (singleVar && contextVariables[singleVar[1].trim()] !== undefined) {
								val = contextVariables[singleVar[1].trim()];
								sourceNote = `(from ${rawDef})`;
							} else if (typeof rawDef === 'string' && rawDef.includes('{')) {
								val = this._parseInputStringLiteral(this._interpolateVariables(rawDef, contextVariables));
								sourceNote = `(from ${rawDef})`;
							} else if (isNonEmpty(rawDef)) {
								val = this._parseInputStringLiteral(rawDef);
								sourceNote = '(default)';
							} else if (isNonEmpty(contextVariables[pKey])) {
								val = contextVariables[pKey];
								sourceNote = '(from context)';
							} else if (contextVariables[pKey] !== undefined) {
								val = contextVariables[pKey];
								sourceNote = '(from context)';
							} else {
								val = undefined;
								sourceNote = '(required — no default)';
							}
							if (val !== undefined) {
								resolvedParams[pKey] = val;
								contextVariables[pKey] = val;
								const desc = describeRuntimeValue(val);
								traceLines.push(`\n• ${pKey} = ${desc.preview}  ${sourceNote}  [Type: ${desc.typeTag}]`);
							} else {
								traceLines.push(`\n• ${pKey}  ${sourceNote}`);
							}
						}
					}
					stepOutput = resolvedParams;
					contextVariables['Parameters'] = { ...(contextVariables['Parameters'] || {}), ...resolvedParams };
					contextVariables['Inputs'] = { ...(contextVariables['Inputs'] || {}), ...resolvedParams };
					contextVariables[fieldLabel] = resolvedParams;
					contextVariables[this._cleanKey(fieldLabel)] = resolvedParams;
					stepDetails = { parameters: resolvedParams };
					field.lastExecutionLog = traceLines.join('\n');
					field.lastExecutionOutput = resolvedParams;
					break;
				}
				case 'prompt': {
					const preInjected = (field.defaultContent || '').trim();
					const userPromptList = Array.isArray(field.defaultUserPrompts) && field.defaultUserPrompts.length > 0
						? field.defaultUserPrompts.map((s: string) => (s || '').trim()).filter(Boolean)
						: ((field.defaultUserPrompt || '').trim() ? [(field.defaultUserPrompt || '').trim()] : []);
					const userPrompt = userPromptList.join('\n\n');
					const rawPrompt = (preInjected && userPrompt)
						? `${preInjected}\n\n--- [USER PROMPT / INSTRUCTIONS] ---\n${userPrompt}`
						: (preInjected || userPrompt);
					const interpolatedPrompt = this._interpolateVariables(rawPrompt, contextVariables);
					const promptModel = field.targetModel || resolveDefaultModelId(field.targetProvider, 'gemini-2.5-flash');
					const promptProvider = field.targetProvider || (field.targetModel ? undefined : getGlobalDefaultModel()?.providerId);
					let rawAiResp = '';
					const directTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, undefined, false);
					if (directTableJson !== undefined) {
						rawAiResp = directTableJson;
					} else {
						this._assertPromptVariablesResolved(fieldLabel, rawPrompt, interpolatedPrompt);
						rawAiResp = await this._executePrompt(promptModel, interpolatedPrompt, promptProvider);
						if (!rawAiResp || /"error"\s*:\s*"[^"]*(?:rows|records|preview|omitted|batches)/i.test(rawAiResp) || rawAiResp.startsWith('[AI ')) {
							const fallbackTableJson = this._tryExtractJsonRecordsFromTablePrompt(rawPrompt, contextVariables, undefined, true);
							if (fallbackTableJson !== undefined) {
								rawAiResp = fallbackTableJson;
							}
						}
					}
					let parsedOutput: unknown = rawAiResp;
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
					const cappedResp = formattedResp.length > 3000 ? formattedResp.substring(0, 3000) + ' ... [truncated]' : formattedResp;
					field.debugPromptOutput = cappedResp;
					delete field.lastSentPrompt;
					field.lastExecutionLog = cappedResp;
					field.lastExecutionOutput = stepOutput;
					stepDetails = { model: promptModel, provider: promptProvider, prompt: (interpolatedPrompt.length > 3000 ? interpolatedPrompt.substring(0, 3000) + ' ... [truncated]' : interpolatedPrompt), response: stepOutput };
					if (typeof rawAiResp === 'string' && (rawAiResp.startsWith('[AI Execution Error') || rawAiResp.startsWith('[AI Service Error'))) {
						stepDetails.error = rawAiResp;
						throw new Error(rawAiResp);
					}
					break;
				}
				case 'python': {
					const rawCode = field.pythonCode || field.defaultValue || field.defaultContent || '';
					const interpolatedCode = this._interpolateVariables(rawCode, contextVariables);
					const pyRes = await this.executePythonScript(wsUri, workUri, field.pythonPath || '', interpolatedCode, contextVariables, field.externalScripts);
					const cappedPyOutput = (pyRes.output || '').length > 3000 ? (pyRes.output || '').substring(0, 3000) + ' ... [truncated]' : (pyRes.output || '(Script pipeline completed with no stdout/stderr output)');
					field.pythonOutput = cappedPyOutput;
					field.lastExecutionLog = cappedPyOutput;
					stepDetails = {
						exitCode: pyRes.exitCode,
						output: pyRes.output,
						result: pyRes.result,
						runDir: pyRes.runDir,
						durationMs: pyRes.durationMs
					};
					if (pyRes.exitCode !== 0 || !pyRes.success) {
						const errDetail = pyRes.error || (pyRes.output ? pyRes.output.trim() : `Python script exited with code ${pyRes.exitCode}`);
						stepDetails.error = errDetail;
						throw new Error(errDetail);
					}
					stepOutput = pyRes.result !== undefined ? pyRes.result : pyRes.output;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					field.pythonResult = pyRes.result;
					field.lastExecutionOutput = stepOutput;
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
					if (sqlRes.isSelectQuery && Array.isArray(sqlRes.queryRows)) {
						field.lastQueryRows = sqlRes.queryRows;
					}
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
					field.lastExecutionLog = field.debugSqlOutput;
					field.lastExecutionOutput = stepOutput;
					const nodeTablePayload = {
						columns: field.tableColumns || [],
						rows: Array.isArray(stepOutput) ? stepOutput : (field.tableRows || []),
						dbEngine: field.tableDbEngine || 'sqlite',
						dbPath,
						tableName: tblName,
						sqlQuery,
						sqlOutput: field.debugSqlOutput,
						output: (Array.isArray(stepOutput) && stepOutput.length > 0) ? JSON.stringify(stepOutput) : (field.debugSqlOutput || JSON.stringify(stepOutput))
					};
					contextVariables[fieldLabel] = nodeTablePayload;
					contextVariables[this._cleanKey(fieldLabel)] = nodeTablePayload;
					contextVariables[`${fieldLabel}.output`] = field.debugSqlOutput || stepOutput;
					contextVariables[`${fieldLabel}.sqlOutput`] = field.debugSqlOutput;
					contextVariables[`${fieldLabel}.rows`] = stepOutput;
					contextVariables[`${fieldLabel}.json`] = JSON.stringify(stepOutput);
					contextVariables[`${this._cleanKey(fieldLabel)}_output`] = field.debugSqlOutput;
					contextVariables[`${this._cleanKey(fieldLabel)}_rows`] = stepOutput;
					contextVariables[`${this._cleanKey(fieldLabel)}_payload`] = nodeTablePayload;
					stepDetails = { dbPath, tableName: tblName, sqlQuery, rowCount: Array.isArray(stepOutput) ? stepOutput.length : 0 };
					if (!sqlRes.success) {
						field.lastExecutionStatus = 'failed';
						field.lastExecutionDurationMs = Date.now() - stepStart;
						field.lastExecutedAt = executedAt;
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
					if (interpolatedUrl) {
						field.lastResolvedUrl = interpolatedUrl;
						field.lastExecutedUrl = interpolatedUrl;
						field.lastExecutedAt = executedAt;
					}
					const maxRetries = (typeof field.browserMaxRetries === 'number' && Number.isFinite(field.browserMaxRetries))
						? Math.max(0, Math.min(10, Math.floor(field.browserMaxRetries)))
						: 3;
					const retryDelayMs = (typeof field.browserRetryDelayMs === 'number' && Number.isFinite(field.browserRetryDelayMs))
						? Math.max(0, Math.min(60000, Math.floor(field.browserRetryDelayMs)))
						: 1000;
					const extracted = interpolatedUrl
						? await this._extractWebContentWithRetry(interpolatedUrl, field.credentials, {
							maxRetries,
							retryDelayMs,
							label: fieldLabel,
							onRetryLog: (msg) => this.logService.warn(`[TicketWorkflowRuntime] ${msg}`),
							checkCancelled: ensureNotCancelled
						})
						: { title: '', content: '', attempts: 0, retryLogs: [] as string[], lastError: 'Invalid or empty URL' };
					const extractedText = extracted.content || '';
					stepOutput = extractedText;
					stepDetails = {
						rawUrl: field.defaultUrl,
						url: interpolatedUrl,
						resolvedUrl: interpolatedUrl,
						contentLength: extractedText.length,
						attempts: extracted.attempts,
						retryLogs: extracted.retryLogs
					};
					if (extracted.lastError || (typeof extractedText === 'string' && (extractedText.startsWith('[Fetch Failed') || extractedText.startsWith('HTTP Error')))) {
						const errMsg = extracted.lastError || extractedText;
						field.lastExecutionStatus = 'failed';
						field.lastExecutionLog = [
							`>>> Browser Fetch Failed: ${interpolatedUrl || '(empty)'}`,
							...extracted.retryLogs,
							`Final Error: ${errMsg}`
						].join('\n');
						throw new Error(errMsg);
					}
					field.lastExecutionStatus = 'success';
					const previewText = extractedText.length > 2000 ? extractedText.substring(0, 2000) + '\n... [truncated]' : extractedText;
					const retryHeader = extracted.retryLogs.length > 0 ? `${extracted.retryLogs.join('\n')}\n` : '';
					field.lastExecutionLog = `>>> Visited Target URL: ${interpolatedUrl || '(empty)'}\n${retryHeader}Extracted Length: ${extractedText.length} chars\n\n${previewText}`;
					field.lastExecutionOutput = extractedText;
					contextVariables[fieldLabel] = extractedText;
					contextVariables[this._cleanKey(fieldLabel)] = extractedText;
					contextVariables[`${fieldLabel}_url`] = interpolatedUrl;
					contextVariables[`${this._cleanKey(fieldLabel)}_url`] = interpolatedUrl;
					contextVariables[`${fieldLabel}_resolved_url`] = interpolatedUrl;
					contextVariables[`${this._cleanKey(fieldLabel)}_resolved_url`] = interpolatedUrl;
					break;
				}
				case 'tts': {
					// Text-to-speech inside a workflow node: synthesize the (interpolated) text and save the audio under
					// <workflow>/attachments/. Reuses the previous file when the text and voice settings are unchanged.
					const ttsProvider = field.targetProvider || 'gemini';
					const ttsModel = field.targetModel || (ttsProvider === 'openai' ? 'tts-1' : 'gemini-2.5-flash-preview-tts');
					const ttsFormat = (field.ttsFormat || 'mp3').toLowerCase();
					const ttsVoice = field.ttsVoice || (ttsProvider === 'openai' ? 'alloy' : 'Kore');
					const sourceText = (field.defaultContent || '').trim() ? (field.defaultContent || '') : (field.ttsDisplayText || '');
					const ttsText = this._interpolateVariables(sourceText, contextVariables).trim();
					if (!ttsText) {
						throw new Error(`Text to Speech '${fieldLabel}': the text is empty.`);
					}
					const cacheKey = JSON.stringify([ttsText, ttsProvider, ttsModel, ttsVoice, ttsFormat]);
					const prevPath: string = field.ttsLastAudioPath || '';
					let audioPath = '';
					let cached = false;
					if (prevPath && field.ttsLastCacheKey === cacheKey && await this.fileService.exists(URI.file(prevPath))) {
						audioPath = prevPath;
						cached = true;
					} else {
						const credService = this.instantiationService.invokeFunction(accessor => {
							try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
						});
						if (!credService?.synthesizeSpeech) {
							throw new Error(`Text to Speech '${fieldLabel}': credential service unavailable.`);
						}
						const ttsRes = await credService.synthesizeSpeech({
							text: ttsText,
							modelId: ttsModel,
							credentialId: field.targetCredentialId || undefined,
							providerId: ttsProvider,
							format: ttsFormat,
							voice: ttsVoice
						});
						if (!ttsRes.success || !ttsRes.audioBuffer) {
							throw new Error(`Text to Speech '${fieldLabel}' failed: ${ttsRes.error || 'synthesis failed'}`);
						}
						const attachDir = URI.joinPath(workUri, 'attachments');
						if (!(await this.fileService.exists(attachDir))) {
							await this.fileService.createFolder(attachDir);
						}
						const audioUri = URI.joinPath(attachDir, `tts_${this._cleanKey(fieldLabel) || 'audio'}_${Date.now()}.${ttsFormat}`);
						await this.fileService.writeFile(audioUri, VSBuffer.wrap(ttsRes.audioBuffer));
						audioPath = audioUri.fsPath;
						field.ttsLastAudioPath = audioPath;
						field.ttsLastCacheKey = cacheKey;
					}
					field.ttsAudioFile = audioPath;
					stepOutput = audioPath;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					if (field.outputVariableName) {
						contextVariables[field.outputVariableName] = stepOutput;
					}
					stepDetails = { text: ttsText, provider: ttsProvider, model: ttsModel, voice: ttsVoice, format: ttsFormat, audioFile: audioPath, cached };
					field.lastExecutionLog = `>>> TEXT TO SPEECH (${ttsProvider}/${ttsModel}, voice ${ttsVoice})${cached ? ' [reused cached audio]' : ''}\n${audioPath}`;
					field.lastExecutionOutput = stepOutput;
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
					field.lastExecutionLog = `>>> MP3 / MP4 Player [${detected.kind.toUpperCase()}]: ${resolvedName || '(no file selected)'}\nPath: ${interpolatedPath || '(none)'}\nFormat: ${detected.ext.toUpperCase()} (${detected.mimeType})\nPlayback Speed: ${rate}x`;
					field.lastExecutionOutput = stepOutput;
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
				case 'voice_note': {
					if (!field.voiceRunInFlow) {
						// Voice Note is commentary-only by default — no-op on execution
						stepOutput = '';
						stepDetails = { skipped: true, reason: 'voice_note_commentary_only' };
						break;
					}
					const clips = Array.isArray(field.voiceClips) ? field.voiceClips.filter(c => !!c?.audioDataUrl) : [];
					const rate = typeof field.voicePlaybackRate === 'number' && Number.isFinite(field.voicePlaybackRate) ? field.voicePlaybackRate : 1.0;
					const playedCount = await this._playVoiceNoteClipsSequentially(clips, rate);
					const transcript = (field.voiceTranscript || clips.map(c => (c.transcript || '').trim()).filter(Boolean).join('\n\n')).trim();
					stepOutput = transcript;
					field.lastExecutionLog = `>>> Voice Note Playback: played ${playedCount}/${clips.length} clip(s) at ${rate}x\n${transcript || '(no transcript text)'}`;
					field.lastExecutionOutput = stepOutput;
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = {
						clipCount: clips.length,
						playedCount,
						playbackRate: rate,
						transcript
					};
					break;
				}
				case 'ssh': {
					const rawCommandsList = normalizeSshCommandsList(field.sshCommands, field.sshCommand || field.defaultContent || '');
					const sshOutLines = typeof field.sshOutputLines === 'number' && field.sshOutputLines > 0 ? field.sshOutputLines : 50;

					const batchRes = await this.executeSshBatchCommands({
						workspaceUri: wsUri,
						host: field.sshHost || '',
						port: field.sshPort || 22,
						user: field.sshUser || 'root',
						password: field.sshPassword || '',
						cwd: field.sshCwd || '',
						commands: rawCommandsList,
						outputLines: sshOutLines,
						existingTerminalLog: field.sshOutput || '',
						contextVariables
					});

					field.sshOutput = batchRes.terminalTranscript;
					field.sshLastRawEntries = batchRes.rawEntries;
					field.sshLastRawOutput = batchRes.rawEntries.length > 0 ? batchRes.rawEntries[batchRes.rawEntries.length - 1].rawOutput : '';
					field.sshLastOutput = batchRes.jsonOutput;
					if (batchRes.cwd) {
						field.sshCwd = batchRes.cwd;
					}

					if (!batchRes.success) {
						const connErrMsg = batchRes.error || `SSH Connection Failed (${batchRes.user}@${batchRes.host}:${batchRes.port})`;
						field.lastExecutionLog = `>>> SSH [${batchRes.user}@${batchRes.host || '(no host)'}:${batchRes.port}] Connection Error:\n${connErrMsg}`;
						field.lastExecutionOutput = batchRes.jsonOutput;
						field.lastExecutionExitCode = batchRes.exitCode;
						field.lastExecutionStatus = 'failed';
						field.lastExecutionDurationMs = batchRes.durationMs || (Date.now() - stepStart);
						field.lastExecutedAt = executedAt;
						return {
							fieldId: field.id,
							fieldLabel,
							fieldType,
							output: batchRes.jsonOutput,
							status: 'failed',
							error: connErrMsg,
							durationMs: batchRes.durationMs || (Date.now() - stepStart),
							details: {
								host: batchRes.host,
								port: batchRes.port,
								user: batchRes.user,
								cwd: batchRes.cwd,
								commands: batchRes.resolvedCommands,
								failedCommandIndex: batchRes.failedCommandIndex,
								failedCommand: batchRes.failedCommand,
								outputLines: sshOutLines,
								output: batchRes.jsonOutput,
								exitCode: batchRes.exitCode,
								durationMs: batchRes.durationMs,
								error: connErrMsg
							}
						};
					}

					stepOutput = batchRes.jsonOutput;
					field.lastExecutionLog = `>>> SSH [${batchRes.user}@${batchRes.host}:${batchRes.port}] (${batchRes.cwd || '~'}) [${batchRes.resolvedCommands.length} command(s), Output: Last ${sshOutLines} lines/cmd]\n${stepOutput}`;
					field.lastExecutionOutput = stepOutput;
					field.lastExecutionExitCode = batchRes.exitCode;
					field.lastExecutionStatus = 'success';
					field.lastExecutionDurationMs = batchRes.durationMs || (Date.now() - stepStart);
					field.lastExecutedAt = executedAt;
					stepDetails = {
						host: batchRes.host,
						port: batchRes.port,
						user: batchRes.user,
						cwd: batchRes.cwd,
						commands: batchRes.resolvedCommands,
						outputLines: sshOutLines,
						output: stepOutput,
						exitCode: batchRes.exitCode,
						durationMs: batchRes.durationMs
					};
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					break;
				}
				case 'http_request': {
					const httpRes = await this.executeHttpRequest(field, contextVariables);
					field.httpResponseStatus = httpRes.status;
					field.httpResponseStatusText = httpRes.statusText;
					field.httpResponseHeaders = httpRes.headers;
					field.httpResponseBody = httpRes.rawText;
					field.httpResponseData = httpRes.data;
					field.defaultContent = typeof httpRes.data === 'object' ? JSON.stringify(httpRes.data, null, 2) : (httpRes.rawText || '');
					field.httpLastExecutionTime = executedAt;
					field.httpLastDurationMs = httpRes.durationMs;

					// Pure business output: ONLY the response payload, NEVER transport/HTTP metadata!
					const cleanHttpData = (httpRes.data !== undefined && httpRes.data !== null)
						? httpRes.data
						: (httpRes.body !== undefined && httpRes.body !== null ? httpRes.body : (httpRes.rawText || ''));
					stepOutput = cleanHttpData;

					// Register convenience sub-variables into context
					contextVariables[`${fieldLabel}_status`] = httpRes.status;
					contextVariables[`${this._cleanKey(fieldLabel)}_status`] = httpRes.status;
					contextVariables[`${fieldLabel}_ok`] = httpRes.ok;
					contextVariables[`${this._cleanKey(fieldLabel)}_ok`] = httpRes.ok;
					if (httpRes.data !== null && httpRes.data !== undefined) {
						contextVariables[`${fieldLabel}_data`] = httpRes.data;
						contextVariables[`${this._cleanKey(fieldLabel)}_data`] = httpRes.data;
					}
					contextVariables[`${fieldLabel}_body`] = httpRes.body;
					contextVariables[`${this._cleanKey(fieldLabel)}_body`] = httpRes.body;
					contextVariables[`${fieldLabel}_raw`] = httpRes.rawText;
					contextVariables[`${this._cleanKey(fieldLabel)}_raw`] = httpRes.rawText;

					contextVariables[fieldLabel] = cleanHttpData;
					contextVariables[this._cleanKey(fieldLabel)] = cleanHttpData;
					if (field.outputVariableName) {
						contextVariables[field.outputVariableName] = cleanHttpData;
						contextVariables[this._cleanKey(field.outputVariableName)] = cleanHttpData;
					}
					if (field.id) {
						contextVariables[field.id] = cleanHttpData;
					}

					field.lastExecutionLog = `>>> HTTP Request [${httpRes.method} ${httpRes.url}]\nStatus: ${httpRes.status} ${httpRes.statusText} (${httpRes.durationMs}ms)\n${httpRes.error ? `Error: ${httpRes.error}\n` : ''}Response Body Preview:\n${httpRes.rawText ? (httpRes.rawText.length > 2000 ? httpRes.rawText.substring(0, 2000) + '... [truncated]' : httpRes.rawText) : '(empty response)'}`;
					field.lastExecutionOutput = cleanHttpData;

					stepDetails = {
						method: httpRes.method,
						url: httpRes.url,
						status: httpRes.status,
						statusText: httpRes.statusText,
						ok: httpRes.ok,
						durationMs: httpRes.durationMs,
						headers: httpRes.headers,
						error: httpRes.error
					};

					if (!httpRes.ok) {
						const errMsg = httpRes.error || `HTTP Request failed with status ${httpRes.status} (${httpRes.statusText || 'Error'})`;
						stepDetails.error = errMsg;
						throw new Error(errMsg);
					}
					break;
				}
				case 'create_tickets': {
					const tType = this._interpolateVariables(field.wfTicketType || 'Task', contextVariables).trim();
					const tTitle = this._interpolateVariables(field.wfTicketTitle || `Ticket ${fieldLabel}`, contextVariables).trim();
					const tPath = this._interpolateVariables(field.wfTicketPath || '.', contextVariables).trim();
					const resolvedParams: Record<string, unknown> = {};
					if (isWorkflowRecord(field.wfTicketParams)) {
						for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
							if (pv === undefined || pv === '') { continue; }
							const singleVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
							resolvedParams[pk] = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
								? contextVariables[singleVar[1].trim()]
								: this._interpolateVariables(String(pv), contextVariables);
						}
					}
					const createdTicketRes = await this.createTicket({
						workspaceUri: wsUri,
						targetPath: tPath,
						ticketType: tType,
						title: tTitle,
						parameters: resolvedParams
					});
					stepOutput = createdTicketRes;
					contextVariables[fieldLabel] = createdTicketRes;
					contextVariables[this._cleanKey(fieldLabel)] = createdTicketRes;
					stepDetails = { ticketType: tType, title: tTitle, path: tPath, parameters: resolvedParams, createdTicket: createdTicketRes };
					field.lastExecutionLog = `>>> CREATE_TICKETS -> ${fieldLabel}\nTicket Type: ${tType}\nTitle: ${tTitle}\nResult:\n${JSON.stringify(createdTicketRes, null, 2)}`;
					field.lastExecutionOutput = createdTicketRes;
					if (!createdTicketRes || !createdTicketRes.success) {
						const errMsg = createdTicketRes?.error || `Failed to create ticket '${tTitle}'`;
						stepDetails.error = errMsg;
						throw new Error(errMsg);
					}
					break;
				}
				case 'run_tickets': {
					const rawTarget = (field.wfTicketTarget || '').trim();
					const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
					let resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: this._interpolateVariables(rawTarget, contextVariables).trim();
					if (isWorkflowRecord(resolvedTarget)) {
						resolvedTarget = resolvedTarget.ticketId || resolvedTarget.entityUri || resolvedTarget.ticketName || '';
					}
					const resolvedParams: Record<string, unknown> = {};
					if (isWorkflowRecord(field.wfTicketParams)) {
						for (const [pk, pv] of Object.entries(field.wfTicketParams)) {
							if (pv === undefined || pv === '') { continue; }
							const pVar = String(pv).trim().match(/^\{([^{}]+)\}$/);
							resolvedParams[pk] = (pVar && contextVariables[pVar[1].trim()] !== undefined)
								? contextVariables[pVar[1].trim()]
								: this._interpolateVariables(String(pv), contextVariables);
						}
					}
					const runTicketRes = await this.runTicket({
						workspaceUri: wsUri,
						ticketIdOrPath: String(resolvedTarget || ''),
						inputParams: resolvedParams
					});
					stepOutput = runTicketRes;
					contextVariables[fieldLabel] = runTicketRes;
					contextVariables[this._cleanKey(fieldLabel)] = runTicketRes;
					stepDetails = { targetTicket: resolvedTarget, parameters: resolvedParams, result: runTicketRes };
					field.lastExecutionLog = `>>> RUN_TICKETS (${resolvedTarget})\nResult:\n${JSON.stringify(runTicketRes, null, 2)}`;
					field.lastExecutionOutput = runTicketRes;
					if (!runTicketRes || !runTicketRes.success || runTicketRes.status === 'failed') {
						const errMsg = runTicketRes?.error || `Run tickets failed for target '${resolvedTarget}'`;
						stepDetails.error = errMsg;
						throw new Error(errMsg);
					}
					break;
				}
				case 'get_outputs': {
					const rawTarget = (field.wfTicketTarget || '').trim();
					const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
					const resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: this._interpolateVariables(rawTarget, contextVariables).trim();
					const targetField = (field.wfTicketField || '').trim() || undefined;
					stepOutput = await this.getOutputs(wsUri, resolvedTarget, targetField);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { targetTicket: resolvedTarget, field: targetField, outputs: stepOutput };
					field.lastExecutionLog = `>>> GET_OUTPUTS (${typeof resolvedTarget === 'object' ? JSON.stringify(resolvedTarget) : resolvedTarget}${targetField ? `, field="${targetField}"` : ''}) -> ${fieldLabel}\n${JSON.stringify(stepOutput, null, 2)}`;
					field.lastExecutionOutput = stepOutput;
					break;
				}
				case 'get_ticket': {
					const targetId = field.wfTicketId ? this._interpolateVariables(field.wfTicketId, contextVariables).trim() : '';
					const targetVar = field.wfTicketVariable ? this._interpolateVariables(field.wfTicketVariable, contextVariables).trim() : '';
					const rawTarget = (field.wfTicketTarget ? this._interpolateVariables(field.wfTicketTarget, contextVariables).trim() : '') || targetId || targetVar;
					const singleVar = rawTarget.match(/^\{([^{}]+)\}$/);
					const resolvedTarget: unknown = (singleVar && contextVariables[singleVar[1].trim()] !== undefined)
						? contextVariables[singleVar[1].trim()]
						: (contextVariables[rawTarget] !== undefined ? contextVariables[rawTarget] : rawTarget);
					const fieldName = field.wfTicketField ? this._interpolateVariables(field.wfTicketField, contextVariables).trim() : undefined;
					stepOutput = await this.getTicket(wsUri, resolvedTarget, fieldName);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					if (field.outputVariableName) {
						contextVariables[field.outputVariableName] = stepOutput;
					}
					stepDetails = { target: resolvedTarget, field: fieldName, result: stepOutput };
					field.lastExecutionLog = `>>> get_ticket(${JSON.stringify(resolvedTarget)}${fieldName ? `, field="${fieldName}"` : ''}) -> ${field.outputVariableName || fieldLabel}\n${JSON.stringify(stepOutput, null, 2)}`;
					field.lastExecutionOutput = stepOutput;
					break;
				}
				case 'get_tickets': {
					const query = this._buildGetTicketsQuery(field, contextVariables);
					stepOutput = await this.getTickets(wsUri, query);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					if (field.outputVariableName) {
						contextVariables[field.outputVariableName] = stepOutput;
					}
					stepDetails = { query, count: Array.isArray(stepOutput) ? stepOutput.length : 0, result: stepOutput };
					field.lastExecutionLog = `>>> GET_TICKETS(${JSON.stringify(query)}) -> ${field.outputVariableName || fieldLabel} [${Array.isArray(stepOutput) ? stepOutput.length : 0} ticket(s)]\n${JSON.stringify(stepOutput, null, 2)}`;
					field.lastExecutionOutput = stepOutput;
					break;
				}
				case 'display': {
					const rawDisp = (field.wfDisplayValue || '').trim();
					stepOutput = await this._evaluateDisplayExpression(wsUri, workUri, rawDisp, contextVariables);
					stepDetails = { displayExpr: rawDisp, value: stepOutput };
					const desc = describeRuntimeValue(stepOutput);
					field.lastExecutionLog = `>>> DISPLAY (${rawDisp}) [Type: ${desc.typeTag}]\n${desc.preview}`;
					field.lastExecutionOutput = stepOutput;
					break;
				}
				case 'output': {
					const outMap: Record<string, unknown> = {};
					const enabledSpecs = (field.outputSpecs || []).filter(s => s && s.enabled !== false);
					const traceLines: string[] = [
						`>>> Executing Component [OUTPUT]: "${fieldLabel}" (${enabledSpecs.length} exported field(s))`,
						`Timestamp: ${executedAt}`
					];
					for (const spec of enabledSpecs) {
						const k = (spec.label || spec.varName || spec.fieldKey || '').trim();
						if (!k) {
							continue;
						}
						const val = this._resolveOutputSpecValue(spec, contextVariables);
						outMap[k] = val;
						contextVariables[k] = val;
						contextVariables[this._cleanKey(k)] = val;
						if (spec.varName && spec.varName.trim()) {
							contextVariables[spec.varName.trim()] = val;
						}
						const desc = describeRuntimeValue(val);
						const varTag = spec.varName ? ` [var: ${spec.varName}]` : '';
						const srcTag = spec.sourceExpression ? ` <- ${spec.sourceExpression}` : '';
						traceLines.push(`\n• ${k}${varTag}${srcTag} [Type: ${desc.typeTag}]`);
						traceLines.push(desc.preview);
					}
					stepOutput = outMap;
					contextVariables[fieldLabel] = outMap;
					contextVariables['OUTPUT'] = outMap;
					stepDetails = { outputs: outMap };
					field.lastExecutionLog = traceLines.join('\n');
					field.lastExecutionOutput = outMap;
					break;
				}
				default: {
					const rawVal = field.defaultContent || '';
					stepOutput = this._interpolateVariables(rawVal, contextVariables);
					contextVariables[fieldLabel] = stepOutput;
					contextVariables[this._cleanKey(fieldLabel)] = stepOutput;
					stepDetails = { value: stepOutput };
					const desc = describeRuntimeValue(stepOutput);
					field.lastExecutionLog = `>>> Component [${fieldType}] "${fieldLabel}" [Type: ${desc.typeTag}]\n${desc.preview}`;
					field.lastExecutionOutput = stepOutput;
					break;
				}
			}

			if (stepOutput !== undefined) {
				const sanitizedStepOut = this.validateAndSanitizeComponentOutput(fieldType, field, stepOutput);
				stepOutput = sanitizedStepOut;
				const outVarName = (field.outputVariableName || '').trim() || generateSmartPythonVarName(fieldLabel, fieldType);
				if (outVarName && fieldType !== 'parameters' && fieldType !== 'output' && fieldType !== 'display') {
					contextVariables[outVarName] = sanitizedStepOut;
					contextVariables[this._cleanKey(outVarName)] = sanitizedStepOut;
				}
				if (field.id) {
					contextVariables[field.id] = sanitizedStepOut;
				}
				const prevLabels = getPreviousLabels(field);
				for (const pl of prevLabels) {
					if (pl && typeof pl === 'string') {
						contextVariables[pl] = sanitizedStepOut;
						contextVariables[this._cleanKey(pl)] = sanitizedStepOut;
					}
				}
			}

			const durationMs = Date.now() - stepStart;
			field.lastExecutionStatus = 'success';
			field.lastExecutionDurationMs = durationMs;
			field.lastExecutedAt = executedAt;

			return {
				fieldId: field.id,
				fieldLabel,
				fieldType,
				output: stepOutput,
				status: 'success',
				durationMs,
				details: stepDetails
			};
		} catch (err) {
			const durationMs = Date.now() - stepStart;
			const errMsg = err?.message || String(err);
			field.lastExecutionStatus = 'failed';
			field.lastExecutionDurationMs = durationMs;
			field.lastExecutedAt = executedAt;
			field.lastExecutionLog = `[Execution Error]: ${errMsg}`;
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

	private _normalizeDisplayPythonExpr(rawVal: string): string {
		const trimmed = (rawVal || '').trim();
		if (!trimmed) {
			return '';
		}
		const exactVar = trimmed.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
		if (exactVar) {
			return exactVar[1];
		}
		let out = '';
		let inQuote: string | null = null;
		let i = 0;
		while (i < trimmed.length) {
			const ch = trimmed[i];
			if (inQuote) {
				out += ch;
				if (ch === '\\' && i + 1 < trimmed.length) {
					out += trimmed[i + 1];
					i += 2;
					continue;
				}
				if (ch === inQuote) {
					inQuote = null;
				}
				i++;
				continue;
			}
			if (ch === '"' || ch === '\'') {
				inQuote = ch;
				out += ch;
				i++;
				continue;
			}
			if (ch === '{') {
				const m = trimmed.slice(i).match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}/);
				if (m) {
					out += m[1];
					i += m[0].length;
					continue;
				}
			}
			out += ch;
			i++;
		}
		return out;
	}

	/**
	 * Evaluate a DISPLAY expression preserving its exact native data type (number, boolean, array, object, string, null).
	 * Never auto-wraps expressions in quotes or forces string coercion.
	 */
	private async _evaluateDisplayExpression(
		workspaceUri: URI,
		workingDirUri: URI,
		rawDisp: string,
		contextVariables: Record<string, unknown>
	): Promise<unknown> {
		const pyExpr = this._normalizeDisplayPythonExpr(rawDisp);
		if (!pyExpr) {
			return null;
		}
		// Fast path 1: exact variable name present in contextVariables (preserves exact native type)
		if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pyExpr) && Object.prototype.hasOwnProperty.call(contextVariables, pyExpr) && contextVariables[pyExpr] !== undefined) {
			return contextVariables[pyExpr];
		}
		// Fast path 2: exact Python/JSON primitive literals (number, boolean, null)
		if (pyExpr === 'None' || pyExpr === 'null') {
			return null;
		}
		if (pyExpr === 'True' || pyExpr === 'true') {
			return true;
		}
		if (pyExpr === 'False' || pyExpr === 'false') {
			return false;
		}
		if (/^-?\d+(\.\d+)?$/.test(pyExpr)) {
			return Number(pyExpr);
		}
		// Fast path 3: plain double-quoted JSON string literal (not f-string)
		if (pyExpr.startsWith('"') && pyExpr.endsWith('"') && pyExpr.length >= 2) {
			try {
				const parsed = JSON.parse(pyExpr);
				if (typeof parsed === 'string') {
					return parsed;
				}
			} catch { }
		}
		// Expression path: evaluate via Python runtime so len(...), indexing, arithmetic, f-strings, dicts, lists, etc.
		// produce their exact native data type.
		const pyCode = `OUTPUT = (${pyExpr})\n`;
		const pyRes = await this.executePythonScript(workspaceUri, workingDirUri, 'python3', pyCode, contextVariables);
		if (!pyRes.success || pyRes.exitCode !== 0) {
			const errDetail = (pyRes.error || pyRes.output || 'Failed to evaluate display expression').trim();
			throw new Error(errDetail);
		}
		return pyRes.result !== undefined ? pyRes.result : null;
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
				type: 'voice_note',
				label: 'Voice Note (Audio Recorder & Transcript)',
				icon: 'mic',
				category: 'processing',
				description: 'Records one or more voice memos via microphone with automatic Speech-to-Text transcription and editable notes. Adds a top-right speaker icon to Workflow Nodes for sequential playback.',
				executionBehavior: 'Aggregates transcripts from all recorded voice clips and exposes the text to workflow context.',
				supportedInputs: ['microphone voice recordings', 'auto-transcribed / edited text notes'],
				supportedOutputs: ['combined voice transcript text']
			},
			{
				type: 'ssh',
				label: 'SSH Terminal (Remote Linux)',
				icon: 'terminal',
				category: 'processing',
				description: 'Interactive SSH connection & terminal component with unified collapsible console, dynamic multi-command send bars, automatic workflow SSH connection, and structured JSON output.',
				executionBehavior: 'Resolves dynamic IP/Port/User/Password/CWD and multiple command bars from upstream variables, connects via SSH (terminating immediately on connection failure), executes commands sequentially, and outputs a standard JSON object mapping each command to its last N output lines.',
				supportedInputs: ['host/IP (supports {variables})', 'port', 'username', 'password', 'remote CWD', 'multiple Linux shell commands (supports {variables})'],
				supportedOutputs: ['JSON object { "command": ["line 1", ...] }', 'remote working directory', 'exit code']
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
				description: 'Records a git repository URL and branch on the ticket (reference metadata only).',
				executionBehavior: 'NOT EXECUTABLE YET: no clone / checkout / fetch is performed and no git variables are registered; at run time the component only passes its text value through.',
				supportedInputs: ['git remote URL', 'branch name'],
				supportedOutputs: ['the stored text value (no git data)']
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
				type: 'http_request',
				label: 'HTTP Request (API / REST Client)',
				icon: 'globe',
				category: 'processing',
				description: 'Calls an HTTP / REST API: GET, POST, PUT, PATCH, DELETE with query params, headers, Bearer / API-Key / Basic auth and a JSON / raw / form body.',
				executionBehavior: 'Interpolates {variables} in URL, params, headers and body, sends the request (default timeout 30s), parses a JSON response, and registers the parsed data plus <var>_status / <var>_ok in context.',
				supportedInputs: ['URL (supports {variables})', 'method', 'query params', 'headers', 'auth', 'body'],
				supportedOutputs: ['parsed response data (JSON or text)', 'HTTP status', 'ok flag', 'response headers']
			},
			{
				type: 'create_tickets',
				label: 'Create Tickets',
				icon: 'new-file',
				category: 'processing',
				description: 'Creates a new ticket from a ticket template (type), e.g. one record per training run.',
				executionBehavior: 'Config: wfTicketType* (template id), wfTicketTitle (supports {var}; default "New Ticket"), wfTicketPath (folder, default "."), wfTicketParams {inputName: value or {var}} matching the template Inputs. Returns a ticket handle {success, ticketId, ticketName, ticketType, entityUri, targetFolder, fields}. In workflow nodes it compiles to Python: v = CREATE_TICKETS(ticket_type=..., title=..., path=..., params={...}).',
				supportedInputs: ['template id', 'title', 'folder', 'template Inputs values'],
				supportedOutputs: ['ticket handle (pass it to Run Tickets / Get Outputs as {var})']
			},
			{
				type: 'run_tickets',
				label: 'Run Tickets',
				icon: 'play',
				category: 'processing',
				description: 'Runs all components of an existing ticket and returns its result.',
				executionBehavior: 'Config: wfTicketTarget* (ticket id, or {var} holding a handle from Create Tickets), wfTicketParams {inputName: value} to override the ticket Inputs. Returns {success, ticketId, status: "success" | "failed", output (the ticket Output dictionary), error, durationMs}.',
				supportedInputs: ['ticket id or handle', 'Inputs overrides'],
				supportedOutputs: ['run result with .output (the ticket Output dictionary) and .status']
			},
			{
				type: 'get_outputs',
				label: 'Get Outputs',
				icon: 'sign-out',
				category: 'data',
				description: 'Reads the Output (result dictionary) of a ticket that has already run.',
				executionBehavior: 'Config: wfTicketTarget* (ticket id or {var} handle), wfTicketField (optional: one item name). Returns the whole Output dictionary, one item, or null when the ticket template has no Output component.',
				supportedInputs: ['ticket id or handle', 'optional item name'],
				supportedOutputs: ['Output dictionary or a single item']
			},
			{
				type: 'get_ticket',
				label: 'Get Ticket',
				icon: 'info',
				category: 'data',
				description: 'Reads ONE ticket: its fields, status, and outputs.',
				executionBehavior: 'Config: wfTicketTarget* (ticket id, name, path, or {var} handle), wfTicketField (optional: return just this field). Returns the ticket object or the field value.',
				supportedInputs: ['ticket id / name / path / handle', 'optional field name'],
				supportedOutputs: ['ticket object or one field value']
			},
			{
				type: 'get_tickets',
				label: 'Get Tickets',
				icon: 'search',
				category: 'data',
				description: 'Searches SEVERAL tickets at once (AND of all filters), e.g. all "Done" tickets of a template, to loop over them.',
				executionBehavior: 'Config (all optional, give at least one): wfTicketType (template id), wfTicketStatus, wfTicketTitle (substring), wfTicketPath (folder), wfTicketField (return only this field per ticket). Returns a list of {ticketId, ticketName, ticketType, title, status, priority, entityUri, customMetadata}.',
				supportedInputs: ['template id', 'status', 'title substring', 'folder', 'optional field'],
				supportedOutputs: ['list of tickets (or of one field value per ticket)']
			},
			{
				type: 'display',
				label: 'Display',
				icon: 'eye',
				category: 'output',
				description: 'Shows an intermediate value in the Live Output panel while a workflow runs (debugging / progress). Produces no variable.',
				executionBehavior: 'Config: wfDisplayValue* (a Python expression evaluated with all current variables, e.g. train_log[-5:]).',
				supportedInputs: ['Python expression'],
				supportedOutputs: ['nothing (display only)']
			},
			{
				type: 'sub_workflow',
				label: 'Call Sub-Workflow',
				icon: 'layers',
				category: 'composite',
				description: 'Calls a reusable sub-workflow from the Sub-Workflow Library inside a node: passes inputs in, runs it, and hands its outputs to the next steps.',
				executionBehavior: 'Config: subWorkflowId* (from the Sub-Workflow Library), subWorkflowInputs {inputName: expression or {var}}. Runs the sub-workflow with those inputs; the result is the sub-workflow Output: the raw value if it has exactly one output item, otherwise a dictionary keyed by output name. Creating a new sub-workflow is a separate action (save a group of nodes to the library), not done by this component.',
				supportedInputs: ['sub-workflow id', 'input bindings'],
				supportedOutputs: ['sub-workflow outputs (single value or dictionary)'],
				usableIn: ['node']
			},
			{
				type: 'output',
				label: 'Output',
				icon: 'output',
				category: 'output',
				description: 'Defines the RESULT of a ticket, node, or workflow as a dictionary {label: value}. Each output item (outputSpecs) takes its value from a variable / expression (sourceExpression, e.g. {summary}, True, or \"Done: {count} rows\") or exports another component (fieldKey). Where the result goes: (1) in a ticket, RUN_TICKETS(...).output and GET_OUTPUTS(ticket) return it; (2) in a workflow, the Output component on the final node (the one right before End) becomes the WORKFLOW OUTPUTS, returned to the caller or to the parent workflow when used as a sub-workflow (one item -> the raw value, several -> a dict). Every ticket template and every workflow should end with an Output; include a success / status flag so callers can tell whether the run succeeded.',
				executionBehavior: 'Evaluates each enabled output item (sourceExpression or exported component), stores the dictionary on the ticket, and returns it as the run result. On the final node of a workflow it becomes WORKFLOW_OUTPUTS.',
				supportedInputs: ['output items: label + sourceExpression ({var}, literal, or template) or fieldKey (component to export)', 'display format (text / markdown / json / table)'],
				supportedOutputs: ['result dictionary {label: value}', 'WORKFLOW_OUTPUTS when on the final workflow node']
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

	async GET_TICKET(workspaceUri: string | URI, ticketIdOrPath: unknown): Promise<ITicketGetResult>;
	async GET_TICKET(workspaceUri: string | URI, ticketIdOrPath: unknown, field: string | undefined): Promise<unknown>;
	async GET_TICKET(workspaceUri: string | URI, ticketIdOrPath: unknown, field?: string): Promise<unknown> {
		return this.getTicket(workspaceUri, ticketIdOrPath, field);
	}

	async getTickets(workspaceUri: string | URI, querySpecOrTarget: unknown, field?: string): Promise<unknown> {
		if (typeof querySpecOrTarget === 'string') {
			return this.getTicket(workspaceUri, querySpecOrTarget, field);
		}
		// Non-object targets carry no query fields (their property reads were all `undefined`)
		const spec: Record<string, unknown> = isWorkflowRecord(querySpecOrTarget) ? querySpecOrTarget : {};
		const hasQueryFilters = spec.ticket_type !== undefined || spec.ticketType !== undefined ||
			spec.status !== undefined || spec.title !== undefined || spec.field !== undefined ||
			spec.path !== undefined || spec.limit !== undefined ||
			spec.wfTicketType !== undefined || spec.wfTicketStatus !== undefined || spec.wfTicketTitle !== undefined || spec.wfTicketPath !== undefined;
		if (!hasQueryFilters && (spec.ticketId || spec.ticket_id || spec.id || spec.ticketName || spec.ticket_name)) {
			return this.getTicket(workspaceUri, spec, field || spec.field as string | undefined);
		}

		const targetType = String(spec.ticket_type || spec.ticketType || spec.wfTicketType || '').trim().toLowerCase();
		const targetStatus = String(spec.status || spec.wfTicketStatus || '').trim().toLowerCase();
		const targetTitle = String(spec.title || spec.wfTicketTitle || '').trim().toLowerCase();
		const targetField = String(field || spec.field || spec.wfTicketField || '').trim();
		const rawPath = String(spec.path || spec.wfTicketPath || '').trim();
		let pathRoot: string | undefined;
		if (rawPath && rawPath !== '.') {
			const wsRoot = typeof workspaceUri === 'string' ? (workspaceUri.includes('://') ? URI.parse(workspaceUri) : URI.file(workspaceUri)) : workspaceUri;
			pathRoot = (rawPath.startsWith('/') ? URI.file(rawPath) : URI.joinPath(wsRoot, rawPath)).path.replace(/\/+$/, '');
		}
		const limitNum = Number(spec.limit);
		const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : undefined;

		const allSnapshots = this.entityPersistenceService.getAllSnapshots();
		const matchedSnapshots = allSnapshots.filter(s => {
			if (pathRoot) {
				let sPath = '';
				try { sPath = URI.parse(s.entityUri).path; } catch { sPath = String(s.entityUri || ''); }
				if (sPath !== pathRoot && !sPath.startsWith(pathRoot + '/')) { return false; }
			}
			if (targetType) {
				const sType = String(s.entityType || '').trim().toLowerCase();
				if (sType !== targetType) { return false; }
			}
			if (targetStatus) {
				const sStatus = String(s.status || '').trim().toLowerCase();
				if (sStatus !== targetStatus) { return false; }
			}
			if (targetTitle) {
				const sTitle = String(s.title || '').trim().toLowerCase();
				const sName = String(s.entityName || '').trim().toLowerCase();
				if (!sTitle.includes(targetTitle) && !sName.includes(targetTitle)) { return false; }
			}
			return true;
		});

		const results: unknown[] = [];
		for (const s of (limit ? matchedSnapshots.slice(0, limit) : matchedSnapshots)) {
			const itemCustomMetadata = s.customMetadata || {};
			const item: Record<string, unknown> = {
				success: true,
				ticketId: s.ticketId || s.entityCode || s.entityName,
				ticketName: s.entityName,
				ticketType: s.entityType,
				title: s.title || '',
				status: s.status || '',
				priority: s.priority || '',
				entityUri: s.entityUri,
				customMetadata: itemCustomMetadata
			};
			if (targetField) {
				if (hasWorkflowProperty(item, targetField)) {
					results.push(item[targetField]);
				} else if (itemCustomMetadata && hasWorkflowProperty(itemCustomMetadata, targetField)) {
					results.push(itemCustomMetadata[targetField]);
				} else {
					const lowerField = targetField.toLowerCase();
					let foundVal: unknown = undefined;
					for (const [k, v] of Object.entries(itemCustomMetadata || {})) {
						if (k.toLowerCase() === lowerField) {
							foundVal = v;
							break;
						}
					}
					results.push(foundVal);
				}
			} else {
				results.push(item);
			}
		}
		return results;
	}

	/** Builds the GET_TICKETS filter object from a `get_tickets` component, interpolating `{var}` placeholders. */
	private _buildGetTicketsQuery(field: ICustomField, contextVariables: Record<string, unknown>): Record<string, string> {
		const query: Record<string, string> = {};
		const put = (key: string, raw: string | undefined) => {
			const v = raw ? this._interpolateVariables(raw, contextVariables).trim() : '';
			if (v) { query[key] = v; }
		};
		put('ticket_type', field.wfTicketType);
		put('status', field.wfTicketStatus);
		put('title', field.wfTicketTitle);
		put('path', field.wfTicketPath);
		put('field', field.wfTicketField);
		return query;
	}

	async GET_TICKETS(workspaceUri: string | URI, querySpecOrTarget: unknown, field?: string): Promise<unknown> {
		return this.getTickets(workspaceUri, querySpecOrTarget, field);
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

	private _findMatchingCustomModule(modules: ICustomModule[], typeStr: string): ICustomModule | undefined {
		const raw = (typeStr || '').trim();
		if (!raw || !Array.isArray(modules) || modules.length === 0) {
			return undefined;
		}
		const lower = raw.toLowerCase();
		const exact = modules.find(m =>
			(m.id || '').toLowerCase() === lower ||
			(m.name || '').toLowerCase() === lower
		);
		if (exact) {
			return exact;
		}
		const norm = lower.replace(/[-_\s]+/g, '_');
		return modules.find(m =>
			(m.id || '').trim().toLowerCase().replace(/[-_\s]+/g, '_') === norm ||
			(m.name || '').trim().toLowerCase().replace(/[-_\s]+/g, '_') === norm
		);
	}

	private _formatTablePayloadAsMarkdown(columns: ITableColumnDefinition[] | undefined, rows: Record<string, unknown>[]): string {
		const colNames = (Array.isArray(columns) && columns.length > 0)
			? columns.map(c => c.name || c.id)
			: (rows.length > 0 && isWorkflowRecord(rows[0]) ? Object.keys(rows[0]) : []);
		if (colNames.length === 0) {
			return JSON.stringify(rows, null, 2);
		}
		const headerLine = `| ${colNames.join(' | ')} |`;
		const dividerLine = `| ${colNames.map(() => '---').join(' | ')} |`;
		const bodyLines = rows.map(row => {
			const cells = colNames.map(col => {
				const val = isWorkflowRecord(row) ? row[col] : '';
				return val === undefined || val === null ? '' : String(val).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
			});
			return `| ${cells.join(' | ')} |`;
		});
		return [headerLine, dividerLine, ...bodyLines].join('\n');
	}

	private _getCleanPrimitiveContent(rawVal: unknown): string {
		if (rawVal === undefined || rawVal === null) { return ''; }
		if (typeof rawVal === 'boolean' || typeof rawVal === 'number') { return String(rawVal); }
		if (Array.isArray(rawVal)) {
			if (rawVal.length > 0) {
				return JSON.stringify(rawVal, null, 2);
			}
			const arraySqlOutput: unknown = Reflect.get(rawVal, 'sqlOutput');
			if (arraySqlOutput && typeof arraySqlOutput === 'string' && arraySqlOutput.trim() !== '') {
				return arraySqlOutput.trim();
			}
			return JSON.stringify(rawVal, null, 2);
		}
		if (typeof rawVal === 'string') {
			const trimmed = rawVal.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					if (Array.isArray(parsed.rows) || typeof parsed.sqlOutput === 'string') {
						if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
							return JSON.stringify(parsed.rows, null, 2);
						}
						if (typeof parsed.sqlOutput === 'string' && parsed.sqlOutput.trim() !== '') {
							return parsed.sqlOutput.trim();
						}
						return this._formatTablePayloadAsMarkdown(parsed.columns, parsed.rows || []);
					}
					if (parsed.content !== undefined && String(parsed.content).trim() !== '') { return String(parsed.content); }
					if (parsed.result !== undefined && parsed.result !== null && (typeof parsed.result !== 'string' || parsed.result.trim() !== '')) {
						return typeof parsed.result === 'object' ? JSON.stringify(parsed.result) : String(parsed.result).trim();
					}
					if (isHttpTicketValue(parsed)) {
						return httpTicketValueOutputText(parsed);
					}
					if (isSshTicketValue(parsed)) {
						return sshTicketValueOutputText(parsed);
					}
					if (parsed.output !== undefined && !Array.isArray(parsed.output)) { return String(parsed.output); }
					if (parsed.url !== undefined && parsed.content === undefined) { return String(parsed.url); }
				} catch { }
			}
			return rawVal;
		}
		if (isWorkflowRecord(rawVal)) { // (null was handled above)
			if (Array.isArray(rawVal.rows) || typeof rawVal.sqlOutput === 'string') {
				if (Array.isArray(rawVal.rows) && rawVal.rows.length > 0) {
					return JSON.stringify(rawVal.rows, null, 2);
				}
				if (typeof rawVal.sqlOutput === 'string' && rawVal.sqlOutput.trim() !== '') {
					return rawVal.sqlOutput.trim();
				}
				return this._formatTablePayloadAsMarkdown(rawVal.columns as ITableColumnDefinition[] | undefined, (rawVal.rows || []) as Record<string, unknown>[]);
			}
			if (rawVal.content !== undefined && String(rawVal.content).trim() !== '') { return String(rawVal.content); }
			if (rawVal.result !== undefined && rawVal.result !== null && (typeof rawVal.result !== 'string' || rawVal.result.trim() !== '')) {
				return typeof rawVal.result === 'object' ? JSON.stringify(rawVal.result) : String(rawVal.result).trim();
			}
			if (isHttpTicketValue(rawVal)) {
				return httpTicketValueOutputText(rawVal);
			}
			if (isSshTicketValue(rawVal)) {
				return sshTicketValueOutputText(rawVal);
			}
			if (rawVal.output !== undefined && !Array.isArray(rawVal.output)) { return String(rawVal.output); }
			return JSON.stringify(rawVal, null, 2);
		}
		return String(rawVal);
	}

	private _resolveSshCommandsForExecution(rawCommands: ReadonlyArray<string>, context: Record<string, unknown>): string[] {
		const resolvedList: string[] = [];
		const lookupContextRaw = (key: string): unknown => {
			const trimmed = key.trim();
			if (context[trimmed] !== undefined) { return context[trimmed]; }
			const clean = this._cleanKey(trimmed);
			if (context[clean] !== undefined) { return context[clean]; }
			const lower = trimmed.toLowerCase();
			for (const [ck, cv] of Object.entries(context)) {
				if (ck.toLowerCase() === lower && cv !== undefined) {
					return cv;
				}
			}
			return undefined;
		};

		for (const rawEntry of (rawCommands || [])) {
			const rawStr = String(rawEntry ?? '').trim();
			if (!rawStr) {
				continue;
			}
			const pureVarMatch = rawStr.match(/^@?\{\{?([^{}]+)\}?\}/);
			if (pureVarMatch && pureVarMatch[0] === rawStr) {
				const rawVal = lookupContextRaw(pureVarMatch[1]);
				if (Array.isArray(rawVal)) {
					for (const item of rawVal) {
						const cleaned = cleanInterpolatedSshCommand(this._interpolateVariables(String(item ?? ''), context));
						if (cleaned) {
							resolvedList.push(cleaned);
						}
					}
					continue;
				}
				if (typeof rawVal === 'string' && rawVal.trim().startsWith('[') && rawVal.trim().endsWith(']')) {
					try {
						const parsedArr = JSON.parse(rawVal.trim());
						if (Array.isArray(parsedArr)) {
							for (const item of parsedArr) {
								const cleaned = cleanInterpolatedSshCommand(this._interpolateVariables(String(item ?? ''), context));
								if (cleaned) {
									resolvedList.push(cleaned);
								}
							}
							continue;
						}
					} catch { }
				}
			}
			const interpolated = cleanInterpolatedSshCommand(this._interpolateVariables(rawStr, context));
			if (interpolated) {
				resolvedList.push(interpolated);
			}
		}
		return resolvedList;
	}

	/** Refuses to send an AI prompt that still contains unresolved `{variable}` placeholders. */
	private _assertPromptVariablesResolved(promptLabel: string, rawPrompt: string, interpolatedPrompt: string): void {
		const missing = findUnresolvedTemplateVariables(rawPrompt, interpolatedPrompt);
		if (missing.length > 0) {
			throw new Error(`AI Prompt '${promptLabel}' was not sent: no value found for ${missing.map(v => `{${v}}`).join(', ')}. Run the upstream node that produces ${missing.length > 1 ? 'these variables' : 'this variable'} first, or fix the variable name.`);
		}
	}

	private _interpolateVariables(text: string, context: Record<string, unknown>): string {
		if (!text) { return ''; }

		// A large-variable reference that was never loaded back is not the variable's value: treat it as missing
		// so the placeholder stays visible (and is reported) instead of sending the reference JSON as content.
		const usable = (v: unknown): unknown => (isWorkflowRecord(v) && v.__anyagentVarRef__ === true) ? undefined : v;
		const findInContext = (k: string): unknown => {
			if (!k) { return undefined; }
			const tk = k.trim();
			if (usable(context[tk]) !== undefined) { return context[tk]; }
			const clean = this._cleanKey(tk);
			if (usable(context[clean]) !== undefined) { return context[clean]; }
			const lower = tk.toLowerCase();
			for (const [ck, cv] of Object.entries(context)) {
				if (ck.toLowerCase() === lower || this._cleanKey(ck) === clean) {
					if (usable(cv) !== undefined) { return cv; }
				}
			}
			return undefined;
		};

		const resolveVal = (key: string): string | undefined => {
			const trimmedKey = key.trim();
			if (!trimmedKey) { return undefined; }

			// 1. Direct match on full key (e.g. {job_id} or {Title})
			const directVal = findInContext(trimmedKey);
			if (directVal !== undefined) {
				return this._getCleanPrimitiveContent(directVal);
			}

			// 2. Property / Bracket / Dot access (e.g. api_json["job_id"], API/JSON["job_id"], api_json.job_id, api_json['job_id'], api_json.data["job_id"], etc.)
			const normalizedKey = trimmedKey.replace(/\\"/g, '"').replace(/\\'/g, '\'');
			const hasBracket = normalizedKey.includes('[');
			const hasDot = normalizedKey.includes('.');

			if (hasBracket || hasDot) {
				let rootCandidate = '';
				const segments: string[] = [];

				if (hasBracket) {
					const firstBracketIdx = normalizedKey.indexOf('[');
					rootCandidate = normalizedKey.substring(0, firstBracketIdx).trim();
					const accessorPart = normalizedKey.substring(firstBracketIdx);

					const accessorRegex = /\[\s*(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_\-]+))\s*\]|\.\s*([a-zA-Z0-9_\-]+)/g;
					let m: RegExpExecArray | null;
					while ((m = accessorRegex.exec(accessorPart)) !== null) {
						const seg = m[1] ?? m[2] ?? m[3] ?? m[4];
						if (seg !== undefined) {
							segments.push(seg);
						}
					}
				} else {
					const dotParts = normalizedKey.split('.');
					let matchedRoot = '';
					let matchedIndex = -1;
					for (let i = dotParts.length - 1; i >= 1; i--) {
						const candidate = dotParts.slice(0, i).join('.').trim();
						if (findInContext(candidate) !== undefined) {
							matchedRoot = candidate;
							matchedIndex = i;
							break;
						}
					}
					if (matchedIndex > 0) {
						rootCandidate = matchedRoot;
						for (let i = matchedIndex; i < dotParts.length; i++) {
							segments.push(dotParts[i].trim());
						}
					} else {
						rootCandidate = dotParts[0].trim();
						for (let i = 1; i < dotParts.length; i++) {
							segments.push(dotParts[i].trim());
						}
					}
				}

				let rootObj = findInContext(rootCandidate);

				if (rootObj === undefined && rootCandidate.includes('.')) {
					const parts = rootCandidate.split('.');
					rootObj = findInContext(parts[0].trim());
					if (rootObj !== undefined) {
						const extraSegs = parts.slice(1).map(p => p.trim());
						segments.unshift(...extraSegs);
					}
				}

				if (rootObj !== undefined && segments.length > 0) {
					let cur: unknown = rootObj;
					for (const seg of segments) {
						if (cur === undefined || cur === null) { break; }

						// If cur is a string (e.g. JSON string output from AI prompt, python or http), try parsing as JSON
						if (typeof cur === 'string') {
							let s = cur.trim();
							if (s.startsWith('```')) {
								s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
							}
							if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
								try {
									cur = JSON.parse(s);
								} catch { }
							}
						}

						// (`cur` is never null here: null is handled at the top of the loop and JSON.parse only ran on '{...}' / '[...]')
						if (!isWorkflowRecord(cur)) {
							cur = undefined;
							break;
						}

						if (Array.isArray(cur)) {
							const idx = parseInt(seg, 10);
							if (!isNaN(idx) && idx >= 0 && idx < cur.length) {
								cur = cur[idx];
							} else {
								cur = undefined;
								break;
							}
						} else {
							if (hasWorkflowProperty(cur, seg)) {
								cur = cur[seg];
							} else if (hasWorkflowProperty(cur, this._cleanKey(seg))) {
								cur = cur[this._cleanKey(seg)];
							} else {
								const lowerSeg = seg.toLowerCase();
								let found = false;
								for (const [k, v] of Object.entries(cur)) {
									if (k.toLowerCase() === lowerSeg || this._cleanKey(k) === this._cleanKey(seg)) {
										cur = v;
										found = true;
										break;
									}
								}
								if (!found) {
									cur = undefined;
									break;
								}
							}
						}
					}

					if (cur !== undefined) {
						return this._getCleanPrimitiveContent(cur);
					}
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
			if (!k || k.length < 2) { continue; }
			const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const atPattern = new RegExp(`@${escaped}\\b`, 'g');
			if (atPattern.test(result)) {
				const cleanVal = this._getCleanPrimitiveContent(context[k]);
				result = result.replace(atPattern, () => cleanVal);
			}
		}

		return result;
	}

	private async _extractWebContentWithRetry(
		targetUrl: string,
		credentials?: Array<{ key: string; value: string }>,
		options?: {
			maxRetries?: number;
			retryDelayMs?: number;
			label?: string;
			onRetryLog?: (msg: string) => void;
			checkCancelled?: () => void;
		}
	): Promise<{ title: string; content: string; attempts: number; retryLogs: string[]; lastError?: string }> {
		const maxRetries = typeof options?.maxRetries === 'number' && Number.isFinite(options.maxRetries)
			? Math.max(0, Math.min(10, Math.floor(options.maxRetries)))
			: 3;
		const retryDelayMs = typeof options?.retryDelayMs === 'number' && Number.isFinite(options.retryDelayMs)
			? Math.max(0, Math.min(60000, Math.floor(options.retryDelayMs)))
			: 1000;
		const label = options?.label || 'Browser';
		const retryLogs: string[] = [];
		let lastResult: { title: string; content: string } = { title: '', content: '' };
		let lastError: string | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			options?.checkCancelled?.();
			try {
				const extracted = await this._extractWebContent(targetUrl, credentials);
				lastResult = extracted;
				const content = extracted?.content || '';
				const isErrorContent = !content || content.startsWith('[Fetch Failed') || content.startsWith('HTTP Error');
				if (!isErrorContent) {
					if (attempt > 0) {
						const okMsg = `[Browser Retry ${attempt}/${maxRetries}] '${label}' succeeded on retry #${attempt} (${content.length} chars).`;
						retryLogs.push(okMsg);
						options?.onRetryLog?.(okMsg);
					}
					return {
						title: extracted.title || '',
						content,
						attempts: attempt + 1,
						retryLogs
					};
				}
				lastError = content || '[Fetch Failed: Empty response]';
			} catch (err) {
				lastError = err?.message || String(err);
				lastResult = { title: '', content: `[Fetch Failed: ${lastError}]` };
			}

			if (attempt < maxRetries) {
				const retryMsg = `[Browser Retry ${attempt + 1}/${maxRetries}] '${label}' failed (${lastError}). Waiting ${retryDelayMs}ms before retry #${attempt + 1}...`;
				retryLogs.push(retryMsg);
				options?.onRetryLog?.(retryMsg);
				if (retryDelayMs > 0) {
					await new Promise(resolve => setTimeout(resolve, retryDelayMs));
				}
				options?.checkCancelled?.();
			} else {
				const haltMsg = `[Browser Failed] '${label}' exhausted all ${maxRetries} retry attempt(s). Final error: ${lastError}`;
				retryLogs.push(haltMsg);
				options?.onRetryLog?.(haltMsg);
			}
		}

		return {
			title: lastResult.title || '',
			content: lastResult.content || (lastError ? `[Fetch Failed: ${lastError}]` : ''),
			attempts: maxRetries + 1,
			retryLogs,
			lastError
		};
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
			} catch (e) {
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
			} catch (err) {
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
		} catch (e) {
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

	private _parseJsonOrPythonListField(val: unknown): unknown[] {
		if (Array.isArray(val)) { return val; }
		if (val === null || val === undefined) { return []; }
		const s = String(val).trim();
		if (!s || s === '[]' || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') { return []; }
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) { return parsed; }
		} catch { }
		if (s.startsWith('[') && s.endsWith(']')) {
			const inner = s.slice(1, -1).trim();
			if (!inner) { return []; }
			const items: string[] = [];
			let i = 0;
			while (i < inner.length) {
				while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t' || inner[i] === '\n' || inner[i] === '\r' || inner[i] === ',')) {
					i++;
				}
				if (i >= inner.length) { break; }
				const quote = inner[i];
				if (quote === '\'' || quote === '"') {
					i++;
					let buf = '';
					while (i < inner.length) {
						if (inner[i] === '\\' && i + 1 < inner.length) {
							const nextCh = inner[i + 1];
							if (nextCh === 'n') { buf += '\n'; }
							else if (nextCh === 't') { buf += '\t'; }
							else if (nextCh === 'r') { buf += '\r'; }
							else { buf += nextCh; }
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
					while (end < inner.length && inner[end] !== ',') { end++; }
					const token = inner.slice(i, end).trim();
					if (token) { items.push(token); }
					i = end + 1;
				}
			}
			return items;
		}
		return [s];
	}

	private _tryExtractJsonRecordsFromTablePrompt(
		rawPrompt: string,
		contextVariables: Record<string, unknown>,
		customMetadata?: Record<string, string>,
		forceFallback: boolean = false
	): string | undefined {
		if (!rawPrompt) { return undefined; }
		const isDbResultJsonArrayParser =
			/(?:parse|extract)[\s\S]*?(?:database\s+query\s+result|query\s+result|returned\s+[\w\s]*records?|table\s+rows?)[\s\S]*?json\s+array/i.test(rawPrompt) ||
			(/(?:extract\s+all\s+returned|into\s+a\s+json\s+array)/i.test(rawPrompt) && /(?:do\s+not\s+omit\s+records|output\s+only\s+valid\s+json)/i.test(rawPrompt));
		if (!isDbResultJsonArrayParser && !forceFallback) {
			return undefined;
		}

		const tokenRegex = /@?\{\{?([^{}]+)\}?\}/g;
		let match: RegExpExecArray | null;
		let foundTableRows: unknown[] | undefined;
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
			if (candidate === undefined) { continue; }

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
			} else if (isWorkflowRecord(parsedCand) && (Reflect.has(parsedCand, 'rows') || Reflect.has(parsedCand, 'sqlOutput') || Reflect.has(parsedCand, 'dbEngine'))) {
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

		if (!foundTableRef) { return undefined; }
		if (!foundTableSuccess || !Array.isArray(foundTableRows) || foundTableRows.length === 0) {
			return '[]';
		}

		let templateObj: Record<string, unknown> | undefined;
		const structMatch = rawPrompt.match(/\[\s*(\{\s*"[^"]+"\s*:[\s\S]*?\})\s*\]/);
		if (structMatch && structMatch[1]) {
			try {
				const parsed = JSON.parse(structMatch[1]);
				if (isWorkflowRecord(parsed) && !Array.isArray(parsed)) {
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

		const sampleRow = isWorkflowRecord(foundTableRows[0]) ? foundTableRows[0] : {};
		const templateKeys = templateObj ? Object.keys(templateObj) : [];
		const matchingTemplateKeys = templateKeys.filter(k => hasWorkflowProperty(sampleRow, k));
		const useTemplateKeys = templateKeys.length >= 2 && matchingTemplateKeys.length >= 2;

		const normalizedRows = foundTableRows.map(row => {
			if (!isWorkflowRecord(row)) { return row; }
			const outRow: Record<string, unknown> = {};
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

	/**
	 * Strictly sanitizes and validates component business output against the Template Schema contract.
	 * Strips away transport and diagnostic envelopes (status, statusText, ok, headers, durationMs, exitCode)
	 * so that only pure business payload is returned as output and passed downstream.
	 */
	public validateAndSanitizeComponentOutput(fieldType: CustomFieldType | string | undefined, field: ICustomField | undefined, rawVal: unknown): unknown {
		if (rawVal === undefined || rawVal === null) {
			return rawVal;
		}

		// 1. HTTP Request Component:
		// Ensure output NEVER contains the transport metadata envelope { status: 200, ok: true, headers, ... }
		const isHttpEnvelope = isWorkflowRecord(rawVal) && !Array.isArray(rawVal) &&
			((Reflect.has(rawVal, 'status') || Reflect.has(rawVal, 'statusText') || Reflect.has(rawVal, 'ok')) && (Reflect.has(rawVal, 'data') || Reflect.has(rawVal, 'body') || Reflect.has(rawVal, 'rawText') || Reflect.has(rawVal, 'headers')));

		if (fieldType === 'http_request' || isHttpEnvelope) {
			if (isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
				if (rawVal.data !== undefined && rawVal.data !== null) {
					return rawVal.data;
				}
				if (rawVal.body !== undefined && rawVal.body !== null) {
					return rawVal.body;
				}
				if (rawVal.rawText !== undefined && rawVal.rawText !== null) {
					return rawVal.rawText;
				}
				if (rawVal.httpResponseData !== undefined && rawVal.httpResponseData !== null) {
					return rawVal.httpResponseData;
				}
				if (rawVal.httpResponseBody !== undefined && rawVal.httpResponseBody !== null) {
					return rawVal.httpResponseBody;
				}
			}
			return rawVal;
		}

		// 2. Python Script Component:
		if ((fieldType === 'python' || !fieldType) && isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
			if (Reflect.has(rawVal, 'result') && (Reflect.has(rawVal, 'pythonCode') || Reflect.has(rawVal, 'code') || Reflect.has(rawVal, 'exitCode') || Reflect.has(rawVal, 'output') || Reflect.has(rawVal, 'externalScripts'))) {
				return rawVal.result !== undefined ? rawVal.result : (rawVal.output || '');
			}
		}

		// 3. Table / SQL Component:
		if ((fieldType === 'table' || !fieldType) && isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
			if (Array.isArray(rawVal.rows) && (Reflect.has(rawVal, 'columns') || Reflect.has(rawVal, 'dbEngine') || Reflect.has(rawVal, 'sqlOutput'))) {
				return rawVal.rows;
			}
		}

		// 4. Browser Component:
		if ((fieldType === 'browser' || !fieldType) && isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
			if (Reflect.has(rawVal, 'content') && (Reflect.has(rawVal, 'url') || Reflect.has(rawVal, 'defaultUrl'))) {
				return rawVal.content;
			}
		}

		// 5. Prompt Component:
		if ((fieldType === 'prompt' || !fieldType) && isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
			if (Reflect.has(rawVal, 'output') && (Reflect.has(rawVal, 'prompt') || Reflect.has(rawVal, 'preInjectedPrompt') || Reflect.has(rawVal, 'userPrompt') || Reflect.has(rawVal, 'userPrompts'))) {
				return rawVal.output;
			}
		}

		// 6. SSH Component:
		if ((fieldType === 'ssh' || !fieldType) && isWorkflowRecord(rawVal) && !Array.isArray(rawVal)) {
			if (Reflect.has(rawVal, 'jsonOutput') && (Reflect.has(rawVal, 'host') || Reflect.has(rawVal, 'commands') || Reflect.has(rawVal, 'resolvedCommands'))) {
				return rawVal.jsonOutput;
			}
		}

		return rawVal;
	}

	private _formatOutputValue(rawVal: unknown, format: string): unknown {
		if (rawVal === undefined || rawVal === null) { return ''; }
		const sanitizedVal = this.validateAndSanitizeComponentOutput(undefined, undefined, rawVal);
		if (isWorkflowRecord(sanitizedVal)) {
			if (!Array.isArray(sanitizedVal) && (Reflect.has(sanitizedVal, 'sqlOutput') || (Reflect.has(sanitizedVal, 'columns') && Reflect.has(sanitizedVal, 'rows')) || Reflect.has(sanitizedVal, 'dbEngine'))) {
				const sqlOutStr = typeof sanitizedVal.sqlOutput === 'string' ? sanitizedVal.sqlOutput.trim() : '';
				if (Array.isArray(sanitizedVal.rows) && sanitizedVal.rows.length > 0) {
					return sanitizedVal.rows;
				}
				if (sqlOutStr !== '') {
					return sqlOutStr;
				}
				if (Array.isArray(sanitizedVal.rows)) {
					return sanitizedVal.rows;
				}
				if (typeof sanitizedVal.output === 'string' && sanitizedVal.output.trim() !== '' && !sanitizedVal.output.trim().startsWith('{"columns":')) {
					return sanitizedVal.output.trim();
				}
				return '';
			}
			return sanitizedVal;
		}

		const str = String(sanitizedVal).trim();
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

	private _parseOutputFieldValue(rawVal: unknown): unknown {
		if (rawVal === undefined || rawVal === null) { return null; }
		if (typeof rawVal === 'object') { return rawVal; }
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

	private _extractCleanRealizedValueFromMeta(rawMeta: unknown): unknown {
		if (rawMeta === undefined || rawMeta === null) { return null; }
		if (isWorkflowRecord(rawMeta)) { // (null was handled above)
			if (Array.isArray(rawMeta)) { return rawMeta; }
			if (Array.isArray(rawMeta.rows) || Reflect.has(rawMeta, 'sqlOutput') || (Reflect.has(rawMeta, 'columns') && Reflect.has(rawMeta, 'dbEngine'))) {
				const sqlOutStr = typeof rawMeta.sqlOutput === 'string' ? rawMeta.sqlOutput.trim() : '';
				if (Array.isArray(rawMeta.rows) && rawMeta.rows.length > 0) {
					return rawMeta.rows;
				}
				if (sqlOutStr !== '') {
					return sqlOutStr;
				}
				return Array.isArray(rawMeta.rows) ? rawMeta.rows : null;
			}
			if (rawMeta.prompt !== undefined || rawMeta.preInjectedPrompt !== undefined || rawMeta.userPrompt !== undefined || rawMeta.userPrompts !== undefined) {
				const out = rawMeta.output !== undefined ? String(rawMeta.output).trim() : '';
				return out ? this._parseOutputFieldValue(out) : null;
			}
			if (rawMeta.pythonCode !== undefined || rawMeta.code !== undefined || rawMeta.pythonPath !== undefined) {
				if (rawMeta.result !== undefined && rawMeta.result !== null && (typeof rawMeta.result !== 'string' || rawMeta.result.trim() !== '')) {
					return this._parseOutputFieldValue(rawMeta.result);
				}
				const out = rawMeta.output !== undefined ? String(rawMeta.output).trim() : '';
				return out ? this._parseOutputFieldValue(out) : null;
			}
			if (rawMeta.url !== undefined && rawMeta.content !== undefined) {
				const c = String(rawMeta.content).trim();
				return c ? this._parseOutputFieldValue(c) : null;
			}
			if (isHttpTicketValue(rawMeta)) {
				const httpVal = normalizeHttpTicketValue(rawMeta) ?? {};
				const httpPayload = httpVal.httpResponseData !== undefined && httpVal.httpResponseData !== null ? httpVal.httpResponseData : httpVal.httpResponseBody;
				return httpPayload !== undefined && httpPayload !== null ? this._parseOutputFieldValue(httpPayload) : null;
			}
			if (isSshTicketValue(rawMeta)) {
				const sshVal = normalizeSshTicketValue(rawMeta) ?? {};
				const maxLines = Number(sshVal.sshOutputLines) > 0 ? Number(sshVal.sshOutputLines) : 50;
				if (Array.isArray(sshVal.sshLastRawEntries) && sshVal.sshLastRawEntries.length > 0) {
					return buildSshCommandsJsonObject(sshVal.sshLastRawEntries, maxLines);
				}
				const sliced = sshTicketValueOutputText(sshVal);
				return sliced ? this._parseOutputFieldValue(sliced) : {};
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
			if (!trimmed) { return null; }
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
	 * - Returns null (None) if the ticket's template has NO 'output' component.
	 * - Returns a dictionary mapping each output field label to its value (or null/None if that field's value is missing/empty).
	 */
	private _extractStrictOutputsComponent(metadata: Record<string, string>, schema?: ICustomModule): Record<string, unknown> | null {
		const outputFields = schema?.fields?.filter(f => f.type === 'output') || [];

		// Collect any saved Output JSON maps in customMetadata (e.g. "Output", "Output 1", "output_1")
		const savedOutputRecords: Record<string, unknown> = {};
		const candidateOutKeys = new Set<string>(['Output', 'Output 1', 'output', 'output_1', 'Result', 'result']);
		for (const ofield of outputFields) {
			if (ofield.label) { candidateOutKeys.add(ofield.label); }
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
					if (isWorkflowRecord(parsed) && !Array.isArray(parsed)) {
						for (const [k, v] of Object.entries(parsed)) {
							if (k === 'outputSpecs' || k === 'output_specs') { continue; }
							savedOutputRecords[k] = v;
						}
					}
				} catch { }
			}
		}

		// If schema has NO output/result component:
		if (outputFields.length === 0) {
			// 1. If ticket saved an Output record in metadata, return it
			if (Object.keys(savedOutputRecords).length > 0) {
				return savedOutputRecords;
			}
			// 2. Otherwise return all non-system metadata fields of the ticket as the outputs dictionary
			if (isWorkflowRecord(metadata) && Object.keys(metadata).length > 0) {
				const fallbackRes: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(metadata)) {
					if (k && !k.startsWith('__') && k !== 'outputSpecs' && k !== 'output_specs') {
						fallbackRes[k] = this._extractCleanRealizedValueFromMeta(v);
					}
				}
				if (Object.keys(fallbackRes).length > 0) {
					return fallbackRes;
				}
			}
			return null;
		}

		const result: Record<string, unknown> = {};
		const lookupFieldMeta = (fieldKey: string, label: string): string | undefined => {
			const candidates: string[] = [];
			const pushCand = (c?: string) => {
				const t = (c || '').trim();
				if (t && !candidates.includes(t)) { candidates.push(t); }
			};
			pushCand(label);
			pushCand(fieldKey);

			if (schema?.fields) {
				const matchedField = schema.fields.find(f => {
					if (f.type === 'output') { return false; }
					const prevs: string[] = getPreviousLabels(f);
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
					const prevs: string[] = getPreviousLabels(matchedField);
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

		const lookupSavedRecord = (fieldKey: string, label: string): unknown => {
			const candidates = [label, fieldKey];
			if (schema?.fields) {
				const mf = schema.fields.find(f =>
					f.type !== 'output' && (
						f.label === label || f.label === fieldKey || f.id === fieldKey || f.id === label
					)
				);
				if (mf) {
					if (mf.label) { candidates.push(mf.label); }
					if (mf.id) {
						candidates.push(mf.id);
						candidates.push(mf.id.replace(/_/g, ' '));
					}
				}
			}
			for (const c of candidates) {
				if (c && savedOutputRecords[c] !== undefined) { return savedOutputRecords[c]; }
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
					if (f.type !== 'output') {
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
				let matchedField: IRuntimeCustomField | undefined = undefined;
				if (schema?.fields) {
					matchedField = schema.fields.find(f => {
						if (f.type === 'output') { return false; }
						const prevs: string[] = getPreviousLabels(f);
						return (
							f.label === outKey ||
							f.label === spec.fieldKey ||
							f.id === spec.fieldKey ||
							f.id === outKey ||
							prevs.includes(outKey) ||
							prevs.includes(spec.fieldKey)
						);
					});
					if (matchedField) {
						const canonicalLabel = matchedField.label || outKey;
						if (outKey !== canonicalLabel) {
							fieldAliases[outKey] = canonicalLabel;
						}
						if (spec.fieldKey && spec.fieldKey !== canonicalLabel) {
							fieldAliases[spec.fieldKey] = canonicalLabel;
						}
						if (matchedField.id && matchedField.id !== canonicalLabel) {
							fieldAliases[matchedField.id] = canonicalLabel;
						}
						if (matchedField.outputVariableName && matchedField.outputVariableName !== canonicalLabel) {
							fieldAliases[matchedField.outputVariableName] = canonicalLabel;
						}
						const prevs: string[] = getPreviousLabels(matchedField);
						for (const pl of prevs) {
							if (pl && pl !== canonicalLabel) {
								fieldAliases[pl] = canonicalLabel;
							}
						}
						outKey = canonicalLabel;
					}
				}
				let resolvedVal: unknown = null;

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

				const sanitizedVal = (resolvedVal !== undefined && resolvedVal !== '') ? this.validateAndSanitizeComponentOutput(matchedField?.type, matchedField, resolvedVal) : null;
				result[outKey] = sanitizedVal;
				if (spec.fieldKey && spec.fieldKey !== outKey) {
					result[spec.fieldKey] = sanitizedVal;
				}
				if (matchedField?.outputVariableName && matchedField.outputVariableName !== outKey) {
					result[matchedField.outputVariableName] = sanitizedVal;
				}
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
				result[k] = (resolved !== undefined && resolved !== '') ? this.validateAndSanitizeComponentOutput(undefined, undefined, resolved) : null;
			}
			return result;
		}

		return null;
	}

	private _extractTicketOutputs(metadata: Record<string, string>, schema?: ICustomModule): Record<string, unknown> {
		const strict = this._extractStrictOutputsComponent(metadata, schema);
		if (strict !== null) {
			return strict;
		}

		const outputs: Record<string, unknown> = {};

		// Fallback: extract output from any browser, prompt, or output fields in metadata
		for (const [k, v] of Object.entries(metadata)) {
			if (k.toLowerCase().startsWith('param') || k === 'parameters') { continue; }
			const extracted = this._extractPrimitiveCleanValue(v);
			if (extracted !== undefined) {
				outputs[k] = extracted;
			}
		}

		return outputs;
	}

	private _extractPrimitiveCleanValue(rawMeta: unknown, defaultFormat?: string): unknown {
		if (rawMeta === undefined || rawMeta === null) { return undefined; }
		if (typeof rawMeta === 'object') {
			return this._extractCleanRealizedValueFromMeta(rawMeta);
		}
		if (typeof rawMeta === 'string') {
			const trimmed = rawMeta.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// Data Table primitive
					if (Array.isArray(parsed.rows) || Reflect.has(parsed, 'sqlOutput') || (Reflect.has(parsed, 'columns') && Reflect.has(parsed, 'dbEngine'))) {
						if (Array.isArray(parsed.rows) && (parsed.rows.length > 0 || !/^Status:\s*FAILED\b/i.test(String(parsed.sqlOutput || '').trim()))) {
							return parsed.rows;
						}
						return parsed.sqlOutput || parsed.rows || [];
					}
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
					// HTTP Request primitive
					if (isHttpTicketValue(parsed)) {
						return httpTicketValueOutputText(parsed);
					}
					// SSH Terminal primitive
					if (isSshTicketValue(parsed)) {
						return sshTicketValueOutputText(parsed) || '{}';
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
					// HTTP Request primitive
					if ((Reflect.has(parsed, 'status') && (Reflect.has(parsed, 'data') || Reflect.has(parsed, 'body') || Reflect.has(parsed, 'headers') || Reflect.has(parsed, 'statusText') || Reflect.has(parsed, 'ok') || Reflect.has(parsed, 'rawText'))) ||
						(parsed.url !== undefined && (parsed.data !== undefined || parsed.body !== undefined || parsed.rawText !== undefined || parsed.status !== undefined)) ||
						Reflect.has(parsed, 'httpResponseData') || Reflect.has(parsed, 'httpResponseBody')) {
						const httpPayload = parsed.data !== undefined ? parsed.data : (parsed.body !== undefined ? parsed.body : (parsed.rawText !== undefined ? parsed.rawText : (parsed.httpResponseData !== undefined ? parsed.httpResponseData : parsed.httpResponseBody)));
						return (httpPayload !== undefined && httpPayload !== null) ? httpPayload : parsed;
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
			ticketUri.path.endsWith('.md') ? ticketUri : undefined,
			URI.joinPath(ticketUri, '.agents', 'ticket.md'),
			URI.joinPath(ticketUri, 'ticket.md'),
			ticketUri
		].filter(Boolean) as URI[];

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
								if (val) { ticketId = val; }
							} else if (key === 'Ticket Type') {
								if (val) { ticketType = val; }
							} else if (key === 'Title') {
								if (val) { title = val; }
							} else if (key === 'Description') {
								if (val) { description = val; }
							} else if (key === 'Status') {
								if (val) { status = val; }
							} else if (key === 'Priority') {
								if (val) { priority = val; }
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
						if (tMatch && tMatch[1].trim()) { title = tMatch[1].trim(); }
						const dMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)$/i);
						if (dMatch && dMatch[1].trim()) { description = dMatch[1].trim(); }
						const idMatch = line.match(/^\s*-\s*\*\*Ticket ID\*\*:\s*(.*)$/i);
						if (idMatch && idMatch[1].trim() && !ticketId) { ticketId = idMatch[1].trim(); }
						const typeMatch = line.match(/^\s*-\s*\*\*Ticket Type\*\*:\s*(.*)$/i);
						if (typeMatch && typeMatch[1].trim() && !ticketType) { ticketType = typeMatch[1].trim(); }
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
			let type: CustomFieldType = 'text';
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

	private async _persistExecutionState(ticketUri: URI, ticket: ITicketGetResult, customMetadata: Record<string, string>, finalOutput: unknown, executionStatus: 'Completed' | 'Failed' = 'Completed'): Promise<void> {
		try {
			// Ensure Output field is populated in customMetadata even if schema didn't explicitly run an output step
			if (finalOutput !== undefined && customMetadata['Output'] === undefined && customMetadata['output'] === undefined) {
				const outPayload = (isWorkflowRecord(finalOutput) && !Array.isArray(finalOutput))
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
				status: executionStatus,
				description: ticket.description
			};
			snapshot.customMetadata = customMetadata;
			snapshot.status = executionStatus;
			await this.entityPersistenceService.saveSnapshot(snapshot);

			// 2. Persist updated customMetadata & Status directly to .agents/ticket.md (and root ticket.md if present)
			const ticketMdCandidates = [
				ticketUri.path.endsWith('.md') ? ticketUri : undefined,
				URI.joinPath(ticketUri, '.agents', 'ticket.md'),
				URI.joinPath(ticketUri, 'ticket.md')
			].filter(Boolean) as URI[];
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
								newLines.push(line.replace(/(^\s*-\s+\*\*Status\*\*:\s*)([^\r\n]*)/i, (_, p1) => `${p1}${executionStatus}`));
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

			// 3. Save execution record using TicketWorklogStorage (independent log files under .agents/Worklogs, auto-split if oversized, lightweight worklog.md)
			try {
				const storage = new TicketWorklogStorage(this.fileService);
				const rawOutSummary = typeof finalOutput === 'object' ? JSON.stringify(finalOutput) : String(finalOutput);
				await storage.saveWorklog(ticketUri, {
					execution_status: executionStatus,
					output_summary: rawOutSummary,
					update_by: 'Workflow Execution'
				});
			} catch (logErr) {
				this.logService.warn(`[TicketWorkflowRuntime] Failed to persist execution state to TicketWorklogStorage:`, logErr);
			}
		} catch (err) {
			this.logService.warn(`[TicketWorkflowRuntime] Failed to persist execution state to worklog:`, err);
		}
	}

	async executePythonScript(
		workspaceUri: string | URI,
		ticketUri: string | URI,
		pythonPath: string,
		code: string,
		contextVariables?: Record<string, unknown>,
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
		const rpcReqUri = URI.file(`${tmpDirPath}/.anyagent_py_${timestamp}_${randSuffix}.rpc_req.json`);
		const rpcResUri = URI.file(`${tmpDirPath}/.anyagent_py_${timestamp}_${randSuffix}.rpc_res.json`);
		const needsHostRpc = /\b(?:CREATE_TICKETS|create_tickets|RUN_TICKETS|run_tickets|GET_OUTPUTS|get_outputs|GET_TICKET|get_ticket)\s*\(/.test(code || '');

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
			// Pre-resolve only ticket IDs explicitly referenced in code
			const preResolvedOutputs: Record<string, unknown> = {};
			const preResolvedTickets: Record<string, unknown> = {};
			try {
				const candidateTicketIds = new Set<string>();
				const idMatches = (code || '').matchAll(/["']([A-Za-z0-9_]+-\d+)["']/g);
				for (const m of idMatches) {
					if (m[1]) { candidateTicketIds.add(m[1].trim()); }
				}
				const fnCallMatches = (code || '').matchAll(/\b(?:GET_OUTPUTS|get_outputs|GET_TICKETS|get_tickets|GET_TICKET|get_ticket)\s*\(\s*(?:(?:ticket_id|ticket|tickets|ticket_name)\s*=\s*)?["']([^"']+)["']/g);
				for (const m of fnCallMatches) {
					if (m[1]) { candidateTicketIds.add(m[1].trim()); }
				}
				// ONLY check contextVariables if the code actually invokes ticket getter primitives and names that variable
				const hasTicketCall = /\b(?:GET_OUTPUTS|get_outputs|GET_TICKETS|get_tickets|GET_TICKET|get_ticket)\b/.test(code || '');
				if (hasTicketCall && isWorkflowRecord(contextVariables)) {
					for (const [k, val] of Object.entries(contextVariables)) {
						if (!(code || '').includes(k)) {
							continue;
						}
						if (isWorkflowRecord(val)) {
							const tid = val.ticketId || val.entityUri || val.ticketName;
							if (tid) {
								candidateTicketIds.add(String(tid).trim());
							}
						} else if (typeof val === 'string' && val.trim().length > 0 && val.trim().length < 512) {
							candidateTicketIds.add(val.trim());
						}
					}
				}
				for (const tid of candidateTicketIds) {
					if (!tid) { continue; }
					const tRes = await this.getTicket(wsUri, tid);
					if (tRes.success) {
						const outDict = await this.getOutputs(wsUri, tRes);
						preResolvedOutputs[tid] = outDict;
						if (tRes.ticketId) {
							preResolvedOutputs[tRes.ticketId] = outDict;
						}
						if (tRes.entityUri) {
							preResolvedOutputs[tRes.entityUri] = outDict;
						}
						if (tRes.ticketName) {
							preResolvedOutputs[tRes.ticketName] = outDict;
						}
						// Store only a lean descriptor, never the multi-megabyte customMetadata
						const cleanTicket = {
							success: true,
							ticketId: tRes.ticketId,
							ticketName: tRes.ticketName,
							ticketType: tRes.ticketType,
							entityUri: tRes.entityUri,
							title: tRes.title,
							status: tRes.status,
							outputs: outDict
						};
						preResolvedTickets[tid] = cleanTicket;
						if (tRes.ticketId && tRes.ticketId !== tid) {
							preResolvedTickets[tRes.ticketId] = cleanTicket;
						}
					}
				}
			} catch { }

			// Strip nested contextVariables / stepResults, duplicate @-prefixed keys, and stale historical ticket dot-notation keys
			const sanitizedCtx: Record<string, unknown> = {};
			if (isWorkflowRecord(contextVariables)) {
				for (const [k, v] of Object.entries(contextVariables)) {
					if (k === 'contextVariables' || k === 'stepResults') { continue; }
					// If k is a ticket dot-notation key (e.g. 'FINDJ-2754.Job Info Page' or 'Job Info https:...'), only include if code explicitly references it
					if ((k.includes('.') || k.startsWith('FINDJ-') || k.startsWith('Job Info')) && !(code || '').includes(k)) {
						continue;
					}
					if (isWorkflowRecord(v) && !Array.isArray(v) && (Reflect.has(v, 'contextVariables') || Reflect.has(v, 'stepResults'))) {
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
            return raw_val
        if 'rows' in raw_val and isinstance(raw_val['rows'], list):
            sql_out = str(raw_val.get('sqlOutput') or '').strip()
            if len(raw_val['rows']) > 0 or (sql_out and not sql_out.startswith('Status: FAILED')):
                return raw_val['rows']
            if sql_out:
                return sql_out
            return raw_val['rows']
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
        if ('httpUrl' in raw_val or 'httpResponseStatus' in raw_val or 'httpResponseData' in raw_val or 'httpResponseBody' in raw_val):
            # http_request ticket value (same names as the template config)
            http_data = raw_val.get('httpResponseData') if raw_val.get('httpResponseData') is not None else raw_val.get('httpResponseBody')
            if http_data is None:
                return None
            return _anyagent_smart_parse(http_data) if isinstance(http_data, str) else http_data
        if (('status' in raw_val and any(k in raw_val for k in ('data', 'body', 'headers', 'statusText', 'ok', 'rawText'))) or
            ('url' in raw_val and any(k in raw_val for k in ('data', 'body', 'rawText', 'status', 'headers')))):
            # older tickets: post-run record with short names
            http_data = raw_val.get('data') if raw_val.get('data') is not None else (raw_val.get('body') if raw_val.get('body') is not None else raw_val.get('rawText'))
            if http_data is not None:
                return _anyagent_smart_parse(http_data) if isinstance(http_data, str) else http_data
        if any(k in raw_val for k in ('sshLastRawEntries', 'sshLastOutput', 'lastRawEntries', 'lastNOutput', 'sshHost', 'sshCommands')) or ('host' in raw_val and ('outputLines' in raw_val or 'sshOutputLines' in raw_val)):
            # ssh ticket value: template config names (sshLastRawEntries, ...); short names are from older tickets
            raw_entries = raw_val.get('sshLastRawEntries') if raw_val.get('sshLastRawEntries') is not None else raw_val.get('lastRawEntries')
            max_l = int(raw_val.get('sshOutputLines') or raw_val.get('outputLines') or 50)
            if isinstance(raw_entries, list) and len(raw_entries) > 0:
                ssh_obj = {}
                for ent in raw_entries:
                    if isinstance(ent, dict):
                        c_key = str(ent.get('command') or '').strip()
                        if c_key:
                            r_out = str(ent.get('rawOutput') or '').replace('\\r\\n', '\\n').replace('\\r', '\\n')
                            r_lines = r_out.split('\\n') if r_out else []
                            while len(r_lines) > 0 and r_lines[-1] == '':
                                r_lines.pop()
                            ssh_obj[c_key] = r_lines[-max_l:] if max_l > 0 and len(r_lines) > max_l else r_lines
                return ssh_obj
            last_n = str(raw_val.get('sshLastOutput') or raw_val.get('lastNOutput') or '').strip()
            if last_n:
                return _anyagent_smart_parse(last_n)
            out = str(raw_val.get('sshOutput') or raw_val.get('output') or '').strip()
            return _anyagent_smart_parse(out) if out else {}
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

def get_outputs(ticket=None, *, ticket_id=None, ticket_name=None, tickets=None, field=None, **kwargs):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (ticket_name if ticket_name is not None else tickets))
    if target is None:
        return None
    lookup_key = None
    if isinstance(target, str):
        lookup_key = target.strip()
    elif isinstance(target, dict):
        lookup_key = str(target.get('ticketId') or target.get('ticket_id') or target.get('ticketName') or target.get('id') or '').strip()
    res = None
    if lookup_key:
        if lookup_key in _pre_resolved_outputs:
            res = _pre_resolved_outputs[lookup_key]
        elif lookup_key.lower() in _pre_resolved_outputs:
            res = _pre_resolved_outputs[lookup_key.lower()]
    if res is None and isinstance(target, dict) and 'outputs' in target and isinstance(target['outputs'], dict):
        res = _anyagent_smart_parse(target['outputs'])
    if res is None:
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
        slug_variants = []
        for cand_slug in [
            ticket_type.strip(),
            ticket_type.strip().lower(),
            re.sub(r'[-_\\s]+', '-', ticket_type.strip().lower()),
            re.sub(r'[-_\\s]+', '_', ticket_type.strip().lower()),
        ]:
            if cand_slug and cand_slug not in slug_variants:
                slug_variants.append(cand_slug)
        cur = t_dir
        for _ in range(4):
            for sv in slug_variants:
                schema_paths.append(os.path.join(cur, '.agents', 'entity_type', f'{sv}.yaml'))
                schema_paths.append(os.path.join(cur, '.agents', 'entity_type', f'{sv}.yml'))
            parent = os.path.dirname(cur)
            if not parent or parent == cur:
                break
            cur = parent
        home_dir = os.path.expanduser('~')
        for sv in slug_variants:
            schema_paths.append(os.path.join(home_dir, '.anyagent', 'entity_type', f'{sv}.yaml'))
            schema_paths.append(os.path.join(home_dir, '.anyagent', 'entity_type', f'{sv}.yml'))
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
        res = None
    elif output_specs:
        out_dict = {}
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
            out_dict[lbl] = val
        res = out_dict
    elif saved_outputs:
        out_dict = {}
        for ok, ov in saved_outputs.items():
            out_dict[ok] = _anyagent_extract_clean_meta_val(ov)
        res = out_dict if out_dict else None
    else:
        res = None
    if field and isinstance(res, dict):
        f = str(field).strip()
        if f in res:
            return res[f]
        for k, v in res.items():
            if str(k).strip().lower() == f.lower():
                return v
        norm_f = re.sub(r'[^a-zA-Z0-9]', '', f).lower()
        for k, v in res.items():
            if re.sub(r'[^a-zA-Z0-9]', '', str(k)).lower() == norm_f:
                return v
        for k, v in res.items():
            norm_k = re.sub(r'[^a-zA-Z0-9]', '', str(k)).lower()
            if (norm_f and norm_f in norm_k) or (norm_k and norm_k in norm_f):
                return v
        return res.get(f)
    return res

GET_OUTPUTS = get_outputs

def get_ticket(ticket=None, *, ticket_id=None, ticket_name=None, field=None, ticket_type=None, **kwargs):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else ticket_name)
    res = None
    if isinstance(target, dict):
        res = target
    elif isinstance(target, str) and target.strip() in _pre_resolved_tickets:
        res = _pre_resolved_tickets[target.strip()]
    elif isinstance(target, str) and target.strip().lower() in _pre_resolved_tickets:
        res = _pre_resolved_tickets[target.strip().lower()]
    else:
        res = target
    if field and isinstance(res, dict):
        f = str(field).strip()
        if f in res:
            return res[f]
        outputs = res.get('outputs')
        if isinstance(outputs, dict) and f in outputs:
            return outputs[f]
        custom_metadata = res.get('customMetadata') or res.get('custom_metadata')
        if isinstance(custom_metadata, dict) and f in custom_metadata:
            return custom_metadata[f]
        lower_f = f.lower()
        for k, v in res.items():
            if str(k).lower() == lower_f:
                return v
        if isinstance(outputs, dict):
            for k, v in outputs.items():
                if str(k).lower() == lower_f:
                    return v
        if isinstance(custom_metadata, dict):
            for k, v in custom_metadata.items():
                if str(k).lower() == lower_f:
                    return v
    return res

GET_TICKET = get_ticket

def get_tickets(ticket=None, *, ticket_id=None, ticket_name=None, tickets=None, ticket_type=None, status=None, title=None, field=None, **kwargs):
    if ticket is not None or ticket_id is not None or ticket_name is not None or tickets is not None:
        target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (ticket_name if ticket_name is not None else tickets))
        return get_ticket(target, field=field)
    res_list = []
    for t in _pre_resolved_tickets.values():
        if not isinstance(t, dict):
            continue
        if ticket_type and str(t.get('ticketType', '')).lower() != str(ticket_type).lower():
            continue
        if status and str(t.get('status', '')).lower() != str(status).lower():
            continue
        if title and str(title).lower() not in str(t.get('title', '')).lower():
            continue
        if field:
            f = str(field).strip()
            val = t.get(f)
            if val is None and isinstance(t.get('outputs'), dict):
                val = t['outputs'].get(f)
            if val is None and isinstance(t.get('customMetadata'), dict):
                val = t['customMetadata'].get(f)
            res_list.append(val)
        else:
            res_list.append(t)
    return res_list

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
        if (('status' in v and any(pk in v for pk in ('data', 'body', 'headers', 'statusText', 'ok', 'rawText'))) or
            ('url' in v and any(pk in v for pk in ('data', 'body', 'rawText', 'status', 'headers'))) or
            ('httpResponseData' in v or 'httpResponseBody' in v)):
            http_payload = v.get('data') if v.get('data') is not None else (v.get('body') if v.get('body') is not None else (v.get('rawText') if v.get('rawText') is not None else (v.get('httpResponseData') if v.get('httpResponseData') is not None else v.get('httpResponseBody'))))
            if http_payload is not None:
                return _anyagent_smart_parse(http_payload)
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
import builtins as _py_builtins, keyword as _py_keyword, time as _py_time, uuid as _py_uuid
_ANYAGENT_RPC_REQ_FILE = ${JSON.stringify(rpcReqUri.fsPath)}
_ANYAGENT_RPC_RES_FILE = ${JSON.stringify(rpcResUri.fsPath)}
_ANYAGENT_RPC_ENABLED = ${needsHostRpc ? 'True' : 'False'}

def _anyagent_host_rpc(fn_name, payload, timeout_sec=600.0):
    if not _ANYAGENT_RPC_ENABLED:
        raise RuntimeError(f"Host RPC is not enabled for {fn_name}")
    req_id = _py_uuid.uuid4().hex
    try:
        if os.path.exists(_ANYAGENT_RPC_RES_FILE):
            os.remove(_ANYAGENT_RPC_RES_FILE)
    except Exception:
        pass
    tmp_req = _ANYAGENT_RPC_REQ_FILE + ".tmp"
    with open(tmp_req, "w", encoding="utf-8") as _rf:
        json.dump({"id": req_id, "fn": fn_name, "payload": payload}, _rf, ensure_ascii=False, default=str)
    os.replace(tmp_req, _ANYAGENT_RPC_REQ_FILE)
    deadline = _py_time.time() + timeout_sec
    while _py_time.time() < deadline:
        if os.path.exists(_ANYAGENT_RPC_RES_FILE):
            try:
                with open(_ANYAGENT_RPC_RES_FILE, "r", encoding="utf-8") as _sf:
                    _resp = json.load(_sf)
                if isinstance(_resp, dict) and _resp.get("id") == req_id:
                    try:
                        os.remove(_ANYAGENT_RPC_RES_FILE)
                    except Exception:
                        pass
                    if not _resp.get("ok", False):
                        raise RuntimeError(_resp.get("error") or f"{fn_name} failed")
                    return _resp.get("result")
            except json.JSONDecodeError:
                pass
        _py_time.sleep(0.04)
    raise TimeoutError(f"{fn_name} timed out waiting for AnyAgent host response")

def CREATE_TICKETS(ticket_type=None, title=None, path=None, parameters=None, params=None, target_path=None, target_folder=None, folder=None, folder_name=None, auto_run=False, **kwargs):
    merged_params = {}
    raw_p = parameters if isinstance(parameters, dict) else (params if isinstance(params, dict) else {})
    merged_params.update(raw_p)
    for _k, _v in kwargs.items():
        if _k not in ('type', 'name', 'fieldValues', 'autoRun', 'folderName'):
            merged_params[_k] = _v
    res = _anyagent_host_rpc("CREATE_TICKETS", {
        "ticketType": ticket_type or kwargs.get("type") or "Task",
        "title": title or kwargs.get("name") or "New Ticket",
        "targetPath": path or target_path or target_folder or folder or ".",
        "folderName": folder_name or kwargs.get("folderName"),
        "parameters": merged_params,
        "autoRun": bool(auto_run or kwargs.get("autoRun", False))
    })
    return res
create_tickets = CREATE_TICKETS

def RUN_TICKETS(ticket=None, ticket_id=None, tickets=None, ticket_name=None, parameters=None, params=None, input_params=None, **kwargs):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (tickets if tickets is not None else ticket_name))
    merged_params = {}
    raw_p = parameters if isinstance(parameters, dict) else (params if isinstance(params, dict) else (input_params if isinstance(input_params, dict) else {}))
    merged_params.update(raw_p)
    for _k, _v in kwargs.items():
        if _k not in ('fieldValues',):
            merged_params[_k] = _v
    res = _anyagent_host_rpc("RUN_TICKETS", {
        "target": target,
        "parameters": merged_params
    })
    return res
run_tickets = RUN_TICKETS

_orig_get_outputs = get_outputs
def get_outputs(ticket=None, field=None, *, ticket_id=None, tickets=None, ticket_name=None, **kwargs):
    res = _orig_get_outputs(ticket=ticket, field=field, ticket_id=ticket_id, tickets=tickets, ticket_name=ticket_name, **kwargs)
    if res is None and _ANYAGENT_RPC_ENABLED:
        target = ticket if ticket is not None else (ticket_id if ticket_id is not None else (tickets if tickets is not None else ticket_name))
        if target is not None:
            try:
                res = _anyagent_host_rpc("GET_OUTPUTS", {"target": target, "field": field})
            except Exception:
                pass
    return res
GET_OUTPUTS = get_outputs

_orig_get_ticket = get_ticket
def get_ticket(ticket=None, *, ticket_id=None, ticket_name=None, field=None, ticket_type=None, **kwargs):
    target = ticket if ticket is not None else (ticket_id if ticket_id is not None else ticket_name)
    res = _orig_get_ticket(ticket=ticket, ticket_id=ticket_id, ticket_name=ticket_name, field=field, ticket_type=ticket_type, **kwargs)
    if (res is None or res == target) and _ANYAGENT_RPC_ENABLED and target is not None:
        try:
            rpc_res = _anyagent_host_rpc("GET_TICKET", {"target": target, "field": field})
            if rpc_res is not None:
                return rpc_res
        except Exception:
            pass
    return res
GET_TICKET = get_ticket

_orig_get_tickets = get_tickets
def get_tickets(ticket=None, *, ticket_id=None, ticket_name=None, tickets=None, ticket_type=None, status=None, title=None, field=None, path=None, limit=None, **kwargs):
    if ticket is not None or ticket_id is not None or ticket_name is not None or tickets is not None:
        return _orig_get_tickets(ticket, ticket_id=ticket_id, ticket_name=ticket_name, tickets=tickets, field=field)
    if _ANYAGENT_RPC_ENABLED:
        try:
            rpc_res = _anyagent_host_rpc("GET_TICKETS", {"ticket_type": ticket_type, "status": status, "title": title, "path": path, "limit": limit, "field": field})
            if isinstance(rpc_res, list):
                return rpc_res
        except Exception:
            pass
    return _orig_get_tickets(ticket_type=ticket_type, status=status, title=title, field=field)
GET_TICKETS = get_tickets

def DISPLAY(*args, **kwargs):
    for _d_arg in args:
        if isinstance(_d_arg, (dict, list)):
            try:
                print(json.dumps(_d_arg, ensure_ascii=False, indent=2, default=str))
            except Exception:
                print(_d_arg)
        else:
            print(_d_arg)
    return args[0] if len(args) == 1 else (args if args else None)
display = DISPLAY
_py_reserved = set(dir(_py_builtins)) | set(_py_keyword.kwlist) | {'TICKET_CONTEXT', 'ticket_context', 'context', 'OUTPUT', 'RESULT', 'CREATE_TICKETS', 'create_tickets', 'RUN_TICKETS', 'run_tickets', 'GET_OUTPUTS', 'get_outputs', 'GET_TICKETS', 'get_tickets', 'GET_TICKET', 'get_ticket', 'DISPLAY', 'display', 'set_output', 'return_output'}
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
    for candidate in ['OUTPUT', 'RESULT', 'output', 'RETURN_VALUE', 'return_value']:
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
			// Callers may (despite the signature) pass an interpreter descriptor object instead of a path string
			const pythonPathArg: unknown = pythonPath;
			if (typeof pythonPathArg === 'string') {
				cleanPyPath = pythonPathArg.trim();
			} else if (isWorkflowRecord(pythonPathArg)) {
				cleanPyPath = String(pythonPathArg.interpreterPath || pythonPathArg.pythonPath || '').trim();
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
			let activeEntry: { terminal: ITerminalInstance; abort: () => void; label: string } | undefined;

			let rpcPollTimer: number | null = null;
			let rpcInFlight = false;
			if (needsHostRpc) {
				rpcPollTimer = mainWindow.setInterval(async () => {
					if (rpcInFlight || finished) {
						return;
					}
					rpcInFlight = true;
					try {
						if (!(await this.fileService.exists(rpcReqUri))) {
							return;
						}
						const rawReq = (await this.fileService.readFile(rpcReqUri)).value.toString();
						try {
							await this.fileService.del(rpcReqUri);
						} catch { }
						const req = JSON.parse(rawReq);
						const reqId = req?.id;
						const fn = String(req?.fn || '').toUpperCase();
						const payload = req?.payload || {};
						let rpcResult: unknown = null;
						let rpcError: string | undefined;
						try {
							if (fn === 'CREATE_TICKETS') {
								const createdTicketRes = await this.createTicket({
									workspaceUri: wsUri,
									targetPath: payload.targetPath || '.',
									ticketType: payload.ticketType || 'Task',
									title: payload.title || 'New Ticket',
									folderName: payload.folderName || undefined,
									parameters: isWorkflowRecord(payload.parameters) ? payload.parameters : {}
								});
								rpcResult = createdTicketRes;
								if (createdTicketRes?.success && payload.autoRun) {
									await this.runTicket({
										workspaceUri: wsUri,
										ticketIdOrPath: createdTicketRes.entityUri || createdTicketRes.ticketId || createdTicketRes.ticketName || '',
										inputParams: isWorkflowRecord(payload.parameters) ? payload.parameters : {}
									});
								}
							} else if (fn === 'RUN_TICKETS') {
								let target = payload.target;
								if (isWorkflowRecord(target)) {
									target = target.entityUri || target.ticketId || target.ticketName || '';
								}
								rpcResult = await this.runTicket({
									workspaceUri: wsUri,
									ticketIdOrPath: String(target || ''),
									inputParams: isWorkflowRecord(payload.parameters) ? payload.parameters : {}
								});
							} else if (fn === 'GET_OUTPUTS') {
								rpcResult = await this.getOutputs(wsUri, payload.target, payload.field || undefined);
							} else if (fn === 'GET_TICKET') {
								rpcResult = await this.getTicket(wsUri, payload.target, payload.field || undefined);
							} else if (fn === 'GET_TICKETS') {
								const q: Record<string, unknown> = isWorkflowRecord(payload) ? payload : {};
								rpcResult = await this.getTickets(wsUri, { ticket_type: q.ticket_type, status: q.status, title: q.title, path: q.path, limit: q.limit }, (q.field || undefined) as string | undefined);
							} else {
								rpcError = `Unknown host RPC function: ${fn}`;
							}
						} catch (callErr) {
							rpcError = callErr?.message || String(callErr);
						}
						const respPayload = rpcError
							? { id: reqId, ok: false, error: rpcError }
							: { id: reqId, ok: true, result: rpcResult };
						await this.fileService.writeFile(rpcResUri, VSBuffer.fromString(JSON.stringify(respPayload)));
					} catch {
						// Ignore transient partial read
					} finally {
						rpcInFlight = false;
					}
				}, 80);
			}

			const waitPromise = new Promise<void>((resolve) => {
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') {
							exitCode = codeOverride;
						}
						finished = true;
						if (rpcPollTimer) {
							mainWindow.clearInterval(rpcPollTimer);
							rpcPollTimer = null;
						}
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
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
				terminalListeners.data = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				terminalListeners.exit = terminal.onExit(code => {
					finishOnce(typeof code === 'number' ? code : exitCode);
				});

				setTimeout(() => {
					finishOnce();
				}, needsHostRpc ? 600000 : 60000);
			});

			try {
				if (this._cancelEpoch !== startEpoch) {
					activeEntry?.abort();
				} else {
					await terminal.sendText(runCmd, true);
					await waitPromise;
				}
			} finally {
				if (rpcPollTimer) {
					mainWindow.clearInterval(rpcPollTimer);
					rpcPollTimer = null;
				}
				try { await this.fileService.del(rpcReqUri); } catch { }
				try { await this.fileService.del(rpcResUri); } catch { }
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

			let scriptResult: unknown = undefined;
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
		} catch (err) {
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
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') { exitCode = codeOverride; }
						finished = true;
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				terminalListeners.data = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				terminalListeners.exit = terminal.onExit(code => {
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
		} catch (err) {
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
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = (codeOverride?: number) => {
					if (!finished) {
						if (typeof codeOverride === 'number') { exitCode = codeOverride; }
						finished = true;
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				terminalListeners.data = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce(parseInt(match[1], 10));
					}
				});

				terminalListeners.exit = terminal.onExit(code => {
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
		} catch (err) {
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
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = () => {
					if (!finished) {
						finished = true;
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
						resolve();
					}
				};
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				terminalListeners.data = terminal.onData(data => {
					if (regex.test(data)) {
						finishOnce();
					}
				});
				terminalListeners.exit = terminal.onExit(() => {
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

	async detectPythonEnvironment(workspaceUri: string | URI, candidatePath?: string | unknown): Promise<IPythonEnvironmentDetectionResult> {
		const wsUri = this._toUri(workspaceUri);
		let rawPath = '';
		if (typeof candidatePath === 'string') {
			rawPath = candidatePath.trim();
		} else if (isWorkflowRecord(candidatePath)) {
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
			let activeEntry: { terminal: ITerminalInstance; abort: () => void; label: string } | undefined;
			const waitPromise = new Promise<void>((resolve) => {
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = () => {
					if (!finished) {
						finished = true;
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
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
				terminalListeners.data = terminal.onData(data => {
					const match = regex.exec(data);
					if (match) {
						finishOnce();
					}
				});
				terminalListeners.exit = terminal.onExit(() => {
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
		} catch (err) {
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

	async executeHttpRequest(
		field: IRuntimeCustomField,
		contextVariables: Record<string, unknown>
	): Promise<IHttpRequestExecutionResult> {
		const start = Date.now();
		const startEpoch = this._cancelEpoch;

		// 1. Method
		const rawMethod = (field.httpMethod || 'GET').trim().toUpperCase();
		const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(rawMethod) ? rawMethod : 'GET';

		// 2. URL and Variable Interpolation
		let rawUrl = (field.httpUrl || '').trim();
		if (!rawUrl && field.defaultUrl) {
			rawUrl = field.defaultUrl.trim();
		}
		let interpolatedUrl = this._interpolateVariables(rawUrl, contextVariables).trim();

		// 3. Query Parameters
		const paramsList = Array.isArray(field.httpParams) ? field.httpParams : [];
		const activeParams: Array<{ key: string; value: string }> = [];
		for (const p of paramsList) {
			if (p && p.enabled !== false && p.key) {
				const interKey = this._interpolateVariables(p.key, contextVariables).trim();
				const interVal = this._interpolateVariables(p.value ?? '', contextVariables);
				if (interKey) {
					activeParams.push({ key: interKey, value: interVal });
				}
			}
		}

		// 4. Authentication & Headers
		const reqHeaders: Record<string, string> = {};
		const authType = (field.httpAuthType || 'none').toLowerCase();

		if (authType === 'bearer') {
			const token = this._interpolateVariables(field.httpAuthToken || '', contextVariables).trim();
			if (token) {
				reqHeaders['Authorization'] = `Bearer ${token}`;
			}
		} else if (authType === 'api_key') {
			const keyName = this._interpolateVariables(field.httpApiKeyName || 'X-API-Key', contextVariables).trim() || 'X-API-Key';
			const keyVal = this._interpolateVariables(field.httpApiKeyValue || '', contextVariables).trim();
			const keyLoc = (field.httpApiKeyLocation || 'header').toLowerCase();
			if (keyVal) {
				if (keyLoc === 'query') {
					activeParams.push({ key: keyName, value: keyVal });
				} else {
					reqHeaders[keyName] = keyVal;
				}
			}
		} else if (authType === 'basic') {
			const u = this._interpolateVariables(field.httpAuthUsername || '', contextVariables);
			const p = this._interpolateVariables(field.httpAuthPassword || '', contextVariables);
			const b64 = typeof btoa === 'function' ? btoa(`${u}:${p}`) : Buffer.from(`${u}:${p}`).toString('base64');
			reqHeaders['Authorization'] = `Basic ${b64}`;
		}

		// Append activeParams to URL query string
		if (activeParams.length > 0 && interpolatedUrl) {
			const urlHasQuery = interpolatedUrl.includes('?');
			const qs = activeParams.map(ap => `${encodeURIComponent(ap.key)}=${encodeURIComponent(ap.value)}`).join('&');
			interpolatedUrl = urlHasQuery ? `${interpolatedUrl}&${qs}` : `${interpolatedUrl}?${qs}`;
		}

		// 5. Custom Headers
		const headersList = Array.isArray(field.httpHeaders) ? field.httpHeaders : [];
		for (const h of headersList) {
			if (h && h.enabled !== false && h.key) {
				const hk = this._interpolateVariables(h.key, contextVariables).trim();
				const hv = this._interpolateVariables(h.value ?? '', contextVariables);
				if (hk) {
					reqHeaders[hk] = hv;
				}
			}
		}

		// 6. Request Body
		let bodyData: string | undefined = undefined;
		const bodyType = (field.httpBodyType || 'none').toLowerCase();
		if (method !== 'GET' && method !== 'HEAD' && bodyType !== 'none') {
			const rawBodyContent = field.httpBodyContent || '';
			const interpolatedBody = this._interpolateVariables(rawBodyContent, contextVariables);

			if (bodyType === 'json') {
				const hasContentType = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-type');
				if (!hasContentType) {
					reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
				}
				bodyData = interpolatedBody;
			} else if (bodyType === 'x-www-form-urlencoded') {
				const hasContentType = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-type');
				if (!hasContentType) {
					reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
				}
				bodyData = interpolatedBody;
			} else {
				// raw / text
				bodyData = interpolatedBody;
			}
		}

		// Default Accept header if not explicitly overridden
		if (!Object.keys(reqHeaders).some(k => k.toLowerCase() === 'accept')) {
			reqHeaders['Accept'] = 'application/json, text/plain, */*';
		}

		// 7. Timeout & AbortController
		const timeoutMs = typeof field.httpTimeoutMs === 'number' && field.httpTimeoutMs > 0 ? field.httpTimeoutMs : 30000;
		const controller = new AbortController();
		this._activeAbortControllers.add(controller);

		const timeoutId = setTimeout(() => {
			controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		try {
			if (this._cancelEpoch !== startEpoch) {
				throw new Error('HTTP Request cancelled by Stop request');
			}
			if (!interpolatedUrl || !/^https?:\/\//i.test(interpolatedUrl)) {
				throw new Error(`Invalid or empty HTTP Request URL: "${interpolatedUrl}"`);
			}

			const fetchOptions: RequestInit = {
				method,
				headers: reqHeaders,
				signal: controller.signal
			};
			if (bodyData !== undefined) {
				fetchOptions.body = bodyData;
			}

			const resp = await fetch(interpolatedUrl, fetchOptions);
			clearTimeout(timeoutId);
			this._activeAbortControllers.delete(controller);

			const durationMs = Date.now() - start;

			// Extract response headers
			const respHeaders: Record<string, string> = {};
			try {
				resp.headers.forEach((v, k) => {
					respHeaders[k.toLowerCase()] = v;
				});
			} catch { }

			// Read response text
			const rawText = await resp.text();

			// Attempt JSON parse
			let parsedJson: unknown = undefined;
			if (rawText && (rawText.trim().startsWith('{') || rawText.trim().startsWith('['))) {
				try {
					parsedJson = JSON.parse(rawText.trim());
				} catch { }
			}

			return {
				status: resp.status,
				statusText: resp.statusText,
				ok: resp.ok,
				headers: respHeaders,
				body: parsedJson !== undefined ? parsedJson : rawText,
				data: parsedJson !== undefined ? parsedJson : null,
				rawText,
				url: interpolatedUrl,
				method,
				durationMs,
				error: !resp.ok ? (() => {
					const statusHead = `HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`;
					let detail = '';
					if (isWorkflowRecord(parsedJson)) {
						const msg = parsedJson.message || parsedJson.detail || parsedJson.error;
						if (typeof msg === 'string' && msg.trim()) {
							detail = msg.trim();
						} else if (msg !== undefined) {
							try { detail = JSON.stringify(msg); } catch { detail = String(msg); }
						}
					}
					if (!detail && rawText && rawText.trim()) {
						detail = rawText.trim();
					}
					if (detail.length > 500) {
						detail = detail.slice(0, 500) + '...';
					}
					return detail ? `${statusHead}: ${detail}` : statusHead;
				})() : undefined
			};
		} catch (err) {
			clearTimeout(timeoutId);
			this._activeAbortControllers.delete(controller);
			const durationMs = Date.now() - start;
			const isAbort = controller.signal.aborted || err?.name === 'AbortError';
			const errMsg = isAbort ? (controller.signal.reason?.message || 'Request timed out') : (err?.message || String(err));
			return {
				status: 0,
				statusText: 'Network / Client Error',
				ok: false,
				headers: {},
				body: null,
				data: null,
				rawText: '',
				url: interpolatedUrl,
				method,
				durationMs,
				error: errMsg
			};
		}
	}

	async executeSshBatchCommands(options: ISshBatchExecutionOptions): Promise<ISshBatchExecutionResult> {
		const ctx = options.contextVariables;
		const interp = (val: string) => ctx ? this._interpolateVariables(val, ctx) : val;

		const resolvedHost = interp(String(options.host || '')).trim();
		const resolvedPort = Number(interp(String(options.port || 22)).trim()) || 22;
		const resolvedUser = interp(String(options.user || 'root')).trim() || 'root';
		const resolvedPassword = interp(String(options.password ?? ''));
		let currentCwd = interp(String(options.cwd || '')).trim();
		const validOutputLines = typeof options.outputLines === 'number' && !isNaN(options.outputLines) && options.outputLines > 0
			? Math.floor(options.outputLines)
			: 50;

		const resolvedCommands = ctx
			? this._resolveSshCommandsForExecution(options.commands || [], ctx)
			: (options.commands || []).map(c => cleanInterpolatedSshCommand(String(c ?? ''))).filter(c => c.length > 0);

		let terminalTranscript = options.existingTerminalLog || '';
		const appendTranscript = (headerLine: string, bodyText: string) => {
			terminalTranscript = terminalTranscript
				? `${terminalTranscript.trimEnd()}\n\n${headerLine}\n${bodyText}`
				: `${headerLine}\n${bodyText}`;
			if (terminalTranscript.length > 48000) {
				terminalTranscript = '...(earlier terminal history truncated)...\n' + terminalTranscript.slice(terminalTranscript.length - 44000);
			}
		};

		if (!resolvedHost) {
			return {
				success: false,
				connectionFailed: true,
				host: '',
				port: resolvedPort,
				user: resolvedUser,
				cwd: currentCwd,
				resolvedCommands,
				rawEntries: [],
				jsonOutput: '{}',
				terminalTranscript,
				exitCode: 1,
				durationMs: 0,
				error: 'SSH Connection Error: Server IP / Host is required.'
			};
		}

		const rawEntries: ISshRawCommandEntry[] = [];
		let totalDurationMs = 0;
		let lastExitCode = 0;

		if (resolvedCommands.length === 0) {
			const connRes = await this.executeSshCommand({
				workspaceUri: options.workspaceUri,
				host: resolvedHost,
				port: resolvedPort,
				user: resolvedUser,
				password: resolvedPassword,
				cwd: currentCwd,
				command: '',
				action: 'connect'
			});
			totalDurationMs += connRes.durationMs || 0;
			lastExitCode = connRes.exitCode;
			if (connRes.cwd) {
				currentCwd = connRes.cwd;
			}
			const rawConnOut = connRes.output || (connRes.error ? `[SSH Connection Error] ${connRes.error}` : '');
			appendTranscript(`${resolvedUser}@${resolvedHost}:${currentCwd || '~'}$ [SSH Login Check]`, rawConnOut || '(Connected)');

			if (connRes.connectionFailed || !connRes.success) {
				return {
					success: false,
					connectionFailed: true,
					host: resolvedHost,
					port: resolvedPort,
					user: resolvedUser,
					cwd: currentCwd,
					resolvedCommands: [],
					rawEntries: [],
					jsonOutput: '{}',
					terminalTranscript,
					exitCode: lastExitCode || 1,
					durationMs: totalDurationMs,
					error: connRes.error || `SSH Connection Failed (${resolvedUser}@${resolvedHost}:${resolvedPort})`
				};
			}
			return {
				success: true,
				connectionFailed: false,
				host: resolvedHost,
				port: resolvedPort,
				user: resolvedUser,
				cwd: currentCwd,
				resolvedCommands: [],
				rawEntries: [],
				jsonOutput: '{}',
				terminalTranscript,
				exitCode: 0,
				durationMs: totalDurationMs
			};
		}

		for (let idx = 0; idx < resolvedCommands.length; idx++) {
			if (options.isCancelled?.()) {
				return {
					success: false,
					connectionFailed: false,
					host: resolvedHost,
					port: resolvedPort,
					user: resolvedUser,
					cwd: currentCwd,
					resolvedCommands,
					rawEntries,
					jsonOutput: formatSshCommandsJsonOutput(rawEntries, validOutputLines),
					terminalTranscript,
					exitCode: 130,
					durationMs: totalDurationMs,
					error: 'SSH execution cancelled by Stop request',
					failedCommandIndex: idx,
					failedCommand: resolvedCommands[idx]
				};
			}

			const cmd = resolvedCommands[idx];
			options.onCommandProgress?.({
				index: idx,
				total: resolvedCommands.length,
				command: cmd,
				phase: 'start',
				cwd: currentCwd
			});

			const sshRes = await this.executeSshCommand({
				workspaceUri: options.workspaceUri,
				host: resolvedHost,
				port: resolvedPort,
				user: resolvedUser,
				password: resolvedPassword,
				cwd: currentCwd,
				command: cmd,
				action: 'exec'
			});
			totalDurationMs += sshRes.durationMs || 0;
			lastExitCode = sshRes.exitCode;

			if (sshRes.connectionFailed) {
				const connErrMsg = sshRes.error || `SSH Connection Failed (${resolvedUser}@${resolvedHost}:${resolvedPort})`;
				appendTranscript(`${resolvedUser}@${resolvedHost}:${currentCwd || '~'}$ ${cmd}`, `[SSH Connection Error] ${connErrMsg}`);
				const partialJson = formatSshCommandsJsonOutput(rawEntries, validOutputLines);
				return {
					success: false,
					connectionFailed: true,
					host: resolvedHost,
					port: resolvedPort,
					user: resolvedUser,
					cwd: currentCwd,
					resolvedCommands,
					rawEntries,
					jsonOutput: partialJson,
					terminalTranscript,
					exitCode: sshRes.exitCode || 255,
					durationMs: totalDurationMs,
					error: connErrMsg,
					failedCommandIndex: idx,
					failedCommand: cmd
				};
			}

			if (sshRes.cwd) {
				currentCwd = sshRes.cwd;
			}
			const rawOut = sshRes.output || (sshRes.error ? sshRes.error : '');
			rawEntries.push({
				command: cmd,
				rawOutput: rawOut
			});
			appendTranscript(`${resolvedUser}@${resolvedHost}:${currentCwd || '~'}$ ${cmd}`, rawOut || '(Command completed with no stdout)');

			const currentJson = formatSshCommandsJsonOutput(rawEntries, validOutputLines);
			options.onCommandProgress?.({
				index: idx,
				total: resolvedCommands.length,
				command: cmd,
				phase: 'done',
				cwd: currentCwd,
				rawOutput: rawOut,
				jsonOutput: currentJson,
				result: sshRes
			});
		}

		const finalJson = formatSshCommandsJsonOutput(rawEntries, validOutputLines);
		return {
			success: true,
			connectionFailed: false,
			host: resolvedHost,
			port: resolvedPort,
			user: resolvedUser,
			cwd: currentCwd,
			resolvedCommands,
			rawEntries,
			jsonOutput: finalJson,
			terminalTranscript,
			exitCode: lastExitCode,
			durationMs: totalDurationMs
		};
	}

	async executeSshCommand(options: ISshCommandOptions): Promise<ISshCommandResult> {
		const startTime = Date.now();
		const host = (options.host || '').trim();
		const port = Number(options.port) || 22;
		const user = (options.user || 'root').trim() || 'root';
		const password = options.password ?? '';
		const cwd = (options.cwd || '').trim();
		const action = options.action || 'exec';
		const rawCommand = (options.command || '').trim();
		const command = rawCommand || (action === 'connect' ? 'echo "Connected to $(hostname) ($(uname -sr 2>/dev/null || uname -a))" && uptime 2>/dev/null || true' : 'pwd');
		const timeoutSec = typeof options.timeoutSec === 'number' && options.timeoutSec > 0 ? options.timeoutSec : 30;

		if (!host) {
			return {
				success: false,
				connectionFailed: true,
				host: '',
				port,
				user,
				cwd,
				command,
				output: '',
				exitCode: 1,
				durationMs: 0,
				error: 'SSH Host / IP is required.'
			};
		}

		const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const tmpDirUri = URI.file('/tmp');
		const inJsonUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_in_${timestamp}.json`);
		const outJsonUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_out_${timestamp}.json`);
		const runnerPyUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_runner_${timestamp}.py`);
		const logUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_log_${timestamp}.log`);

		const payload = {
			host,
			port,
			user,
			password,
			command,
			cwd,
			action,
			timeoutSec
		};

		const pythonRunner = [
			'import sys, os, json, time, pty, select, re, signal',
			'',
			`IN_PATH = ${JSON.stringify(inJsonUri.fsPath)}`,
			`OUT_PATH = ${JSON.stringify(outJsonUri.fsPath)}`,
			'',
			'def main():',
			'    t0 = time.time()',
			'    with open(IN_PATH, "r", encoding="utf-8") as f:',
			'        req = json.load(f)',
			'    host = str(req.get("host") or "").strip()',
			'    port = int(req.get("port") or 22)',
			'    user = str(req.get("user") or "root").strip() or "root"',
			'    password = str(req.get("password") or "")',
			'    cmd = str(req.get("command") or "pwd")',
			'    cwd = str(req.get("cwd") or "").strip()',
			'    timeout_sec = float(req.get("timeoutSec") or 30.0)',
			'',
			'    res = {',
			'        "success": False,',
			'        "connectionFailed": False,',
			'        "host": host,',
			'        "port": port,',
			'        "user": user,',
			'        "cwd": cwd,',
			'        "command": cmd,',
			'        "output": "",',
			'        "exitCode": 1,',
			'        "durationMs": 0',
			'    }',
			'',
			'    safe_cwd = cwd.replace("\'", "\'\\"\'\\"\'") if cwd else ""',
			'    cd_prefix = f"if [ -n \'{safe_cwd}\' ] && [ -d \'{safe_cwd}\' ]; then cd \'{safe_cwd}\' 2>/dev/null; fi\\n" if safe_cwd else ""',
			'    remote_script = (',
			'        f"printf \'\\\\n___ANYAGENT_SSH_CONNECTED___\\\\n\'\\n"',
			'        f"{cd_prefix}"',
			'        f"{cmd}\\n"',
			'        f"__aa_ec=$?\\n"',
			'        f"printf \'\\\\n___ANYAGENT_SSH_META___:%s:%s___\\\\n\' \\"$(pwd)\\" \\"$__aa_ec\\"\\n"',
			'        f"exit $__aa_ec"',
			'    )',
			'',
			'    ssh_args = [',
			'        "ssh",',
			'        "-p", str(port),',
			'        "-o", "StrictHostKeyChecking=no",',
			'        "-o", "UserKnownHostsFile=/dev/null",',
			'        "-o", "LogLevel=ERROR",',
			'        "-o", "ConnectTimeout=10",',
			'        "-o", "NumberOfPasswordPrompts=1",',
			'        "-o", "PreferredAuthentications=password,keyboard-interactive,publickey",',
			'        f"{user}@{host}",',
			'        remote_script',
			'    ]',
			'',
			'    try:',
			'        pid, master_fd = pty.fork()',
			'        if pid == 0:',
			'            os.environ["LC_ALL"] = "C"',
			'            os.environ["TERM"] = "xterm-256color"',
			'            os.execvp("ssh", ssh_args)',
			'            os._exit(127)',
			'',
			'        raw_buf = b""',
			'        output_buf = b""',
			'        password_sent = False',
			'        yes_sent = False',
			'        deadline = time.time() + timeout_sec',
			'        exit_code = None',
			'',
			'        while time.time() < deadline:',
			'            rlist, _, _ = select.select([master_fd], [], [], 0.15)',
			'            if master_fd in rlist:',
			'                try:',
			'                    chunk = os.read(master_fd, 8192)',
			'                except OSError:',
			'                    chunk = b""',
			'                if not chunk:',
			'                    break',
			'                raw_buf += chunk',
			'                output_buf += chunk',
			'                lower_tail = raw_buf[-512:].decode("utf-8", errors="ignore").lower()',
			'                if (not yes_sent) and ("continue connecting" in lower_tail and "yes/no" in lower_tail):',
			'                    try:',
			'                        os.write(master_fd, b"yes\\n")',
			'                        yes_sent = True',
			'                        output_buf = b""',
			'                    except OSError:',
			'                        pass',
			'                elif (not password_sent) and ("password:" in lower_tail or "passphrase" in lower_tail or "verification code" in lower_tail):',
			'                    try:',
			'                        os.write(master_fd, (password + "\\n").encode("utf-8"))',
			'                        password_sent = True',
			'                        output_buf = b""',
			'                    except OSError:',
			'                        pass',
			'            try:',
			'                wpid, wstatus = os.waitpid(pid, os.WNOHANG)',
			'                if wpid == pid:',
			'                    exit_code = os.waitstatus_to_exitcode(wstatus) if hasattr(os, "waitstatus_to_exitcode") else (wstatus >> 8)',
			'                    while True:',
			'                        r2, _, _ = select.select([master_fd], [], [], 0.05)',
			'                        if not r2:',
			'                            break',
			'                        try:',
			'                            c2 = os.read(master_fd, 8192)',
			'                            if not c2:',
			'                                break',
			'                            output_buf += c2',
			'                        except OSError:',
			'                            break',
			'                    break',
			'            except ChildProcessError:',
			'                break',
			'',
			'        if exit_code is None:',
			'            try:',
			'                os.kill(pid, signal.SIGTERM)',
			'            except Exception:',
			'                pass',
			'            try:',
			'                wpid, wstatus = os.waitpid(pid, 0)',
			'                exit_code = os.waitstatus_to_exitcode(wstatus) if hasattr(os, "waitstatus_to_exitcode") else (wstatus >> 8)',
			'            except Exception:',
			'                exit_code = 124',
			'',
			'        try:',
			'            os.close(master_fd)',
			'        except Exception:',
			'            pass',
			'',
			'        text = output_buf.decode("utf-8", errors="replace").replace("\\r\\n", "\\n").replace("\\r", "\\n")',
			'        if password_sent and text.startswith("\\n"):',
			'            text = text[1:]',
			'',
			'        connected_ok = "___ANYAGENT_SSH_CONNECTED___" in text',
			'        if connected_ok:',
			'            text = re.sub(r"\\n?___ANYAGENT_SSH_CONNECTED___\\n?", "", text, count=1)',
			'',
			'        meta_match = re.search(r"\\n?___ANYAGENT_SSH_META___:(.*?):(-?\\d+)___\\n?", text)',
			'        if meta_match:',
			'            detected_cwd = meta_match.group(1).strip()',
			'            detected_ec = int(meta_match.group(2))',
			'            if detected_cwd:',
			'                res["cwd"] = detected_cwd',
			'            exit_code = detected_ec',
			'            text = text[:meta_match.start()] + text[meta_match.end():]',
			'',
			'        clean_text = text.strip("\\n")',
			'        res["output"] = clean_text',
			'        res["exitCode"] = int(exit_code if exit_code is not None else 0)',
			'        if not connected_ok:',
			'            res["connectionFailed"] = True',
			'            res["success"] = False',
			'            err_detail = clean_text or ("exit code " + str(res["exitCode"]))',
			'            res["error"] = f"SSH Connection Failed ({user}@{host}:{port}): {err_detail}"',
			'        else:',
			'            res["success"] = (res["exitCode"] == 0)',
			'            if not res["success"] and not res.get("error"):',
			'                res["error"] = clean_text or f"SSH exited with code {res[\'exitCode\']}"',
			'    except Exception as e:',
			'        res["connectionFailed"] = True',
			'        res["success"] = False',
			'        res["error"] = str(e)',
			'',
			'    res["durationMs"] = int((time.time() - t0) * 1000)',
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

			const workDirUri = options.workspaceUri ? this._toUri(options.workspaceUri) : tmpDirUri;
			const envDetection = await this.detectPythonEnvironment(workDirUri);
			const pythonCmd = envDetection.interpreterPath || 'python3';
			const escapedPython = pythonCmd.includes(' ') ? `"${pythonCmd}"` : pythonCmd;

			const terminal = await this.terminalService.createTerminal({
				config: {
					name: 'AnyAgent SSH Runner',
					cwd: tmpDirUri,
					hideFromUser: true
				}
			});

			const sentinel = `___SSH_OP_${timestamp}___`;
			const cmd = `${escapedPython} "${runnerPyUri.fsPath}" > "${logUri.fsPath}" 2>&1; echo "${sentinel}:$?"`;

			let finished = false;
			let activeEntry: { terminal: ITerminalInstance; abort: () => void; label: string } | undefined;
			const waitPromise = new Promise<void>((resolve) => {
				// Assigned below, once the listeners are registered (finishOnce may run before that)
				const terminalListeners: { data?: { dispose(): void }; exit?: { dispose(): void } } = {};
				const finishOnce = () => {
					if (!finished) {
						finished = true;
						terminalListeners.data?.dispose();
						terminalListeners.exit?.dispose();
						resolve();
					}
				};
				activeEntry = {
					terminal,
					abort: finishOnce,
					label: 'AnyAgent SSH Runner'
				};
				this._activeTerminals.add(activeEntry);
				const regex = new RegExp(`${sentinel}:(\\d+)`);
				terminalListeners.data = terminal.onData(data => {
					if (regex.test(data)) {
						finishOnce();
					}
				});
				terminalListeners.exit = terminal.onExit(() => {
					finishOnce();
				});
				setTimeout(() => {
					finishOnce();
				}, (timeoutSec + 5) * 1000);
			});

			try {
				await terminal.sendText(cmd, true);
				await waitPromise;
			} finally {
				if (activeEntry) {
					this._activeTerminals.delete(activeEntry);
				}
			}

			let resultObj: ISshCommandResult | undefined;
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
				connectionFailed: true,
				host,
				port,
				user,
				cwd,
				command,
				output: logText,
				exitCode: 1,
				durationMs: Date.now() - startTime,
				error: logText || 'SSH runner failed to produce a response.'
			};
		} catch (err) {
			for (const tmpUri of [inJsonUri, outJsonUri, runnerPyUri, logUri]) {
				try {
					if (await this.fileService.exists(tmpUri)) {
						await this.fileService.del(tmpUri);
					}
				} catch { }
			}
			return {
				success: false,
				connectionFailed: true,
				host,
				port,
				user,
				cwd,
				command,
				output: '',
				exitCode: 1,
				durationMs: Date.now() - startTime,
				error: err.message || String(err)
			};
		}
	}

	private _resolveOutputSpecValue(spec: IOutputSpec, contextVariables: Record<string, unknown>): unknown {
		const rawExpr = (spec.sourceExpression || '').trim();
		const outputLabel = spec.label || spec.varName || spec.fieldKey || 'Output';
		const formatAvailableVars = (): string => {
			const keys = Object.keys(contextVariables || {})
				.filter(k => k && !k.startsWith('@') && !k.startsWith('__') && !k.startsWith('comp_'))
				.slice(0, 20);
			return keys.length > 0 ? ` Available variables: ${keys.join(', ')}` : '';
		};
		if (rawExpr) {
			// Exact Python/JSON primitive literals (never treat as undefined variable)
			if (rawExpr === 'None' || rawExpr === 'null') { return null; }
			if (rawExpr === 'True' || rawExpr === 'true') { return true; }
			if (rawExpr === 'False' || rawExpr === 'false') { return false; }
			if (/^-?\d+(\.\d+)?$/.test(rawExpr)) { return Number(rawExpr); }

			// Direct single-variable reference: {var}, {{var}}, @var, or bare identifier var
			const directMatch = rawExpr.match(/^(?:\{\{\s*([^{}]+?)\s*\}\}|\{\s*([^{}]+?)\s*\}|@?([a-zA-Z_][a-zA-Z0-9_]*))$/);
			if (directMatch) {
				const refKey = (directMatch[1] || directMatch[2] || directMatch[3] || '').trim();
				if (refKey) {
					if (Object.prototype.hasOwnProperty.call(contextVariables, refKey) && contextVariables[refKey] !== undefined) {
						return contextVariables[refKey];
					}
					const cleanRef = this._cleanKey(refKey);
					if (Object.prototype.hasOwnProperty.call(contextVariables, cleanRef) && contextVariables[cleanRef] !== undefined) {
						return contextVariables[cleanRef];
					}
					throw new Error(`Output '${outputLabel}' references undefined variable '${rawExpr}'.${formatAvailableVars()}`);
				}
			}
			// Interpolated expression: ensure no {var} / {{var}} placeholder is left unresolved
			const unresolvedRefs: string[] = [];
			const refScanRe = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g;
			let m: RegExpExecArray | null;
			while ((m = refScanRe.exec(rawExpr)) !== null) {
				const rk = (m[1] || m[2] || '').trim();
				if (!rk) { continue; }
				const cleanRk = this._cleanKey(rk);
				const found = (Object.prototype.hasOwnProperty.call(contextVariables, rk) && contextVariables[rk] !== undefined)
					|| (Object.prototype.hasOwnProperty.call(contextVariables, cleanRk) && contextVariables[cleanRk] !== undefined);
				if (!found && !unresolvedRefs.includes(rk)) {
					unresolvedRefs.push(rk);
				}
			}
			if (unresolvedRefs.length > 0) {
				throw new Error(`Output '${outputLabel}' references undefined variable(s): ${unresolvedRefs.map(r => `{${r}}`).join(', ')}.${formatAvailableVars()}`);
			}
			return this._interpolateVariables(rawExpr, contextVariables);
		}
		const k = spec.label || spec.fieldKey;
		return contextVariables[k]
			?? contextVariables[spec.fieldKey]
			?? (spec.varName ? contextVariables[spec.varName] : undefined)
			?? contextVariables[this._cleanKey(k)]
			?? (spec.fieldKey ? contextVariables[this._cleanKey(spec.fieldKey)] : undefined);
	}

	private async _playVoiceNoteClipsSequentially(
		clips: ReadonlyArray<{ audioDataUrl?: string; mimeType?: string }>,
		playbackRate: number
	): Promise<number> {
		let playedCount = 0;
		for (const clip of clips) {
			const dataUrl = clip?.audioDataUrl;
			if (!dataUrl) {
				continue;
			}
			let blobUrl: string | undefined;
			let audioSrc = dataUrl;
			try {
				if (dataUrl.startsWith('data:')) {
					const commaIdx = dataUrl.indexOf(',');
					if (commaIdx !== -1) {
						const header = dataUrl.substring(0, commaIdx);
						const b64 = dataUrl.substring(commaIdx + 1);
						const mimeMatch = header.match(/data:([^;]+)/i);
						const mime = (mimeMatch ? mimeMatch[1] : '') || clip.mimeType || 'audio/webm';
						const bstr = atob(b64);
						const u8arr = new Uint8Array(bstr.length);
						for (let i = 0; i < bstr.length; i++) {
							u8arr[i] = bstr.charCodeAt(i);
						}
						blobUrl = URL.createObjectURL(new Blob([u8arr], { type: mime }));
						audioSrc = blobUrl;
					}
				}
				await new Promise<void>(resolve => {
					const audio = new Audio(audioSrc);
					audio.playbackRate = playbackRate;
					const finish = () => {
						audio.onended = null;
						audio.onerror = null;
						resolve();
					};
					audio.onended = () => {
						playedCount++;
						finish();
					};
					audio.onerror = () => finish();
					void audio.play().catch(() => finish());
				});
			} finally {
				if (blobUrl) {
					try {
						URL.revokeObjectURL(blobUrl);
					} catch { }
				}
			}
		}
		return playedCount;
	}

	async openInteractiveSshTerminal(options: ISshCommandOptions): Promise<void> {
		const host = (options.host || '').trim();
		const port = Number(options.port) || 22;
		const user = (options.user || 'root').trim() || 'root';
		const password = options.password ?? '';
		if (!host) {
			return;
		}

		const terminal = await this.terminalService.createTerminal({
			config: {
				name: `SSH: ${user}@${host}:${port}`
			}
		});
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.revealActiveTerminal();

		if (!password) {
			await terminal.sendText(`ssh -p ${port} -o StrictHostKeyChecking=no ${user}@${host}`, true);
			return;
		}

		const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const tmpDirUri = URI.file('/tmp');
		const cfgUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_interactive_${timestamp}.json`);
		const scriptUri = URI.joinPath(tmpDirUri, `.anyagent_ssh_interactive_${timestamp}.py`);

		const pyInteractive = [
			'import os, sys, json, pty',
			`CFG_PATH = ${JSON.stringify(cfgUri.fsPath)}`,
			'with open(CFG_PATH, "r", encoding="utf-8") as f:',
			'    cfg = json.load(f)',
			'try:',
			'    os.remove(CFG_PATH)',
			'    os.remove(__file__)',
			'except Exception:',
			'    pass',
			'host = cfg.get("host", "")',
			'port = str(cfg.get("port", 22))',
			'user = cfg.get("user", "root")',
			'password = cfg.get("password", "")',
			'pw_sent = [False]',
			'buf = [b""]',
			'def master_read(fd):',
			'    data = os.read(fd, 4096)',
			'    if data and not pw_sent[0]:',
			'        buf[0] = (buf[0] + data)[-512:]',
			'        low = buf[0].decode("utf-8", errors="ignore").lower()',
			'        if "password:" in low or "passphrase" in low:',
			'            os.write(fd, (password + "\\n").encode("utf-8"))',
			'            pw_sent[0] = True',
			'    return data',
			'pty.spawn(["ssh", "-p", port, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", f"{user}@{host}"], master_read)',
		].join('\n');

		await this.fileService.writeFile(cfgUri, VSBuffer.fromString(JSON.stringify({ host, port, user, password })));
		await this.fileService.writeFile(scriptUri, VSBuffer.fromString(pyInteractive));
		await terminal.sendText(`python3 "${scriptUri.fsPath}"`, true);
	}
}
