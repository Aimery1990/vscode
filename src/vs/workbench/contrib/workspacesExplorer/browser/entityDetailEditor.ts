/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode, Dimension, h } from '../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
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
import { EntityDetailEditorInput } from './entityDetailEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { dirname } from '../../../../base/common/resources.js';
import { IAgentsManagerService, IAgentItem } from '../../agentsManager/common/agentsManager.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspacesExplorerService } from '../common/workspacesExplorer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

const ttPolicy = createTrustedTypesPolicy('entityDetailEditor', { createHTML: (value: string) => value })
	|| createTrustedTypesPolicy('htmlToMarkdown', { createHTML: (value: string) => value });

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

	private _entityUri: URI | undefined;
	private _entityName: string = '';
	private _entityType: string = 'task';

	private _ticketFileUri: URI | undefined;
	private _instructionUri: URI | undefined;
	private _readmeUri: URI | undefined;
	private _workLogUri: URI | undefined;
	private _lastParsedData: IParsedTicketData | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IAgentsManagerService private readonly _agentsManagerService: IAgentsManagerService,
		@IWorkspacesExplorerService private readonly _workspacesExplorerService: IWorkspacesExplorerService,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService
	) {
		super(EntityDetailEditor.ID, group, telemetryService, themeService, _storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = h('div.entity-detail-editor').root;
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflowY = 'auto';
		this._container.style.overflowX = 'hidden';
		this._container.style.background = 'var(--vscode-editor-background)';
		this._container.style.color = 'var(--vscode-editor-foreground)';
		this._container.style.boxSizing = 'border-box';
		this._container.style.padding = '24px 32px';
		parent.appendChild(this._container);

		this._bindContainerEvents();
	}

	override layout(dimension: Dimension): void {
		// Native DOM in _container auto-sizes smoothly.
	}

	override async setInput(input: EntityDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this._entityUri = input.entityUri;
		this._entityName = input.entityName;

		await this._resolvePathsAndLoadData();
	}

	override clearInput(): void {
		if (this._container) {
			clearNode(this._container);
		}
		this._entityUri = undefined;
		this._lastParsedData = undefined;
		super.clearInput();
	}

	override dispose(): void {
		if (this._container) {
			clearNode(this._container);
			this._container = undefined;
		}
		super.dispose();
	}

	private _setElementHTML(element: HTMLElement, html: string): void {
		if (ttPolicy) {
			element.innerHTML = ttPolicy.createHTML(html) as unknown as string;
		} else {
			element.innerHTML = html;
		}
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this._entityUri) {
			this._resolvePathsAndLoadData();
		}
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
						try { val = JSON.parse(val); } catch { }
					}
					currentField = { [key]: val };
					currentFieldList.push(currentField);
				} else {
					let val = content;
					if (val.startsWith('"') && val.endsWith('"')) {
						try { val = JSON.parse(val); } catch { }
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
					try { val = JSON.parse(val); } catch { }
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

		try {
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
			this._lastParsedData = parsed;
			this._entityType = parsed.ticketType || 'task';

			const attachments = await this._getAttachments(this._entityUri);
			const customModule = await this._readCustomModule(this._entityUri, this._entityType);
			const agents = this._agentsManagerService ? await this._agentsManagerService.getAgents() : [];
			const allTickets = await this._loadAllAvailableTickets();

			// 3. Render directly into this._container as native high-performance DOM
			const html = this._generateHtml(parsed, workLogContent, attachments, customModule, agents, allTickets);
			this._setElementHTML(this._container, html);
		} catch (err) {
			console.error('Failed to resolve and render entity detail:', err);
		}
	}

	private _bindContainerEvents(): void {
		if (!this._container) return;

		this._container.addEventListener('click', async (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;

			// 1. AI Sparkle button click
			const aiBtn = target.closest('.ai-edit-btn') as HTMLElement | null;
			if (aiBtn) {
				e.preventDefault();
				e.stopPropagation();
				const field = aiBtn.getAttribute('data-ai-field') || '/Description';
				const fieldType = aiBtn.getAttribute('data-ai-field-type') || 'text';
				const label = aiBtn.getAttribute('data-ai-field-label') || '';
				const currentValue = aiBtn.getAttribute('data-ai-current-value') || '';
				const optionsRaw = aiBtn.getAttribute('data-ai-options') || '';
				let options: any[] = [];
				if (optionsRaw) {
					try { options = JSON.parse(optionsRaw); } catch { }
				}
				await this._handleMessage({
					type: 'openAgentCentral',
					field,
					fieldType,
					label,
					currentValue,
					options,
					source: field
				});
				return;
			}

			// 2. Ticket Link Chip click
			const ticketChip = target.closest('.ticket-link-chip') as HTMLElement | null;
			if (ticketChip) {
				const ticketId = ticketChip.getAttribute('data-ticket-id');
				if (ticketId) {
					e.preventDefault();
					e.stopPropagation();
					await this._handleMessage({ type: 'openTicket', ticketId });
					return;
				}
			}

			// 3. Add Work Log toggle button
			if (target.id === 'add-log-btn' || target.closest('#add-log-btn')) {
				const addLogBox = this._container?.querySelector('#add-log-box') as HTMLElement | null;
				const textarea = this._container?.querySelector('#log-textarea') as HTMLTextAreaElement | null;
				if (addLogBox) {
					addLogBox.style.display = 'block';
					textarea?.focus();
				}
				return;
			}

			// 4. Cancel Add Log
			if (target.id === 'cancel-log-btn' || target.closest('#cancel-log-btn')) {
				const addLogBox = this._container?.querySelector('#add-log-box') as HTMLElement | null;
				const textarea = this._container?.querySelector('#log-textarea') as HTMLTextAreaElement | null;
				if (addLogBox) {
					addLogBox.style.display = 'none';
					if (textarea) textarea.value = '';
				}
				return;
			}

			// 5. Submit Work Log
			if (target.id === 'submit-log-btn' || target.closest('#submit-log-btn')) {
				const textarea = this._container?.querySelector('#log-textarea') as HTMLTextAreaElement | null;
				const val = textarea?.value?.trim();
				if (val) {
					await this._handleMessage({ type: 'addWorkLog', log: val });
				}
				return;
			}

			// 6. Delete attachment
			const delAttachBtn = target.closest('.delete-attachment') as HTMLElement | null;
			if (delAttachBtn) {
				const fileName = delAttachBtn.getAttribute('data-file-name');
				if (fileName) {
					e.preventDefault();
					e.stopPropagation();
					if (confirm(`Are you sure you want to delete attachment '${fileName}'?`)) {
						await this._handleMessage({ type: 'deleteAttachment', name: fileName });
					}
					return;
				}
			}

			// 7. Download attachment
			const downloadAttachCard = target.closest('.attachment-card-download') as HTMLElement | null;
			if (downloadAttachCard) {
				const fileName = downloadAttachCard.getAttribute('data-file-name');
				if (fileName) {
					e.preventDefault();
					e.stopPropagation();
					await this._handleMessage({ type: 'downloadAttachment', name: fileName });
					return;
				}
			}

			// 8. Trigger File Upload Dropzone
			if (target.id === 'attachment-dropzone' || target.closest('#attachment-dropzone')) {
				if (!target.classList.contains('delete-attachment') && !target.closest('.delete-attachment')) {
					const fileInput = this._container?.querySelector('#file-input') as HTMLInputElement | null;
					fileInput?.click();
				}
				return;
			}

			// 9. Copy System Prompt
			const copyPromptBtn = target.closest('#copy-system-prompt-btn') as HTMLElement | null;
			if (copyPromptBtn) {
				const promptText = copyPromptBtn.getAttribute('data-prompt') || '';
				if (promptText) {
					await this._clipboardService.writeText(promptText);
					this._notificationService.info(localize('promptCopied', "System Prompt copied to clipboard!"));
				}
				return;
			}

			// 10. Assign Task to Agent
			const assignTaskBtn = target.closest('#agent-assign-task-btn') as HTMLElement | null;
			if (assignTaskBtn) {
				const agentId = assignTaskBtn.getAttribute('data-agent-id');
				const agentName = assignTaskBtn.getAttribute('data-agent-name') || this._lastParsedData?.title || 'AI Agent';
				if (agentId && this._agentsManagerService) {
					const taskTitle = await this._quickInputService.input({
						prompt: `Assign New Task to AI Agent '${agentName}'`,
						placeHolder: 'e.g. Implement user authentication, Refactor API response handler',
						validateInput: async (val) => val.trim() ? null : 'Task title cannot be empty'
					});
					if (taskTitle) {
						const taskDescription = await this._quickInputService.input({
							prompt: 'Enter Task Details & Requirements (Optional)',
							placeHolder: 'e.g. Ensure unit tests pass and work_log is updated.'
						});
						await this._agentsManagerService.assignTaskToAgent(agentId, taskTitle, taskDescription || '');
						this._notificationService.info(`Task '${taskTitle}' assigned to Agent '${agentName}'! Logged in work_log.md.`);
						await this._resolvePathsAndLoadData();
					}
				}
				return;
			}
		});

		this._container.addEventListener('change', async (e: Event) => {
			const target = e.target as HTMLInputElement | null;
			if (target && target.id === 'file-input' && target.files && target.files.length > 0) {
				const file = target.files[0];
				const buffer = await file.arrayBuffer();
				await this._handleMessage({
					type: 'uploadAttachment',
					name: file.name,
					data: Array.from(new Uint8Array(buffer))
				});
			}
		});

		this._container.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			const dropzone = this._container?.querySelector('#attachment-dropzone') as HTMLElement | null;
			dropzone?.classList.add('dragover');
		});

		this._container.addEventListener('dragleave', (e: DragEvent) => {
			const dropzone = this._container?.querySelector('#attachment-dropzone') as HTMLElement | null;
			dropzone?.classList.remove('dragover');
		});

		this._container.addEventListener('drop', async (e: DragEvent) => {
			e.preventDefault();
			const dropzone = this._container?.querySelector('#attachment-dropzone') as HTMLElement | null;
			dropzone?.classList.remove('dragover');
			if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
				const file = e.dataTransfer.files[0];
				const buffer = await file.arrayBuffer();
				await this._handleMessage({
					type: 'uploadAttachment',
					name: file.name,
					data: Array.from(new Uint8Array(buffer))
				});
			}
		});
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

	private _parseMetadata(content: string): { [key: string]: string } {
		const metadata: { [key: string]: string } = {};
		const lines = (content || '').split(/\r?\n/);
		for (const line of lines) {
			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match) {
				const key = match[1].trim();
				const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				metadata[key] = val;
			}
		}
		return metadata;
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

	private _escapeHtmlAttr(str: string | undefined): string {
		if (!str) return '';
		return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

	private _updateInstructionContent(content: string, updates: { [key: string]: string }): string {
		const lines = content.split(/\r?\n/);
		const newLines: string[] = [];
		let inMeta = true;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('---') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				inMeta = false;
			}

			if (inMeta) {
				const tpMatch = line.match(/^\s*-\s*\*\*Ticket Prompt\*\*:\s*(.*)$/i);
				if (tpMatch && updates['Ticket Prompt'] !== undefined) {
					newLines.push(`- **Ticket Prompt**: ${updates['Ticket Prompt']}`);
					continue;
				}
				const ttpMatch = line.match(/^\s*-\s*\*\*Ticket Type Prompt\*\*:\s*(.*)$/i);
				if (ttpMatch && updates['Ticket Type Prompt'] !== undefined) {
					newLines.push(`- **Ticket Type Prompt**: ${updates['Ticket Type Prompt']}`);
					continue;
				}
			}
			newLines.push(line);
		}

		if (updates['System Prompt'] !== undefined || updates['Instruction Notes'] !== undefined) {
			const notes = updates['System Prompt'] !== undefined ? updates['System Prompt'] : updates['Instruction Notes'];
			const sepIdx = newLines.findIndex(l => l.startsWith('---'));
			if (sepIdx !== -1) {
				newLines.splice(sepIdx + 1, newLines.length - (sepIdx + 1), '', notes);
			} else {
				newLines.push('', '---', '', notes);
			}
		}

		return newLines.join('\n');
	}

	private _extractEntityTitleAndSummary(
		meta: { [key: string]: string },
		readmeContent: string,
		fallbackName: string
	): { title: string; summary: string } {
		let title = '';
		let summary = '';

		// 1. Check title from metadata
		const rawTitle = meta['Title']?.trim();
		if (rawTitle && rawTitle !== 'None' && rawTitle !== 'null' && rawTitle !== fallbackName && rawTitle !== meta['Ticket ID']) {
			title = rawTitle;
		}

		// 2. Check title from README.md
		if (!title && readmeContent) {
			const lines = readmeContent.split(/\r?\n/);
			for (const line of lines) {
				const titleMatch = line.match(/^\s*-\s*\*\*Title\*\*:\s*(.*)$/i);
				if (titleMatch && titleMatch[1].trim() && titleMatch[1].trim() !== 'None') {
					const t = titleMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					if (t !== fallbackName && t !== meta['Ticket ID']) {
						title = t;
						break;
					}
				}
				const h1Match = line.match(/^#\s+(.+)$/);
				if (h1Match && h1Match[1].trim()) {
					const t = h1Match[1].trim();
					if (t !== fallbackName && t !== meta['Ticket ID']) {
						title = t;
						break;
					}
				}
			}
		}

		// 3. Summary from Description
		if (meta['Description'] && meta['Description'] !== 'None' && meta['Description'] !== 'null') {
			summary = meta['Description'].trim();
		}

		if (!summary && readmeContent) {
			const lines = readmeContent.split(/\r?\n/);
			for (const line of lines) {
				const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)$/i);
				if (descMatch && descMatch[1].trim() && descMatch[1].trim() !== 'None') {
					summary = descMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
					break;
				}
			}
			if (!summary) {
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.startsWith('`') && !trimmed.startsWith('---')) {
						summary = trimmed;
						break;
					}
				}
			}
		}

		// If title is missing or identical to fallbackName/Ticket ID, promote summary to title
		if (!title || title === fallbackName || title === meta['Ticket ID']) {
			if (summary) {
				title = summary;
				summary = '';
			} else {
				title = fallbackName.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			}
		}

		if (summary.length > 80) {
			summary = summary.substring(0, 77) + '...';
		}

		return { title, summary };
	}

	private async _loadAllAvailableTickets(): Promise<Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }>> {
		if (!this._workspacesExplorerService) return [];
		const result: Array<{ id: string; code: string; title: string; summary: string; type: string; workspaceId: string; workspaceName: string; uri: string }> = [];
		try {
			const workspaces = await this._workspacesExplorerService.getWorkspaces();
			const currentTicketId = this._lastParsedData?.ticketId || this._entityName || '';

			for (const ws of workspaces) {
				const wsTargetBase = ws.uri.path.endsWith('.code-workspace') ? dirname(ws.uri) : ws.uri;
				const wsName = ws.name || wsTargetBase.path.split('/').filter(Boolean).pop() || 'Workspace';

				// 1. Check workspace root ticket
				const wsTicketUri = await this._resolveFileUri(wsTargetBase, 'ticket.md');
				const wsReadmeUri = await this._resolveFileUri(wsTargetBase, 'README.md');
				if (wsTicketUri && (await this._fileService.exists(wsTicketUri))) {
					const content = await this._safeReadFile(wsTicketUri);
					const readmeContent = await this._safeReadFile(wsReadmeUri);
					const meta = this._parseMetadata(content);
					const tId = meta['Ticket ID'] || meta['Entity ID'] || ws.name;
					const rawCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'];
					const tCode = (rawCode && rawCode !== 'None') ? rawCode : tId;
					const { title: tTitle, summary: tSummary } = this._extractEntityTitleAndSummary(meta, readmeContent, ws.name);
					const tType = meta['Ticket Type'] || meta['Entity Type'] || 'workspace';
					if (tId && tId !== currentTicketId && !result.some(r => r.id === tId)) {
						result.push({
							id: tId,
							code: tCode,
							title: tTitle,
							summary: tSummary,
							type: tType,
							workspaceId: meta['Workspace ID'] || ws.name,
							workspaceName: wsName,
							uri: wsTargetBase.toString()
						});
					}
				}

				// 2. Scan children of workspace
				const children = await this._workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'file') continue;
					const childTicketUri = await this._resolveFileUri(child.uri, 'ticket.md');
					const childReadmeUri = await this._resolveFileUri(child.uri, 'README.md');
					if (childTicketUri && (await this._fileService.exists(childTicketUri))) {
						const content = await this._safeReadFile(childTicketUri);
						const readmeContent = await this._safeReadFile(childReadmeUri);
						const meta = this._parseMetadata(content);
						const tId = meta['Ticket ID'] || meta['Entity ID'] || child.name;
						const rawCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'];
						const tCode = (rawCode && rawCode !== 'None') ? rawCode : tId;
						const { title: tTitle, summary: tSummary } = this._extractEntityTitleAndSummary(meta, readmeContent, child.name);
						const tType = meta['Ticket Type'] || meta['Entity Type'] || child.type || 'task';
						if (tId && tId !== currentTicketId && !result.some(r => r.id === tId)) {
							result.push({
								id: tId,
								code: tCode,
								title: tTitle,
								summary: tSummary,
								type: tType,
								workspaceId: meta['Workspace ID'] || ws.name,
								workspaceName: wsName,
								uri: child.uri.toString()
							});
						}
					}
				}
			}
		} catch (err) {
			console.error('Failed to load available tickets:', err);
		}
		return result;
	}

	private async _findTicketUriById(targetId: string): Promise<URI | undefined> {
		if (!this._workspacesExplorerService || !targetId) return undefined;
		const query = targetId.trim();
		try {
			const workspaces = await this._workspacesExplorerService.getWorkspaces();
			for (const ws of workspaces) {
				const wsTargetBase = ws.uri.path.endsWith('.code-workspace') ? dirname(ws.uri) : ws.uri;
				const wsTicketUri = await this._resolveFileUri(wsTargetBase, 'ticket.md');
				if (wsTicketUri && (await this._fileService.exists(wsTicketUri))) {
					const content = await this._safeReadFile(wsTicketUri);
					const meta = this._parseMetadata(content);
					const tId = meta['Ticket ID'] || meta['Entity ID'] || ws.name;
					const tCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'] || tId;
					if (tId === query || tCode === query || ws.name === query) {
						return wsTicketUri;
					}
				}

				const children = await this._workspacesExplorerService.scanWorkspaceChildren(ws.uri);
				for (const child of children) {
					if (child.type === 'file') continue;
					const childTicketUri = await this._resolveFileUri(child.uri, 'ticket.md');
					if (childTicketUri && (await this._fileService.exists(childTicketUri))) {
						const content = await this._safeReadFile(childTicketUri);
						const meta = this._parseMetadata(content);
						const tId = meta['Ticket ID'] || meta['Entity ID'] || child.name;
						const tCode = meta['Ticket Code'] || meta['Entity Code'] || meta['Code'] || tId;
						if (tId === query || tCode === query || child.name === query) {
							return childTicketUri;
						}
					}
				}
			}
		} catch (err) {
			console.error(`Failed to find ticket URI for id ${targetId}:`, err);
		}
		return undefined;
	}

	private async _syncBidirectionalLinks(sourceTicketId: string, oldLinkToRaw: string, newLinkToRaw: string): Promise<void> {
		if (!sourceTicketId) return;

		const parseList = (raw: string | undefined): string[] => {
			if (!raw) return [];
			return raw.split(/[,;\n]+/)
				.map(s => s.trim())
				.filter(s => s && s !== 'None' && s !== 'null' && s !== 'undefined' && s !== 'Unassigned');
		};

		const oldList = parseList(oldLinkToRaw);
		const newList = parseList(newLinkToRaw);

		const added = newList.filter(id => !oldList.includes(id));
		const removed = oldList.filter(id => !newList.includes(id));

		if (added.length === 0 && removed.length === 0) {
			return;
		}

		// 1. For each added target, add sourceTicketId to target's Linked By
		for (const targetId of added) {
			const targetUri = await this._findTicketUriById(targetId);
			if (targetUri && (await this._fileService.exists(targetUri))) {
				try {
					const content = await this._safeReadFile(targetUri);
					const meta = this._parseMetadata(content);
					const existingLinkedBy = parseList(meta['Linked By']);
					if (!existingLinkedBy.includes(sourceTicketId)) {
						existingLinkedBy.push(sourceTicketId);
						const updatedLinkedBy = existingLinkedBy.join(', ');
						const newContent = this._updateTicketMdContent(content, { 'Linked By': updatedLinkedBy });
						await this._fileService.writeFile(targetUri, VSBuffer.fromString(newContent));
					}
				} catch (err) {
					console.error(`Failed to sync Linked By to target ${targetId}:`, err);
				}
			}
		}

		// 2. For each removed target, remove sourceTicketId from target's Linked By
		for (const targetId of removed) {
			const targetUri = await this._findTicketUriById(targetId);
			if (targetUri && (await this._fileService.exists(targetUri))) {
				try {
					const content = await this._safeReadFile(targetUri);
					const meta = this._parseMetadata(content);
					const existingLinkedBy = parseList(meta['Linked By']);
					const filtered = existingLinkedBy.filter(id => id !== sourceTicketId);
					const updatedLinkedBy = filtered.length > 0 ? filtered.join(', ') : 'None';
					const newContent = this._updateTicketMdContent(content, { 'Linked By': updatedLinkedBy });
					await this._fileService.writeFile(targetUri, VSBuffer.fromString(newContent));
				} catch (err) {
					console.error(`Failed to remove Linked By from target ${targetId}:`, err);
				}
			}
		}
	}

	private _getTypeColorInfo(typeStr: string | undefined): { text: string; bg: string; border: string } {
		const typeLower = (typeStr || 'task').toLowerCase().trim();
		const typeColors: { [key: string]: { text: string; bg: string; border: string } } = {
			workspace: { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.2)', border: 'rgba(56, 189, 248, 0.35)' },
			job: { text: '#fbbf24', bg: 'rgba(251, 191, 36, 0.2)', border: 'rgba(251, 191, 36, 0.35)' },
			task: { text: '#a78bfa', bg: 'rgba(167, 139, 250, 0.2)', border: 'rgba(167, 139, 250, 0.35)' },
			project: { text: '#60a5fa', bg: 'rgba(96, 165, 250, 0.2)', border: 'rgba(96, 165, 250, 0.35)' },
			workflow: { text: '#0d9488', bg: 'rgba(13, 148, 136, 0.2)', border: 'rgba(13, 148, 136, 0.35)' },
			agent: { text: '#f472b6', bg: 'rgba(244, 114, 182, 0.2)', border: 'rgba(244, 114, 182, 0.35)' },
			case: { text: '#a3e635', bg: 'rgba(163, 230, 53, 0.2)', border: 'rgba(163, 230, 53, 0.35)' },
			issue: { text: '#ef4444', bg: 'rgba(239, 68, 68, 0.2)', border: 'rgba(239, 68, 68, 0.35)' },
			analysis: { text: '#34d399', bg: 'rgba(52, 211, 153, 0.2)', border: 'rgba(52, 211, 153, 0.35)' },
			note: { text: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.2)', border: 'rgba(45, 212, 191, 0.35)' },
			resume: { text: '#34d399', bg: 'rgba(52, 211, 153, 0.2)', border: 'rgba(52, 211, 153, 0.35)' }
		};

		if (typeColors[typeLower]) {
			return typeColors[typeLower];
		}

		const baseColor = getColorForName(typeLower);
		return {
			text: baseColor,
			bg: hexToRgba(baseColor, 0.2),
			border: hexToRgba(baseColor, 0.35)
		};
	}

	private _renderTicketChipsHtml(raw: string | undefined, allTickets: any[] = []): string {
		if (!raw || raw === 'None' || raw === 'Unassigned') {
			return '<span style="opacity:0.4; font-size: 0.88em;">None</span>';
		}
		const ids = raw.split(/[,;\n]+/).map(s => s.trim()).filter(s => s && s !== 'None' && s !== 'Unassigned');
		if (ids.length === 0) {
			return '<span style="opacity:0.4; font-size: 0.88em;">None</span>';
		}
		return ids.map(id => {
			const matched = allTickets.find(t => t.id === id || t.code === id);
			const typeLower = (matched?.type || 'task').toLowerCase();
			const colorInfo = this._getTypeColorInfo(typeLower);
			const typeBadge = matched?.type ? `<span style="font-size: 8px; padding: 1px 4px; border-radius: 3px; background: ${colorInfo.bg}; color: ${colorInfo.text}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;">${this._escapeHtmlAttr(matched.type)}</span>` : '';
			const tooltip = matched ? `${matched.id} [${(matched.type || 'task').toUpperCase()}]: ${matched.title || ''}\n${matched.summary || ''}` : `Ticket ${id}`;

			return `
			<span class="ticket-link-chip" data-ticket-id="${this._escapeHtmlAttr(id)}" style="display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 600; font-family: monospace; padding: 2px 7px; border-radius: 3px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: ${colorInfo.text}; cursor: pointer; transition: all 0.15s ease;" title="${this._escapeHtmlAttr(tooltip)}">
				${typeBadge}
				<span>${this._escapeHtmlAttr(id)}</span>
			</span>
		`;
		}).join('');
	}

	private _buildHierarchyTree(data: IParsedTicketData | undefined, agents: any[], allTickets: any[] = []): any[] {
		if (!data) return [];
		const rootNodes: any[] = [];

		// 1. Title
		rootNodes.push({
			path: '/Title',
			label: 'Title',
			fieldType: 'text',
			currentValue: data.title || ''
		});

		// 2. Description
		rootNodes.push({
			path: '/Description',
			label: 'Description',
			fieldType: 'textarea',
			currentValue: data.description || ''
		});

		// 3. Instructions
		const isAgent = (data.ticketType || '').toLowerCase() === 'agent';
		const matchingAgent = agents.find(a =>
			(this._entityUri && a.folderPath && (a.folderPath === this._entityUri.fsPath || a.folderPath.toLowerCase() === this._entityUri.fsPath.toLowerCase())) ||
			(a.name.toLowerCase() === (data.title || '').toLowerCase()) ||
			(a.name.toLowerCase() === (data.ticketId || '').toLowerCase()) ||
			(a.name.toLowerCase() === this._entityName.toLowerCase())
		);

		const agentModel = matchingAgent?.model?.modelId || data.metadata['Model Name'] || data.metadata['AI Model'] || data.metadata['Model'] || 'gemini-1.5-flash';
		const agentPrompt = matchingAgent?.systemPrompt || data.metadata['System Prompt'] || data.instructionNotes || data.ticketPrompt || '';
		const agentRole = matchingAgent?.role || data.metadata['Role'] || data.description || 'AI Agent';

		const instructionChildren: any[] = [];
		if (isAgent) {
			instructionChildren.push({
				path: '/Instructions/System Prompt',
				label: 'System Prompt / Persona',
				fieldType: 'textarea',
				currentValue: agentPrompt
			});
		}
		instructionChildren.push(
			{
				path: '/Instructions/Ticket Prompt',
				label: isAgent ? 'Instance Rules / Ticket Prompt' : 'Ticket Prompt',
				fieldType: 'textarea',
				currentValue: data.ticketPrompt || ''
			},
			{
				path: '/Instructions/Ticket Type Prompt',
				label: isAgent ? 'System Type Prompt' : 'Ticket Type Prompt',
				fieldType: 'textarea',
				currentValue: data.metadata?.['Ticket Type Prompt'] || ''
			},
			{
				path: '/Instructions/Instruction Notes',
				label: 'Instruction Notes',
				fieldType: 'textarea',
				currentValue: data.instructionNotes || ''
			}
		);
		rootNodes.push({
			path: '/Instructions',
			label: isAgent ? 'Prompts & Instructions' : 'Instructions',
			fieldType: 'container',
			children: instructionChildren
		});

		// 4. Attributes
		const isAgentAssigned = !!(data.assignedAgentName && data.assignedAgentName !== 'None' && data.assignedAgentName !== 'Unassigned');
		const attrChildren: any[] = [
			{
				path: '/Attributes/Status',
				label: 'Status',
				fieldType: 'status',
				currentValue: data.status || 'Todo',
				options: isAgent ? ['idle', 'busy', 'offline', 'active'] : ['Todo', 'In Progress', 'Done', 'Blocked']
			},
			{
				path: '/Attributes/Priority',
				label: 'Priority',
				fieldType: 'priority',
				currentValue: data.priority || 'Medium',
				options: ['Low', 'Medium', 'High', 'Urgent']
			}
		];

		if (isAgent) {
			attrChildren.push(
				{
					path: '/Attributes/AI Model',
					label: 'AI Model',
					fieldType: 'text',
					currentValue: agentModel
				},
				{
					path: '/Attributes/Agent Role',
					label: 'Agent Role',
					fieldType: 'text',
					currentValue: agentRole
				}
			);
		} else {
			attrChildren.push({
				path: '/Attributes/Current AI Agent',
				label: 'Current AI Agent',
				fieldType: 'agent',
				currentValue: isAgentAssigned ? data.assignedAgentName : 'Unassigned',
				options: agents.map(a => ({ id: a.id, name: a.name }))
			});
		}

		attrChildren.push(
			{
				path: '/Attributes/Link To',
				label: 'Link To',
				fieldType: 'link_to',
				currentValue: data.linkTo && data.linkTo !== 'None' ? data.linkTo : 'None',
				options: allTickets
			},
			{
				path: '/Attributes/Linked By',
				label: 'Linked By',
				fieldType: 'read_only',
				currentValue: data.linkedBy && data.linkedBy !== 'None' ? data.linkedBy : 'None'
			}
		);
		rootNodes.push({
			path: '/Attributes',
			label: 'Attributes',
			fieldType: 'container',
			children: attrChildren
		});

		// 5. Custom Metadata
		if (data.customMetadata) {
			const customChildren: any[] = [];
			for (const [k, v] of Object.entries(data.customMetadata)) {
				let parsedItems: any[] | null = null;
				if (typeof v === 'string' && v.trim().startsWith('[')) {
					try {
						parsedItems = JSON.parse(v);
					} catch { }
				} else if (Array.isArray(v)) {
					parsedItems = v;
				}

				if (parsedItems && Array.isArray(parsedItems)) {
					const listItems: any[] = [];
					parsedItems.forEach((item, idx) => {
						const idxNum = item._index || (idx + 1);
						const itemTitle = item._title || `${k} #${idxNum}`;
						const itemFields: any[] = [];
						for (const [subK, subValRaw] of Object.entries(item)) {
							if (subK.startsWith('_')) continue;
							const rawStr = subValRaw !== undefined && subValRaw !== null ? String(subValRaw).trim() : '';
							const isSubEmpty = !rawStr || rawStr === 'None' || rawStr === 'null' || rawStr === 'undefined' || rawStr === 'N/A';
							const subVal = isSubEmpty ? 'None' : rawStr;
							const isDateOrRange = subVal !== 'None' && (subVal.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(subVal) || subK.toLowerCase().includes('period') || subK.toLowerCase().includes('date'));
							const isLong = subVal.length > 80 || subVal.includes('\n');
							itemFields.push({
								path: `/Custom/${k}/${idxNum}/${subK}`,
								label: subK,
								fieldType: isDateOrRange ? 'date_range' : (isLong ? 'textarea' : 'text'),
								currentValue: subVal
							});
						}
						listItems.push({
							path: `/Custom/${k}/${idxNum}`,
							label: itemTitle,
							fieldType: 'composite',
							currentValue: itemTitle,
							children: itemFields
						});
					});

					customChildren.push({
						path: `/Custom/${k}`,
						label: k,
						fieldType: 'dynamic_list',
						children: listItems
					});
				} else {
					const rawVal = v !== undefined && v !== null ? String(v).trim() : '';
					const isValEmpty = !rawVal || rawVal === 'None' || rawVal === 'null' || rawVal === 'undefined' || rawVal === 'N/A';
					const strVal = isValEmpty ? 'None' : rawVal;
					const isRange = strVal !== 'None' && (strVal.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(strVal));
					const isMultiline = strVal.length > 80 || strVal.includes('\n');
					customChildren.push({
						path: `/Custom/${k}`,
						label: k,
						fieldType: isRange ? 'date_range' : (isMultiline ? 'textarea' : 'text'),
						currentValue: strVal
					});
				}
			}

			if (customChildren.length > 0) {
				rootNodes.push({
					path: '/Custom',
					label: 'Custom Properties',
					fieldType: 'container',
					children: customChildren
				});
			}
		}

		return rootNodes;
	}

	private async _handleMessage(eventData: any): Promise<void> {
		const e = (eventData && eventData.message) ? eventData.message : eventData;
		if (!e || !this._entityUri) {
			return;
		}

		switch (e.type) {
			case 'openAgentCentral':
			case 'aiButtonClicked': {
				const field = e.field || e.source || '/Description';
				const ticketId = this._lastParsedData?.ticketId || this._entityName || '';
				const workspaceId = this._lastParsedData?.workspaceId || '';

				const locators: string[] = [];
				if (workspaceId) {
					locators.push(`Workspace: ${workspaceId}`);
				}
				if (ticketId) {
					locators.push(`Ticket: ${ticketId}`);
				}
				if (field) {
					locators.push(`Target: ${field}`);
				}

				const prompt = locators.length > 0 ? `[${locators.join(' | ')}] ` : '';
				const agents = this._agentsManagerService ? await this._agentsManagerService.getAgents() : [];
				const allTickets = await this._loadAllAvailableTickets();
				const hierarchyTree = this._buildHierarchyTree(this._lastParsedData, agents, allTickets);

				try {
					await this._commandService.executeCommand('workbench.action.chat.toggleCenteredChatPopup', {
						prompt: prompt,
						workspaceId: workspaceId,
						ticketId: ticketId,
						field: field,
						label: e.label,
						fieldType: e.fieldType,
						currentValue: e.currentValue,
						options: e.options,
						hierarchyTree: hierarchyTree
					});
				} catch (err) {
					console.error('Failed to open Agent Central:', err);
				}
				break;
			}
			case 'saveAllData':
			case 'saveTitleAndDescription':
			case 'saveDescription': {
				try {
					if (e.metadata && e.metadata['Link To'] !== undefined) {
						const oldLinkTo = this._lastParsedData?.linkTo || 'None';
						const newLinkTo = e.metadata['Link To'];
						const currentTicketId = this._lastParsedData?.ticketId || this._entityName || '';
						await this._syncBidirectionalLinks(currentTicketId, oldLinkTo, newLinkTo);
					}
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
					if (this._instructionUri && e.metadata && (e.metadata['Ticket Prompt'] !== undefined || e.metadata['Ticket Type Prompt'] !== undefined || e.metadata['System Prompt'] !== undefined || e.metadata['Instruction Notes'] !== undefined)) {
						const instContent = await this._safeReadFile(this._instructionUri);
						const updatedInst = this._updateInstructionContent(instContent, e.metadata);
						await this._fileService.writeFile(this._instructionUri, VSBuffer.fromString(updatedInst));
					}
					if (this._entityType === 'agent' && this._agentsManagerService) {
						const agents = await this._agentsManagerService.getAgents();
						const matchingAgent = agents.find(a =>
							(this._entityUri && a.folderPath && (a.folderPath === this._entityUri.fsPath || a.folderPath.toLowerCase() === this._entityUri.fsPath.toLowerCase())) ||
							(a.name.toLowerCase() === (e.title || this._lastParsedData?.title || '').toLowerCase()) ||
							(a.name.toLowerCase() === this._entityName.toLowerCase())
						);
						if (matchingAgent) {
							const updatedAgent: IAgentItem = {
								...matchingAgent,
								name: e.title || e.metadata?.['Title'] || matchingAgent.name,
								role: e.description || e.metadata?.['Description'] || e.metadata?.['Role'] || e.metadata?.['Agent Role'] || matchingAgent.role,
								description: e.description || e.metadata?.['Description'] || matchingAgent.description,
								systemPrompt: e.metadata?.['System Prompt'] || e.metadata?.['Instruction Notes'] || matchingAgent.systemPrompt,
								status: (e.metadata?.['Status'] ? (e.metadata['Status'].toLowerCase() as any) : matchingAgent.status)
							};
							if (e.metadata?.['AI Model'] || e.metadata?.['Model'] || e.metadata?.['Model Name']) {
								const mId = e.metadata['AI Model'] || e.metadata['Model'] || e.metadata['Model Name'];
								updatedAgent.model = {
									providerId: matchingAgent.model?.providerId || 'gemini',
									modelId: mId,
									credentialId: matchingAgent.model?.credentialId
								};
							}
							await this._agentsManagerService.updateAgent(updatedAgent);
						}
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
					if (e.metadata && e.metadata['Link To'] !== undefined) {
						const oldLinkTo = this._lastParsedData?.linkTo || 'None';
						const newLinkTo = e.metadata['Link To'];
						const currentTicketId = this._lastParsedData?.ticketId || this._entityName || '';
						await this._syncBidirectionalLinks(currentTicketId, oldLinkTo, newLinkTo);
					}
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
					if (this._instructionUri && e.metadata && (e.metadata['Ticket Prompt'] !== undefined || e.metadata['Ticket Type Prompt'] !== undefined || e.metadata['System Prompt'] !== undefined || e.metadata['Instruction Notes'] !== undefined)) {
						const instContent = await this._safeReadFile(this._instructionUri);
						const updatedInst = this._updateInstructionContent(instContent, e.metadata);
						await this._fileService.writeFile(this._instructionUri, VSBuffer.fromString(updatedInst));
					}
					if (this._entityType === 'agent' && this._agentsManagerService) {
						const agents = await this._agentsManagerService.getAgents();
						const matchingAgent = agents.find(a =>
							(this._entityUri && a.folderPath && (a.folderPath === this._entityUri.fsPath || a.folderPath.toLowerCase() === this._entityUri.fsPath.toLowerCase())) ||
							(a.name.toLowerCase() === (e.metadata?.['Title'] || this._lastParsedData?.title || '').toLowerCase()) ||
							(a.name.toLowerCase() === this._entityName.toLowerCase())
						);
						if (matchingAgent) {
							const updatedAgent: IAgentItem = {
								...matchingAgent,
								name: e.metadata?.['Title'] || matchingAgent.name,
								role: e.metadata?.['Description'] || e.metadata?.['Role'] || e.metadata?.['Agent Role'] || matchingAgent.role,
								description: e.metadata?.['Description'] || matchingAgent.description,
								systemPrompt: e.metadata?.['System Prompt'] || e.metadata?.['Instruction Notes'] || matchingAgent.systemPrompt,
								status: (e.metadata?.['Status'] ? (e.metadata['Status'].toLowerCase() as any) : matchingAgent.status)
							};
							if (e.metadata?.['AI Model'] || e.metadata?.['Model'] || e.metadata?.['Model Name']) {
								const mId = e.metadata['AI Model'] || e.metadata['Model'] || e.metadata['Model Name'];
								updatedAgent.model = {
									providerId: matchingAgent.model?.providerId || 'gemini',
									modelId: mId,
									credentialId: matchingAgent.model?.credentialId
								};
							}
							await this._agentsManagerService.updateAgent(updatedAgent);
						}
					}
					this._notificationService.info(localize('metaSaved', "Attributes updated successfully."));
					await this._resolvePathsAndLoadData();
				} catch (err) {
					this._notificationService.error(localize('saveMetaFailed', "Failed to save attributes: {0}", String(err)));
				}
				break;
			}
			case 'openTicket': {
				const targetId = e.ticketId;
				if (targetId) {
					const targetUri = await this._findTicketUriById(targetId);
					if (targetUri) {
						let entityDir = dirname(targetUri);
						if (entityDir.path.endsWith('/.agents')) {
							entityDir = dirname(entityDir);
						}
						const input = this._instantiationService.createInstance(EntityDetailEditorInput, entityDir, targetId);
						await this._editorService.openEditor(input, { pinned: true });
					}
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
		customModule?: any,
		agents: IAgentItem[] = [],
		allTickets: any[] = []
	): string {
		const typeUpper = (data.ticketType || 'task').toUpperCase();

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
		let colorSetting: { text: string; bg: string; border: string };
		if (customModule && customModule.color) {
			colorSetting = { text: customModule.color, bg: hexToRgba(customModule.color, 0.2), border: hexToRgba(customModule.color, 0.35) };
		} else {
			colorSetting = this._getTypeColorInfo(data.ticketType || 'task');
		}

		// 3. Priority badge
		const pColors: { [key: string]: string } = {
			'very high': '#f43f5e',
			'high': '#fb923c',
			'medium': '#38bdf8',
			'low': '#34d399',
			'very low': '#2dd4bf'
		};
		const pColor = pColors[(data.priority || 'medium').toLowerCase()] || '#94a3b8';

		// 4. Attachments HTML
		let attachmentsHtml = '';
		if (attachments.length === 0) {
			attachmentsHtml = '<p style="opacity: 0.45; font-style: italic; font-size: 0.88em; margin: 8px 0;">No attachments linked yet.</p>';
		} else {
			attachmentsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 10px;">';
			for (const file of attachments) {
				attachmentsHtml += `
					<div class="attachment-card" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 8px 12px; border-radius: 6px;">
						<div class="attachment-card-download" data-file-name="${this._escapeHtmlAttr(file)}" style="display: flex; align-items: center; gap: 8px; overflow: hidden; cursor: pointer; flex: 1;" title="Download attachment">
							<span style="font-size: 0.88em; font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${this._escapeHtmlAttr(file)}</span>
						</div>
						<span class="delete-attachment" data-file-name="${this._escapeHtmlAttr(file)}" style="opacity: 0.4; cursor: pointer; padding: 2px 4px; font-size: 0.85em;" title="Delete Attachment">✕</span>
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
				let parsedArray: any[] | null = null;
				if (typeof v === 'string' && v.trim().startsWith('[') && v.trim().endsWith(']')) {
					try {
						const parsed = JSON.parse(v.trim());
						if (Array.isArray(parsed)) {
							parsedArray = parsed;
						}
					} catch {}
				}

				if (parsedArray) {
					// Dynamic List Container
					let subCardsViewHtml = '';

					if (parsedArray.length === 0) {
						subCardsViewHtml = '<div style="opacity: 0.45; font-style: italic; padding: 6px 0;">No entries in this list.</div>';
					} else {
						parsedArray.forEach((item: any, idx: number) => {
							const idxNum = item._index || (idx + 1);
							const itemTitle = item._title || item.title || item.name || item.company || `Entry #${idxNum}`;
							
							let itemSubFieldsView = '';
							const itemEntries = Object.entries(item).filter(([subK]) => subK !== '_index' && subK !== '_title');
							
							if (itemEntries.length === 0) {
								itemSubFieldsView = '<div style="opacity: 0.5; font-size: 0.85em;">No sub-fields recorded.</div>';
							} else {
								for (const [subK, subValRaw] of itemEntries) {
									const subVal = String(subValRaw || '');
									const isDateOrRange = subVal.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(subVal);
									const isLong = subVal.length > 80 || subVal.includes('\n');

									itemSubFieldsView += `
										<div class="dynamic-subfield-row" style="margin-bottom: 6px; display: flex; flex-direction: ${isLong ? 'column' : 'row'}; gap: ${isLong ? '4px' : '8px'}; align-items: ${isLong ? 'flex-start' : 'center'}; justify-content: space-between;">
											<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
												<span style="font-size: 0.82em; font-weight: 600; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em;">${subK}:</span>
												${isDateOrRange ? `
													<span class="range-badge" style="font-size: 0.82em; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); display: inline-flex; align-items: center; gap: 4px;">
														${subVal}
													</span>
												` : (!isLong ? `
													<span style="font-size: 0.9em; font-weight: 500; color: var(--vscode-editor-foreground);">${subVal || '<span style="opacity:0.4; font-style:italic;">None</span>'}</span>
												` : '')}
											</div>
											<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${k}/${idxNum}/${subK}" data-ai-field-type="${isDateOrRange ? 'date_range' : (isLong ? 'textarea' : 'text')}" data-ai-field-label="${subK}" data-ai-current-value="${this._escapeHtmlAttr(subVal)}" title="Edit ${subK} with AI" style="padding: 2px 5px; font-size: 0.75em;">
												<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
											</button>
										</div>
										${isLong ? `
											<div class="desc-content-box" style="margin-top: 2px; margin-bottom: 8px; font-size: 0.88em; padding: 8px 12px;">
												${this._markdownToHtml(subVal)}
											</div>
										` : ''}
									`;
								}
							}

							subCardsViewHtml += `
								<div class="dynamic-sub-card" style="background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px 14px; margin-bottom: 10px;">
									<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; margin-bottom: 10px;">
										<div style="display: flex; align-items: center; gap: 8px;">
											<span style="font-size: 0.75em; font-weight: 700; background: rgba(56,189,248,0.18); color: #38bdf8; padding: 2px 7px; border-radius: 4px; letter-spacing: 0.05em;">#${idxNum}</span>
											<span style="font-size: 0.95em; font-weight: 600; color: var(--vscode-editor-foreground);">${itemTitle}</span>
										</div>
										<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${k}/${idxNum}" data-ai-field-type="composite" data-ai-field-label="${itemTitle}" data-ai-current-value="${this._escapeHtmlAttr(itemTitle)}" title="Edit ${itemTitle} with AI">
											<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
										</button>
									</div>
									<div class="subcard-body">
										${itemSubFieldsView}
									</div>
								</div>
							`;
						});
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(6,182,212,0.15); color: #06b6d4; font-weight: 700; text-transform: uppercase;">Dynamic List</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${k}" data-ai-field-type="dynamic_list" data-ai-field-label="${k}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view">
								${subCardsViewHtml}
							</div>
						</div>
					`;
				} else {
					// Single Value Property
					const isRange = typeof v === 'string' && (v.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(v));
					const isMultiline = v.length > 80 || v.includes('\n') || ['experience', 'description', 'detail', 'content', 'notes', 'summary', 'project', 'background'].some(sub => k.toLowerCase().includes(sub));
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<span>${k}</span>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${k}" data-ai-field-type="${isRange ? 'date_range' : (isMultiline ? 'textarea' : 'text')}" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(v)}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view desc-content-box">
								${isRange ? `
									<span class="range-badge" style="font-size: 0.9em; font-weight: 600; padding: 3px 10px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); display: inline-flex; align-items: center; gap: 6px;">
										${v}
									</span>
								` : (v ? this._markdownToHtml(v) : '<span style="opacity: 0.45; font-style: italic;">No content provided.</span>')}
							</div>
						</div>
					`;
				}
			}
		}

		// 7. Instructions Card Section
		const ticketPromptDisplay = (data.ticketPrompt && data.ticketPrompt !== 'None') ? data.ticketPrompt : '';
		const typePromptDisplay = (data.typePrompt && data.typePrompt !== 'None') ? data.typePrompt : '';

		const isAgent = (data.ticketType || '').toLowerCase() === 'agent';
		const matchingAgent = agents.find(a =>
			(this._entityUri && a.folderPath && (a.folderPath === this._entityUri.fsPath || a.folderPath.toLowerCase() === this._entityUri.fsPath.toLowerCase())) ||
			(a.name.toLowerCase() === (data.title || '').toLowerCase()) ||
			(a.name.toLowerCase() === (data.ticketId || '').toLowerCase()) ||
			(a.name.toLowerCase() === this._entityName.toLowerCase())
		);

		const agentModel = matchingAgent?.model?.modelId || data.metadata['Model Name'] || data.metadata['AI Model'] || data.metadata['Model'] || 'gemini-1.5-flash';
		const agentProvider = matchingAgent?.model?.providerId || data.metadata['AI Provider'] || data.metadata['Provider'] || (agentModel.startsWith('gpt') ? 'openai' : agentModel.startsWith('claude') ? 'anthropic' : agentModel.startsWith('deepseek') ? 'deepseek' : 'gemini');
		const agentCredentialId = matchingAgent?.model?.credentialId || data.metadata['Credential ID'] || data.metadata['Credential'] || 'Default Provider Connection';
		const agentRole = matchingAgent?.role || data.metadata['Role'] || data.description || `${data.workspaceId || 'Workspace'} Agent`;
		const agentSystemPrompt = matchingAgent?.systemPrompt || data.metadata['System Prompt'] || data.instructionNotes || '';
		const agentScopeName = matchingAgent?.scopeName || data.metadata['Scope Name'] || data.workspaceId || 'Workspace';
		const agentStatus = matchingAgent?.status || (data.status === 'Todo' ? 'idle' : data.status.toLowerCase());

		if (isAgent) {
			status = agentStatus;
			if (agentStatus === 'busy') {
				statusColor = '#eab308';
				statusBg = 'rgba(234, 179, 8, 0.16)';
				statusBorder = 'rgba(234, 179, 8, 0.35)';
			} else if (agentStatus === 'offline') {
				statusColor = '#94a3b8';
				statusBg = 'rgba(148, 163, 184, 0.16)';
				statusBorder = 'rgba(148, 163, 184, 0.35)';
			} else {
				statusColor = '#22c55e';
				statusBg = 'rgba(34, 197, 94, 0.16)';
				statusBorder = 'rgba(34, 197, 94, 0.35)';
			}
		}

		return `
			<style>
				.entity-detail-editor * {
					box-sizing: border-box;
				}
				.entity-detail-editor .layout-container {
					display: grid;
					grid-template-columns: minmax(0, 1fr) 320px;
					gap: 28px;
					width: 100%;
					margin: 0;
				}
				.entity-detail-editor .main-content {
					display: flex;
					flex-direction: column;
					gap: 20px;
					min-width: 0;
				}
				.entity-detail-editor .sidebar {
					background: rgba(255,255,255,0.02);
					border: 1px solid rgba(255,255,255,0.06);
					border-radius: 10px;
					padding: 20px;
					height: fit-content;
					position: sticky;
					top: 0px;
					backdrop-filter: blur(8px);
					box-shadow: 0 4px 16px rgba(0,0,0,0.15);
				}
				.entity-detail-editor .header-breadcrumb {
					display: flex;
					align-items: center;
					justify-content: flex-start;
					gap: 8px;
					font-size: 0.85em;
					opacity: 0.65;
					margin-bottom: 6px;
					font-weight: 500;
					text-align: left;
				}
				.entity-detail-editor .header-title-row {
					display: flex;
					align-items: center;
					justify-content: flex-start;
					gap: 12px;
					margin-bottom: 8px;
					text-align: left;
				}
				.entity-detail-editor .ticket-title {
					margin: 0;
					font-size: 1.65em;
					font-weight: 700;
					color: var(--vscode-editor-foreground, #fff);
					line-height: 1.25;
					text-align: left;
				}
				.entity-detail-editor .badge {
					display: inline-block;
					padding: 2px 8px;
					border-radius: 4px;
					font-size: 0.72em;
					font-weight: 700;
					letter-spacing: 0.05em;
					text-transform: uppercase;
				}
				.entity-detail-editor .btn-primary {
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
				.entity-detail-editor .btn-primary:hover {
					background: var(--vscode-button-hoverBackground);
				}
				.entity-detail-editor .btn-secondary {
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
				.entity-detail-editor .btn-secondary:hover {
					background: rgba(255,255,255,0.12);
				}
				.entity-detail-editor .input-field {
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
				.entity-detail-editor .input-field:focus {
					outline: 1px solid var(--vscode-focusBorder, #007acc);
					border-color: var(--vscode-focusBorder, #007acc);
				}
				.entity-detail-editor .section-card {
					background: rgba(255,255,255,0.015);
					border: 1px solid rgba(255,255,255,0.05);
					border-radius: 8px;
					padding: 18px 22px;
				}
				.entity-detail-editor .section-title {
					font-size: 1.05em;
					font-weight: 600;
					margin: 0 0 14px 0;
					color: var(--vscode-editor-foreground, #eee);
					display: flex;
					justify-content: space-between;
					align-items: center;
				}
				.entity-detail-editor .desc-content-box {
					padding: 14px 16px;
					background: rgba(0,0,0,0.18);
					border-radius: 6px;
					border: 1px solid rgba(255,255,255,0.04);
					font-size: 0.93em;
					line-height: 1.65;
					text-align: left;
				}
				.entity-detail-editor .dropzone {
					border: 2px dashed rgba(255,255,255,0.12);
					border-radius: 6px;
					padding: 20px;
					text-align: center;
					cursor: pointer;
					transition: border 0.2s, background 0.2s;
					background: rgba(255,255,255,0.005);
				}
				.entity-detail-editor .dropzone:hover, .entity-detail-editor .dropzone.dragover {
					border-color: var(--vscode-focusBorder, #38bdf8);
					background: rgba(56,189,248,0.04);
				}
				.entity-detail-editor .sidebar-row {
					display: flex;
					flex-direction: column;
					gap: 4px;
					margin-bottom: 14px;
					border-bottom: 1px solid rgba(255,255,255,0.04);
					padding-bottom: 8px;
				}
				.entity-detail-editor .sidebar-label {
					font-size: 0.75em;
					opacity: 0.55;
					font-weight: 600;
					letter-spacing: 0.05em;
					text-transform: uppercase;
				}
				.entity-detail-editor .sidebar-value {
					font-size: 0.9em;
					font-weight: 500;
					color: var(--vscode-editor-foreground);
					word-break: break-word;
				}
				.entity-detail-editor .ai-edit-btn {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					background: transparent;
					color: var(--vscode-icon-foreground, rgba(255, 255, 255, 0.45));
					border: 1px solid transparent;
					border-radius: 4px;
					padding: 3px 5px;
					cursor: pointer;
					transition: opacity 0.3s ease 0.35s, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
					user-select: none;
					line-height: 1;
					opacity: 0;
					pointer-events: none;
				}
				/* Container-level hover reveals all editable sparkle buttons within */
				.entity-detail-editor .header-title-row:hover .ai-edit-btn,
				.entity-detail-editor .section-card:hover .ai-edit-btn,
				.entity-detail-editor .sidebar:hover .ai-edit-btn,
				.entity-detail-editor .dynamic-sub-card:hover .ai-edit-btn,
				.entity-detail-editor .custom-property-card:hover .ai-edit-btn {
					opacity: 0.55;
					pointer-events: auto;
					transition: opacity 0.15s ease 0s, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
				}
				.entity-detail-editor .ai-edit-btn:hover {
					opacity: 1 !important;
					color: var(--vscode-editor-foreground, #ffffff) !important;
					background: rgba(255, 255, 255, 0.08) !important;
					border-color: rgba(255, 255, 255, 0.18) !important;
					box-shadow: none !important;
					transform: none !important;
					transition: opacity 0.1s ease 0s, background 0.15s ease, color 0.15s ease, border-color 0.15s ease !important;
				}
			</style>

			<!-- Top Header Area -->
			<div style="width: 100%; margin: 0 0 20px 0; text-align: left;">
				<div class="header-breadcrumb">
					<span>${data.workspaceId || 'Workspace'}</span>
					<span>/</span>
					<span>${data.ticketId}</span>
					<span style="font-size: 8.5px; padding: 1px 5px; border-radius: 3px; background: ${colorSetting.bg}; color: ${colorSetting.text}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; display: inline-block;">${typeUpper}</span>
				</div>
				<div class="header-title-row">
					<h1 class="ticket-title" id="title-heading">${data.title}</h1>
					<button type="button" class="ai-edit-btn" data-ai-field="/Title" data-ai-field-type="text" data-ai-field-label="Title" data-ai-current-value="${this._escapeHtmlAttr(data.title)}" title="Edit Title with AI">
						<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
					</button>
				</div>
			</div>

			<!-- Main Layout Container -->
			<div class="layout-container">
				<!-- Left Column: Main Stream -->
				<div class="main-content">
					<!-- 1. Description / Role Card -->
					<div class="section-card">
						<div class="section-title">
							<div style="display: flex; align-items: center; gap: 8px;">
								<span>${isAgent ? 'Role & Purpose' : 'Description'}</span>
							</div>
							<button type="button" class="ai-edit-btn" data-ai-field="/Description" data-ai-field-type="textarea" data-ai-field-label="${isAgent ? 'Role & Purpose' : 'Description'}" data-ai-current-value="${this._escapeHtmlAttr(data.description)}" title="Edit Description with AI">
								<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
							</button>
						</div>
						
						<div id="desc-view-mode" class="desc-content-box">
							${data.description ? this._markdownToHtml(data.description) : `<span style="opacity: 0.45; font-style: italic;">No ${isAgent ? 'role description' : 'description'} provided.</span>`}
						</div>
					</div>

					${isAgent ? `
						<!-- AI Model & Execution Engine Card -->
						<div class="section-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>AI Model & Execution Engine</span>
								</div>
								<div style="display: flex; align-items: center; gap: 8px;">
									${matchingAgent ? `
										<button type="button" id="agent-assign-task-btn" data-agent-id="${this._escapeHtmlAttr(matchingAgent.id)}" data-agent-name="${this._escapeHtmlAttr(matchingAgent.name)}" class="btn-primary" style="font-size: 0.8em; padding: 3px 10px;">+ Assign Task</button>
									` : ''}
									<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/AI Model" data-ai-field-type="text" data-ai-field-label="AI Model" data-ai-current-value="${this._escapeHtmlAttr(agentModel)}" title="Edit AI Model with AI">
										<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
									</button>
								</div>
							</div>
							<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;">
								<div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px 14px;">
									<div style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Active Model</div>
									<div style="display: flex; align-items: center; gap: 6px;">
										<span style="display: inline-block; padding: 3px 8px; border-radius: 4px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 700; font-family: monospace; font-size: 0.9em; border: 1px solid rgba(56, 189, 248, 0.3);">${agentModel}</span>
									</div>
								</div>
								<div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px 14px;">
									<div style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">AI Provider</div>
									<div style="font-size: 0.9em; font-weight: 600; text-transform: uppercase; color: #a78bfa;">${agentProvider}</div>
								</div>
								<div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px 14px;">
									<div style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">API Connection</div>
									<div style="font-size: 0.88em; opacity: 0.85; word-break: break-word;">${agentCredentialId}</div>
								</div>
								<div style="background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px 14px;">
									<div style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Bound Scope</div>
									<div style="font-size: 0.88em; font-weight: 600; color: #34d399;">${agentScopeName}</div>
								</div>
							</div>
						</div>
					` : ''}

					<!-- Instructions / System Prompt Card -->
					<div class="section-card">
						<div class="section-title">
							<div style="display: flex; align-items: center; gap: 8px;">
								<span>${isAgent ? 'System Prompt & Persona Instructions' : 'Instructions'}</span>
							</div>
							<div style="display: flex; align-items: center; gap: 8px;">
								${isAgent && agentSystemPrompt ? `
									<button type="button" id="copy-system-prompt-btn" class="btn-secondary" data-prompt="${this._escapeHtmlAttr(agentSystemPrompt)}" style="font-size: 0.78em; padding: 3px 8px; display: inline-flex; align-items: center; gap: 4px;" title="Copy System Prompt">
										<span>Copy Prompt</span>
									</button>
								` : ''}
								<button type="button" class="ai-edit-btn" data-ai-field="${isAgent ? '/Instructions/System Prompt' : '/Instructions'}" data-ai-field-type="textarea" data-ai-field-label="${isAgent ? 'System Prompt' : 'Instructions'}" data-ai-current-value="${this._escapeHtmlAttr(agentSystemPrompt || data.instructionNotes || '')}" title="Edit with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
						</div>

						<div style="display: flex; flex-direction: column; gap: 12px;">
							${isAgent && agentSystemPrompt ? `
								<!-- Core Persona / System Prompt Box -->
								<div class="instruction-item" style="border-left: 3px solid #f472b6; background: rgba(244, 114, 182, 0.04); padding: 14px 18px; border-radius: 0 6px 6px 0; border: 1px solid rgba(244, 114, 182, 0.18); border-left-width: 3px;">
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
										<div style="font-size: 0.78em; font-weight: 700; color: #f472b6; letter-spacing: 0.04em; text-transform: uppercase;">Core System Prompt / Persona</div>
										<button type="button" class="ai-edit-btn" data-ai-field="/Instructions/System Prompt" data-ai-field-type="textarea" data-ai-field-label="System Prompt" data-ai-current-value="${this._escapeHtmlAttr(agentSystemPrompt)}" title="Edit System Prompt with AI">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
										</button>
									</div>
									<div style="font-size: 0.9em; opacity: 0.95; line-height: 1.6; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-word;">${this._markdownToHtml(agentSystemPrompt)}</div>
								</div>
							` : ''}

							<!-- Ticket Prompt -->
							<div class="instruction-item" style="border-left: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.04); padding: 12px 16px; border-radius: 0 6px 6px 0; border: 1px solid rgba(56, 189, 248, 0.15); border-left-width: 3px;">
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<div style="font-size: 0.78em; font-weight: 700; color: #38bdf8; letter-spacing: 0.04em; text-transform: uppercase;">${isAgent ? 'Instance Rules / Ticket Prompt' : 'Ticket Prompt'}</div>
									<button type="button" class="ai-edit-btn" data-ai-field="/Instructions/Ticket Prompt" data-ai-field-type="textarea" data-ai-field-label="Ticket Prompt" data-ai-current-value="${this._escapeHtmlAttr(data.ticketPrompt || '')}" title="Edit Ticket Prompt with AI">
										<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
									</button>
								</div>
								<div style="font-size: 0.9em; opacity: 0.9; line-height: 1.5;">${ticketPromptDisplay ? this._markdownToHtml(ticketPromptDisplay) : '<span style="opacity: 0.45; font-style: italic;">No Ticket Prompt configured.</span>'}</div>
							</div>

							<!-- Ticket Type Prompt -->
							<div class="instruction-item" style="border-left: 3px solid #a78bfa; background: rgba(167, 139, 250, 0.04); padding: 12px 16px; border-radius: 0 6px 6px 0; border: 1px solid rgba(167, 139, 250, 0.15); border-left-width: 3px;">
								<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
									<div style="font-size: 0.78em; font-weight: 700; color: #a78bfa; letter-spacing: 0.04em; text-transform: uppercase;">${isAgent ? 'System Type Prompt' : 'Ticket Type Prompt'}</div>
									<button type="button" class="ai-edit-btn" data-ai-field="/Instructions/Ticket Type Prompt" data-ai-field-type="textarea" data-ai-field-label="Ticket Type Prompt" data-ai-current-value="${this._escapeHtmlAttr(typePromptDisplay || '')}" title="Edit Ticket Type Prompt with AI">
										<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
									</button>
								</div>
								<div style="font-size: 0.9em; opacity: 0.9; line-height: 1.5;">${typePromptDisplay ? this._markdownToHtml(typePromptDisplay) : '<span style="opacity: 0.45; font-style: italic;">No Ticket Type Prompt configured.</span>'}</div>
							</div>

							${data.instructionNotes && (!isAgent || data.instructionNotes !== agentSystemPrompt) ? `
								<div class="instruction-item" style="padding: 12px 16px; background: rgba(0,0,0,0.15); border-radius: 6px; border: 1px solid rgba(255,255,255,0.04);">
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
										<div style="font-size: 0.78em; font-weight: 700; opacity: 0.6; letter-spacing: 0.04em; text-transform: uppercase;">Instruction Notes</div>
										<button type="button" class="ai-edit-btn" data-ai-field="/Instructions/Instruction Notes" data-ai-field-type="textarea" data-ai-field-label="Instruction Notes" data-ai-current-value="${this._escapeHtmlAttr(data.instructionNotes || '')}" title="Edit Instruction Notes with AI">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
										</button>
									</div>
									<div style="font-size: 0.9em; line-height: 1.5;">${this._markdownToHtml(data.instructionNotes)}</div>
								</div>
							` : ''}
						</div>
					</div>

					<!-- Custom Properties -->
					${customFieldsHtml}

					<!-- Attachments Card -->
					<div class="section-card">
						<div class="section-title">
							<span>Attachments (${attachments.length})</span>
						</div>
						<div id="attachment-dropzone" class="dropzone">
							<span style="font-size: 0.88em; opacity: 0.7;">Drag and drop files here or click to browse</span>
							<input type="file" id="file-input" style="display: none;" />
						</div>
						<div id="attachments-container">
							${attachmentsHtml}
						</div>
					</div>

					<!-- Work Logs Card -->
					<div class="section-card">
						<div class="section-title">
							<span>${isAgent ? 'Task History & Work Logs' : 'Work Logs'}</span>
							<button id="add-log-btn" class="btn-primary" style="font-size: 0.8em; padding: 4px 10px;">+ Add Log</button>
						</div>
						
						<!-- Add Log Form -->
						<div id="add-log-box" style="display: none; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 15px;">
							<textarea id="log-textarea" class="input-field" rows="3" placeholder="Enter work log description..."></textarea>
							<div style="display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;">
								<button id="cancel-log-btn" class="btn-secondary">Cancel</button>
								<button id="submit-log-btn" class="btn-primary">Record Log</button>
							</div>
						</div>

						<div id="work-logs-container">
							${workLogHtml}
						</div>
					</div>
				</div>

				<!-- Right Column: Sidebar (Attributes / Information) -->
				<div class="sidebar">
					<div class="sidebar-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px;">
						<h3 style="margin: 0; font-size: 1.05em; font-weight: 700; color: var(--vscode-editor-foreground);">${isAgent ? 'Agent Attributes' : 'Attributes'}</h3>
						<button type="button" class="ai-edit-btn" data-ai-field="/Attributes" data-ai-field-type="attributes" data-ai-field-label="Attributes" title="Edit Attributes with AI">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
						</button>
					</div>
					
					<!-- Status -->
					<div class="sidebar-row">
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<span class="sidebar-label">STATUS</span>
							<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Status" data-ai-field-type="status" data-ai-field-label="Status" data-ai-current-value="${this._escapeHtmlAttr(status)}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(isAgent ? ['idle', 'busy', 'offline'] : ['Todo', 'In Progress', 'Done', 'Blocked']))}" title="Edit Status with AI">
								<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
							</button>
						</div>
						<div style="padding: 2px 0;">
							<span id="status-view-val" style="display: inline-block; font-size: 0.88em; font-weight: 700; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder}; padding: 3px 10px; border-radius: 5px; text-transform: uppercase;">${status}</span>
						</div>
					</div>

					<!-- Priority -->
					<div class="sidebar-row">
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<span class="sidebar-label">PRIORITY</span>
							<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Priority" data-ai-field-type="priority" data-ai-field-label="Priority" data-ai-current-value="${this._escapeHtmlAttr(data.priority)}" title="Edit Priority with AI">
								<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
							</button>
						</div>
						<div style="display: flex; align-items: center; gap: 6px; padding: 2px 0;">
							<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${pColor}; box-shadow: 0 0 6px ${pColor}80;"></span>
							<span class="meta-view-val" style="font-size: 0.9em; font-weight: 700; color: ${pColor};">${data.priority}</span>
						</div>
					</div>

					${isAgent ? `
						<!-- AI Model -->
						<div class="sidebar-row">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<span class="sidebar-label">AI MODEL</span>
								<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/AI Model" data-ai-field-type="text" data-ai-field-label="AI Model" data-ai-current-value="${this._escapeHtmlAttr(agentModel)}" title="Edit AI Model with AI">
									<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<span class="sidebar-value" style="color: #38bdf8; font-weight: 700; font-family: monospace;">${agentModel}</span>
						</div>

						<!-- Provider -->
						<div class="sidebar-row">
							<span class="sidebar-label">PROVIDER</span>
							<span class="sidebar-value" style="text-transform: uppercase; font-size: 0.88em; color: #a78bfa; font-weight: 600;">${agentProvider}</span>
						</div>

						<!-- Agent Role -->
						<div class="sidebar-row">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<span class="sidebar-label">AGENT ROLE</span>
								<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Agent Role" data-ai-field-type="text" data-ai-field-label="Agent Role" data-ai-current-value="${this._escapeHtmlAttr(agentRole)}" title="Edit Agent Role with AI">
									<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<span class="sidebar-value" style="font-size: 0.88em;">${agentRole}</span>
						</div>

						<!-- Scope -->
						<div class="sidebar-row">
							<span class="sidebar-label">BOUND SCOPE</span>
							<span class="sidebar-value" style="font-size: 0.88em; color: #34d399; font-weight: 600;">${agentScopeName}</span>
						</div>
					` : `
						<!-- Current AI Agent -->
						<div class="sidebar-row">
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<span class="sidebar-label">CURRENT AI AGENT</span>
								<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Current AI Agent" data-ai-field-type="agent" data-ai-field-label="Current AI Agent" data-ai-current-value="${this._escapeHtmlAttr(data.assignedAgentName || '')}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(agents.map(a => ({ id: a.id, name: a.name }))))}" title="Edit Current AI Agent with AI">
									<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<span class="meta-view-val sidebar-value">${data.assignedAgentName && data.assignedAgentName !== 'None' ? data.assignedAgentName : '<span style="opacity:0.4;">Unassigned</span>'}</span>
						</div>
					`}

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
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<span class="sidebar-label">LINK TO</span>
							<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Link To" data-ai-field-type="link_to" data-ai-field-label="Link To" data-ai-current-value="${data.linkTo !== 'None' ? this._escapeHtmlAttr(data.linkTo) : ''}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(allTickets))}" title="Edit Link To with AI">
								<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
							</button>
						</div>
						<div class="sidebar-value" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
							${this._renderTicketChipsHtml(data.linkTo, allTickets)}
						</div>
					</div>

					<div class="sidebar-row">
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<span class="sidebar-label">LINKED BY</span>
						</div>
						<div class="sidebar-value" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
							${this._renderTicketChipsHtml(data.linkedBy, allTickets)}
						</div>
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
				</div>
			</div>
		`;
	}
}
