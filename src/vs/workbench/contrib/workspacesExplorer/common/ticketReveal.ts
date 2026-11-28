/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/** UI-36: reveal the ticket of the active editor in the Workspaces tree (like `explorer.autoReveal`). */
export const WORKSPACES_AUTO_REVEAL_SETTING = 'anyagent.workspaces.autoReveal';
export const REVEAL_ACTIVE_TICKET_COMMAND_ID = 'anyagent.workspaces.revealActiveTicket';

/** File names that stand for their ticket folder when an editor points at them instead of the folder. */
const TICKET_FILE_NAMES = new Set(['ticket.md', 'readme.md', 'workspace.md', 'workflow.json']);

function segmentsOf(uri: URI): string[] {
	return uri.path.split('/').filter(Boolean);
}

/**
 * The ticket folder for a URI an editor shows: the folder itself, or the folder of a `ticket.md` / `README.md` /
 * `workflow.json` file, or the folder that holds a `.agents/...` path.
 */
export function ticketFolderOf(uri: URI): URI {
	const segments = segmentsOf(uri);
	const agentsIndex = segments.findIndex(s => s.toLowerCase() === '.agents');
	let keep = agentsIndex >= 0 ? agentsIndex : segments.length;
	if (agentsIndex < 0 && keep > 0 && TICKET_FILE_NAMES.has(segments[keep - 1].toLowerCase())) {
		keep--;
	}
	if (keep === segments.length) {
		return uri;
	}
	return uri.with({ path: '/' + segments.slice(0, keep).join('/') });
}

/** The folder a workspace entry shows in the tree (a `.code-workspace` file stands for its folder). */
export function workspaceFolderOf(uri: URI): URI {
	const segments = segmentsOf(uri);
	if (segments.length > 0 && segments[segments.length - 1].toLowerCase().endsWith('.code-workspace')) {
		return uri.with({ path: '/' + segments.slice(0, -1).join('/') });
	}
	return uri;
}

export interface ITicketRevealPath {
	/** Index of the workspace (in the `workspaces` argument) that contains the ticket. */
	readonly workspaceIndex: number;
	/** The ticket folder. */
	readonly ticket: URI;
	/** Folders between the workspace folder and the ticket, top-down, both ends excluded. */
	readonly ancestors: readonly URI[];
}

/**
 * Where a ticket sits in the tree: the innermost workspace whose folder contains it (paths compared without case,
 * like the tree's keys) and the ancestor folders that have to be expanded to show its row. Undefined when no
 * workspace contains it, or when it is a workspace folder itself.
 */
export function computeTicketRevealPath(ticketUri: URI, workspaces: readonly URI[]): ITicketRevealPath | undefined {
	const ticket = ticketFolderOf(ticketUri);
	const ticketSegments = segmentsOf(ticket);
	const lowerTicket = ticketSegments.map(s => s.toLowerCase());
	let best: { index: number; depth: number } | undefined;
	workspaces.forEach((ws, index) => {
		const folder = workspaceFolderOf(ws);
		if (folder.scheme !== ticket.scheme || folder.authority.toLowerCase() !== ticket.authority.toLowerCase()) {
			return;
		}
		const wsSegments = segmentsOf(folder).map(s => s.toLowerCase());
		if (wsSegments.length >= lowerTicket.length || !wsSegments.every((s, i) => s === lowerTicket[i])) {
			return;
		}
		if (!best || wsSegments.length > best.depth) {
			best = { index, depth: wsSegments.length };
		}
	});
	if (!best) {
		return undefined;
	}
	const ancestors: URI[] = [];
	for (let end = best.depth + 1; end < ticketSegments.length; end++) {
		ancestors.push(ticket.with({ path: '/' + ticketSegments.slice(0, end).join('/') }));
	}
	return { workspaceIndex: best.index, ticket, ancestors };
}

/** The inline hint shown when the revealed ticket's row is hidden by the status filter (UI-15 / UI-16). */
export function describeRevealHiddenByFilter(ticketLabel: string): string {
	return `${ticketLabel} is hidden by the status filter`;
}
