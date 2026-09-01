/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspacesExplorerService } from '../../common/workspacesExplorer.js';
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
	worklog_record: IWorklogRecord;
}

export interface IUpdateTicketToolOptions {
	workspace_id: string;
	ticket_id: string;
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
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService
	) { }

	/**
	 * Find the workspace root URI from workspace_id or active workspaces
	 */
	public async findWorkspaceUri(workspaceId: string): Promise<URI | undefined> {
		const workspaces = await this.workspacesExplorerService.getWorkspaces();
		if (!workspaces || workspaces.length === 0) return undefined;

		const target = workspaces.find(w => {
			const wCode = w.code || '';
			const wId = w.id || '';
			const wName = w.name || '';
			return wCode === workspaceId ||
				wId === workspaceId ||
				wName === workspaceId ||
				`${wCode}-0000` === workspaceId;
		});

		if (target) return target.uri;

		// Fallback to active workspace if workspaceId is default/current
		const current = workspaces.find(w => w.isCurrent) || workspaces[0];
		return current?.uri;
	}

	/**
	 * Find ticket folder by ticket_id under workspace
	 */
	public async resolveTicketPaths(workspaceUri: URI, ticketId: string): Promise<ITicketResolvedPaths | undefined> {
		// 1. Check if target is workspace root itself
		const wsTicketPaths = await this._checkFolderForTicketPaths(workspaceUri);
		if (wsTicketPaths && (wsTicketPaths.ticketId === ticketId || ticketId === 'root' || ticketId === '/' || wsTicketPaths.workspaceId === ticketId)) {
			return wsTicketPaths;
		}

		// 2. Scan children recursively
		const children = await this.workspacesExplorerService.scanWorkspaceChildren(workspaceUri, true);
		const found = this._findChildRecursively(children, ticketId);
		if (found) {
			const paths = await this._checkFolderForTicketPaths(found.uri);
			if (paths) return paths;
		}

		// 3. Fallback direct folder check
		const directUri = URI.joinPath(workspaceUri, ticketId);
		if (await this.fileService.exists(directUri)) {
			const paths = await this._checkFolderForTicketPaths(directUri);
			if (paths) return paths;
		}

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

	private async _checkFolderForTicketPaths(folderUri: URI): Promise<ITicketResolvedPaths | undefined> {
		const agentsDir = URI.joinPath(folderUri, '.agents');
		let ticketMdUri = URI.joinPath(agentsDir, 'ticket.md');
		if (!await this.fileService.exists(ticketMdUri)) {
			ticketMdUri = URI.joinPath(folderUri, 'ticket.md');
			if (!await this.fileService.exists(ticketMdUri)) {
				return undefined;
			}
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
		const wsMatch = content.match(/^-\s*\*\*Workspace ID\*\*:\s*(.+)$/m);
		const idMatch = content.match(/^-\s*\*\*Ticket ID\*\*:\s*(.+)$/m);
		const typeMatch = content.match(/^-\s*\*\*Ticket Type\*\*:\s*(.+)$/m);

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
	 * 1. anyagent_get_ticket_data
	 */
	public async getTicketData(workspaceId: string, ticketId: string, fieldPath?: string): Promise<any> {
		const wsUri = await this.findWorkspaceUri(workspaceId);
		if (!wsUri) throw new Error(`Workspace '${workspaceId}' not found.`);

		const paths = await this.resolveTicketPaths(wsUri, ticketId);
		if (!paths) throw new Error(`Ticket '${ticketId}' not found in workspace '${workspaceId}'.`);

		// Read files
		const ticketContent = (await this.fileService.readFile(paths.ticketMdUri)).value.toString();
		const readmeContent = await this._safeRead(paths.readmeMdUri);
		const instructionContent = await this._safeRead(paths.instructionMdUri);

		// Get workspace statuses & mapping
		const wsStatuses = await this.workspacesExplorerService.getWorkspaceStatuses(paths.folderUri);

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
		if (options.parent_path && options.parent_path !== '/' && options.parent_path !== 'root') {
			const rel = options.parent_path.startsWith('/') ? options.parent_path.slice(1) : options.parent_path;
			parentFolderUri = URI.joinPath(wsUri, rel);
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
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

		const paths = await this.resolveTicketPaths(wsUri, options.ticket_id);
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
		const ticketData = await this.getTicketData(options.workspace_id, options.ticket_id);
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
			await this.appendWorklog(paths.worklogMdUri, options.worklog_record);
		}

		return {
			success: true,
			removed_ticket_id: options.ticket_id,
			status_set_to: removedStatusName,
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
					collectedIds.push(child.name || child.id);
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
		const wsUri = await this.findWorkspaceUri(options.workspace_id);
		if (!wsUri) throw new Error(`Workspace '${options.workspace_id}' not found.`);

		const paths = await this.resolveTicketPaths(wsUri, options.ticket_id);
		if (!paths) throw new Error(`Ticket '${options.ticket_id}' not found.`);

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
			// 7. Dynamic Custom Cards & Attributes (/Custom/...)
			else if (path.startsWith('/Custom/') || path.startsWith('Custom/')) {
				const cleanPath = path.replace(/^\/?Custom\//, '');
				ticketContent = this._applyCustomUpdate(ticketContent, cleanPath, rawVal);
				ticketModified = true;
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

		// 1. /Custom/<key>/add -> Add dynamic card
		if (parts.length === 2 && parts[1] === 'add' && val && typeof val === 'object') {
			const listKey = parts[0];
			const cardKey = val.key || val.name || val.title || `Item ${Date.now()}`;
			let newCardBlock = `  - **${cardKey}**:\n`;
			for (const [subK, subV] of Object.entries(val)) {
				if (subK === 'key') continue;
				newCardBlock += `    - **${subK}**: ${subV}\n`;
			}

			// Find listKey in Self Defined Data Value
			const listRegex = new RegExp(`(  - \\*\\*${listKey}\\*\\*:\\n)([\\s\\S]*?)(?=(\\n  - \\*\\*|\\n\\n|\\n###|$))`);
			if (listRegex.test(content)) {
				content = content.replace(listRegex, `$1$2${newCardBlock}`);
			} else {
				// Insert new listKey
				content = content.replace(/(### Self Defined Data Value:\n)/, `$1  - **${listKey}**:\n${newCardBlock}`);
			}
			return content;
		}

		// 2. /Custom/<key>/<cardKey>/<attr> -> Update specific attribute of card
		if (parts.length === 3) {
			const [, cardKey, attr] = parts;
			const attrRegex = new RegExp(`(  - \\*\\*${cardKey}\\*\\*:[\\s\\S]*?    - \\*\\*${attr}\\*\\*:).*$`, 'm');
			if (attrRegex.test(content)) {
				content = content.replace(attrRegex, `$1 ${val}`);
			}
			return content;
		}

		// 3. /Custom/<key>/<cardKey>: null -> Delete card
		if (parts.length === 2 && (val === null || val === undefined)) {
			const [, cardKey] = parts;
			const cardRegex = new RegExp(`\\n?    - \\*\\*${cardKey}\\*\\*:[\\s\\S]*?(?=(\\n    - \\*\\*|\\n  - \\*\\*|\\n###|$))`, 'g');
			content = content.replace(cardRegex, '');
			return content;
		}

		// 4. /Custom/<key>: val -> Flat custom property
		if (parts.length === 1) {
			const key = parts[0];
			const propRegex = new RegExp(`^  - \\*\\*${key}\\*\\*:.*$`, 'm');
			if (val === null || val === undefined) {
				content = content.replace(propRegex, '');
			} else if (propRegex.test(content)) {
				content = content.replace(propRegex, `  - **${key}**: ${val}`);
			} else {
				content = content.replace(/(### Self Defined Data Value:\n)/, `$1  - **${key}**: ${val}\n`);
			}
			return content;
		}

		return content;
	}

	private _extractFieldByPath(data: any, path: string): any {
		const clean = path.startsWith('/') ? path.slice(1) : path;
		const parts = clean.split('/');
		let curr = data;
		for (const p of parts) {
			if (curr === undefined || curr === null) return undefined;
			if (curr[p] !== undefined) {
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
