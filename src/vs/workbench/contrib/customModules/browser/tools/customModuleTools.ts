/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { ICustomModulesService } from '../../common/customModules.js';
import { IWorkspacesExplorerService } from '../../../workspacesExplorer/common/workspacesExplorer.js';
import { CustomFieldType, ICustomField, ICustomModule, IActionButton, IStatusDefinition, DEFAULT_STATUS_DEFINITIONS, normalizeFieldType } from '../../../entityPersistence/common/entityPersistence.js';
import { resolveDefaultModel } from '../../../agentsManager/common/agentsManager.js';
import { getReservedTemplateNameError } from '../../common/freestyleTicket.js';
import { findPlaintextBrowserCredentials, normalizeBrowserCredentials } from '../../common/browserCredentials.js';

export const ListCustomModulesToolId = 'anyagent_list_custom_modules';
export const GenerateCustomModuleToolId = 'anyagent_generate_custom_module';
export const ToggleCustomModuleStatusToolId = 'anyagent_toggle_custom_module_status';
export const DeleteCustomModuleToolId = 'anyagent_delete_custom_module';

function toolResult(data: unknown, message?: string): IToolResult {
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
	'browser',
	'git',
	'parameters',
	'prompt',
	'output',
	'python',
	'tts',
	'media_player',
	'voice_note',
	'table',
	'ssh',
	'http_request',
	'create_tickets',
	'run_tickets',
	'get_outputs',
	'get_ticket',
	'get_tickets',
	'display'
]);

