/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export type EntityType = 'workspace' | 'job' | 'project' | 'task' | 'workflow' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file' | string;

export interface IEntityGitSnapshot {
	remoteUrl?: string;
	branch?: string;
	lastCommitHash?: string;
	lastCommitMsg?: string;
	hasUncommittedChanges?: boolean;
	stashCount?: number;
}

export type CustomFieldType =
	| 'text'
	| 'number'
	| 'textarea'
	| 'select'
	| 'multiselect'
	| 'switch'
	| 'date'
	| 'time'
	| 'datetime'
	| 'date_range'
	| 'time_range'
	| 'datetime_range'
	| 'dynamic_list'
	| 'attachment'
	| 'button_group'
	| 'browser'
	| 'git'
	| 'parameters'
	| 'prompt'
	| 'output'
	| 'python'
	| 'tts'
	| 'media_player'
	| 'voice_note'
	| 'table'
	| 'create_tickets'
	| 'run_tickets'
	| 'get_ticket'
	| 'get_tickets'
	| 'get_outputs'
	| 'display'
	| 'ssh'
	| 'http_request'
	| 'sub_workflow';

/**
 * Component type ids that were renamed. Old saved data (template YAML, workflow JSON) is migrated to the current id
 * when it is loaded, so the rest of the code only ever sees the current id.
 */
const LEGACY_FIELD_TYPE_RENAMES: Readonly<Record<string, CustomFieldType>> = {
	result: 'output',
	button: 'button_group'
};

/** Maps a possibly-legacy component type id to its current id (e.g. 'result' -> 'output'). */
export function normalizeFieldType(type: string): string {
	const key = (type || '').trim();
	return LEGACY_FIELD_TYPE_RENAMES[key] ?? key;
}

/**
 * Walks loaded template / workflow data in place and renames legacy component type ids on every field-like object
 * (an object with a string `type` plus an `id` or `label`). Returns the same object for convenience.
 */
export function normalizeLegacyFieldTypes<T>(data: T): T {
	const seen = new Set<unknown>();
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object' || seen.has(value)) {
			return;
		}
		seen.add(value);
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		const obj = value as Record<string, unknown>;
		if (typeof obj.type === 'string' && (obj.id !== undefined || obj.label !== undefined) && LEGACY_FIELD_TYPE_RENAMES[obj.type]) {
			obj.type = LEGACY_FIELD_TYPE_RENAMES[obj.type];
		}
		for (const child of Object.values(obj)) {
			visit(child);
		}
	};
	visit(data);
	return data;
}

/**
 * Ticket-level values of `http_request` / `ssh` components use EXACTLY the same property names as the template
 * component config (`httpUrl`, `httpBodyContent`, `sshHost`, ...). Older tickets stored short names (`url`,
 * `bodyContent`, `host`, ...); these maps translate them. Canonical names always win over legacy names.
 */
const HTTP_TICKET_LEGACY_KEYS: Readonly<Record<string, string>> = {
	url: 'httpUrl',
	method: 'httpMethod',
	authType: 'httpAuthType',
	authToken: 'httpAuthToken',
	apiKeyName: 'httpApiKeyName',
	apiKeyValue: 'httpApiKeyValue',
	apiKeyLocation: 'httpApiKeyLocation',
	authUsername: 'httpAuthUsername',
	authPassword: 'httpAuthPassword',
	bodyType: 'httpBodyType',
	bodyContent: 'httpBodyContent',
	timeoutMs: 'httpTimeoutMs',
	responseStatus: 'httpResponseStatus',
	responseStatusText: 'httpResponseStatusText',
	responseHeaders: 'httpResponseHeaders',
	responseBody: 'httpResponseBody',
	responseData: 'httpResponseData',
	lastExecuted: 'httpLastExecutionTime',
	durationMs: 'httpLastDurationMs'
};

const SSH_TICKET_LEGACY_KEYS: Readonly<Record<string, string>> = {
	host: 'sshHost',
	port: 'sshPort',
	user: 'sshUser',
	password: 'sshPassword',
	cwd: 'sshCwd',
	command: 'sshCommand',
	commands: 'sshCommands',
	output: 'sshOutput',
	lastRawOutput: 'sshLastRawOutput',
	lastRawEntries: 'sshLastRawEntries',
	lastNOutput: 'sshLastOutput',
	outputLines: 'sshOutputLines',
	quickCommands: 'sshQuickCommands',
	lastExecuted: 'sshLastExecuted'
};

/** Request settings of an `http_request` component (template config names), i.e. what a ticket may override. */
export const HTTP_REQUEST_CONFIG_KEYS: readonly string[] = [
	'httpUrl', 'httpMethod', 'httpParams', 'httpHeaders', 'httpAuthType', 'httpAuthToken', 'httpApiKeyName',
	'httpApiKeyValue', 'httpApiKeyLocation', 'httpAuthUsername', 'httpAuthPassword', 'httpBodyType', 'httpBodyContent',
	'httpTimeoutMs'
];

/** A parsed (JSON) ticket value object; keys are dynamic. */
export type TicketValueObject = Record<string, unknown>;

/**
 * Ticket value of an `http_request` component with canonical (template) property names. Values come from
 * persisted JSON, so additional / unknown keys may be present.
 */
export interface IHttpTicketValue extends Pick<ICustomField,
	'httpUrl' | 'httpMethod' | 'httpParams' | 'httpHeaders' | 'httpAuthType' | 'httpAuthToken' | 'httpApiKeyName' |
	'httpApiKeyValue' | 'httpApiKeyLocation' | 'httpAuthUsername' | 'httpAuthPassword' | 'httpBodyType' |
	'httpBodyContent' | 'httpTimeoutMs' | 'httpResponseStatus' | 'httpResponseStatusText' | 'httpResponseHeaders' |
	'httpResponseBody' | 'httpResponseData' | 'httpLastExecutionTime' | 'httpLastDurationMs'> {
	[key: string]: unknown;
}

/**
 * Ticket value of an `ssh` component with canonical (template) property names. Values come from persisted JSON,
 * so additional / unknown keys may be present.
 */
export interface ISshTicketValue extends Pick<ICustomField,
	'sshHost' | 'sshPort' | 'sshUser' | 'sshPassword' | 'sshCwd' | 'sshCommand' | 'sshCommands' | 'sshOutput' |
	'sshLastOutput' | 'sshLastRawOutput' | 'sshLastRawEntries' | 'sshOutputLines' | 'sshQuickCommands'> {
	sshLastExecuted?: string;
	[key: string]: unknown;
}

