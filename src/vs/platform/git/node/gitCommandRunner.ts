/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { IGitExecOptions, IGitExecResult } from '../common/localGitService.js';

/*
 * Runs one git command for the AnyAgent `git` component (CI-24). The arguments are an argv array passed to spawn
 * without a shell, so no value can inject shell syntax. The process never waits for a person:
 * - GIT_TERMINAL_PROMPT=0 (git does not ask for credentials), GCM_INTERACTIVE=never, SSH_ASKPASS_REQUIRE=never;
 * - GIT_EDITOR / GIT_SEQUENCE_EDITOR = true and GIT_MERGE_AUTOEDIT=no (no editor is opened);
 * - on POSIX the process runs in its own session (no controlling terminal, so ssh cannot prompt either) and the whole
 *   process group is killed on timeout / cancel.
 * Credentials come from the user's own credential helpers / SSH agent only.
 */

/** Default timeout of a git command. */
export const GIT_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
/** Default bytes kept per output stream. */
export const GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Environment that keeps git non-interactive. */
export const GIT_NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: '0',
	GCM_INTERACTIVE: 'never',
	SSH_ASKPASS_REQUIRE: 'never',
	GIT_EDITOR: 'true',
	GIT_SEQUENCE_EDITOR: 'true',
	GIT_MERGE_AUTOEDIT: 'no',
	GIT_PAGER: 'cat'
};

export interface IRunningGitCommand {
	readonly result: Promise<IGitExecResult>;
	/** Stops the command (and its child processes). */
	kill(): void;
}

class StreamBuffer {
	private readonly _chunks: Buffer[] = [];
	private _size = 0;
	truncated = false;

	constructor(private readonly _max: number) { }

	push(chunk: Buffer): void {
		if (this._size >= this._max) {
			this.truncated = true;
			return;
		}
		const room = this._max - this._size;
		const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
		if (part.length < chunk.length) {
			this.truncated = true;
		}
		this._chunks.push(part);
		this._size += part.length;
	}

	text(): string {
		const text = Buffer.concat(this._chunks).toString('utf8');
		return this.truncated ? `${text}\n… [output truncated after ${this._max} bytes]` : text;
	}
}

/** Starts `git <args>`; the result promise never rejects. */
export function startGitCommand(args: readonly string[], options: IGitExecOptions = {}, gitPath = 'git'): IRunningGitCommand {
	const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : GIT_EXEC_DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxOutputBytes && options.maxOutputBytes > 0 ? options.maxOutputBytes : GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
	const isWindows = process.platform === 'win32';
	const start = Date.now();
	let proc: cp.ChildProcess | undefined;
	let killRequested: 'timeout' | 'cancel' | undefined;

	const killTree = (signal: NodeJS.Signals) => {
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
			return;
		}
		try {
			if (!isWindows && proc.pid) {
				process.kill(-proc.pid, signal);
			} else {
				proc.kill(signal);
			}
		} catch {
			try { proc.kill(signal); } catch { /* already gone */ }
		}
	};
	const stop = (reason: 'timeout' | 'cancel') => {
		if (killRequested) {
			return;
		}
		killRequested = reason;
		killTree('SIGTERM');
		setTimeout(() => killTree('SIGKILL'), 2000);
	};

	const result = (async (): Promise<IGitExecResult> => {
		const fail = (error: string): IGitExecResult => ({ exitCode: -1, stdout: '', stderr: '', durationMs: Date.now() - start, timedOut: false, error });
		if (options.cwd) {
			try {
				const stat = await fs.stat(options.cwd);
				if (!stat.isDirectory()) {
					return fail(`Not a directory: ${options.cwd}`);
				}
			} catch {
				return fail(`Directory does not exist: ${options.cwd}`);
			}
		}
		if (killRequested) {
			return { ...fail('Cancelled'), cancelled: true };
		}
		return new Promise<IGitExecResult>(resolve => {
			const stdout = new StreamBuffer(maxBytes);
			const stderr = new StreamBuffer(maxBytes);
			let spawnError: string | undefined;
			let settled = false;
			try {
				proc = cp.spawn(gitPath, [...args], {
					cwd: options.cwd,
					env: { ...process.env, ...GIT_NON_INTERACTIVE_ENV, ...(options.env ?? {}) },
					stdio: ['ignore', 'pipe', 'pipe'],
					detached: !isWindows,
					windowsHide: true,
					shell: false
				});
			} catch (err) {
				resolve(fail(`Could not start git: ${(err as Error)?.message ?? String(err)}`));
				return;
			}
			const timer = setTimeout(() => stop('timeout'), timeoutMs);
			proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
			proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
			proc.on('error', (err: NodeJS.ErrnoException) => {
				spawnError = err.code === 'ENOENT' ? `git executable not found ('${gitPath}'). Install git or add it to PATH.` : (err.message || String(err));
				// 'close' normally follows; make sure the promise settles even if it does not
				setTimeout(() => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(fail(spawnError!));
					}
				}, 200);
			});
			proc.on('close', (code, signal) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				const timedOut = killRequested === 'timeout';
				const cancelled = killRequested === 'cancel';
				let exitCode = typeof code === 'number' ? code : (timedOut ? 124 : (signal ? 128 : -1));
				let error: string | undefined;
				if (spawnError) {
					exitCode = -1;
					error = spawnError;
				} else if (timedOut) {
					error = `git timed out after ${Math.round(timeoutMs / 1000)}s and was stopped`;
				} else if (cancelled) {
					error = 'Cancelled';
				}
				resolve({
					exitCode,
					stdout: stdout.text(),
					stderr: stderr.text(),
					durationMs: Date.now() - start,
					timedOut,
					cancelled: cancelled || undefined,
					stdoutTruncated: stdout.truncated || undefined,
					stderrTruncated: stderr.truncated || undefined,
					error
				});
			});
		});
	})();

	return { result, kill: () => stop('cancel') };
}

/** Runs `git <args>` and waits for the result (never rejects). */
export function runGitCommand(args: readonly string[], options: IGitExecOptions = {}, gitPath = 'git'): Promise<IGitExecResult> {
	return startGitCommand(args, options, gitPath).result;
}