const BASE_PRIMITIVES_CATALOG = [
	{
		type: 'parameters',
		label: 'Inputs (Runtime Variables)',
		description: 'Runtime input parameters and variables for tickets with optional choices. Interpolated via {{param_name}} in URLs and prompts.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'runtime_params',
			label: 'Inputs',
			type: 'parameters',
			parameters: [
				{ id: 'param_1', name: 'start', defaultValue: '0' },
				{ id: 'param_2', name: 'env', defaultValue: 'testing', options: ['testing', 'developing', 'production'] }
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
			get targetProvider() { return resolveDefaultModel({ providerId: 'gemini', modelId: 'gemini-2.5-flash' }).providerId; },
			get targetModel() { return resolveDefaultModel({ providerId: 'gemini', modelId: 'gemini-2.5-flash' }).modelId; },
			targetAgentId: ''
		}
	},
	{
		type: 'tts',
		label: 'Audio / TTS (Text-to-Speech)',
		description: 'Multilingual text-to-speech audio generator using Agent Central AI models. Synthesizes speech into MP3 (default) or WAV/OPUS/AAC and saves the audio file persistently inside the ticket.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'tts_audio',
			label: 'TTS Audio',
			type: 'tts',
			defaultContent: 'Hello! Welcome to AnyAgent multilingual voice synthesis.',
			targetModel: 'tts-1',
			ttsFormat: 'mp3',
			ttsVoice: 'alloy',
			ttsAutoPlay: false
		}
	},
	{
		type: 'media_player',
		label: 'MP3 / MP4 Player',
		description: 'Local HTML5 Audio & Video player supporting MP3, MP4, WAV, M4A, AAC, OGG, FLAC, WebM, MOV, etc. with drag-and-drop file import and 0.25x-2.0x playback speed control. Optional subtitles + dictation (mediaSubtitlesEnabled: true): extracts timed subtitles with a voice model (mediaSubtitleProvider openai|aliyun|gemini|custom or empty for the active voice model, mediaSubtitleModel e.g. whisper-1 / qwen3-asr-flash-us / gemini-2.5-flash, mediaSubtitleLanguage hint), limits mediaMaxUploadMb (default 200) and mediaMaxDurationMin (0 = none), mediaSubtitleDisplayMode single|scroll|dictation (dictation = Dictation practice), mediaDictationUnit segment|seconds with mediaDictationSeconds (>= 1), mediaDictationAutoPause = "Dictation mode" (default true: stop after each sentence / unit so the user can type what they hear; false: playback keeps going). A ticket run uses saved subtitles of the same file or extracts them during the run (a failed extraction fails the step).',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'media_player_1',
			label: 'MP3 / MP4 Player',
			type: 'media_player',
			mediaFilePath: '',
			mediaFileName: '',
			mediaPlaybackRate: 1.0
		}
	},
	{
		type: 'voice_note',
		label: 'Voice Note (Audio Recorder & Transcript)',
		description: 'Records voice clips via microphone with automatic Speech-to-Text transcription and editable text. Automatically surfaces a top-right speaker playback icon when placed in a Workflow Flowchart Node.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'voice_note_1',
			label: 'Voice Note',
			type: 'voice_note',
			voiceClips: [],
			voiceTranscript: '',
			voiceAutoTranscribe: true,
			voicePlaybackRate: 1.0
		}
	},
	{
		type: 'browser',
		label: 'Browser (Web Application)',
		description: 'Opens defaultUrl and extracts the readable page text (retries, then falls back to a plain HTTP GET). The URL supports {variable} references. credentials is a list of {key, value} pairs with names of your choice; write {key} in the URL and the run replaces it with the URL-encoded value (a credential wins over a variable with the same name). Credentials are used only in the URL (no headers, cookies or form login) and are shown as *** in logs, outputs and the stored URL. Values written by the AI must be variable references like {SITE_API_KEY}, never plain text.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'web_browser',
			label: 'Browser',
			type: 'browser',
			defaultUrl: 'https://example.com/api?user={user}&key={api_key}',
			credentials: [
				{ id: 'cred_1', key: 'user', value: '{SITE_USER}' },
				{ id: 'cred_2', key: 'api_key', value: '{SITE_API_KEY}' }
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
		type: 'output',
		label: 'Output',
		description: 'Defines the RESULT of a ticket, node, or workflow as a dictionary {label: value}. Each output item (outputSpecs) takes its value from a variable / expression (sourceExpression, e.g. {summary}, True, or \"Done: {count} rows\") or exports another component (fieldKey). Where the result goes: (1) in a ticket, RUN_TICKETS(...).output and GET_OUTPUTS(ticket) return it; (2) in a workflow, the Output component on the final node (the one right before End) becomes the WORKFLOW OUTPUTS, returned to the caller or to the parent workflow when used as a sub-workflow (one item -> the raw value, several -> a dict). Every ticket template and every workflow should end with an Output; include a success / status flag so callers can tell whether the run succeeded.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'pipeline_output',
			label: 'Output',
			type: 'output',
			outputSpecs: [
				{ label: 'success', sourceExpression: 'True' },
				{ label: 'summary', sourceExpression: '{ai_summary}' },
				{ label: 'row_count', sourceExpression: '{row_count}' }
			]
		}
	},
	{
		type: 'table',
		label: 'Data Table (SQLite / Structured Grid)',
		description: 'Structured database table primitive with typed columns (TEXT, INTEGER, REAL, NUMERIC, BOOLEAN, DATE, DATETIME, JSON, VARCHAR(255), BLOB), manual/clipboard data entry, AI data manipulation, and direct SQLite database storage/sync.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'job_listings_table',
			label: 'Job Listings Table',
			type: 'table',
			tableDbEngine: 'sqlite',
			tableDbTableName: 'job_listings',
			tableColumns: [
				{ id: 'col_1', name: 'job_id', dataType: 'INTEGER', primaryKey: true },
				{ id: 'col_2', name: 'title', dataType: 'TEXT' },
				{ id: 'col_3', name: 'company', dataType: 'TEXT' },
				{ id: 'col_4', name: 'created_at', dataType: 'DATETIME' }
			],
			tableRows: []
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
		description: 'Calendar date. Value is a string "YYYY-MM-DD" (e.g. "2026-11-25"); passed through unchanged at run time.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'expense_date', label: 'Expense Date', type: 'date' }
	},
	{
		type: 'time',
		label: 'Single Time Picker',
		description: 'Time of day. Value is a string "HH:MM" in 24-hour format (e.g. "09:30").',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'incident_time', label: 'Incident Time', type: 'time' }
	},
	{
		type: 'datetime',
		label: 'Single DateTime Picker',
		description: 'Date and time. Value is a string "YYYY-MM-DDTHH:MM" (e.g. "2026-11-25T09:30"); older values may use a space instead of "T".',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'submission_time', label: 'Submission Timestamp', type: 'datetime' }
	},
	{
		type: 'date_range',
		label: 'Date Range (Start ~ End)',
		description: 'Range of dates. Value is one string "start ~ end" with each side "YYYY-MM-DD" (e.g. "2026-11-25 ~ 2026-11-30").',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'travel_period', label: 'Travel Dates', type: 'date_range' }
	},
	{
		type: 'time_range',
		label: 'Time Range (Start ~ End)',
		description: 'Range of times. Value is one string "start ~ end" with each side "HH:MM" (e.g. "09:00 ~ 18:00").',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'working_hours', label: 'Shift Hours', type: 'time_range' }
	},
	{
		type: 'datetime_range',
		label: 'DateTime Range (Start ~ End)',
		description: 'Range of date-times. Value is one string "start ~ end" with each side "YYYY-MM-DDTHH:MM" (e.g. "2026-11-25T09:00 ~ 2026-11-25T18:00").',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'booking_window', label: 'Booking Window', type: 'datetime_range' }
	},
	{
		type: 'dynamic_list',
		label: 'Container (Nested Subfields / Repeating Items)',
		description: 'Nested repeatable line items or sub-table. Supports itemFields (array of sub-fields) or componentRef (reusable class ID). Stored value: a JSON array of entries, one object per entry keyed by sub-field label, with optional "_index" and "_title". In a ticket run it publishes that array as structured JSON (without "_index"; every sub-field label present, "" when empty) under outputVariableName (or the name generated from the label, e.g. expense_items) and under its label, plus {name.json} with the JSON text; an empty list publishes []. Read it as {expense_items}, {expense_items.0.Date} or, in Python, as a list of dicts. Example: [{"_title": "Trip A", "Item Name": "Taxi", "Date": "2026-11-25", "Amount ($)": "12", "Notes": ""}].',
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
		label: 'Attachment (Files)',
		description: 'File upload field for documents, files, proof receipts, or images.',
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
	},
	{
		type: 'http_request',
		label: 'HTTP Request (API / REST Client)',
		description: 'Universal HTTP / REST API communication component supporting GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS with dynamic variable URL, query parameters, custom headers, Bearer/API-Key/Basic authentication, request body, and rich structured JSON output passed cleanly to downstream nodes.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'api_request_1',
			label: 'Create Item',
			type: 'http_request',
			httpUrl: 'https://api.example.com/v1/items',
			httpMethod: 'POST',
			httpAuthType: 'bearer',
			httpAuthToken: '{API_TOKEN}',
			httpHeaders: [
				{ key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true },
				{ key: 'Accept', value: 'application/json', enabled: true }
			],
			httpParams: [],
			httpBodyType: 'json',
			httpBodyContent: '{\n  "name": "{item_name}",\n  "status": "published",\n  "payload": {ai_result_json}\n}'
		}
	},
	{
		type: 'python',
		label: 'Python (Code Automation)',
		description: 'Runs a local Python script. Read upstream values from TICKET_CONTEXT (dict) or directly as globals; return the result by assigning OUTPUT = ... (or calling set_output(value)). Built-ins available: CREATE_TICKETS, RUN_TICKETS, GET_TICKET, GET_TICKETS, GET_OUTPUTS, DISPLAY. Output is exposed downstream as the component variable plus <var>_output / <var>_logs.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'python_1',
			label: 'Clean Dataset',
			type: 'python',
			pythonCode: 'import json\nrows = json.loads(TICKET_CONTEXT.get("raw_rows", "[]"))\nOUTPUT = [r for r in rows if r.get("text")]\n'
		}
	},
	{
		type: 'ssh',
		label: 'SSH Terminal (Remote Linux)',
		description: 'Connects to a remote Linux host and runs the commands in order (stops at the first connection failure). Output is a JSON object mapping each command to its last N output lines. Commands support {var} interpolation. Never put a plain-text password in the config; reference a variable instead.',
		requiresOptions: false,
		supportsItemFields: false,
		example: {
			id: 'ssh_1',
			label: 'Check GPU Server',
			type: 'ssh',
			sshHost: '{gpu_host}',
			sshPort: 22,
			sshUser: 'ubuntu',
			sshCwd: '~',
			sshCommands: ['nvidia-smi', 'df -h'],
			sshOutputLines: 50
		}
	},
	{
		type: 'create_tickets',
		label: 'Create Tickets',
		description: 'Creates a new ticket from another template when this ticket runs. Settings: wfTicketType (template id, required), wfTicketTitle (supports {var}), wfTicketPath (folder, default "."), wfTicketParams {inputName: value or {var}}. Output: a ticket handle usable by Run Tickets / Get Outputs as {var}. The reserved types "freestyle" and "sub_workflow" cannot be created here (a sub-workflow is created only by encapsulating nodes on a workflow canvas).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'new_run', label: 'New Run', type: 'create_tickets', wfTicketType: 'training_run', wfTicketTitle: 'Run {run_no}', wfTicketParams: { lr: '{lr}' } }
	},
	{
		type: 'run_tickets',
		label: 'Run Tickets',
		description: 'Runs another ticket. Settings: wfTicketTarget (ticket id or {var} handle, required), wfTicketParams (Inputs overrides). Output: {success, status, output, error}.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'run_it', label: 'Run It', type: 'run_tickets', wfTicketTarget: '{new_run}' }
	},
	{
		type: 'get_outputs',
		label: 'Get Outputs',
		description: 'Reads another ticket\'s Output dictionary. Settings: wfTicketTarget (required), wfTicketField (optional item name).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'run_result', label: 'Run Result', type: 'get_outputs', wfTicketTarget: '{new_run}', wfTicketField: 'accuracy' }
	},
	{
		type: 'get_ticket',
		label: 'Get Ticket',
		description: 'Reads one ticket (or one of its fields). Settings: wfTicketTarget (id / name / path / {var}, required), wfTicketField (optional). For a sub_workflow ticket the result has subWorkflow: its full calling contract (inputs with defaults, outputs, source workflow).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'parent', label: 'Parent', type: 'get_ticket', wfTicketTarget: 'JOB-0001' }
	},
	{
		type: 'get_tickets',
		label: 'Get Tickets',
		description: 'Searches several tickets (AND of filters; give at least one). Settings: wfTicketType, wfTicketStatus, wfTicketTitle (substring), wfTicketPath (folder), wfTicketField (return one field per ticket). Output: a list. To discover reusable sub-workflows use wfTicketType "sub_workflow" (each item has subWorkflow {name, inputs, outputs, sourceWorkflow}); call one from a workflow node with a Call Sub-Workflow step whose subWorkflowId is that ticket ID.',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'done_runs', label: 'Done Runs', type: 'get_tickets', wfTicketType: 'training_run', wfTicketStatus: 'Done' }
	},
	{
		type: 'display',
		label: 'Display',
		description: 'Shows a value in the Live Output panel while running (no variable is produced). Settings: wfDisplayValue (Python expression, required).',
		requiresOptions: false,
		supportsItemFields: false,
		example: { id: 'show_progress', label: 'Show Progress', type: 'display', wfDisplayValue: 'row_count' }
	}
];

