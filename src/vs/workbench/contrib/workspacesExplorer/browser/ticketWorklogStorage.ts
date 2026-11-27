/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { replaceWorklogMdSummaryBlock, TICKET_CHANGE_ENTRY_KIND, ticketChangeCoalescer } from '../common/ticketChangeLog.js';

/**
 * Default size threshold for splitting large worklog files (512 KB)
 */
export const DEFAULT_WORKLOG_SPLIT_THRESHOLD_BYTES = 512 * 1024;

export interface IWorklogRecord {
	user_request?: string;
	update_summary?: string;
	update_details?: string;
	update_conclusion?: string;
	commit?: {
		repo?: string;
		branch?: string;
		commit_id?: string;
		comment?: string;
		committed_by?: string;
	};
	update_by?: string;
	/** Agent / workflow name of the actor, when known (front matter `actor_name`). */
	actor_name?: string;
	/** Kind of entry (front matter `entry_kind`), e.g. `field_changes` for automatically recorded field changes (CI-50). */
	entry_kind?: string;
	execution_status?: string;
	output_summary?: string;
	raw_content?: string;
}

export interface IWorklogEntryMeta {
	id: string; // Logical entry ID: "Ticket_{TicketID}_{Timestamp}"
	ticketId: string;
	timestamp: string; // Datetime string, e.g. "2026-11-17 11:45:00 -05:00"
	dateStamp: string; // Compact date: "20261117_114500"
	displayHeader: string; // "2026-11-17 11:45:00 -05:00" or "2026-11-17 16:16 - Workflow Execution"
	partFiles: string[]; // Ordered filenames of parts: ["Ticket_..._001.log", ...]
	totalParts: number;
	totalBytes: number;
	isSplit: boolean;
	updateBy: string;
	firstPartUri: URI;
}

export interface IWorklogEntry {
	meta: IWorklogEntryMeta;
	headerText: string;
	bodyText: string;
	fullContent: string;
}

export interface IWorklogPage {
	entries: IWorklogEntry[];
	totalCount: number;
	offset: number;
	limit: number;
	hasMore: boolean;
}

export interface ITicketStorageEnvironment {
	configDir: URI;
	worklogsDir: URI;
	ticketMdUri: URI;
	ticketsMdUri: URI;
	instructionMdUri: URI;
	readmeMdUri: URI;
	worklogMdUri: URI;
	ticketId: string;
	workspaceId: string;
	ticketType: string;
}

export class TicketWorklogStorage {

	private _splitThresholdBytes: number;

	constructor(
		private readonly fileService: IFileService,
		splitThresholdBytes: number = DEFAULT_WORKLOG_SPLIT_THRESHOLD_BYTES
	) {
		this._splitThresholdBytes = splitThresholdBytes;
	}

	public get splitThresholdBytes(): number {
		return this._splitThresholdBytes;
	}

	public set splitThresholdBytes(val: number) {
		if (val > 1024) {
			this._splitThresholdBytes = val;
		}
	}

