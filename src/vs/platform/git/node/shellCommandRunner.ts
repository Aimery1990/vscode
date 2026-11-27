/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { IGitExecResult, IShellExecRequest, LocalShellType } from '../common/localGitService.js';
import { IRunningProcessCommand, startProcessCommand } from './processCommandRunner.js';

/*
 * Runs the script of an AnyAgent `shell` component (CI-55): `<shell> -c <script> anyagent-shell`. The script is ONE
 * argv entry (spawn without a shell), so nothing is spliced into a command line here; the values of {variables} reach
 * the script only as environment variables (see customModules/common/shellComponent.ts). Non-interactive: stdin is
 * closed, the process has no controlling terminal (own session on POSIX) and its process group is killed on timeout /
 * cancel (processCommandRunner.ts). Windows is not supported.
 */

const SHELL_CANDIDATES: Readonly<Record<LocalShellType, readonly string[]>> = {
	zsh: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'],
	bash: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'],
	sh: ['/bin/sh', '/usr/bin/sh']
};

/** Variables of the app process that must not leak into user scripts (they change how Electron binaries behave). */
const REMOVED_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_ENABLE_STACK_DUMPING'];

/** Environment that keeps common tools from waiting for input. */
export const SHELL_NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: '0',
	DEBIAN_FRONTEND: 'noninteractive'
};

/** Absolute path of a shell (first existing well-known location), or its name for a PATH lookup. */
export function resolveShellExecutable(shell: LocalShellType): string {
	for (const candidate of SHELL_CANDIDATES[shell] ?? []) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// try the next location
		}
	}
	return shell;
}

/** Starts the script; the result promise never rejects. */
export function startShellCommand(request: IShellExecRequest): IRunningProcessCommand {
	if (process.platform === 'win32') {
		return { result: Promise.resolve<IGitExecResult>({ exitCode: -1, stdout: '', stderr: '', durationMs: 0, timedOut: false, error: 'The shell component runs zsh / bash / sh and is not available on Windows.' }), kill: () => { } };
	}
	if (!Object.prototype.hasOwnProperty.call(SHELL_CANDIDATES, request.shell)) {
		return { result: Promise.resolve<IGitExecResult>({ exitCode: -1, stdout: '', stderr: '', durationMs: 0, timedOut: false, error: `Unknown shell '${request.shell}' (use zsh, bash or sh).` }), kill: () => { } };
	}
	const executable = resolveShellExecutable(request.shell);
	return startProcessCommand({
		executable,
		args: ['-c', request.script, 'anyagent-shell'],
		label: request.shell,
		baseEnv: SHELL_NON_INTERACTIVE_ENV,
		removeEnv: REMOVED_ENV,
		notFoundMessage: `${request.shell} was not found on this computer. Pick another shell.`
	}, { cwd: request.cwd, env: request.env, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes });
}

/** Runs the script and waits for the result (never rejects). */
export function runShellCommand(request: IShellExecRequest): Promise<IGitExecResult> {
	return startShellCommand(request).result;
}
