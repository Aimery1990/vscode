/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';

/**
 * The one AnyAgent global folder (CI-26). Everything that is not stored inside a workspace lives in a
 * subfolder of it: templates, components, workflow run history and, in future, other global data.
 * The user picks it in Settings > Agent Customizations. Workflows, agents and tickets are NOT global:
 * they always live inside a workspace the user picks.
 */
export const ANYAGENT_GLOBAL_DATA_PATH_KEY = 'anyagent.globalDataPath';
/** Optional override for the template folder; unset means `<global folder>/entity_type`. */
export const ANYAGENT_GLOBAL_ENTITY_TYPE_PATH_KEY = 'anyagent.globalEntityTypePath';
/** Optional override for the component folder; unset means `<global folder>/entity_component`. */
export const ANYAGENT_GLOBAL_ENTITY_COMPONENT_PATH_KEY = 'anyagent.globalEntityComponentPath';

/** Recommended default: already in use, inside the home folder, and needs no extra macOS privacy permission. */
export const DEFAULT_ANYAGENT_GLOBAL_DATA_PATH = '~/.anyagent';

/** Subfolders of the global folder. */
export const AnyAgentGlobalSubfolder = {
	EntityType: 'entity_type',
	EntityComponent: 'entity_component',
	WorkflowHistory: 'workflow_history',
	Workflows: 'workflows'
} as const;

export interface IAnyAgentGlobalPathSettings {
	/** Raw `anyagent.globalDataPath` value (may start with `~`). */
	readonly globalDataPath?: string;
	/** Raw `anyagent.globalEntityTypePath` value (may start with `~`). */
	readonly entityTypePath?: string;
	/** Raw `anyagent.globalEntityComponentPath` value (may start with `~`). */
	readonly entityComponentPath?: string;
}

/** Resolved absolute file system paths. */
export interface IAnyAgentGlobalPaths {
	readonly root: string;
	readonly entityType: string;
	readonly entityComponent: string;
	readonly workflowHistory: string;
	readonly workflows: string;
}

/** The same paths as file URIs. */
export interface IAnyAgentGlobalFolders {
	readonly root: URI;
	readonly entityType: URI;
	readonly entityComponent: URI;
	readonly workflowHistory: URI;
	readonly workflows: URI;
}

function trimTrailingSeparators(path: string): string {
	let end = path.length;
	while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) {
		end--;
	}
	return path.substring(0, end);
}

function joinPath(base: string, child: string): string {
	const cleanBase = trimTrailingSeparators(base);
	return cleanBase.endsWith('/') || cleanBase.endsWith('\\') ? cleanBase + child : `${cleanBase}/${child}`;
}

/**
 * Expands a leading `~` (`~`, `~/x` or `~\x`) with the real user home folder. Other paths are returned trimmed.
 * `homePath` must be the real home of the current user (from `IPathService.userHome()` or the environment service).
 */
export function expandHomePath(rawPath: string, homePath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed === '~') {
		return trimTrailingSeparators(homePath);
	}
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return joinPath(homePath, trimmed.substring(2));
	}
	return trimmed;
}

/** True for a path the settings accept: absolute (`/x`, `C:\x`, `\\server\x`) or starting with `~`. */
export function isAcceptableGlobalPath(rawPath: string): boolean {
	const trimmed = rawPath.trim();
	if (!trimmed) {
		return false;
	}
	return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') ||
		trimmed.startsWith('/') || trimmed.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(trimmed);
}

/** Error text for a path setting the user typed, or undefined when it is fine (empty means "use the default"). */
export function validateGlobalPathInput(rawPath: string): string | undefined {
	if (!rawPath.trim()) {
		return undefined;
	}
	if (!isAcceptableGlobalPath(rawPath)) {
		return `"${rawPath.trim()}" is not an absolute path. Use a full path such as /Users/you/.anyagent or a path starting with ~/, or pick a folder with the Browse button.`;
	}
	return undefined;
}

/**
 * Resolves all global paths from the raw settings. Empty or invalid values fall back to the defaults:
 * the global folder defaults to `~/.anyagent`, the template and component folders to subfolders of it.
 */