function parseTicketValueObject(value: unknown): TicketValueObject | undefined {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as TicketValueObject;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed;
				}
			} catch { /* not JSON */ }
		}
	}
	return undefined;
}

function renameTicketKeys(src: TicketValueObject, map: Readonly<Record<string, string>>, skip: ReadonlySet<string> = new Set()): TicketValueObject {
	const out: TicketValueObject = {};
	for (const [k, v] of Object.entries(src)) {
		if (map[k] === undefined && !skip.has(k)) {
			out[k] = v;
		}
	}
	for (const [legacy, canonical] of Object.entries(map)) {
		if (src[legacy] !== undefined && src[canonical] === undefined) {
			out[canonical] = src[legacy];
		}
	}
	return out;
}

/**
 * Returns the ticket value of an `http_request` component with canonical (template) property names, or undefined
 * when the value is not an object / JSON object. Also understands the old post-run record
 * (`{url, method, status, statusText, ok, headers, data, body, rawText}`), whose `url` was the resolved URL and
 * whose `headers` / `body` were RESPONSE headers / body.
 */
export function normalizeHttpTicketValue(value: unknown): IHttpTicketValue | undefined {
	const src = parseTicketValueObject(value);
	if (!src) {
		return undefined;
	}
	const isOldRunRecord = src.status !== undefined && src.authType === undefined && src.httpAuthType === undefined;
	// Keys whose meaning depends on the record shape; handled explicitly below and never copied as-is.
	const skip = new Set(['params', 'headers', 'body', 'status', 'statusText', 'data', 'rawText', 'ok']);
	let map = HTTP_TICKET_LEGACY_KEYS;
	if (isOldRunRecord) {
		// The old post-run `url` is the RESOLVED url (query string already appended) - drop it, the template url applies.
		const { url: _resolvedUrl, ...rest } = HTTP_TICKET_LEGACY_KEYS;
		map = rest;
		skip.add('url');
	}
	const out = renameTicketKeys(src, map, skip);
	const setIfMissing = (key: string, v: unknown) => {
		if (v !== undefined && out[key] === undefined) {
			out[key] = v;
		}
	};
	if (Array.isArray(src.params)) {
		setIfMissing('httpParams', src.params);
	}
	if (Array.isArray(src.headers)) {
		setIfMissing('httpHeaders', src.headers);
	} else if (src.headers && typeof src.headers === 'object') {
		setIfMissing('httpResponseHeaders', src.headers);
	}
	if (isOldRunRecord) {
		setIfMissing('httpResponseStatus', typeof src.status === 'number' ? src.status : Number(src.status) || 0);
		setIfMissing('httpResponseStatusText', src.statusText);
		setIfMissing('httpResponseData', src.data);
		setIfMissing('httpResponseBody', src.rawText ?? (typeof src.body === 'string' ? src.body : undefined));
	} else if (typeof src.body === 'string') {
		// The old runtime read `body` as the request body.
		setIfMissing('httpBodyContent', src.body);
	}
	return out as IHttpTicketValue;
}

/** Returns the ticket value of an `ssh` component with canonical (template) property names, or undefined. */
export function normalizeSshTicketValue(value: unknown): ISshTicketValue | undefined {
	const src = parseTicketValueObject(value);
	return src ? renameTicketKeys(src, SSH_TICKET_LEGACY_KEYS) as ISshTicketValue : undefined;
}

/** True when a parsed ticket value looks like an `http_request` value (canonical or legacy names). */
export function looksLikeHttpTicketValue(obj: Readonly<TicketValueObject>): boolean {
	return (obj.httpUrl !== undefined && obj.httpMethod !== undefined)
		|| (obj.method !== undefined && obj.url !== undefined && (obj.authType !== undefined || obj.headers !== undefined || obj.params !== undefined));
}

/** True when a parsed ticket value looks like an `ssh` value (canonical or legacy names). */
export function looksLikeSshTicketValue(obj: Readonly<TicketValueObject>): boolean {
	return obj.sshHost !== undefined
		|| (obj.host !== undefined && (obj.port !== undefined || obj.quickCommands !== undefined));
}

/** True when the object is an `http_request` ticket value, including the old post-run record. */
export function isHttpTicketValue(obj: Readonly<TicketValueObject>): boolean {
	return looksLikeHttpTicketValue(obj) || obj.httpResponseStatus !== undefined
		|| (obj.status !== undefined && (obj.data !== undefined || obj.body !== undefined || obj.rawText !== undefined));
}

/** True when the object is an `ssh` ticket value (canonical or legacy names). */
export function isSshTicketValue(obj: Readonly<TicketValueObject>): boolean {
	return looksLikeSshTicketValue(obj)
		|| Array.isArray(obj.sshLastRawEntries) || obj.sshLastOutput !== undefined
		|| Array.isArray(obj.lastRawEntries) || obj.lastNOutput !== undefined;
}

/** Business output (response payload as text) of an `http_request` ticket value; '' before the first run. */
export function httpTicketValueOutputText(obj: Readonly<TicketValueObject>): string {
	const v = normalizeHttpTicketValue(obj) ?? {};
	const data = v.httpResponseData;
	if (data !== undefined && data !== null) {
		return typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
	}
	return v.httpResponseBody !== undefined && v.httpResponseBody !== null ? String(v.httpResponseBody) : '';
}

/** Business output (last N lines per command) of an `ssh` ticket value; '' before the first run. */
export function sshTicketValueOutputText(obj: Readonly<TicketValueObject>): string {
	const v = normalizeSshTicketValue(obj) ?? {};
	const n = Number(v.sshOutputLines) > 0 ? Number(v.sshOutputLines) : 50;
	if (Array.isArray(v.sshLastRawEntries) && v.sshLastRawEntries.length > 0) {
		return formatSshCommandsJsonOutput(v.sshLastRawEntries, n);
	}
	if (v.sshLastOutput !== undefined && String(v.sshLastOutput).trim() !== '') {
		return extractSshOutputLastNLines(String(v.sshLastOutput).trim(), n);
	}
	return v.sshOutput ? extractSshOutputLastNLines(String(v.sshOutput), n) : '';
}

