/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspacesExplorerService } from '../../common/workspacesExplorer.js';
import { IAgentsManagerService } from '../../../agentsManager/common/agentsManager.js';
import { parse as parseYaml } from '../../../../../base/common/yaml.js';

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
	custom_values?: Record<string, any>;
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
	updates: Record<string, any>;
	worklog_record: IWorklogRecord;
}

export interface IManageLinksToolOptions {
	workspace_id: string;
	source_ticket_ids: string[];
	action: 'add_links' | 'remove_links' | 'set_links';
	target_ticket_ids: string[];
	worklog_record: IWorklogRecord;
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
		@IAgentsManagerService private readonly agentsManagerService: IAgentsManagerService
	) { }

	/**
	 * Find the workspace root URI from workspace_id or active workspaces with smart matching
	 */
	public async findWorkspaceUri(workspaceId?: string, ticketId?: string): Promise<URI | undefined> {
		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		if (!workspaces || workspaces.length === 0) return undefined;

		// 0. Ensure workspaces have their code populated if missing
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
					if (matchByPrefix) return matchByPrefix.uri;
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

		if (target) return target.uri;

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

		if (target) return target.uri;

		// 4. Substring / Prefix match
		target = workspaces.find(w => {
			const normCode = (w.code || '').toLowerCase().replace(/[\s_\-]+/g, '');
			const normName = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
			return (normId.length >= 3 && normName.includes(normId)) ||
				(normName.length >= 3 && normId.includes(normName)) ||
				(normCode.length >= 2 && normId.startsWith(normCode)) ||
				(normCode.length >= 2 && cleanCodeFromWsId.startsWith(normCode));
		});

		if (target) return target.uri;

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
				if (target) return target.uri;
			}
		}

		if (cleanCodeFromWsId && cleanCodeFromWsId.length >= 3) {
			target = workspaces.find(w => {
				const n = (w.name || '').toLowerCase().replace(/[\s_\-]+/g, '');
				return n.startsWith(cleanCodeFromWsId) || (cleanCodeFromWsId.length >= 3 && n.startsWith(cleanCodeFromWsId.slice(0, 3))) || (n.length >= 3 && cleanCodeFromWsId.startsWith(n.slice(0, 3)));
			});
			if (target) return target.uri;
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
			if (target) return target.uri;
		}

		// 6. Fuzzy Levenshtein Distance match (for acoustic / typo tolerance)
		const levenshtein = (a: string, b: string): number => {
			const matrix: number[][] = [];
			for (let i = 0; i <= b.length; i++) matrix[i] = [i];
			for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
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

		// 6.5 If ticketId is provided, scan all workspaces to see which one physically contains this ticket
		if (ticketId) {
			for (const w of workspaces) {
				try {
					const found = await this.resolveTicketPaths(w.uri, ticketId);
					if (found) {
						return w.uri;
					}
				} catch { }
			}
		}

		// 7. SAFETY: DO NOT silently fall back to workspaces[0]!
		// Throw an informative error listing all available workspaces so AI and user know exactly what exists
		const availableList = workspaces.map(w => `"${w.name}" (Code: ${w.code || 'N/A'})${w.isCurrent ? ' [Active]' : ''}`).join(', ');
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
				if (paths) return paths;
			}
		}

		// 2. If ticketIdOrPath contains slashes (e.g. '/FNDJ1-0006/FNDJ1-0001' or 'FNDJ1-0006/FNDJ1-0001')
		if (ticketIdOrPath.includes('/')) {
			const cleanPath = ticketIdOrPath.startsWith('/') ? ticketIdOrPath.slice(1) : ticketIdOrPath;
			const directPathUri = URI.joinPath(workspaceUri, cleanPath);
			if (await this.fileService.exists(directPathUri)) {
				const paths = await this._checkFolderForTicketPaths(directPathUri);
				if (paths) return paths;
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
				if (paths) return paths;
			}
		}

		// 5. Direct folder check at root
		const directUri = URI.joinPath(workspaceUri, ticketIdOrPath);
		if (await this.fileService.exists(directUri)) {
			const paths = await this._checkFolderForTicketPaths(directUri);
			if (paths) return paths;
		}

		// 6. Recursive deep search across nested folders
		const deepUri = await this._findTicketFolderDeep(workspaceUri, ticketIdOrPath);
		if (deepUri) {
			const paths = await this._checkFolderForTicketPaths(deepUri);
			if (paths) return paths;
		}

		// 7. Fallback to explorer children scan
		const children = await this.workspacesExplorerService.scanWorkspaceChildren(workspaceUri, true);
		const found = this._findChildRecursively(children, ticketIdOrPath);
		if (found) {
			const paths = await this._checkFolderForTicketPaths(found.uri);
			if (paths) return paths;
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
					if (paths) return paths;
				}
			} catch {}
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
			if (depth > 6) return;
			const fsPath = dirUri.fsPath;
			if (visitedFolders.has(fsPath)) return;
			visitedFolders.add(fsPath);

			try {
				const stat = await this.fileService.resolve(dirUri);
				if (!stat.children) return;

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
							if (parsed.title) title = parsed.title;
						} catch {}

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
			} catch {}
		};

		await scanDir(workspaceUri, 0);
		return results;
	}

	private async _resolveTicketFuzzyOrSequence(workspaceUri: URI, ticketIdOrPath: string): Promise<ITicketResolvedPaths | undefined> {
		const cleanInput = ticketIdOrPath.trim().replace(/^[/\\]+/, '');
		if (!cleanInput) return undefined;

		const allTickets = await this._collectAllWorkspaceTickets(workspaceUri);
		if (allTickets.length === 0) return undefined;

		const normInput = cleanInput.toLowerCase().replace(/[\s_\-]+/g, '');

		// Case 1: Type + Sequence Number (e.g. "job 0001", "job-0001", "job 1", "task 0002", "job0001")
		const typeSeqMatch = cleanInput.match(/^(job|task|note|workflow|project|case|agent|issue|analysis)[\s_\-]*0*(\d+)$/i);
		if (typeSeqMatch) {
			const targetType = typeSeqMatch[1].toLowerCase();
			const targetSeq = parseInt(typeSeqMatch[2], 10);
			const matched = allTickets.find(t =>
				t.ticketType.toLowerCase() === targetType && t.seqNumber === targetSeq
			);
			if (matched) return matched.paths;

			// Fallback: If type doesn't strictly match but seqNumber matches and there's only one
			const seqMatches = allTickets.filter(t => t.seqNumber === targetSeq);
			if (seqMatches.length === 1) return seqMatches[0].paths;
		}

		// Case 2: Pure sequence number (e.g. "0001", "1", "-0001", "#1")
		const pureSeqMatch = cleanInput.match(/^#?[_\-]?0*(\d+)$/);
		if (pureSeqMatch) {
			const targetSeq = parseInt(pureSeqMatch[1], 10);
			const seqMatches = allTickets.filter(t => t.seqNumber === targetSeq);
			if (seqMatches.length === 1) return seqMatches[0].paths;
			if (seqMatches.length > 1) {
				// Prefer top-level or job type
				const jobMatch = seqMatches.find(t => t.ticketType.toLowerCase() === 'job');
				if (jobMatch) return jobMatch.paths;
				return seqMatches[0].paths;
			}
		}

		// Case 3: Normalized ticket ID (e.g. "neowo0001", "neowo-1")
		const idMatch = allTickets.find(t => {
			const normTid = t.ticketId.toLowerCase().replace(/[\s_\-]+/g, '');
			return normTid === normInput;
		});
		if (idMatch) return idMatch.paths;

		// Case 4: Title match (exact or substring)
		const titleMatch = allTickets.find(t =>
			t.title.toLowerCase() === cleanInput.toLowerCase() ||
			(cleanInput.length >= 4 && t.title.toLowerCase().includes(cleanInput.toLowerCase()))
		);
		if (titleMatch) return titleMatch.paths;

		return undefined;
	}

	private async _findTicketFolderDeep(baseUri: URI, ticketId: string, currentDepth: number = 0, maxDepth: number = 6): Promise<URI | undefined> {
		if (currentDepth >= maxDepth) return undefined;
		try {
			const stat = await this.fileService.resolve(baseUri);
			if (!stat.children) return undefined;

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
				if (found) return found;
			}
		} catch {}
		return undefined;
	}

	private _findChildRecursively(children: any[], ticketId: string): any | undefined {
		for (const child of children) {
			if (child.id === ticketId || child.name === ticketId || child.code === ticketId) {
				return child;
			}
			if (child.children && child.children.length > 0) {
				const nested = this._findChildRecursively(child.children, ticketId);
				if (nested) return nested;
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
			if (!stat.children) return results;

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
		} catch {}

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
		let typeMatch = content.match(/^-\s*\*\*(?:Ticket Type|Entity Type)\*\*:\s*(.+)$/m);

		// Fallback to instruction.md or README.md if not in ticket.md
		if ((!wsMatch || !idMatch) && await this.fileService.exists(instructionMdUri)) {
			const instContent = (await this.fileService.readFile(instructionMdUri)).value.toString();
			if (!wsMatch) wsMatch = instContent.match(/^-\s*\*\*Workspace ID\*\*:\s*(.+)$/m);
			if (!idMatch) idMatch = instContent.match(/^-\s*\*\*Ticket ID\*\*:\s*(.+)$/m);
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
			if (t === 'job') return '🚀';
			if (t === 'task') return '📋';
			if (t === 'workflow') return '⚡';
			if (t === 'case') return '📦';
			if (t === 'note') return '📝';
			if (t === 'agent') return '🤖';
			if (t === 'issue') return '🐞';
			if (t === 'analysis') return '📊';
			return '📄';
		};

		const getDirectSubTickets = async (folderUri: URI): Promise<Array<{ paths: ITicketResolvedPaths; title: string; status: string }>> => {
			const items: Array<{ paths: ITicketResolvedPaths; title: string; status: string }> = [];
			try {
				const stat = await this.fileService.resolve(folderUri);
				if (!stat.children) return items;
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
							if (parsedR.title) title = parsedR.title;
						} catch {}
						try {
							const ticket = await this._safeRead(paths.ticketMdUri);
							const parsedT = this._parseTicketMd(ticket);
							if (parsedT.status) status = parsedT.status;
						} catch {}

						items.push({ paths, title, status });
					}
				}
			} catch {}
			return items;
		};

		const renderBranch = async (dirUri: URI, prefix: string, depth: number): Promise<string[]> => {
			const lines: string[] = [];
			const subTickets = await getDirectSubTickets(dirUri);
			if (subTickets.length === 0) return lines;

			for (let i = 0; i < subTickets.length; i++) {
				const item = subTickets[i];
				const isLast = (i === subTickets.length - 1);
				const pointer = isLast ? '└── ' : '├── ';
				const nextPrefix = prefix + (isLast ? '    ' : '│   ');

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
	public async queryWorkspaceTree(options: { workspace_id: string; parent_ticket_id?: string; query?: string; max_depth?: number }): Promise<any> {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.parent_ticket_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

		let baseUri = wsUri;
		let targetParentId = options.parent_ticket_id;
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
	public async getTicketData(workspaceId: string, ticketId: string, fieldPath?: string, parentPath?: string): Promise<any> {
		const wsUri = await this.findWorkspaceUri(workspaceId, ticketId);
		if (!wsUri) throw new Error(`Workspace '${workspaceId}' not found.`);

		const paths = await this.resolveTicketPaths(wsUri, ticketId, parentPath);
		if (!paths) throw new Error(`Ticket '${ticketId}' not found in workspace '${workspaceId}'.`);

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

		// Try load type schema YAML if any
		let schemaDefinition: any = null;
		const typeYamlUri = URI.joinPath(wsUri, '.agents', 'entity_type', `${paths.ticketType}.yaml`);
		if (await this.fileService.exists(typeYamlUri)) {
			try {
				const yamlStr = (await this.fileService.readFile(typeYamlUri)).value.toString();
				schemaDefinition = parseYaml(yamlStr);
			} catch {}
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
			self_defined_data: parsedTicket.selfDefinedData,
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

		if (!fieldPath || fieldPath === '/' || fieldPath === '') {
			return fullData;
		}

		// Field-specific query
		return this._extractFieldByPath(fullData, fieldPath);
	}

	/**
	 * 2. anyagent_create_ticket
	 */
	public async createTicket(options: ICreateTicketToolOptions): Promise<any> {
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

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

		// 4. Create resource
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
			customMetadata: options.custom_values ? this._flattenCustomValues(options.custom_values) : undefined
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
	public async deleteTicket(options: IDeleteTicketToolOptions): Promise<any> {
		const wsUri = await this.findWorkspaceUri(options.workspace_id, options.ticket_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

		const paths = await this.resolveTicketPaths(wsUri, options.ticket_id, options.parent_path);
		if (!paths) throw new Error(`Ticket '${options.ticket_id}' not found.`);

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
		const ticketData = await this.getTicketData(options.workspace_id, options.ticket_id, undefined, options.parent_path);
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
			} catch {}
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

	private async _cascadeMarkRemoved(children: any[], removedStatus: string, collectedIds: string[]): Promise<void> {
		for (const child of children) {
			if (child.uri && child.type !== 'file' && child.type !== 'folder') {
				try {
					await this.workspacesExplorerService.setEntityStatus(child.uri, removedStatus);
					await this.workspacesExplorerService.removeSnapshot(child.uri);
					if (child.name) collectedIds.push(child.name);
				} catch {}
			}
			if (child.children && child.children.length > 0) {
				await this._cascadeMarkRemoved(child.children, removedStatus, collectedIds);
			}
		}
	}

	/**
	 * 4. anyagent_update_ticket
	 */
	public async updateTicket(options: IUpdateTicketToolOptions): Promise<any> {
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
			} catch {}
		}

		if (!paths) {
			if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);
			throw new Error(`Ticket '${options.ticket_id}' not found.`);
		}

		let ticketContent = (await this.fileService.readFile(paths.ticketMdUri)).value.toString();
		let readmeContent = await this._safeRead(paths.readmeMdUri);
		let instructionContent = await this._safeRead(paths.instructionMdUri);

		let ticketModified = false;
		let readmeModified = false;
		let instructionModified = false;

		for (const [rawPath, rawVal] of Object.entries(options.updates)) {
			const path = rawPath.trim();

			// 1. Title
			if (path === '/Title' || path === 'Title' || path === '/README/Title') {
				if (rawVal) {
					readmeContent = readmeContent.replace(/^-\s*\*\*Title\*\*:\s*.*$/m, `- **Title**: ${rawVal}`);
					readmeModified = true;
				}
			}
			// 2. Description
			else if (path === '/Description' || path === 'Description' || path === '/README/Description') {
				const descVal = rawVal || 'None';
				readmeContent = readmeContent.replace(/^-\s*\*\*Description\*\*:\s*.*$/m, `- **Description**: ${descVal}`);
				readmeModified = true;
			}
			// 3. Status
			else if (path === '/Status' || path === '/Attributes/Status' || path === 'Status') {
				if (rawVal) {
					ticketContent = ticketContent.replace(/^-\s*\*\*Status\*\*:\s*.*$/m, `- **Status**: ${rawVal}`);
					ticketModified = true;
					// Synchronize through explorer service as well
					await this.workspacesExplorerService.setEntityStatus(paths.folderUri, rawVal);
				}
			}
			// 4. Priority
			else if (path === '/Priority' || path === '/Attributes/Priority' || path === 'Priority') {
				if (rawVal) {
					ticketContent = ticketContent.replace(/^-\s*\*\*Priority\*\*:\s*.*$/m, `- **Priority**: ${rawVal}`);
					ticketModified = true;
				}
			}
			// 5. Current AI Agent
			else if (path === '/Current AI Agent' || path === '/Attributes/Current AI Agent') {
				const agentVal = rawVal || 'None';
				ticketContent = ticketContent.replace(/^-\s*\*\*Current AI Agent\*\*:\s*.*$/m, `- **Current AI Agent**: ${agentVal}`);
				ticketModified = true;
			}
			// 6. Prompts in instruction.md
			else if (path === '/Instructions/Ticket Prompt' || path === '/Ticket Prompt') {
				const pVal = rawVal || 'None';
				instructionContent = instructionContent.replace(/^-\s*\*\*Ticket Prompt\*\*:\s*.*$/m, `- **Ticket Prompt**: ${pVal}`);
				instructionModified = true;
			}
			else if (path === '/Instructions/Ticket Type Prompt' || path === '/Ticket Type Prompt') {
				const pVal = rawVal || 'None';
				instructionContent = instructionContent.replace(/^-\s*\*\*Ticket Type Prompt\*\*:\s*.*$/m, `- **Ticket Type Prompt**: ${pVal}`);
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
				const cleanPath = path.replace(/^\/?Custom\//, '');
				ticketContent = this._applyCustomUpdate(ticketContent, cleanPath, rawVal);
				ticketModified = true;
			}
		}

		// 8. Auto-sync physical attachment files if any attachment fields or file objects were updated
		const filesToSync: string[] = [];
		for (const [k, v] of Object.entries(options.updates)) {
			if (k.toLowerCase().includes('attachment') || Array.isArray(v) || (typeof v === 'object' && v && ('name' in v))) {
				const items = Array.isArray(v) ? v : [v];
				for (const item of items) {
					if (item && typeof item === 'object' && item.name && typeof item.name === 'string') {
						filesToSync.push(item.name);
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
	public async manageLinks(options: IManageLinksToolOptions): Promise<any> {
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

		const involvedTicketPaths: ITicketResolvedPaths[] = [];

		for (const srcId of options.source_ticket_ids) {
			const srcPaths = await this.resolveTicketPaths(wsUri, srcId);
			if (!srcPaths) continue;
			involvedTicketPaths.push(srcPaths);

			let srcTicketContent = (await this.fileService.readFile(srcPaths.ticketMdUri)).value.toString();
			const currentLinkTo = this._extractLinkValue(srcTicketContent, 'Link To');
			let newLinkToList = this._splitList(currentLinkTo);

			if (options.action === 'add_links') {
				for (const targetId of options.target_ticket_ids) {
					if (!newLinkToList.includes(targetId)) newLinkToList.push(targetId);
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
			if (!targetPaths) continue;
			if (!involvedTicketPaths.some(p => p.ticketId === targetPaths.ticketId)) {
				involvedTicketPaths.push(targetPaths);
			}

			let targetTicketContent = (await this.fileService.readFile(targetPaths.ticketMdUri)).value.toString();
			const currentLinkedBy = this._extractLinkValue(targetTicketContent, 'Linked By');
			let newLinkedByList = this._splitList(currentLinkedBy);

			if (options.action === 'add_links' || options.action === 'set_links') {
				for (const srcId of options.source_ticket_ids) {
					if (!newLinkedByList.includes(srcId)) newLinkedByList.push(srcId);
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
	 * Append standard worklog record into worklog.md
	 */
	public async appendWorklog(worklogUri: URI, record: IWorklogRecord): Promise<void> {
		try {
			const fullLogDateTime = this._getFormattedDateTimeWithSecondsAndTz();
			let content = '';
			if (await this.fileService.exists(worklogUri)) {
				content = (await this.fileService.readFile(worklogUri)).value.toString();
			} else {
				content = `# Work Log\n\n---\n\n`;
			}

			let entry = `\n---\n\n## ${fullLogDateTime}\n\n`;
			entry += `- **Update Datetime**: ${fullLogDateTime}\n`;
			entry += `- **Update By**: AI Agent\n\n`;
			entry += `### User Request\n${record.user_request}\n\n`;
			entry += `### Update Summary\n${record.update_summary}\n\n`;
			entry += `### Update Details\n${record.update_details}\n\n`;
			entry += `### Update Conclusion\n${record.update_conclusion}\n\n`;
			entry += `### Commit\n`;
			if (record.commit && record.commit.commit_id && record.commit.commit_id !== 'None') {
				entry += `- **Repo**: ${record.commit.repo || 'None'}\n`;
				entry += `- **Branch**: ${record.commit.branch || 'None'}\n`;
				entry += `- **ID**: ${record.commit.commit_id}\n`;
				entry += `- **comment**: ${record.commit.comment || 'None'}\n`;
				entry += `- **committed by**: ${record.commit.committed_by || 'None'}\n`;
			} else {
				entry += `- **Repo**: None\n`;
				entry += `- **Branch**: None\n`;
				entry += `- **ID**: None\n`;
				entry += `- **comment**: None\n`;
				entry += `- **committed by**: None\n`;
			}

			content += entry;
			await this.fileService.writeFile(worklogUri, VSBuffer.fromString(content));
		} catch (err) {
			console.error('Failed to append worklog:', err);
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

	private _parseTicketMd(content: string): any {
		const result: any = {
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

	private _applyCustomUpdate(content: string, path: string, val: any): string {
		const parts = path.split('/').filter(Boolean);
		if (parts.length === 0) return content;

		// 1. /Custom/<key>/add -> Add items to list or dynamic card
		if (parts.length === 2 && parts[1] === 'add' && val !== undefined && val !== null) {
			const listKey = parts[0];
			const propRegex = new RegExp(`^(\\s*-\\s*\\*\\*${listKey}\\*\\*:)(.*)$`, 'm');
			const propMatch = content.match(propRegex);

			// Check if listKey is stored as a JSON array / flat line
			const isArrayOrAttachment = Array.isArray(val) || (typeof val === 'object' && ('name' in val || 'file' in val || 'uri' in val)) || (propMatch && propMatch[2].trim().startsWith('['));

			if (isArrayOrAttachment) {
				let existingArr: any[] = [];
				if (propMatch && propMatch[2].trim().startsWith('[')) {
					try { existingArr = JSON.parse(propMatch[2].trim()); } catch { }
					if (!Array.isArray(existingArr)) existingArr = [];
				} else if (propMatch && propMatch[2].trim()) {
					existingArr = [{ name: propMatch[2].trim() }];
				}

				const itemsToAdd = Array.isArray(val) ? val : [val];
				for (const item of itemsToAdd) {
					const itemName = typeof item === 'object' && item ? (item.name || item.key || item.title || JSON.stringify(item)) : String(item);
					const exists = existingArr.some(e => {
						const eName = typeof e === 'object' && e ? (e.name || e.key || e.title || JSON.stringify(e)) : String(e);
						return eName === itemName;
					});
					if (!exists) {
						existingArr.push(item);
					}
				}

				const updatedJson = JSON.stringify(existingArr);
				if (propMatch) {
					content = content.replace(propRegex, `  - **${listKey}**: ${updatedJson}`);
				} else {
					if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
						content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, `$1\n  - **${listKey}**: ${updatedJson}`);
					} else if (/### Self Defined Data Value/m.test(content)) {
						content = content.replace(/(### Self Defined Data Value:?\n)/m, `$1  - **${listKey}**: ${updatedJson}\n`);
					} else {
						content += `\n  - **${listKey}**: ${updatedJson}\n`;
					}
				}
				return content;
			}

			// Otherwise, handle as markdown sub-card block
			const cardKey = val.key || val.name || val.title || `Item ${Date.now()}`;
			let newCardBlock = `  - **${cardKey}**:\n`;
			for (const [subK, subV] of Object.entries(val)) {
				if (subK === 'key') continue;
				newCardBlock += `    - **${subK}**: ${subV}\n`;
			}

			// Find listKey in Self Defined Data Value
			const listRegex = new RegExp(`(  - \\*\\*${listKey}\\*\\*:\\n?)([\\s\\S]*?)(?=(\\n  - \\*\\*|\\n\\n|\\n###|$))`);
			if (listRegex.test(content)) {
				content = content.replace(listRegex, `$1$2${newCardBlock}`);
			} else {
				if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
					content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, `$1\n  - **${listKey}**: ${newCardBlock}`);
				} else if (/### Self Defined Data Value/m.test(content)) {
					content = content.replace(/(### Self Defined Data Value:?\n)/m, `$1  - **${listKey}**: ${newCardBlock}`);
				}
			}
			return content;
		}

		// 2. /Custom/<key>/remove or /delete
		if (parts.length === 2 && (parts[1] === 'remove' || parts[1] === 'delete')) {
			const listKey = parts[0];
			const propRegex = new RegExp(`^(\\s*-\\s*\\*\\*${listKey}\\*\\*:)(.*)$`, 'm');
			const propMatch = content.match(propRegex);
			if (propMatch && propMatch[2].trim().startsWith('[')) {
				try {
					let arr = JSON.parse(propMatch[2].trim());
					if (Array.isArray(arr)) {
						const targetName = typeof val === 'object' && val ? (val.name || val.key || val.title) : String(val);
						arr = arr.filter(item => {
							const itemName = typeof item === 'object' && item ? (item.name || item.key || item.title) : String(item);
							return itemName !== targetName;
						});
						content = content.replace(propRegex, `  - **${listKey}**: ${JSON.stringify(arr)}`);
					}
				} catch { }
			}
			return content;
		}

		// 3. /Custom/<key>/<cardKey>/<attr> -> Update specific attribute of card
		if (parts.length === 3) {
			const [, cardKey, attr] = parts;
			const attrRegex = new RegExp(`(  - \\*\\*${cardKey}\\*\\*:[\\s\\S]*?    - \\*\\*${attr}\\*\\*:).*$`, 'm');
			if (attrRegex.test(content)) {
				content = content.replace(attrRegex, `$1 ${val}`);
			}
			return content;
		}

		// 4. /Custom/<key>/<cardKey>: null -> Delete card
		if (parts.length === 2 && (val === null || val === undefined)) {
			const [, cardKey] = parts;
			const cardRegex = new RegExp(`\\n?    - \\*\\*${cardKey}\\*\\*:[\\s\\S]*?(?=(\\n    - \\*\\*|\\n  - \\*\\*|\\n###|$))`, 'g');
			content = content.replace(cardRegex, '');
			return content;
		}

		// 5. /Custom/<key>: val -> Flat custom property or full array update
		if (parts.length === 1) {
			const key = parts[0];
			const propRegex = new RegExp(`^\\s*-\\s*\\*\\*${key}\\*\\*:.*$`, 'm');
			const valStr = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val ?? '');
			if (val === null || val === undefined) {
				content = content.replace(propRegex, '');
			} else if (propRegex.test(content)) {
				content = content.replace(propRegex, `  - **${key}**: ${valStr}`);
			} else {
				if (/^-\s*\*\*Self Defined Data Value\*\*:/m.test(content)) {
					content = content.replace(/(^-\s*\*\*Self Defined Data Value\**:)/m, `$1\n  - **${key}**: ${valStr}`);
				} else if (/### Self Defined Data Value/m.test(content)) {
					content = content.replace(/(### Self Defined Data Value:?\n)/m, `$1  - **${key}**: ${valStr}\n`);
				} else {
					content += `\n  - **${key}**: ${valStr}\n`;
				}
			}
			return content;
		}

		return content;
	}

	private _extractFieldByPath(data: any, path: string): any {
		let clean = path.startsWith('/') ? path.slice(1) : path;
		let curr = data;

		if (clean.startsWith('Custom/')) {
			clean = clean.slice('Custom/'.length);
			if (curr && curr.self_defined_data !== undefined) {
				curr = curr.self_defined_data;
			}
		} else if (clean.startsWith('Attributes/')) {
			clean = clean.slice('Attributes/'.length);
		} else if (clean.startsWith('Profile/')) {
			clean = clean.slice('Profile/'.length);
			if (curr && curr.profile_data !== undefined) {
				curr = curr.profile_data;
			}
		} else if (clean.startsWith('Instructions/')) {
			clean = clean.slice('Instructions/'.length);
			if (curr && curr.prompts !== undefined) {
				curr = curr.prompts;
			}
		}

		if (!clean) return curr;

		const parts = clean.split('/');
		for (const p of parts) {
			if (curr === undefined || curr === null) return undefined;
			if (typeof curr === 'string' && (curr.trim().startsWith('[') || curr.trim().startsWith('{'))) {
				try { curr = JSON.parse(curr); } catch { }
			}
			if (Array.isArray(curr) && /^\d+$/.test(p)) {
				const idx = parseInt(p, 10);
				curr = curr.find(item => item && (item._index === idx || item.id === p)) || curr[idx - 1] || curr[idx];
			} else if (curr[p] !== undefined) {
				curr = curr[p];
			} else if (curr.self_defined_data && curr.self_defined_data[p] !== undefined) {
				curr = curr.self_defined_data[p];
			} else if (curr.profile_data && curr.profile_data[p] !== undefined) {
				curr = curr.profile_data[p];
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
		if (!str || str === 'None') return [];
		return str.split(',').map(s => s.trim()).filter(Boolean);
	}

	private async _syncTargetsLinkedBy(wsUri: URI, sourceIds: string[], targetIds: string[], op: 'add' | 'remove'): Promise<void> {
		for (const tId of targetIds) {
			const p = await this.resolveTicketPaths(wsUri, tId);
			if (!p) continue;
			let content = (await this.fileService.readFile(p.ticketMdUri)).value.toString();
			const current = this._extractLinkValue(content, 'Linked By');
			let list = this._splitList(current);

			if (op === 'add') {
				for (const sId of sourceIds) {
					if (!list.includes(sId)) list.push(sId);
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
			if (!p) continue;
			let content = (await this.fileService.readFile(p.ticketMdUri)).value.toString();
			const current = this._extractLinkValue(content, 'Link To');
			let list = this._splitList(current);

			if (op === 'add') {
				for (const tId of targetIds) {
					if (!list.includes(tId)) list.push(tId);
				}
			} else {
				list = list.filter(id => !targetIds.includes(id));
			}

			const finalStr = list.length > 0 ? list.join(', ') : 'None';
			content = content.replace(/^-\s*\*\*Link To\*\*:\s*.*$/m, `- **Link To**: ${finalStr}`);
			await this.fileService.writeFile(p.ticketMdUri, VSBuffer.fromString(content));
		}
	}

	private _flattenCustomValues(obj: Record<string, any>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj)) {
			out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
		}
		return out;
	}
}
