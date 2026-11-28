/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, join } from '../../../../base/common/path.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellRunResult } from '../../entityPersistence/common/entityPersistence.js';
import { truncateUtf8 } from './gitComponent.js';

/*
 * The `shell` component (CI-55): runs a local zsh / bash / sh script. Pure helpers shared by the runtime, the editors
 * and tests: config handling, the variable-safe script builder, outputs, the stored ticket value, validation and the
 * human confirmation marker.
 *
 * Variable safety: a {variable} in the script is NEVER spliced into the script text. Each reference is replaced by a
 * quoted shell parameter expansion ("${ANYAGENT_VAR_name}") and the resolved value is passed as that environment
 * variable. The shell does not re-parse the result of a parameter expansion, so a value such as `x; rm -rf ~` or
 * `$(reboot)` stays plain data. The quote context is tracked so the expansion stays one word: unquoted text gets
 * "${V}", inside "..." and unquoted heredocs ${V}, inside '...' the quote is closed and reopened ('"${V}"').
 * In a quoted heredoc (<<'EOF') and in comments the text is left unchanged (the shell would not expand there).
 * A {reference} with no value (e.g. awk '{print $1}', a JSON brace, ${HOME}) is left as written.
 *
 * Confirmation: a script that an AI wrote or changed must be confirmed by a person before it runs. The marker is
 * shellConfirmedHash = HMAC-SHA256(local key, shell + cwd + script + env). The key is random per installation and
 * kept in the application storage, so an AI writing templates / tickets cannot produce a valid marker, and any change
 * of the script (or cwd / shell / env) invalidates it. UI edits and the Confirm dialog compute a new marker.
 */

export const SHELL_TYPES = ['zsh', 'bash', 'sh'] as const;
export type ShellType = typeof SHELL_TYPES[number];

/** Default timeout (seconds) and the largest allowed. */
export const SHELL_DEFAULT_TIMEOUT_SEC = 120;
export const SHELL_MAX_TIMEOUT_SEC = 3600;
/** Bytes of stdout / stderr captured per stream by a run. */
export const SHELL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Bytes of stdout / stderr kept in the result stored on the ticket / node. */
export const SHELL_STORED_OUTPUT_MAX_BYTES = 3072;
/** Environment variables carrying the values of {variables}. */
export const SHELL_VARIABLE_ENV_PREFIX = 'ANYAGENT_VAR_';
/** Largest total size of the variable values passed in the environment (the OS limit is about 1 MB on macOS). */
export const SHELL_MAX_VARIABLE_ENV_BYTES = 512 * 1024;

/** Default shell: zsh on macOS, bash elsewhere. */
export function defaultShellType(): ShellType {
	return isMacintosh ? 'zsh' : 'bash';
}

/** Template / ticket settings of a shell component (ICustomField names). */
export interface IShellComponentConfig {
	shellScript?: string;
	shellCwd?: string;
	shellType?: string;
	shellEnv?: string;
	shellTimeoutSec?: number | string;
}

export type ShellConfigKey = keyof IShellComponentConfig;

export const SHELL_CONFIG_KEYS: readonly ShellConfigKey[] = ['shellScript', 'shellCwd', 'shellType', 'shellEnv', 'shellTimeoutSec'];

/** Ticket value of a shell component: the ticket's own settings (they win over the template), marker and last result. */
export interface IShellTicketValue extends IShellComponentConfig {
	shellConfirmedHash?: string;
	shellLastResult?: IShellRunResult;
}

export function normalizeShellType(value: unknown): ShellType | undefined {
	const key = String(value ?? '').trim().toLowerCase();
	return (SHELL_TYPES as readonly string[]).includes(key) ? key as ShellType : undefined;
}

/** The shell a config runs (the platform default when none is set). */
export function shellTypeOf(config: IShellComponentConfig): ShellType {
	return normalizeShellType(config.shellType) ?? defaultShellType();
}

// ---------------------------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------------------------

/** The shell settings of an object (a field, a ticket value); other keys are dropped, undefined values omitted. */
export function pickShellConfig(source: unknown): IShellComponentConfig {
	const out: Record<string, unknown> = {};
	if (source && typeof source === 'object') {
		for (const key of SHELL_CONFIG_KEYS) {
			const value = Reflect.get(source, key);
			if (value !== undefined && value !== null) {
				out[key] = value;
			}
		}
	}
	return out as IShellComponentConfig;
}