type ConfigPropKind = 'string' | 'number' | 'boolean' | 'stringArray' | 'objectArray' | 'object' | 'credentialArray';

/**
 * Per-component configuration the AI may set through `config` (validated and copied onto the field). This is the single
 * source for both the copy logic and the tool description, so they cannot drift apart.
 */
const COMPONENT_CONFIG_PROPS: Readonly<Record<string, Readonly<Record<string, ConfigPropKind>>>> = {
	text: { defaultContent: 'string', required: 'boolean' },
	textarea: { defaultContent: 'string', required: 'boolean' },
	number: { defaultContent: 'string' },
	select: { defaultContent: 'string' },
	multiselect: { defaultContent: 'string' },
	switch: { defaultContent: 'string' },
	date: { defaultContent: 'string' },
	time: { defaultContent: 'string' },
	datetime: { defaultContent: 'string' },
	date_range: { defaultContent: 'string' },
	time_range: { defaultContent: 'string' },
	datetime_range: { defaultContent: 'string' },
	prompt: { defaultUserPrompt: 'string', defaultUserPrompts: 'stringArray', defaultContent: 'string', targetProvider: 'string', targetModel: 'string', targetCredentialId: 'string' },
	python: { pythonCode: 'string', pythonPath: 'string', pythonEnvMode: 'string', externalScripts: 'stringArray' },
	http_request: { httpUrl: 'string', httpMethod: 'string', httpParams: 'objectArray', httpHeaders: 'objectArray', httpAuthType: 'string', httpAuthToken: 'string', httpApiKeyName: 'string', httpApiKeyValue: 'string', httpApiKeyLocation: 'string', httpAuthUsername: 'string', httpAuthPassword: 'string', httpBodyType: 'string', httpBodyContent: 'string', httpTimeoutMs: 'number' },
	ssh: { sshHost: 'string', sshPort: 'number', sshUser: 'string', sshPassword: 'string', sshCwd: 'string', sshCommands: 'stringArray', sshOutputLines: 'number' },
	browser: { defaultUrl: 'string', browserMaxRetries: 'number', browserRetryDelayMs: 'number', credentials: 'credentialArray' },
	tts: { defaultContent: 'string', ttsVoice: 'string', ttsFormat: 'string', targetProvider: 'string', targetModel: 'string', targetCredentialId: 'string', ttsAutoPlay: 'boolean', ttsPlaybackRate: 'number' },
	media_player: { mediaFilePath: 'string', mediaPlaybackRate: 'number', mediaAutoPlay: 'boolean', mediaSubtitlesEnabled: 'boolean', mediaSubtitleProvider: 'string', mediaSubtitleModel: 'string', mediaSubtitleLanguage: 'string', mediaMaxUploadMb: 'number', mediaMaxDurationMin: 'number', mediaSubtitleDisplayMode: 'string', mediaDictationUnit: 'string', mediaDictationSeconds: 'number', mediaDictationAutoPause: 'boolean' },
	voice_note: { voiceRunInFlow: 'boolean', voiceAutoTranscribe: 'boolean' },
	table: { tableSqlQuery: 'string' },
	git: { gitRemoteUrl: 'string', gitBranch: 'string' },
	create_tickets: { wfTicketType: 'string', wfTicketTitle: 'string', wfTicketPath: 'string', wfTicketParams: 'object' },
	run_tickets: { wfTicketTarget: 'string', wfTicketParams: 'object' },
	get_outputs: { wfTicketTarget: 'string', wfTicketField: 'string' },
	get_ticket: { wfTicketTarget: 'string', wfTicketField: 'string' },
	get_tickets: { wfTicketType: 'string', wfTicketStatus: 'string', wfTicketTitle: 'string', wfTicketPath: 'string', wfTicketField: 'string' },
	display: { wfDisplayValue: 'string' }
};

