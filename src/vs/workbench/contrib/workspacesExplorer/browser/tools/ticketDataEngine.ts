/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ICustomField, normalizeNumberFieldValue } from '../../../entityPersistence/common/entityPersistence.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceChildItem, IWorkspacesExplorerService } from '../../common/workspacesExplorer.js';
import { IAgentsManagerService } from '../../../agentsManager/common/agentsManager.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISqliteTableOperationResult, ITicketWorkflowRuntimeService } from '../../../workflowsManager/browser/ticketWorkflowRuntime.js';
import { findTemplateField, getTemplateFields, parseTemplateYaml } from '../../../customModules/common/templateYaml.js';
import { getProgrammaticTicketTypeError, isFreestyleTicketType, isSubWorkflowTicketType, readFreestyleSchema } from '../../../customModules/common/freestyleTicket.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import { hasKey } from '../../../../../base/common/types.js';
import { TicketWorklogStorage } from '../ticketWorklogStorage.js';

/** Loosely-typed JSON object (tool parameters, parsed ticket values). */
type IJsonObject = { [key: string]: unknown };

/** Parsed `ticket.md` sections. */
interface IParsedTicketMd {
	profileData: Record<string, string>;
	selfDefinedData: Record<string, string>;
	attachments: string[];
	status?: string;
	priority?: string;
	currentAiAgent?: string;
	parentPath?: string;
	linkTo?: string;
	linkedBy?: string;
}

/** `item.name || item.key || item.title` of a tool-provided JSON object. */
function itemIdentity(item: object): unknown {
	const obj = item as IJsonObject;
	return obj.name || obj.key || obj.title;
}

/** Whether a tool-provided object looks like a file/attachment reference (has `name`, `file` or `uri`, own or inherited). */
function isAttachmentLike(obj: object): obj is { name?: unknown; file?: unknown; uri?: unknown } {
	return 'name' in obj || 'file' in obj || 'uri' in obj;
}

export interface IWorklogRecord {
	user_request: string;
	update_summary: string;
	update_details: string;
	update_conclusion: string;
	commit?: {
		repo?: string;
		branch?: string;
		commit_id?: string;
		comment?: string;
		committed_by?: string;
	} | null;
}

export interface ICreateTicketToolOptions {
	workspace_id: string;
	parent_path: string;
	ticket_type: string;
	title: string;
	description?: string;
	status?: string;
	priority?: string;
	ticket_prompt?: string;
	assigned_agent?: string;
	link_to?: string;
	attachments?: string[];
	custom_values?: Record<string, unknown>;
	/** ticket_type "sub_workflow" only: optional definition (object or JSON text: name, nodes, links, inputs, outputs). */
	sub_workflow_definition?: unknown;
	worklog_record: IWorklogRecord;
}

export interface IDeleteTicketToolOptions {
	workspace_id: string;
	ticket_id: string;
	parent_path?: string;
	move_to_trash?: boolean;
	worklog_record: IWorklogRecord;
}

export interface IUpdateTicketToolOptions {
	workspace_id: string;
	ticket_id: string;
	parent_path?: string;
	updates: Record<string, unknown>;
	worklog_record: IWorklogRecord;
}

export interface IManageLinksToolOptions {
	workspace_id: string;
	source_ticket_ids: string[];
	action: 'add_links' | 'remove_links' | 'set_links';
	target_ticket_ids: string[];
	worklog_record: IWorklogRecord;
}

export interface IQueryWorkspaceTreeToolOptions {
	workspace_id: string;
	parent_ticket_id?: string;
	query?: string;
	max_depth?: number;
}

export interface IOperateTicketTableToolOptions {
	workspace_id: string;
	ticket_id: string;
	parent_path?: string;
	table_field: string;
	operation:
	| 'get_table'
	| 'define_columns'
	| 'insert_rows'
	| 'update_rows'
	| 'set_rows'
	| 'delete_rows'
	| 'clear_rows'
	| 'bind_sqlite'
	| 'save_to_sqlite'
	| 'update_in_sqlite'
	| 'load_from_sqlite'
	| 'delete_from_sqlite'
	| 'sql_query';
	columns?: Array<{
		name: string;
		dataType?: string;
		primaryKey?: boolean;
		nullable?: boolean;
		defaultValue?: string;
	}>;
	rows?: Array<Record<string, unknown>>;
	match_column?: string;
	match_value?: unknown;
	row_indices?: number[];
	db_path?: string;
	db_table_name?: string;
	auto_sync_db?: boolean;
	sync_sqlite?: boolean;
	sql_query?: string;
	worklog_record?: IWorklogRecord;
}

export interface ITicketResolvedPaths {
	folderUri: URI;
	ticketMdUri: URI;
	readmeMdUri: URI;
	instructionMdUri: URI;
	worklogMdUri: URI;
	ticketId: string;
	workspaceId: string;
	ticketType: string;
}

export class TicketDataEngine {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	private _resolveGlobalWorkspaceUri(workspaceId?: string, ticketId?: string): URI | undefined {
		const trimmedId = (workspaceId || '').trim();
		const lowerId = trimmedId.toLowerCase();
		const normId = lowerId.replace(/[\s_\-]+/g, '');
		const cleanCodeFromWsId = lowerId.replace(/-0000$/i, '').replace(/[\s_\-]+/g, '');

		// 1. Direct filesystem path or file:// URI
		if (trimmedId.startsWith('file://')) {
			try {
				return URI.parse(trimmedId);
			} catch { }
		}
		if (trimmedId.startsWith('/') && trimmedId.length > 1) {
			return URI.file(trimmedId);
		}
		if (trimmedId.startsWith('~/')) {
			return URI.file('/Users/aimery/' + trimmedId.slice(2));
		}

		// 2. Global Workflows Directory (/Users/aimery/Documents/workflows -> GFLOW / GFLOW-0000)
		if (
			cleanCodeFromWsId === 'gflow' ||
			normId === 'gflow' ||
			normId === 'gflow0000' ||
			normId === 'globalworkflow' ||
			normId === 'globalworkflows' ||
			normId === 'independent' ||
			normId === 'independentflow' ||
			normId === 'independentworkflow' ||
			normId === 'workflows'
		) {
			return URI.file('/Users/aimery/Documents/workflows');
		}

		// 3. Global Agents Directory (/Users/aimery/Documents/agents -> GAGENT / GAGENT-0000)
		if (
			cleanCodeFromWsId === 'gagent' ||
			normId === 'gagent' ||
			normId === 'gagent0000' ||
			normId === 'globalagent' ||
			normId === 'globalagents' ||
			normId === 'agents'
		) {
			return URI.file('/Users/aimery/Documents/agents');
		}

		// 4. Global Jobs Directory (/Users/aimery/repos/jobs -> GLOBAL / GLOBAL-0000)
		if (
			cleanCodeFromWsId === 'global' ||
			normId === 'global' ||
			normId === 'global0000' ||
			normId === 'globaljobs'
		) {
			return URI.file('/Users/aimery/repos/jobs');
		}

		// 5. Infer from ticketId prefix (GFLOW-xxxx, GAGENT-xxxx, GLOBAL-xxxx)
		if (ticketId) {
			const cleanTicket = ticketId.trim().replace(/^[/\\]+/, '');
			if (/^gflow[-_]\d+/i.test(cleanTicket)) {
				return URI.file('/Users/aimery/Documents/workflows');
			}
			if (/^gagent[-_]\d+/i.test(cleanTicket)) {
				return URI.file('/Users/aimery/Documents/agents');
			}
			if (/^global[-_]\d+/i.test(cleanTicket)) {
				return URI.file('/Users/aimery/repos/jobs');
			}
		}

		return undefined;
	}

	/**
	 * Find the workspace root URI from workspace_id or active workspaces with smart matching
	 */
	public async findWorkspaceUri(workspaceId?: string, ticketId?: string): Promise<URI | undefined> {
		// 0. Check Global Workspaces (GFLOW-0000, GAGENT-0000, GLOBAL-0000) or direct path first
		const globalUri = this._resolveGlobalWorkspaceUri(workspaceId, ticketId);
		if (globalUri) {
			if (await this.fileService.exists(globalUri)) {
				return globalUri;
			}
		}

		const workspaces = (await this.workspacesExplorerService.getWorkspaces()) || [];

		// Ensure workspaces have their code populated if missing
		for (const w of workspaces) {
			if (!w.code) {
				try {
					w.code = await this.workspacesExplorerService.resolveEntityCode(w.uri);
				} catch { }
			}
		}

		const trimmedId = (workspaceId || '').trim();

		// 1. If workspaceId is empty, default, or active-keyword, resolve to ticketId prefix or active/current workspace
		if (!trimmedId || trimmedId === 'current' || trimmedId === 'active' || trimmedId === 'default' || trimmedId === '/' || trimmedId === '.') {
			if (ticketId) {
				const ticketPrefixMatch = ticketId.trim().match(/^([A-Za-z0-9_-]+?)-\d+/);
				if (ticketPrefixMatch) {
					const prefix = ticketPrefixMatch[1].toLowerCase();
					const matchByPrefix = workspaces.find(w => (w.code || '').toLowerCase() === prefix);
					if (matchByPrefix) { return matchByPrefix.uri; }
				}
			}
			const current = workspaces.find(w => w.isCurrent) || workspaces[0];
			return current?.uri;
		}

		const lowerId = trimmedId.toLowerCase();
		const normId = lowerId.replace(/[\s_\-]+/g, '');
		const cleanCodeFromWsId = lowerId.replace(/-0000$/i, '').replace(/[\s_\-]+/g, '');

		// 2. Exact match (case-insensitive)
		let target = workspaces.find(w => {
			const wCode = (w.code || '').toLowerCase();
			const wId = (w.id || '').toLowerCase();
			const wName = (w.name || '').toLowerCase();
			return wCode === lowerId ||
				wId === lowerId ||
				wName === lowerId ||
				`${wCode}-0000` === lowerId ||
				wCode === cleanCodeFromWsId ||
				w.uri.fsPath.toLowerCase() === lowerId;
		});

		if (target) { return target.uri; }

		// 3. Normalized match (ignoring whitespace, underscores, hyphens)
		target = workspaces.find(w => {
			const normCode = (w.code || '').toLowerCase().replace(/[\s_\-]+/g, '');
			const normName = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
			const normIdStr = (w.id || '').toLowerCase().replace(/[\s_\-]+/g, '');
			return normCode === normId ||
				normName === normId ||
				normIdStr === normId ||
				`${normCode}0000` === normId ||
				normCode === cleanCodeFromWsId;
		});

		if (target) { return target.uri; }

		// 4. Substring / Prefix match
		target = workspaces.find(w => {
			const normCode = (w.code || '').toLowerCase().replace(/[\s_\-]+/g, '');
			const normName = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
			return (normId.length >= 3 && normName.includes(normId)) ||
				(normName.length >= 3 && normId.includes(normName)) ||
				(normCode.length >= 2 && normId.startsWith(normCode)) ||
				(normCode.length >= 2 && cleanCodeFromWsId.startsWith(normCode));
		});

		if (target) { return target.uri; }

		// 5. If ticketId is provided, try matching by ticket prefix (e.g. NEOWO-0006 -> NEOWO)
		if (ticketId) {
			const ticketPrefixMatch = ticketId.trim().match(/^([A-Za-z0-9_-]+?)-\d+/);
			if (ticketPrefixMatch) {
				const prefix = ticketPrefixMatch[1].toLowerCase().replace(/[\s_\-]+/g, '');
				target = workspaces.find(w => {
					const c = (w.code || '').toLowerCase().replace(/[\s_\-]+/g, '');
					const n = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
					return c === prefix || n.startsWith(prefix) || (prefix.length >= 3 && n.startsWith(prefix.slice(0, 3))) || (n.length >= 3 && prefix.startsWith(n.slice(0, 3)));
				});
				if (target) { return target.uri; }
			}
		}

		if (cleanCodeFromWsId && cleanCodeFromWsId.length >= 3) {
			target = workspaces.find(w => {
				const n = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
				return n.startsWith(cleanCodeFromWsId) || (cleanCodeFromWsId.length >= 3 && n.startsWith(cleanCodeFromWsId.slice(0, 3))) || (n.length >= 3 && cleanCodeFromWsId.startsWith(n.slice(0, 3)));
			});
			if (target) { return target.uri; }
		}

		// 5. STT Acoustic / Phonetic matching (handles speech-to-text confusions like "new" <-> "neo")
		const phoneticVariants = [
			normId.replace(/^new/, 'neo'),
			normId.replace(/newworkspace$/, 'neoworkspace'),
			normId.replace(/new/, 'neo')
		];

		for (const variant of phoneticVariants) {
			target = workspaces.find(w => {
				const normName = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
				const normCode = (w.code || '').toLowerCase().replace(/[\s_\-]+/g, '');
				return normName === variant || normCode === variant;
			});
			if (target) { return target.uri; }
		}

		// 6. Fuzzy Levenshtein Distance match (for acoustic / typo tolerance)
		const levenshtein = (a: string, b: string): number => {
			const matrix: number[][] = [];
			for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
			for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
			for (let i = 1; i <= b.length; i++) {
				for (let j = 1; j <= a.length; j++) {
					if (b.charAt(i - 1) === a.charAt(j - 1)) {
						matrix[i][j] = matrix[i - 1][j - 1];
					} else {
						matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
					}
				}
			}
			return matrix[b.length][a.length];
		};

		let bestMatch: typeof workspaces[0] | undefined = undefined;
		let minDistance = 999;
		for (const w of workspaces) {
			const normName = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
			const dist = levenshtein(normId, normName);
			if (dist <= 2 && dist < minDistance && normName.length >= 3) {
				minDistance = dist;
				bestMatch = w;
			}
		}

		if (bestMatch && minDistance <= 2) {
			return bestMatch.uri;
		}

		// 6.5 If ticketId is provided, scan all workspaces and global directories to see which one physically contains this ticket
		if (ticketId) {
			for (const w of workspaces) {
				try {
					const found = await this.resolveTicketPaths(w.uri, ticketId);
					if (found) {
						return w.uri;
					}
				} catch { }
			}
			const globalCandidateDirs = [
				URI.file('/Users/aimery/Documents/workflows'),
				URI.file('/Users/aimery/Documents/agents'),
				URI.file('/Users/aimery/repos/jobs')
			];
			for (const gDir of globalCandidateDirs) {
				try {
					if (await this.fileService.exists(gDir)) {
						const found = await this.resolveTicketPaths(gDir, ticketId);
						if (found) {
							return gDir;
						}
					}
				} catch { }
			}
		}

		// 7. SAFETY: DO NOT silently fall back to workspaces[0]!
		// Throw an informative error listing all available workspaces so AI and user know exactly what exists
		const availableList = [
			...workspaces.map(w => `"${w.name}" (Code: ${w.code || 'N/A'})${w.isCurrent ? ' [Active]' : ''}`),
			'"Global Workflows" (Code: GFLOW-0000)',
			'"Global Agents" (Code: GAGENT-0000)'
		].join(', ');
		throw new Error(`Workspace '${workspaceId}' was not found. Currently available workspaces in AnyAgent are: [${availableList}]. Please specify one of these valid workspace names, or ask the user to clarify if unsure.`);
	}

