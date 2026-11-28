/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, join } from '../../../../base/common/path.js';
import { IGitRunResult } from '../../entityPersistence/common/entityPersistence.js';

/*
 * The `git` component (CI-24): which commands it offers, how a configuration becomes git argv arrays, how a run's
 * result is published (identically for ticket runs and workflow node runs) and how it is stored on the ticket.
 * Pure (no services), so the runtime, the editors and tests share it.
 *
 * Safety: arguments are argv arrays (never a shell string); options that destroy work (push --force, reset --hard)
 * are not offered; values used as refs / remotes may not start with '-'; paths and URLs follow `--`.
 */

export const GIT_COMMANDS = ['status', 'clone', 'checkout', 'pull', 'fetch', 'add', 'commit', 'push', 'log', 'diff', 'branch', 'custom'] as const;
export type GitCommand = typeof GIT_COMMANDS[number];

/** Default command of a new git component (and of a config that names none but has a repository path). */
export const GIT_DEFAULT_COMMAND: GitCommand = 'status';
/** Timeout of each git invocation. */
export const GIT_COMPONENT_TIMEOUT_MS = 120_000;
/** Bytes of stdout / stderr kept in the result stored on the ticket (the run itself sees the full output). */
export const GIT_STORED_OUTPUT_MAX_BYTES = 3072;
export const GIT_DEFAULT_LOG_COUNT = 10;
const GIT_MAX_LOG_COUNT = 1000;

/** Template / ticket settings of a git component (ICustomField names). */
export interface IGitComponentConfig {
	gitCommand?: string;
	gitRepoPath?: string;
	gitRemoteUrl?: string;
	gitCloneDir?: string;
	gitBranch?: string;
	gitRemote?: string;
	gitCreateBranch?: boolean;
	gitPaths?: string;
	gitMessage?: string;
	gitAddAll?: boolean;
	gitLogCount?: number | string;
	gitDiffTarget?: string;
	gitSetUpstream?: boolean;
	gitCustomArgs?: string;
}

export type GitConfigKey = keyof IGitComponentConfig;

export const GIT_CONFIG_KEYS: readonly GitConfigKey[] = [
	'gitCommand', 'gitRepoPath', 'gitRemoteUrl', 'gitCloneDir', 'gitBranch', 'gitRemote', 'gitCreateBranch', 'gitPaths',
	'gitMessage', 'gitAddAll', 'gitLogCount', 'gitDiffTarget', 'gitSetUpstream', 'gitCustomArgs'
];

/** Ticket value of a git component: the ticket's own settings (they win over the template) plus the last result. */
export interface IGitTicketValue extends IGitComponentConfig {
	gitLastResult?: IGitRunResult;
}

export interface IGitParamInfo {
	readonly key: GitConfigKey;
	readonly label: string;
	readonly kind: 'text' | 'multiline' | 'boolean' | 'number';
	readonly placeholder?: string;
	readonly hint?: string;
}

export const GIT_PARAM_INFO: Readonly<Record<Exclude<GitConfigKey, 'gitCommand'>, IGitParamInfo>> = {
	gitRepoPath: { key: 'gitRepoPath', label: 'Repository path', kind: 'text', placeholder: '/path/to/repo or {repo_path}', hint: 'Working directory. Absolute, ~/..., or relative to the workspace folder.' },
	gitRemoteUrl: { key: 'gitRemoteUrl', label: 'Repository URL', kind: 'text', placeholder: 'git@github.com:org/repo.git' },
	gitCloneDir: { key: 'gitCloneDir', label: 'Target directory', kind: 'text', placeholder: '~/code/repo (default: repo name in the workspace folder)' },
	gitBranch: { key: 'gitBranch', label: 'Branch', kind: 'text', placeholder: 'main' },
	gitRemote: { key: 'gitRemote', label: 'Remote', kind: 'text', placeholder: 'origin' },
	gitCreateBranch: { key: 'gitCreateBranch', label: 'Create new branch (-b)', kind: 'boolean' },
	gitPaths: { key: 'gitPaths', label: 'Paths', kind: 'text', placeholder: '. (quote paths with spaces: "my file.txt")' },
	gitMessage: { key: 'gitMessage', label: 'Commit message', kind: 'multiline', placeholder: 'Describe the change ({variables} allowed)' },
	gitAddAll: { key: 'gitAddAll', label: 'Add all changes first (git add -A)', kind: 'boolean' },
	gitLogCount: { key: 'gitLogCount', label: 'Number of commits', kind: 'number', placeholder: String(GIT_DEFAULT_LOG_COUNT) },
	gitDiffTarget: { key: 'gitDiffTarget', label: 'Target / paths (optional)', kind: 'text', placeholder: 'e.g. HEAD~1 or --stat or src/' },
	gitSetUpstream: { key: 'gitSetUpstream', label: 'Set upstream (-u)', kind: 'boolean' },
	gitCustomArgs: { key: 'gitCustomArgs', label: 'Arguments after "git"', kind: 'text', placeholder: 'e.g. stash list   or   tag -a v1.0 -m "Release"' }
};

