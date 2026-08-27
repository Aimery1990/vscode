/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode, Dimension, h } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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

export class EntityDetailEditor extends EditorPane {
	static readonly ID = 'workbench.editor.entityDetail';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private readonly _contentDisposables = this._register(new DisposableStore());

	private _entityUri: URI | undefined;
	private _entityName: string = '';
	private _entityType: string = 'task';
	private _startInEditMode: boolean = false;

	private _entityFileUri: URI | undefined;
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

		this._contentDisposables.clear();
		if (this._container) {
			clearNode(this._container);
		}

		await this._resolvePathsAndLoadData();
	}

	override clearInput(): void {
		this._webview?.dispose();
		this._webview = undefined;
		this._contentDisposables.clear();
		if (this._container) {
			clearNode(this._container);
		}
		super.clearInput();
	}

	private _parseYaml(yaml: string): any {
		const lines = yaml.split(/\r?\n/);
		const result: any = {};
		let currentFieldList: any[] = [];
		let currentField: any = null;

		for (let line of lines) {
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

	private async _readCustomModule(workspaceUri: URI, typeId: string): Promise<any | null> {
		const savedPath = this._storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
		const userHome = this._environmentService.userHome.fsPath;
		const resolvedPath = savedPath.startsWith('~/') ? userHome + savedPath.substring(1) : savedPath === '~' ? userHome : savedPath;
		
		const possibleUris = [
			URI.joinPath(workspaceUri, '.agents', 'entity_type', `${typeId}.yaml`),
			URI.joinPath(workspaceUri, '.agents', 'entity_type', `${typeId.toLowerCase()}.yaml`),
			URI.joinPath(dirname(workspaceUri), '.agents', 'entity_type', `${typeId}.yaml`),
			URI.joinPath(dirname(workspaceUri), '.agents', 'entity_type', `${typeId.toLowerCase()}.yaml`),
			URI.file(resolvedPath + `/${typeId}.yaml`),
			URI.file(resolvedPath + `/${typeId.toLowerCase()}.yaml`),
		];

		for (const u of possibleUris) {
			if (await this._fileService.exists(u)) {
				try {
					const content = await this._fileService.readFile(u);
					return this._parseYaml(content.value.toString());
				} catch {}
			}
		}

		return null;
	}

	private async _resolvePathsAndLoadData(): Promise<void> {
		if (!this._entityUri || !this._container) {
			return;
		}

		// 1. Resolve paths
		const agentsDir = URI.joinPath(this._entityUri, '.agents');
		const rootDir = this._entityUri;

		const possibleMds = [
			{ name: 'workspace.md', type: 'workspace' },
			{ name: 'project.md', type: 'project' },
			{ name: 'job.md', type: 'job' },
			{ name: 'task.md', type: 'task' },
			{ name: 'agent.md', type: 'agent' },
			{ name: 'workflow.md', type: 'workflow' },
			{ name: 'note.md', type: 'note' }
		];

		let detectedMainMdName: string | undefined;
		let detectedType: string = 'task';

		const ticketPath = URI.joinPath(agentsDir, 'ticket.md');
		if (await this._fileService.exists(ticketPath)) {
			detectedMainMdName = 'ticket.md';
		} else {
			try {
				if (await this._fileService.exists(agentsDir)) {
					const stat = await this._fileService.resolve(agentsDir);
					if (stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory && child.name.endsWith('.md')) {
								const nameLower = child.name.toLowerCase();
								if (nameLower !== 'instruction.md' && nameLower !== 'readme.md' && nameLower !== 'work_log.md' && nameLower !== 'worklog.md') {
									detectedMainMdName = child.name;
									detectedType = child.name.substring(0, child.name.length - 3);
									break;
								}
							}
						}
					}
				}
			} catch {}
		}

		if (detectedMainMdName) {
			this._entityType = detectedType;
			this._entityFileUri = URI.joinPath(agentsDir, detectedMainMdName);
		} else {
			const nameLower = (this._entityName || '').toLowerCase();
			const uriPathLower = this._entityUri.path.toLowerCase();
			if (nameLower.startsWith('note') || uriPathLower.includes('/note-') || uriPathLower.includes('/notes/')) {
				this._entityType = 'note';
				this._entityFileUri = URI.joinPath(agentsDir, 'note.md');
			} else {
				this._entityType = 'task';
				this._entityFileUri = URI.joinPath(agentsDir, 'task.md');
			}

			for (const item of possibleMds) {
				const path1 = URI.joinPath(agentsDir, item.name);
				if (await this._fileService.exists(path1)) {
					this._entityType = item.type;
					this._entityFileUri = path1;
					break;
				}
				const path2 = URI.joinPath(rootDir, item.name);
				if (await this._fileService.exists(path2)) {
					this._entityType = item.type;
					this._entityFileUri = path2;
					break;
				}
			}
		}

		this._instructionUri = await this._resolveFileUri(this._entityUri, 'instruction.md');
		this._readmeUri = await this._resolveFileUri(this._entityUri, 'README.md');
		const worklogUriNew = URI.joinPath(agentsDir, 'worklog.md');
		if (await this._fileService.exists(worklogUriNew)) {
			this._workLogUri = worklogUriNew;
		} else {
			this._workLogUri = await this._resolveFileUri(this._entityUri, 'work_log.md');
		}

		// 2. Load contents
		const entityContent = await this._safeReadFile(this._entityFileUri);
		const parsed = this._parseEntityFile(entityContent);
		if (this._entityFileUri.path.endsWith('ticket.md')) {
			this._entityType = parsed.metadata['Ticket Type'] || parsed.metadata['Entity Type'] || 'task';
		}

		const instructionContent = await this._safeReadFile(this._instructionUri);
		const readmeContent = await this._safeReadFile(this._readmeUri);
		const workLogContent = await this._safeReadFile(this._workLogUri);

		const attachments = await this._getAttachments(this._entityUri);

		// 3. Setup Webview
		if (!this._webview) {
			this._webview = this._contentDisposables.add(this._webviewService.createWebviewElement({
				title: localize('entityDetail', "Entity Detail"),
				options: {},
				contentOptions: { allowScripts: true },
				extension: undefined
			}));
			this._webview.mountTo(this._container, this.window);

			this._contentDisposables.add(this._webview.onMessage(async (e: any) => {
				await this._handleMessage(e);
			}));
		}

		const customModule = await this._readCustomModule(this._entityUri, this._entityType);

		const html = this._generateHtml(parsed.title || this._entityName, this._entityType, parsed.metadata, parsed.description, readmeContent, instructionContent, workLogContent, attachments, customModule);
		this._webview.setHtml(html);
	}

	private async _resolveFileUri(baseUri: URI, name: string): Promise<URI> {
		const path1 = URI.joinPath(baseUri, '.agents', name);
		if (await this._fileService.exists(path1)) {
			return path1;
		}
		return URI.joinPath(baseUri, name);
	}

	private async _safeReadFile(uri: URI): Promise<string> {
		if (await this._fileService.exists(uri)) {
			try {
				const content = await this._fileService.readFile(uri);
				return content.value.toString();
			} catch { }
		}
		return '';
	}

	private _parseEntityFile(content: string): { title: string, metadata: { [key: string]: string }, description: string } {
		const lines = content.split(/\r?\n/);
		let title = '';
		const metadata: { [key: string]: string } = {};
		let description = '';

		let inMetadata = false;
		let inDescription = false;
		let descLines: string[] = [];

		for (const line of lines) {
			if (line.startsWith('# ')) {
				title = line.substring(2).trim();
				continue;
			}
			if (line.startsWith('## Overview') || line.startsWith('## Metadata') || line.startsWith('## 基本元数据') || line.startsWith('## Details') || line.startsWith('## 概览')) {
				inMetadata = true;
				inDescription = false;
				continue;
			}
			if (line.startsWith('## Description') || line.startsWith('## Job 目标') || line.startsWith('## 目标')) {
				inMetadata = false;
				inDescription = true;
				continue;
			}
			if (line.startsWith('## ')) {
				inMetadata = false;
				inDescription = false;
				continue;
			}

			if (inMetadata) {
				const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
				if (match) {
					const key = match[1].trim();
					const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					metadata[key] = val;
				} else {
					// Fallback for simple list: - Key: Value
					const simpleMatch = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
					if (simpleMatch) {
						const key = simpleMatch[1].trim();
						const val = simpleMatch[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
						metadata[key] = val;
					}
				}
			} else if (inDescription) {
				descLines.push(line);
			}
		}

		description = descLines.join('\n').trim();
		return { title, metadata, description };
	}

	private _updateEntityFileContent(content: string, newDesc: string | undefined, newMeta: { [key: string]: string } | undefined): string {
		const lines = content.split(/\r?\n/);
		const newLines: string[] = [];

		let inMetadata = false;
		let inDescription = false;
		let hasReplacedMeta = false;
		let hasReplacedDesc = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (line.startsWith('## Overview') || line.startsWith('## Metadata') || line.startsWith('## 基本元数据') || line.startsWith('## Details') || line.startsWith('## 概览')) {
				newLines.push(line);
				inMetadata = true;
				inDescription = false;
				if (newMeta) {
					newLines.push('');
					for (const [k, v] of Object.entries(newMeta)) {
						newLines.push(`- **${k}**: ${v}`);
					}
					hasReplacedMeta = true;
					// Skip old metadata lines
					while (i + 1 < lines.length && !lines[i + 1].startsWith('## ')) {
						i++;
					}
				}
				continue;
			}

			if (line.startsWith('## Description') || line.startsWith('## Job 目标') || line.startsWith('## 目标')) {
				newLines.push(line);
				inMetadata = false;
				inDescription = true;
				if (newDesc !== undefined) {
					newLines.push('');
					newLines.push(newDesc);
					hasReplacedDesc = true;
					// Skip old description lines
					while (i + 1 < lines.length && !lines[i + 1].startsWith('## ')) {
						i++;
					}
				}
				continue;
			}

			if (line.startsWith('## ')) {
				inMetadata = false;
				inDescription = false;
			}

			if (!inMetadata && !inDescription) {
				newLines.push(line);
			}
		}

		// Fallback if sections didn't exist
		if (!hasReplacedMeta && newMeta) {
			newLines.push('');
			newLines.push('## Overview');
			newLines.push('');
			for (const [k, v] of Object.entries(newMeta)) {
				newLines.push(`- **${k}**: ${v}`);
			}
		}
		if (!hasReplacedDesc && newDesc !== undefined) {
			newLines.push('');
			newLines.push('## Description');
			newLines.push('');
			newLines.push(newDesc);
		}

		return newLines.join('\n');
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

	private async _handleMessage(e: any): Promise<void> {
		if (!e || !this._entityUri) {
			return;
		}

		switch (e.type) {
			case 'saveDescription': {
				try {
					if (this._entityFileUri) {
						const content = await this._safeReadFile(this._entityFileUri);
						const updated = this._updateEntityFileContent(content, e.description, undefined);
						await this._fileService.writeFile(this._entityFileUri, VSBuffer.fromString(updated));
						this._notificationService.info(localize('descSaved', "Description saved successfully."));
						await this._resolvePathsAndLoadData();
					}
				} catch (err) {
					this._notificationService.error(localize('saveDescFailed', "Failed to save description: {0}", String(err)));
				}
				break;
			}
			case 'saveMetadata': {
				try {
					if (this._entityFileUri) {
						const content = await this._safeReadFile(this._entityFileUri);
						const updated = this._updateEntityFileContent(content, undefined, e.metadata);
						await this._fileService.writeFile(this._entityFileUri, VSBuffer.fromString(updated));
						this._notificationService.info(localize('metaSaved', "Metadata updated successfully."));
						await this._resolvePathsAndLoadData();
					}
				} catch (err) {
					this._notificationService.error(localize('saveMetaFailed', "Failed to save metadata: {0}", String(err)));
				}
				break;
			}
			case 'addWorkLog': {
				try {
					if (this._workLogUri) {
						// Auto create work_log.md and parent directory if missing
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

	private _markdownToHtml(md: string): string {
		if (!md) {
			return '<p style="opacity: 0.5; font-style: italic;">No content available</p>';
		}
		// Basic sanitizer and markdown compiler for security and aesthetic rendering
		let html = md
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');

		// Process links [text](url)
		html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: #38bdf8; text-decoration: none;">$1</a>');

		// Process headings
		html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 12px 0 4px 0; color: #38bdf8; font-size: 0.95em; font-weight: 600;">$1</h4>');
		html = html.replace(/^## (.*$)/gim, '<h3 style="margin: 16px 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--vscode-editor-foreground); font-size: 1.05em; font-weight: 600;">$1</h3>');
		html = html.replace(/^# (.*$)/gim, '<h2 style="margin: 20px 0 10px 0; color: var(--vscode-editor-foreground); font-size: 1.15em; font-weight: bold;">$1</h2>');

		// Process bold and code blocks
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong style="color: var(--vscode-editor-foreground);">$1</strong>');
		html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.08); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 0.9em; border: 1px solid rgba(255,255,255,0.06);">$1</code>');

		// Process lists
		html = html.replace(/^\s*-\s+(.*$)/gim, '<li style="margin-left: 18px; margin-bottom: 4px; line-height: 1.5;">$1</li>');
		html = html.replace(/^\s*\*\s+(.*$)/gim, '<li style="margin-left: 18px; margin-bottom: 4px; line-height: 1.5;">$1</li>');

		// Wrap lines in paragraphs if they are not headings, lists, or hr
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

	private _generateHtml(title: string, type: string, metadata: { [key: string]: string }, description: string, readme: string, instruction: string, workLog: string, attachments: string[], customModule?: any): string {
		const typeUpper = type.toUpperCase();

		// 1. Clean Title (remove trailing parenthesis tags like (JOB), (TASK) etc.)
		const cleanTitle = title.replace(/\s*\((job|task|project|workspace|agent|workflow|case|issue|analysis)\)/i, '');

		// 2. Map Status type to badge styles
		let status = metadata['Status'] || metadata['status'] || 'Todo';
		let statusColor = '#818cf8';
		let statusBg = 'rgba(129, 140, 248, 0.18)';
		let statusBorder = 'rgba(129, 140, 248, 0.4)';
		if (status.toLowerCase().includes('progress')) {
			statusColor = '#38bdf8';
			statusBg = 'rgba(56, 189, 248, 0.18)';
			statusBorder = 'rgba(56, 189, 248, 0.4)';
		} else if (status.toLowerCase().includes('done')) {
			statusColor = '#34d399';
			statusBg = 'rgba(52, 211, 153, 0.18)';
			statusBorder = 'rgba(52, 211, 153, 0.4)';
		} else if (status.toLowerCase().includes('block')) {
			statusColor = '#f87171';
			statusBg = 'rgba(248, 113, 113, 0.18)';
			statusBorder = 'rgba(248, 113, 113, 0.4)';
		}

		// 3. Custom colors for entity types
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
			note: { text: '#cbd5e1', bg: 'rgba(203, 213, 225, 0.15)' }
		};

		const typeLower = type.toLowerCase();
		let colorSetting = typeColors[typeLower];
		if (!colorSetting) {
			if (customModule && customModule.color) {
				colorSetting = { text: customModule.color, bg: hexToRgba(customModule.color, 0.15) };
			} else {
				const color = getColorForName(typeLower);
				colorSetting = { text: color, bg: hexToRgba(color, 0.15) };
			}
		}

		// Attachment cards html list
		let attachmentsHtml = '';
		if (attachments.length === 0) {
			attachmentsHtml = '<p style="opacity: 0.5; font-style: italic; font-size: 0.9em; margin: 10px 0;">No attachments linked yet.</p>';
		} else {
			attachmentsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 10px;">';
			for (const file of attachments) {
				attachmentsHtml += `
					<div class="attachment-card" data-filename="${file}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 8px 12px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease;">
						<div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
							<span style="font-size: 1.1em; opacity: 0.8;">📄</span>
							<span style="font-size: 0.85em; font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${file}</span>
						</div>
						<span class="delete-attachment" data-filename="${file}" style="opacity: 0.4; cursor: pointer; padding: 2px 4px;" title="Delete Attachment">✕</span>
					</div>
				`;
			}
			attachmentsHtml += '</div>';
		}

		// Accordions for README and Instruction
		const readmeHtml = this._markdownToHtml(readme);
		const instructionHtml = this._markdownToHtml(instruction);

		// Render work logs timeline
		let workLogHtml = '';
		const logsList = workLog.split(/\r?\n##\s+/);
		if (logsList.length <= 1 && !workLog.trim().startsWith('##')) {
			workLogHtml = '<p style="opacity: 0.5; font-style: italic; font-size: 0.9em; margin: 10px 0;">No work logs available.</p>';
		} else {
			workLogHtml = '<div class="timeline" style="border-left: 2px solid rgba(255,255,255,0.08); margin-left: 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 16px; margin-top: 15px;">';
			for (let entry of logsList) {
				entry = entry.trim();
				if (!entry) {
					continue;
				}
				// If first entry had heading '# Work Log', split it
				if (entry.startsWith('#')) {
					const subParts = entry.split(/\r?\n##\s+/);
					if (subParts.length > 1) {
						entry = subParts[1].trim();
					} else {
						continue;
					}
				}
				const lines = entry.split('\n');
				let header = lines[0].trim();
				if (header.toLowerCase() === 'overview' || header.toLowerCase() === 'metadata' || header.toLowerCase() === '基本元数据') {
					continue;
				}
				const body = lines.slice(1).join('\n').trim();
				const bodyHtml = this._markdownToHtml(body);
				workLogHtml += `
					<div class="timeline-item" style="position: relative;">
						<div class="timeline-dot" style="position: absolute; left: -27px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-button-background); border: 2px solid var(--vscode-editor-background);"></div>
						<div style="font-weight: 600; font-size: 0.95em; color: var(--vscode-editor-foreground); margin-bottom: 6px;">${header}</div>
						<div class="timeline-body" style="font-size: 0.88em; opacity: 0.9; line-height: 1.5;">${bodyHtml}</div>
					</div>
				`;
			}
			workLogHtml += '</div>';
		}

		// Metadata sidebar list (Make entity type, created at, entity code, owner account, created by read-only)
		let metadataRows = '';

		const customFields = (customModule && customModule.fields) ? customModule.fields : [];
		const customFieldLabels = new Set(customFields.map((f: any) => f.label.toLowerCase()));

		if (customFields.length > 0) {
			for (const field of customFields) {
				const key = field.label;
				let value = '';
				for (const [k, v] of Object.entries(metadata)) {
					if (k.toLowerCase() === key.toLowerCase()) {
						value = v;
						break;
					}
				}

				if (field.type === 'switch') {
					metadataRows += `
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
							<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${field.label.toUpperCase()}</span>
							<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${value === 'true' ? 'Yes' : 'No'}</span>
							<div class="meta-edit-val" style="display: none; align-items: center; gap: 8px; padding: 4px 0;">
								<input type="checkbox" class="meta-input" data-key="${field.label}" ${value === 'true' ? 'checked' : ''} value="${value === 'true' ? 'true' : 'false'}" onchange="this.value = this.checked ? 'true' : 'false'" style="cursor: pointer;" />
								<span style="font-size: 0.9em; opacity: 0.85;">Enabled</span>
							</div>
						</div>
					`;
				} else if (field.type === 'select') {
					const options = field.options || [];
					metadataRows += `
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
							<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${field.label.toUpperCase()}</span>
							<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${value}</span>
							<select class="meta-input meta-edit-val" data-key="${field.label}" style="display: none; background: rgba(255,255,255,0.02); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.06); padding: 5px 8px; border-radius: 4px; font-size: 0.9em; width: 100%; cursor: pointer;">
								${options.map((opt: string) => `<option value="${opt}" ${opt === value ? 'selected' : ''}>${opt}</option>`).join('')}
							</select>
						</div>
					`;
				} else if (field.type === 'multiselect') {
					const options = field.options || [];
					metadataRows += `
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
							<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${field.label.toUpperCase()}</span>
							<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${value || 'None'}</span>
							<div class="meta-edit-val" style="display: none; flex-direction: column; gap: 4px; padding: 4px 0;">
								<input type="hidden" class="meta-input" data-key="${field.label}" id="multiselect-${field.id}" value="${value}" />
								${options.map((opt: string) => {
									const isChecked = value.split(',').map(s => s.trim()).includes(opt);
									return `
										<label style="display: flex; align-items: center; gap: 6px; font-size: 0.9em; cursor: pointer; margin-bottom: 2px;">
											<input type="checkbox" class="multiselect-checkbox-${field.id}" value="${opt}" ${isChecked ? 'checked' : ''} onchange="
												const checked = Array.from(document.querySelectorAll('.multiselect-checkbox-${field.id}:checked')).map(cb => cb.value);
												document.getElementById('multiselect-${field.id}').value = checked.join(', ');
											" />
											<span>${opt}</span>
										</label>
									`;
								}).join('')}
							</div>
						</div>
					`;
				} else if (field.type === 'textarea') {
					metadataRows += `
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
							<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${field.label.toUpperCase()}</span>
							<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground); white-space: pre-wrap;">${value}</span>
							<textarea class="meta-input meta-edit-val" data-key="${field.label}" style="display: none; background: rgba(255,255,255,0.02); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.06); padding: 5px 8px; border-radius: 4px; font-size: 0.9em; width: 100%; min-height: 50px; resize: vertical; font-family: inherit;">${value}</textarea>
						</div>
					`;
				} else {
					metadataRows += `
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
							<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${field.label.toUpperCase()}</span>
							<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${value}</span>
							<input type="text" class="meta-input meta-edit-val" data-key="${field.label}" value="${value}" style="display: none; background: rgba(255,255,255,0.02); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.06); padding: 5px 8px; border-radius: 4px; font-size: 0.9em; width: 100%;" />
						</div>
					`;
				}
			}
		}

		for (const [key, value] of Object.entries(metadata)) {
			const keyLower = key.toLowerCase();
			if (keyLower === 'status') {
				continue; // rendered separately at the top
			}
			if (keyLower === 'entity type') {
				continue; // Removed to avoid redundancy with the main badge
			}
			if (customFieldLabels.has(keyLower)) {
				continue; // already rendered as custom field
			}

			if (keyLower === 'priority') {
				const pColors: { [key: string]: string } = {
					'very high': '#f43f5e',
					'high': '#fb923c',
					'medium': '#38bdf8',
					'low': '#34d399',
					'very low': '#2dd4bf'
				};
				const pColor = pColors[value.toLowerCase()] || '#94a3b8';
				metadataRows += `
					<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
						<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">PRIORITY</span>
						<div style="display: flex; align-items: center; gap: 6px; padding: 4px 0;">
							<span style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: ${pColor}; box-shadow: 0 0 6px ${pColor}80;"></span>
							<span style="font-size: 0.9em; font-weight: 700; color: ${pColor};">${value}</span>
						</div>
					</div>
				`;
				continue;
			}
			const isReadOnly = ['workspace id', 'ticket id', 'ticket type', 'created at', 'belongs to workspace uri', 'target project', 'git', 'entity code', 'owner account', 'created by', 'scope type', 'scope name', 'role', 'model'].includes(keyLower);
			let displayValue = value;
			if (keyLower === 'scope type' && displayValue) {
				displayValue = displayValue.charAt(0).toUpperCase() + displayValue.slice(1);
			}
			if (keyLower === 'ticket id' && (type === 'workspace' || !displayValue.includes('-'))) {
				const wsIdVal = metadata['Workspace ID'] || metadata['workspace id'];
				if (wsIdVal && wsIdVal !== 'None' && type === 'workspace') {
					displayValue = wsIdVal;
				}
			}
			if (isReadOnly) {
				metadataRows += `
					<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
						<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${key.toUpperCase()}</span>
						<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${displayValue}</span>
					</div>
				`;
			} else {
				metadataRows += `
					<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
						<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${key.toUpperCase()}</span>
						<span class="meta-view-val" style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${displayValue}</span>
						<input type="text" class="meta-input meta-edit-val" data-key="${key}" value="${displayValue}" style="display: none; background: rgba(255,255,255,0.02); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.06); padding: 5px 8px; border-radius: 4px; font-size: 0.9em; width: 100%; transition: border 0.2s;" />
					</div>
				`;
			}
		}

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
						padding: 24px;
						box-sizing: border-box;
						overflow-y: auto;
					}
					* {
						box-sizing: border-box;
					}
					.layout-container {
						display: flex;
						gap: 30px;
						max-width: 1200px;
						margin: 0 auto;
					}
					.main-content {
						flex: 1;
						display: flex;
						flex-direction: column;
						gap: 24px;
					}
					.sidebar {
						width: 300px;
						flex-shrink: 0;
						background: rgba(255,255,255,0.02);
						border: 1px solid rgba(255,255,255,0.05);
						border-radius: 8px;
						padding: 20px;
						height: fit-content;
						position: sticky;
						top: 0;
						backdrop-filter: blur(8px);
						box-shadow: 0 4px 12px rgba(0,0,0,0.1);
					}
					.badge {
						display: inline-block;
						padding: 3px 8px;
						border-radius: 4px;
						font-size: 0.75em;
						font-weight: 700;
						letter-spacing: 0.05em;
						margin-bottom: 8px;
					}
					.btn-primary {
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						padding: 6px 14px;
						border-radius: 4px;
						cursor: pointer;
						font-weight: 600;
						font-size: 0.85em;
						transition: background 0.2s;
					}
					.btn-primary:hover {
						background: var(--vscode-button-hoverBackground);
					}
					.btn-secondary {
						background: rgba(255,255,255,0.08);
						color: var(--vscode-foreground);
						border: 1px solid rgba(255,255,255,0.1);
						padding: 6px 14px;
						border-radius: 4px;
						cursor: pointer;
						font-weight: 500;
						font-size: 0.85em;
						transition: background 0.2s;
					}
					.btn-secondary:hover {
						background: rgba(255,255,255,0.15);
					}
					.btn-danger {
						background: rgba(211,47,47,0.15);
						color: #ff5252;
						border: 1px solid rgba(211,47,47,0.25);
						padding: 6px 14px;
						border-radius: 4px;
						cursor: pointer;
						font-weight: 500;
						font-size: 0.85em;
						transition: background 0.2s;
					}
					.btn-danger:hover {
						background: rgba(211,47,47,0.25);
					}
					.input-field {
						background: var(--vscode-input-background, #252526);
						color: var(--vscode-input-foreground, #ccc);
						border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
						padding: 8px 12px;
						border-radius: 4px;
						width: 100%;
						font-family: var(--vscode-font-family);
						font-size: 0.95em;
						line-height: 1.5;
						resize: vertical;
					}
					.input-field:focus {
						outline: 1px solid var(--vscode-focusBorder, #007acc);
						border-color: var(--vscode-focusBorder, #007acc);
					}
					.meta-input:focus {
						outline: 1px solid var(--vscode-focusBorder, #007acc);
						border-color: var(--vscode-focusBorder, #007acc);
					}
					.section-card {
						background: rgba(255,255,255,0.01);
						border: 1px solid rgba(255,255,255,0.04);
						border-radius: 8px;
						padding: 16px 20px;
					}
					.section-title {
						font-size: 1.1em;
						font-weight: 600;
						margin: 0 0 12px 0;
						color: var(--vscode-editor-foreground, #eee);
						display: flex;
						justify-content: space-between;
						align-items: center;
					}
					.accordion-header {
						background: rgba(255,255,255,0.02);
						border: 1px solid rgba(255,255,255,0.05);
						border-radius: 6px;
						padding: 12px 16px;
						cursor: pointer;
						font-weight: 600;
						display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 6px;
						transition: background 0.2s;
					}
					.accordion-header:hover {
						background: rgba(255,255,255,0.05);
					}
					.accordion-content {
						display: none;
						padding: 12px 16px;
						background: rgba(0,0,0,0.1);
						border-radius: 0 0 6px 6px;
						border: 1px solid rgba(255,255,255,0.03);
						border-top: none;
						margin-bottom: 12px;
					}
					.dropzone {
						border: 2px dashed rgba(255,255,255,0.12);
						border-radius: 6px;
						padding: 24px;
						text-align: center;
						cursor: pointer;
						transition: border 0.2s, background 0.2s;
						background: rgba(255,255,255,0.005);
					}
					.dropzone.dragover {
						border-color: var(--vscode-focusBorder);
						background: rgba(0,122,204,0.05);
					}
				</style>
			</head>
			<body>
				<div class="layout-container">
					<div class="main-content">
						<!-- Title & Header -->
						<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
							<h1 style="margin: 0; font-size: 1.7em; font-weight: bold; color: var(--vscode-editor-foreground, #fff); line-height: 1.2;">${cleanTitle}</h1>
						</div>

						<!-- Description Card -->
						<div class="section-card">
							<div class="section-title">
								<span>Description</span>
								<button id="edit-desc-btn" onclick="startEditDesc()" class="btn-secondary" style="display: none; padding: 3px 8px; font-size: 0.8em;">Edit</button>
							</div>
							
							<div id="desc-view-mode" style="white-space: pre-wrap; line-height: 1.6; opacity: 0.9;">
								${description || '<span style="opacity: 0.5; font-style: italic;">No description provided. Click Edit to add one.</span>'}
							</div>
							
							<div id="desc-edit-mode" style="display: none;">
								<textarea id="desc-textarea" class="input-field" rows="6">${description}</textarea>
								<div style="display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;">
									<button onclick="cancelEditDesc()" class="btn-secondary">Cancel</button>
									<button onclick="saveDesc()" class="btn-primary">Save</button>
								</div>
							</div>
						</div>

						<!-- Collapsible Documents (README / Instruction) (Moved up) -->
						<div>
							<div class="accordion-header" onclick="toggleAccordion('readme-acc')">
								<span>Overview (README)</span>
								<span id="readme-acc-icon">▶</span>
							</div>
							<div id="readme-acc" class="accordion-content">
								${readmeHtml}
							</div>

							<div class="accordion-header" onclick="toggleAccordion('inst-acc')">
								<span>Instructions & Run Commands</span>
								<span id="inst-acc-icon">▶</span>
							</div>
							<div id="inst-acc" class="accordion-content">
								${instructionHtml}
							</div>
						</div>

						<!-- Attachments Card -->
						<div class="section-card">
							<div class="section-title">Attachments</div>
							<div id="attachment-dropzone" class="dropzone" onclick="triggerBrowse()">
								<span style="font-size: 1.5em; display: block; margin-bottom: 6px;">📥</span>
								<span style="font-size: 0.9em; opacity: 0.7;">Drag and drop files here or click to upload</span>
								<input type="file" id="file-input" style="display: none;" onchange="handleBrowseUpload(event)" />
							</div>
							<div id="attachments-container">
								${attachmentsHtml}
							</div>
						</div>

						<!-- Work Logs Card (Moved to bottom) -->
						<div class="section-card">
							<div class="section-title">
								<span>Work Logs Timeline</span>
								<button id="add-log-btn" onclick="showAddLogModal()" class="btn-primary" style="display: none; padding: 3px 8px; font-size: 0.8em;">Add Log</button>
							</div>
							
							<!-- Add Log Box -->
							<div id="add-log-box" style="display: none; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 15px;">
								<textarea id="log-textarea" class="input-field" rows="3" placeholder="Enter work log description..."></textarea>
								<div style="display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;">
									<button onclick="hideAddLogModal()" class="btn-secondary">Cancel</button>
									<button onclick="submitLog()" class="btn-primary">Add Log</button>
								</div>
							</div>

							<div id="work-logs-container">
								${workLogHtml}
							</div>
						</div>
					</div>

					<!-- Metadata Sidebar -->
					<div class="sidebar">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
							<div style="display: flex; align-items: center; gap: 8px;">
								<h3 style="margin: 0; font-size: 1.05em; font-weight: bold; color: var(--vscode-editor-foreground);">Details</h3>
								<button id="toggle-edit-mode-btn" onclick="toggleEditMode()" class="btn-secondary" style="padding: 2px 6px; font-size: 0.8em;">Edit</button>
							</div>
							<span class="badge" style="background: ${colorSetting.bg}; color: ${colorSetting.text}; margin: 0; font-size: 0.7em; padding: 3px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">${typeUpper}</span>
						</div>
						
						<!-- Status selection -->
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px;">
							<span style="font-size: 0.8em; opacity: 0.6; font-weight: 600; letter-spacing: 0.03em;">STATUS</span>
							<div style="padding: 4px 0;">
								<span id="status-view-val" style="display: inline-block; font-size: 0.9em; font-weight: 700; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder}; padding: 4px 10px; border-radius: 6px;">${status}</span>
							</div>
							<select id="status-select" onchange="onStatusChange()" style="display: none; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 0.88em; width: 100%; cursor: pointer; transition: all 0.2s ease;">
								<option value="Todo" ${status.toLowerCase() === 'todo' ? 'selected' : ''} style="background: #1e1b4b; color: #818cf8; font-weight: 700; padding: 8px;">Todo</option>
								<option value="In Progress" ${status.toLowerCase().includes('progress') ? 'selected' : ''} style="background: #0c4a6e; color: #38bdf8; font-weight: 700; padding: 8px;">In Progress</option>
								<option value="Done" ${status.toLowerCase().includes('done') || status.toLowerCase().includes('complete') ? 'selected' : ''} style="background: #064e3b; color: #34d399; font-weight: 700; padding: 8px;">Done</option>
								<option value="Blocked" ${status.toLowerCase().includes('block') ? 'selected' : ''} style="background: #4c0519; color: #f43f5e; font-weight: 700; padding: 8px;">Blocked</option>
							</select>
						</div>

						${metadataRows}

						<button id="save-metadata-btn" onclick="saveAllMetadata()" class="btn-primary" style="display: none; width: 100%; margin-top: 15px; padding: 8px;">Save</button>
					</div>
				</div>

				<script>
					const vscode = acquireVsCodeApi();

					// Cache full metadata dictionary to preserve read-only values on write
					let currentMetadata = ${JSON.stringify(metadata)};

					// 1. Description edit mode toggle
					function startEditDesc() {
						document.getElementById('desc-view-mode').style.display = 'none';
						document.getElementById('desc-edit-mode').style.display = 'block';
						document.getElementById('edit-desc-btn').style.display = 'none';
						document.getElementById('desc-textarea').focus();
					}

					function cancelEditDesc() {
						document.getElementById('desc-view-mode').style.display = 'block';
						document.getElementById('desc-edit-mode').style.display = 'none';
						document.getElementById('edit-desc-btn').style.display = 'block';
					}

					function saveDesc() {
						const newDesc = document.getElementById('desc-textarea').value;
						vscode.postMessage({
							type: 'saveDescription',
							description: newDesc
						});
					}

					// 2. Metadata Updates
					function onStatusChange() {
						const select = document.getElementById('status-select');
						const status = select.value.toLowerCase();
						if (status.includes('progress')) {
							select.style.background = 'rgba(56, 189, 248, 0.18)';
							select.style.color = '#38bdf8';
							select.style.borderColor = 'rgba(56, 189, 248, 0.4)';
						} else if (status.includes('done') || status.includes('complete') || status.includes('approved')) {
							select.style.background = 'rgba(52, 211, 153, 0.18)';
							select.style.color = '#34d399';
							select.style.borderColor = 'rgba(52, 211, 153, 0.4)';
						} else if (status.includes('block') || status.includes('fail') || status.includes('cancel')) {
							select.style.background = 'rgba(244, 63, 94, 0.18)';
							select.style.color = '#f43f5e';
							select.style.borderColor = 'rgba(244, 63, 94, 0.4)';
						} else if (status.includes('review') || status.includes('test') || status.includes('pending')) {
							select.style.background = 'rgba(251, 191, 36, 0.18)';
							select.style.color = '#fbbf24';
							select.style.borderColor = 'rgba(251, 191, 36, 0.4)';
						} else if (status.includes('todo') || status.includes('backlog')) {
							select.style.background = 'rgba(129, 140, 248, 0.18)';
							select.style.color = '#818cf8';
							select.style.borderColor = 'rgba(129, 140, 248, 0.4)';
						} else {
							select.style.background = 'rgba(148, 163, 184, 0.18)';
							select.style.color = '#94a3b8';
							select.style.borderColor = 'rgba(148, 163, 184, 0.4)';
						}
					}

					function saveAllMetadata() {
						currentMetadata['Status'] = document.getElementById('status-select').value;
						
						const inputs = document.querySelectorAll('.meta-input');
						inputs.forEach(input => {
							const key = input.getAttribute('data-key');
							currentMetadata[key] = input.value;
						});

						vscode.postMessage({
							type: 'saveMetadata',
							metadata: currentMetadata
						});
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

					// 4. Accordions
					function toggleAccordion(id) {
						const element = document.getElementById(id);
						const icon = document.getElementById(id + '-icon');
						if (element.style.display === 'block') {
							element.style.display = 'none';
							icon.textContent = '▶';
						} else {
							element.style.display = 'block';
							icon.textContent = '▼';
						}
					}

					// 5. Attachments drag and drop & upload
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

					// 6. Edit Mode Toggle
					let isEditMode = ${this._startInEditMode ? 'true' : 'false'};
					function toggleEditMode() {
						isEditMode = !isEditMode;
						const btn = document.getElementById('toggle-edit-mode-btn');
						if (isEditMode) {
							btn.innerText = 'Cancel';
							btn.classList.add('active');
							const editDescBtn = document.getElementById('edit-desc-btn');
							if (editDescBtn) editDescBtn.style.display = 'inline-block';
							const addLogBtn = document.getElementById('add-log-btn');
							if (addLogBtn) addLogBtn.style.display = 'inline-block';
							
							const statusView = document.getElementById('status-view-val');
							if (statusView) statusView.style.display = 'none';
							const statusSelect = document.getElementById('status-select');
							if (statusSelect) statusSelect.style.display = 'block';

							document.querySelectorAll('.meta-view-val').forEach(el => el.style.display = 'none');
							document.querySelectorAll('.meta-edit-val').forEach(el => el.style.display = 'block');
							document.getElementById('save-metadata-btn').style.display = 'block';
						} else {
							btn.innerText = 'Edit';
							btn.classList.remove('active');
							const editDescBtn = document.getElementById('edit-desc-btn');
							if (editDescBtn) editDescBtn.style.display = 'none';
							const addLogBtn = document.getElementById('add-log-btn');
							if (addLogBtn) addLogBtn.style.display = 'none';
							
							const descView = document.getElementById('desc-view-mode');
							if (descView) descView.style.display = 'block';
							const descEdit = document.getElementById('desc-edit-mode');
							if (descEdit) descEdit.style.display = 'none';
							
							hideAddLogModal();
							
							const statusView = document.getElementById('status-view-val');
							if (statusView) statusView.style.display = 'inline-block';
							const statusSelect = document.getElementById('status-select');
							if (statusSelect) statusSelect.style.display = 'none';

							document.querySelectorAll('.meta-view-val').forEach(el => el.style.display = 'block');
							document.querySelectorAll('.meta-edit-val').forEach(el => el.style.display = 'none');
							document.getElementById('save-metadata-btn').style.display = 'none';

							// Reset inputs to original values
							const inputs = document.querySelectorAll('.meta-input');
							inputs.forEach(input => {
								const key = input.getAttribute('data-key');
								if (key) {
									const val = currentMetadata[key] || '';
									if (input.type === 'checkbox') {
										input.checked = (val === 'true');
										input.value = val;
									} else {
										input.value = val;
									}
								}
							});

							const multiselects = document.querySelectorAll('[id^="multiselect-"]');
							multiselects.forEach(hiddenInput => {
								const key = hiddenInput.getAttribute('data-key');
								const val = currentMetadata[key] || '';
								hiddenInput.value = val;
								const fid = hiddenInput.id.replace('multiselect-', '');
								const valList = val.split(',').map(s => s.trim());
								document.querySelectorAll('.multiselect-checkbox-' + fid).forEach(cb => {
									cb.checked = valList.includes(cb.value);
								});
							});
						}
					}

					// Auto trigger edit mode on startup if requested
					if (isEditMode) {
						isEditMode = false; // reset so toggleEditMode sets it to true
						toggleEditMode();
					}
				</script>
			</body>
			</html>
		`;
	}
}