export function resolveAnyAgentGlobalPaths(settings: IAnyAgentGlobalPathSettings, homePath: string): IAnyAgentGlobalPaths {
	const pick = (raw: string | undefined): string | undefined => (raw && isAcceptableGlobalPath(raw)) ? expandHomePath(raw, homePath) : undefined;
	const root = pick(settings.globalDataPath) ?? expandHomePath(DEFAULT_ANYAGENT_GLOBAL_DATA_PATH, homePath);
	return {
		root,
		entityType: pick(settings.entityTypePath) ?? joinPath(root, AnyAgentGlobalSubfolder.EntityType),
		entityComponent: pick(settings.entityComponentPath) ?? joinPath(root, AnyAgentGlobalSubfolder.EntityComponent),
		workflowHistory: joinPath(root, AnyAgentGlobalSubfolder.WorkflowHistory),
		workflows: joinPath(root, AnyAgentGlobalSubfolder.Workflows)
	};
}

/** Reads the raw path settings (profile scope storage, written by the Settings dialog). */
export function readAnyAgentGlobalPathSettings(storageService: Pick<IStorageService, 'get'>): IAnyAgentGlobalPathSettings {
	return {
		globalDataPath: storageService.get(ANYAGENT_GLOBAL_DATA_PATH_KEY, StorageScope.PROFILE),
		entityTypePath: storageService.get(ANYAGENT_GLOBAL_ENTITY_TYPE_PATH_KEY, StorageScope.PROFILE),
		entityComponentPath: storageService.get(ANYAGENT_GLOBAL_ENTITY_COMPONENT_PATH_KEY, StorageScope.PROFILE)
	};
}

/**
 * The single entry point for global folders: reads the settings and resolves them against the real user home.
 * `userHome` is a file URI, e.g. `pathService.userHome({ preferLocal: true })` or `environmentService.userHome`.
 */
export function getAnyAgentGlobalFolders(storageService: Pick<IStorageService, 'get'>, userHome: URI): IAnyAgentGlobalFolders {
	const paths = resolveAnyAgentGlobalPaths(readAnyAgentGlobalPathSettings(storageService), userHome.fsPath);
	return {
		root: URI.file(paths.root),
		entityType: URI.file(paths.entityType),
		entityComponent: URI.file(paths.entityComponent),
		workflowHistory: URI.file(paths.workflowHistory),
		workflows: URI.file(paths.workflows)
	};
}

/**
 * Workspace codes of the removed global workspaces (CI-26): GFLOW (old global workflows folder), GAGENT (old global
 * agents folder) and GLOBAL (old global jobs folder). Returns the matched code when `id` is one of them or a ticket
 * id under one of them (e.g. `GFLOW-0003`, `gflow`, `/GAGENT-0001`), otherwise undefined.
 */
export function getRetiredGlobalWorkspaceCode(id: string | undefined): string | undefined {
	if (!id) {
		return undefined;
	}
	const clean = id.trim().replace(/^[/\\]+/, '').toUpperCase();
	const match = /^(GFLOW|GAGENT|GLOBAL)(?:[-_]?\d+)?(?:[/\\].*)?$/.exec(clean);
	return match ? match[1] : undefined;
}

/** The "not found" text for a reference to a removed global workspace. */
export function getRetiredGlobalWorkspaceMessage(id: string, code: string): string {
	return `'${id.trim()}' refers to the removed global ${code} folder. Global workflows, agents and jobs no longer exist: workflows and tickets live inside a workspace. If you still need the old files, open that folder as a normal workspace (in the Workspaces view) and use its workspace code instead.`;
}

/** True when `err` is a file system permission error (EPERM / EACCES, e.g. a macOS privacy permission was denied). */
export function isFolderPermissionError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	if (toFileOperationResult(err) === FileOperationResult.FILE_PERMISSION_DENIED) {
		return true;
	}
	return /\b(EPERM|EACCES)\b|operation not permitted|permission denied/i.test(err.message);
}

/** The error text shown when a folder the user chose cannot be created or written. */
export function getFolderNotAccessibleMessage(folderPath: string): string {
	return `The folder "${folderPath}" is not accessible. AnyAgent was not allowed to create or write it, possibly because macOS privacy permission was denied. Grant AnyAgent access (System Settings > Privacy & Security > Files and Folders) or choose another folder with the folder picker.`;
}

/**
 * Converts a permission error for `folder` into a clear "folder not accessible" error; other errors are returned as is.
 * Callers rethrow the result: the operation stops, nothing falls back to another location.
 */
export function toFolderAccessError(err: unknown, folder: URI): unknown {
	return isFolderPermissionError(err) ? new Error(getFolderNotAccessibleMessage(folder.fsPath)) : err;
}