/** Initial ticket value of an `http_request` component, built from its template config (same property names). */
export function buildHttpTicketValue(f: ICustomField): IHttpTicketValue {
	return {
		httpMethod: f.httpMethod || 'GET',
		httpUrl: f.httpUrl || f.defaultUrl || '',
		httpParams: Array.isArray(f.httpParams) ? f.httpParams : [],
		httpHeaders: Array.isArray(f.httpHeaders) ? f.httpHeaders : [],
		httpAuthType: f.httpAuthType || 'none',
		httpAuthToken: f.httpAuthToken || '',
		httpApiKeyName: f.httpApiKeyName || '',
		httpApiKeyValue: f.httpApiKeyValue || '',
		httpApiKeyLocation: f.httpApiKeyLocation || 'header',
		httpAuthUsername: f.httpAuthUsername || '',
		httpAuthPassword: f.httpAuthPassword || '',
		httpBodyType: f.httpBodyType || 'none',
		httpBodyContent: f.httpBodyContent || '',
		httpTimeoutMs: f.httpTimeoutMs || 30000
	};
}

/** Initial ticket value of an `ssh` component, built from its template config (same property names). */
export function buildSshTicketValue(f: ICustomField): ISshTicketValue {
	const cmds = normalizeSshCommandsList(f.sshCommands, f.sshCommand || f.defaultContent || '');
	return {
		sshHost: f.sshHost || '',
		sshPort: Number(f.sshPort) || 22,
		sshUser: f.sshUser || 'root',
		sshPassword: f.sshPassword || '',
		sshCwd: f.sshCwd || '~',
		sshCommand: cmds[0] || '',
		sshCommands: cmds,
		sshOutputLines: typeof f.sshOutputLines === 'number' && f.sshOutputLines > 0 ? f.sshOutputLines : 50,
		sshQuickCommands: normalizeSshQuickCommands(f.sshQuickCommands),
		sshOutput: f.sshOutput || '',
		sshLastRawOutput: f.sshLastRawOutput ?? '',
		sshLastRawEntries: Array.isArray(f.sshLastRawEntries) ? f.sshLastRawEntries : [],
		sshLastOutput: f.sshLastOutput ?? '',
		sshLastExecuted: ''
	};
}

/** Range / precision rules of a `number` component. */
export interface INumberFieldRules {
	label?: string;
	min?: number;
	max?: number;
	/** Decimal places to keep. Undefined = keep the value as entered. */
	precision?: number;
}

export interface INumberFieldCheck {
	ok: boolean;
	/** Normalized value to store (rounded to `precision`); the original text when not ok. */
	value: string;
	error?: string;
}

/**
 * Validates and normalizes a value for a `number` component: empty is allowed, `{variable}` placeholders are kept as-is
 * (they are checked again after interpolation at run time), anything else must be a number within [min, max] and is
 * rounded to `precision` decimal places.
 */
export function normalizeNumberFieldValue(rules: INumberFieldRules, raw: unknown): INumberFieldCheck {
	const text = raw === undefined || raw === null ? '' : String(raw).trim();
	if (text === '' || /\{[^{}]+\}/.test(text)) {
		return { ok: true, value: text };
	}
	const name = rules.label ? `"${rules.label}"` : 'Number';
	const n = Number(text.replace(/,/g, ''));
	if (!Number.isFinite(n)) {
		return { ok: false, value: text, error: `${name} must be a number (got "${text}").` };
	}
	const p = typeof rules.precision === 'number' && rules.precision >= 0 ? Math.min(Math.floor(rules.precision), 15) : undefined;
	const rounded = p === undefined ? n : Number(n.toFixed(p));
	const hasMin = typeof rules.min === 'number' && Number.isFinite(rules.min);
	const hasMax = typeof rules.max === 'number' && Number.isFinite(rules.max);
	if ((hasMin && rounded < rules.min!) || (hasMax && rounded > rules.max!)) {
		const range = hasMin && hasMax ? `between ${rules.min} and ${rules.max}` : hasMin ? `at least ${rules.min}` : `at most ${rules.max}`;
		return { ok: false, value: text, error: `${name} must be ${range} (got ${text}).` };
	}
	return { ok: true, value: p === undefined ? String(rounded) : rounded.toFixed(p) };
}