	/**
	 * Find ticket folder by ticket_id or path under workspace
	 */
	public async resolveTicketPaths(workspaceUri: URI, ticketIdOrPath: string, parentPath?: string): Promise<ITicketResolvedPaths | undefined> {
		if (!ticketIdOrPath) {
			return undefined;
		}

		// 1. If explicit parent_path is provided, resolve directly under that parent
		if (parentPath && parentPath !== '/' && parentPath !== 'root') {
			const parentRel = parentPath.startsWith('/') ? parentPath.slice(1) : parentPath;
			const cleanTicketId = ticketIdOrPath.startsWith('/') ? ticketIdOrPath.slice(1) : ticketIdOrPath;
			const targetUnderParentUri = URI.joinPath(workspaceUri, parentRel, cleanTicketId);
			if (await this.fileService.exists(targetUnderParentUri)) {
				const paths = await this._checkFolderForTicketPaths(targetUnderParentUri);
				if (paths) { return paths; }
			}
		}

		// 2. If ticketIdOrPath contains slashes (e.g. '/FNDJ1-0006/FNDJ1-0001' or 'FNDJ1-0006/FNDJ1-0001')
		if (ticketIdOrPath.includes('/')) {
			const cleanPath = ticketIdOrPath.startsWith('/') ? ticketIdOrPath.slice(1) : ticketIdOrPath;
			const directPathUri = URI.joinPath(workspaceUri, cleanPath);
			if (await this.fileService.exists(directPathUri)) {
				const paths = await this._checkFolderForTicketPaths(directPathUri);
				if (paths) { return paths; }
			}
		}

		// 3. Check if target is workspace root itself
		const wsTicketPaths = await this._checkFolderForTicketPaths(workspaceUri);
		if (wsTicketPaths && (wsTicketPaths.ticketId === ticketIdOrPath || ticketIdOrPath === 'root' || ticketIdOrPath === '/' || wsTicketPaths.workspaceId === ticketIdOrPath)) {
			return wsTicketPaths;
		}

		// 4. If parent_path is explicitly '/' or root, check direct folder at workspace root
		if (parentPath === '/' || parentPath === 'root') {
			const directUri = URI.joinPath(workspaceUri, ticketIdOrPath);
			if (await this.fileService.exists(directUri)) {
				const paths = await this._checkFolderForTicketPaths(directUri);
				if (paths) { return paths; }
			}
		}

		// 5. Direct folder check at root
		const directUri = URI.joinPath(workspaceUri, ticketIdOrPath);
		if (await this.fileService.exists(directUri)) {
			const paths = await this._checkFolderForTicketPaths(directUri);
			if (paths) { return paths; }
		}

		// 6. Recursive deep search across nested folders
		const deepUri = await this._findTicketFolderDeep(workspaceUri, ticketIdOrPath);
		if (deepUri) {
			const paths = await this._checkFolderForTicketPaths(deepUri);
			if (paths) { return paths; }
		}

		// 7. Fallback to explorer children scan
		const children = await this.workspacesExplorerService.scanWorkspaceChildren(workspaceUri, true);
		const found = this._findChildRecursively(children, ticketIdOrPath);
		if (found) {
			const paths = await this._checkFolderForTicketPaths(found.uri);
			if (paths) { return paths; }
		}

		// 8. Direct agents manager check if target matches a registered agent
		if (this.agentsManagerService) {
			try {
				const agents = await this.agentsManagerService.getAgents();
				const matchedAgent = agents.find(a => {
					const fName = a.folderPath ? a.folderPath.split(/[/\\]/).filter(Boolean).pop() : '';
					return (fName && fName === ticketIdOrPath) ||
						(a.id && a.id === ticketIdOrPath) ||
						(a.name && (a.name === ticketIdOrPath || a.name.toLowerCase() === ticketIdOrPath.toLowerCase()));
				});
				if (matchedAgent && matchedAgent.folderPath) {
					const agentFolderUri = URI.file(matchedAgent.folderPath);
					const paths = await this._checkFolderForTicketPaths(agentFolderUri);
					if (paths) { return paths; }
				}
			} catch { }
		}

		// 9. Intelligent Sequence / Type / Fuzzy matching (e.g. "job 0001", "job 1", "0001", "job-0001", "#1", title match)
		const fuzzyMatched = await this._resolveTicketFuzzyOrSequence(workspaceUri, ticketIdOrPath);
		if (fuzzyMatched) {
			return fuzzyMatched;
		}

		return undefined;
	}

	private async _collectAllWorkspaceTickets(workspaceUri: URI): Promise<Array<{
		paths: ITicketResolvedPaths;
		ticketId: string;
		ticketType: string;
		title: string;
		seqNumber?: number;
		code?: string;
	}>> {
		const results: Array<{
			paths: ITicketResolvedPaths;
			ticketId: string;
			ticketType: string;
			title: string;
			seqNumber?: number;
			code?: string;
		}> = [];
		const visitedFolders = new Set<string>();

		const scanDir = async (dirUri: URI, depth: number) => {
			if (depth > 6) { return; }
			const fsPath = dirUri.fsPath;
			if (visitedFolders.has(fsPath)) { return; }
			visitedFolders.add(fsPath);

			try {
				const stat = await this.fileService.resolve(dirUri);
				if (!stat.children) { return; }

				for (const child of stat.children) {
					if (!child.isDirectory || child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules') {
						continue;
					}
					const paths = await this._checkFolderForTicketPaths(child.resource);
					if (paths) {
						let title = child.name;
						try {
							const readme = await this._safeRead(paths.readmeMdUri);
							const parsed = this._parseReadmeMd(readme);
							if (parsed.title) { title = parsed.title; }
						} catch { }

						let seqNumber: number | undefined;
						let code: string | undefined;
						const match = paths.ticketId.match(/^([A-Za-z0-9]+)[_\-]0*(\d+)$/);
						if (match) {
							code = match[1];
							seqNumber = parseInt(match[2], 10);
						}

						results.push({
							paths,
							ticketId: paths.ticketId,
							ticketType: paths.ticketType || '',
							title,
							seqNumber,
							code
						});
					}
					await scanDir(child.resource, depth + 1);
				}
			} catch { }
		};

		await scanDir(workspaceUri, 0);
		return results;
	}