	/**
	 * Resolves ticket configuration directories and ensures all 5 required Markdown files
	 * (ticket.md, instruction.md, README.md, worklog.md, tickets.md) and Worklogs/ directory exist.
	 */
	public async resolveAndEnsureTicketEnvironment(entityUri: URI): Promise<ITicketStorageEnvironment> {
		let configDir: URI;
		if (entityUri.path.endsWith('/.agents') || entityUri.path.endsWith('\\.agents')) {
			configDir = entityUri;
		} else {
			const candidate = URI.joinPath(entityUri, '.agents');
			if (await this.fileService.exists(candidate)) {
				configDir = candidate;
			} else {
				// If .agents folder does not exist yet, create it under entityUri
				await this.fileService.createFolder(candidate);
				configDir = candidate;
			}
		}

		const worklogsDir = URI.joinPath(configDir, 'Worklogs');
		if (!await this.fileService.exists(worklogsDir)) {
			await this.fileService.createFolder(worklogsDir);
		}

		const ticketMdUri = URI.joinPath(configDir, 'ticket.md');
		const ticketsMdUri = URI.joinPath(configDir, 'tickets.md');
		const instructionMdUri = URI.joinPath(configDir, 'instruction.md');
		const readmeMdUri = URI.joinPath(configDir, 'README.md');
		let worklogMdUri = URI.joinPath(configDir, 'worklog.md');

		// Check for alt work_log.md
		if (!await this.fileService.exists(worklogMdUri)) {
			const altWorklog = URI.joinPath(configDir, 'work_log.md');
			if (await this.fileService.exists(altWorklog)) {
				worklogMdUri = altWorklog;
			}
		}

		// Extract metadata if available
		let ticketId = entityUri.path.split('/').filter(Boolean).pop() || 'Unknown';
		if (ticketId === '.agents') {
			const parts = entityUri.path.split('/').filter(Boolean);
			ticketId = parts.length > 1 ? parts[parts.length - 2] : 'Unknown';
		}
		let workspaceId = 'None';
		let ticketType = 'task';

		if (await this.fileService.exists(ticketMdUri)) {
			try {
				const content = (await this.fileService.readFile(ticketMdUri)).value.toString();
				const idMatch = content.match(/^-\s*\*\*Ticket ID\*\*:\s*(.+)$/m);
				if (idMatch && idMatch[1].trim() && idMatch[1].trim() !== 'None') {
					ticketId = idMatch[1].trim();
				}
				const wsMatch = content.match(/^-\s*\*\*Workspace ID\*\*:\s*(.+)$/m);
				if (wsMatch && wsMatch[1].trim() && wsMatch[1].trim() !== 'None') {
					workspaceId = wsMatch[1].trim();
				}
				const typeMatch = content.match(/^-\s*\*\*(?:Ticket Type|Entity Type)\*\*:\s*(.+)$/m);
				if (typeMatch && typeMatch[1].trim()) {
					ticketType = typeMatch[1].trim();
				}
			} catch { }
		}

		// Ensure tickets.md exists (Preserve all 5 required Markdown files)
		if (!await this.fileService.exists(ticketsMdUri)) {
			const ticketsContent = `# Tickets - ${ticketId}\n\n## Overview\n\n- **Workspace ID**: ${workspaceId}\n- **Parent Ticket ID**: ${ticketId}\n- **Ticket Type**: ${ticketType}\n\n---\n\n## Sub Tickets\n\nNone\n`;
			await this.fileService.writeFile(ticketsMdUri, VSBuffer.fromString(ticketsContent));
		}

		// Ensure worklog.md exists with lightweight header if missing
		if (!await this.fileService.exists(worklogMdUri)) {
			const worklogHeader = `# Work Log - ${ticketId}\n\n## Overview\n\n- **Workspace ID**: ${workspaceId}\n- **Ticket ID**: ${ticketId}\n- **Ticket Type**: ${ticketType}\n- **Worklogs Directory**: [Worklogs](.agents/Worklogs)\n\n---\n\n`;
			await this.fileService.writeFile(worklogMdUri, VSBuffer.fromString(worklogHeader));
		}

		return {
			configDir,
			worklogsDir,
			ticketMdUri,
			ticketsMdUri,
			instructionMdUri,
			readmeMdUri,
			worklogMdUri,
			ticketId,
			workspaceId,
			ticketType
		};
	}

	/**
	 * Formats a Date object to YYYYMMDD_HHMMSS for log filenames
	 */
	public formatDateStamp(d: Date): string {
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		const hours = String(d.getHours()).padStart(2, '0');
		const mins = String(d.getMinutes()).padStart(2, '0');
		const secs = String(d.getSeconds()).padStart(2, '0');
		return `${year}${month}${day}_${hours}${mins}${secs}`;
	}