/** Reads number rules written as data attributes (data-min / data-max / data-precision) on an input element. */
export function numberFieldRulesFromAttributes(getAttr: (name: string) => string | null, label?: string): INumberFieldRules {
	const num = (name: string): number | undefined => {
		const v = getAttr(name);
		if (v === null || v.trim() === '') { return undefined; }
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	return { label, min: num('data-min'), max: num('data-max'), precision: num('data-precision') };
}

export interface IVoiceNoteClip {
	id: string;
	title?: string;
	audioDataUrl: string;
	mimeType?: string;
	durationSeconds?: number;
	transcript?: string;
	createdAt: number;
}

export interface IHttpRequestParam {
	id?: string;
	key: string;
	value: string;
	enabled?: boolean;
	description?: string;
}

export interface IHttpRequestHeader {
	id?: string;
	key: string;
	value: string;
	enabled?: boolean;
	description?: string;
}

export interface ISshQuickCommand {
	id?: string;
	label: string;
	command: string;
	category?: string;
	description?: string;
}

export const SSH_DEFAULT_QUICK_COMMANDS: ISshQuickCommand[] = [
	{ label: 'List Directory (ls -la)', command: 'ls -la', category: 'Files & Dirs' },
	{ label: 'Current Path (pwd)', command: 'pwd', category: 'Files & Dirs' },
	{ label: 'System Info (uname -a)', command: 'uname -a && cat /etc/os-release 2>/dev/null | head -n 6', category: 'System' },
	{ label: 'Uptime & Load (uptime)', command: 'uptime', category: 'System' },
	{ label: 'Memory Usage (free -h)', command: 'free -h', category: 'Resources' },
	{ label: 'Disk Space (df -h)', command: 'df -h', category: 'Resources' },
	{ label: 'Top 10 Processes (ps)', command: 'ps aux --sort=-%mem | head -n 11', category: 'Resources' },
	{ label: 'Listening Ports (ss -tulnp)', command: 'ss -tulnp || netstat -tulnp', category: 'Network' },
	{ label: 'IP Addresses (ip a)', command: 'ip -br a || ifconfig', category: 'Network' },
	{ label: 'Docker Containers (docker ps)', command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', category: 'Docker & Services' },
	{ label: 'Docker Stats (docker stats)', command: 'docker stats --no-stream', category: 'Docker & Services' },
	{ label: 'Running Services (systemctl)', command: 'systemctl list-units --type=service --state=running --no-pager | head -n 25', category: 'Docker & Services' },
	{ label: 'System Logs (journalctl)', command: 'journalctl -n 30 --no-pager', category: 'Logs' },
	{ label: 'Large Files >100M (find)', command: 'find . -maxdepth 3 -type f -size +100M -exec ls -lh {} + 2>/dev/null', category: 'Files & Dirs' }
];

const SSH_LEGACY_CN_LABEL_MAP: Record<string, { label: string; category: string }> = {
	'\u67E5\u770B\u76EE\u5F55 (ls -la)': { label: 'List Directory (ls -la)', category: 'Files & Dirs' },
	'\u5F53\u524D\u8DEF\u5F84 (pwd)': { label: 'Current Path (pwd)', category: 'Files & Dirs' },
	'\u7CFB\u7EDF\u4FE1\u606F (uname -a)': { label: 'System Info (uname -a)', category: 'System' },
	'\u8FD0\u884C\u65F6\u95F4 & \u8D1F\u8F7D (uptime)': { label: 'Uptime & Load (uptime)', category: 'System' },
	'\u5185\u5B58\u4F7F\u7528 (free -h)': { label: 'Memory Usage (free -h)', category: 'Resources' },
	'\u78C1\u76D8\u7A7A\u95F4 (df -h)': { label: 'Disk Space (df -h)', category: 'Resources' },
	'CPU/\u5185\u5B58 Top 10 \u8FDB\u7A0B': { label: 'Top 10 Processes (ps)', category: 'Resources' },
	'\u76D1\u542C\u7AEF\u53E3 (ss -tulnp)': { label: 'Listening Ports (ss -tulnp)', category: 'Network' },
	'\u516C\u7F51/\u7F51\u5361 IP (ip a)': { label: 'IP Addresses (ip a)', category: 'Network' },
	'Docker \u8FD0\u884C\u5BB9\u5668 (docker ps)': { label: 'Docker Containers (docker ps)', category: 'Docker & Services' },
	'Docker \u8D44\u6E90\u5360\u7528 (docker stats)': { label: 'Docker Stats (docker stats)', category: 'Docker & Services' },
	'\u8FD0\u884C\u4E2D Systemd \u670D\u52A1': { label: 'Running Services (systemctl)', category: 'Docker & Services' },
	'\u7CFB\u7EDF\u6700\u65B0\u65E5\u5FD7 (journalctl)': { label: 'System Logs (journalctl)', category: 'Logs' },
	'\u5927\u6587\u4EF6\u626B\u63CF (>100M)': { label: 'Large Files >100M (find)', category: 'Files & Dirs' }
};

export function normalizeSshQuickCommands(cmds?: ISshQuickCommand[]): ISshQuickCommand[] {
	if (!Array.isArray(cmds) || cmds.length === 0) {
		return SSH_DEFAULT_QUICK_COMMANDS.map(c => ({ ...c }));
	}
	return cmds.map(c => {
		const mapped = c?.label ? SSH_LEGACY_CN_LABEL_MAP[c.label.trim()] : undefined;
		if (mapped) {
			return {
				...c,
				label: mapped.label,
				category: mapped.category
			};
		}
		return { ...c };
	});
}

export interface ISshRawCommandEntry {
	command: string;
	rawOutput: string;
}

export function normalizeSshCommandsList(sshCommands?: unknown, fallbackCommand?: string): string[] {
	if (Array.isArray(sshCommands) && sshCommands.length > 0) {
		return sshCommands.map(cmd => String(cmd ?? ''));
	}
	if (typeof fallbackCommand === 'string' && fallbackCommand.trim().length > 0) {
		return [fallbackCommand];
	}
	return [''];
}

export function cleanInterpolatedSshCommand(rawResolved: string): string {
	let trimmed = String(rawResolved ?? '').trim();
	if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
		trimmed = trimmed
			.replace(/^```(?:bash|sh|zsh|shell|console)?\s*\n?/i, '')
			.replace(/\n?```\s*$/i, '')
			.trim();
	}
	return trimmed;
}

export function extractSshOutputLinesArray(rawLog: string | undefined, maxLines?: number): string[] {
	const normalized = String(rawLog ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
	if (!normalized) {
		return [];
	}
	const n = typeof maxLines === 'number' && !isNaN(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 50;
	const lines = normalized.split('\n');
	return lines.slice(-n);
}

export function buildSshCommandsJsonObject(entries: ReadonlyArray<ISshRawCommandEntry>, maxLines?: number): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const entry of (entries || [])) {
		const cmdKey = String(entry?.command ?? '').trim();
		if (!cmdKey) {
			continue;
		}
		result[cmdKey] = extractSshOutputLinesArray(entry?.rawOutput, maxLines);
	}
	return result;
}

export function formatSshCommandsJsonOutput(entries: ReadonlyArray<ISshRawCommandEntry>, maxLines?: number): string {
	const obj = buildSshCommandsJsonObject(entries, maxLines);
	return JSON.stringify(obj, null, 2);
}

export function extractSshOutputLastNLines(rawLog: string | undefined, maxLines?: number): string {
	const text = String(rawLog ?? '').replace(/\r\n/g, '\n').trimEnd();
	if (!text) {
		return '';
	}
	// Preserve valid JSON object output from multi-command SSH runs while re-slicing line arrays if needed
	const trimmed = text.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const values = Object.values(parsed);
				if (values.every(v => Array.isArray(v))) {
					const n = typeof maxLines === 'number' && !isNaN(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 50;
					const slicedObj: Record<string, string[]> = {};
					for (const [k, v] of Object.entries(parsed)) {
						slicedObj[k] = (v as unknown[]).map(line => String(line ?? '')).slice(-n);
					}
					return JSON.stringify(slicedObj, null, 2);
				}
			}
		} catch { }
	}
	const n = typeof maxLines === 'number' && !isNaN(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 50;
	const lines = text.split('\n');
	return lines.slice(-n).join('\n');
}

export type TableColumnDataType =
	| 'TEXT'
	| 'VARCHAR(255)'
	| 'INTEGER'
	| 'REAL'
	| 'NUMERIC'
	| 'BOOLEAN'
	| 'DATE'
	| 'DATETIME'
	| 'JSON'
	| 'BLOB'
	| string;

export interface ITableColumnDefinition {
	id: string;
	name: string;
	label?: string;
	dataType: TableColumnDataType;
	primaryKey?: boolean;
	nullable?: boolean;
	defaultValue?: string;
}

export interface IActionButton {
	id: string;
	label: string;
	color?: string;
	targetStatus?: string;
}

export interface ICredentialPair {
	id: string;
	key: string;
	value: string;
}

export interface IParameterDefinition {
	id: string;
	name: string;
	label?: string;
	defaultValue?: string;
	options?: string[];
	description?: string;
}

export interface IOutputSpec {
	fieldKey: string;
	label: string;
	enabled: boolean;
	defaultFormat?: string;
	isCustom?: boolean;
	varName?: string;
	varNameManual?: boolean;
	sourceExpression?: string;
}

