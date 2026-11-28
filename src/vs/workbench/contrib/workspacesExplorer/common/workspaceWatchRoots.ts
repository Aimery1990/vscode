/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';

/**
 * File watching for Managed Workspaces outside the opened folders (UI-30).
 *
 * Only the opened workspace folders are watched by the workbench, so the Workspaces tree caches (child counts,
 * sub-tree summaries, ticket metadata) of any other managed workspace never heard about changes on disk. The service
 * starts one recursive watcher per such workspace root; this module holds the pure parts: which roots need a watcher
 * and which folders the watchers skip.
 */

/** Folders whose contents never affect the tree (ticket folders, ticket.md, README.md, run outcomes). */
export const MANAGED_WORKSPACE_WATCH_EXCLUDES: readonly string[] = [
	'**/.git/**',
	'**/node_modules/**',
	'**/attachments/**',
	'**/.venv/**',
	'**/__pycache__/**',
];

/** True when `resource` is `root` or below it. */
export function isEqualOrUnder(resource: URI, root: URI): boolean {
	return extUriBiasedIgnorePathCase.isEqualOrParent(resource, root);
}

/**
 * The workspace roots that need their own watcher: those not inside (or equal to) an opened folder, without
 * duplicates and without roots nested in another returned root (a recursive watcher already covers them).
 */
export function computeExternalWatchRoots(workspaceRoots: readonly URI[], openedFolders: readonly URI[]): URI[] {
	const candidates = workspaceRoots.filter(root => !openedFolders.some(folder => isEqualOrUnder(root, folder)));
	// shortest paths first, so a nested root is always checked against its already accepted parent
	const sorted = [...candidates].sort((a, b) => a.path.length - b.path.length);
	const result: URI[] = [];
	for (const root of sorted) {
		if (!result.some(accepted => isEqualOrUnder(root, accepted))) {
			result.push(root);
		}
	}
	return result;
}