/** Secrets must reference a variable ({token}) instead of containing the plain-text value. */
const SECRET_CONFIG_PROPS: ReadonlySet<string> = new Set(['httpAuthToken', 'httpApiKeyValue', 'httpAuthPassword', 'sshPassword']);

/** Settings available to every component. */
const COMMON_CONFIG_PROPS: Readonly<Record<string, ConfigPropKind>> = { outputVariableName: 'string', disabled: 'boolean' };

function describeComponentConfigProps(): string {
	return Object.entries(COMPONENT_CONFIG_PROPS).map(([type, props]) => `${type}: ${Object.keys(props).join(', ')}`).join('; ');
}

/** Copies the allowed `config` keys for a component type onto the field, coercing simple types. Returns an error message or undefined. */
function applyComponentConfig(field: ICustomField, type: string, config: Record<string, unknown>): string | undefined {
	const allowed = { ...COMMON_CONFIG_PROPS, ...(COMPONENT_CONFIG_PROPS[type] || {}) };
	const target = field as unknown as Record<string, unknown>;
	for (const [key, raw] of Object.entries(config)) {
		const kind = allowed[key];
		if (!kind || raw === undefined || raw === null) {
			continue;
		}
		if (SECRET_CONFIG_PROPS.has(key) && String(raw).trim() && !/\{[^{}]+\}/.test(String(raw))) {
			return `'${field.label}.${key}' must reference a variable such as {API_TOKEN}; plain-text secrets are not allowed.`;
		}
		switch (kind) {
			case 'string': target[key] = typeof raw === 'string' ? raw : JSON.stringify(raw); break;
			case 'number': {
				const n = Number(raw);
				if (!Number.isFinite(n)) { return `'${field.label}.${key}' must be a number.`; }
				target[key] = n;
				break;
			}
			case 'boolean': target[key] = raw === true || raw === 'true'; break;
			case 'stringArray': target[key] = (Array.isArray(raw) ? raw : [raw]).map(v => String(v)); break;
			case 'objectArray': {
				if (!Array.isArray(raw)) { return `'${field.label}.${key}' must be an array.`; }
				target[key] = raw.filter(v => v && typeof v === 'object').map(v => ({ enabled: true, ...(v as object) }));
				break;
			}
			case 'object': {
				if (typeof raw !== 'object' || Array.isArray(raw)) { return `'${field.label}.${key}' must be an object.`; }
				target[key] = { ...(raw as object) };
				break;
			}
			case 'credentialArray': {
				// Browser credentials: [{ key, value }], referenced in the URL as {key}; values must be variable references
				if (!Array.isArray(raw)) { return `'${field.label}.${key}' must be an array of { key, value }.`; }
				const plaintext = findPlaintextBrowserCredentials(raw);
				if (plaintext.length > 0) {
					return `'${field.label}.${key}' value(s) for ${plaintext.join(', ')} must reference a variable such as {SITE_API_KEY}; plain-text secrets are not allowed.`;
				}
				target[key] = Array.from(normalizeBrowserCredentials(raw).entries()).map(([name, value], idx) => ({ id: `cred_${idx + 1}`, key: name, value }));
				break;
			}
		}
	}
	return undefined;
}

/** Field types the AI may use, derived from VALID_FIELD_TYPES so the tool schema can never drift from validation. */
function aiFieldTypes(): string[] {
	return Array.from(VALID_FIELD_TYPES);
}

/** One-line list of the base primitives, generated from the catalog so the tool description always matches what is returned. */
function describeBasePrimitives(): string {
	return `${BASE_PRIMITIVES_CATALOG.length} base primitives: ${BASE_PRIMITIVES_CATALOG.map(p => p.type).join(', ')}`;
}