export interface ICustomField {
	id: string;
	label: string;
	type: CustomFieldType;
	/** Initial value seeded when the component is created (e.g. the Python script template). Read as a fallback after type-specific content such as `pythonCode`. */
	defaultValue?: string;
	options?: string[];
	itemFields?: ICustomField[];
	componentRef?: string;
	buttons?: IActionButton[];
	unit?: string;
	precision?: number;
	min?: number;
	max?: number;
	step?: number;
	required?: boolean;
	disabled?: boolean;
	defaultUrl?: string;
	lastResolvedUrl?: string;
	browserMaxRetries?: number;
	browserRetryDelayMs?: number;
	defaultContent?: string;
	credentials?: ICredentialPair[];
	gitRemoteUrl?: string;
	gitBranch?: string;
	parameters?: IParameterDefinition[];
	targetMode?: 'model' | 'agent';
	targetModel?: string;
	targetProvider?: string;
	targetCredentialId?: string;
	targetAgentId?: string;
	targetAgentName?: string;
	promptPreInjectedVisible?: boolean;
	promptUserInputVisible?: boolean;
	defaultUserPrompt?: string;
	defaultUserPrompts?: string[];
	defaultFormat?: string;
	outputSpecs?: IOutputSpec[];
	debugPromptOutput?: string;
	pythonPath?: string;
	pythonEnvMode?: 'existing' | 'create';
	pythonCode?: string;
	pythonOutput?: string;
	pythonResult?: unknown;
	externalScripts?: string[];
	ttsFormat?: 'mp3' | 'wav' | 'opus' | 'aac' | string;
	ttsVoice?: string;
	ttsAutoPlay?: boolean;
	ttsPlaybackRate?: number;
	ttsDisplayText?: string;
	ttsShowSpeechTextInTicket?: boolean;
	ttsAudioFile?: string;
	ttsAudioDataUrl?: string;
	mediaFilePath?: string;
	mediaFileName?: string;
	mediaKind?: 'audio' | 'video' | string;
	mediaMimeType?: string;
	mediaPlaybackRate?: number;
	mediaAutoPlay?: boolean;
	voiceClips?: IVoiceNoteClip[];
	voiceTranscript?: string;
	voiceAutoTranscribe?: boolean;
	voicePlaybackRate?: number;
	voiceRunInFlow?: boolean;
	subWorkflowId?: string;
	subWorkflowName?: string;
	subWorkflowSourceUri?: string;
	subWorkflowInputs?: Record<string, string>;
	subWorkflowInputDefs?: Array<{ name: string; label?: string; defaultValue?: string }>;
	subWorkflowOutputDefs?: Array<{ label: string; varName: string; defaultFormat?: string }>;
	tableColumns?: ITableColumnDefinition[];
	tableRows?: Array<Record<string, unknown>>;
	tableDbEngine?: 'sqlite' | string;
	tableDbPath?: string;
	tableDbTableName?: string;
	tableAutoSyncDb?: boolean;
	tableSqlQuery?: string;
	tablePageSize?: number;
	debugSqlOutput?: string;
	wfTicketType?: string;
	wfTicketTitle?: string;
	wfTicketPath?: string;
	wfTicketTarget?: string;
	wfTicketStatus?: string;
	wfTicketId?: string;
	wfTicketVariable?: string;
	wfTicketField?: string;
	wfTicketParams?: Record<string, string>;
	wfDisplayValue?: string;
	outputVariableName?: string;
	outputVariableManual?: boolean;
	sshHost?: string;
	sshPort?: number | string;
	sshUser?: string;
	sshPassword?: string;
	sshCwd?: string;
	sshCommand?: string;
	sshCommands?: string[];
	sshOutput?: string;
	sshLastOutput?: string;
	sshLastRawOutput?: string;
	sshLastRawEntries?: ISshRawCommandEntry[];
	sshOutputLines?: number;
	sshQuickCommands?: ISshQuickCommand[];
	httpUrl?: string;
	httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | string;
	httpParams?: IHttpRequestParam[];
	httpHeaders?: IHttpRequestHeader[];
	httpAuthType?: 'none' | 'bearer' | 'api_key' | 'basic' | 'custom' | string;
	httpAuthToken?: string;
	httpApiKeyName?: string;
	httpApiKeyValue?: string;
	httpApiKeyLocation?: 'header' | 'query';
	httpAuthUsername?: string;
	httpAuthPassword?: string;
	httpBodyType?: 'none' | 'json' | 'raw' | 'x-www-form-urlencoded' | string;
	httpBodyContent?: string;
	httpTimeoutMs?: number;
	httpResponseStatus?: number;
	httpResponseStatusText?: string;
	httpResponseHeaders?: Record<string, string>;
	httpResponseBody?: string;
	httpResponseData?: unknown;
	httpLastExecutionTime?: string;
	httpLastDurationMs?: number;
}

const PYTHON_RESERVED_KEYWORDS = new Set([
	'false', 'none', 'true', 'and', 'as', 'assert', 'async', 'await', 'break',
	'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
	'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
	'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const SMART_VAR_STOPWORDS = new Set([
	'the', 'a', 'an', 'to', 'be', 'by', 'with', 'from', 'for', 'of', 'in', 'on',
	'at', 'and', 'or', 'is', 'are', 'was', 'were', 'been', 'being', 'this', 'that',
	'these', 'those', 'into', 'over', 'via', 'using', 'based', 'upon', 'per', 'as',
	'about', 'between', 'through', 'during', 'before', 'after', 'above', 'below'
]);

const SMART_VAR_LOW_INFO_MODIFIERS = new Set([
	'overall', 'general', 'current', 'basic', 'simple', 'standard', 'default',
	'custom', 'raw', 'new', 'my', 'our', 'all', 'each', 'every', 'single'
]);

const SMART_VAR_LEADING_VERBS = new Set([
	'fetch', 'get', 'load', 'read', 'extract', 'generate', 'create', 'build',
	'calculate', 'compute', 'analyze', 'evaluate', 'process', 'parse', 'find',
	'search', 'check', 'verify', 'run', 'execute', 'retrieve', 'collect', 'obtain',
	'determine', 'make', 'do', 'perform', 'handle'
]);