export interface IGitCommandInfo {
	readonly label: string;
	readonly description: string;
	/** Parameters shown for the command, in order. */
	readonly params: readonly Exclude<GitConfigKey, 'gitCommand'>[];
}

export const GIT_COMMAND_INFO: Readonly<Record<GitCommand, IGitCommandInfo>> = {
	status: { label: 'status', description: 'Show the working tree status', params: ['gitRepoPath'] },
	clone: { label: 'clone', description: 'Clone a repository into a new directory', params: ['gitRemoteUrl', 'gitCloneDir', 'gitBranch'] },
	checkout: { label: 'checkout', description: 'Switch to a branch (optionally create it)', params: ['gitRepoPath', 'gitBranch', 'gitCreateBranch'] },
	pull: { label: 'pull', description: 'Fetch and merge from a remote', params: ['gitRepoPath', 'gitRemote', 'gitBranch'] },
	fetch: { label: 'fetch', description: 'Download objects and refs from a remote', params: ['gitRepoPath', 'gitRemote'] },
	add: { label: 'add', description: 'Stage file contents', params: ['gitRepoPath', 'gitPaths'] },
	commit: { label: 'commit', description: 'Record staged changes', params: ['gitRepoPath', 'gitMessage', 'gitAddAll'] },
	push: { label: 'push', description: 'Update the remote branch (never forced)', params: ['gitRepoPath', 'gitRemote', 'gitBranch', 'gitSetUpstream'] },
	log: { label: 'log', description: 'Show recent commits', params: ['gitRepoPath', 'gitLogCount'] },
	diff: { label: 'diff', description: 'Show changes', params: ['gitRepoPath', 'gitDiffTarget'] },
	branch: { label: 'branch', description: 'List branches, or create one when a name is given', params: ['gitRepoPath', 'gitBranch'] },
	custom: { label: 'custom', description: 'Run any git arguments you write', params: ['gitRepoPath', 'gitCustomArgs'] }
};

export function normalizeGitCommand(value: unknown): GitCommand | undefined {
	const key = String(value ?? '').trim().toLowerCase();
	return (GIT_COMMANDS as readonly string[]).includes(key) ? key as GitCommand : undefined;
}

// ---------------------------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------------------------

/** The git settings of an object (a field, a ticket value); other keys are dropped, undefined values omitted. */
export function pickGitConfig(source: unknown): IGitComponentConfig {
	const out: Record<string, unknown> = {};
	if (source && typeof source === 'object') {
		for (const key of GIT_CONFIG_KEYS) {
			const value = Reflect.get(source, key);
			if (value !== undefined && value !== null) {
				out[key] = value;
			}
		}
	}
	return out as IGitComponentConfig;
}

/** Template settings overlaid with the ticket's own settings (a ticket setting wins when present). */
export function effectiveGitConfig(template: IGitComponentConfig, ticketValue?: IGitComponentConfig): IGitComponentConfig {
	return { ...pickGitConfig(template), ...pickGitConfig(ticketValue) };
}

/** True for a template that only records a repository (pre CI-24 "reference" git components): nothing is run. */
export function isGitReferenceOnly(config: IGitComponentConfig): boolean {
	return !normalizeGitCommand(config.gitCommand) && !String(config.gitRepoPath ?? '').trim();
}

/** The command a config runs (default status). */
export function gitCommandOf(config: IGitComponentConfig): GitCommand {
	return normalizeGitCommand(config.gitCommand) ?? GIT_DEFAULT_COMMAND;
}

function isTrue(value: unknown): boolean {
	return value === true || value === 'true';
}

// ---------------------------------------------------------------------------------------------
// Argument tokenizer
// ---------------------------------------------------------------------------------------------

/**
 * Splits a text into arguments like a POSIX shell would split words, WITHOUT any other shell feature: whitespace
 * separates arguments, '...' keeps everything literally, "..." keeps whitespace (\" and \\ are escapes), a backslash
 * outside quotes escapes the next character. Returns an error for an unterminated quote.
 */