/** Template settings overlaid with the ticket's own settings (a non-empty ticket setting wins). */
export function effectiveShellConfig(template: IShellComponentConfig, ticketValue?: IShellComponentConfig): IShellComponentConfig {
	const out: IShellComponentConfig = pickShellConfig(template);
	for (const [key, value] of Object.entries(pickShellConfig(ticketValue))) {
		if (value !== '') {
			Reflect.set(out, key, value);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Environment lines (shellEnv)
// ---------------------------------------------------------------------------------------------

/** Variables that make a shell run other code or change how it parses (never settable from the config). */
const FORBIDDEN_ENV_KEYS = new Set(['BASH_ENV', 'ENV', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS', 'IFS', 'PS4', 'PROMPT_COMMAND', 'BASH_FUNC', 'NODE_OPTIONS', 'PYTHONSTARTUP']);
const FORBIDDEN_ENV_PREFIXES = ['LD_', 'DYLD_', 'BASH_FUNC_', SHELL_VARIABLE_ENV_PREFIX];
/** Names that look like secrets: their value must be a {variable} reference, never plain text. */
const SECRET_ENV_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PURE_REFERENCE = /^@?\{\{?[^{}]+\}?\}$/;

export interface IShellEnvEntry {
	readonly key: string;
	readonly value: string;
}

/** Parses `KEY=VALUE` lines (blank lines and `# comments` skipped). Values are not resolved here. */
export function parseShellEnv(text: string | undefined): { entries: IShellEnvEntry[]; errors: string[] } {
	const entries: IShellEnvEntry[] = [];
	const errors: string[] = [];
	const lines = String(text ?? '').split(/\r?\n/);
	lines.forEach((raw, idx) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			return;
		}
		const eq = line.indexOf('=');
		const key = (eq < 0 ? line : line.slice(0, eq)).trim().replace(/^export\s+/, '');
		if (eq < 0) {
			errors.push(`line ${idx + 1}: expected KEY=VALUE`);
			return;
		}
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		const upper = key.toUpperCase();
		if (!ENV_KEY.test(key)) {
			errors.push(`line ${idx + 1}: '${key}' is not a valid variable name`);
		} else if (FORBIDDEN_ENV_KEYS.has(upper) || FORBIDDEN_ENV_PREFIXES.some(p => upper.startsWith(p))) {
			errors.push(`line ${idx + 1}: ${key} cannot be set (it changes how the shell starts or is reserved)`);
		} else if (SECRET_ENV_KEY.test(key) && value && !PURE_REFERENCE.test(value)) {
			errors.push(`line ${idx + 1}: ${key} looks like a secret; do not write it in plain text, reference a variable instead (e.g. ${key}={${key}})`);
		} else {
			entries.push({ key, value });
		}
	});
	return { entries, errors };
}

// ---------------------------------------------------------------------------------------------
// Variable-safe script builder
// ---------------------------------------------------------------------------------------------

export interface IShellSubstitution {
	/** Script with every resolved {reference} replaced by a quoted "${ANYAGENT_VAR_...}" expansion. */
	readonly script: string;
	/** ANYAGENT_VAR_... name -> value. */
	readonly env: Record<string, string>;
	/** Variable names in order of first use. */
	readonly variables: readonly string[];
}

/** Resolves one reference text (`{name}` or `{{name}}`); undefined when it has no value. */
export type ShellReferenceResolver = (reference: string, name: string) => string | undefined;

type LexMode = 'plain' | 'single' | 'double' | 'ansi' | 'comment' | 'heredoc';

interface IPendingHeredoc {
	readonly delimiter: string;
	readonly quoted: boolean;
	readonly stripTabs: boolean;
}

const REFERENCE_AT = /\{\{([^{}\n]+)\}\}|\{([^{}\n]+)\}/y;
const HEREDOC_WORD_END = /[\s;&|<>()]/;

/**
 * Replaces the {variable} references of a script by environment variable expansions (see the file comment).
 * `resolveRef` returns the value of a reference, or undefined to leave it as written.
 */
export function substituteShellVariables(script: string, resolveRef: ShellReferenceResolver): IShellSubstitution {
	const env: Record<string, string> = {};
	const variables: string[] = [];
	const envNameOf = new Map<string, string>();
	const envFor = (name: string, value: string): string => {
		let envName = envNameOf.get(name);
		if (!envName) {
			const base = `${SHELL_VARIABLE_ENV_PREFIX}${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
			envName = base;
			for (let n = 2; Object.prototype.hasOwnProperty.call(env, envName); n++) {
				envName = `${base}_${n}`;
			}
			envNameOf.set(name, envName);
			variables.push(name);
			env[envName] = value.replace(/\0/g, '');
		}
		return envName;
	};

	let out = '';
	let mode: LexMode = 'plain';
	const pending: IPendingHeredoc[] = [];
	let heredoc: IPendingHeredoc | undefined;
	let i = 0;
	const n = script.length;

	/** Tries a reference at i; returns true (and appends the expansion) when it has a value. */
	const tryReference = (expansion: (envName: string) => string): boolean => {
		if (i > 0 && script[i - 1] === '$') {
			return false; // ${NAME} is a shell expansion, not a variable reference
		}
		REFERENCE_AT.lastIndex = i;
		const match = REFERENCE_AT.exec(script);
		if (!match) {
			return false;
		}
		const name = (match[1] ?? match[2]).trim();
		if (!name) {
			return false;
		}
		const value = resolveRef(match[0], name);
		if (value === undefined) {
			return false;
		}
		if (out.endsWith('@')) {
			out = out.slice(0, -1); // @{name} form
		}
		out += expansion(envFor(name, value));
		i += match[0].length;
		return true;
	};

	const startOfWord = (): boolean => i === 0 || /[\s;&|()<>]/.test(script[i - 1]);

	const readHeredocOperator = (): void => {
		// at '<<' (not '<<<'): copy the operator and the delimiter word, remember the heredoc
		let j = i + 2;
		let stripTabs = false;
		if (script[j] === '-') {
			stripTabs = true;
			j++;
		}
		let k = j;
		while (k < n && (script[k] === ' ' || script[k] === '\t')) {
			k++;
		}
		let word = '';
		let quoted = false;
		let q: string | undefined;
		let w = k;
		for (; w < n; w++) {
			const ch = script[w];
			if (q) {
				if (ch === q) {
					q = undefined;
				} else {
					word += ch;
				}
				continue;
			}
			if (ch === '\'' || ch === '"') {
				q = ch;
				quoted = true;
				continue;
			}
			if (ch === '\\' && w + 1 < n) {
				quoted = true;
				word += script[++w];
				continue;
			}
			if (HEREDOC_WORD_END.test(ch)) {
				break;
			}
			word += ch;
		}
		if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(word)) {
			pending.push({ delimiter: word, quoted, stripTabs });
			out += script.slice(i, w);
			i = w;
		} else {
			out += '<<';
			i += 2;
		}
	};

	const onNewline = (): void => {
		out += '\n';
		i++;
		if (pending.length) {
			heredoc = pending.shift();
			mode = 'heredoc';
		} else {
			mode = 'plain';
		}
	};

	while (i < n) {
		const ch = script[i];
		switch (mode as LexMode) {
			case 'plain': {
				if (ch === '\\') {
					out += script.slice(i, i + 2);
					i += 2;
				} else if (ch === '\'') {
					mode = 'single';
					out += ch;
					i++;
				} else if (ch === '$' && script[i + 1] === '\'') {
					mode = 'ansi';
					out += '$\'';
					i += 2;
				} else if (ch === '"') {
					mode = 'double';
					out += ch;
					i++;
				} else if (ch === '#' && startOfWord()) {
					mode = 'comment';
					out += ch;
					i++;
				} else if (ch === '<' && script[i + 1] === '<' && script[i + 2] !== '<' && script[i - 1] !== '<') {
					readHeredocOperator();
				} else if (ch === '\n') {
					onNewline();
				} else if (ch === '{' && tryReference(v => `"\${${v}}"`)) {
					// appended by tryReference
				} else {
					out += ch;
					i++;
				}
				break;
			}
			case 'double': {
				if (ch === '\\') {
					out += script.slice(i, i + 2);
					i += 2;
				} else if (ch === '"') {
					mode = 'plain';
					out += ch;
					i++;
				} else if (ch === '{' && tryReference(v => `\${${v}}`)) {
					// appended
				} else {
					out += ch;
					i++;
				}
				break;
			}
			case 'single': {
				if (ch === '\'') {
					mode = 'plain';
					out += ch;
					i++;
				} else if (ch === '{' && tryReference(v => `'"\${${v}}"'`)) {
					// appended
				} else {
					out += ch;
					i++;
				}
				break;
			}
			case 'ansi': {
				if (ch === '\\') {
					out += script.slice(i, i + 2);
					i += 2;
				} else if (ch === '\'') {
					mode = 'plain';
					out += ch;
					i++;
				} else if (ch === '{' && tryReference(v => `'"\${${v}}"$'`)) {
					// appended
				} else {
					out += ch;
					i++;
				}
				break;
			}
			case 'comment': {
				if (ch === '\n') {
					onNewline();
				} else {
					out += ch;
					i++;
				}
				break;
			}
			case 'heredoc': {
				// at the start of a body line
				const eol = script.indexOf('\n', i);
				const lineEnd = eol < 0 ? n : eol;
				const line = script.slice(i, lineEnd);
				const doc = heredoc!;
				if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
					out += line;
					i = lineEnd;
					if (i < n) {
						onNewline();
					}
					break;
				}
				if (doc.quoted) {
					out += line;
					i = lineEnd;
				} else {
					while (i < lineEnd) {
						if (script[i] === '\\') {
							out += script.slice(i, Math.min(i + 2, lineEnd));
							i += 2;
						} else if (script[i] === '{' && tryReference(v => `\${${v}}`)) {
							// appended
						} else {
							out += script[i];
							i++;
						}
					}
					i = lineEnd;
				}
				if (i < n) {
					out += '\n';
					i++;
				}
				break;
			}
		}
	}
	return { script: out, env, variables };
}

// ---------------------------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------------------------

export interface IShellPlan {
	readonly shell: ShellType;
	/** Script to run (references replaced by "${ANYAGENT_VAR_...}"). */
	readonly script: string;
	readonly cwd: string;
	/** User environment lines (resolved) plus the ANYAGENT_VAR_ values. */
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
	/** Names of the variables passed to the script. */
	readonly variables: readonly string[];
}

export interface IShellBuildOptions {
	/** Resolves {variable} references in one text value (returns the text unchanged when a reference has no value). */
	readonly resolve: (text: string) => string;
	/** Base of relative paths and the default working directory (the workspace / workflow folder). */
	readonly baseDir?: string;
	/** Home directory, for `~` paths. */
	readonly homeDir?: string;
}

export type ShellPlanResult = { readonly ok: true; readonly plan: IShellPlan } | { readonly ok: false; readonly error: string };

const UNRESOLVED_VARIABLE = /\{\{?[^{}\s]+\}?\}/;

/** Timeout in seconds of a config, or an error. */
export function shellTimeoutSecOf(config: IShellComponentConfig): { seconds: number; error?: string } {
	const raw = config.shellTimeoutSec;
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return { seconds: SHELL_DEFAULT_TIMEOUT_SEC };
	}
	const seconds = Number(String(raw).trim());
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > SHELL_MAX_TIMEOUT_SEC) {
		return { seconds: SHELL_DEFAULT_TIMEOUT_SEC, error: `Timeout must be a number of seconds between 1 and ${SHELL_MAX_TIMEOUT_SEC} (got '${raw}').` };
	}
	return { seconds };
}

/** Builds what runs: variables passed as environment, paths made absolute, settings checked. */
export function buildShellPlan(config: IShellComponentConfig, options: IShellBuildOptions): ShellPlanResult {
	const rawScript = String(config.shellScript ?? '');
	if (!rawScript.trim()) {
		return { ok: false, error: 'Script is empty: write a command or script.' };
	}
	const shellRaw = String(config.shellType ?? '').trim();
	const shell = shellRaw ? normalizeShellType(shellRaw) : defaultShellType();
	if (!shell) {
		return { ok: false, error: `Shell '${shellRaw}' is not supported (use zsh, bash or sh).` };
	}
	const timeout = shellTimeoutSecOf(config);
	if (timeout.error) {
		return { ok: false, error: timeout.error };
	}

	// Working directory
	const cwdText = options.resolve(String(config.shellCwd ?? '')).trim();
	const unresolvedCwd = UNRESOLVED_VARIABLE.exec(cwdText);
	if (unresolvedCwd) {
		return { ok: false, error: `Working directory: variable ${unresolvedCwd[0]} has no value.` };
	}
	let cwd = cwdText;
	if (!cwd) {
		cwd = options.baseDir || options.homeDir || '';
		if (!cwd) {
			return { ok: false, error: 'No working directory: set one (there is no workspace folder).' };
		}
	} else {
		if (options.homeDir && (cwd === '~' || cwd.startsWith('~/'))) {
			cwd = join(options.homeDir, cwd.slice(1));
		}
		if (!isAbsolute(cwd)) {
			if (!options.baseDir) {
				return { ok: false, error: `Working directory '${cwdText}' is relative and there is no workspace folder to resolve it against; use an absolute path.` };
			}
			cwd = join(options.baseDir, cwd);
		}
	}

	// Environment lines
	const parsedEnv = parseShellEnv(config.shellEnv);
	if (parsedEnv.errors.length) {
		return { ok: false, error: `Environment: ${parsedEnv.errors.join('; ')}.` };
	}
	const env: Record<string, string> = {};
	for (const entry of parsedEnv.entries) {
		const value = options.resolve(entry.value);
		const unresolved = UNRESOLVED_VARIABLE.exec(value);
		if (unresolved && UNRESOLVED_VARIABLE.test(entry.value)) {
			return { ok: false, error: `Environment ${entry.key}: variable ${unresolved[0]} has no value.` };
		}
		env[entry.key] = value.replace(/\0/g, '');
	}

	// Script: references become environment variables
	const substitution = substituteShellVariables(rawScript, reference => {
		const value = options.resolve(reference);
		return value === reference ? undefined : value;
	});
	let varBytes = 0;
	for (const value of Object.values(substitution.env)) {
		varBytes += new TextEncoder().encode(value).length;
	}
	if (varBytes > SHELL_MAX_VARIABLE_ENV_BYTES) {
		return { ok: false, error: `The values of the script's variables are too large to pass to the shell (${varBytes} bytes, limit ${SHELL_MAX_VARIABLE_ENV_BYTES}). Write large data to a file first and read the file in the script.` };
	}
	return {
		ok: true,
		plan: {
			shell,
			script: substitution.script,
			cwd,
			env: { ...env, ...substitution.env },
			timeoutMs: timeout.seconds * 1000,
			variables: substitution.variables
		}
	};
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

/** One run as returned by the executor (ILocalGitService.execShell). */
export interface IShellStepResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly timedOut?: boolean;
	readonly cancelled?: boolean;
	readonly error?: string;
}

export type ShellExecutor = (plan: IShellPlan) => Promise<IShellStepResult>;

/** A result for a configuration that could not run (invalid settings, not confirmed, missing service, ...). */
export function shellFailureResult(config: IShellComponentConfig, error: string, extra: Partial<IShellRunResult> = {}): IShellRunResult {
	return {
		ok: false,
		exitCode: -1,
		stdout: '',
		stderr: error,
		command: String(config.shellScript ?? ''),
		shell: normalizeShellType(config.shellType) ?? defaultShellType(),
		cwd: String(config.shellCwd ?? ''),
		durationMs: 0,
		error,
		executedAt: new Date().toISOString(),
		...extra
	};
}

/** Runs a plan through the executor and maps the result. */
export async function runShellPlan(plan: IShellPlan, exec: ShellExecutor): Promise<IShellRunResult> {
	const res = await exec(plan);
	const ok = res.exitCode === 0 && !res.error;
	let error = res.error;
	if (!ok && !error) {
		error = `${plan.shell} exited with code ${res.exitCode}`;
	}
	return {
		ok,
		exitCode: res.exitCode,
		stdout: res.stdout,
		stderr: res.stderr || (!ok && res.error ? res.error : ''),
		command: plan.script,
		shell: plan.shell,
		cwd: plan.cwd,
		durationMs: res.durationMs,
		timedOut: res.timedOut || undefined,
		cancelled: res.cancelled || undefined,
		error,
		executedAt: new Date().toISOString()
	};
}

// ---------------------------------------------------------------------------------------------
// Outputs (identical for ticket runs and workflow node runs)
// ---------------------------------------------------------------------------------------------

/** Names of the structured output fields: `{Label}.ok`, `{Label}.exitCode`, ... */
export const SHELL_OUTPUT_FIELDS = ['ok', 'exitCode', 'stdout', 'stderr', 'command', 'cwd', 'durationMs'] as const;
export type ShellOutputField = typeof SHELL_OUTPUT_FIELDS[number];

/** Main text output: stdout, or (when the script failed) stderr / the error. */
export function shellMainOutput(result: IShellRunResult): string {
	if (result.ok) {
		return result.stdout;
	}
	return result.stderr || result.stdout || result.error || '';
}

/** The structured output fields of a result. */
export function shellOutputFields(result: IShellRunResult): Record<ShellOutputField, string | number | boolean> {
	return {
		ok: result.ok,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		command: result.command,
		cwd: result.cwd,
		durationMs: result.durationMs
	};
}

function cleanKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

/**
 * Publishes a shell result into run context variables: `{Label}` / label_key = main text, `{Label.field}` and
 * `{label_key.field}` per structured field, and `{Label}_result` / `{label_key}_result` = all fields as a dict
 * (TICKET_CONTEXT["shell_1_result"]["exitCode"] in Python). The same names are published under each of `aliases` (the
 * output variable, UI-27). The id is published by the caller.
 */
export function publishShellOutputs(context: Record<string, unknown>, label: string, result: IShellRunResult, aliases: readonly (string | undefined)[] = []): string {
	const main = shellMainOutput(result);
	const fields = shellOutputFields(result);
	for (const name of new Set([label, cleanKey(label), ...aliases.filter((a): a is string => !!a)])) {
		context[name] = main;
		context[`${name}_result`] = fields;
		for (const [field, value] of Object.entries(fields)) {
			context[`${name}.${field}`] = value;
		}
	}
	return main;
}

// ---------------------------------------------------------------------------------------------
// Ticket value (stored in ticket.md)
// ---------------------------------------------------------------------------------------------

/** The result as stored: stdout / stderr cut to SHELL_STORED_OUTPUT_MAX_BYTES with a note. */
export function toStoredShellResult(result: IShellRunResult, maxBytes = SHELL_STORED_OUTPUT_MAX_BYTES): IShellRunResult {
	return { ...result, stdout: truncateUtf8(result.stdout, maxBytes), stderr: truncateUtf8(result.stderr, maxBytes) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True for a stored shell ticket value (it has a shell setting, a marker or a last result). */
export function isShellTicketValue(value: unknown): boolean {
	return isPlainObject(value) && (isPlainObject(value.shellLastResult) || typeof value.shellConfirmedHash === 'string' || SHELL_CONFIG_KEYS.some(key => value[key] !== undefined));
}

/** Parses a stored ticket value (object or JSON text) into a shell ticket value, or undefined. */
export function normalizeShellTicketValue(raw: unknown): IShellTicketValue | undefined {
	let value = raw;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed.startsWith('{')) {
			return undefined;
		}
		try {
			value = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	if (!isShellTicketValue(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	const out: IShellTicketValue = pickShellConfig(obj);
	if (typeof obj.shellConfirmedHash === 'string' && obj.shellConfirmedHash) {
		out.shellConfirmedHash = obj.shellConfirmedHash;
	}
	if (isPlainObject(obj.shellLastResult)) {
		out.shellLastResult = obj.shellLastResult as unknown as IShellRunResult;
	}
	return out;
}

/** Ticket value to store: the ticket's own settings, the confirmation marker and the (truncated) result. */
export function buildShellTicketValue(ticketValue: IShellTicketValue | undefined, result: IShellRunResult | undefined): IShellTicketValue {
	return {
		...pickShellConfig(ticketValue),
		...(ticketValue?.shellConfirmedHash ? { shellConfirmedHash: ticketValue.shellConfirmedHash } : {}),
		...(result ? { shellLastResult: toStoredShellResult(result) } : (ticketValue?.shellLastResult ? { shellLastResult: ticketValue.shellLastResult } : {}))
	};
}

/** Main text of a stored ticket value (the last result's output), '' before the first run. */
export function shellTicketValueOutputText(value: unknown): string {
	const parsed = normalizeShellTicketValue(value);
	return parsed?.shellLastResult ? shellMainOutput(parsed.shellLastResult) : '';
}

// ---------------------------------------------------------------------------------------------
// Validation (used by validateComponentConfig)
// ---------------------------------------------------------------------------------------------

export interface IShellConfigProblem {
	readonly prop: ShellConfigKey;
	readonly code: 'required' | 'invalidValue';
	readonly message: string;
}

/** Settings that are missing or cannot work. Variable references count as values. */
export function validateShellConfig(config: IShellComponentConfig, checkRequired = true): IShellConfigProblem[] {
	const problems: IShellConfigProblem[] = [];
	if (checkRequired && !String(config.shellScript ?? '').trim()) {
		problems.push({ prop: 'shellScript', code: 'required', message: 'shellScript (the command or script) is required.' });
	}
	const shellRaw = String(config.shellType ?? '').trim();
	if (shellRaw && !normalizeShellType(shellRaw)) {
		problems.push({ prop: 'shellType', code: 'invalidValue', message: `shellType must be zsh, bash or sh (got '${shellRaw}').` });
	}
	const timeout = shellTimeoutSecOf(config);
	if (timeout.error) {
		problems.push({ prop: 'shellTimeoutSec', code: 'invalidValue', message: timeout.error });
	}
	const env = parseShellEnv(config.shellEnv);
	if (env.errors.length) {
		problems.push({ prop: 'shellEnv', code: 'invalidValue', message: `shellEnv: ${env.errors.join('; ')}.` });
	}
	return problems;
}

// ---------------------------------------------------------------------------------------------
// Human confirmation marker
// ---------------------------------------------------------------------------------------------

/** Storage key of the per-installation HMAC key (application scope, this machine only). */
export const SHELL_CONFIRMATION_KEY_STORAGE_KEY = 'anyagent.shellComponent.confirmationKey';

/** The local confirmation key; created (random 256 bits) on first use. */
export function getShellConfirmationKey(storageService: IStorageService): string {
	const existing = storageService.get(SHELL_CONFIRMATION_KEY_STORAGE_KEY, StorageScope.APPLICATION, '');
	if (existing) {
		return existing;
	}
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	const key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
	storageService.store(SHELL_CONFIRMATION_KEY_STORAGE_KEY, key, StorageScope.APPLICATION, StorageTarget.MACHINE);
	return key;
}

/** What a confirmation covers: shell, working directory, script and environment lines (as written, unresolved). */
export function shellConfirmationPayload(config: IShellComponentConfig): string {
	const text = (value: unknown) => String(value ?? '').replace(/\r\n?/g, '\n');
	return JSON.stringify(['anyagent-shell-confirmation-v1', shellTypeOf(config), text(config.shellCwd).trim(), text(config.shellScript), text(config.shellEnv).trim()]);
}

/** HMAC-SHA256 (hex) of the confirmation payload with the local key. */
export async function computeShellConfirmationHash(key: string, config: IShellComponentConfig): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await globalThis.crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(shellConfirmationPayload(config)));
	return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

/** True when one of the stored markers confirms exactly this config. */
export async function isShellConfigConfirmed(key: string, config: IShellComponentConfig, markers: readonly (string | undefined)[]): Promise<boolean> {
	const valid = markers.filter((m): m is string => typeof m === 'string' && m.length > 0);
	if (!valid.length) {
		return false;
	}
	const expected = await computeShellConfirmationHash(key, config);
	return valid.includes(expected);
}

/** Text of the failure when an unconfirmed script would run. */
export function shellNeedsConfirmationMessage(where: string): string {
	return `Shell script needs confirmation: it was written or changed by AI and has not been confirmed by a person. Open ${where} and click Confirm on the shell card (or edit the script yourself), then run again.`;
}
