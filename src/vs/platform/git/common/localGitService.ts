/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalGitService = createDecorator<ILocalGitService>('localGitService');

export interface IGitPullOptions {
	readonly allowHardResetOnDivergence?: boolean;
}

/** Options of {@link ILocalGitService.exec} (AnyAgent git component, CI-24). */
export interface IGitExecOptions {
	/** Working directory (native path). Must exist. */
	readonly cwd?: string;
	/** Kills the process (and its children) after this many ms. */
	readonly timeoutMs?: number;
	/** Extra environment variables (merged over the process environment and the non-interactive defaults). */
	readonly env?: Readonly<Record<string, string>>;
	/** Bytes kept per stream (stdout / stderr); the rest is dropped and the stream marked truncated. */
	readonly maxOutputBytes?: number;
}

/** Result of {@link ILocalGitService.exec}. Never rejects for a failing git command: the exit code tells. */
export interface IGitExecResult {
	/** Exit code; -1 when git could not be started, 124 on timeout (when the process reported no code). */
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly cancelled?: boolean;
	readonly stdoutTruncated?: boolean;
	readonly stderrTruncated?: boolean;
	/** Why git could not be started or was stopped. */
	readonly error?: string;
}

/** Shells the AnyAgent `shell` component can run (CI-55). */
export type LocalShellType = 'zsh' | 'bash' | 'sh';

/** Request of {@link ILocalGitService.execShell} (AnyAgent shell component, CI-55). */
export interface IShellExecRequest {
	readonly shell: LocalShellType;
	/** Script passed as ONE argv entry to `<shell> -c`; never concatenated with other text. */
	readonly script: string;
	/** Working directory (native path). Must exist. */
	readonly cwd?: string;
	/** Environment variables set over the process environment (user settings and the values of {variables}). */
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

/**
 * Low-level service for executing git commands on the local machine.
 * Used in the shared process where Node.js APIs are available.
 * All path arguments are native file-system paths.
 */
export interface ILocalGitService {
	readonly _serviceBrand: undefined;

	clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void>;
	pull(operationId: string, repoPath: string, options?: IGitPullOptions): Promise<boolean>;
	checkout(operationId: string, repoPath: string, treeish: string, detached?: boolean): Promise<void>;
	revParse(repoPath: string, ref: string): Promise<string>;
	fetch(operationId: string, repoPath: string): Promise<void>;
	revListCount(repoPath: string, fromRef: string, toRef: string): Promise<number>;
	cancel(operationId: string): Promise<void>;
	/**
	 * Runs `git <args>` as an argv array (no shell), non-interactively (`GIT_TERMINAL_PROMPT=0`, no controlling
	 * terminal), capturing stdout, stderr, exit code and duration. Cancel it with {@link cancel}.
	 */
	exec(operationId: string, args: readonly string[], options?: IGitExecOptions): Promise<IGitExecResult>;
	/**
	 * Runs `<shell> -c <script>` (CI-55) non-interactively (stdin closed, no controlling terminal), capturing stdout,
	 * stderr, exit code and duration; the process group is killed on timeout and on {@link cancel}.
	 */
	execShell(operationId: string, request: IShellExecRequest): Promise<IGitExecResult>;
}