	private async _resolveTicketFuzzyOrSequence(workspaceUri: URI, ticketIdOrPath: string): Promise<ITicketResolvedPaths | undefined> {
		const cleanInput = ticketIdOrPath.trim().replace(/^[/\\]+/, '');
		if (!cleanInput) { return undefined; }

		const allTickets = await this._collectAllWorkspaceTickets(workspaceUri);
		if (allTickets.length === 0) { return undefined; }

		const normInput = cleanInput.toLowerCase().replace(/[\s_\-]+/g, '');

		// Case 1: Type + Sequence Number (e.g. "job 0001", "job-0001", "job 1", "task 0002", "job0001")
		const typeSeqMatch = cleanInput.match(/^(job|task|note|workflow|project|case|agent|issue|analysis)[\s_\-]*0*(\d+)$/i);
		if (typeSeqMatch) {
			const targetType = typeSeqMatch[1].toLowerCase();
			const targetSeq = parseInt(typeSeqMatch[2], 10);
			const matched = allTickets.find(t =>
				t.ticketType.toLowerCase() === targetType && t.seqNumber === targetSeq
			);
			if (matched) { return matched.paths; }

			// Fallback: If type doesn't strictly match but seqNumber matches and there's only one
			const seqMatches = allTickets.filter(t => t.seqNumber === targetSeq);
			if (seqMatches.length === 1) { return seqMatches[0].paths; }
		}

		// Case 2: Pure sequence number (e.g. "0001", "1", "-0001", "#1")
		const pureSeqMatch = cleanInput.match(/^#?[_\-]?0*(\d+)$/);
		if (pureSeqMatch) {
			const targetSeq = parseInt(pureSeqMatch[1], 10);
			const seqMatches = allTickets.filter(t => t.seqNumber === targetSeq);
			if (seqMatches.length === 1) { return seqMatches[0].paths; }
			if (seqMatches.length > 1) {
				// Prefer top-level or job type
				const jobMatch = seqMatches.find(t => t.ticketType.toLowerCase() === 'job');
				if (jobMatch) { return jobMatch.paths; }
				return seqMatches[0].paths;
			}
		}

		// Case 3: Normalized ticket ID (e.g. "neowo0001", "neowo-1")
		const idMatch = allTickets.find(t => {
			const normTid = t.ticketId.toLowerCase().replace(/[\s_\-]+/g, '');
			return normTid === normInput;
		});
		if (idMatch) { return idMatch.paths; }

		// Case 4: Title match (exact or substring)
		const titleMatch = allTickets.find(t =>
			t.title.toLowerCase() === cleanInput.toLowerCase() ||
			(cleanInput.length >= 4 && t.title.toLowerCase().includes(cleanInput.toLowerCase()))
		);
		if (titleMatch) { return titleMatch.paths; }

		return undefined;
	}

	private async _findTicketFolderDeep(baseUri: URI, ticketId: string, currentDepth: number = 0, maxDepth: number = 6): Promise<URI | undefined> {
		if (currentDepth >= maxDepth) { return undefined; }
		try {
			const stat = await this.fileService.resolve(baseUri);
			if (!stat.children) { return undefined; }

			// Check direct subdirectories at this level first
			for (const child of stat.children) {
				if (!child.isDirectory || child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules') {
					continue;
				}
				if (child.name === ticketId) {
					return child.resource;
				}
				const paths = await this._checkFolderForTicketPaths(child.resource);
				if (paths && paths.ticketId === ticketId) {
					return child.resource;
				}
			}

			// Then recursively check deeper
			for (const child of stat.children) {
				if (!child.isDirectory || child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules') {
					continue;
				}
				const found = await this._findTicketFolderDeep(child.resource, ticketId, currentDepth + 1, maxDepth);
				if (found) { return found; }
			}
		} catch { }
		return undefined;
	}

	private _findChildRecursively(children: IWorkspaceChildItem[], ticketId: string): IWorkspaceChildItem | undefined {
		for (const child of children) {
			if (child.id === ticketId || child.name === ticketId || child.code === ticketId) {
				return child;
			}
			if (child.children && child.children.length > 0) {
				const nested = this._findChildRecursively(child.children, ticketId);
				if (nested) { return nested; }
			}
		}
		return undefined;
	}

	private async _discoverChildren(folderUri: URI, workspaceUri: URI): Promise<Array<{
		ticket_id: string;
		title: string;
		ticket_type: string;
		status: string;
		priority: string;
		created_at?: string;
		parent_path: string;
		relative_path: string;
		full_path: string;
	}>> {
		const results: Array<{
			ticket_id: string;
			title: string;
			ticket_type: string;
			status: string;
			priority: string;
			created_at?: string;
			parent_path: string;
			relative_path: string;
			full_path: string;
		}> = [];

		try {
			const stat = await this.fileService.resolve(folderUri);
			if (!stat.children) { return results; }

			const wsFsPath = workspaceUri.fsPath;
			const folderFsPath = folderUri.fsPath;
			const parentRelPath = folderFsPath.startsWith(wsFsPath)
				? folderFsPath.slice(wsFsPath.length).replace(/^[/\\]+/, '')
				: '';
			const parentPathStr = parentRelPath ? `/${parentRelPath}` : '/';

			for (const child of stat.children) {
				if (!child.isDirectory || child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules') {
					continue;
				}
				const childPaths = await this._checkFolderForTicketPaths(child.resource);
				if (childPaths) {
					const childTicketContent = await this._safeRead(childPaths.ticketMdUri);
					const childReadmeContent = await this._safeRead(childPaths.readmeMdUri);
					const childParsedTicket = this._parseTicketMd(childTicketContent);
					const childParsedReadme = this._parseReadmeMd(childReadmeContent);

					const fullPath = parentRelPath ? `/${parentRelPath}/${child.name}` : `/${child.name}`;

					results.push({
						ticket_id: childPaths.ticketId,
						title: childParsedReadme.title || childPaths.ticketId,
						ticket_type: childPaths.ticketType,
						status: childParsedTicket.status || 'Todo',
						priority: childParsedTicket.priority || 'Medium',
						created_at: childParsedTicket.profileData?.['Created At'] || '',
						parent_path: parentPathStr,
						relative_path: child.name,
						full_path: fullPath
					});
				}
			}
		} catch { }

		return results;
	}

	private async _checkFolderForTicketPaths(folderUri: URI): Promise<ITicketResolvedPaths | undefined> {
		const agentsDir = URI.joinPath(folderUri, '.agents');
		const altCandidates = ['ticket.md', 'agent.md', 'job.md', 'task.md', 'note.md', 'workspace.md'];
		let ticketMdUri: URI | undefined;

		for (const alt of altCandidates) {
			const inAgents = URI.joinPath(agentsDir, alt);
			if (await this.fileService.exists(inAgents)) {
				ticketMdUri = inAgents;
				break;
			}
		}
		if (!ticketMdUri) {
			for (const alt of altCandidates) {
				const inRoot = URI.joinPath(folderUri, alt);
				if (await this.fileService.exists(inRoot)) {
					ticketMdUri = inRoot;
					break;
				}
			}
		}
		if (!ticketMdUri) {
			return undefined;
		}

		const isAgents = ticketMdUri.path.includes('/.agents/');
		const baseConfigDir = isAgents ? agentsDir : folderUri;

		const readmeMdUri = URI.joinPath(baseConfigDir, 'README.md');
		const instructionMdUri = URI.joinPath(baseConfigDir, 'instruction.md');
		let worklogMdUri = URI.joinPath(baseConfigDir, 'worklog.md');
		if (!await this.fileService.exists(worklogMdUri)) {
			const altWorklog = URI.joinPath(baseConfigDir, 'work_log.md');
			if (await this.fileService.exists(altWorklog)) {
				worklogMdUri = altWorklog;
			}
		}

		// Parse overview to get ticket ID and workspace ID
		const content = (await this.fileService.readFile(ticketMdUri)).value.toString();
		let wsMatch = content.match(/^-\s*\*\*Workspace ID\*\*:\s*(.+)$/m);
		let idMatch = content.match(/^-\s*\*\*Ticket ID\*\*:\s*(.+)$/m);
		const typeMatch = content.match(/^-\s*\*\*(?:Ticket Type|Entity Type)\*\*:\s*(.+)$/m);

		// Fallback to instruction.md or README.md if not in ticket.md
		if ((!wsMatch || !idMatch) && await this.fileService.exists(instructionMdUri)) {
			const instContent = (await this.fileService.readFile(instructionMdUri)).value.toString();
			if (!wsMatch) { wsMatch = instContent.match(/^-\s*\*\*Workspace ID\*\*:\s*(.+)$/m); }
			if (!idMatch) { idMatch = instContent.match(/^-\s*\*\*Ticket ID\*\*:\s*(.+)$/m); }
		}

		const folderName = folderUri.path.split('/').filter(Boolean).pop() || '';

		return {
			folderUri,
			ticketMdUri,
			readmeMdUri,
			instructionMdUri,
			worklogMdUri,
			ticketId: idMatch ? idMatch[1].trim() : folderName,
			workspaceId: wsMatch ? wsMatch[1].trim() : 'None',
			ticketType: typeMatch ? typeMatch[1].trim() : 'task'
		};
	}

	/**
	 * Builds an ultra-compact, token-dense ASCII skeleton tree of the workspace tickets.
	 * Compresses hierarchical information by 95% compared to raw JSON.
	 */
	public async buildCompactWorkspaceTree(workspaceUri: URI, activeTicketId?: string, maxDepth: number = 2): Promise<string> {
		const typeEmoji = (type: string): string => {
			const t = (type || '').toLowerCase();
			if (t === 'job') { return '\uD83D\uDE80'; }
			if (t === 'task') { return '\uD83D\uDCCB'; }
			if (t === 'workflow') { return '\u26A1'; }
			if (t === 'case') { return '\uD83D\uDCE6'; }
			if (t === 'note') { return '\uD83D\uDCDD'; }
			if (t === 'agent') { return '\uD83E\uDD16'; }
			if (t === 'issue') { return '\uD83D\uDC1E'; }
			if (t === 'analysis') { return '\uD83D\uDCCA'; }
			return '\uD83D\uDCC4';
		};

		const getDirectSubTickets = async (folderUri: URI): Promise<Array<{ paths: ITicketResolvedPaths; title: string; status: string }>> => {
			const items: Array<{ paths: ITicketResolvedPaths; title: string; status: string }> = [];
			try {
				const stat = await this.fileService.resolve(folderUri);
				if (!stat.children) { return items; }
				for (const child of stat.children) {
					if (!child.isDirectory || child.name.startsWith('.') || child.name.startsWith('~') || child.name === 'node_modules') {
						continue;
					}
					const paths = await this._checkFolderForTicketPaths(child.resource);
					if (paths) {
						let title = child.name;
						let status = 'Todo';
						try {
							const readme = await this._safeRead(paths.readmeMdUri);
							const parsedR = this._parseReadmeMd(readme);
							if (parsedR.title) { title = parsedR.title; }
						} catch { }
						try {
							const ticket = await this._safeRead(paths.ticketMdUri);
							const parsedT = this._parseTicketMd(ticket);
							if (parsedT.status) { status = parsedT.status; }
						} catch { }

						items.push({ paths, title, status });
					}
				}
			} catch { }
			return items;
		};

		const renderBranch = async (dirUri: URI, prefix: string, depth: number): Promise<string[]> => {
			const lines: string[] = [];
			const subTickets = await getDirectSubTickets(dirUri);
			if (subTickets.length === 0) { return lines; }

			for (let i = 0; i < subTickets.length; i++) {
				const item = subTickets[i];
				const isLast = (i === subTickets.length - 1);
				const pointer = isLast ? '└\u2500\u2500 ' : '├\u2500\u2500 ';
				const nextPrefix = prefix + (isLast ? '    ' : '\u2502   ');

				const emoji = typeEmoji(item.paths.ticketType);
				const isFocus = !!(activeTicketId && (item.paths.ticketId === activeTicketId || item.paths.ticketId.toLowerCase() === activeTicketId.toLowerCase()));
				const focusBadge = isFocus ? ' [CURRENT FOCUS]' : '';

				const grandChildren = await getDirectSubTickets(item.paths.folderUri);
				const shouldExpand = (depth < maxDepth) || isFocus || (grandChildren.length <= 5 && depth <= maxDepth + 1);

				if (grandChildren.length > 0 && !shouldExpand) {
					lines.push(`${prefix}${pointer}${emoji} ${item.paths.ticketId} [${item.paths.ticketType}] ${item.title} (Status: ${item.status}, ${grandChildren.length} sub-items)${focusBadge}`);
				} else {
					lines.push(`${prefix}${pointer}${emoji} ${item.paths.ticketId} [${item.paths.ticketType}] ${item.title} (Status: ${item.status})${focusBadge}`);
					if (grandChildren.length > 0) {
						const childLines = await renderBranch(item.paths.folderUri, nextPrefix, depth + 1);
						lines.push(...childLines);
					}
				}
			}
			return lines;
		};

		const treeLines = await renderBranch(workspaceUri, '  ', 1);
		if (treeLines.length === 0) {
			return '  (Empty workspace - no tickets created yet)';
		}
		return treeLines.join('\n');
	}

	/**
	 * Query workspace tree on-demand
	 */
	public async queryWorkspaceTree(options: IQueryWorkspaceTreeToolOptions) {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.parent_ticket_id);
		if (!wsUri) { throw new Error(`Workspace '${options.workspace_id}' not found.`); }

		let baseUri = wsUri;
		const targetParentId = options.parent_ticket_id;
		if (targetParentId && targetParentId !== '/' && targetParentId !== 'root' && targetParentId !== '.') {
			const resolved = await this.resolveTicketPaths(wsUri, targetParentId);
			if (resolved) {
				baseUri = resolved.folderUri;
			} else {
				throw new Error(`Parent ticket '${targetParentId}' not found in workspace '${options.workspace_id}'.`);
			}
		}

		const maxDepth = options.max_depth || 3;
		const query = (options.query || '').trim().toLowerCase();

		const allTickets = await this._collectAllWorkspaceTickets(baseUri);
		let matches = allTickets;
		if (query) {
			matches = allTickets.filter(t =>
				t.ticketId.toLowerCase().includes(query) ||
				t.ticketType.toLowerCase().includes(query) ||
				t.title.toLowerCase().includes(query) ||
				(t.seqNumber !== undefined && String(t.seqNumber) === query)
			);
		}

		const treeView = await this.buildCompactWorkspaceTree(baseUri, undefined, maxDepth);

		return {
			workspace_id: options.workspace_id,
			base_ticket_or_folder: targetParentId || '/',
			total_matching: matches.length,
			matching_tickets: matches.slice(0, 30).map(t => ({
				ticket_id: t.ticketId,
				ticket_type: t.ticketType,
				title: t.title,
				folder_path: t.paths.folderUri.fsPath
			})),
			tree_view: treeView
		};
	}