	/**
	 * Formats a Date object to full display string with timezone
	 */
	public formatFullDateTime(d: Date): string {
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		const hours = String(d.getHours()).padStart(2, '0');
		const mins = String(d.getMinutes()).padStart(2, '0');
		const secs = String(d.getSeconds()).padStart(2, '0');
		const tzOffset = -d.getTimezoneOffset();
		const sign = tzOffset >= 0 ? '+' : '-';
		const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
		const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${mins}:${secs} ${sign}${tzHours}:${tzMins}`;
	}

	/**
	 * Generates a standard log filename: Ticket_{TicketID}_{Timestamp}_{Sequence}.log
	 */
	public buildLogFilename(ticketId: string, dateStamp: string, sequence: number = 1): string {
		const cleanTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, '_');
		const seqStr = String(sequence).padStart(3, '0');
		return `Ticket_${cleanTicketId}_${dateStamp}_${seqStr}.log`;
	}

	/**
	 * Parses a standard log filename into its components
	 */
	public parseLogFilename(filename: string): { ticketId: string; dateStamp: string; sequence: number } | undefined {
		const match = filename.match(/^Ticket_(.+)_(\d{8}_\d{6})_(\d{3})\.log$/i);
		if (!match) {
			return undefined;
		}
		return {
			ticketId: match[1],
			dateStamp: match[2],
			sequence: parseInt(match[3], 10)
		};
	}

	/**
	 * Saves a worklog entry into the independent Worklogs/ directory.
	 * Automatically splits into sequential parts (_001.log, _002.log, etc.) if size exceeds split threshold.
	 * Also updates the main worklog.md with a lightweight summary.
	 */
	public async saveWorklog(entityUri: URI, record: IWorklogRecord, options?: { customDate?: Date; splitThresholdBytes?: number }): Promise<IWorklogEntry> {
		const env = await this.resolveAndEnsureTicketEnvironment(entityUri);
		const dateObj = options?.customDate || new Date();
		let dateStamp = this.formatDateStamp(dateObj);
		const fullDateTime = this.formatFullDateTime(dateObj);
		const threshold = options?.splitThresholdBytes || this._splitThresholdBytes;

		// Ensure collision resistance: if Ticket_{id}_{dateStamp}_001.log already exists, increment dateStamp
		let checkFilename = this.buildLogFilename(env.ticketId, dateStamp, 1);
		let attempts = 0;
		while (await this.fileService.exists(URI.joinPath(env.worklogsDir, checkFilename)) && attempts < 10) {
			dateObj.setSeconds(dateObj.getSeconds() + 1);
			dateStamp = this.formatDateStamp(dateObj);
			checkFilename = this.buildLogFilename(env.ticketId, dateStamp, 1);
			attempts++;
		}

		// Compose entry body and header
		let displayHeader = fullDateTime;
		let bodyMarkdown = '';

		if (record.raw_content) {
			const trimmed = record.raw_content.trim();
			if (trimmed.startsWith('## ')) {
				const lines = trimmed.split('\n');
				displayHeader = lines[0].replace(/^##\s+/, '').trim();
				bodyMarkdown = lines.slice(1).join('\n').trim();
			} else {
				bodyMarkdown = trimmed;
			}
		} else if (record.execution_status || record.output_summary !== undefined) {
			displayHeader = `${dateStamp.slice(0, 8)} ${dateStamp.slice(9, 13)} - Workflow Execution`;
			bodyMarkdown = `- **Execution Status**: ${record.execution_status || 'Completed'}\n`;
			if (record.output_summary) {
				bodyMarkdown += `- **Output Summary**: ${record.output_summary}\n`;
			}
		} else {
			displayHeader = fullDateTime;
			bodyMarkdown += `- **Update Datetime**: ${fullDateTime}\n`;
			bodyMarkdown += `- **Update By**: ${record.update_by || 'User'}\n\n`;
			if (record.user_request) {
				bodyMarkdown += `### User Request\n${record.user_request}\n\n`;
			}
			if (record.update_summary) {
				bodyMarkdown += `### Update Summary\n${record.update_summary}\n\n`;
			}
			if (record.update_details) {
				bodyMarkdown += `### Update Details\n${record.update_details}\n\n`;
			}
			if (record.update_conclusion) {
				bodyMarkdown += `### Update Conclusion\n${record.update_conclusion}\n\n`;
			}
			if (record.commit) {
				bodyMarkdown += `### Commit\n`;
				bodyMarkdown += `- **Repo**: ${record.commit.repo || 'None'}\n`;
				bodyMarkdown += `- **Branch**: ${record.commit.branch || 'None'}\n`;
				bodyMarkdown += `- **ID**: ${record.commit.commit_id || 'None'}\n`;
				bodyMarkdown += `- **comment**: ${record.commit.comment || 'None'}\n`;
				bodyMarkdown += `- **committed by**: ${record.commit.committed_by || 'None'}\n`;
			}
		}

		const fullMarkdown = `## ${displayHeader}\n\n${bodyMarkdown}`.trim();
		const buffer = VSBuffer.fromString(fullMarkdown);
		const totalBytes = buffer.byteLength;
		const isSplit = totalBytes > threshold;
		const totalParts = isSplit ? Math.ceil(totalBytes / threshold) : 1;

		const createdFiles: string[] = [];
		const updateBy = record.update_by || 'User';

		for (let part = 1; part <= totalParts; part++) {
			const seq = part;
			const filename = this.buildLogFilename(env.ticketId, dateStamp, seq);
			const fileUri = URI.joinPath(env.worklogsDir, filename);

			let chunkContent = '';
			if (!isSplit) {
				chunkContent = fullMarkdown;
			} else {
				const start = (part - 1) * threshold;
				const end = Math.min(part * threshold, totalBytes);
				chunkContent = buffer.slice(start, end).toString();
			}

			// Add YAML frontmatter with full provenance & reconstruction metadata
			const frontmatter = this._buildFrontmatter(env.ticketId, fullDateTime, seq, part, totalParts, chunkContent, updateBy, record);

			const filePayload = frontmatter + chunkContent;
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(filePayload));
			createdFiles.push(filename);
		}

		// Update main worklog.md with a lightweight summary/index (prevent unbounded file growth)
		await this._appendLightweightSummaryToWorklogMd(env, displayHeader, updateBy, record, createdFiles[0]);

		// Any other entry ends the coalescing of automatically recorded field changes (CI-50)
		if (record.entry_kind !== TICKET_CHANGE_ENTRY_KIND) {
			ticketChangeCoalescer.invalidate(env.worklogsDir.toString());
		}

		const entryMeta: IWorklogEntryMeta = {
			id: `Ticket_${env.ticketId}_${dateStamp}`,
			ticketId: env.ticketId,
			timestamp: fullDateTime,
			dateStamp,
			displayHeader,
			partFiles: createdFiles,
			totalParts,
			totalBytes,
			isSplit,
			updateBy,
			firstPartUri: URI.joinPath(env.worklogsDir, createdFiles[0])
		};

		return {
			meta: entryMeta,
			headerText: displayHeader,
			bodyText: bodyMarkdown,
			fullContent: fullMarkdown
		};
	}

	private _buildFrontmatter(ticketId: string, fullDateTime: string, seq: number, part: number, totalParts: number, chunkContent: string, updateBy: string, record: IWorklogRecord): string {
		const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
		return [
			'---',
			`ticket_id: ${ticketId}`,
			`timestamp: ${fullDateTime}`,
			`sequence: ${String(seq).padStart(3, '0')}`,
			`part: ${part}/${totalParts}`,
			`total_parts: ${totalParts}`,
			`is_split: ${totalParts > 1}`,
			`byte_length: ${VSBuffer.fromString(chunkContent).byteLength}`,
			`update_by: ${oneLine(updateBy)}`,
			...(record.actor_name ? [`actor_name: ${oneLine(record.actor_name)}`] : []),
			...(record.entry_kind ? [`entry_kind: ${oneLine(record.entry_kind)}`] : []),
			'---',
			''
		].join('\n');
	}

	/**
	 * Rewrites a single part entry in place (same file name and timestamp) with new `raw_content`, and updates its
	 * worklog.md summary block. Used to coalesce consecutive field changes into one entry (CI-50).
	 */
	public async rewriteSinglePartEntry(entityUri: URI, filename: string, fullDateTime: string, record: IWorklogRecord): Promise<void> {
		const env = await this.resolveAndEnsureTicketEnvironment(entityUri);
		const content = (record.raw_content || '').trim();
		const updateBy = record.update_by || 'User';
		const frontmatter = this._buildFrontmatter(env.ticketId, fullDateTime, 1, 1, 1, content, updateBy, record);
		await this.fileService.writeFile(URI.joinPath(env.worklogsDir, filename), VSBuffer.fromString(frontmatter + content));
		const header = content.startsWith('## ') ? content.split('\n')[0].replace(/^##\s+/, '').trim() : fullDateTime;
		await this._replaceWorklogMdSummary(env, filename, this._buildSummaryBlock(header, updateBy, record, filename));
	}

	/** Deletes a single part entry and its worklog.md summary block (a coalesced entry whose changes were all reverted). */
	public async deleteSinglePartEntry(entityUri: URI, filename: string): Promise<void> {
		const env = await this.resolveAndEnsureTicketEnvironment(entityUri);
		const fileUri = URI.joinPath(env.worklogsDir, filename);
		if (await this.fileService.exists(fileUri)) {
			await this.fileService.del(fileUri);
		}
		await this._replaceWorklogMdSummary(env, filename, undefined);
	}

	private async _replaceWorklogMdSummary(env: ITicketStorageEnvironment, filename: string, block: string | undefined): Promise<void> {
		try {
			if (!await this.fileService.exists(env.worklogMdUri)) {
				return;
			}
			const existing = (await this.fileService.readFile(env.worklogMdUri)).value.toString();
			const updated = replaceWorklogMdSummaryBlock(existing, filename, block);
			if (updated !== existing) {
				await this.fileService.writeFile(env.worklogMdUri, VSBuffer.fromString(updated));
			}
		} catch (err) {
			console.warn('[TicketWorklogStorage] Failed to update summary in worklog.md:', err);
		}
	}

	/**
	 * Scans Worklogs/ and lists all logical worklog entries metadata sorted descending by timestamp.
	 * Automatically performs safe backward compatibility migration from worklog.md if needed.
	 */
	public async listWorklogMetas(entityUri: URI): Promise<IWorklogEntryMeta[]> {
		const env = await this.resolveAndEnsureTicketEnvironment(entityUri);

		// Safe backward-compatibility migration of legacy embedded logs in worklog.md
		await this.migrateLegacyWorklogsIfNeeded(env);

		let dirStat;
		try {
			dirStat = await this.fileService.resolve(env.worklogsDir);
		} catch {
			return [];
		}

		if (!dirStat.children || dirStat.children.length === 0) {
			return [];
		}

		// Group files by base logical key: Ticket_{ticketId}_{dateStamp}
		const groups = new Map<string, {
			ticketId: string;
			dateStamp: string;
			files: Array<{ name: string; sequence: number; uri: URI }>;
		}>();

		for (const child of dirStat.children) {
			if (child.isDirectory || !child.name.endsWith('.log')) {
				continue;
			}
			const parsed = this.parseLogFilename(child.name);
			if (parsed) {
				const groupKey = `Ticket_${parsed.ticketId}_${parsed.dateStamp}`;
				if (!groups.has(groupKey)) {
					groups.set(groupKey, {
						ticketId: parsed.ticketId,
						dateStamp: parsed.dateStamp,
						files: []
					});
				}
				groups.get(groupKey)!.files.push({
					name: child.name,
					sequence: parsed.sequence,
					uri: child.resource
				});
			} else {
				// Fallback for custom named .log files
				const fallbackKey = child.name.replace(/\.log$/i, '');
				if (!groups.has(fallbackKey)) {
					groups.set(fallbackKey, {
						ticketId: env.ticketId,
						dateStamp: '19700101_000000',
						files: []
					});
				}
				groups.get(fallbackKey)!.files.push({
					name: child.name,
					sequence: 1,
					uri: child.resource
				});
			}
		}

		const metas: IWorklogEntryMeta[] = [];

		for (const [groupKey, grp] of groups.entries()) {
			// Sort part files by sequence number ascending
			grp.files.sort((a, b) => a.sequence - b.sequence);
			const partFiles = grp.files.map(f => f.name);
			const firstFile = grp.files[0];

			// Quick inspection of first file header for display metadata
			let displayHeader = grp.dateStamp;
			let fullTimestamp = '';
			let updateBy = 'Unknown';
			let totalParts = grp.files.length;
			let totalBytes = 0;

			try {
				const headContent = (await this.fileService.readFile(firstFile.uri)).value.toString();
				totalBytes += VSBuffer.fromString(headContent).byteLength;
				const headerMatch = headContent.match(/^##\s+(.+)$/m);
				if (headerMatch) {
					displayHeader = headerMatch[1].trim();
				}
				const tsMatch = headContent.match(/^timestamp:\s*(.+)$/m) || headContent.match(/^-\s*\*\*Update Datetime\*\*:\s*(.+)$/m);
				if (tsMatch) {
					fullTimestamp = tsMatch[1].trim();
				}
				const byMatch = headContent.match(/^update_by:\s*(.+)$/m) || headContent.match(/^-\s*\*\*Update By\*\*:\s*(.+)$/m);
				if (byMatch) {
					updateBy = byMatch[1].trim();
				}
				const partsMatch = headContent.match(/^total_parts:\s*(\d+)$/m);
				if (partsMatch) {
					totalParts = parseInt(partsMatch[1], 10);
				}
			} catch { }

			// Tally bytes for remaining parts
			for (let i = 1; i < grp.files.length; i++) {
				try {
					const c = await this.fileService.readFile(grp.files[i].uri);
					totalBytes += c.value.byteLength;
				} catch { }
			}

			metas.push({
				id: groupKey,
				ticketId: grp.ticketId,
				timestamp: fullTimestamp || displayHeader,
				dateStamp: grp.dateStamp,
				displayHeader,
				partFiles,
				totalParts,
				totalBytes,
				isSplit: totalParts > 1,
				updateBy,
				firstPartUri: firstFile.uri
			});
		}

		// Sort chronological descending (newest first)
		metas.sort((a, b) => b.dateStamp.localeCompare(a.dateStamp));

		return metas;
	}

	/**
	 * Reads and reconstructs a complete logical worklog entry by joining all split parts in order.
	 */
	public async readWorklogEntry(entityUri: URI, meta: IWorklogEntryMeta): Promise<IWorklogEntry> {
		const env = await this.resolveAndEnsureTicketEnvironment(entityUri);
		const chunks: string[] = [];

		for (const filename of meta.partFiles) {
			const fileUri = URI.joinPath(env.worklogsDir, filename);
			try {
				let text = (await this.fileService.readFile(fileUri)).value.toString();
				// Strip YAML frontmatter if present
				text = text.replace(/^---[\s\S]*?---\r?\n/, '');
				chunks.push(text);
			} catch (err) {
				console.error(`Failed to read worklog part ${filename}:`, err);
			}
		}

		const fullContent = chunks.join('');
		let headerText = meta.displayHeader;
		let bodyText = fullContent;

		if (fullContent.startsWith('## ')) {
			const lines = fullContent.split('\n');
			headerText = lines[0].replace(/^##\s+/, '').trim();
			bodyText = lines.slice(1).join('\n').trim();
		}

		return {
			meta,
			headerText,
			bodyText,
			fullContent
		};
	}

	/**
	 * Incremental pagination loader. Fetches a slice of worklog entries.
	 * Default: limit: 1, offset: 0 loads only the latest entry on initial ticket view.
	 */
	public async getWorklogPage(entityUri: URI, options?: { offset?: number; limit?: number }): Promise<IWorklogPage> {
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 1;

		const allMetas = await this.listWorklogMetas(entityUri);
		const totalCount = allMetas.length;

		const sliceMetas = allMetas.slice(offset, offset + limit);
		const entries: IWorklogEntry[] = [];

		for (const meta of sliceMetas) {
			const entry = await this.readWorklogEntry(entityUri, meta);
			entries.push(entry);
		}

		return {
			entries,
			totalCount,
			offset,
			limit,
			hasMore: (offset + limit) < totalCount
		};
	}

	/**
	 * Helper: Appends a lightweight reference line to the main worklog.md file
	 * to prevent it from growing into megabytes while keeping standard Markdown visibility intact.
	 */
	private async _appendLightweightSummaryToWorklogMd(
		env: ITicketStorageEnvironment,
		displayHeader: string,
		updateBy: string,
		record: IWorklogRecord,
		primaryFilename: string
	): Promise<void> {
		try {
			let existing = '';
			if (await this.fileService.exists(env.worklogMdUri)) {
				existing = (await this.fileService.readFile(env.worklogMdUri)).value.toString();
			} else {
				existing = `# Work Log - ${env.ticketId}\n\n## Overview\n\n- **Workspace ID**: ${env.workspaceId}\n- **Ticket ID**: ${env.ticketId}\n- **Ticket Type**: ${env.ticketType}\n- **Worklogs Directory**: [Worklogs](.agents/Worklogs)\n\n---\n\n`;
			}

			const summaryEntry = `\n${this._buildSummaryBlock(displayHeader, updateBy, record, primaryFilename)}`;
			await this.fileService.writeFile(env.worklogMdUri, VSBuffer.fromString(existing.trimEnd() + '\n' + summaryEntry));
		} catch (err) {
			console.warn('[TicketWorklogStorage] Failed to append lightweight summary to worklog.md:', err);
		}
	}

	private _buildSummaryBlock(displayHeader: string, updateBy: string, record: IWorklogRecord, primaryFilename: string): string {
		// Clean brief summary
		let briefSummary = record.update_summary || record.user_request || (record.execution_status ? `Workflow status: ${record.execution_status}` : 'Worklog entry recorded');
		briefSummary = briefSummary.replace(/[\r\n]+/g, ' ');
		if (briefSummary.length > 200) {
			briefSummary = briefSummary.substring(0, 197) + '...';
		}
		const by = record.actor_name ? `${updateBy} (${record.actor_name})` : updateBy;
		return `## ${displayHeader}\n\n- **Log File**: [${primaryFilename}](.agents/Worklogs/${primaryFilename})\n- **Update By**: ${by}\n- **Summary**: ${briefSummary}\n`;
	}

	/**
	 * Safe backward-compatibility migration:
	 * Reads existing worklog.md (if it contains multi-entry history) and migrates entries into independent
	 * log files under Worklogs/, without deleting the original worklog.md.
	 */
	public async migrateLegacyWorklogsIfNeeded(env: ITicketStorageEnvironment): Promise<number> {
		try {
			if (!await this.fileService.exists(env.worklogMdUri)) {
				return 0;
			}

			// Check if Worklogs/ already has logs
			const dirStat = await this.fileService.resolve(env.worklogsDir);
			if (dirStat.children && dirStat.children.some(c => !c.isDirectory && c.name.endsWith('.log'))) {
				// Already migrated or populated
				return 0;
			}

			const content = (await this.fileService.readFile(env.worklogMdUri)).value.toString();
			const sections = content.split(/\r?\n##\s+/);
			if (sections.length <= 1) {
				return 0;
			}

			let migratedCount = 0;
			for (let i = 1; i < sections.length; i++) {
				const section = sections[i].trim();
				if (!section) { continue; }

				const lines = section.split('\n');
				const header = lines[0].trim();
				if (header.toLowerCase() === 'overview' || header.toLowerCase() === 'metadata') {
					continue;
				}

				// Extract date from header or content
				let dateObj = new Date();
				const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
				if (dateMatch) {
					const parsedDate = new Date(`${dateMatch[1]}T${dateMatch[2]}`);
					if (!isNaN(parsedDate.getTime())) {
						dateObj = parsedDate;
					}
				}

				// Prevent timestamp collision during batch migration
				dateObj.setSeconds(dateObj.getSeconds() + i);
				const dateStamp = this.formatDateStamp(dateObj);
				const fullDateTime = this.formatFullDateTime(dateObj);

				const filename = this.buildLogFilename(env.ticketId, dateStamp, 1);
				const fileUri = URI.joinPath(env.worklogsDir, filename);

				const fullEntry = `## ${header}\n\n${lines.slice(1).join('\n')}`.trim();
				const frontmatter = [
					'---',
					`ticket_id: ${env.ticketId}`,
					`timestamp: ${fullDateTime}`,
					`sequence: 001`,
					`part: 1/1`,
					`total_parts: 1`,
					`is_split: false`,
					`byte_length: ${VSBuffer.fromString(fullEntry).byteLength}`,
					`update_by: Legacy Migration`,
					'---',
					''
				].join('\n');

				await this.fileService.writeFile(fileUri, VSBuffer.fromString(frontmatter + fullEntry));
				migratedCount++;
			}

			return migratedCount;
		} catch (err) {
			console.warn('[TicketWorklogStorage] Migration error:', err);
			return 0;
		}
	}
}