export function splitGitArgs(text: string): { args: string[]; error?: string } {
	const args: string[] = [];
	let current = '';
	let inToken = false;
	let quote: '\'' | '"' | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === '\'') {
			if (ch === '\'') {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
			} else if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
				current += text[++i];
			} else {
				current += ch;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			if (inToken) {
				args.push(current);
				current = '';
				inToken = false;
			}
			continue;
		}
		inToken = true;
		if (ch === '\'' || ch === '"') {
			quote = ch;
		} else if (ch === '\\' && i + 1 < text.length) {
			current += text[++i];
		} else {
			current += ch;
		}
	}
	if (quote) {
		return { args: [], error: `Unterminated ${quote === '"' ? 'double' : 'single'} quote` };
	}
	if (inToken) {
		args.push(current);
	}
	return { args };
}

/** Quotes one argument for display (POSIX style); plain arguments stay as they are. */
export function quoteGitArg(arg: string): string {
	if (arg !== '' && /^[A-Za-z0-9_@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Display text of the git invocations of a run, e.g. `git add -A && git commit -m 'Fix'`. */
export function formatGitCommandLine(steps: readonly (readonly string[])[]): string {
	return steps.map(step => ['git', ...step.map(quoteGitArg)].join(' ')).join(' && ');
}

// ---------------------------------------------------------------------------------------------
// Plan (argv) builder
// ---------------------------------------------------------------------------------------------

export interface IGitPlan {
	readonly command: GitCommand;
	/** git argument arrays, run in order (stop at the first failure). */
	readonly steps: readonly (readonly string[])[];
	/** Working directory of the steps. */
	readonly cwd: string;
	/** Repository the branch / commit are read from afterwards (the clone target for clone). */
	readonly repoPath: string;
}

export interface IGitBuildOptions {
	/** Resolves {variable} references in one text value. */
	readonly resolve: (text: string) => string;
	/** Base of relative paths (the workspace / workflow folder). */
	readonly baseDir?: string;
	/** Home directory, for `~` paths. */
	readonly homeDir?: string;
}

export type GitPlanResult = { readonly ok: true; readonly plan: IGitPlan } | { readonly ok: false; readonly command: GitCommand; readonly error: string };

const UNRESOLVED_VARIABLE = /\{\{?[^{}\s]+\}?\}/;

class GitPlanError extends Error { }

/** Builds the git argv arrays of a configuration (variables resolved, paths made absolute, values checked). */
export function buildGitPlan(config: IGitComponentConfig, options: IGitBuildOptions): GitPlanResult {
	const command = gitCommandOf(config);
	try {
		return { ok: true, plan: buildPlanOrThrow(command, config, options) };
	} catch (err) {
		if (err instanceof GitPlanError) {
			return { ok: false, command, error: err.message };
		}
		throw err;
	}
}

function buildPlanOrThrow(command: GitCommand, config: IGitComponentConfig, options: IGitBuildOptions): IGitPlan {
	const text = (key: GitConfigKey, fallback = ''): string => {
		const raw = config[key];
		if (raw === undefined || raw === null || raw === '') {
			return fallback;
		}
		return options.resolve(String(raw));
	};
	/** A single value that must be fully resolved (paths, URLs, refs). */
	const strict = (key: GitConfigKey, fallback = ''): string => {
		const value = text(key, fallback).trim();
		const unresolved = UNRESOLVED_VARIABLE.exec(value);
		if (unresolved) {
			throw new GitPlanError(`${GIT_PARAM_INFO[key as Exclude<GitConfigKey, 'gitCommand'>]?.label ?? key}: variable ${unresolved[0]} has no value.`);
		}
		return value;
	};
	const ref = (key: 'gitBranch' | 'gitRemote', fallback = ''): string => {
		const value = strict(key, fallback);
		if (value && (value.startsWith('-') || /[\s\x00-\x1f]/.test(value))) {
			throw new GitPlanError(`${GIT_PARAM_INFO[key].label} '${value}' is not valid (it may not start with '-' or contain spaces).`);
		}
		return value;
	};
	const toAbsolute = (value: string): string => {
		let p = value;
		if (options.homeDir && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) {
			p = join(options.homeDir, p.slice(1));
		}
		if (isAbsolute(p)) {
			return p;
		}
		if (!options.baseDir) {
			throw new GitPlanError(`Path '${value}' is relative and there is no workspace folder to resolve it against; use an absolute path.`);
		}
		return join(options.baseDir, p);
	};
	/** Tokenizes first, then resolves variables per argument (a variable is always one argument, even with spaces). */
	const argList = (key: GitConfigKey, fallback = ''): string[] => {
		const raw = config[key];
		const source = raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw);
		const split = splitGitArgs(source);
		if (split.error) {
			throw new GitPlanError(`${GIT_PARAM_INFO[key as Exclude<GitConfigKey, 'gitCommand'>]?.label ?? key}: ${split.error}.`);
		}
		return split.args.map(arg => options.resolve(arg));
	};

	if (command === 'clone') {
		const url = strict('gitRemoteUrl');
		if (!url) {
			throw new GitPlanError('Repository URL is required for git clone.');
		}
		const branch = ref('gitBranch');
		const dirText = strict('gitCloneDir');
		let target: string;
		if (dirText) {
			target = toAbsolute(dirText);
		} else {
			const name = url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop()?.replace(/\.git$/i, '') || '';
			if (!name || name === '.' || name === '..') {
				throw new GitPlanError('Target directory is required: no folder name can be derived from the URL.');
			}
			target = toAbsolute(name);
		}
		const cwd = options.baseDir || options.homeDir || '';
		if (!cwd) {
			throw new GitPlanError('No working directory for git clone (no workspace folder).');
		}
		return { command, steps: [['clone', ...(branch ? ['--branch', branch] : []), '--', url, target]], cwd, repoPath: target };
	}

	const repoText = strict('gitRepoPath');
	if (!repoText) {
		throw new GitPlanError(`Repository path is required for git ${command}.`);
	}
	const repoPath = toAbsolute(repoText);
	const plan = (steps: string[][]): IGitPlan => ({ command, steps, cwd: repoPath, repoPath });

	switch (command) {
		case 'status':
			return plan([['status']]);
		case 'checkout': {
			const branch = ref('gitBranch');
			if (!branch) {
				throw new GitPlanError('Branch is required for git checkout.');
			}
			return plan([['checkout', ...(isTrue(config.gitCreateBranch) ? ['-b'] : []), branch]]);
		}
		case 'pull': {
			const branch = ref('gitBranch');
			const remote = ref('gitRemote') || (branch ? 'origin' : '');
			return plan([['pull', ...(remote ? [remote] : []), ...(branch ? [branch] : [])]]);
		}
		case 'fetch': {
			const remote = ref('gitRemote');
			return plan([['fetch', ...(remote ? [remote] : [])]]);
		}
		case 'add': {
			const paths = argList('gitPaths', '.');
			return plan([['add', '--', ...(paths.length ? paths : ['.'])]]);
		}
		case 'commit': {
			const message = text('gitMessage');
			if (!message.trim()) {
				throw new GitPlanError('Commit message is required for git commit.');
			}
			const commit = ['commit', '-m', message];
			return plan(isTrue(config.gitAddAll) ? [['add', '-A'], commit] : [commit]);
		}
		case 'push': {
			const setUpstream = isTrue(config.gitSetUpstream);
			let branch = ref('gitBranch');
			let remote = ref('gitRemote');
			if (setUpstream || branch) {
				remote = remote || 'origin';
			}
			if (setUpstream && !branch) {
				branch = 'HEAD';
			}
			return plan([['push', ...(setUpstream ? ['--set-upstream'] : []), ...(remote ? [remote] : []), ...(branch ? [branch] : [])]]);
		}
		case 'log': {
			const rawCount = text('gitLogCount', String(GIT_DEFAULT_LOG_COUNT)).trim();
			const count = Number(rawCount);
			if (!Number.isFinite(count) || count < 1) {
				throw new GitPlanError(`Number of commits must be a positive number (got '${rawCount}').`);
			}
			return plan([['log', '-n', String(Math.min(Math.floor(count), GIT_MAX_LOG_COUNT)), '--date=short', '--pretty=format:%h %ad %an  %s']]);
		}
		case 'diff':
			return plan([['diff', ...argList('gitDiffTarget')]]);
		case 'branch': {
			const name = ref('gitBranch');
			return plan([name ? ['branch', name] : ['branch', '-a']]);
		}
		case 'custom': {
			const args = argList('gitCustomArgs');
			if (args[0] === 'git') {
				args.shift();
			}
			if (args.length === 0 || args.every(a => !a.trim())) {
				throw new GitPlanError('Custom git command is empty: write the arguments after "git" (e.g. stash list).');
			}
			return plan([args]);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

/** One git invocation as returned by the executor (ILocalGitService.exec). */
export interface IGitStepResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly timedOut?: boolean;
	readonly cancelled?: boolean;
	readonly error?: string;
}

export type GitExecutor = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<IGitStepResult>;

/** A result for a configuration that could not run (invalid settings, missing service, ...). */
export function gitFailureResult(command: string, error: string, repoPath = ''): IGitRunResult {
	return { ok: false, exitCode: -1, stdout: '', stderr: error, command: '', gitCommand: command, repoPath, branch: '', commit: '', durationMs: 0, error, executedAt: new Date().toISOString() };
}

/** Runs the steps of a plan in order (stops at the first failure), then reads the current branch and HEAD commit. */
export async function runGitPlan(plan: IGitPlan, exec: GitExecutor, timeoutMs = GIT_COMPONENT_TIMEOUT_MS): Promise<IGitRunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let exitCode = 0;
	let durationMs = 0;
	let timedOut = false;
	let error: string | undefined;
	let cancelled = false;
	for (const step of plan.steps) {
		const res = await exec(step, plan.cwd, timeoutMs);
		durationMs += res.durationMs;
		if (res.stdout) {
			stdout.push(res.stdout);
		}
		if (res.stderr) {
			stderr.push(res.stderr);
		}
		exitCode = res.exitCode;
		timedOut = timedOut || !!res.timedOut;
		cancelled = cancelled || !!res.cancelled;
		if (res.exitCode !== 0) {
			error = res.error || `git ${step[0] ?? ''} exited with code ${res.exitCode}`;
			if (res.error && !res.stderr) {
				stderr.push(res.error);
			}
			break;
		}
	}
	let branch = '';
	let commit = '';
	if (!cancelled) {
		const info = async (args: string[]): Promise<string> => {
			try {
				const res = await exec(args, plan.repoPath, 10_000);
				return res.exitCode === 0 ? res.stdout.trim() : '';
			} catch {
				return '';
			}
		};
		if (plan.command !== 'clone' || exitCode === 0) {
			branch = await info(['rev-parse', '--abbrev-ref', 'HEAD']) || await info(['symbolic-ref', '--short', '-q', 'HEAD']);
			commit = await info(['rev-parse', '--short', 'HEAD']);
		}
	}
	return {
		ok: exitCode === 0,
		exitCode,
		stdout: stdout.join('\n'),
		stderr: stderr.join('\n'),
		command: formatGitCommandLine(plan.steps),
		gitCommand: plan.command,
		repoPath: plan.repoPath,
		branch,
		commit,
		durationMs,
		timedOut: timedOut || undefined,
		error,
		executedAt: new Date().toISOString()
	};
}

// ---------------------------------------------------------------------------------------------
// Outputs (identical for ticket runs and workflow node runs)
// ---------------------------------------------------------------------------------------------

/** Names of the structured output fields: `{Label}.ok`, `{Label}.exitCode`, ... */
export const GIT_OUTPUT_FIELDS = ['ok', 'exitCode', 'stdout', 'stderr', 'command', 'repoPath', 'branch', 'commit'] as const;
export type GitOutputField = typeof GIT_OUTPUT_FIELDS[number];

/** Main text output: stdout, or (when the command failed) stderr / the error. */
export function gitMainOutput(result: IGitRunResult): string {
	if (result.ok) {
		return result.stdout;
	}
	return result.stderr || result.stdout || result.error || '';
}

/** The structured output fields of a result. */
export function gitOutputFields(result: IGitRunResult): Record<GitOutputField, string | number | boolean> {
	return {
		ok: result.ok,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		command: result.command,
		repoPath: result.repoPath,
		branch: result.branch,
		commit: result.commit
	};
}

function cleanKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

/**
 * Publishes a git result into run context variables: `{Label}` / label_key = main text, `{Label.field}` and
 * `{label_key.field}` for each structured field, and `{Label}_result` / `{label_key}_result` = all fields as a dict
 * (TICKET_CONTEXT["git_1_result"]["exitCode"] in Python). The same names are published under each of `aliases` (the
 * output variable, UI-27), so `{repo_status.stdout}` works after the variable was renamed. The id is published by the
 * caller.
 */
export function publishGitOutputs(context: Record<string, unknown>, label: string, result: IGitRunResult, aliases: readonly (string | undefined)[] = []): string {
	const main = gitMainOutput(result);
	const fields = gitOutputFields(result);
	const key = cleanKey(label);
	for (const name of new Set([label, key, ...aliases.filter((a): a is string => !!a)])) {
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

/** Cuts a text to `maxBytes` UTF-8 bytes (no broken character) and appends a note with the full size. */
export function truncateUtf8(text: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	if (bytes.length <= maxBytes) {
		return text;
	}
	const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, '');
	return `${head}\n… [truncated: ${bytes.length} bytes in total, first ${maxBytes} kept]`;
}

/** The result as stored on the ticket: stdout / stderr cut to GIT_STORED_OUTPUT_MAX_BYTES with a note. */
export function toStoredGitResult(result: IGitRunResult, maxBytes = GIT_STORED_OUTPUT_MAX_BYTES): IGitRunResult {
	return { ...result, stdout: truncateUtf8(result.stdout, maxBytes), stderr: truncateUtf8(result.stderr, maxBytes) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True for a stored git ticket value (it has a git setting or a last result). */
export function isGitTicketValue(value: unknown): boolean {
	return isPlainObject(value) && (isPlainObject(value.gitLastResult) || GIT_CONFIG_KEYS.some(key => value[key] !== undefined));
}

/** Parses a stored ticket value (object or JSON text) into a git ticket value, or undefined. */
export function normalizeGitTicketValue(raw: unknown): IGitTicketValue | undefined {
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
	if (!isGitTicketValue(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	const out: IGitTicketValue = pickGitConfig(obj);
	if (isPlainObject(obj.gitLastResult)) {
		out.gitLastResult = obj.gitLastResult as unknown as IGitRunResult;
	}
	return out;
}

/** Ticket value to store after a run: the ticket's own settings plus the (truncated) result. */
export function buildGitTicketValue(ticketConfig: IGitComponentConfig | undefined, result: IGitRunResult | undefined): IGitTicketValue {
	return { ...pickGitConfig(ticketConfig), ...(result ? { gitLastResult: toStoredGitResult(result) } : {}) };
}

/** Main text of a stored ticket value (the last result's output), '' before the first run. */
export function gitTicketValueOutputText(value: unknown): string {
	const parsed = normalizeGitTicketValue(value);
	return parsed?.gitLastResult ? gitMainOutput(parsed.gitLastResult) : '';
}

// ---------------------------------------------------------------------------------------------
// Validation (used by validateComponentConfig)
// ---------------------------------------------------------------------------------------------

export interface IGitConfigProblem {
	readonly prop: GitConfigKey;
	readonly code: 'required' | 'invalidValue';
	readonly message: string;
}

/** Settings a command needs, and values that cannot work. Variable references count as values. */
export function validateGitConfig(config: IGitComponentConfig, checkRequired = true): IGitConfigProblem[] {
	const problems: IGitConfigProblem[] = [];
	if (isGitReferenceOnly(config)) {
		return problems;
	}
	const command = gitCommandOf(config);
	const has = (key: GitConfigKey) => String(config[key] ?? '').trim() !== '';
	const need = (key: GitConfigKey, what: string) => {
		if (checkRequired && !has(key)) {
			problems.push({ prop: key, code: 'required', message: `${what} is required for git ${command}.` });
		}
	};
	if (command === 'clone') {
		need('gitRemoteUrl', 'gitRemoteUrl (repository URL)');
	} else {
		need('gitRepoPath', 'gitRepoPath (repository path)');
	}
	if (command === 'checkout') {
		need('gitBranch', 'gitBranch');
	}
	if (command === 'commit') {
		need('gitMessage', 'gitMessage');
	}
	if (command === 'custom') {
		need('gitCustomArgs', 'gitCustomArgs');
	}
	for (const key of ['gitBranch', 'gitRemote'] as const) {
		const value = String(config[key] ?? '').trim();
		if (value.startsWith('-')) {
			problems.push({ prop: key, code: 'invalidValue', message: `${key} may not start with '-'.` });
		}
	}
	if (has('gitCustomArgs') && splitGitArgs(String(config.gitCustomArgs)).error) {
		problems.push({ prop: 'gitCustomArgs', code: 'invalidValue', message: `gitCustomArgs: ${splitGitArgs(String(config.gitCustomArgs)).error}.` });
	}
	if (has('gitLogCount') && !UNRESOLVED_VARIABLE.test(String(config.gitLogCount)) && !(Number(config.gitLogCount) >= 1)) {
		problems.push({ prop: 'gitLogCount', code: 'invalidValue', message: 'gitLogCount must be a positive number.' });
	}
	return problems;
}
