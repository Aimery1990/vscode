/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { IGitExecOptions, IGitExecResult } from '../common/localGitService.js';

/*
 * Runs one local process for the AnyAgent `git` (CI-24) and `shell` (CI-55) components. The process never waits for a
 * person: stdin is closed, and on POSIX it runs in its own session (no controlling terminal); the whole process group
 * is killed on timeout / cancel (SIGTERM, then SIGKILL after 2 s). stdout / stderr are captured up to a byte limit
 * each. The result promise never rejects: the exit code (or `error`) tells what happened.
 */

/** Default timeout of a command. */
export const PROCESS_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
/** Default bytes kept per output stream. */
export const PROCESS_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface IRunningProcessCommand {
	readonly result: Promise<IGitExecResult>;
	/** Stops the command (and its child processes). */
	kill(): void;
}

export interface IProcessCommandSpec {
	/** Executable (a name looked up on PATH, or an absolute path). */
	readonly executable: string;
	/** argv after the executable; passed to spawn without a shell. */
	readonly args: readonly string[];
	/** Name used in messages, e.g. `git` or `zsh`. */
	readonly label: string;
	/** Environment set over the process environment and under `options.env`. */
	readonly baseEnv?: Readonly<Record<string, string>>;
	/** Variables removed from the inherited process environment. */
	readonly removeEnv?: readonly string[];
	/** Message when the executable does not exist. */
	readonly notFoundMessage?: string;
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

/** Starts the process; the result promise never rejects. */
export function startProcessCommand(spec: IProcessCommandSpec, options: IGitExecOptions = {}): IRunningProcessCommand {
	const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxOutputBytes && options.maxOutputBytes > 0 ? options.maxOutputBytes : PROCESS_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
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
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of spec.removeEnv ?? []) {
			delete env[key];
		}
		Object.assign(env, spec.baseEnv ?? {}, options.env ?? {});
		return new Promise<IGitExecResult>(resolve => {
			const stdout = new StreamBuffer(maxBytes);
			const stderr = new StreamBuffer(maxBytes);
			let spawnError: string | undefined;
			let settled = false;
			try {
				proc = cp.spawn(spec.executable, [...spec.args], {
					cwd: options.cwd,
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					detached: !isWindows,
					windowsHide: true,
					shell: false
				});
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				resolve(fail(code === 'E2BIG'
					? `Could not start ${spec.label}: the environment / arguments are too large (E2BIG).`
					: `Could not start ${spec.label}: ${(err as Error)?.message ?? String(err)}`));
				return;
			}
			const timer = setTimeout(() => stop('timeout'), timeoutMs);
			proc.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
			proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
			proc.on('error', (err: NodeJS.ErrnoException) => {
				spawnError = err.code === 'ENOENT'
					? (spec.notFoundMessage ?? `${spec.label} executable not found ('${spec.executable}').`)
					: err.code === 'E2BIG' ? `Could not start ${spec.label}: the environment / arguments are too large (E2BIG).` : (err.message || String(err));
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
					error = `${spec.label} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped`;
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
