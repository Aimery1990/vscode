/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ITicketSubtreeNode, ITicketSubtreeSummary } from './ticketSubtreeCount.js';
import { CanonicalStatusCategory } from './workspacesExplorer.js';

/**
 * Deep ticket search of the Workspaces tree (UI-21).
 *
 * The service flattens the cached sub-tree summary of every managed workspace (UI-17, one scan of all levels, kept
 * fresh by the file watcher) into {@link ITicketSearchEntry} rows. Searching is then a pure in-memory pass:
 * a ticket matches by ID (exact > prefix > contains) or by title (contains), case-insensitive. The tree shows only
 * the path(s) to the matches, a pruned tree built from each match's parent chain.
 */

export const GO_TO_TICKET_COMMAND_ID = 'workbench.action.workspacesExplorer.goToTicket';
export const TICKET_SEARCH_MIN_QUERY_LENGTH = 2;
export const TICKET_SEARCH_MAX_RESULTS = 200;
export const TICKET_SEARCH_DEBOUNCE_MS = 250;

export interface ITicketSearchAncestor {
	/** Canonical tree key of the ancestor ticket (same key as its tree row). */
	readonly key: string;
	readonly label: string;
}

export interface ITicketSearchEntry {
	/** Canonical tree key of the ticket (same key as its tree row, see {@link canonicalTreeKey}). */
	readonly key: string;
	readonly resource: URI;
	readonly ticketId: string;
	/** Title from ticket.md (or README Title); empty when none. */
	readonly title: string;
	readonly type?: string;
	readonly status?: string;
	readonly category?: CanonicalStatusCategory;
	/** The ticket itself counts as removed. */
	readonly removed: boolean;
	/** The ticket or one of its ancestors is removed (hidden from the tree unless "show removed items" is on). */
	readonly removedInPath: boolean;
	readonly workspaceKey: string;
	readonly workspaceName: string;
	readonly workspaceResource: URI;
	/** Ancestor tickets, top-down, without the workspace and without the ticket itself. */
	readonly ancestors: readonly ITicketSearchAncestor[];
}

export interface ITicketSearchIndex {
	readonly entries: readonly ITicketSearchEntry[];
	/** Some workspace scan stopped at the depth or size cap: deeper / later tickets are not searchable. */
	readonly truncated: boolean;
}

/** The key the Workspaces tree uses for a row: lower-cased fsPath for file URIs, else the lower-cased URI string. */
export function canonicalTreeKey(target: string | URI): string {
	const str = typeof target === 'string' ? target : target.toString();
	try {
		if (str.startsWith('file://')) {
			return URI.parse(str).fsPath.toLowerCase();
		}
		return str.toLowerCase();
	} catch {
		return str.toLowerCase();
	}
}

export interface ITicketSearchWorkspace {
	readonly key: string;
	readonly name: string;
	readonly resource: URI;
}

/** One row per ticket of `summary` (all levels, depth-first). Nodes without a resource are skipped with their sub-tree. */
export function flattenTicketSubtree(summary: ITicketSubtreeSummary, workspace: ITicketSearchWorkspace): ITicketSearchEntry[] {
	const out: ITicketSearchEntry[] = [];
	const walk = (nodes: readonly ITicketSubtreeNode[], ancestors: readonly ITicketSearchAncestor[], removedAbove: boolean) => {
		for (const node of nodes) {
			if (!node.resource) {
				continue;
			}
			const key = canonicalTreeKey(node.resource);
			const ticketId = node.ticketId || node.resource.path.split('/').filter(Boolean).pop() || '';
			const title = node.title && node.title !== ticketId ? node.title : '';
			const removedInPath = removedAbove || node.removed;
			out.push({
				key,
				resource: node.resource,
				ticketId,
				title,
				type: node.type,
				status: node.status,
				category: node.category,
				removed: node.removed,
				removedInPath,
				workspaceKey: workspace.key,
				workspaceName: workspace.name,
				workspaceResource: workspace.resource,
				ancestors
			});
			if (node.children.length > 0) {
				walk(node.children, [...ancestors, { key, label: title ? `${ticketId} ${title}` : ticketId }], removedInPath);
			}
		}
	};
	walk(summary.children, [], false);
	return out;
}

export const enum TicketMatchRank {
	ExactId = 0,
	IdPrefix = 1,
	IdContains = 2,
	Title = 3
}