	/**
	 * 1. anyagent_get_ticket_data
	 */
	public async getTicketData(workspaceId: string, ticketId: string, fieldPath?: string, parentPath?: string): Promise<unknown> {
		const fullData = await this._getFullTicketData(workspaceId, ticketId, parentPath);

		if (!fieldPath || fieldPath === '/' || fieldPath === '') {
			return fullData;
		}

		// Field-specific query
		return this._extractFieldByPath(fullData, fieldPath);
	}

	private async _getFullTicketData(workspaceId: string, ticketId: string, parentPath?: string) {
		const wsUri = await this.findWorkspaceUri(workspaceId, ticketId);
		if (!wsUri) { throw new Error(`Workspace '${workspaceId}' not found.`); }

		const paths = await this.resolveTicketPaths(wsUri, ticketId, parentPath);
		if (!paths) { throw new Error(`Ticket '${ticketId}' not found in workspace '${workspaceId}'.`); }

		// Read files
		const ticketContent = (await this.fileService.readFile(paths.ticketMdUri)).value.toString();
		const readmeContent = await this._safeRead(paths.readmeMdUri);
		const instructionContent = await this._safeRead(paths.instructionMdUri);

		// Get workspace statuses & mapping
		const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(paths.folderUri);

		// Dynamically discover children under this ticket's directory (no static file modification)
		const discoveredChildren = await this._discoverChildren(paths.folderUri, wsUri);

		// Parse metadata
		const parsedTicket = this._parseTicketMd(ticketContent);
		const parsedReadme = this._parseReadmeMd(readmeContent);
		const parsedInstruction = this._parseInstructionMd(instructionContent);

		// Load the ticket's template (type) definition, if any, as a plain object
		const schemaDefinition = await this._readTicketSchema(paths.folderUri, wsUri, paths.ticketType);

		// Also merge customMetadata from .agents/entity_snapshot.json if present (e.g. Workflows)
		const mergedSelfDefinedData: Record<string, unknown> = { ...parsedTicket.selfDefinedData };
		const snapshotUri = URI.joinPath(paths.folderUri, '.agents', 'entity_snapshot.json');
		if (await this.fileService.exists(snapshotUri)) {
			try {
				const snapRaw = (await this.fileService.readFile(snapshotUri)).value.toString();
				const snapObj = JSON.parse(snapRaw);
				if (snapObj && snapObj.customMetadata && typeof snapObj.customMetadata === 'object') {
					for (const [k, v] of Object.entries(snapObj.customMetadata)) {
						if (mergedSelfDefinedData[k] === undefined) {
							mergedSelfDefinedData[k] = v;
						}
					}
				}
			} catch { }
		}

		const fullData = {
			workspace_id: paths.workspaceId,
			ticket_id: paths.ticketId,
			ticket_type: paths.ticketType,
			title: parsedReadme.title || paths.ticketId,
			description: parsedReadme.description || '',
			status: parsedTicket.status || 'Todo',
			priority: parsedTicket.priority || 'Medium',
			current_ai_agent: parsedTicket.currentAiAgent || 'None',
			parent_path: parsedTicket.parentPath || '/',
			children: discoveredChildren,
			profile_data: parsedTicket.profileData,
			self_defined_data: mergedSelfDefinedData,
			links: {
				link_to: parsedTicket.linkTo || 'None',
				linked_by: parsedTicket.linkedBy || 'None'
			},
			attachments: parsedTicket.attachments,
			prompts: {
				ticket_type_prompt: parsedInstruction.typePrompt || '',
				ticket_prompt: parsedInstruction.ticketPrompt || ''
			},
			workspace_status_flow: {
				statuses: wsStatuses.statuses,
				mapping: wsStatuses.mapping,
				initial_status: wsStatuses.initialStatus,
				removed_status: wsStatuses.removedStatus
			},
			schema_definition: schemaDefinition
		};
		return fullData;
	}

	/**
	 * 2. anyagent_create_ticket
	 */
	public async createTicket(options: ICreateTicketToolOptions) {
		// Freestyle tickets can only be created manually in the UI (create dialog), never by AI tools
		const reservedTypeError = getProgrammaticTicketTypeError(options.ticket_type);
		if (reservedTypeError) {
			throw new Error(reservedTypeError);
		}
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) { throw new Error(`Workspace '${options.workspace_id}' not found.`); }

		// 1. Determine parent folder URI
		let parentFolderUri = wsUri;
		if (options.parent_path && options.parent_path !== '/' && options.parent_path !== 'root' && options.parent_path !== '.') {
			const resolvedParent = await this.resolveTicketPaths(wsUri, options.parent_path);
			if (resolvedParent) {
				parentFolderUri = resolvedParent.folderUri;
			} else {
				// SAFETY: DO NOT create an arbitrary folder on disk!
				const allTickets = await this._collectAllWorkspaceTickets(wsUri);
				const ticketSummary = allTickets.map(t => `${t.ticketId} (Type: ${t.ticketType}, Title: "${t.title}")`).join(', ');
				throw new Error(`Parent ticket '${options.parent_path}' was not found in workspace '${options.workspace_id}'. Existing tickets in this workspace are: [${ticketSummary || 'none'}]. Please specify an existing ticket ID (such as 'NEOWO-0001') or '/' for workspace root.`);
			}
		}

		// 2. Generate sequential name & code
		const { name, code } = await this.workspacesExplorerService.generateNextSequentialName(parentFolderUri, options.ticket_type);

		// 3. Workspace statuses
		const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(wsUri);
		const initialStatus = options.status || wsStatuses.initialStatus || 'Todo';

		// 4. Create resource (a sub_workflow ticket must be inside a workflow folder; its definition is validated there)
		const isSubWorkflow = isSubWorkflowTicketType(options.ticket_type);
		const result = await this.workspacesExplorerService.createResourceUnderWorkspace({
			workspaceUri: wsUri,
			targetParentUri: parentFolderUri,
			type: options.ticket_type,
			name: name,
			title: options.title,
			description: options.description || '',
			status: initialStatus,
			priority: options.priority || 'Medium',
			assignedAgentName: options.assigned_agent || 'None',
			linkTo: options.link_to || 'None',
			ticketPrompt: options.ticket_prompt,
			customMetadata: (options.custom_values && !isSubWorkflow) ? this._flattenCustomValues(options.custom_values) : undefined,
			subWorkflowDefinition: isSubWorkflow ? (options.sub_workflow_definition ?? options.custom_values?.definition) : undefined
		});

		// 5. Append initial worklog record
		const newPaths = await this._checkFolderForTicketPaths(result.uri);
		if (newPaths && options.worklog_record) {
			await this.appendWorklog(newPaths.worklogMdUri, options.worklog_record);
		}

		// 6. Handle link_to target sync if any
		if (options.link_to && options.link_to !== 'None') {
			const targetIds = options.link_to.split(',').map(s => s.trim()).filter(Boolean);
			if (targetIds.length > 0) {
				await this._syncTargetsLinkedBy(wsUri, [name], targetIds, 'add');
			}
		}