const SMART_VAR_ABBREVIATIONS: Record<string, string> = {
	description: 'desc',
	descriptions: 'descs',
	information: 'info',
	configuration: 'cfg',
	configurations: 'cfgs',
	config: 'cfg',
	parameters: 'params',
	parameter: 'param',
	application: 'app',
	applications: 'apps',
	database: 'db',
	databases: 'dbs',
	document: 'doc',
	documents: 'docs',
	documentation: 'docs',
	experience: 'exp',
	experiences: 'exp',
	formula: 'fmt',
	position: 'pos',
	positions: 'pos',
	number: 'num',
	numbers: 'nums',
	count: 'cnt',
	index: 'idx',
	temporary: 'tmp',
	message: 'msg',
	messages: 'msgs',
	response: 'resp',
	responses: 'resps',
	request: 'req',
	requests: 'reqs',
	result: 'res',
	results: 'res',
	output: 'out',
	outputs: 'out',
	value: 'val',
	values: 'vals',
	calculate: 'calc',
	calculation: 'calc',
	compute: 'calc',
	qualification: 'qual',
	qualifications: 'quals',
	qualified: 'qual',
	evaluation: 'eval',
	classification: 'cls',
	category: 'cat',
	categories: 'cats',
	candidate: 'cand',
	candidates: 'cands',
	summary: 'sum',
	summaries: 'sums',
	dictionary: 'dict',
	directory: 'dir',
	repository: 'repo',
	environment: 'env',
	credential: 'cred',
	credentials: 'creds',
	attribute: 'attr',
	attributes: 'attrs',
	property: 'prop',
	properties: 'props',
	reference: 'ref',
	references: 'refs',
	context: 'ctx',
	command: 'cmd',
	commands: 'cmds',
	text: 'txt',
	string: 'str',
	object: 'obj',
	objects: 'objs',
	function: 'fn',
	python: 'py'
};

/**
 * Generates a concise, intuitive programmer-style Python variable name from a component Field Label.
 * Avoids naively joining long sentences with underscores: strips stopwords/filler modifiers,
 * applies idiomatic developer abbreviations, and caps at 2-3 core semantic tokens.
 */
export function generateSmartPythonVarName(label?: string, fallbackType?: string): string {
	const raw = (label || '').trim().replace(/^@+/, '');
	if (!raw) {
		return sanitizePythonVarName(fallbackType || 'var');
	}

	// If already a compact valid snake_case or camelCase identifier (<= 20 chars, <= 3 parts), normalize it cleanly
	if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw) && raw.length <= 20 && raw.split('_').filter(Boolean).length <= 3) {
		const splitCamel = raw
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toLowerCase()
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		if (splitCamel.split('_').length <= 3 && splitCamel.length <= 22) {
			return sanitizePythonVarName(splitCamel, fallbackType);
		}
	}

	// Split CamelCase, acronyms, and non-alphanumeric boundaries into lowercase tokens
	const normalized = raw
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.toLowerCase();

	let tokens = normalized.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return sanitizePythonVarName(fallbackType || 'res');
	}

	// Step 1: Strip filler stopwords (unless all tokens are stopwords)
	const nonStop = tokens.filter(t => !SMART_VAR_STOPWORDS.has(t));
	if (nonStop.length > 0) {
		tokens = nonStop;
	}

	// Step 2: If > 2 tokens, strip low-information modifiers (e.g. "overall", "current", "raw")
	if (tokens.length > 2) {
		const withoutLowInfo = tokens.filter((t, idx) => idx === tokens.length - 1 || !SMART_VAR_LOW_INFO_MODIFIERS.has(t));
		if (withoutLowInfo.length >= 2) {
			tokens = withoutLowInfo;
		}
	}

	// Step 3: If >= 3 tokens and starts with a generic action verb (e.g. "fetch", "get", "calculate"), drop the leading verb
	if (tokens.length >= 3 && SMART_VAR_LEADING_VERBS.has(tokens[0])) {
		tokens = tokens.slice(1);
	}

	// Step 4: Apply programmer abbreviations when multi-word or long token
	const totalRawLen = tokens.join('_').length;
	tokens = tokens.map(t => {
		if ((tokens.length >= 2 || totalRawLen > 14 || t.length > 9) && SMART_VAR_ABBREVIATIONS[t]) {
			return SMART_VAR_ABBREVIATIONS[t];
		}
		return t;
	});

	// Step 5: Deduplicate adjacent or repeated tokens while preserving order
	const deduped: string[] = [];
	for (const t of tokens) {
		if (!deduped.includes(t)) {
			deduped.push(t);
		}
	}
	tokens = deduped;

	// Step 6: Cap to at most 3 core tokens (first 2 key qualifier tokens + final head noun token)
	if (tokens.length > 3) {
		tokens = [tokens[0], tokens[1], tokens[tokens.length - 1]];
	}

	// Step 7: If still overly long (> 22 chars) with 3 tokens, keep first + last token
	let candidate = tokens.join('_');
	if (candidate.length > 22 && tokens.length === 3) {
		candidate = `${tokens[0]}_${tokens[2]}`;
	}

	return sanitizePythonVarName(candidate, fallbackType);
}

export function sanitizePythonVarName(name?: string, fallbackType?: string): string {
	let cleaned = (name || '')
		.trim()
		.replace(/^@+/, '')
		.replace(/[^a-zA-Z0-9_]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!cleaned) {
		const fb = (fallbackType || 'res').toLowerCase().replace(/[^a-z0-9_]/g, '_');
		cleaned = fb || 'res';
	}
	if (/^[0-9]/.test(cleaned)) {
		cleaned = `v_${cleaned}`;
	}
	if (PYTHON_RESERVED_KEYWORDS.has(cleaned.toLowerCase())) {
		cleaned = `${cleaned}_var`;
	}
	return cleaned;
}

export interface ICompositeComponent {
	id: string;
	name: string;
	description?: string;
	itemFields: ICustomField[];
	storageScope?: 'global' | 'workspace';
}

export interface IStatusDefinition {
	id: string;
	label: string;
	color: string;
	category: 'Todo' | 'In Progress' | 'Done' | 'Blocked' | 'Removed';
	description?: string;
}

export const DEFAULT_STATUS_DEFINITIONS: IStatusDefinition[] = [
	{ id: 'todo', label: 'Todo', color: '#818cf8', category: 'Todo', description: 'Initial backlog / pending' },
	{ id: 'in_progress', label: 'In Progress', color: '#fbbf24', category: 'In Progress', description: 'Active development' },
	{ id: 'done', label: 'Done', color: '#34d399', category: 'Done', description: 'Completed & delivered' },
	{ id: 'blocked', label: 'Blocked', color: '#f43f5e', category: 'Blocked', description: 'Waiting / on hold' },
	{ id: 'removed', label: 'Removed', color: '#94a3b8', category: 'Removed', description: 'Archived / purged' }
];