/** [start, end) offsets into the matched text. */
export type MatchRange = readonly [number, number];

export interface ITicketTextMatch {
	readonly rank: TicketMatchRank;
	readonly idRange?: MatchRange;
	readonly titleRange?: MatchRange;
}

export interface ITicketMatch extends ITicketTextMatch {
	readonly entry: ITicketSearchEntry;
}

export function normalizeTicketQuery(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Case-insensitive range of `query` (already normalized) in `text`; undefined when not contained. */
export function findMatchRange(text: string, query: string): MatchRange | undefined {
	if (!query) {
		return undefined;
	}
	const index = text.toLowerCase().indexOf(query);
	return index < 0 ? undefined : [index, index + query.length];
}

/**
 * How `ticketId` / `title` match `query` (normalized). A query that starts one of the ID's `-` / `_` / `.` separated
 * parts counts as an ID prefix, so "0111" ranks ANYAG-0111 like "anyag-0" does.
 */
export function matchTicketText(ticketId: string, title: string, query: string): ITicketTextMatch | undefined {
	if (!query) {
		return undefined;
	}
	const id = ticketId.toLowerCase();
	const titleRange = findMatchRange(title, query);
	let rank: TicketMatchRank | undefined;
	let idRange: MatchRange | undefined;
	if (id === query) {
		rank = TicketMatchRank.ExactId;
		idRange = [0, id.length];
	} else if (id.startsWith(query)) {
		rank = TicketMatchRank.IdPrefix;
		idRange = [0, query.length];
	} else {
		let offset = 0;
		for (const part of id.split(/([-_.])/)) {
			if (part.length > 1 || !/[-_.]/.test(part)) {
				if (part.startsWith(query)) {
					rank = TicketMatchRank.IdPrefix;
					idRange = [offset, offset + query.length];
					break;
				}
			}
			offset += part.length;
		}
		if (rank === undefined) {
			const contains = findMatchRange(id, query);
			if (contains) {
				rank = TicketMatchRank.IdContains;
				idRange = contains;
			}
		}
	}
	if (rank === undefined) {
		return titleRange ? { rank: TicketMatchRank.Title, titleRange } : undefined;
	}
	return titleRange ? { rank, idRange, titleRange } : { rank, idRange };
}

export interface ITicketSearchOptions {
	/** "show removed items": removed tickets (and tickets below them) are found only when on. */
	readonly includeRemoved: boolean;
	/** Default {@link TICKET_SEARCH_MAX_RESULTS}. */
	readonly limit?: number;
	/** Default {@link TICKET_SEARCH_MIN_QUERY_LENGTH}; shorter queries return no matches. */
	readonly minLength?: number;
}

export interface ITicketSearchResult {
	readonly query: string;
	/** Ranked: exact ID > ID prefix > ID contains > title contains, then by ticket ID (natural order). */
	readonly matches: readonly ITicketMatch[];
	/** Matches before the cap. */
	readonly total: number;
	readonly capped: boolean;
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function searchTickets(entries: readonly ITicketSearchEntry[], rawQuery: string, options: ITicketSearchOptions): ITicketSearchResult {
	const query = normalizeTicketQuery(rawQuery);
	const limit = options.limit ?? TICKET_SEARCH_MAX_RESULTS;
	if (query.length < (options.minLength ?? TICKET_SEARCH_MIN_QUERY_LENGTH)) {
		return { query, matches: [], total: 0, capped: false };
	}
	const all: ITicketMatch[] = [];
	for (const entry of entries) {
		if (entry.removedInPath && !options.includeRemoved) {
			continue;
		}
		const match = matchTicketText(entry.ticketId, entry.title, query);
		if (match) {
			all.push({ entry, ...match });
		}
	}
	all.sort((a, b) => a.rank - b.rank || naturalCollator.compare(a.entry.ticketId, b.entry.ticketId) || (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0));
	return { query, matches: all.length > limit ? all.slice(0, limit) : all, total: all.length, capped: all.length > limit };
}

/** The ticket whose ID equals the query (case-insensitive), preferring one that is not removed. */
export function findExactIdMatch(entries: readonly ITicketSearchEntry[], rawQuery: string, includeRemoved: boolean): ITicketSearchEntry | undefined {
	const query = normalizeTicketQuery(rawQuery);
	if (!query) {
		return undefined;
	}
	let fallback: ITicketSearchEntry | undefined;
	for (const entry of entries) {
		if (entry.ticketId.toLowerCase() !== query || (entry.removedInPath && !includeRemoved)) {
			continue;
		}
		if (!entry.removed) {
			return entry;
		}
		fallback ??= entry;
	}
	return fallback;
}

export interface IPrunedTicketNode {
	readonly key: string;
	readonly label: string;
	readonly children: IPrunedTicketNode[];
	/** Set on matched tickets (a match can also be the ancestor of another match). */
	match?: ITicketMatch;
}

export interface IPrunedTicketTree {
	/** One root per workspace with matches, in order of their best match. */
	readonly roots: readonly IPrunedTicketNode[];
	/** Workspace and ticket keys to expand: every node with a match below it. */
	readonly expanded: ReadonlySet<string>;
	/** Ticket keys to show: the matches and their ancestors (siblings along the path stay hidden). */
	readonly visible: ReadonlySet<string>;
	readonly workspaceKeys: ReadonlySet<string>;
	readonly matchByKey: ReadonlyMap<string, ITicketMatch>;
}

/** The pruned tree holding only the paths workspace → ... → matched ticket; common ancestors are shared. */
export function buildPrunedTicketTree(matches: readonly ITicketMatch[]): IPrunedTicketTree {
	const roots: IPrunedTicketNode[] = [];
	const nodes = new Map<string, IPrunedTicketNode>();
	const expanded = new Set<string>();
	const visible = new Set<string>();
	const workspaceKeys = new Set<string>();
	const matchByKey = new Map<string, ITicketMatch>();
	const ensure = (key: string, label: string, parent: IPrunedTicketNode[] | undefined): IPrunedTicketNode => {
		let node = nodes.get(key);
		if (!node) {
			node = { key, label, children: [] };
			nodes.set(key, node);
			(parent ?? roots).push(node);
		}
		return node;
	};
	for (const match of matches) {
		const { entry } = match;
		const wsNode = ensure(`ws:${entry.workspaceKey}`, entry.workspaceName, undefined);
		workspaceKeys.add(entry.workspaceKey);
		expanded.add(entry.workspaceKey);
		let parent = wsNode;
		for (const ancestor of entry.ancestors) {
			parent = ensure(ancestor.key, ancestor.label, parent.children);
			expanded.add(ancestor.key);
			visible.add(ancestor.key);
		}
		const node = ensure(entry.key, entry.title ? `${entry.ticketId} ${entry.title}` : entry.ticketId, parent.children);
		node.match = match;
		visible.add(entry.key);
		matchByKey.set(entry.key, match);
	}
	return { roots, expanded, visible, workspaceKeys, matchByKey };
}

/** "Workspace > ANYAG-0038 UX Issues > ANYAG-0110 ..." (the ticket's location, without the ticket itself). */
export function describeTicketLocation(entry: ITicketSearchEntry): string {
	return [entry.workspaceName, ...entry.ancestors.map(a => a.label)].join(' \u203a ');
}

export interface IHighlightSegment {
	readonly text: string;
	readonly highlight: boolean;
}

/** Splits `text` around `range` for rendering a highlighted substring. */
export function splitHighlight(text: string, range: MatchRange | undefined): IHighlightSegment[] {
	if (!range || range[0] >= range[1] || range[0] < 0 || range[1] > text.length) {
		return [{ text, highlight: false }];
	}
	const segments: IHighlightSegment[] = [];
	if (range[0] > 0) {
		segments.push({ text: text.slice(0, range[0]), highlight: false });
	}
	segments.push({ text: text.slice(range[0], range[1]), highlight: true });
	if (range[1] < text.length) {
		segments.push({ text: text.slice(range[1]), highlight: false });
	}
	return segments;
}

/** "No tickets match ...", "3 matches", or "Showing first 200 of 431 matches". */
export function describeSearchResult(result: ITicketSearchResult, rawQuery: string, indexTruncated: boolean): string {
	const capNote = indexTruncated ? ' (very large workspaces are only partly indexed)' : '';
	if (result.total === 0) {
		return `No tickets match \u201c${rawQuery.trim()}\u201d${capNote}`;
	}
	if (result.capped) {
		return `Showing first ${result.matches.length} of ${result.total} matches${capNote}`;
	}
	return `${result.total} ${result.total === 1 ? 'match' : 'matches'}${capNote}`;
}
