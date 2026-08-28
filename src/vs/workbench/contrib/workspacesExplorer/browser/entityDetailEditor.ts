/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, h } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { dirname } from '../../../../base/common/resources.js';

function getColorForName(name: string | undefined): string {
	if (!name) return '#38bdf8';
	const MODERN_PALETTE = [
		'#38bdf8', // Light Blue
		'#a78bfa', // Purple/Violet
		'#f472b6', // Pink
		'#34d399', // Emerald/Green
		'#fbbf24', // Amber/Yellow
		'#fb923c', // Orange
		'#2dd4bf', // Teal
		'#f87171', // Red
		'#818cf8', // Indigo
		'#c084fc', // Fuchsia
		'#22d3ee', // Cyan
		'#eab308'  // Yellow-gold
	];
	let hash = 0;
	const str = String(name).trim();
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % MODERN_PALETTE.length;
	return MODERN_PALETTE[index];
}

function hexToRgba(hex: string | undefined, alpha: number): string {
	if (!hex) {
		return `rgba(56, 189, 248, ${alpha})`;
	}
	let r = 0, g = 0, b = 0;
	if (hex.length === 4) {
		r = parseInt(hex[1] + hex[1], 16);
		g = parseInt(hex[2] + hex[2], 16);
		b = parseInt(hex[3] + hex[3], 16);
	} else if (hex.length === 7) {
		r = parseInt(hex.substring(1, 3), 16);
		g = parseInt(hex.substring(3, 5), 16);
		b = parseInt(hex.substring(5, 7), 16);
	}
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface IParsedTicketData {
	title: string;
	description: string;
	ticketType: string;
	ticketId: string;
	workspaceId: string;
	ticketCode: string;
	status: string;
	priority: string;
	assignedAgentName: string;
	typeDefinition: string;
	typePrompt: string;
	ticketPrompt: string;
	createdBy: string;
	ownerAccount: string;
	createdAt: string;
	lastUpdatedAt: string;
	lastUpdatedBy: string;
	linkTo: string;
	linkedBy: string;
	customMetadata: { [key: string]: string };
	metadata: { [key: string]: string };
	readmeNotes: string;
	instructionNotes: string;
}

export class EntityDetailEditor extends EditorPane {
	static readonly ID = 'workbench.editor.entityDetail';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	private _entityUri: URI | undefined;
	private _entityName: string = '';
	private _entityType: string = 'task';
	private _startInEditMode: boolean = false;

	private _ticketFileUri: URI | undefined;
	private _instructionUri: URI | undefined;
	private _readmeUri: URI | undefined;
	private _workLogUri: URI | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService
	) {
		super(EntityDetailEditor.ID, group, telemetryService, themeService, _storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = h('div.entity-detail-editor').root;
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
	}

	override layout(dimension: Dimension): void {
		// No-op. Webview element handles size automatically.
	}

	override async setInput(input: EntityDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this._entityUri = input.entityUri;
		this._entityName = input.entityName;
		this._startInEditMode = !!input.startInEditMode;

		await this._resolvePathsAndLoadData();
	}

	override clearInput(): void {
		super.clearInput();
	}

	private async _readCustomModule(workspaceUri: URI, typeId: string): Promise<any | null> {
		const targetId = (typeId || '').trim().toLowerCase();
		if (!targetId) return null;

		// Fast-bail for built-in system types to avoid redundant disk scans
		const builtInTypes = new Set(['workspace', 'job', 'task', 'project', 'workflow', 'agent', 'case', 'issue', 'analysis']);
		if (builtInTypes.has(targetId)) {
			return null;
		}

		const checkDirs: URI[] = [];
		let curr = workspaceUri;
		while (curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
			checkDirs.push(URI.joinPath(curr, '.agents', 'entity_type'));
			checkDirs.push(URI.joinPath(curr, '.agents', 'entity_types'));
			const parent = dirname(curr);
			if (parent.path === curr.path) break;
			curr = parent;
		}

		// Global directory
		const savedPath = this._storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
		const userHome = this._environmentService.userHome.fsPath;
		const resolvedGlobal = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : (savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_type'));
		checkDirs.push(URI.file(resolvedGlobal));

		for (const dir of checkDirs) {
			try {
				if (await this._fileService.exists(dir)) {
					// 1. Check direct file names
					const directNames = [`${targetId}.yaml`, `${targetId}.yml`, `${typeId}.yaml`, `${typeId}.yml`];
					for (const dName of directNames) {
						const directUri = URI.joinPath(dir, dName);
						if (await this._fileService.exists(directUri)) {
							const content = await this._fileService.readFile(directUri);
							const mod = this._parseSimpleYaml(content.value.toString());
							if (mod) return mod;
						}
					}

					// 2. Scan all files in directory
					const stat = await this._fileService.resolve(dir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && (child.name.endsWith('.yaml') || child.name.endsWith('.yml'))) {
								const content = await this._fileService.readFile(child.resource);
								const mod = this._parseSimpleYaml(content.value.toString());
								if (mod && (
									mod.id?.toLowerCase() === targetId ||
									mod.name?.toLowerCase() === targetId ||
									child.name.toLowerCase() === `${targetId}.yaml` ||
									child.name.toLowerCase() === `${targetId}.yml`
								)) {
									return mod;
								}
							}
						}
					}
				}
			} catch (e) {
				console.error('Error searching custom module:', e);
			}
		}
		return null;
	}

	private _parseSimpleYaml(yaml: string): any {
		const lines = yaml.split(/\r?\n/);
		const result: any = {};
		let currentFieldList: any[] = [];
		let currentField: any = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const indent = line.length - line.trimStart().length;

			if (trimmed.startsWith('-')) {
				const content = trimmed.substring(1).trim();
				if (content.includes(':')) {
					const colonIndex = content.indexOf(':');
					const key = content.substring(0, colonIndex).trim();
					let val = content.substring(colonIndex + 1).trim();
					if (val.startsWith('"') && val.endsWith('"')) {
						try { val = JSON.parse(val); } catch {}
					}
					currentField = { [key]: val };
					currentFieldList.push(currentField);
				} else {
					let val = content;
					if (val.startsWith('"') && val.endsWith('"')) {
						try { val = JSON.parse(val); } catch {}
					}
					if (currentField && Array.isArray(currentField.options)) {
						currentField.options.push(val);
					}
				}
			} else if (trimmed.includes(':')) {
				const colonIndex = trimmed.indexOf(':');
				const key = trimmed.substring(0, colonIndex).trim();
				let val = trimmed.substring(colonIndex + 1).trim();
				if (val.startsWith('"') && val.endsWith('"')) {
					try { val = JSON.parse(val); } catch {}
				}

				if (indent === 0) {
					if (key === 'fields') {
						result.fields = [];
						currentFieldList = result.fields;
					} else {
						result[key] = (val === 'true' ? true : val === 'false' ? false : val);
					}
				} else if (indent > 0 && currentField) {
					if (key === 'options') {
						currentField.options = [];
					} else {
						currentField[key] = (val === 'true' ? true : val === 'false' ? false : val);
					}
				}
			}
		}
		return result;
	}

	private async _resolvePathsAndLoadData(): Promise<void> {
		if (!this._entityUri || !this._container) {
			return;
		}

		// 1. Resolve 4-MD file paths (robust checking of .agents and root)
		this._ticketFileUri = await this._resolveFileUri(this._entityUri, 'ticket.md');
		this._instructionUri = await this._resolveFileUri(this._entityUri, 'instruction.md');
		this._readmeUri = await this._resolveFileUri(this._entityUri, 'README.md');
		this._workLogUri = await this._resolveWorkLogUri(this._entityUri);

		// 2. Read contents from 4-MD files
		const ticketContent = await this._safeReadFile(this._ticketFileUri);
		const readmeContent = await this._safeReadFile(this._readmeUri);
		const instructionContent = await this._safeReadFile(this._instructionUri);
		const workLogContent = await this._safeReadFile(this._workLogUri);

		const parsed = this._parseAllEntityData(ticketContent, readmeContent, instructionContent);
		this._entityType = parsed.ticketType || 'task';

		const attachments = await this._getAttachments(this._entityUri);
		const customModule = await this._readCustomModule(this._entityUri, this._entityType);

		// 3. Setup Webview cleanly without recreating or dropping listeners
		if (!this._webview) {
			this._webview = this._register(this._webviewService.createWebviewElement({
				title: localize('entityDetail', "Entity Detail"),
				options: {},
				contentOptions: { allowScripts: true },
				extension: undefined
			}));
			this._webview.mountTo(this._container, this.window);

			this._register(this._webview.onMessage(async (e: any) => {
				await this._handleMessage(e);
			}));
		}

		const html = this._generateHtml(parsed, workLogContent, attachments, customModule);
		this._webview.setHtml(html);
	}

	private async _resolveFileUri(baseUri: URI, name: string): Promise<URI> {
		const agentsDir = URI.joinPath(baseUri, '.agents');
		const pathInAgents = URI.joinPath(agentsDir, name);
		if (await this._fileService.exists(pathInAgents)) {
			return pathInAgents;
		}
		const pathInRoot = URI.joinPath(baseUri, name);
		if (await this._fileService.exists(pathInRoot)) {
			return pathInRoot;
		}
		// Default to .agents/<name>
		return pathInAgents;
	}

	private async _resolveWorkLogUri(baseUri: URI): Promise<URI> {
		const names = ['worklog.md', 'work_log.md'];
		for (const name of names) {
			const p1 = URI.joinPath(baseUri, '.agents', name);
			if (await this._fileService.exists(p1)) return p1;
			const p2 = URI.joinPath(baseUri, name);
			if (await this._fileService.exists(p2)) return p2;
		}
		return URI.joinPath(baseUri, '.agents', 'worklog.md');
	}

	private async _safeReadFile(uri: URI | undefined): Promise<string> {
		if (uri && await this._fileService.exists(uri)) {
			try {
				const content = await this._fileService.readFile(uri);
				return content.value.toString();
			} catch { }
		}
		return '';
	}

	private _parseAllEntityData(
		ticketContent: string,
		readmeContent: string,
		instructionContent: string
	): IParsedTicketData {
		const metadata: { [key: string]: string } = {};
		const customMetadata: { [key: string]: string } = {};

		// 1. Parse ticket.md
		let inSelfDefined = false;
		const ticketLines = ticketContent.split(/\r?\n/);
		for (const line of ticketLines) {
			if (line.startsWith('### Self Defined Data')) {
				inSelfDefined = true;
				continue;
			}
			if (line.startsWith('### ') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				inSelfDefined = false;
			}
			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match) {
				const key = match[1].trim();
				const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				if (inSelfDefined && line.startsWith('  -')) {
					customMetadata[key] = val;
				} else {
					metadata[key] = val;
				}
			}
		}

		// 2. Parse README.md
		let readmeTitle = '';
		let readmeDesc = '';
		const readmeNotesLines: string[] = [];
		let isPastReadmeMeta = false;
		const readmeLines = readmeContent.split(/\r?\n/);
		for (const line of readmeLines) {
			const titleMatch = line.match(/^\s*-\s*\*\*Title\*\*:\s*(.*)$/i);
			if (titleMatch) {
				readmeTitle = titleMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)$/i);
			if (descMatch) {
				readmeDesc = descMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			if (line.startsWith('---') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				isPastReadmeMeta = true;
			}
			if (isPastReadmeMeta) {
				readmeNotesLines.push(line);
			}
		}

		// 3. Parse instruction.md
		let typePrompt = '';
		let ticketPrompt = '';
		const instNotesLines: string[] = [];
		let isPastInstMeta = false;
		const instLines = instructionContent.split(/\r?\n/);
		for (const line of instLines) {
			const tpMatch = line.match(/^\s*-\s*\*\*Ticket Type Prompt\*\*:\s*(.*)$/i);
			if (tpMatch) {
				typePrompt = tpMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const tickpMatch = line.match(/^\s*-\s*\*\*Ticket Prompt\*\*:\s*(.*)$/i);
			if (tickpMatch) {
				ticketPrompt = tickpMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			if (line.startsWith('---') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				isPastInstMeta = true;
			}
			if (isPastInstMeta) {
				instNotesLines.push(line);
			}
		}

		const ticketId = metadata['Ticket ID'] || this._entityName || '';
		const workspaceId = metadata['Workspace ID'] || '';
		const ticketType = metadata['Ticket Type'] || this._entityType || 'job';
		const title = readmeTitle || metadata['Title'] || this._entityName || ticketId;
		const description = (readmeDesc && readmeDesc !== 'None') ? readmeDesc : (metadata['Description'] || '');

		return {
			title,
			description,
			ticketType,
			ticketId,
			workspaceId,
			ticketCode: metadata['Ticket Code'] || '',
			status: metadata['Status'] || 'Todo',
			priority: metadata['Priority'] || 'Medium',
			assignedAgentName: metadata['Current AI Agent'] || 'None',
			typeDefinition: metadata['Type Definition'] || 'None',
			typePrompt: typePrompt || 'None',
			ticketPrompt: ticketPrompt || 'None',
			createdBy: metadata['Created By'] || 'User',
			ownerAccount: metadata['Owner Account'] || '',
			createdAt: metadata['Created At'] || '',
			lastUpdatedAt: metadata['Last Updated At'] || '',
			lastUpdatedBy: metadata['Last Updated By'] || 'User',
			linkTo: metadata['Link To'] || 'None',
			linkedBy: metadata['Linked By'] || 'None',
			customMetadata,
			metadata,
			readmeNotes: readmeNotesLines.join('\n').trim(),
			instructionNotes: instNotesLines.join('\n').trim()
		};
	}

	private _updateReadmeContent(content: string, newTitle?: string, newDesc?: string): string {
		const lines = content.split(/\r?\n/);
		const newLines: string[] = [];
		let foundTitle = false;
		let foundDesc = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.match(/^\s*-\s*\*\*Title\*\*:/i)) {
				if (newTitle !== undefined) {
					newLines.push(`- **Title**: ${newTitle}`);
					foundTitle = true;
				} else {
					newLines.push(line);
					foundTitle = true;
				}
				continue;
			}
			if (line.match(/^\s*-\s*\*\*Description\*\*:/i)) {
				if (newDesc !== undefined) {
					newLines.push(`- **Description**: ${newDesc}`);
					foundDesc = true;
				} else {
					newLines.push(line);
					foundDesc = true;
				}
				continue;
			}
			newLines.push(line);
		}

		if (!foundTitle && newTitle !== undefined) {
			newLines.splice(1, 0, `- **Title**: ${newTitle}`);
		}
		if (!foundDesc && newDesc !== undefined) {
			newLines.splice(2, 0, `- **Description**: ${newDesc}`);
		}

		return newLines.join('\n');
	}

	private _updateTicketMdContent(content: string, updates: { [key: string]: string }, customUpdates?: { [key: string]: string }): string {
		const lines = content.split(/\r?\n/);
		const newLines: string[] = [];
		let inSelfDefined = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('### Self Defined Data')) {
				inSelfDefined = true;
				newLines.push(line);
				continue;
			}
			if (inSelfDefined && (line.startsWith('### ') || (line.startsWith('## ') && !line.startsWith('## Overview')) || line.startsWith('- **Current AI Agent') || line.startsWith('- **Status'))) {
				inSelfDefined = false;
			}

			if (inSelfDefined && customUpdates && line.startsWith('- **Self Defined Data Value**:')) {
				newLines.push(line);
				for (const [k, v] of Object.entries(customUpdates)) {
					newLines.push(`  - **${k}**: ${v}`);
				}
				// Skip old custom fields
				while (i + 1 < lines.length && (lines[i + 1].startsWith('  -') || (lines[i + 1].trim() === '' && i + 2 < lines.length && lines[i + 2].startsWith('  -')))) {
					i++;
				}
				continue;
			}

			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match && !inSelfDefined) {
				const key = match[1].trim();
				if (updates[key] !== undefined) {
					newLines.push(`- **${key}**: ${updates[key]}`);
					continue;
				}
			}
			newLines.push(line);
		}

		return newLines.join('\n');
	}

	private async _handleMessage(e: any): Promise<void> {
		if (!e || !this._entityUri) {
			return;
		}

		switch (e.type) {
			case 'saveAllData':
			case 'saveTitleAndDescription':
			case 'saveDescription': {
				try {
					if (this._readmeUri) {
						if (!(await this._fileService.exists(this._readmeUri))) {
							const parentDir = dirname(this._readmeUri);
							if (!(await this._fileService.exists(parentDir))) {
								await this._fileService.createFolder(parentDir);
							}
							await this._fileService.writeFile(this._readmeUri, VSBuffer.fromString('# ' + (e.title || this._entityName) + '\n'));
						}
						const content = await this._safeReadFile(this._readmeUri);
						const updated = this._updateReadmeContent(content, e.title, e.description);
						await this._fileService.writeFile(this._readmeUri, VSBuffer.fromString(updated));
					}
					if (this._ticketFileUri) {
						if (!(await this._fileService.exists(this._ticketFileUri))) {
							const parentDir = dirname(this._ticketFileUri);
							if (!(await this._fileService.exists(parentDir))) {
								await this._fileService.createFolder(parentDir);
							}
							await this._fileService.writeFile(this._ticketFileUri, VSBuffer.fromString('# ' + (e.title || this._entityName) + '\n\n## Overview\n'));
						}
						const content = await this._safeReadFile(this._ticketFileUri);
						const updates: { [key: string]: string } = {};
						if (e.title) updates['Title'] = e.title;
						if (e.description) updates['Description'] = e.description;
						if (e.metadata) Object.assign(updates, e.metadata);
						const updated = this._updateTicketMdContent(content, updates, e.customMetadata);
						await this._fileService.writeFile(this._ticketFileUri, VSBuffer.fromString(updated));
					}
					this._notificationService.info(localize('descSaved', "Saved entity details successfully."));
					await this._resolvePathsAndLoadData();
				} catch (err) {
					console.error('Failed to save entity details:', err);
					this._notificationService.error(localize('saveDescFailed', "Failed to save: {0}", String(err)));
				}
				break;
			}
			case 'saveMetadata': {
				try {
					if (this._ticketFileUri) {
						const content = await this._safeReadFile(this._ticketFileUri);
						const updated = this._updateTicketMdContent(content, e.metadata, e.customMetadata);
						await this._fileService.writeFile(this._ticketFileUri, VSBuffer.fromString(updated));
					}
					if (e.metadata && (e.metadata['Title'] || e.metadata['Description']) && this._readmeUri) {
						const content = await this._safeReadFile(this._readmeUri);
						const updated = this._updateReadmeContent(content, e.metadata['Title'], e.metadata['Description']);
						await this._fileService.writeFile(this._readmeUri, VSBuffer.fromString(updated));
					}
					this._notificationService.info(localize('metaSaved', "Attributes updated successfully."));
					await this._resolvePathsAndLoadData();
				} catch (err) {
					this._notificationService.error(localize('saveMetaFailed', "Failed to save attributes: {0}", String(err)));
				}
				break;
			}
			case 'addWorkLog': {
				try {
					if (this._workLogUri) {
						if (!(await this._fileService.exists(this._workLogUri))) {
							const parentDir = dirname(this._workLogUri);
							if (!(await this._fileService.exists(parentDir))) {
								await this._fileService.createFolder(parentDir);
							}
							await this._fileService.writeFile(this._workLogUri, VSBuffer.fromString('# Work Log\n'));
						}
						const content = await this._safeReadFile(this._workLogUri);
						const updated = this._addLogToContent(content, e.log);
						await this._fileService.writeFile(this._workLogUri, VSBuffer.fromString(updated));
						this._notificationService.info(localize('logAdded', "Work log recorded successfully."));
						await this._resolvePathsAndLoadData();
					}
				} catch (err) {
					this._notificationService.error(localize('addLogFailed', "Failed to add work log: {0}", String(err)));
				}
				break;
			}
			case 'uploadAttachment': {
				try {
					const attachmentsDir = URI.joinPath(this._entityUri, 'attachments');
					if (!(await this._fileService.exists(attachmentsDir))) {
						await this._fileService.createFolder(attachmentsDir);
					}
					const fileUri = URI.joinPath(attachmentsDir, e.name);
					const buffer = new Uint8Array(e.data);
					await this._fileService.writeFile(fileUri, VSBuffer.wrap(buffer));
					this._notificationService.info(localize('fileUploaded', "Attachment '{0}' uploaded.", e.name));
					await this._resolvePathsAndLoadData();
				} catch (err) {
					this._notificationService.error(localize('uploadFailed', "Failed to upload attachment: {0}", String(err)));
				}
				break;
			}
			case 'downloadAttachment': {
				try {
					const fileUri = URI.joinPath(this._entityUri, 'attachments', e.name);
					if (await this._fileService.exists(fileUri)) {
						const content = await this._fileService.readFile(fileUri);
						const saveUri = await this._fileDialogService.showSaveDialog({
							defaultUri: URI.file(e.name),
							title: localize('saveAttachment', "Download Attachment")
						});
						if (saveUri) {
							await this._fileService.writeFile(saveUri, content.value);
							this._notificationService.info(localize('downloadSuccess', "Attachment downloaded."));
						}
					}
				} catch (err) {
					this._notificationService.error(localize('downloadFail', "Failed to download: {0}", String(err)));
				}
				break;
			}
			case 'deleteAttachment': {
				try {
					const fileUri = URI.joinPath(this._entityUri, 'attachments', e.name);
					if (await this._fileService.exists(fileUri)) {
						await this._fileService.del(fileUri);
						this._notificationService.info(localize('attachmentDeleted', "Attachment deleted."));
						await this._resolvePathsAndLoadData();
					}
				} catch (err) {
					this._notificationService.error(localize('deleteFailed', "Failed to delete: {0}", String(err)));
				}
				break;
			}
		}
	}

	private _addLogToContent(content: string, newLogText: string): string {
		const lines = content.split(/\r?\n/);
		const now = new Date();
		const dateStr = now.toISOString().split('T')[0];
		const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

		const logBlock = [
			`## ${dateStr} ${timeStr}`,
			'',
			'### AI 执行记录',
			'',
			newLogText,
			''
		].join('\n');

		let insertIndex = 0;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith('# ')) {
				insertIndex = i + 1;
				break;
			}
		}

		lines.splice(insertIndex, 0, '', logBlock);
		return lines.join('\n');
	}

	private async _getAttachments(entityUri: URI): Promise<string[]> {
		const attachmentsDir = URI.joinPath(entityUri, 'attachments');
		if (!(await this._fileService.exists(attachmentsDir))) {
			return [];
		}
		try {
			const stat = await this._fileService.resolve(attachmentsDir);
			if (stat.children) {
				return stat.children.filter(child => !child.isDirectory).map(child => child.name);
			}
		} catch { }
		return [];
	}

	private _markdownToHtml(md: string): string {
		if (!md) {
			return '<p style="opacity: 0.5; font-style: italic;">No content available</p>';
		}
		let html = md
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');

		html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: #38bdf8; text-decoration: none;">$1</a>');
		html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 12px 0 4px 0; color: #38bdf8; font-size: 0.95em; font-weight: 600;">$1</h4>');
		html = html.replace(/^## (.*$)/gim, '<h3 style="margin: 16px 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--vscode-editor-foreground); font-size: 1.05em; font-weight: 600;">$1</h3>');
		html = html.replace(/^# (.*$)/gim, '<h2 style="margin: 20px 0 10px 0; color: var(--vscode-editor-foreground); font-size: 1.15em; font-weight: bold;">$1</h2>');
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong style="color: var(--vscode-editor-foreground);">$1</strong>');
		html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.08); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 0.9em; border: 1px solid rgba(255,255,255,0.06);">$1</code>');
		html = html.replace(/^\s*-\s+(.*$)/gim, '<li style="margin-left: 18px; margin-bottom: 4px; line-height: 1.5;">$1</li>');
		html = html.replace(/^\s*\*\s+(.*$)/gim, '<li style="margin-left: 18px; margin-bottom: 4px; line-height: 1.5;">$1</li>');

		const lines = html.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line && !line.startsWith('<h') && !line.startsWith('<li') && !line.startsWith('<ul') && !line.startsWith('<ol') && !line.startsWith('<code') && !line.startsWith('---')) {
				lines[i] = `<p style="margin: 4px 0; line-height: 1.5; opacity: 0.95;">${lines[i]}</p>`;
			} else if (line === '---') {
				lines[i] = '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 16px 0;" />';
			}
		}

		return lines.join('\n');
	}

	private _generateHtml(
		data: IParsedTicketData,
		workLog: string,
		attachments: string[],
		customModule?: any
	): string {
		const typeUpper = data.ticketType.toUpperCase();

		// 1. Status Colors
		let status = data.status || 'Todo';
		let statusColor = '#818cf8';
		let statusBg = 'rgba(129, 140, 248, 0.16)';
		let statusBorder = 'rgba(129, 140, 248, 0.35)';
		if (status.toLowerCase().includes('progress')) {
			statusColor = '#38bdf8';
			statusBg = 'rgba(56, 189, 248, 0.16)';
			statusBorder = 'rgba(56, 189, 248, 0.35)';
		} else if (status.toLowerCase().includes('done') || status.toLowerCase().includes('complete')) {
			statusColor = '#34d399';
			statusBg = 'rgba(52, 211, 153, 0.16)';
			statusBorder = 'rgba(52, 211, 153, 0.35)';
		} else if (status.toLowerCase().includes('block') || status.toLowerCase().includes('fail')) {
			statusColor = '#f87171';
			statusBg = 'rgba(248, 113, 113, 0.16)';
			statusBorder = 'rgba(248, 113, 113, 0.35)';
		}

		// 2. Type Colors
		const typeColors: { [key: string]: { text: string; bg: string } } = {
			workspace: { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' },
			job: { text: '#fbbf24', bg: 'rgba(251, 191, 36, 0.15)' },
			task: { text: '#a78bfa', bg: 'rgba(167, 139, 250, 0.15)' },
			project: { text: '#60a5fa', bg: 'rgba(96, 165, 250, 0.15)' },
			workflow: { text: '#0d9488', bg: 'rgba(13, 148, 136, 0.15)' },
			agent: { text: '#f472b6', bg: 'rgba(244, 114, 182, 0.15)' },
			case: { text: '#a3e635', bg: 'rgba(163, 230, 53, 0.15)' },
			issue: { text: '#f87171', bg: 'rgba(248, 113, 113, 0.15)' },
			analysis: { text: '#34d399', bg: 'rgba(52, 211, 153, 0.15)' },
			note: { text: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.15)' }
		};

		const typeLower = data.ticketType.toLowerCase();
		let colorSetting: { text: string; bg: string };
		if (customModule && customModule.color) {
			colorSetting = { text: customModule.color, bg: hexToRgba(customModule.color, 0.15) };
		} else if (typeColors[typeLower]) {
			colorSetting = typeColors[typeLower];
		} else {
			const color = getColorForName(typeLower);
			colorSetting = { text: color, bg: hexToRgba(color, 0.15) };
		}

		// 3. Priority badge
		const pColors: { [key: string]: string } = {
			'very high': '#f43f5e',
			'high': '#fb923c',
			'medium': '#38bdf8',
			'low': '#34d399',
			'very low': '#2dd4bf'
		};
		const pColor = pColors[data.priority.toLowerCase()] || '#94a3b8';

		// 4. Attachments HTML
		let attachmentsHtml = '';
		if (attachments.length === 0) {
			attachmentsHtml = '<p style="opacity: 0.45; font-style: italic; font-size: 0.88em; margin: 8px 0;">No attachments linked yet.</p>';
		} else {
			attachmentsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 10px;">';
			for (const file of attachments) {
				attachmentsHtml += `
					<div class="attachment-card" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 8px 12px; border-radius: 6px;">
						<div onclick="downloadFile('${file}')" style="display: flex; align-items: center; gap: 8px; overflow: hidden; cursor: pointer; flex: 1;" title="Download attachment">
							<span style="font-size: 0.88em; font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${file}</span>
						</div>
						<span class="delete-attachment" onclick="deleteFile('${file}')" style="opacity: 0.4; cursor: pointer; padding: 2px 4px; font-size: 0.85em;" title="Delete Attachment">✕</span>
					</div>
				`;
			}
			attachmentsHtml += '</div>';
		}

		// 5. Timeline HTML
		let workLogHtml = '';
		const logsList = workLog.split(/\r?\n##\s+/);
		if (logsList.length <= 1 && !workLog.trim().startsWith('##')) {
			workLogHtml = '<p style="opacity: 0.45; font-style: italic; font-size: 0.88em; margin: 8px 0;">No work logs recorded yet.</p>';
		} else {
			workLogHtml = '<div class="timeline" style="border-left: 2px solid rgba(255,255,255,0.08); margin-left: 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 16px; margin-top: 15px;">';
			for (let entry of logsList) {
				entry = entry.trim();
				if (!entry) continue;
				if (entry.startsWith('#')) {
					const subParts = entry.split(/\r?\n##\s+/);
					if (subParts.length > 1) {
						entry = subParts[1].trim();
					} else {
						continue;
					}
				}
				const lines = entry.split('\n');
				const header = lines[0].trim();
				if (header.toLowerCase() === 'overview' || header.toLowerCase() === 'metadata' || header.toLowerCase() === '基本元数据') {
					continue;
				}
				const body = lines.slice(1).join('\n').trim();
				const bodyHtml = this._markdownToHtml(body);
				workLogHtml += `
					<div class="timeline-item" style="position: relative;">
						<div class="timeline-dot" style="position: absolute; left: -27px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-button-background); border: 2px solid var(--vscode-editor-background);"></div>
						<div style="font-weight: 600; font-size: 0.92em; color: var(--vscode-editor-foreground); margin-bottom: 4px;">${header}</div>
						<div class="timeline-body" style="font-size: 0.88em; opacity: 0.88; line-height: 1.5;">${bodyHtml}</div>
					</div>
				`;
			}
			workLogHtml += '</div>';
		}

		// 6. Custom Fields Section
		let customFieldsHtml = '';
		const customFieldsEntries = Object.entries(data.customMetadata || {});
		if (customFieldsEntries.length > 0) {
			for (const [k, v] of customFieldsEntries) {
				const isMultiline = v.length > 80 || v.includes('\n') || ['experience', 'description', 'detail', 'content', 'notes', 'summary', 'project', 'background'].some(sub => k.toLowerCase().includes(sub));
				customFieldsHtml += `
					<div class="section-card custom-property-card">
						<div class="section-title">
							<span>${k}</span>
						</div>
						<div class="custom-field-view desc-content-box">
							${v ? this._markdownToHtml(v) : '<span style="opacity: 0.45; font-style: italic;">No content provided.</span>'}
						</div>
						<div class="custom-field-edit" style="display: none;">
							${isMultiline ? `
								<textarea class="custom-meta-input input-field" data-custom-key="${k}" rows="5">${v}</textarea>
							` : `
								<input type="text" class="custom-meta-input input-field" data-custom-key="${k}" value="${v}" />
							`}
						</div>
					</div>
				`;
			}
		}

		// 7. Instructions Card Section
		const ticketPromptDisplay = (data.ticketPrompt && data.ticketPrompt !== 'None') ? data.ticketPrompt : '';
		const typePromptDisplay = (data.typePrompt && data.typePrompt !== 'None') ? data.typePrompt : '';

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<style>
					:root {
						--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
					}
					body {
						font-family: var(--vscode-font-family);
						color: var(--vscode-foreground);
						background-color: var(--vscode-editor-background);
						margin: 0;
						padding: 24px 32px;
						box-sizing: border-box;
						overflow-y: auto;
					}
					* {
						box-sizing: border-box;
					}
					.layout-container {
						display: grid;
						grid-template-columns: minmax(0, 1fr) 320px;
						gap: 32px;
						max-width: 1360px;
						margin: 0 auto;
					}
					.main-content {
						display: flex;
						flex-direction: column;
						gap: 20px;
					}
					.sidebar {
						background: rgba(255,255,255,0.02);
						border: 1px solid rgba(255,255,255,0.06);
						border-radius: 10px;
						padding: 20px;
						height: fit-content;
						position: sticky;
						top: 24px;
						backdrop-filter: blur(8px);
						box-shadow: 0 4px 16px rgba(0,0,0,0.15);
					}
					.header-breadcrumb {
						display: flex;
						align-items: center;
						gap: 8px;
						font-size: 0.85em;
						opacity: 0.65;
						margin-bottom: 6px;
						font-weight: 500;
					}
					.header-title-row {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 16px;
						margin-bottom: 8px;
					}
					.ticket-title {
						margin: 0;
						font-size: 1.65em;
						font-weight: 700;
						color: var(--vscode-editor-foreground, #fff);
						line-height: 1.25;
					}
					.badge {
						display: inline-block;
						padding: 4px 10px;
						border-radius: 4px;
						font-size: 0.72em;
						font-weight: 700;
						letter-spacing: 0.05em;
						text-transform: uppercase;
					}
					.btn-primary {
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						padding: 6px 14px;
						border-radius: 5px;
						cursor: pointer;
						font-weight: 600;
						font-size: 0.85em;
						transition: background 0.2s;
					}
					.btn-primary:hover {
						background: var(--vscode-button-hoverBackground);
					}
					.btn-primary:disabled {
						opacity: 0.6;
						cursor: not-allowed;
					}
					.btn-secondary {
						background: rgba(255,255,255,0.06);
						color: var(--vscode-foreground);
						border: 1px solid rgba(255,255,255,0.1);
						padding: 5px 12px;
						border-radius: 5px;
						cursor: pointer;
						font-weight: 500;
						font-size: 0.82em;
						transition: background 0.2s;
					}
					.btn-secondary:hover {
						background: rgba(255,255,255,0.12);
					}
					.input-field {
						background: var(--vscode-input-background, #1e1e1e);
						color: var(--vscode-input-foreground, #eee);
						border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
						padding: 10px 14px;
						border-radius: 6px;
						width: 100%;
						font-family: inherit;
						font-size: 0.95em;
						line-height: 1.6;
						resize: vertical;
					}
					.input-field:focus {
						outline: 1px solid var(--vscode-focusBorder, #007acc);
						border-color: var(--vscode-focusBorder, #007acc);
					}
					.section-card {
						background: rgba(255,255,255,0.015);
						border: 1px solid rgba(255,255,255,0.05);
						border-radius: 8px;
						padding: 18px 22px;
					}
					.section-title {
						font-size: 1.05em;
						font-weight: 600;
						margin: 0 0 14px 0;
						color: var(--vscode-editor-foreground, #eee);
						display: flex;
						justify-content: space-between;
						align-items: center;
					}
					.desc-content-box {
						padding: 14px 16px;
						background: rgba(0,0,0,0.18);
						border-radius: 6px;
						border: 1px solid rgba(255,255,255,0.04);
						font-size: 0.93em;
						line-height: 1.65;
						text-align: left;
					}
					.dropzone {
						border: 2px dashed rgba(255,255,255,0.12);
						border-radius: 6px;
						padding: 20px;
						text-align: center;
						cursor: pointer;
						transition: border 0.2s, background 0.2s;
						background: rgba(255,255,255,0.005);
					}
					.dropzone:hover, .dropzone.dragover {
						border-color: var(--vscode-focusBorder, #38bdf8);
						background: rgba(56,189,248,0.04);
					}
					.sidebar-row {
						display: flex;
						flex-direction: column;
						gap: 4px;
						margin-bottom: 14px;
						border-bottom: 1px solid rgba(255,255,255,0.04);
						padding-bottom: 8px;
					}
					.sidebar-label {
						font-size: 0.75em;
						opacity: 0.55;
						font-weight: 600;
						letter-spacing: 0.05em;
						text-transform: uppercase;
					}
					.sidebar-value {
						font-size: 0.9em;
						font-weight: 500;
						color: var(--vscode-editor-foreground);
						word-break: break-word;
					}
				</style>
			</head>
			<body>
				<!-- Top Header Area -->
				<div style="max-width: 1360px; margin: 0 auto 20px auto;">
					<div class="header-breadcrumb">
						<span>${data.workspaceId || 'Workspace'}</span>
						<span>/</span>
						<span>${data.ticketId}</span>
						<span class="badge" style="background: ${colorSetting.bg}; color: ${colorSetting.text}; border: 1px solid ${colorSetting.text}40;">${typeUpper}</span>
					</div>
					<div class="header-title-row">
						<h1 class="ticket-title" id="title-heading">${data.title}</h1>
					</div>
				</div>

				<!-- Main Layout Container -->
				<div class="layout-container">
					<!-- Left Column: Main Stream -->
					<div class="main-content">
						<!-- 1. Description Card -->
						<div class="section-card">
							<div class="section-title">
								<span>Description</span>
								<button id="edit-desc-btn" onclick="startEditDesc()" class="btn-secondary">Edit</button>
							</div>
							
							<div id="desc-view-mode" class="desc-content-box">
								${data.description ? this._markdownToHtml(data.description) : '<span style="opacity: 0.45; font-style: italic;">No description provided. Click Edit to add one.</span>'}
							</div>
							
							<div id="desc-edit-mode" style="display: none;">
								<div style="margin-bottom: 8px;">
									<label style="display: block; font-size: 0.8em; opacity: 0.6; margin-bottom: 4px; font-weight: 600;">TITLE</label>
									<input type="text" id="title-input" class="input-field" value="${data.title}" />
								</div>
								<div>
									<label style="display: block; font-size: 0.8em; opacity: 0.6; margin-bottom: 4px; font-weight: 600;">DESCRIPTION</label>
									<textarea id="desc-textarea" class="input-field" rows="6">${data.description}</textarea>
								</div>
								<div style="display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;">
									<button onclick="cancelEditDesc()" class="btn-secondary">Cancel</button>
									<button id="save-desc-btn" onclick="saveAllChanges('save-desc-btn')" class="btn-primary">Save Changes</button>
								</div>
							</div>
						</div>

						<!-- 2. Instructions & Directives Card -->
						<div class="section-card">
							<div class="section-title">
								<span>Instructions & Directives</span>
							</div>

							<div style="display: flex; flex-direction: column; gap: 12px;">
								<!-- Ticket Specific Directives -->
								<div style="border-left: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.04); padding: 12px 16px; border-radius: 0 6px 6px 0; border: 1px solid rgba(56, 189, 248, 0.15); border-left-width: 3px;">
									<div style="font-size: 0.78em; font-weight: 700; color: #38bdf8; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px;">Ticket Specific Prompt / Rules</div>
									<div style="font-size: 0.9em; opacity: 0.9; line-height: 1.5;">${ticketPromptDisplay ? this._markdownToHtml(ticketPromptDisplay) : '<span style="opacity: 0.45; font-style: italic;">No specific ticket prompts configured.</span>'}</div>
								</div>

								<!-- Type Guidelines -->
								<div style="border-left: 3px solid #a78bfa; background: rgba(167, 139, 250, 0.04); padding: 12px 16px; border-radius: 0 6px 6px 0; border: 1px solid rgba(167, 139, 250, 0.15); border-left-width: 3px;">
									<div style="font-size: 0.78em; font-weight: 700; color: #a78bfa; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px;">${typeUpper} Definition & Role Guidelines</div>
									<div style="font-size: 0.9em; opacity: 0.9; line-height: 1.5;">${typePromptDisplay ? this._markdownToHtml(typePromptDisplay) : '<span style="opacity: 0.45; font-style: italic;">Standard system processing guidelines apply.</span>'}</div>
								</div>

								${data.instructionNotes ? `
									<div style="padding: 12px 16px; background: rgba(0,0,0,0.15); border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
										<div style="font-size: 0.78em; font-weight: 700; opacity: 0.6; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 6px;">Operational Commands & Notes</div>
										<div style="font-size: 0.9em; line-height: 1.5;">${this._markdownToHtml(data.instructionNotes)}</div>
									</div>
								` : ''}
							</div>
						</div>

						<!-- 3. Custom Properties -->
						${customFieldsHtml}

						<!-- 4. Attachments Card -->
						<div class="section-card">
							<div class="section-title">
								<span>Attachments (${attachments.length})</span>
							</div>
							<div id="attachment-dropzone" class="dropzone" onclick="triggerBrowse()">
								<span style="font-size: 0.88em; opacity: 0.7;">Drag and drop files here or click to browse</span>
								<input type="file" id="file-input" style="display: none;" onchange="handleBrowseUpload(event)" />
							</div>
							<div id="attachments-container">
								${attachmentsHtml}
							</div>
						</div>

						<!-- 5. Activity & Work Logs Card -->
						<div class="section-card">
							<div class="section-title">
								<span>Work Logs & Activity</span>
								<button id="add-log-btn" onclick="showAddLogModal()" class="btn-primary" style="font-size: 0.8em; padding: 4px 10px;">+ Add Log</button>
							</div>
							
							<!-- Add Log Form -->
							<div id="add-log-box" style="display: none; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 15px;">
								<textarea id="log-textarea" class="input-field" rows="3" placeholder="Enter work log description..."></textarea>
								<div style="display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;">
									<button onclick="hideAddLogModal()" class="btn-secondary">Cancel</button>
									<button onclick="submitLog()" class="btn-primary">Record Log</button>
								</div>
							</div>

							<div id="work-logs-container">
								${workLogHtml}
							</div>
						</div>
					</div>

					<!-- Right Column: Sidebar (Attributes / Information) -->
					<div class="sidebar">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
							<div style="display: flex; align-items: center; gap: 8px;">
								<h3 style="margin: 0; font-size: 1.05em; font-weight: 700; color: var(--vscode-editor-foreground);">Attributes</h3>
								<button id="toggle-edit-mode-btn" onclick="toggleEditMode()" class="btn-secondary" style="padding: 2px 8px; font-size: 0.8em;">Edit</button>
							</div>
							<span class="badge" style="background: ${colorSetting.bg}; color: ${colorSetting.text}; border: 1px solid ${colorSetting.text}40;">${typeUpper}</span>
						</div>
						
						<!-- Status -->
						<div class="sidebar-row">
							<span class="sidebar-label">STATUS</span>
							<div style="padding: 2px 0;">
								<span id="status-view-val" style="display: inline-block; font-size: 0.88em; font-weight: 700; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder}; padding: 3px 10px; border-radius: 5px;">${status}</span>
							</div>
							<select id="status-select" onchange="onStatusChange()" style="display: none; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; padding: 6px 10px; border-radius: 5px; font-weight: 700; font-size: 0.88em; width: 100%; cursor: pointer;">
								<option value="Todo" ${status.toLowerCase() === 'todo' ? 'selected' : ''}>Todo</option>
								<option value="In Progress" ${status.toLowerCase().includes('progress') ? 'selected' : ''}>In Progress</option>
								<option value="Done" ${status.toLowerCase().includes('done') || status.toLowerCase().includes('complete') ? 'selected' : ''}>Done</option>
								<option value="Blocked" ${status.toLowerCase().includes('block') ? 'selected' : ''}>Blocked</option>
							</select>
						</div>

						<!-- Priority -->
						<div class="sidebar-row">
							<span class="sidebar-label">PRIORITY</span>
							<div style="display: flex; align-items: center; gap: 6px; padding: 2px 0;">
								<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${pColor}; box-shadow: 0 0 6px ${pColor}80;"></span>
								<span class="meta-view-val" style="font-size: 0.9em; font-weight: 700; color: ${pColor};">${data.priority}</span>
							</div>
							<select class="meta-input meta-edit-val" data-key="Priority" style="display: none; background: rgba(255,255,255,0.04); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.1); padding: 5px 8px; border-radius: 4px; font-size: 0.88em; width: 100%;">
								<option value="Very High" ${data.priority.toLowerCase() === 'very high' ? 'selected' : ''}>Very High</option>
								<option value="High" ${data.priority.toLowerCase() === 'high' ? 'selected' : ''}>High</option>
								<option value="Medium" ${data.priority.toLowerCase() === 'medium' ? 'selected' : ''}>Medium</option>
								<option value="Low" ${data.priority.toLowerCase() === 'low' ? 'selected' : ''}>Low</option>
								<option value="Very Low" ${data.priority.toLowerCase() === 'very low' ? 'selected' : ''}>Very Low</option>
							</select>
						</div>

						<!-- Assigned AI Agent -->
						<div class="sidebar-row">
							<span class="sidebar-label">ASSIGNED AGENT</span>
							<span class="meta-view-val sidebar-value">${data.assignedAgentName && data.assignedAgentName !== 'None' ? data.assignedAgentName : '<span style="opacity:0.4;">Unassigned</span>'}</span>
							<input type="text" class="meta-input meta-edit-val input-field" data-key="Current AI Agent" value="${data.assignedAgentName !== 'None' ? data.assignedAgentName : ''}" style="display: none; padding: 4px 8px; font-size: 0.88em;" placeholder="e.g. Lead Architect" />
						</div>

						<!-- Type Definition -->
						<div class="sidebar-row">
							<span class="sidebar-label">TYPE DEFINITION</span>
							<span class="sidebar-value" style="font-family: monospace; font-size: 0.85em; opacity: 0.9;">${data.typeDefinition}</span>
						</div>

						<!-- Workspace ID & Ticket ID -->
						<div class="sidebar-row">
							<span class="sidebar-label">WORKSPACE ID</span>
							<span class="sidebar-value" style="font-family: monospace; font-size: 0.88em;">${data.workspaceId || 'None'}</span>
						</div>

						<div class="sidebar-row">
							<span class="sidebar-label">TICKET ID</span>
							<span class="sidebar-value" style="font-family: monospace; font-size: 0.88em; color: #38bdf8;">${data.ticketId}</span>
						</div>

						<div class="sidebar-row">
							<span class="sidebar-label">TICKET CODE</span>
							<span class="sidebar-value" style="font-family: monospace; font-size: 0.88em;">${data.ticketCode || 'None'}</span>
						</div>

						<!-- Link To & Linked By -->
						<div class="sidebar-row">
							<span class="sidebar-label">LINK TO</span>
							<span class="meta-view-val sidebar-value">${data.linkTo !== 'None' ? data.linkTo : '<span style="opacity:0.4;">None</span>'}</span>
							<input type="text" class="meta-input meta-edit-val input-field" data-key="Link To" value="${data.linkTo !== 'None' ? data.linkTo : ''}" style="display: none; padding: 4px 8px; font-size: 0.88em;" placeholder="e.g. FNDJ1-0001" />
						</div>

						<div class="sidebar-row">
							<span class="sidebar-label">LINKED BY</span>
							<span class="meta-view-val sidebar-value">${data.linkedBy !== 'None' ? data.linkedBy : '<span style="opacity:0.4;">None</span>'}</span>
							<input type="text" class="meta-input meta-edit-val input-field" data-key="Linked By" value="${data.linkedBy !== 'None' ? data.linkedBy : ''}" style="display: none; padding: 4px 8px; font-size: 0.88em;" />
						</div>

						<!-- Ownership & Dates -->
						<div class="sidebar-row">
							<span class="sidebar-label">CREATED BY</span>
							<span class="sidebar-value">${data.createdBy}</span>
						</div>

						<div class="sidebar-row">
							<span class="sidebar-label">OWNER ACCOUNT</span>
							<span class="sidebar-value" style="font-size: 0.85em; opacity: 0.85;">${data.ownerAccount || 'unauthenticated'}</span>
						</div>

						<div class="sidebar-row">
							<span class="sidebar-label">CREATED AT</span>
							<span class="sidebar-value" style="font-size: 0.85em; opacity: 0.85;">${data.createdAt}</span>
						</div>

						<div class="sidebar-row" style="border-bottom: none; margin-bottom: 0;">
							<span class="sidebar-label">LAST UPDATED AT</span>
							<span class="sidebar-value" style="font-size: 0.85em; opacity: 0.85;">${data.lastUpdatedAt}</span>
						</div>

						<button id="save-metadata-btn" onclick="saveAllChanges('save-metadata-btn')" class="btn-primary" style="display: none; width: 100%; margin-top: 16px; padding: 8px;">Save Attributes</button>
					</div>
				</div>

				<script>
					const vscode = acquireVsCodeApi();

					let currentMetadata = ${JSON.stringify(data.metadata)};
					let currentCustomMetadata = ${JSON.stringify(data.customMetadata)};

					// 1. Description & Title Edit
					function startEditDesc() {
						document.getElementById('desc-view-mode').style.display = 'none';
						document.getElementById('desc-edit-mode').style.display = 'block';
						document.getElementById('edit-desc-btn').style.display = 'none';
						const textarea = document.getElementById('desc-textarea');
						if (textarea) textarea.focus();
					}

					function cancelEditDesc() {
						document.getElementById('desc-view-mode').style.display = 'block';
						document.getElementById('desc-edit-mode').style.display = 'none';
						document.getElementById('edit-desc-btn').style.display = 'inline-block';
					}

					function saveAllChanges(btnId) {
						const btn = btnId ? document.getElementById(btnId) : null;
						if (btn) {
							btn.disabled = true;
							btn.innerText = 'Saving...';
							setTimeout(() => {
								if (btn) {
									btn.disabled = false;
									btn.innerText = (btnId === 'save-metadata-btn') ? 'Save Attributes' : 'Save Changes';
								}
							}, 1500);
						}

						const titleEl = document.getElementById('title-input');
						const descEl = document.getElementById('desc-textarea');
						const newTitle = titleEl ? titleEl.value.trim() : undefined;
						const newDesc = descEl ? descEl.value.trim() : undefined;

						const statusSelect = document.getElementById('status-select');
						if (statusSelect) {
							currentMetadata['Status'] = statusSelect.value;
						}
						
						const inputs = document.querySelectorAll('.meta-input');
						inputs.forEach(input => {
							const key = input.getAttribute('data-key');
							if (key) {
								currentMetadata[key] = input.value;
							}
						});

						const customInputs = document.querySelectorAll('.custom-meta-input');
						customInputs.forEach(input => {
							const key = input.getAttribute('data-custom-key');
							if (key) {
								currentCustomMetadata[key] = input.value;
							}
						});

						vscode.postMessage({
							type: 'saveAllData',
							title: newTitle,
							description: newDesc,
							metadata: currentMetadata,
							customMetadata: currentCustomMetadata
						});
					}

					// Shortcut Cmd+S / Ctrl+S
					window.addEventListener('keydown', (e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === 's') {
							e.preventDefault();
							saveAllChanges('save-desc-btn');
						}
					});

					// 2. Status & Metadata Changes
					function onStatusChange() {
						const select = document.getElementById('status-select');
						const status = select.value.toLowerCase();
						if (status.includes('progress')) {
							select.style.background = 'rgba(56, 189, 248, 0.18)';
							select.style.color = '#38bdf8';
							select.style.borderColor = 'rgba(56, 189, 248, 0.4)';
						} else if (status.includes('done') || status.includes('complete')) {
							select.style.background = 'rgba(52, 211, 153, 0.18)';
							select.style.color = '#34d399';
							select.style.borderColor = 'rgba(52, 211, 153, 0.4)';
						} else if (status.includes('block') || status.includes('fail')) {
							select.style.background = 'rgba(244, 63, 94, 0.18)';
							select.style.color = '#f43f5e';
							select.style.borderColor = 'rgba(244, 63, 94, 0.4)';
						} else {
							select.style.background = 'rgba(129, 140, 248, 0.18)';
							select.style.color = '#818cf8';
							select.style.borderColor = 'rgba(129, 140, 248, 0.4)';
						}
					}

					// 3. Work Logs
					function showAddLogModal() {
						document.getElementById('add-log-box').style.display = 'block';
						document.getElementById('log-textarea').focus();
					}

					function hideAddLogModal() {
						document.getElementById('add-log-box').style.display = 'none';
						document.getElementById('log-textarea').value = '';
					}

					function submitLog() {
						const val = document.getElementById('log-textarea').value;
						if (val.trim()) {
							vscode.postMessage({
								type: 'addWorkLog',
								log: val
							});
							hideAddLogModal();
						}
					}

					// 4. Attachments
					const dropzone = document.getElementById('attachment-dropzone');
					window.addEventListener('dragover', (e) => e.preventDefault());
					window.addEventListener('drop', (e) => e.preventDefault());

					dropzone.addEventListener('dragover', (e) => {
						e.preventDefault();
						dropzone.classList.add('dragover');
					});
					dropzone.addEventListener('dragleave', () => {
						dropzone.classList.remove('dragover');
					});
					dropzone.addEventListener('drop', (e) => {
						e.preventDefault();
						dropzone.classList.remove('dragover');
						const files = e.dataTransfer.files;
						if (files && files.length > 0) {
							uploadFile(files[0]);
						}
					});

					function triggerBrowse() {
						document.getElementById('file-input').click();
					}

					function handleBrowseUpload(event) {
						const files = event.target.files;
						if (files && files.length > 0) {
							uploadFile(files[0]);
						}
					}

					function uploadFile(file) {
						const reader = new FileReader();
						reader.onload = function(e) {
							vscode.postMessage({
								type: 'uploadAttachment',
								name: file.name,
								data: Array.from(new Uint8Array(e.target.result))
							});
						};
						reader.readAsArrayBuffer(file);
					}

					function downloadFile(name) {
						vscode.postMessage({
							type: 'downloadAttachment',
							name: name
						});
					}

					function deleteFile(name) {
						if (confirm("Are you sure you want to delete attachment '" + name + "'?")) {
							vscode.postMessage({
								type: 'deleteAttachment',
								name: name
							});
						}
					}

					// 5. Edit Mode Toggle
					let isEditMode = ${this._startInEditMode ? 'true' : 'false'};
					function toggleEditMode() {
						isEditMode = !isEditMode;
						const btn = document.getElementById('toggle-edit-mode-btn');
						if (isEditMode) {
							btn.innerText = 'Cancel';
							const statusView = document.getElementById('status-view-val');
							if (statusView) statusView.style.display = 'none';
							const statusSelect = document.getElementById('status-select');
							if (statusSelect) statusSelect.style.display = 'block';

							document.querySelectorAll('.meta-view-val').forEach(el => el.style.display = 'none');
							document.querySelectorAll('.meta-edit-val').forEach(el => el.style.display = 'block');
							document.querySelectorAll('.custom-field-view').forEach(el => el.style.display = 'none');
							document.querySelectorAll('.custom-field-edit').forEach(el => el.style.display = 'block');
							document.getElementById('save-metadata-btn').style.display = 'block';
						} else {
							btn.innerText = 'Edit';
							const statusView = document.getElementById('status-view-val');
							if (statusView) statusView.style.display = 'inline-block';
							const statusSelect = document.getElementById('status-select');
							if (statusSelect) statusSelect.style.display = 'none';

							document.querySelectorAll('.meta-view-val').forEach(el => el.style.display = 'block');
							document.querySelectorAll('.meta-edit-val').forEach(el => el.style.display = 'none');
							document.querySelectorAll('.custom-field-view').forEach(el => el.style.display = 'block');
							document.querySelectorAll('.custom-field-edit').forEach(el => el.style.display = 'none');
							document.getElementById('save-metadata-btn').style.display = 'none';
						}
					}

					if (isEditMode) {
						isEditMode = false;
						toggleEditMode();
					}
				</script>
			</body>
			</html>
		`;
	}
}