export interface ICustomModule {
	id: string;
	name: string;
	category?: string;
	description?: string;
	prompt?: string;
	isDeprecated?: boolean;
	icon?: string;
	color: string;
	storageScope?: 'global' | 'workspace';
	updatedAt?: number;
	fields?: ICustomField[];
	statuses?: IStatusDefinition[];
}

export const DEFAULT_CUSTOM_MODULE_ICON_ID = 'package';

export interface ICustomModuleIconOption {
	id: string;
	label: string;
	icon: ThemeIcon;
}

export const CUSTOM_MODULE_ICON_LIBRARY: ICustomModuleIconOption[] = [
	{ id: 'package', label: 'Package', icon: Codicon.package },
	{ id: 'briefcase', label: 'Briefcase / Job', icon: Codicon.briefcase },
	{ id: 'rocket', label: 'Rocket', icon: Codicon.rocket },
	{ id: 'project', label: 'Project', icon: Codicon.project },
	{ id: 'checklist', label: 'Checklist / Task', icon: Codicon.checklist },
	{ id: 'tasklist', label: 'Tasklist', icon: Codicon.tasklist },
	{ id: 'github-action', label: 'Workflow', icon: Codicon.githubAction },
	{ id: 'robot', label: 'AI Agent', icon: Codicon.robot },
	{ id: 'beaker', label: 'Beaker / Case', icon: Codicon.beaker },
	{ id: 'bug', label: 'Bug / Issue', icon: Codicon.bug },
	{ id: 'graph', label: 'Graph / Analysis', icon: Codicon.graph },
	{ id: 'book', label: 'Book / Note', icon: Codicon.book },
	{ id: 'globe', label: 'Globe / Web', icon: Codicon.globe },
	{ id: 'database', label: 'Database', icon: Codicon.database },
	{ id: 'compass', label: 'Compass', icon: Codicon.compass },
	{ id: 'layers', label: 'Layers', icon: Codicon.layers },
	{ id: 'extensions', label: 'Extensions', icon: Codicon.extensions },
	{ id: 'symbol-namespace', label: 'Namespace', icon: Codicon.symbolNamespace },
	{ id: 'sparkle', label: 'Sparkle / AI', icon: Codicon.sparkle },
	{ id: 'bookmark', label: 'Bookmark', icon: Codicon.bookmark },
	{ id: 'archive', label: 'Archive', icon: Codicon.archive },
	{ id: 'organization', label: 'Organization / Team', icon: Codicon.organization },
	{ id: 'milestone', label: 'Milestone', icon: Codicon.milestone },
	{ id: 'shield', label: 'Shield / Security', icon: Codicon.shield },
	{ id: 'plug', label: 'Plug / Integration', icon: Codicon.plug },
	{ id: 'tools', label: 'Tools', icon: Codicon.tools },
	{ id: 'terminal', label: 'Terminal', icon: Codicon.terminal },
	{ id: 'tag', label: 'Tag', icon: Codicon.tag },
	{ id: 'file-text', label: 'Document', icon: Codicon.fileText },
	{ id: 'file-code', label: 'Code File', icon: Codicon.fileCode },
	{ id: 'file-media', label: 'Media', icon: Codicon.fileMedia },
	{ id: 'file-pdf', label: 'PDF / Resume', icon: Codicon.filePdf },
	{ id: 'person', label: 'Person / Profile', icon: Codicon.person },
	{ id: 'account', label: 'Account', icon: Codicon.account },
	{ id: 'mortar-board', label: 'Education', icon: Codicon.mortarBoard },
	{ id: 'calendar', label: 'Calendar', icon: Codicon.calendar },
	{ id: 'clock', label: 'Clock / Time', icon: Codicon.clock },
	{ id: 'mail', label: 'Mail', icon: Codicon.mail },
	{ id: 'comment-discussion', label: 'Discussion', icon: Codicon.commentDiscussion },
	{ id: 'megaphone', label: 'Megaphone', icon: Codicon.megaphone },
	{ id: 'lightbulb', label: 'Lightbulb / Idea', icon: Codicon.lightbulb },
	{ id: 'flame', label: 'Flame / Hot', icon: Codicon.flame },
	{ id: 'star-full', label: 'Star', icon: Codicon.starFull },
	{ id: 'heart', label: 'Heart', icon: Codicon.heart },
	{ id: 'key', label: 'Key', icon: Codicon.key },
	{ id: 'lock', label: 'Lock', icon: Codicon.lock },
	{ id: 'cloud', label: 'Cloud', icon: Codicon.cloud },
	{ id: 'server', label: 'Server', icon: Codicon.server },
	{ id: 'code', label: 'Code', icon: Codicon.code },
	{ id: 'json', label: 'JSON', icon: Codicon.json },
	{ id: 'table', label: 'Table', icon: Codicon.table },
	{ id: 'wand', label: 'Magic Wand', icon: Codicon.wand },
	{ id: 'law', label: 'Law / Policy', icon: Codicon.law },
	{ id: 'credit-card', label: 'Finance / Payment', icon: Codicon.creditCard },
	{ id: 'pulse', label: 'Pulse / Monitor', icon: Codicon.pulse },
	{ id: 'target', label: 'Target / Goal', icon: Codicon.target }
];

export const CUSTOM_MODULE_COLOR_PALETTE: string[] = [
	'#38bdf8', // Sky Blue
	'#f59e0b', // Amber
	'#ec4899', // Pink
	'#10b981', // Emerald
	'#a855f7', // Purple
	'#3b82f6', // Blue
	'#0d9488', // Teal
	'#ef4444', // Red
	'#eab308', // Yellow
	'#06b6d4', // Cyan
	'#818cf8', // Indigo
	'#fb923c', // Orange
	'#84cc16', // Lime
	'#f43f5e'  // Rose
];

const SYSTEM_MODULE_DEFAULT_ICONS: Record<string, ThemeIcon> = {
	'job': Codicon.rocket,
	'project': Codicon.project,
	'task': Codicon.checklist,
	'workflow': Codicon.githubAction,
	'case': Codicon.beaker,
	'agent': Codicon.robot,
	'issue': Codicon.bug,
	'analysis': Codicon.graph,
	'note': Codicon.book
};

export function getDefaultCustomModuleIconId(typeId?: string): string {
	const lower = (typeId || '').trim().toLowerCase();
	if (lower && SYSTEM_MODULE_DEFAULT_ICONS[lower]) {
		return SYSTEM_MODULE_DEFAULT_ICONS[lower].id;
	}
	return DEFAULT_CUSTOM_MODULE_ICON_ID;
}