async function resolveWorkspaceUri(workspacesExplorerService: IWorkspacesExplorerService, workspaceId?: string): Promise<URI | undefined> {
	try {
		const workspaces = await workspacesExplorerService.getWorkspaces();
		if (!workspaces || workspaces.length === 0) { return undefined; }

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
			modelDescription: `List all existing Custom Modules, the available Base Primitives (${describeBasePrimitives()}), and reusable composite component classes. Use this to discover available field building blocks before synthesizing a custom module schema.`,
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.layout,
			inputSchema: {
				type: 'object',
				properties: {
					workspace_id: {
						type: 'string',
						description: 'Optional workspace identifier or name to scope lookup.'
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
		} catch (err) {
			return toolError(`Failed to list custom modules: ${(err as Error).message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

// -------------------------------------------------------------
// 2. anyagent_generate_custom_module
// -------------------------------------------------------------
/** A table column as provided by the model; values are validated/coerced before use. */
interface IGenerateTableColumnParameter {
	id?: string;
	name?: unknown;
	dataType?: unknown;
	primaryKey?: unknown;
}

/** A `parameters` component entry as provided by the model; values are validated/coerced before use. */
interface IGenerateParameterDefinitionParameter {
	name?: unknown;
	label?: unknown;
	defaultValue?: unknown;
	options?: unknown;
	description?: unknown;
}

/** An `output` component spec as provided by the model; values are validated/coerced before use. */
interface IGenerateOutputSpecParameter {
	label?: unknown;
	sourceExpression?: unknown;
	fieldKey?: unknown;
	enabled?: unknown;
	defaultFormat?: unknown;
	varName?: unknown;
}

export interface IGenerateCustomModuleFieldParameter {
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
	tableDbPath?: unknown;
	tableDbTableName?: unknown;
	tableColumns?: Array<IGenerateTableColumnParameter>;
	tableRows?: unknown;
	parameters?: Array<IGenerateParameterDefinitionParameter | null | undefined>;
	outputSpecs?: Array<IGenerateOutputSpecParameter | null | undefined>;
	/** Component settings may be nested in `config` ... */
	config?: unknown;
	/** ... or given directly on the field (any key of the component's config catalog). */
	[configKey: string]: unknown;
}

export interface IGenerateCustomModuleParameters {
	module_id: string;
	module_name?: string;
	color?: string;
	type_definition?: string;
	type_prompt?: string;
	storage_scope?: 'global' | 'workspace';
	fields?: IGenerateCustomModuleFieldParameter[];
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
			modelDescription: 'Synthesize and register a new Custom Module (entity type schema) or update an existing module in AnyAgent. Extracts Type Definition (business purpose) and Type Prompt (system instructions for AI processing tickets of this type) from user voice/text description, structures appropriate fields using Base Primitives and Reusable Classes, writes YAML definition, and opens Schema Designer for interactive visual review.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.extensions,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: 'Unique kebab-case or snake-case identifier for the module (e.g. \'expense_reimbursement\', \'reimbursement_approval\', \'contract_review\'). \'freestyle\' (in any spelling, e.g. \'free-style\') is reserved and cannot be used as a module id or name.'
					},
					module_name: {
						type: 'string',
						description: 'Human-readable display name for the module (e.g. \'Expense Reimbursement\', \'Leave Request\', \'Purchase Order\').'
					},
					color: {
						type: 'string',
						description: 'Theme hex color code for this module badge (e.g. \'#10b981\' emerald/finance, \'#3b82f6\' blue/process, \'#8b5cf6\' purple/workflow, \'#f59e0b\' amber, \'#ef4444\' red). Defaults to \'#10b981\'.'
					},
					type_definition: {
						type: 'string',
						description: 'Business purpose and semantic definition of this entity type extracted from user description. Explains what this entity is, why it is used, and its role in business operations.'
					},
					type_prompt: {
						type: 'string',
						description: 'AI system instruction / prompt specifically guiding AI agents on how to process, audit, validate, calculate, and route tickets of this module type.'
					},
					storage_scope: {
						type: 'string',
						enum: ['global', 'workspace'],
						description: 'Storage scope: \'global\' applies across all workspaces, \'workspace\' stores within current workspace. Defaults to \'global\'.'
					},
					fields: {
						type: 'array',
						description: 'Array of fields composing this entity type.',
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description: 'Field identifier (e.g. \'total_amount\', \'category\', \'expense_items\', \'receipts\').'
								},
								label: {
									type: 'string',
									description: 'Display label for the field (e.g. \'Total Amount\', \'Expense Category\', \'Line Items\', \'Receipts\').'
								},
								type: {
									type: 'string',
									enum: aiFieldTypes(),
									description: 'Component type from Base Primitives catalog.'
								},
								tableColumns: {
									type: 'array',
									description: 'Column definitions if type is \'table\' (each with name, dataType such as TEXT/INTEGER/REAL/NUMERIC/BOOLEAN/DATE/DATETIME/JSON/BLOB, and optional primaryKey).',
									items: {
										type: 'object',
										properties: {
											id: { type: 'string' },
											name: { type: 'string', description: 'Column header / SQL column name' },
											dataType: { type: 'string', description: 'SQLite / SQL column data type (e.g. TEXT, INTEGER, REAL, NUMERIC, BOOLEAN, DATE, DATETIME, JSON, VARCHAR(255), BLOB)' },
											primaryKey: { type: 'boolean' }
										},
										required: ['name', 'dataType']
									}
								},
								tableDbPath: {
									type: 'string',
									description: 'Optional SQLite database file path (.db / .sqlite) if type is \'table\'.'
								},
								tableDbTableName: {
									type: 'string',
									description: 'Optional target SQLite table name if type is \'table\'.'
								},
								options: {
									type: 'array',
									items: { type: 'string' },
									description: 'Options array for \'select\' or \'multiselect\' fields.'
								},
								itemFields: {
									type: 'array',
									description: 'Sub-fields array if type is \'dynamic_list\' (nested sub-table / repeating items).'
								},
								componentRef: {
									type: 'string',
									description: 'Optional ID of a reusable class if referencing a composite component.'
								},
								unit: {
									type: 'string',
									description: 'Optional unit or currency/measurement symbol for numeric fields (e.g. \'$\', \'kg\', \'%\', \'hours\', \'pts\').'
								},
								precision: {
									type: 'number',
									description: 'Decimal places precision for numeric fields. Defaults to 2 (e.g. 0.00).'
								},
								min: { type: 'number', description: 'Minimum allowed value for numeric fields.' },
								max: { type: 'number', description: 'Maximum allowed value for numeric fields.' },
								step: { type: 'number', description: 'Stepping increment for numeric fields.' },
								buttons: {
									type: 'array',
									description: 'Array of action transition buttons if type is \'button_group\'.',
									items: {
										type: 'object',
										properties: {
											id: { type: 'string', description: 'Button identifier' },
											label: { type: 'string', description: 'Button display label' },
											color: { type: 'string', description: 'Hex color for button' },
											targetStatus: { type: 'string', description: 'Target status stage to transition ticket to upon click' }
										},
										required: ['id', 'label']
									}
								},
								parameters: {
									type: 'array',
									description: 'Input definitions if type is \'parameters\' (the Inputs component). Each input becomes a variable that later components can reference as {name}; callers fill them via CREATE_TICKETS / RUN_TICKETS params.',
									items: {
										type: 'object',
										properties: {
											name: { type: 'string', description: 'Variable name (letters, digits, underscore).' },
											label: { type: 'string', description: 'Optional display label. Default: name.' },
											defaultValue: { type: 'string', description: 'Optional default value; may reference another variable as {var}. Default: empty.' },
											options: { type: 'array', items: { type: 'string' }, description: 'Optional allowed values (renders a dropdown).' },
											description: { type: 'string', description: 'Optional help text.' }
										},
										required: ['name']
									}
								},
								config: {
									type: 'object',
									description: `Component settings, by type (all optional; omitted settings use the defaults): ${describeComponentConfigProps()}. Every type also accepts outputVariableName and disabled. Text can reference earlier values as {variable}. Secrets (httpAuthToken, httpApiKeyValue, httpAuthPassword, sshPassword, and every browser credentials value) MUST be a variable reference like {API_TOKEN}, never the plain value. Browser credentials are [{key, value}] pairs referenced in defaultUrl as {key}. Inputs use 'parameters', Output uses 'outputSpecs', table columns use 'tableColumns'.`,
									additionalProperties: true
								},
								outputSpecs: {
									type: 'array',
									description: 'Output items if type is \'output\'. The Output component defines the RESULT of the ticket: a dictionary {label: value} returned by RUN_TICKETS(...).output and GET_OUTPUTS(ticket). Always include at least one item; a status flag such as {label: \'success\', sourceExpression: \'True\'} is recommended.',
									items: {
										type: 'object',
										properties: {
											label: { type: 'string', description: 'Key of this item in the result dictionary.' },
											sourceExpression: { type: 'string', description: 'Where the value comes from: a variable reference such as {summary} or summary, a literal (True / 42), or a template string with {var} placeholders. Omit it and set fieldKey to export another component\'s value instead.' },
											fieldKey: { type: 'string', description: 'Alternative to sourceExpression: id or label of another component in this module whose value is exported.' },
											varName: { type: 'string', description: 'Optional Python variable name for this item. Default: derived from label.' },
											defaultFormat: { type: 'string', enum: ['text', 'markdown', 'json', 'table'], description: 'Display format, used only with fieldKey. Default: table.' },
											enabled: { type: 'boolean', description: 'Default: true.' }
										},
										required: ['label']
									}
								}
							},
							required: ['id', 'label', 'type']
						}
					},
					statuses: {
						type: 'array',
						description: 'Custom operational lifecycle statuses for tickets of this module type. If omitted, defaults to the 5 canonical stages (Todo, In Progress, Done, Blocked, Removed).',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string', description: 'Unique status stage identifier' },
								label: { type: 'string', description: 'Status stage display name' },
								color: { type: 'string', description: 'Hex color code for status stage badge' },
								category: {
									type: 'string',
									enum: ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'],
									description: 'Canonical lifecycle bucket to map this custom status into'
								},
								description: { type: 'string', description: 'Optional description of what this stage represents' }
							},
							required: ['id', 'label', 'color', 'category']
						}
					},
					workspace_id: {
						type: 'string',
						description: 'Target workspace ID or name if scoping to a specific workspace.'
					},
					auto_open: {
						type: 'boolean',
						description: 'Whether to automatically open the visual Schema Designer editor in Workbench upon creation. Defaults to true.'
					}
				},
				required: ['module_id']
			}
		};
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		try {
			const params = invocation.parameters as IGenerateCustomModuleParameters;
			if (!params || !params.module_id) {
				return toolError('Missing required parameter: \'module_id\' must be provided.');
			}

			const rawId = params.module_id.trim();
			const cleanId = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
			if (!cleanId) {
				return toolError(`Invalid module_id '${params.module_id}'. Must contain valid letters or numbers.`);
			}

			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);

			// CRITICAL: getCustomModules first so we can preserve existing module properties & fields when updating
			const existingModules = await this.customModulesService.getCustomModules(workspaceUri);
			const existingMod = existingModules.find(m => m.id.toLowerCase() === cleanId.toLowerCase());

			if (!existingMod && !params.module_name) {
				return toolError('Missing required parameter: \'module_name\' must be provided when creating a new module.');
			}

			// "freestyle" is reserved for Freestyle tickets (no template): never create or rename a template to it
			const reservedNameError = getReservedTemplateNameError(
				{ id: cleanId, name: (params.module_name || existingMod?.name || cleanId).trim() },
				existingMod ? { id: existingMod.id, name: existingMod.name } : undefined
			);
			if (reservedNameError) {
				return toolError(reservedNameError);
			}

			// Clean and validate fields if provided
			const rawFields = Array.isArray(params.fields) ? params.fields : [];
			let finalFields: ICustomField[];

			if (rawFields.length === 0 && existingMod && Array.isArray(existingMod.fields) && existingMod.fields.length > 0) {
				// Preserve existing fields verbatim (including Python scripts, Prompt configs, SQLite tables, etc.)
				finalFields = JSON.parse(JSON.stringify(existingMod.fields));
			} else {
				const cleanedFields: ICustomField[] = [];

				for (let idx = 0; idx < rawFields.length; idx++) {
					const f = rawFields[idx];
					if (!f || !f.id || !f.label || !f.type) {
						continue;
					}
					const fieldType = normalizeFieldType(f.type.toLowerCase()) as CustomFieldType;
					if (!VALID_FIELD_TYPES.has(fieldType)) {
						return toolError(`Field '${f.id}' has invalid type '${f.type}'. Allowed types: ${Array.from(VALID_FIELD_TYPES).join(', ')}`);
					}

					const fieldId = f.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
					const existingFieldMatch = existingMod?.fields?.find(
						ef => ef.id.toLowerCase() === fieldId.toLowerCase() || (ef.label && ef.label.toLowerCase() === f.label.trim().toLowerCase())
					);

					const cleanField: ICustomField = {
						...(existingFieldMatch ? JSON.parse(JSON.stringify(existingFieldMatch)) : {}),
						id: existingFieldMatch?.id || fieldId,
						label: f.label.trim(),
						type: fieldType
					};

					if (fieldType === 'select' || fieldType === 'multiselect') {
						if (Array.isArray(f.options) && f.options.length > 0) {
							cleanField.options = f.options.map(opt => String(opt).trim()).filter(Boolean);
						} else if (!cleanField.options || cleanField.options.length === 0) {
							cleanField.options = ['Option 1', 'Option 2', 'Option 3'];
						}
					}

					if (fieldType === 'dynamic_list') {
						if (Array.isArray(f.itemFields) && f.itemFields.length > 0) {
							cleanField.itemFields = f.itemFields.map((sub: ICustomField, sIdx: number) => {
								const subType = normalizeFieldType(sub.type ? sub.type.toLowerCase() : 'text') as CustomFieldType;
								const subClean: ICustomField = {
									id: (sub.id || `sub_${sIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
									label: (sub.label || `Item ${sIdx + 1}`).trim(),
									type: VALID_FIELD_TYPES.has(subType) ? subType : 'text'
								};
								if ((subType === 'select' || subType === 'multiselect') && Array.isArray(sub.options)) {
									subClean.options = sub.options.map((o: unknown) => String(o).trim()).filter(Boolean);
								}
								return subClean;
							});
						} else if (f.componentRef) {
							cleanField.componentRef = f.componentRef.trim();
						} else if (!cleanField.itemFields || cleanField.itemFields.length === 0) {
							cleanField.itemFields = [
								{ id: 'item_name', label: 'Item Name', type: 'text' },
								{ id: 'description', label: 'Description', type: 'textarea' }
							];
						}
					}

					if (fieldType === 'button_group') {
						if (Array.isArray(f.buttons) && f.buttons.length > 0) {
							cleanField.buttons = f.buttons.map((b: IActionButton, bIdx: number) => ({
								id: (b.id || `btn_${bIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
								label: (b.label || `Action ${bIdx + 1}`).trim(),
								color: b.color && /^#[0-9a-fA-F]{3,8}$/.test(b.color.trim()) ? b.color.trim() : '#3b82f6',
								targetStatus: b.targetStatus ? String(b.targetStatus).trim() : undefined
							}));
						} else if (!cleanField.buttons || cleanField.buttons.length === 0) {
							cleanField.buttons = [
								{ id: 'btn_approve', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
								{ id: 'btn_reject', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
							];
						}
					}

					if (fieldType === 'number') {
						if (f.unit !== undefined) { cleanField.unit = f.unit ? String(f.unit).trim() : undefined; }
						if (typeof f.precision === 'number') { cleanField.precision = f.precision; }
						else if (cleanField.precision === undefined) { cleanField.precision = 2; }
						if (typeof f.min === 'number') { cleanField.min = f.min; }
						if (typeof f.max === 'number') { cleanField.max = f.max; }
						if (typeof f.step === 'number') { cleanField.step = f.step; }
					}

					if (fieldType === 'table') {
						cleanField.tableDbEngine = 'sqlite';
						if (f.tableDbPath !== undefined) {
							cleanField.tableDbPath = String(f.tableDbPath).trim();
						} else if (!cleanField.tableDbPath) {
							cleanField.tableDbPath = '';
						}
						if (f.tableDbTableName !== undefined) {
							cleanField.tableDbTableName = String(f.tableDbTableName).trim();
						} else if (!cleanField.tableDbTableName) {
							cleanField.tableDbTableName = fieldId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
						}
						if (Array.isArray(f.tableColumns) && f.tableColumns.length > 0) {
							cleanField.tableColumns = f.tableColumns.map((col: IGenerateTableColumnParameter, cIdx: number) => ({
								id: (col.id || `col_${cIdx + 1}`).trim(),
								name: String(col.name || `column_${cIdx + 1}`).trim(),
								dataType: String(col.dataType || 'TEXT').toUpperCase().trim(),
								primaryKey: Boolean(col.primaryKey)
							}));
						} else if (!cleanField.tableColumns || cleanField.tableColumns.length === 0) {
							cleanField.tableColumns = [
								{ id: 'col_1', name: 'id', dataType: 'INTEGER', primaryKey: true },
								{ id: 'col_2', name: 'name', dataType: 'TEXT' },
								{ id: 'col_3', name: 'status', dataType: 'TEXT' },
								{ id: 'col_4', name: 'created_at', dataType: 'DATETIME' }
							];
						}
						if (Array.isArray(f.tableRows)) {
							cleanField.tableRows = f.tableRows;
						} else if (!cleanField.tableRows) {
							cleanField.tableRows = [];
						}
					}

					{
						// Settings may be given inside `config` or (as in the catalog examples) directly on the field
						const allowedKeys = Object.keys({ ...COMMON_CONFIG_PROPS, ...(COMPONENT_CONFIG_PROPS[fieldType] || {}) });
						const merged: Record<string, unknown> = {};
						for (const key of allowedKeys) {
							if (f[key] !== undefined) { merged[key] = f[key]; }
						}
						if (f.config && typeof f.config === 'object') {
							Object.assign(merged, f.config);
						}
						const configError = applyComponentConfig(cleanField, fieldType, merged);
						if (configError) {
							return toolError(configError);
						}
					}

					if (fieldType === 'parameters' && Array.isArray(f.parameters)) {
						cleanField.parameters = f.parameters
							.filter((pd): pd is IGenerateParameterDefinitionParameter => !!(pd && String(pd.name || '').trim()))
							.map((pd: IGenerateParameterDefinitionParameter, pIdx: number) => ({
								id: `param_${pIdx + 1}`,
								name: String(pd.name).trim().replace(/[^a-zA-Z0-9_]/g, '_'),
								label: pd.label ? String(pd.label).trim() : undefined,
								defaultValue: pd.defaultValue !== undefined ? String(pd.defaultValue) : '',
								options: Array.isArray(pd.options) ? pd.options.map((o: unknown) => String(o)) : undefined,
								description: pd.description ? String(pd.description) : ''
							}));
					}

					if (fieldType === 'output' && Array.isArray(f.outputSpecs)) {
						cleanField.outputSpecs = f.outputSpecs
							.filter((os): os is IGenerateOutputSpecParameter => !!(os && String(os.label || '').trim()))
							.map((os: IGenerateOutputSpecParameter) => {
								const label = String(os.label).trim();
								const sourceExpression = os.sourceExpression !== undefined ? String(os.sourceExpression).trim() : '';
								const fieldKey = os.fieldKey ? String(os.fieldKey).trim() : '';
								const isCustom = !!sourceExpression || !fieldKey;
								return {
									fieldKey: fieldKey || label,
									label,
									enabled: os.enabled !== false,
									defaultFormat: typeof os.defaultFormat === 'string' && ['text', 'markdown', 'json', 'table'].includes(os.defaultFormat) ? os.defaultFormat : (isCustom ? 'text' : 'table'),
									isCustom,
									varName: os.varName ? String(os.varName).trim() : undefined,
									varNameManual: !!os.varName,
									sourceExpression: isCustom ? (sourceExpression || `{${label}}`) : undefined
								};
							});
					}

					cleanedFields.push(cleanField);
				}

				// Enforce only Title as mandatory root field at index 0 (Description is optional)
				const titleField: ICustomField = {
					id: 'title',
					label: 'Title',
					type: 'text',
					required: true
				};
				finalFields = [
					titleField,
					...cleanedFields.filter(f =>
						f.id.toLowerCase() !== 'title' &&
						f.label.toLowerCase() !== 'title'
					)
				];
			}

			const color = params.color && /^#[0-9a-fA-F]{3,8}$/.test(params.color.trim())
				? params.color.trim()
				: (existingMod?.color || '#10b981');

			let cleanedStatuses: IStatusDefinition[] | undefined;
			if (Array.isArray(params.statuses) && params.statuses.length > 0) {
				cleanedStatuses = params.statuses.map((st: IStatusDefinition, sIdx: number) => {
					const cat = ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'].includes(st.category) ? st.category : 'Todo';
					return {
						id: (st.id || `status_${sIdx + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_'),
						label: (st.label || st.id || `Status ${sIdx + 1}`).trim(),
						color: st.color && /^#[0-9a-fA-F]{3,8}$/.test(st.color.trim()) ? st.color.trim() : '#818cf8',
						category: cat,
						description: st.description ? String(st.description).trim() : undefined
					};
				});
			} else if (existingMod && Array.isArray(existingMod.statuses) && existingMod.statuses.length > 0) {
				cleanedStatuses = JSON.parse(JSON.stringify(existingMod.statuses));
			} else {
				cleanedStatuses = DEFAULT_STATUS_DEFINITIONS.map(d => ({ ...d }));
			}

			const newModule: ICustomModule = {
				...(existingMod ? JSON.parse(JSON.stringify(existingMod)) : {}),
				id: cleanId,
				name: (params.module_name || existingMod?.name || cleanId).trim(),
				color: color,
				storageScope: params.storage_scope ? (params.storage_scope === 'workspace' ? 'workspace' : 'global') : (existingMod?.storageScope || 'global'),
				description: params.type_definition !== undefined ? String(params.type_definition).trim() : (existingMod?.description || ''),
				prompt: params.type_prompt !== undefined ? String(params.type_prompt).trim() : (existingMod?.prompt || ''),
				updatedAt: Date.now(),
				fields: finalFields,
				statuses: cleanedStatuses
			};

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

			// Open Schema Designer editor if auto_open is explicitly true or when creating a new module (not needed if already open & updating)
			let designerOpened = false;
			if (params.auto_open !== false && !replaced) {
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
			}, `Custom Module '${newModule.name}' (${newModule.id}) successfully ${replaced ? 'updated' : 'created'} with ${newModule.fields?.length || 0} field(s). Type Definition and Type Prompt are configured.`);
		} catch (err) {
			return toolError(`Failed to generate custom module: ${(err as Error).message || err}`);
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
			modelDescription: 'Disable (deactivate) or re-enable a Custom Module in AnyAgent. When disabled, the module will be hidden from the new ticket type options. Existing tickets remain preserved.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.circleSlash,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: 'The identifier of the custom module (e.g. \'expense_reimbursement\').'
					},
					action: {
						type: 'string',
						enum: ['disable', 'enable'],
						description: 'Action to perform: \'disable\' (deactivate) or \'enable\' (activate).'
					},
					workspace_id: {
						type: 'string',
						description: 'Optional workspace identifier or name.'
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
				return toolError('Missing required parameters: \'module_id\' and \'action\' (\'disable\' | \'enable\') must be provided.');
			}

			const cleanId = params.module_id.trim().toLowerCase();
			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);
			const modules = await this.customModulesService.getCustomModules(workspaceUri);

			const targetMod = modules.find(m => m.id.toLowerCase() === cleanId);
			if (!targetMod) {
				return toolError(`Custom Module '${params.module_id}' was not found in workspace.`);
			}

			targetMod.isDeprecated = (params.action === 'disable');
			targetMod.updatedAt = Date.now();
			await this.customModulesService.saveCustomModules(modules, workspaceUri);

			return toolResult({
				status: 'success',
				module_id: targetMod.id,
				module_name: targetMod.name,
				is_deprecated: targetMod.isDeprecated,
				message: `Module '${targetMod.name}' is now ${targetMod.isDeprecated ? 'Disabled' : 'Active'}.`
			}, `Custom Module '${targetMod.name}' successfully ${targetMod.isDeprecated ? 'disabled' : 'enabled'}.`);
		} catch (err) {
			return toolError(`Failed to toggle custom module status: ${(err as Error).message || err}`);
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
			modelDescription: 'Permanently delete a Custom Module definition from AnyAgent. This removes the schema YAML file. Existing tickets of this type will preserve their data.',
			source: ToolDataSource.Internal,
			canBeReferencedInPrompt: true,
			icon: Codicon.trash,
			inputSchema: {
				type: 'object',
				properties: {
					module_id: {
						type: 'string',
						description: 'The identifier of the custom module to delete (e.g. \'expense_reimbursement\').'
					},
					workspace_id: {
						type: 'string',
						description: 'Optional workspace identifier or name.'
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
				return toolError('Missing required parameter: \'module_id\' must be provided.');
			}

			const cleanId = params.module_id.trim();
			const workspaceUri = await resolveWorkspaceUri(this.workspacesExplorerService, params.workspace_id);

			await this.customModulesService.deleteCustomModule(cleanId, workspaceUri);

			return toolResult({
				status: 'success',
				deleted_module_id: cleanId,
				message: `Custom module '${cleanId}' has been deleted.`
			}, `Custom Module '${cleanId}' was successfully deleted.`);
		} catch (err) {
			return toolError(`Failed to delete custom module: ${(err as Error).message || err}`);
		}
	}

	async prepareToolInvocation?(context: IToolInvocationPreparationContext, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

