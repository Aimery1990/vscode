/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IGitExecOptions, IGitExecResult } from '../common/localGitService.js';
import { IRunningProcessCommand, PROCESS_EXEC_DEFAULT_MAX_OUTPUT_BYTES, PROCESS_EXEC_DEFAULT_TIMEOUT_MS, startProcessCommand } from './processCommandRunner.js';

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
export const GIT_EXEC_DEFAULT_TIMEOUT_MS = PROCESS_EXEC_DEFAULT_TIMEOUT_MS;
/** Default bytes kept per output stream. */
export const GIT_EXEC_DEFAULT_MAX_OUTPUT_BYTES = PROCESS_EXEC_DEFAULT_MAX_OUTPUT_BYTES;

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

export type IRunningGitCommand = IRunningProcessCommand;

/** Starts `git <args>`; the result promise never rejects. */
export function startGitCommand(args: readonly string[], options: IGitExecOptions = {}, gitPath = 'git'): IRunningGitCommand {
	return startProcessCommand({
		executable: gitPath,
		args,
		label: 'git',
		baseEnv: GIT_NON_INTERACTIVE_ENV,
		notFoundMessage: `git executable not found ('${gitPath}'). Install git or add it to PATH.`
	}, options);
}

/** Runs `git <args>` and waits for the result (never rejects). */
export function runGitCommand(args: readonly string[], options: IGitExecOptions = {}, gitPath = 'git'): Promise<IGitExecResult> {
	return startGitCommand(args, options, gitPath).result;
}