		return {
			success: true,
			ticket_id: name,
			ticket_code: code,
			folder_path: result.uri.fsPath,
			title: options.title,
			status: initialStatus
		};
	}

	/**
	 * 3. anyagent_delete_ticket
	 */
	public async deleteTicket(options: IDeleteTicketToolOptions) {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.ticket_id);
		if (!wsUri) { throw new Error(`Workspace '${options.workspace_id}' not found.`); }

		const paths = await this.resolveTicketPaths(wsUri, options.ticket_id, options.parent_path);
		if (!paths) { throw new Error(`Ticket '${options.ticket_id}' not found.`); }

		const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(paths.folderUri);
		const removedStatusName = wsStatuses.removedStatus || 'Removed';

		// 1. Mark target ticket as Removed
		await this.workspacesExplorerService.setEntityStatus(paths.folderUri, removedStatusName);
		await this.workspacesExplorerService.removeSnapshot(paths.folderUri);

		// 2. Cascade delete all sub-tickets recursively
		const children = await this.workspacesExplorerService.scanWorkspaceChildren(paths.folderUri, true);
		const cascadedIds: string[] = [];
		await this._cascadeMarkRemoved(children, removedStatusName, cascadedIds);

		// 3. Clean up bidirectional links in external tickets
		const ticketData = await this._getFullTicketData(options.workspace_id, options.ticket_id, options.parent_path);
		const linkToList = this._splitList(ticketData.links?.link_to);
		const linkedByList = this._splitList(ticketData.links?.linked_by);

		// Remove this ticket from targets' Linked By
		if (linkToList.length > 0) {
			await this._syncTargetsLinkedBy(wsUri, [options.ticket_id], linkToList, 'remove');
		}
		// Remove this ticket from sources' Link To
		if (linkedByList.length > 0) {
			await this._syncSourcesLinkTo(wsUri, linkedByList, [options.ticket_id], 'remove');
		}

		// 4. Append worklog to the removed ticket
		if (options.worklog_record) {
			try {
				await this.appendWorklog(paths.worklogMdUri, options.worklog_record);
			} catch { }
		}

		// 5. If move_to_trash requested, permanently move folder to OS Trash
		let movedToOsTrash = false;
		if (options.move_to_trash) {
			try {
				await this.fileService.del(paths.folderUri, { recursive: true, useTrash: true });
				movedToOsTrash = true;
				await this.workspacesExplorerService.removeSnapshot(paths.folderUri);
			} catch (err) {
				console.error('Failed to move ticket folder to OS trash:', err);
			}
		}

		return {
			success: true,
			removed_ticket_id: options.ticket_id,
			status_set_to: removedStatusName,
			moved_to_os_trash: movedToOsTrash,
			cascaded_child_tickets_removed: cascadedIds,
			unlinked_references: {
				targets_unlinked: linkToList,
				sources_unlinked: linkedByList
			}
		};
	}

	private async _cascadeMarkRemoved(children: IWorkspaceChildItem[], removedStatus: string, collectedIds: string[]): Promise<void> {
		for (const child of children) {
			if (child.uri && child.type !== 'file' && child.type !== 'folder') {
				try {
					await this.workspacesExplorerService.setEntityStatus(child.uri, removedStatus);
					await this.workspacesExplorerService.removeSnapshot(child.uri);
					if (child.name) { collectedIds.push(child.name); }
				} catch { }
			}
			if (child.children && child.children.length > 0) {
				await this._cascadeMarkRemoved(child.children, removedStatus, collectedIds);
			}
		}
	}

	/**
	 * 4. anyagent_update_ticket
	 */
	/**
	 * Reads the ticket's template (type) YAML: ticket folder, then workspace, then the global template folder.
	 * A Freestyle ticket has no template: its own structure (`.agents/freestyle_schema.json`) is returned instead.
	 */
	private async _readTicketSchema(folderUri: URI, wsUri: URI | undefined, ticketType: string): Promise<object | null> {
		if (isFreestyleTicketType(ticketType)) {
			return await readFreestyleSchema(this.fileService, folderUri) ?? null;
		}
		const typeYamlCandidates = [
			URI.joinPath(folderUri, '.agents', 'entity_type', `${ticketType}.yaml`),
			...(wsUri ? [URI.joinPath(wsUri, '.agents', 'entity_type', `${ticketType}.yaml`)] : []),
			URI.file(`/Users/aimery/.anyagent/entity_type/${ticketType}.yaml`)
		];
		for (const typeYamlUri of typeYamlCandidates) {
			if (await this.fileService.exists(typeYamlUri)) {
				try {
					const schema = parseTemplateYaml((await this.fileService.readFile(typeYamlUri)).value.toString());
					if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
						return schema;
					}
				} catch { }
			}
		}
		return null;
	}

	public async updateTicket(options: IUpdateTicketToolOptions) {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.ticket_id);
		let paths = wsUri ? await this.resolveTicketPaths(wsUri, options.ticket_id, options.parent_path) : undefined;

		if (!paths && this.agentsManagerService) {
			try {
				const agents = await this.agentsManagerService.getAgents();
				const matchedAgent = agents.find(a => {
					const fName = a.folderPath ? a.folderPath.split(/[/\\]/).filter(Boolean).pop() : '';
					return (fName && fName === options.ticket_id) ||
						(a.id && a.id === options.ticket_id) ||
						(a.name && (a.name === options.ticket_id || a.name.toLowerCase() === options.ticket_id.toLowerCase()));
				});
				if (matchedAgent && matchedAgent.folderPath) {
					paths = await this._checkFolderForTicketPaths(URI.file(matchedAgent.folderPath));
				}
			} catch { }
		}

		if (!paths) {
			if (!wsUri) { throw new Error(`Workspace '${options.workspace_id}' not found.`); }
			throw new Error(`Ticket '${options.ticket_id}' not found.`);
		}

		let ticketContent = (await this.fileService.readFile(paths.ticketMdUri)).value.toString();
		let readmeContent = await this._safeRead(paths.readmeMdUri);
		let instructionContent = await this._safeRead(paths.instructionMdUri);

		let ticketModified = false;
		let readmeModified = false;
		let instructionModified = false;
		let schemaFields: ICustomField[] | undefined = undefined;

		for (const [rawPath, rawVal] of Object.entries(options.updates)) {
			const path = rawPath.trim();

			// 1. Title
			if (path === '/Title' || path === 'Title' || path === '/README/Title') {
				if (rawVal) {
					readmeContent = readmeContent.replace(/^-\s*\*\*Title\*\*:\s*.*$/m, () => `- **Title**: ${rawVal}`);
					readmeModified = true;
				}
			}
			// 2. Description
			else if (path === '/Description' || path === 'Description' || path === '/README/Description') {
				const descVal = rawVal || 'None';
				readmeContent = readmeContent.replace(/^-\s*\*\*Description\*\*:\s*.*$/m, () => `- **Description**: ${descVal}`);
				readmeModified = true;
			}
			// 3. Status
			else if (path === '/Status' || path === '/Attributes/Status' || path === 'Status') {
				if (rawVal) {
					ticketContent = ticketContent.replace(/^-\s*\*\*Status\*\*:\s*.*$/m, () => `- **Status**: ${rawVal}`);
					ticketModified = true;
					// Synchronize through explorer service as well
					await this.workspacesExplorerService.setEntityStatus(paths.folderUri, rawVal as string);
				}
			}
			// 4. Priority
			else if (path === '/Priority' || path === '/Attributes/Priority' || path === 'Priority') {
				if (rawVal) {
					ticketContent = ticketContent.replace(/^-\s*\*\*Priority\*\*:\s*.*$/m, () => `- **Priority**: ${rawVal}`);
					ticketModified = true;
				}
			}
			// 5. Current AI Agent
			else if (path === '/Current AI Agent' || path === '/Attributes/Current AI Agent') {
				const agentVal = rawVal || 'None';
				ticketContent = ticketContent.replace(/^-\s*\*\*Current AI Agent\*\*:\s*.*$/m, () => `- **Current AI Agent**: ${agentVal}`);
				ticketModified = true;
			}
			// 6. Prompts in instruction.md
			else if (path === '/Instructions/Ticket Prompt' || path === '/Ticket Prompt') {
				const pVal = rawVal || 'None';
				instructionContent = instructionContent.replace(/^-\s*\*\*Ticket Prompt\*\*:\s*.*$/m, () => `- **Ticket Prompt**: ${pVal}`);
				instructionModified = true;
			}
			else if (path === '/Instructions/Ticket Type Prompt' || path === '/Ticket Type Prompt') {
				const pVal = rawVal || 'None';
				instructionContent = instructionContent.replace(/^-\s*\*\*Ticket Type Prompt\*\*:\s*.*$/m, () => `- **Ticket Type Prompt**: ${pVal}`);
				instructionModified = true;
			}
			else if (path === '/Instructions/Instruction Notes' || path === '/Instruction Notes' || path === '/Instructions') {
				const notes = String(rawVal ?? '');
				const lines = instructionContent.split(/\r?\n/);
				const sepIdx = lines.findIndex(l => l.startsWith('---'));
				if (sepIdx !== -1) {
					lines.splice(sepIdx + 1, lines.length - (sepIdx + 1), '', notes);
				} else {
					lines.push('', '---', '', notes);
				}
				instructionContent = lines.join('\n');
				instructionModified = true;
			}
			// 7. Dynamic Custom Cards & Attributes (/Custom/...)
			else if (path.startsWith('/Custom/') || path.startsWith('Custom/')) {
				let cleanPath = path.replace(/^\/?Custom\//, '');
				let customVal = rawVal;
				if (!cleanPath.includes('/')) {
					schemaFields ??= getTemplateFields(await this._readTicketSchema(paths.folderUri, wsUri, paths.ticketType));
					const fieldDef = findTemplateField(schemaFields, cleanPath);
					if (fieldDef) {
						// Ticket values are stored under the component's label (what the ticket UI reads), also when addressed by id.
						// (A label containing '/' cannot be written as a flat key by _applyCustomUpdate, so keep the given key then.)
						if (typeof fieldDef.label === 'string' && fieldDef.label.trim() && !fieldDef.label.includes('/')) {
							cleanPath = fieldDef.label;
						}
						// Enforce a number component's range / precision (same rules as the ticket UI)
						if (fieldDef.type === 'number') {
							const numCheck = normalizeNumberFieldValue({ label: fieldDef.label, min: fieldDef.min, max: fieldDef.max, precision: fieldDef.precision }, customVal);
							if (!numCheck.ok) {
								throw new Error(numCheck.error);
							}
							customVal = numCheck.value;
						}
					}
				}
				ticketContent = this._applyCustomUpdate(ticketContent, cleanPath, customVal);
				ticketModified = true;
			}
		}

		// 8. Auto-sync physical attachment files if any attachment fields or file objects were updated
		const filesToSync: string[] = [];
		for (const [k, v] of Object.entries(options.updates)) {
			if (k.toLowerCase().includes('attachment') || Array.isArray(v) || (typeof v === 'object' && v && hasKey(v, { name: true }))) {
				const items = Array.isArray(v) ? v : [v];
				for (const item of items) {
					if (item && typeof item === 'object' && (item as IJsonObject).name && typeof (item as IJsonObject).name === 'string') {
						filesToSync.push((item as IJsonObject).name as string);
					} else if (typeof item === 'string' && /\.[a-zA-Z0-9]{2,5}$/.test(item)) {
						filesToSync.push(item);
					}
				}
			}
		}

		if (filesToSync.length > 0) {
			const attachmentsDir = URI.joinPath(paths.folderUri, 'attachments');
			if (!(await this.fileService.exists(attachmentsDir))) {
				await this.fileService.createFolder(attachmentsDir);
			}
			for (const fileName of filesToSync) {
				const destUri = URI.joinPath(attachmentsDir, fileName);
				if (!(await this.fileService.exists(destUri))) {
					const userHome = '/Users/aimery';
					const candidates = [
						URI.file(`${userHome}/Desktop/${fileName}`),
						URI.file(`${userHome}/Downloads/${fileName}`),
						URI.file(`${userHome}/Documents/${fileName}`)
					];
					for (const cand of candidates) {
						if (await this.fileService.exists(cand)) {
							try {
								await this.fileService.copy(cand, destUri, true);
								break;
							} catch { }
						}
					}
				}

				// Also ensure ### Attachments Links in ticket.md reflects this file
				const fileLinkPattern = new RegExp(`\\[${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'i');
				if (!fileLinkPattern.test(ticketContent)) {
					const encodedName = encodeURIComponent(fileName);
					const linkLine = `- [${fileName}](attachments/${encodedName})`;
					if (/^### Attachments Links\n-\s*None/m.test(ticketContent)) {
						ticketContent = ticketContent.replace(/^### Attachments Links\n-\s*None/m, `### Attachments Links\n${linkLine}`);
					} else if (/^### Attachments Links/m.test(ticketContent)) {
						ticketContent = ticketContent.replace(/(^### Attachments Links\n)/m, `$1${linkLine}\n`);
					} else {
						ticketContent += `\n### Attachments Links\n${linkLine}\n`;
					}
					ticketModified = true;
				}
			}
		}

		// Update Last Updated At / By in ticket.md
		const nowFormatted = this._getFormattedDateTime();
		ticketContent = ticketContent.replace(/^-\s*\*\*Last Updated At\*\*:\s*.*$/m, `- **Last Updated At**: ${nowFormatted}`);
		ticketContent = ticketContent.replace(/^-\s*\*\*Last Updated By\*\*:\s*.*$/m, `- **Last Updated By**: AI Agent`);
		ticketModified = true;

		// Save files
		if (ticketModified) {
			await this.fileService.writeFile(paths.ticketMdUri, VSBuffer.fromString(ticketContent));
		}
		if (readmeModified) {
			await this.fileService.writeFile(paths.readmeMdUri, VSBuffer.fromString(readmeContent));
		}
		if (instructionModified) {
			await this.fileService.writeFile(paths.instructionMdUri, VSBuffer.fromString(instructionContent));
		}

		// Sync .agents/entity_snapshot.json if present (e.g. Workflows or snapshots)
		const snapshotUri = URI.joinPath(paths.folderUri, '.agents', 'entity_snapshot.json');
		if (await this.fileService.exists(snapshotUri)) {
			try {
				const snapRaw = (await this.fileService.readFile(snapshotUri)).value.toString();
				const snapObj = JSON.parse(snapRaw);
				if (snapObj && typeof snapObj === 'object') {
					let snapModified = false;
					if (!snapObj.customMetadata || typeof snapObj.customMetadata !== 'object') {
						snapObj.customMetadata = {};
					}
					for (const [rawPath, rawVal] of Object.entries(options.updates)) {
						const p = rawPath.trim();
						if (p === '/Title' || p === 'Title' || p === '/README/Title') {
							if (rawVal) { snapObj.title = String(rawVal); snapModified = true; }
						} else if (p === '/Description' || p === 'Description' || p === '/README/Description') {
							snapObj.description = String(rawVal || ''); snapModified = true;
						} else if (p === '/Status' || p === '/Attributes/Status' || p === 'Status') {
							if (rawVal) { snapObj.status = String(rawVal); snapModified = true; }
						} else if (p === '/Priority' || p === '/Attributes/Priority' || p === 'Priority') {
							if (rawVal) { snapObj.priority = String(rawVal); snapModified = true; }
						} else if (p.startsWith('/Custom/') || p.startsWith('Custom/')) {
							const cleanKey = p.replace(/^\/?Custom\//, '').split('/')[0];
							if (cleanKey) {
								snapObj.customMetadata[cleanKey] = (typeof rawVal === 'object' && rawVal !== null) ? JSON.stringify(rawVal) : String(rawVal ?? '');
								snapModified = true;
							}
						}
					}
					if (snapModified) {
						snapObj.updatedAt = new Date().toISOString();
						await this.fileService.writeFile(snapshotUri, VSBuffer.fromString(JSON.stringify(snapObj, null, 2)));
					}
				}
			} catch { }
		}

		// Append worklog
		if (options.worklog_record) {
			await this.appendWorklog(paths.worklogMdUri, options.worklog_record);
		}

		return {
			success: true,
			ticket_id: options.ticket_id,
			modified_files: [
				ticketModified ? 'ticket.md' : null,
				readmeModified ? 'README.md' : null,
				instructionModified ? 'instruction.md' : null,
				'worklog.md'
			].filter(Boolean),
			applied_updates: options.updates
		};
	}

	/**
	 * 5. anyagent_manage_links
	 */
	public async manageLinks(options: IManageLinksToolOptions) {
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) { throw new Error(`Workspace '${options.workspace_id}' not found.`); }

		const involvedTicketPaths: ITicketResolvedPaths[] = [];

		for (const srcId of options.source_ticket_ids) {
			const srcPaths = await this.resolveTicketPaths(wsUri, srcId);
			if (!srcPaths) { continue; }
			involvedTicketPaths.push(srcPaths);

			let srcTicketContent = (await this.fileService.readFile(srcPaths.ticketMdUri)).value.toString();
			const currentLinkTo = this._extractLinkValue(srcTicketContent, 'Link To');
			let newLinkToList = this._splitList(currentLinkTo);

			if (options.action === 'add_links') {
				for (const targetId of options.target_ticket_ids) {
					if (!newLinkToList.includes(targetId)) { newLinkToList.push(targetId); }
				}
			} else if (options.action === 'remove_links') {
				newLinkToList = newLinkToList.filter(id => !options.target_ticket_ids.includes(id));
			} else if (options.action === 'set_links') {
				newLinkToList = [...options.target_ticket_ids];
			}

			const finalLinkToStr = newLinkToList.length > 0 ? newLinkToList.join(', ') : 'None';
			srcTicketContent = srcTicketContent.replace(/^-\s*\*\*Link To\*\*:\s*.*$/m, `- **Link To**: ${finalLinkToStr}`);
			await this.fileService.writeFile(srcPaths.ticketMdUri, VSBuffer.fromString(srcTicketContent));
		}

		// Update Linked By on targets
		for (const targetId of options.target_ticket_ids) {
			const targetPaths = await this.resolveTicketPaths(wsUri, targetId);
			if (!targetPaths) { continue; }
			if (!involvedTicketPaths.some(p => p.ticketId === targetPaths.ticketId)) {
				involvedTicketPaths.push(targetPaths);
			}

			let targetTicketContent = (await this.fileService.readFile(targetPaths.ticketMdUri)).value.toString();
			const currentLinkedBy = this._extractLinkValue(targetTicketContent, 'Linked By');
			let newLinkedByList = this._splitList(currentLinkedBy);

			if (options.action === 'add_links' || options.action === 'set_links') {
				for (const srcId of options.source_ticket_ids) {
					if (!newLinkedByList.includes(srcId)) { newLinkedByList.push(srcId); }
				}
			} else if (options.action === 'remove_links') {
				newLinkedByList = newLinkedByList.filter(id => !options.source_ticket_ids.includes(id));
			}

			const finalLinkedByStr = newLinkedByList.length > 0 ? newLinkedByList.join(', ') : 'None';
			targetTicketContent = targetTicketContent.replace(/^-\s*\*\*Linked By\*\*:\s*.*$/m, `- **Linked By**: ${finalLinkedByStr}`);
			await this.fileService.writeFile(targetPaths.ticketMdUri, VSBuffer.fromString(targetTicketContent));
		}

		// Synchronize worklog to all involved tickets
		if (options.worklog_record) {
			for (const p of involvedTicketPaths) {
				await this.appendWorklog(p.worklogMdUri, options.worklog_record);
			}
		}

		return {
			success: true,
			action: options.action,
			sources: options.source_ticket_ids,
			targets: options.target_ticket_ids,
			synchronized_tickets_count: involvedTicketPaths.length
		};
	}

	/**
	 * Append standard worklog record into independent Worklogs storage and update worklog.md summary
	 */
	public async appendWorklog(worklogUri: URI, record: IWorklogRecord): Promise<void> {
		try {
			const storage = new TicketWorklogStorage(this.fileService);
			await storage.saveWorklog(dirname(worklogUri), {
				user_request: record.user_request,
				update_summary: record.update_summary,
				update_details: record.update_details,
				update_conclusion: record.update_conclusion,
				commit: record.commit,
				update_by: 'AI Agent'
			});
		} catch (err) {
			console.error('Failed to append worklog via TicketWorklogStorage:', err);
		}
	}

	private _getFormattedDateTime(): string {
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	}

	private _getFormattedDateTimeWithSecondsAndTz(): string {
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, '0');
		const tzOffset = -now.getTimezoneOffset();
		const sign = tzOffset >= 0 ? '+' : '-';
		const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
		const tzMinutes = pad(Math.abs(tzOffset) % 60);
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${sign}${tzHours}:${tzMinutes}`;
	}

	// ---------------- Helper Methods ----------------

	private async _safeRead(uri: URI): Promise<string> {
		if (await this.fileService.exists(uri)) {
			return (await this.fileService.readFile(uri)).value.toString();
		}
		return '';
	}

	private _parseTicketMd(content: string): IParsedTicketMd {
		const result: IParsedTicketMd = {
			profileData: {},
			selfDefinedData: {},
			attachments: []
		};
		const lines = content.split(/\r?\n/);
		let currentSection = 'overview';

		for (const line of lines) {
			if (line.startsWith('### Profile Data')) { currentSection = 'profile'; continue; }
			if (line.startsWith('### Self Defined Data')) { currentSection = 'self_defined'; continue; }
			if (line.startsWith('### Link')) { currentSection = 'link'; continue; }
			if (line.startsWith('### Attachments Links')) { currentSection = 'attachments'; continue; }
			if (line.startsWith('## ') || (line.startsWith('### ') && !line.includes('Profile') && !line.includes('Self') && !line.includes('Link') && !line.includes('Attachments'))) {
				currentSection = 'overview';
			}

			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match) {
				const k = match[1].trim();
				const v = match[2].trim();
				if (currentSection === 'profile') {
					result.profileData[k] = v;
				} else if (currentSection === 'self_defined') {
					result.selfDefinedData[k] = v;
				} else if (k === 'Status') {
					result.status = v;
				} else if (k === 'Priority') {
					result.priority = v;
				} else if (k === 'Current AI Agent') {
					result.currentAiAgent = v;
				} else if (k === 'Parent Path') {
					result.parentPath = v;
				} else if (k === 'Link To') {
					result.linkTo = v;
				} else if (k === 'Linked By') {
					result.linkedBy = v;
				}
			} else if (currentSection === 'attachments' && line.trim().startsWith('- [')) {
				result.attachments.push(line.trim().slice(2));
			}
		}
		return result;
	}

	private _parseReadmeMd(content: string): { title?: string; description?: string } {
		const titleMatch = content.match(/^-\s*\*\*Title\*\*:\s*(.+)$/m);
		const descMatch = content.match(/^-\s*\*\*Description\*\*:\s*(.+)$/m);
		return {
			title: titleMatch ? titleMatch[1].trim() : undefined,
			description: descMatch ? descMatch[1].trim() : undefined
		};
	}

	private _parseInstructionMd(content: string): { typePrompt?: string; ticketPrompt?: string } {
		const typeMatch = content.match(/^-\s*\*\*Ticket Type Prompt\*\*:\s*(.+)$/m);
		const ticketMatch = content.match(/^-\s*\*\*Ticket Prompt\*\*:\s*(.+)$/m);
		return {
			typePrompt: typeMatch ? typeMatch[1].trim() : undefined,
			ticketPrompt: ticketMatch ? ticketMatch[1].trim() : undefined
		};
	}

	private _applyCustomUpdate(content: string, path: string, val: unknown): string {
		const parts = path.split('/').filter(Boolean);
		if (parts.length === 0) { return content; }

		// 1. /Custom/<key>/add -> Add items to list, table, or dynamic card
		if (parts.length === 2 && parts[1] === 'add' && val !== undefined && val !== null) {
			const listKey = parts[0];
			const propRegex = new RegExp(`^(\\s*-\\s*\\*\\*${escapeRegExpCharacters(listKey)}\\*\\*:)(.*)$`, 'm');
			const propMatch = content.match(propRegex);

			// Check if listKey is a Data Table JSON object ({ columns, rows, ... })
			if (propMatch && propMatch[2].trim().startsWith('{')) {
				try {
					const parsedObj = JSON.parse(propMatch[2].trim());
					if (parsedObj && typeof parsedObj === 'object' && Array.isArray(parsedObj.rows)) {
						const rowsToAdd = Array.isArray(val) ? val : [val];
						parsedObj.rows.push(...rowsToAdd);
						content = content.replace(propRegex, () => `  - **${listKey}**: ${JSON.stringify(parsedObj)}`);
						return content;
					}
				} catch { }
			}

			// Check if listKey is stored as a JSON array / flat line
			const isArrayOrAttachment = Array.isArray(val) || (typeof val === 'object' && isAttachmentLike(val)) || (propMatch && propMatch[2].trim().startsWith('['));

			if (isArrayOrAttachment) {
				let existingArr: unknown[] = [];
				if (propMatch && propMatch[2].trim().startsWith('[')) {
					try { existingArr = JSON.parse(propMatch[2].trim()); } catch { }
					if (!Array.isArray(existingArr)) { existingArr = []; }
				} else if (propMatch && propMatch[2].trim()) {
					existingArr = [{ name: propMatch[2].trim() }];
				}

				const itemsToAdd = Array.isArray(val) ? val : [val];
				for (const item of itemsToAdd) {
					const itemName = typeof item === 'object' && item ? (itemIdentity(item) || JSON.stringify(item)) : String(item);
					const exists = existingArr.some(e => {
						const eName = typeof e === 'object' && e ? (itemIdentity(e) || JSON.stringify(e)) : String(e);
						return eName === itemName;
					});
					if (!exists) {
						existingArr.push(item);
					}
				}

				const updatedJson = JSON.stringify(existingArr);
				if (propMatch) {
					content = content.replace(propRegex, () => `  - **${listKey}**: ${updatedJson}`);
				} else {
					if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
						content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, (_m, p1) => `${p1}\n  - **${listKey}**: ${updatedJson}`);
					} else if (/### Self Defined Data Value/m.test(content)) {
						content = content.replace(/(### Self Defined Data Value:?\n)/m, (_m, p1) => `${p1}  - **${listKey}**: ${updatedJson}\n`);
					} else {
						content += `\n  - **${listKey}**: ${updatedJson}\n`;
					}
				}
				return content;
			}

			// Otherwise, handle as markdown sub-card block
			const valObj = val as IJsonObject;
			const cardKey = valObj.key || valObj.name || valObj.title || `Item ${Date.now()}`;
			let newCardBlock = `  - **${cardKey}**:\n`;
			for (const [subK, subV] of Object.entries(val)) {
				if (subK === 'key') { continue; }
				newCardBlock += `    - **${subK}**: ${subV}\n`;
			}

			// Find listKey in Self Defined Data Value
			const listRegex = new RegExp(`(  - \\*\\*${escapeRegExpCharacters(listKey)}\\*\\*:\\n?)([\\s\\S]*?)(?=(\\n  - \\*\\*|\\n\\n|\\n###|$))`);
			if (listRegex.test(content)) {
				content = content.replace(listRegex, (_m, p1, p2) => `${p1}${p2}${newCardBlock}`);
			} else {
				if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
					content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, (_m, p1) => `${p1}\n  - **${listKey}**: ${newCardBlock}`);
				} else if (/### Self Defined Data Value/m.test(content)) {
					content = content.replace(/(### Self Defined Data Value:?\n)/m, (_m, p1) => `${p1}  - **${listKey}**: ${newCardBlock}`);
				}
			}
			return content;
		}

		// 2. /Custom/<key>/remove or /delete
		if (parts.length === 2 && (parts[1] === 'remove' || parts[1] === 'delete')) {
			const listKey = parts[0];
			const propRegex = new RegExp(`^(\\s*-\\s*\\*\\*${escapeRegExpCharacters(listKey)}\\*\\*:)(.*)$`, 'm');
			const propMatch = content.match(propRegex);
			if (propMatch && propMatch[2].trim().startsWith('[')) {
				try {
					let arr = JSON.parse(propMatch[2].trim());
					if (Array.isArray(arr)) {
						const targetName = typeof val === 'object' && val ? itemIdentity(val) : String(val);
						arr = arr.filter(item => {
							const itemName = typeof item === 'object' && item ? (item.name || item.key || item.title) : String(item);
							return itemName !== targetName;
						});
						content = content.replace(propRegex, () => `  - **${listKey}**: ${JSON.stringify(arr)}`);
					}
				} catch { }
			}
			return content;
		}

		// 3. /Custom/<key>/<cardKey>/<attr> -> Update specific attribute of card
		if (parts.length === 3) {
			const [, cardKey, attr] = parts;
			const attrRegex = new RegExp(`(  - \\*\\*${escapeRegExpCharacters(cardKey)}\\*\\*:[\\s\\S]*?    - \\*\\*${escapeRegExpCharacters(attr)}\\*\\*:).*$`, 'm');
			if (attrRegex.test(content)) {
				content = content.replace(attrRegex, (_m, p1) => `${p1} ${val}`);
			}
			return content;
		}

		// 4. /Custom/<key>/<cardKey>: null -> Delete card
		if (parts.length === 2 && (val === null || val === undefined)) {
			const [, cardKey] = parts;
			const cardRegex = new RegExp(`\\n?    - \\*\\*${escapeRegExpCharacters(cardKey)}\\*\\*:[\\s\\S]*?(?=(\\n    - \\*\\*|\\n  - \\*\\*|\\n###|$))`, 'g');
			content = content.replace(cardRegex, '');
			return content;
		}

		// 5. /Custom/<key>: val -> Flat custom property or full array update
		if (parts.length === 1) {
			const key = parts[0];
			const propRegex = new RegExp(`^\\s*-\\s*\\*\\*${escapeRegExpCharacters(key)}\\*\\*:.*$`, 'm');
			const valStr = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val ?? '');
			if (val === null || val === undefined) {
				content = content.replace(propRegex, '');
			} else if (propRegex.test(content)) {
				content = content.replace(propRegex, () => `  - **${key}**: ${valStr}`);
			} else {
				if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
					content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, (_m, p1) => `${p1}\n  - **${key}**: ${valStr}`);
				} else if (/### Self Defined Data Value/m.test(content)) {
					content = content.replace(/(### Self Defined Data Value:?\n)/m, (_m, p1) => `${p1}  - **${key}**: ${valStr}\n`);
				} else {
					content += `\n  - **${key}**: ${valStr}\n`;
				}
			}
			return content;
		}

		return content;
	}

	private _extractFieldByPath(data: unknown, path: string): unknown {
		const prop = (obj: unknown, key: string): unknown => (obj as IJsonObject)[key];
		let clean = path.startsWith('/') ? path.slice(1) : path;
		let curr = data;

		if (clean.startsWith('Custom/')) {
			clean = clean.slice('Custom/'.length);
			if (curr && prop(curr, 'self_defined_data') !== undefined) {
				curr = prop(curr, 'self_defined_data');
			}
		} else if (clean.startsWith('Attributes/')) {
			clean = clean.slice('Attributes/'.length);
		} else if (clean.startsWith('Profile/')) {
			clean = clean.slice('Profile/'.length);
			if (curr && prop(curr, 'profile_data') !== undefined) {
				curr = prop(curr, 'profile_data');
			}
		} else if (clean.startsWith('Instructions/')) {
			clean = clean.slice('Instructions/'.length);
			if (curr && prop(curr, 'prompts') !== undefined) {
				curr = prop(curr, 'prompts');
			}
		}

		if (!clean) { return curr; }

		const parts = clean.split('/');
		for (const p of parts) {
			if (curr === undefined || curr === null) { return undefined; }
			if (typeof curr === 'string' && (curr.trim().startsWith('[') || curr.trim().startsWith('{'))) {
				try { curr = JSON.parse(curr); } catch { }
			}
			if (Array.isArray(curr) && /^\d+$/.test(p)) {
				const idx = parseInt(p, 10);
				curr = curr.find(item => item && (item._index === idx || item.id === p)) || curr[idx - 1] || curr[idx];
			} else if (prop(curr, p) !== undefined) {
				curr = prop(curr, p);
			} else if (prop(curr, 'self_defined_data') && prop(prop(curr, 'self_defined_data'), p) !== undefined) {
				curr = prop(prop(curr, 'self_defined_data'), p);
			} else if (prop(curr, 'profile_data') && prop(prop(curr, 'profile_data'), p) !== undefined) {
				curr = prop(prop(curr, 'profile_data'), p);
			} else {
				return undefined;
			}
		}
		return curr;
	}

	private _extractLinkValue(content: string, field: string): string {
		const match = content.match(new RegExp(`^-\\s*\\*\\*${field}\\*\\*:\\s*(.*)$`, 'm'));
		return match ? match[1].trim() : 'None';
	}

	private _splitList(str?: string): string[] {
		if (!str || str === 'None') { return []; }
		return str.split(',').map(s => s.trim()).filter(Boolean);
	}

	private async _syncTargetsLinkedBy(wsUri: URI, sourceIds: string[], targetIds: string[], op: 'add' | 'remove'): Promise<void> {
		for (const tId of targetIds) {
			const p = await this.resolveTicketPaths(wsUri, tId);
			if (!p) { continue; }
			let content = (await this.fileService.readFile(p.ticketMdUri)).value.toString();
			const current = this._extractLinkValue(content, 'Linked By');
			let list = this._splitList(current);

			if (op === 'add') {
				for (const sId of sourceIds) {
					if (!list.includes(sId)) { list.push(sId); }
				}
			} else {
				list = list.filter(id => !sourceIds.includes(id));
			}

			const finalStr = list.length > 0 ? list.join(', ') : 'None';
			content = content.replace(/^-\s*\*\*Linked By\*\*:\s*.*$/m, `- **Linked By**: ${finalStr}`);
			await this.fileService.writeFile(p.ticketMdUri, VSBuffer.fromString(content));
		}
	}

	private async _syncSourcesLinkTo(wsUri: URI, sourceIds: string[], targetIds: string[], op: 'add' | 'remove'): Promise<void> {
		for (const sId of sourceIds) {
			const p = await this.resolveTicketPaths(wsUri, sId);
			if (!p) { continue; }
			let content = (await this.fileService.readFile(p.ticketMdUri)).value.toString();
			const current = this._extractLinkValue(content, 'Link To');
			let list = this._splitList(current);

			if (op === 'add') {
				for (const tId of targetIds) {
					if (!list.includes(tId)) { list.push(tId); }
				}
			} else {
				list = list.filter(id => !targetIds.includes(id));
			}

			const finalStr = list.length > 0 ? list.join(', ') : 'None';
			content = content.replace(/^-\s*\*\*Link To\*\*:\s*.*$/m, `- **Link To**: ${finalStr}`);
			await this.fileService.writeFile(p.ticketMdUri, VSBuffer.fromString(content));
		}
	}

	private _flattenCustomValues(obj: Record<string, unknown>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj)) {
			out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
		}
		return out;
	}

	/**
	 * 6. anyagent_operate_ticket_table
	 * Structured AI interface for Data Table primitives & SQLite persistence
	 */
	public async operateTicketTable(options: IOperateTicketTableToolOptions) {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.ticket_id);
		if (!wsUri) {
			throw new Error(`Workspace '${options.workspace_id}' not found.`);
		}

		const paths = await this.resolveTicketPaths(wsUri, options.ticket_id, options.parent_path);
		if (!paths) {
			throw new Error(`Ticket '${options.ticket_id}' not found in workspace '${options.workspace_id}'.`);
		}

		let ticketContent = (await this.fileService.readFile(paths.ticketMdUri)).value.toString();
		const parsedTicket = this._parseTicketMd(ticketContent);

		const schema = await this._readTicketSchema(paths.folderUri, wsUri, paths.ticketType);

		const requestedField = (options.table_field || '').trim();
		if (!requestedField) {
			throw new Error(`'table_field' is required.`);
		}

		// Match the template's table component (by label or id, case-insensitively); its value is stored under the label
		const matchedSchemaField = findTemplateField(getTemplateFields(schema), requestedField, { type: 'table', ignoreCase: true });
		const matchedLabel = matchedSchemaField?.label && !matchedSchemaField.label.includes('/') ? matchedSchemaField.label : undefined;
		const canonicalKey = matchedLabel || requestedField;

		let existingRaw: unknown = parsedTicket.selfDefinedData?.[canonicalKey] ?? parsedTicket.selfDefinedData?.[requestedField];
		if (typeof existingRaw === 'string' && existingRaw.trim().startsWith('{')) {
			try {
				existingRaw = JSON.parse(existingRaw.trim());
			} catch { }
		}

		let columns: Array<{
			id: string;
			name: string;
			label?: string;
			dataType: string;
			primaryKey?: boolean;
			nullable?: boolean;
			defaultValue?: string;
		}> = [];
		let rows: Record<string, unknown>[] = [];
		let dbEngine: 'sqlite' | 'none' = matchedSchemaField?.tableDbEngine === 'none' ? 'none' : 'sqlite';
		let dbPath = '';
		let tableName = canonicalKey.toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'ticket_table';
		let autoSyncDb = Boolean(matchedSchemaField?.tableAutoSyncDb);
		let lastSynced = '';

		if (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)) {
			const existingObj = existingRaw as IJsonObject;
			if (Array.isArray(existingObj.columns)) { columns = existingObj.columns; }
			if (Array.isArray(existingObj.rows)) { rows = existingObj.rows; }
			if (existingObj.dbEngine) { dbEngine = existingObj.dbEngine === 'none' ? 'none' : 'sqlite'; }
			if (existingObj.dbPath !== undefined) { dbPath = String(existingObj.dbPath); }
			if (existingObj.tableName !== undefined) { tableName = String(existingObj.tableName); }
			if (existingObj.autoSyncDb !== undefined) { autoSyncDb = Boolean(existingObj.autoSyncDb); }
			if (existingObj.lastSynced) { lastSynced = String(existingObj.lastSynced); }
		} else if (Array.isArray(existingRaw)) {
			rows = existingRaw;
		}

		if (columns.length === 0 && Array.isArray(matchedSchemaField?.tableColumns) && matchedSchemaField.tableColumns.length > 0) {
			columns = JSON.parse(JSON.stringify(matchedSchemaField.tableColumns));
		}
		if (!dbPath && matchedSchemaField?.tableDbPath) {
			dbPath = String(matchedSchemaField.tableDbPath);
		}
		if (rows.length === 0 && !dbPath && Array.isArray(matchedSchemaField?.tableRows) && matchedSchemaField.tableRows.length > 0 && !existingRaw) {
			rows = JSON.parse(JSON.stringify(matchedSchemaField.tableRows));
		}
		if (matchedSchemaField?.tableDbTableName && (!existingRaw || !(existingRaw as IJsonObject).tableName)) {
			tableName = String(matchedSchemaField.tableDbTableName);
		}
		if (columns.length === 0) {
			columns = [
				{ id: 'col_1', name: 'id', label: 'id', dataType: 'INTEGER', primaryKey: true, nullable: false },
				{ id: 'col_2', name: 'name', label: 'name', dataType: 'TEXT', primaryKey: false, nullable: true }
			];
		}

		if (options.db_path !== undefined) {
			dbPath = String(options.db_path).trim();
		}
		if (options.db_table_name !== undefined && String(options.db_table_name).trim()) {
			tableName = String(options.db_table_name).trim().replace(/[^a-zA-Z0-9_]/g, '_');
		}
		if (options.auto_sync_db !== undefined) {
			autoSyncDb = Boolean(options.auto_sync_db);
		}

		const op = options.operation;
		if (op === 'get_table') {
			return {
				ticket_id: paths.ticketId,
				table_field: canonicalKey,
				columns,
				rows,
				row_count: rows.length,
				db_engine: dbEngine,
				db_path: dbPath,
				db_table_name: tableName,
				auto_sync_db: autoSyncDb,
				last_synced: lastSynced
			};
		}

		const ensureColumnsForRow = (rowObj: Record<string, unknown>) => {
			if (!rowObj || typeof rowObj !== 'object') { return; }
			for (const k of Object.keys(rowObj)) {
				if (!columns.some(c => c.name.toLowerCase() === k.toLowerCase())) {
					columns.push({
						id: `col_${Date.now()}_${columns.length + 1}`,
						name: k,
						label: k,
						dataType: 'TEXT',
						primaryKey: false,
						nullable: true
					});
				}
			}
		};

		let operationSummary = '';
		let sqliteResult: ISqliteTableOperationResult | undefined = undefined;

		if (op === 'define_columns') {
			if (!Array.isArray(options.columns) || options.columns.length === 0) {
				throw new Error(`'columns' array is required for operation 'define_columns'.`);
			}
			columns = options.columns.map((c, idx) => ({
				id: `col_${Date.now()}_${idx + 1}`,
				name: String(c.name || `col_${idx + 1}`).trim(),
				label: String(c.name || `col_${idx + 1}`).trim(),
				dataType: String(c.dataType || 'TEXT').trim().toUpperCase(),
				primaryKey: Boolean(c.primaryKey),
				nullable: c.nullable !== false,
				defaultValue: c.defaultValue !== undefined ? String(c.defaultValue) : undefined
			}));
			operationSummary = `Defined ${columns.length} column(s) for table '${canonicalKey}'.`;
		} else if (op === 'insert_rows') {
			const toInsert = Array.isArray(options.rows) ? options.rows : [];
			toInsert.forEach(r => {
				if (r && typeof r === 'object') {
					ensureColumnsForRow(r);
					rows.push({ ...r });
				}
			});
			operationSummary = `Inserted ${toInsert.length} row(s) into table '${canonicalKey}' (total: ${rows.length}).`;
		} else if (op === 'set_rows') {
			const nextRows = Array.isArray(options.rows) ? options.rows : [];
			if (Array.isArray(options.columns) && options.columns.length > 0) {
				columns = options.columns.map((c, idx) => ({
					id: `col_${Date.now()}_${idx + 1}`,
					name: String(c.name || `col_${idx + 1}`).trim(),
					label: String(c.name || `col_${idx + 1}`).trim(),
					dataType: String(c.dataType || 'TEXT').trim().toUpperCase(),
					primaryKey: Boolean(c.primaryKey),
					nullable: c.nullable !== false,
					defaultValue: c.defaultValue !== undefined ? String(c.defaultValue) : undefined
				}));
			}
			nextRows.forEach(r => ensureColumnsForRow(r));
			rows = nextRows.map(r => ({ ...r }));
			operationSummary = `Set ${rows.length} row(s) in table '${canonicalKey}'.`;
		} else if (op === 'update_rows') {
			const incoming = Array.isArray(options.rows) ? options.rows : [];
			const pkCols = columns.filter(c => c.primaryKey).map(c => c.name);
			let updatedCount = 0;
			if (options.match_column && options.match_value !== undefined && incoming.length > 0) {
				const patch = incoming[0];
				ensureColumnsForRow(patch);
				rows = rows.map(r => {
					if (r && String(r[options.match_column!]) === String(options.match_value)) {
						updatedCount++;
						return { ...r, ...patch };
					}
					return r;
				});
			} else if (pkCols.length > 0 && incoming.length > 0) {
				for (const item of incoming) {
					if (!item || typeof item !== 'object') { continue; }
					ensureColumnsForRow(item);
					const hasAllPkValues = pkCols.every(pk => item[pk] !== undefined);
					if (hasAllPkValues) {
						const existingIdx = rows.findIndex(r => r && pkCols.every(pk => String(r[pk]) === String(item[pk])));
						if (existingIdx >= 0) {
							rows[existingIdx] = { ...rows[existingIdx], ...item };
							updatedCount++;
						} else {
							rows.push({ ...item });
							updatedCount++;
						}
					} else {
						rows.push({ ...item });
						updatedCount++;
					}
				}
			} else if (Array.isArray(options.row_indices) && incoming.length > 0) {
				options.row_indices.forEach((rIdx, i) => {
					const patch = incoming[i] || incoming[0];
					if (rIdx >= 0 && rIdx < rows.length && patch) {
						ensureColumnsForRow(patch);
						rows[rIdx] = { ...rows[rIdx], ...patch };
						updatedCount++;
					}
				});
			}
			operationSummary = `Updated ${updatedCount} row(s) in table '${canonicalKey}'.`;
		} else if (op === 'delete_rows') {
			const beforeLen = rows.length;
			if (Array.isArray(options.row_indices) && options.row_indices.length > 0) {
				const idxSet = new Set(options.row_indices);
				rows = rows.filter((_, idx) => !idxSet.has(idx));
			} else if (options.match_column && options.match_value !== undefined) {
				rows = rows.filter(r => !r || String(r[options.match_column!]) !== String(options.match_value));
			}
			const deletedCount = beforeLen - rows.length;
			operationSummary = `Deleted ${deletedCount} row(s) from table '${canonicalKey}' (remaining: ${rows.length}).`;
		} else if (op === 'clear_rows') {
			rows = [];
			operationSummary = `Cleared all rows from table '${canonicalKey}'.`;
		} else if (op === 'bind_sqlite') {
			dbEngine = 'sqlite';
			operationSummary = `Bound table '${canonicalKey}' to SQLite file '${dbPath}' (table: '${tableName}').`;
		}

		// Execute SQLite operation if requested. Edits of a table bound to SQLite always go to the database too
		// (unless the caller explicitly passes sync_sqlite: false); there is no separate switch for this any more.
		const isExplicitSqliteOp = op === 'save_to_sqlite' || op === 'update_in_sqlite' || op === 'load_from_sqlite' || op === 'delete_from_sqlite' || op === 'sql_query';
		const shouldAutoSync = options.sync_sqlite !== false && dbEngine === 'sqlite' && Boolean(dbPath.trim()) && ['define_columns', 'insert_rows', 'set_rows', 'update_rows', 'bind_sqlite'].includes(op);

		if (isExplicitSqliteOp || shouldAutoSync) {
			const runtime = this.instantiationService.invokeFunction(accessor => {
				try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
			});
			if (!runtime) {
				if (isExplicitSqliteOp) {
					throw new Error('TicketWorkflowRuntimeService is unavailable for SQLite execution.');
				}
			} else {
				let sqliteAction: 'save' | 'update' | 'insert' | 'update_header' | 'inspect_schema' | 'load' | 'delete_data' | 'query' = 'update';
				let rowsForSqlite = rows;
				if (op === 'save_to_sqlite' || op === 'set_rows') {
					sqliteAction = 'save';
				} else if (op === 'insert_rows') {
					sqliteAction = 'insert';
					rowsForSqlite = Array.isArray(options.rows) ? options.rows.filter(r => r && typeof r === 'object') : [];
				} else if (op === 'define_columns') {
					sqliteAction = 'update_header';
				} else if (op === 'bind_sqlite') {
					sqliteAction = 'inspect_schema';
				} else if (op === 'update_in_sqlite' || op === 'update_rows') {
					sqliteAction = 'update';
				} else if (op === 'load_from_sqlite') {
					sqliteAction = 'load';
				} else if (op === 'delete_from_sqlite') {
					sqliteAction = 'delete_data';
				} else if (op === 'sql_query') {
					sqliteAction = 'query';
				}

				const sqRes = await runtime.executeSqliteTableOperation({
					workspaceUri: wsUri,
					workingDirUri: paths.folderUri,
					dbPath,
					tableName,
					action: sqliteAction,
					columns,
					rows: rowsForSqlite,
					sqlQuery: options.sql_query
				});
				sqliteResult = sqRes;

				if (!sqRes.success && isExplicitSqliteOp) {
					throw new Error(sqRes.error || `SQLite operation '${op}' failed.`);
				}
				if (sqRes.success) {
					if (op === 'load_from_sqlite') {
						if (Array.isArray(sqRes.columns) && sqRes.columns.length > 0) {
							columns = sqRes.columns;
						}
						if (Array.isArray(sqRes.rows)) {
							rows = sqRes.rows;
						}
					} else if (op === 'delete_from_sqlite') {
						rows = [];
					} else if (Array.isArray(sqRes.rows) && (op === 'save_to_sqlite' || op === 'update_in_sqlite')) {
						rows = sqRes.rows;
					}
					lastSynced = new Date().toISOString();
					if (!operationSummary) {
						operationSummary = sqRes.message || `Executed SQLite operation '${op}' on '${tableName}'.`;
					}
				}
			}
		}

		const updatedTablePayload = {
			columns,
			rows,
			dbEngine,
			dbPath,
			tableName,
			autoSyncDb,
			lastSynced
		};

		ticketContent = this._applyCustomUpdate(ticketContent, canonicalKey, updatedTablePayload);
		await this.fileService.writeFile(paths.ticketMdUri, VSBuffer.fromString(ticketContent));

		if (options.worklog_record) {
			await this.appendWorklog(paths.worklogMdUri, options.worklog_record);
		}

		return {
			success: true,
			ticket_id: paths.ticketId,
			table_field: canonicalKey,
			operation: op,
			summary: operationSummary,
			columns,
			rows,
			row_count: rows.length,
			db_engine: dbEngine,
			db_path: dbPath,
			db_table_name: tableName,
			sqlite_result: sqliteResult
		};
	}
}