export function resolveCustomModuleIcon(iconId?: string, fallbackTypeId?: string): ThemeIcon {
	const cleaned = (iconId || '').trim();
	if (cleaned) {
		const found = CUSTOM_MODULE_ICON_LIBRARY.find(item => item.id.toLowerCase() === cleaned.toLowerCase());
		if (found) {
			return found.icon;
		}
		return ThemeIcon.fromId(cleaned);
	}
	const lowerType = (fallbackTypeId || '').trim().toLowerCase();
	if (lowerType && SYSTEM_MODULE_DEFAULT_ICONS[lowerType]) {
		return SYSTEM_MODULE_DEFAULT_ICONS[lowerType];
	}
	const defaultEntry = CUSTOM_MODULE_ICON_LIBRARY.find(item => item.id === DEFAULT_CUSTOM_MODULE_ICON_ID);
	return defaultEntry ? defaultEntry.icon : Codicon.package;
}

export function getDefaultCustomModuleColor(nameOrId?: string, usedColors?: Set<string>): string {
	if (usedColors && usedColors.size > 0) {
		const unused = CUSTOM_MODULE_COLOR_PALETTE.find(c => !usedColors.has(c.toLowerCase()));
		if (unused) {
			return unused;
		}
	}
	if (!nameOrId) {
		return CUSTOM_MODULE_COLOR_PALETTE[0];
	}
	let hash = 0;
	const str = String(nameOrId).trim().toLowerCase();
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % CUSTOM_MODULE_COLOR_PALETTE.length;
	return CUSTOM_MODULE_COLOR_PALETTE[index];
}

export interface IBaseEntitySnapshot {
	entityUri: string;
	entityName: string;
	title?: string;
	ticketId?: string;
	workspaceId?: string;
	entityType: EntityType;
	entityCode?: string;
	ownerAccount?: string;
	createdAt?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	typeDefinition?: string;
	typePrompt?: string;
	ticketPrompt?: string;
	linkTo?: string;
	linkedBy?: string;
	attachments?: string[];
	belongsToWorkspaceUri?: string;

	// Specialized properties for AI Agent
	systemPrompt?: string;
	role?: string;
	modelName?: string;
	avatarIcon?: string;
	scopeType?: string;
	scopeId?: string;
	scopeName?: string;

	// Git metadata snapshot
	git?: IEntityGitSnapshot;
	customMetadata?: { [key: string]: string };
}

export const IEntityPersistenceService = createDecorator<IEntityPersistenceService>('entityPersistenceService');

export interface IEntityPersistenceService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSnapshots: Event<void>;

	saveSnapshot(snapshot: IBaseEntitySnapshot): Promise<void>;
	getSnapshot(uri: URI | string): IBaseEntitySnapshot | undefined;
	getAllSnapshots(): IBaseEntitySnapshot[];
	removeSnapshot(uri: URI | string): Promise<void>;

	writeEntity4MDFiles(snapshot: IBaseEntitySnapshot, targetFolderUri: URI, isNewFolder?: boolean): Promise<URI>;
}

/**
 * Playback speeds required for MP3 / MP4 Player (and Audio/Video components):
 * 0.25x, 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x
 */
export const MEDIA_PLAYER_SPEED_OPTIONS: ReadonlyArray<{ rate: number; label: string; desc: string }> = [
	{ rate: 0.25, label: '0.25x', desc: '0.25x (Quarter Speed)' },
	{ rate: 0.5, label: '0.5x', desc: '0.5x (Half Speed)' },
	{ rate: 0.75, label: '0.75x', desc: '0.75x (Slow)' },
	{ rate: 1.0, label: '1.0x', desc: '1.0x (Normal Speed)' },
	{ rate: 1.25, label: '1.25x', desc: '1.25x (Fast)' },
	{ rate: 1.5, label: '1.5x', desc: '1.5x (Fast)' },
	{ rate: 1.75, label: '1.75x', desc: '1.75x (Fast)' },
	{ rate: 2.0, label: '2.0x', desc: '2.0x (Double Speed)' }
];

export const MEDIA_PLAYER_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'wma', 'opus', 'weba'] as const;
export const MEDIA_PLAYER_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'] as const;
export const MEDIA_PLAYER_ALL_EXTENSIONS = [...MEDIA_PLAYER_AUDIO_EXTENSIONS, ...MEDIA_PLAYER_VIDEO_EXTENSIONS] as const;

const AUDIO_EXT_SET = new Set<string>(MEDIA_PLAYER_AUDIO_EXTENSIONS);
const VIDEO_EXT_SET = new Set<string>(MEDIA_PLAYER_VIDEO_EXTENSIONS);

const EXT_TO_MIME_MAP: Record<string, string> = {
	// Audio
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	flac: 'audio/flac',
	wma: 'audio/x-ms-wma',
	opus: 'audio/opus',
	weba: 'audio/webm',
	// Video
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	m4v: 'video/mp4',
	ogv: 'video/ogg',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo'
};

/**
 * Automatically detects whether a media file is 'audio' or 'video', resolves its extension and MIME type,
 * and checks if it matches supported audio/video formats.
 */
export function detectMediaFileInfo(fileNameOrPath: string, explicitMime?: string): {
	kind: 'audio' | 'video';
	ext: string;
	mimeType: string;
	isRecognizedMedia: boolean;
} {
	const rawName = (fileNameOrPath || '').trim();
	const dotIdx = rawName.lastIndexOf('.');
	const ext = dotIdx >= 0 ? rawName.substring(dotIdx + 1).toLowerCase().trim() : '';
	const cleanMime = (explicitMime || '').trim().toLowerCase();

	if (VIDEO_EXT_SET.has(ext)) {
		return {
			kind: 'video',
			ext,
			mimeType: cleanMime.startsWith('video/') ? cleanMime : (EXT_TO_MIME_MAP[ext] || 'video/mp4'),
			isRecognizedMedia: true
		};
	}
	if (AUDIO_EXT_SET.has(ext)) {
		return {
			kind: 'audio',
			ext,
			mimeType: cleanMime.startsWith('audio/') ? cleanMime : (EXT_TO_MIME_MAP[ext] || 'audio/mpeg'),
			isRecognizedMedia: true
		};
	}
	if (cleanMime.startsWith('video/')) {
		return {
			kind: 'video',
			ext: ext || 'mp4',
			mimeType: cleanMime,
			isRecognizedMedia: true
		};
	}
	if (cleanMime.startsWith('audio/')) {
		return {
			kind: 'audio',
			ext: ext || 'mp3',
			mimeType: cleanMime,
			isRecognizedMedia: true
		};
	}
	return {
		kind: 'audio',
		ext: ext || 'unknown',
		mimeType: cleanMime || 'application/octet-stream',
		isRecognizedMedia: false
	};
}

