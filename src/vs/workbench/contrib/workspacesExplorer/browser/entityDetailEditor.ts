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
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { dirname } from '../../../../base/common/resources.js';

export class EntityDetailEditor extends EditorPane {
	static readonly ID = 'workbench.editor.entityDetail';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private readonly _contentDisposables = this._register(new DisposableStore());

	private _entityUri: URI | undefined;
	private _entityName: string = '';
	private _entityType: string = 'task';

	private _entityFileUri: URI | undefined;
	private _instructionUri: URI | undefined;
	private _readmeUri: URI | undefined;
	private _workLogUri: URI | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super(EntityDetailEditor.ID, group, telemetryService, themeService, storageService);
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
			{ name: 'workflow.md', type: 'workflow' }
		];

		this._entityType = 'task';
		this._entityFileUri = URI.joinPath(agentsDir, 'task.md');

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

		this._instructionUri = await this._resolveFileUri(this._entityUri, 'instruction.md');
		this._readmeUri = await this._resolveFileUri(this._entityUri, 'README.md');
		this._workLogUri = await this._resolveFileUri(this._entityUri, 'work_log.md');

		// 2. Load contents
		const entityContent = await this._safeReadFile(this._entityFileUri);
		const parsed = this._parseEntityFile(entityContent);

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

		const html = this._generateHtml(parsed.title || this._entityName, this._entityType, parsed.metadata, parsed.description, readmeContent, instructionContent, workLogContent, attachments);
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
			} catch {}
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
			if (line.startsWith('## Metadata') || line.startsWith('## 基本元数据')) {
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
			
			if (line.startsWith('## Metadata') || line.startsWith('## 基本元数据')) {
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
			newLines.push('## Metadata');
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
		} catch {}
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

		// Process headings
		html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 14px 0 6px 0; color: var(--vscode-editor-foreground); font-weight: 600;">$1</h4>');
		html = html.replace(/^## (.*$)/gim, '<h3 style="margin: 20px 0 10px 0; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--vscode-editor-foreground); font-weight: 600;">$1</h3>');
		html = html.replace(/^# (.*$)/gim, '<h2 style="margin: 24px 0 12px 0; color: var(--vscode-editor-foreground); font-weight: bold;">$1</h2>');

		// Process bold and code blocks
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.06); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 0.9em; border: 1px solid rgba(255,255,255,0.05);">$1</code>');

		// Process lists
		html = html.replace(/^\s*-\s+(.*$)/gim, '<li style="margin-left: 20px; margin-bottom: 6px; line-height: 1.5;">$1</li>');
		html = html.replace(/^\s*\*\s+(.*$)/gim, '<li style="margin-left: 20px; margin-bottom: 6px; line-height: 1.5;">$1</li>');

		// Wrap lines in paragraphs if they are not headings, lists, or tables
		const lines = html.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line && !line.startsWith('<h') && !line.startsWith('<li') && !line.startsWith('<ul') && !line.startsWith('<ol') && !line.startsWith('<code') && !line.startsWith('---')) {
				lines[i] = `<p style="margin: 8px 0; line-height: 1.6; opacity: 0.95;">${lines[i]}</p>`;
			} else if (line === '---') {
				lines[i] = '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 20px 0;" />';
			}
		}

		return lines.join('\n');
	}

	private _generateHtml(title: string, type: string, metadata: { [key: string]: string }, description: string, readme: string, instruction: string, workLog: string, attachments: string[]): string {
		const typeUpper = type.toUpperCase();
		
		// 1. Clean Title (remove trailing parenthesis tags like (JOB), (TASK) etc.)
		const cleanTitle = title.replace(/\s*\((job|task|project|workspace|agent|workflow|case|issue|analysis)\)/i, '');

		// 2. Map Status type to badge styles
		const status = metadata['Status'] || metadata['status'] || 'Todo';
		let statusColor = '#818cf8';
		let statusBg = 'rgba(129, 140, 248, 0.18)';
		let statusBorder = 'rgba(129, 140, 248, 0.4)';
		if (status.toLowerCase().includes('progress')) {
			statusColor = '#38bdf8';
			statusBg = 'rgba(56, 189, 248, 0.18)';
			statusBorder = 'rgba(56, 189, 248, 0.4)';
		} else if (status.toLowerCase().includes('done') || status.toLowerCase().includes('complete') || status.toLowerCase().includes('approved')) {
			statusColor = '#34d399';
			statusBg = 'rgba(52, 211, 153, 0.18)';
			statusBorder = 'rgba(52, 211, 153, 0.4)';
		} else if (status.toLowerCase().includes('block') || status.toLowerCase().includes('fail') || status.toLowerCase().includes('cancel')) {
			statusColor = '#f43f5e';
			statusBg = 'rgba(244, 63, 94, 0.18)';
			statusBorder = 'rgba(244, 63, 94, 0.4)';
		} else if (status.toLowerCase().includes('review') || status.toLowerCase().includes('test') || status.toLowerCase().includes('pending')) {
			statusColor = '#fbbf24';
			statusBg = 'rgba(251, 191, 36, 0.18)';
			statusBorder = 'rgba(251, 191, 36, 0.4)';
		}

		// 3. Map Badge color to matching color system
		const typeColors: { [key: string]: { text: string, bg: string } } = {
			'job': { text: '#eab308', bg: 'rgba(234, 179, 8, 0.15)' },
			'task': { text: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)' },
			'project': { text: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)' },
			'workflow': { text: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' },
			'case': { text: '#f97316', bg: 'rgba(249, 115, 22, 0.15)' },
			'agent': { text: '#ec4899', bg: 'rgba(236, 72, 153, 0.15)' },
			'issue': { text: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)' },
			'analysis': { text: '#06b6d4', bg: 'rgba(6, 182, 212, 0.15)' },
			'workspace': { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' }
		};
		const colorSetting = typeColors[type.toLowerCase()] || { text: '#808080', bg: 'rgba(128, 128, 128, 0.15)' };

		// Attachment cards html list
		let attachmentsHtml = '';
		if (attachments.length === 0) {
			attachmentsHtml = '<p style="opacity: 0.5; font-style: italic; font-size: 0.9em; text-align: center; padding: 20px 0;">No attachments uploaded yet. Drag files here!</p>';
		} else {
			attachmentsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 10px;">';
			for (const file of attachments) {
				const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file);
				const icon = isImage ? '📷' : '📄';
				attachmentsHtml += `
					<div class="attachment-card" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; min-height: 80px; transition: background 0.2s;">
						<div style="display: flex; align-items: center; gap: 8px;">
							<span style="font-size: 1.5em;">${icon}</span>
							<span style="font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;" title="${file}">${file}</span>
						</div>
						<div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px;">
							<button onclick="downloadFile('${file}')" class="btn-secondary" style="font-size: 0.8em; padding: 3px 8px;">Download</button>
							<button onclick="deleteFile('${file}')" class="btn-danger" style="font-size: 0.8em; padding: 3px 8px;">Delete</button>
						</div>
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
				if (header.toLowerCase() === 'metadata' || header.toLowerCase() === '基本元数据') {
					header = 'Creation Details (创建信息)';
				}
				const body = lines.slice(1).join('\n').trim();
				workLogHtml += `
					<div class="timeline-item" style="position: relative;">
						<div class="timeline-dot" style="position: absolute; left: -27px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-button-background); border: 2px solid var(--vscode-editor-background);"></div>
						<div style="font-weight: 600; font-size: 0.9em; color: var(--vscode-editor-foreground); margin-bottom: 4px;">${header}</div>
						<div style="font-size: 0.85em; opacity: 0.8; line-height: 1.5; white-space: pre-wrap;">${body}</div>
					</div>
				`;
			}
			workLogHtml += '</div>';
		}

		// Metadata sidebar list (Make entity type, created at, entity code, owner account, created by read-only)
		let metadataRows = '';
		for (const [key, value] of Object.entries(metadata)) {
			const keyLower = key.toLowerCase();
			if (keyLower === 'status') {
				continue; // rendered separately at the top
			}
			if (keyLower === 'entity type') {
				continue; // Removed to avoid redundancy with the main badge
			}
			const isReadOnly = ['created at', 'belongs to workspace uri', 'target project', 'git', 'entity code', 'owner account', 'created by'].includes(keyLower);
			if (isReadOnly) {
				metadataRows += `
					<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
						<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${key.toUpperCase()}</span>
						<span style="font-size: 0.9em; opacity: 0.95; padding: 4px 0; font-weight: 500; color: var(--vscode-editor-foreground);">${value}</span>
					</div>
				`;
			} else {
				metadataRows += `
					<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 8px;">
						<span style="font-size: 0.85em; opacity: 0.55; font-weight: 600; letter-spacing: 0.03em;">${key.toUpperCase()}</span>
						<input type="text" class="meta-input" data-key="${key}" value="${value}" style="background: rgba(255,255,255,0.02); color: var(--vscode-foreground); border: 1px solid rgba(255,255,255,0.06); padding: 5px 8px; border-radius: 4px; font-size: 0.9em; transition: border 0.2s;" />
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
								<button id="edit-desc-btn" onclick="startEditDesc()" class="btn-secondary" style="padding: 3px 8px; font-size: 0.8em;">Edit</button>
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
								<button onclick="showAddLogModal()" class="btn-primary" style="padding: 3px 8px; font-size: 0.8em;">Add Log</button>
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
							<h3 style="margin: 0; font-size: 1.05em; font-weight: bold; color: var(--vscode-editor-foreground);">Details</h3>
							<span class="badge" style="background: ${colorSetting.bg}; color: ${colorSetting.text}; margin: 0; font-size: 0.7em; padding: 3px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">${typeUpper}</span>
						</div>
						
						<!-- Status selection -->
						<div class="meta-row" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px;">
							<span style="font-size: 0.8em; opacity: 0.6; font-weight: 600; letter-spacing: 0.03em;">STATUS</span>
							<select id="status-select" onchange="onStatusChange()" style="background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; padding: 7px 12px; border-radius: 6px; font-weight: 700; font-size: 0.88em; width: 100%; cursor: pointer; transition: all 0.2s ease;">
								<option value="Todo" ${status.toLowerCase() === 'todo' ? 'selected' : ''} style="background: #1e1b4b; color: #818cf8; font-weight: 700; padding: 8px;">Todo</option>
								<option value="In Progress" ${status.toLowerCase().includes('progress') ? 'selected' : ''} style="background: #0c4a6e; color: #38bdf8; font-weight: 700; padding: 8px;">In Progress</option>
								<option value="Done" ${status.toLowerCase().includes('done') || status.toLowerCase().includes('complete') ? 'selected' : ''} style="background: #064e3b; color: #34d399; font-weight: 700; padding: 8px;">Done</option>
								<option value="Blocked" ${status.toLowerCase().includes('block') ? 'selected' : ''} style="background: #4c0519; color: #f43f5e; font-weight: 700; padding: 8px;">Blocked</option>
							</select>
						</div>

						${metadataRows}

						<button onclick="saveAllMetadata()" class="btn-primary" style="width: 100%; margin-top: 15px; padding: 8px;">Save</button>
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
				</script>
			</body>
			</html>
		`;
	}
}
