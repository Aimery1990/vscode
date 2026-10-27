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
import { WorkflowEditorInput } from '../../workflowsManager/browser/workflowEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { dirname, basename } from '../../../../base/common/resources.js';
import { IAgentsManagerService, IAgentItem, IAgentCredentialService } from '../../agentsManager/common/agentsManager.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspacesExplorerService, IWorkspaceStatusesInfo } from '../common/workspacesExplorer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { parseYaml } from '../../customModules/browser/customModulesService.js';
import { IActionButton, ICredentialPair, IParameterDefinition } from '../../entityPersistence/common/entityPersistence.js';
import { IRequestService, asText } from '../../../../platform/request/common/request.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IWebContentExtractorService, WebContentExtractResult } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ITicketWorkflowRuntimeService } from '../../workflowsManager/browser/ticketWorkflowRuntime.js';
import { highlightPythonToHTML } from '../../customModules/browser/pythonSyntaxHighlighter.js';

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
	gitRemoteUrl?: string;
	gitBranch?: string;
	localPath?: string;
	customMetadata: { [key: string]: string };
	metadata: { [key: string]: string };
	readmeNotes: string;
	instructionNotes: string;
	breadcrumbSegments?: Array<{ label: string; uri?: string }>;
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
	private _lastCustomModule: any | undefined;
	private _workspaceStatuses: IWorkspaceStatusesInfo = {
		statuses: ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed'],
		mapping: {
			'Todo': 'Todo',
			'In Progress': 'In Progress',
			'Done': 'Done',
			'Blocked': 'Blocked',
			'Removed': 'Removed'
		},
		removedStatus: 'Removed',
		initialStatus: 'Todo',
		getCategory: (st?: string) => {
			if (!st) return 'Todo';
			const lower = st.toLowerCase();
			if (lower.includes('progress') || lower.includes('dev') || lower.includes('doing') || lower.includes('test') || lower.includes('review') || lower.includes('deploy')) return 'In Progress';
			if (lower.includes('done') || lower.includes('finish') || lower.includes('complete') || lower.includes('release')) return 'Done';
			if (lower.includes('block') || lower.includes('fail') || lower.includes('hold')) return 'Blocked';
			if (lower.includes('remove') || lower.includes('cancel') || lower.includes('archive')) return 'Removed';
			return 'Todo';
		}
	};

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
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IRequestService private readonly _requestService: IRequestService
	) {
		super(EntityDetailEditor.ID, group, telemetryService, themeService, _storageService);

		// Auto-reload data when underlying files are modified on disk (by AI or other tools)
		this._register(this._fileService.onDidFilesChange(e => {
			if (!this._entityUri || !this.isVisible()) return;
			if (e.affects(this._entityUri)) {
				this._resolvePathsAndLoadData();
			}
		}));
	}

	public async refresh(): Promise<void> {
		await this._resolvePathsAndLoadData();
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
		this._lastCustomModule = undefined;
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

		// 1. Global directory has priority for custom modules defined/updated in the Schema Designer
		const savedPath = this._storageService.get('anyagent.globalEntityTypePath', StorageScope.PROFILE, '~/.anyagent/entity_type');
		const userHome = this._environmentService.userHome.fsPath;
		const resolvedGlobal = (savedPath && savedPath.startsWith('~/')) ? userHome + savedPath.substring(1) : (savedPath === '~' ? userHome : (savedPath || '~/.anyagent/entity_type'));
		checkDirs.push(URI.file(resolvedGlobal));

		// 2. Local workspace directory hierarchy
		let curr = workspaceUri;
		while (curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
			checkDirs.push(URI.joinPath(curr, '.agents', 'entity_type'));
			checkDirs.push(URI.joinPath(curr, '.agents', 'entity_types'));
			const parent = dirname(curr);
			if (parent.path === curr.path) break;
			curr = parent;
		}

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
		return parseYaml(yaml);
	}

	private async _resolvePathsAndLoadData(): Promise<void> {
		if (!this._entityUri || !this._container) {
			return;
		}

		try {
			// 1. Resolve 4-MD file paths (robust checking of workspace.md/ticket.md, .agents and root)
			this._ticketFileUri = await this._resolveMainEntityFileUri(this._entityUri);
			this._instructionUri = await this._resolveFileUri(this._entityUri, 'instruction.md');
			this._readmeUri = await this._resolveFileUri(this._entityUri, 'README.md');
			this._workLogUri = await this._resolveWorkLogUri(this._entityUri);

			// 2. Read contents from 4-MD files
			const ticketContent = await this._safeReadFile(this._ticketFileUri);
			const readmeContent = await this._safeReadFile(this._readmeUri);
			const instructionContent = await this._safeReadFile(this._instructionUri);
			const workLogContent = await this._safeReadFile(this._workLogUri);

			const parsed = this._parseAllEntityData(ticketContent, readmeContent, instructionContent);

			// Fallback: discover local .git if remoteUrl or branch not recorded in metadata
			let gitRemoteUrl = parsed.gitRemoteUrl || '';
			let gitBranch = parsed.gitBranch || '';

			if ((!gitRemoteUrl || !gitBranch) && this._entityUri) {
				let curr: URI | undefined = this._entityUri;
				let foundGitUri: URI | undefined = undefined;
				while (curr && curr.path !== '/' && curr.path !== '\\' && curr.path !== '.') {
					const checkGit = URI.joinPath(curr, '.git');
					if (await this._fileService.exists(checkGit)) {
						foundGitUri = checkGit;
						break;
					}
					const parent = dirname(curr);
					if (parent.path === curr.path) break;
					curr = parent;
				}

				if (foundGitUri) {
					if (!gitBranch) {
						try {
							const headUri = URI.joinPath(foundGitUri, 'HEAD');
							if (await this._fileService.exists(headUri)) {
								const headContent = (await this._fileService.readFile(headUri)).value.toString().trim();
								if (headContent.startsWith('ref: refs/heads/')) {
									gitBranch = headContent.replace('ref: refs/heads/', '').trim();
								}
							}
						} catch {}
					}
					if (!gitRemoteUrl) {
						try {
							const configUri = URI.joinPath(foundGitUri, 'config');
							if (await this._fileService.exists(configUri)) {
								const configContent = (await this._fileService.readFile(configUri)).value.toString();
								const match = configContent.match(/url\s*=\s*(.+)/);
								if (match && match[1]) {
									gitRemoteUrl = match[1].trim();
								}
							}
						} catch {}
					}
				}
			}
			if (!gitRemoteUrl && (parsed.localPath || parsed.metadata['Local Path'] || parsed.metadata['Target Project'])) {
				try {
					const lp = parsed.localPath || parsed.metadata['Local Path'] || parsed.metadata['Target Project'];
					const localPathUri = URI.file(lp);
					const configUri = URI.joinPath(localPathUri, '.git', 'config');
					if (await this._fileService.exists(configUri)) {
						const configContent = (await this._fileService.readFile(configUri)).value.toString();
						const match = configContent.match(/url\s*=\s*(.+)/);
						if (match && match[1]) {
							gitRemoteUrl = match[1].trim();
						}
					}
				} catch {}
			}

			parsed.gitRemoteUrl = gitRemoteUrl;
			parsed.gitBranch = gitBranch;

			this._lastParsedData = parsed;
			this._entityType = parsed.ticketType || 'task';

			if (this._entityUri && this._workspacesExplorerService) {
				try {
					this._workspaceStatuses = await this._workspacesExplorerService.getWorkspaceStatuses(this._entityUri);
				} catch {}
			}

			const attachments = await this._getAttachments(this._entityUri);
			const customModule = await this._readCustomModule(this._entityUri, this._entityType);
			this._lastCustomModule = customModule;

			// If customModule exists, prune empty deleted fields from customMetadata so stale schemas do not linger
			if (customModule && Array.isArray(customModule.fields) && parsed.customMetadata) {
				const validKeys = new Set<string>();
				for (const f of customModule.fields) {
					if (f.label) validKeys.add(f.label.toLowerCase());
					if (f.id) validKeys.add(f.id.toLowerCase());
				}
				const internalLifecycleKeys = ['ticket statuses', 'status mapping', 'removed status', 'git remote url', 'git branch'];
				for (const k of Object.keys(parsed.customMetadata)) {
					if (internalLifecycleKeys.includes(k.toLowerCase())) continue;
					if (!validKeys.has(k.toLowerCase())) {
						const val = parsed.customMetadata[k];
						const isEmpty = val === undefined || val === null || String(val).trim() === '' || String(val).trim() === '[]' || String(val).trim() === '{}';
						if (isEmpty) {
							delete parsed.customMetadata[k];
						}
					}
				}
			}

			const agents = this._agentsManagerService ? await this._agentsManagerService.getAgents() : [];
			const allTickets = await this._loadAllAvailableTickets();

			// 2.5 Resolve hierarchical breadcrumb segments from root workspace down to current entity
			const breadcrumbSegments: Array<{ label: string; uri?: string }> = [];
			try {
				const wsRootUri = this._entityUri ? await this._workspacesExplorerService.findWorkspaceRootUri(this._entityUri) : undefined;
				const rootLabel = parsed.workspaceId || (wsRootUri ? basename(wsRootUri) : 'Workspace');
				breadcrumbSegments.push({ label: rootLabel, uri: wsRootUri?.toString() });

				if (wsRootUri && this._entityUri && this._entityUri.toString() !== wsRootUri.toString()) {
					const rootPath = wsRootUri.path.replace(/\/+$/, '');
					const entityPath = this._entityUri.path.replace(/\/+$/, '');
					if (entityPath.startsWith(rootPath + '/')) {
						const rel = entityPath.substring(rootPath.length + 1);
						const parts = rel.split('/').filter(Boolean);
						let curr = wsRootUri;
						for (let i = 0; i < parts.length - 1; i++) {
							const seg = parts[i];
							curr = URI.joinPath(curr, seg);
							const snap = this._workspacesExplorerService.getMetadataSnapshot(curr);
							const segLabel = snap?.ticketId || snap?.entityName || seg;
							breadcrumbSegments.push({ label: segLabel, uri: curr.toString() });
						}
					}
				}
				breadcrumbSegments.push({ label: parsed.ticketId || parsed.title || this._entityName });
			} catch {}
			parsed.breadcrumbSegments = breadcrumbSegments;

			// 3. Render directly into this._container as native high-performance DOM
			const html = this._generateHtml(parsed, workLogContent, attachments, customModule, agents, allTickets);
			this._setElementHTML(this._container, html);

			// 4. Attach direct click handlers for key interactive elements
			const directInfoBtn = this._container.querySelector('#status-lifecycle-info-btn') as HTMLElement | null;
			const popoverEl = this._container.querySelector('#status-lifecycle-popover') as HTMLElement | null;
			const closePopoverBtn = this._container.querySelector('#close-status-lifecycle-popover-btn') as HTMLElement | null;
			if (directInfoBtn && popoverEl) {
				directInfoBtn.onclick = (e) => {
					e.preventDefault();
					e.stopPropagation();
					const isHidden = popoverEl.style.display === 'none' || !popoverEl.style.display;
					popoverEl.style.display = isHidden ? 'flex' : 'none';
				};
			}
			if (closePopoverBtn && popoverEl) {
				closePopoverBtn.onclick = (e) => {
					e.preventDefault();
					e.stopPropagation();
					popoverEl.style.display = 'none';
				};
			}
		} catch (err) {
			console.error('Failed to resolve and render entity detail:', err);
		}
	}

	private _bindContainerEvents(): void {
		if (!this._container) return;

		this._container.addEventListener('click', async (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;

			// 0. Manual Refresh Button click
			if (target.id === 'entity-detail-refresh-btn' || target.closest('#entity-detail-refresh-btn')) {
				e.preventDefault();
				e.stopPropagation();
				await this._resolvePathsAndLoadData();
				this._notificationService.info(`Refreshed ticket data for '${this._entityName || 'ticket'}'.`);
				return;
			}

			// 0.05 Breadcrumb item navigation click
			const breadcrumbItem = target.closest('.breadcrumb-item') as HTMLElement | null;
			if (breadcrumbItem && breadcrumbItem.getAttribute('data-uri')) {
				const uriStr = breadcrumbItem.getAttribute('data-uri');
				if (uriStr && uriStr !== this._entityUri?.toString()) {
					e.preventDefault();
					e.stopPropagation();
					const targetUri = URI.parse(uriStr);
					const label = breadcrumbItem.textContent?.trim() || 'Entity';
					const isWorkflow = label.toLowerCase().includes('workflow') || (await this._fileService.exists(URI.joinPath(targetUri, '.agents', 'workflow_flowchart.json')));
					if (isWorkflow) {
						await this._editorService.openEditor(new WorkflowEditorInput(targetUri, label), { pinned: true });
					} else {
						await this._editorService.openEditor(new EntityDetailEditorInput(targetUri, label), { pinned: true });
					}
					return;
				}
			}

			// 0.1 Status Lifecycle Mapping Info button click
			const infoBtn = (target.id === 'status-lifecycle-info-btn' || target.classList.contains('status-lifecycle-info-btn')) ? target : target.closest('#status-lifecycle-info-btn, .status-lifecycle-info-btn');
			if (infoBtn) {
				e.preventDefault();
				e.stopPropagation();
				const popoverEl = this._container?.querySelector('#status-lifecycle-popover') as HTMLElement | null;
				if (popoverEl) {
					const isHidden = popoverEl.style.display === 'none' || !popoverEl.style.display;
					popoverEl.style.display = isHidden ? 'flex' : 'none';
				}
				return;
			}

			// 0.11 Close popover button click
			if (target.id === 'close-status-lifecycle-popover-btn' || target.closest('#close-status-lifecycle-popover-btn')) {
				e.preventDefault();
				e.stopPropagation();
				const popoverEl = this._container?.querySelector('#status-lifecycle-popover') as HTMLElement | null;
				if (popoverEl) {
					popoverEl.style.display = 'none';
				}
				return;
			}

			// Close popover if clicking outside
			const popoverEl = this._container?.querySelector('#status-lifecycle-popover') as HTMLElement | null;
			if (popoverEl && popoverEl.style.display === 'flex') {
				if (!target.closest('#status-lifecycle-popover') && !target.closest('#status-lifecycle-info-btn')) {
					popoverEl.style.display = 'none';
				}
			}

			// 0.12 Credential Eye Toggle click
			const credEyeBtn = target.closest('.cred-toggle-eye') as HTMLElement | null;
			if (credEyeBtn) {
				e.preventDefault();
				e.stopPropagation();
				const item = credEyeBtn.closest('.browser-cred-item');
				const textSpan = item?.querySelector('.cred-secret-text') as HTMLElement | null;
				if (textSpan) {
					const realVal = textSpan.getAttribute('data-real') || '';
					if (textSpan.textContent === '••••••••') {
						textSpan.textContent = realVal;
					} else {
						textSpan.textContent = '••••••••';
					}
				}
				return;
			}

			// 0.125 Parameter Copy Tag click
			const copyParamTag = target.closest('.ticket-param-copy-tag') as HTMLElement | null;
			if (copyParamTag) {
				e.preventDefault();
				e.stopPropagation();
				const token = copyParamTag.getAttribute('data-token') || '';
				if (token) {
					await this._clipboardService.writeText(token);
					this._notificationService.info(`Copied '${token}' to clipboard.`);
				}
				return;
			}

			// 0.13 Browser Copy Content button click
			const copyContentBtn = target.closest('.browser-copy-content-btn') as HTMLElement | null;
			if (copyContentBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = copyContentBtn.closest('.browser-primitive-card');
				const contentEl = card?.querySelector('.browser-content-display');
				const text = contentEl?.textContent || '';
				if (text && !text.includes('No webpage content extracted yet.')) {
					await this._clipboardService.writeText(text);
					this._notificationService.info('Webpage content copied to clipboard.');
				}
				return;
			}

			// 0.14 Browser Clear Content button click
			const clearContentBtn = target.closest('.browser-clear-content-btn') as HTMLElement | null;
			if (clearContentBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = clearContentBtn.getAttribute('data-field-key') || '';
				const card = clearContentBtn.closest('.browser-primitive-card') as HTMLElement | null;
				if (card) {
					const contentEl = card.querySelector('.browser-content-display');
					if (contentEl) {
						contentEl.innerHTML = '<span style="opacity: 0.4; font-style: italic;">No webpage content extracted yet. Enter a URL above and click "Fetch (Silent)" or "Open in Tab" to extract page contents.</span>';
					}
					const statusEl = card.querySelector('.browser-fetch-status') as HTMLElement | null;
					if (statusEl) {
						statusEl.textContent = 'Cleared';
						statusEl.style.color = '';
					}
					const urlInput = card.querySelector('.browser-url-input') as HTMLInputElement | null;
					const currentUrl = urlInput?.value.trim() || '';
					await this._saveBrowserPrimitiveData(fieldKey, currentUrl, '', '');
				}
				return;
			}

			// 0.15 Browser Silent Fetch Button click
			const silentFetchBtn = target.closest('.browser-silent-fetch-btn') as HTMLElement | null;
			if (silentFetchBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = silentFetchBtn.getAttribute('data-field-key') || '';
				const card = silentFetchBtn.closest('.browser-primitive-card') as HTMLElement | null;
				if (card) {
					await this._executeBrowserFetch(card, fieldKey, false);
				}
				return;
			}

			// 0.16 Browser Open in Tab Button click
			const openTabBtn = target.closest('.browser-open-tab-btn') as HTMLElement | null;
			if (openTabBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = openTabBtn.getAttribute('data-field-key') || '';
				const card = openTabBtn.closest('.browser-primitive-card') as HTMLElement | null;
				if (card) {
					await this._executeBrowserFetch(card, fieldKey, true);
				}
				return;
			}

			// 0.165 Browser New Tab Button (+) click
			const newTabBtn = target.closest('.browser-new-tab-btn') as HTMLElement | null;
			if (newTabBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = newTabBtn.closest('.browser-primitive-card') as HTMLElement | null;
				const urlInput = card?.querySelector('.browser-url-input') as HTMLInputElement | null;
				let url = urlInput?.value.trim() || 'https://www.google.com';
				if (!/^https?:\/\//i.test(url)) {
					url = 'https://' + url;
				}
				url = this._interpolateParameters(url);
				try {
					const uri = URI.parse(url);
					await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
						viewColumn: -2, // ViewColumn.Beside
						preserveFocus: false
					});
				} catch (e) {
					try {
						await this._commandService.executeCommand('simpleBrowser.show', url);
					} catch (err) {
						console.error('Failed to open simpleBrowser:', err);
					}
				}
				return;
			}

			// 0.2 Copy Git URL button click
			const copyGitBtn = target.closest('.copy-git-url-btn') as HTMLElement | null;
			if (copyGitBtn) {
				e.preventDefault();
				e.stopPropagation();
				const gitUrl = copyGitBtn.getAttribute('data-git-url');
				if (gitUrl) {
					this._clipboardService.writeText(gitUrl);
					const span = copyGitBtn.querySelector('span');
					if (span) span.textContent = 'Copied!';
					setTimeout(() => { if (span) span.textContent = 'Copy'; }, 1500);
					this._notificationService.info('Copied Git repository URL to clipboard.');
				}
				return;
			}

			// 0.3 Ticket Action Transition Button click
			const actionTransitionBtn = target.closest('.ticket-action-transition-btn') as HTMLElement | null;
			if (actionTransitionBtn) {
				e.preventDefault();
				e.stopPropagation();
				const btnLabel = actionTransitionBtn.getAttribute('data-action-label') || 'Action';
				const targetStatus = actionTransitionBtn.getAttribute('data-target-status') || '';
				await this._executeActionTransition(targetStatus, btnLabel);
				return;
			}

			// 0.4 Prompt Primitive: Toggle Target Mode (Model vs Agent)
			const promptModeBtn = target.closest('.prompt-mode-btn') as HTMLElement | null;
			if (promptModeBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = promptModeBtn.getAttribute('data-field-key') || '';
				const mode = promptModeBtn.getAttribute('data-mode') as 'model' | 'agent';
				const card = promptModeBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				if (card) {
					this._togglePromptMode(card, fieldKey, mode);
				}
				return;
			}

			// 0.41 Prompt Primitive: Run Prompt with Model
			const runPromptBtn = target.closest('.prompt-run-model-btn') as HTMLElement | null;
			if (runPromptBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = runPromptBtn.getAttribute('data-field-key') || '';
				const card = runPromptBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				if (card) {
					await this._executePromptWithModel(card, fieldKey);
				}
				return;
			}

			// 0.42 Prompt Primitive: Dispatch Task to AI Agent
			const dispatchAgentBtn = target.closest('.prompt-dispatch-agent-btn') as HTMLElement | null;
			if (dispatchAgentBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = dispatchAgentBtn.getAttribute('data-field-key') || '';
				const card = dispatchAgentBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				if (card) {
					await this._dispatchPromptToAgent(card, fieldKey);
				}
				return;
			}

			// 0.43 Prompt Primitive: Open in Agent Central
			const openCentralBtn = target.closest('.prompt-open-agent-central-btn') as HTMLElement | null;
			if (openCentralBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = openCentralBtn.getAttribute('data-field-key') || '';
				const card = openCentralBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				const textarea = card?.querySelector('.prompt-instruction-textarea') as HTMLTextAreaElement | null;
				const promptVal = textarea?.value.trim() || '';
				await this._handleMessage({
					type: 'openAgentCentral',
					field: `/Custom/${fieldKey}`,
					fieldType: 'prompt',
					label: fieldKey,
					currentValue: promptVal,
					options: [],
					source: `/Custom/${fieldKey}`
				});
				return;
			}

			// 0.44 Prompt Primitive: Save Prompt Instruction & Settings
			const savePromptBtn = target.closest('.prompt-save-btn') as HTMLElement | null;
			if (savePromptBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = savePromptBtn.getAttribute('data-field-key') || '';
				const card = savePromptBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				if (card) {
					await this._savePromptDataFromCard(card, fieldKey);
					this._notificationService.info(`Prompt settings for '${fieldKey}' saved.`);
				}
				return;
			}

			// 0.45 Prompt Primitive: Copy Output
			const copyPromptOutBtn = target.closest('.prompt-copy-output-btn') as HTMLElement | null;
			if (copyPromptOutBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = copyPromptOutBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				const display = card?.querySelector('.prompt-output-display') as HTMLElement | null;
				if (display && display.textContent) {
					this._clipboardService.writeText(display.textContent);
					this._notificationService.info('Copied AI execution output to clipboard.');
				}
				return;
			}

			// 0.46 Prompt Primitive: Clear Output
			const clearPromptOutBtn = target.closest('.prompt-clear-output-btn') as HTMLElement | null;
			if (clearPromptOutBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = clearPromptOutBtn.getAttribute('data-field-key') || '';
				const card = clearPromptOutBtn.closest('.prompt-primitive-card') as HTMLElement | null;
				if (card) {
					const display = card.querySelector('.prompt-output-display') as HTMLElement | null;
					if (display) display.innerHTML = '<span style="opacity: 0.4; font-style: italic;">No execution output yet. Click "Run with Model" or "Dispatch to Agent" above to run instructions.</span>';
					const statusText = card.querySelector('.prompt-status-text') as HTMLElement | null;
					if (statusText) statusText.textContent = 'Ready';
					await this._savePromptDataFromCard(card, fieldKey, '');
				}
				return;
			}

			// Python Primitive: Run Script button click
			const runPyBtn = target.closest('.python-run-script-btn') as HTMLElement | null;
			if (runPyBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = runPyBtn.getAttribute('data-field-key') || '';
				const card = runPyBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					await this._executePythonScriptInEditor(card, fieldKey);
				}
				return;
			}

			// Python Primitive: Save Code button click
			const savePyBtn = target.closest('.python-save-code-btn') as HTMLElement | null;
			if (savePyBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = savePyBtn.getAttribute('data-field-key') || '';
				const card = savePyBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					await this._savePythonDataFromCard(card, fieldKey);
					this._notificationService.info('Saved Python automation script.');
				}
				return;
			}

			// Python Primitive: Test Interpreter button click
			const testPyBtn = target.closest('.python-test-interpreter-btn') as HTMLElement | null;
			if (testPyBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = testPyBtn.getAttribute('data-field-key') || '';
				const card = testPyBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					await this._testPythonInterpreterInEditor(card, fieldKey);
				}
				return;
			}

			// Python Primitive: Create venv button click
			const createVenvBtn = target.closest('.python-create-venv-btn') as HTMLElement | null;
			if (createVenvBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = createVenvBtn.getAttribute('data-field-key') || '';
				const card = createVenvBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					await this._createVenvInEditor(card, fieldKey);
				}
				return;
			}

			// Python Primitive: Browse Interpreter button click
			const browsePyBtn = target.closest('.python-browse-interpreter-btn') as HTMLElement | null;
			if (browsePyBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = browsePyBtn.getAttribute('data-field-key') || '';
				const card = browsePyBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					await this._browsePythonInterpreterInEditor(card, fieldKey);
				}
				return;
			}

			// Python Primitive: Click on syntax highlighted code display to enter edit mode
			const pyDisplay = target.closest('.python-code-display') as HTMLElement | null;
			if (pyDisplay) {
				const card = pyDisplay.closest('.python-primitive-card') as HTMLElement | null;
				const textarea = card?.querySelector('.python-code-textarea') as HTMLTextAreaElement | null;
				const badge = card?.querySelector('.python-mode-badge') as HTMLElement | null;
				if (card && textarea) {
					pyDisplay.style.display = 'none';
					textarea.style.display = 'block';
					const h = pyDisplay.getBoundingClientRect().height;
					if (h > 60) {
						textarea.style.height = `${Math.max(120, Math.round(h))}px`;
					}
					if (badge) {
						badge.textContent = '✏️ Editing';
						badge.style.color = '#f59e0b';
						badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
						badge.style.background = 'rgba(245, 158, 11, 0.12)';
					}
					textarea.focus();
				}
				return;
			}

			// Python Primitive: Mode badge toggle
			const pyBadge = target.closest('.python-mode-badge') as HTMLElement | null;
			if (pyBadge) {
				const card = pyBadge.closest('.python-primitive-card') as HTMLElement | null;
				const pyDisplayEl = card?.querySelector('.python-code-display') as HTMLElement | null;
				const textarea = card?.querySelector('.python-code-textarea') as HTMLTextAreaElement | null;
				if (card && textarea && pyDisplayEl) {
					const isEditing = textarea.style.display !== 'none';
					if (isEditing) {
						pyDisplayEl.innerHTML = highlightPythonToHTML(textarea.value, { showLineNumbers: true });
						textarea.style.display = 'none';
						pyDisplayEl.style.display = 'block';
						pyBadge.textContent = '🎨 Highlighted';
						pyBadge.style.color = '#38bdf8';
						pyBadge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
						pyBadge.style.background = 'rgba(56, 189, 248, 0.12)';
					} else {
						pyDisplayEl.style.display = 'none';
						textarea.style.display = 'block';
						const h = pyDisplayEl.getBoundingClientRect().height;
						if (h > 60) {
							textarea.style.height = `${Math.max(120, Math.round(h))}px`;
						}
						pyBadge.textContent = '✏️ Editing';
						pyBadge.style.color = '#f59e0b';
						pyBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
						pyBadge.style.background = 'rgba(245, 158, 11, 0.12)';
						textarea.focus();
					}
				}
				return;
			}

			// Python Primitive: Insert Context Chip click
			const insertPyCtxChip = target.closest('.python-insert-ctx-chip') as HTMLElement | null;
			if (insertPyCtxChip) {
				e.preventDefault();
				e.stopPropagation();
				const card = insertPyCtxChip.closest('.python-primitive-card') as HTMLElement | null;
				const textarea = card?.querySelector('.python-code-textarea') as HTMLTextAreaElement | null;
				const textToInsert = insertPyCtxChip.getAttribute('data-insert') || '';
				const cursorOffset = parseInt(insertPyCtxChip.getAttribute('data-cursor-offset') || '0', 10);
				if (textarea && textToInsert) {
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const before = textarea.value.substring(0, start);
					const after = textarea.value.substring(end);
					textarea.value = before + textToInsert + after;
					const newCursor = start + textToInsert.length + cursorOffset;
					textarea.selectionStart = textarea.selectionEnd = newCursor;
					const pyDisplayEl = card?.querySelector('.python-code-display') as HTMLElement | null;
					if (pyDisplayEl) {
						pyDisplayEl.innerHTML = highlightPythonToHTML(textarea.value, { showLineNumbers: true });
					}
					textarea.focus();
					const fieldKey = insertPyCtxChip.getAttribute('data-field-key') || '';
					if (fieldKey && card) {
						await this._savePythonDataFromCard(card, fieldKey);
					}
				}
				return;
			}

			// Python Primitive: Context chips More / Less toggle
			const morePyCtxBtn = target.closest('.python-ctx-more-btn') as HTMLElement | null;
			if (morePyCtxBtn) {
				e.preventDefault();
				e.stopPropagation();
				const bar = morePyCtxBtn.closest('.python-ctx-chips-bar') as HTMLElement | null;
				const hiddenGroup = bar?.querySelector('.python-ctx-hidden-group') as HTMLElement | null;
				if (hiddenGroup) {
					const isHidden = hiddenGroup.style.display === 'none';
					hiddenGroup.style.display = isHidden ? 'contents' : 'none';
					const remainingCount = morePyCtxBtn.getAttribute('data-count') || '';
					morePyCtxBtn.textContent = isHidden ? 'Less' : `+${remainingCount} More...`;
				}
				return;
			}

			// Python Primitive: Copy Output button click
			const copyPyOutBtn = target.closest('.python-copy-output-btn') as HTMLElement | null;
			if (copyPyOutBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = copyPyOutBtn.closest('.python-primitive-card') as HTMLElement | null;
				const outputDisplay = card?.querySelector('.python-output-display') as HTMLElement | null;
				const text = outputDisplay?.textContent || '';
				if (text && !text.startsWith('No execution output yet')) {
					this._clipboardService.writeText(text);
					copyPyOutBtn.textContent = 'Copied!';
					setTimeout(() => { copyPyOutBtn.textContent = 'Copy'; }, 1500);
					this._notificationService.info('Copied Python execution output to clipboard.');
				}
				return;
			}

			// Python Primitive: Clear Output button click
			const clearPyOutBtn = target.closest('.python-clear-output-btn') as HTMLElement | null;
			if (clearPyOutBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = clearPyOutBtn.getAttribute('data-field-key') || '';
				const card = clearPyOutBtn.closest('.python-primitive-card') as HTMLElement | null;
				if (card) {
					(card as any)._lastPythonResult = undefined;
					const resultBlock = card.querySelector('.python-result-block') as HTMLElement | null;
					if (resultBlock) resultBlock.remove();
					const outputDisplay = card.querySelector('.python-output-display') as HTMLElement | null;
					if (outputDisplay) {
						outputDisplay.innerHTML = '<span style="opacity: 0.4; font-style: italic;">No execution logs yet. Click "Run Script" above to execute the automation code.</span>';
					}
					const statusText = card.querySelector('.python-status-text') as HTMLElement | null;
					if (statusText) {
						statusText.textContent = 'Logs and output cleared';
						statusText.style.color = 'inherit';
					}
					await this._savePythonDataFromCard(card, fieldKey, '', undefined, undefined, null);
				}
				return;
			}

			// Output Item: Copy
			const copyOutputItemBtn = target.closest('.output-item-copy-btn') as HTMLElement | null;
			if (copyOutputItemBtn) {
				e.preventDefault();
				e.stopPropagation();
				const specKey = copyOutputItemBtn.getAttribute('data-spec-key') || '';
				const card = copyOutputItemBtn.closest('.output-primitive-card, .result-primitive-card') as HTMLElement | null;
				const item = card?.querySelector(`.output-spec-item[data-spec-key="${specKey}"]`);
				const rawTa = item?.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
				const text = rawTa?.value || '';
				if (text) {
					await this._clipboardService.writeText(text);
					this._notificationService.info(`Output '${specKey}' copied to clipboard.`);
				} else {
					this._notificationService.warn('No content to copy.');
				}
				return;
			}

			// Output Item: Export CSV
			const exportOutputItemCsvBtn = target.closest('.output-item-export-csv-btn') as HTMLElement | null;
			if (exportOutputItemCsvBtn) {
				e.preventDefault();
				e.stopPropagation();
				const specKey = exportOutputItemCsvBtn.getAttribute('data-spec-key') || '';
				const card = exportOutputItemCsvBtn.closest('.output-primitive-card, .result-primitive-card') as HTMLElement | null;
				const item = card?.querySelector(`.output-spec-item[data-spec-key="${specKey}"]`);
				const rawTa = item?.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
				const text = rawTa?.value || '';
				this._exportResultToCsv(text, specKey);
				return;
			}

			// Output: Sync All Outputs
			const syncOutputsBtn = target.closest('.output-sync-all-btn') as HTMLElement | null;
			if (syncOutputsBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = syncOutputsBtn.closest('.output-primitive-card, .result-primitive-card') as HTMLElement | null;
				if (card) {
					const fieldKey = syncOutputsBtn.getAttribute('data-field-key') || '';
					await this._syncAllOutputItems(card, fieldKey);
				}
				return;
			}

			// Output: Copy All Data as JSON
			const copyAllOutputBtn = target.closest('.output-copy-all-btn') as HTMLElement | null;
			if (copyAllOutputBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = copyAllOutputBtn.closest('.output-primitive-card, .result-primitive-card') as HTMLElement | null;
				if (card) {
					const allOutputs: Record<string, string> = {};
					const items = card.querySelectorAll('.output-spec-item');
					items.forEach(it => {
						const sKey = it.getAttribute('data-spec-key') || '';
						const ta = it.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
						if (sKey) { allOutputs[sKey] = ta?.value || ''; }
					});
					const jsonStr = JSON.stringify(allOutputs, null, 2);
					await this._clipboardService.writeText(jsonStr);
					this._notificationService.info('All output items copied as JSON.');
				}
				return;
			}

			// 0.47 Result Primitive: Copy Result Content
			const copyResultBtn = target.closest('.result-copy-btn') as HTMLElement | null;
			if (copyResultBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = copyResultBtn.closest('.result-primitive-card') as HTMLElement | null;
				const rawTa = card?.querySelector('.result-raw-content') as HTMLTextAreaElement | null;
				const text = rawTa?.value || '';
				if (text) {
					await this._clipboardService.writeText(text);
					this._notificationService.info('Result content copied to clipboard.');
				} else {
					this._notificationService.warn('No content to copy.');
				}
				return;
			}

			// 0.48 Result Primitive: Export CSV
			const exportCsvBtn = target.closest('.result-export-csv-btn') as HTMLElement | null;
			if (exportCsvBtn) {
				e.preventDefault();
				e.stopPropagation();
				const fieldKey = exportCsvBtn.getAttribute('data-field-key') || '';
				const card = exportCsvBtn.closest('.result-primitive-card') as HTMLElement | null;
				const rawTa = card?.querySelector('.result-raw-content') as HTMLTextAreaElement | null;
				const text = rawTa?.value || '';
				this._exportResultToCsv(text, fieldKey);
				return;
			}

			// 0.49 Result Primitive: Sync from AI Prompt
			const syncPromptBtn = target.closest('.result-sync-prompt-btn') as HTMLElement | null;
			if (syncPromptBtn) {
				e.preventDefault();
				e.stopPropagation();
				const card = syncPromptBtn.closest('.result-primitive-card') as HTMLElement | null;
				if (card) {
					const fieldKey = syncPromptBtn.getAttribute('data-field-key') || '';
					const promptCard = this._container?.querySelector('.prompt-primitive-card');
					const promptOutputEl = promptCard?.querySelector('.prompt-output-display');
					const text = promptOutputEl?.textContent || '';
					if (!text || text.includes('No execution output yet.')) {
						this._notificationService.warn('No AI Prompt output available to sync. Run an AI Prompt first.');
						return;
					}
					await this._setResultCardContent(card, fieldKey, text);
					this._notificationService.info(`Synced output from AI Prompt into '${fieldKey}'.`);
				}
				return;
			}

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

			// 8. Trigger File Upload Dropzone (if present)
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
						validateInput: async (val: string) => val.trim() ? null : 'Task title cannot be empty'
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
			const target = e.target as HTMLElement | null;
			const paramInput = target?.closest('.ticket-parameter-input') as HTMLInputElement | HTMLSelectElement | null;
			if (paramInput) {
				const fieldKey = paramInput.getAttribute('data-field-key') || '';
				const paramName = paramInput.getAttribute('data-param-name') || '';
				const newValue = paramInput.value;
				if (fieldKey && paramName) {
					await this._saveTicketParameterValue(fieldKey, paramName, newValue);
				}
				return;
			}

			const outputItemSelector = target?.closest('.output-item-format-selector') as HTMLSelectElement | null;
			if (outputItemSelector) {
				const fieldKey = outputItemSelector.getAttribute('data-field-key') || '';
				const specKey = outputItemSelector.getAttribute('data-spec-key') || '';
				const card = outputItemSelector.closest('.output-primitive-card, .result-primitive-card') as HTMLElement | null;
				if (card) {
					await this._updateOutputItemFormat(card, fieldKey, specKey, outputItemSelector.value);
				}
				return;
			}

			const formatSelector = target?.closest('.result-format-selector') as HTMLSelectElement | null;
			if (formatSelector) {
				const fieldKey = formatSelector.getAttribute('data-field-key') || '';
				const card = formatSelector.closest('.result-primitive-card, .output-primitive-card') as HTMLElement | null;
				if (card) {
					await this._updateResultCardFormat(card, fieldKey, formatSelector.value);
				}
				return;
			}

			const fileInput = target as HTMLInputElement | null;
			if (fileInput && fileInput.id === 'file-input' && fileInput.files && fileInput.files.length > 0) {
				const file = fileInput.files[0];
				const buffer = await file.arrayBuffer();
				await this._handleMessage({
					type: 'uploadAttachment',
					name: file.name,
					data: Array.from(new Uint8Array(buffer))
				});
			}
		});

		this._container.addEventListener('blur', async (e: FocusEvent) => {
			const target = e.target as HTMLElement | null;
			const paramInput = target?.closest('.ticket-parameter-input') as HTMLInputElement | null;
			if (paramInput && paramInput.tagName === 'INPUT') {
				const fieldKey = paramInput.getAttribute('data-field-key') || '';
				const paramName = paramInput.getAttribute('data-param-name') || '';
				const newValue = paramInput.value;
				if (fieldKey && paramName) {
					await this._saveTicketParameterValue(fieldKey, paramName, newValue);
				}
			}
		}, true);

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

		this._container.addEventListener('keydown', async (e: KeyboardEvent) => {
			if (e.key === 'Tab') {
				const pyTextarea = (e.target as HTMLElement)?.closest('.python-code-textarea') as HTMLTextAreaElement | null;
				if (pyTextarea) {
					e.preventDefault();
					e.stopPropagation();
					const start = pyTextarea.selectionStart;
					const end = pyTextarea.selectionEnd;
					pyTextarea.value = pyTextarea.value.substring(0, start) + '    ' + pyTextarea.value.substring(end);
					pyTextarea.selectionStart = pyTextarea.selectionEnd = start + 4;
					return;
				}
			}
			if (e.key === 'Escape') {
				const pyTextarea = (e.target as HTMLElement)?.closest('.python-code-textarea') as HTMLTextAreaElement | null;
				if (pyTextarea) {
					const card = pyTextarea.closest('.python-primitive-card') as HTMLElement | null;
					const pyDisplay = card?.querySelector('.python-code-display') as HTMLElement | null;
					const badge = card?.querySelector('.python-mode-badge') as HTMLElement | null;
					if (card && pyDisplay) {
						pyDisplay.innerHTML = highlightPythonToHTML(pyTextarea.value, { showLineNumbers: true });
						pyTextarea.style.display = 'none';
						pyDisplay.style.display = 'block';
						if (badge) {
							badge.textContent = '🎨 Highlighted';
							badge.style.color = '#38bdf8';
							badge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
							badge.style.background = 'rgba(56, 189, 248, 0.12)';
						}
					}
					return;
				}
			}
			if (e.key === 'Enter') {
				const urlInput = (e.target as HTMLElement)?.closest('.browser-url-input') as HTMLInputElement | null;
				if (urlInput) {
					e.preventDefault();
					e.stopPropagation();
					const card = urlInput.closest('.browser-primitive-card') as HTMLElement | null;
					const fetchBtn = card?.querySelector('.browser-silent-fetch-btn') as HTMLElement | null;
					const fieldKey = fetchBtn?.getAttribute('data-field-key') || '';
					if (card && fieldKey) {
						await this._executeBrowserFetch(card, fieldKey, false);
					}
				}
			}
		});

		this._container.addEventListener('focusout', (e: FocusEvent) => {
			const pyTextarea = (e.target as HTMLElement)?.closest('.python-code-textarea') as HTMLTextAreaElement | null;
			if (pyTextarea) {
				const card = pyTextarea.closest('.python-primitive-card') as HTMLElement | null;
				const pyDisplay = card?.querySelector('.python-code-display') as HTMLElement | null;
				const badge = card?.querySelector('.python-mode-badge') as HTMLElement | null;
				if (card && pyDisplay) {
					setTimeout(() => {
						pyDisplay.innerHTML = highlightPythonToHTML(pyTextarea.value, { showLineNumbers: true });
						pyTextarea.style.display = 'none';
						pyDisplay.style.display = 'block';
						if (badge) {
							badge.textContent = '🎨 Highlighted';
							badge.style.color = '#38bdf8';
							badge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
							badge.style.background = 'rgba(56, 189, 248, 0.12)';
						}
					}, 180);
				}
			}
		});
	}


	private async _resolveMainEntityFileUri(baseUri: URI): Promise<URI> {
		const candidates = ['workspace.md', 'job.md', 'project.md', 'task.md', 'ticket.md', 'agent.md', 'workflow.md', 'case.md', 'issue.md', 'analysis.md'];
		for (const name of candidates) {
			const p1 = URI.joinPath(baseUri, '.agents', name);
			if (await this._fileService.exists(p1)) return p1;
			const p2 = URI.joinPath(baseUri, name);
			if (await this._fileService.exists(p2)) return p2;
		}
		return URI.joinPath(baseUri, '.agents', 'ticket.md');
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
		let currentCustomKey: string | null = null;
		const ticketLines = ticketContent.split(/\r?\n/);
		for (const line of ticketLines) {
			if (line.startsWith('### Self Defined Data')) {
				inSelfDefined = true;
				currentCustomKey = null;
				continue;
			}
			if (line.startsWith('### ') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				inSelfDefined = false;
				currentCustomKey = null;
			}
			const match = line.match(/^\s*-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
			if (match) {
				const key = match[1].trim();
				const val = match[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				if (inSelfDefined && line.startsWith('  -')) {
					customMetadata[key] = val;
					currentCustomKey = key;
				} else {
					metadata[key] = val;
					currentCustomKey = null;
				}
			} else if (inSelfDefined && currentCustomKey && !line.startsWith('#') && !line.startsWith('---') && !line.match(/^\s*-\s*\*\*/)) {
				customMetadata[currentCustomKey] = (customMetadata[currentCustomKey] || '') + '\n' + line;
			}
		}

		// 2. Parse README.md
		let readmeTitle = '';
		let readmeDesc = '';
		let readmeWorkspaceId = '';
		let readmeTicketId = '';
		const readmeNotesLines: string[] = [];
		let isPastReadmeMeta = false;
		const readmeLines = readmeContent.split(/\r?\n/);
		for (const line of readmeLines) {
			const wsMatch = line.match(/^\s*-\s*\*\*Workspace ID\*\*:\s*(.*)$/i);
			if (wsMatch) {
				readmeWorkspaceId = wsMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const tidMatch = line.match(/^\s*-\s*\*\*Ticket ID\*\*:\s*(.*)$/i);
			if (tidMatch) {
				readmeTicketId = tidMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
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
		let instWorkspaceId = '';
		let instTicketId = '';
		let instGitRemote = '';
		let instGitBranch = '';
		let instLocalPath = '';
		const instNotesLines: string[] = [];
		let isPastInstMeta = false;
		const instLines = instructionContent.split(/\r?\n/);
		for (const line of instLines) {
			const wsMatch = line.match(/^\s*-\s*\*\*Workspace ID\*\*:\s*(.*)$/i);
			if (wsMatch) {
				instWorkspaceId = wsMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const tidMatch = line.match(/^\s*-\s*\*\*Ticket ID\*\*:\s*(.*)$/i);
			if (tidMatch) {
				instTicketId = tidMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
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
			const gitRepoMatch = line.match(/^\s*-\s*(?:\*\*)?(?:Git\s+Repository(?:\s+URL)?|Git\s+Remote\s+URL|Git\s+Repo)(?:\*\*)?\s*[:：]\s*(.*)$/i);
			if (gitRepoMatch) {
				instGitRemote = gitRepoMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const gitBranchMatch = line.match(/^\s*-\s*(?:\*\*)?(?:Git\s+Branch)(?:\*\*)?\s*[:：]\s*(.*)$/i);
			if (gitBranchMatch) {
				instGitBranch = gitBranchMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			const localPathMatch = line.match(/^\s*-\s*(?:\*\*)?(?:Local\s+Path|Target\s+Project(?:\s+Path)?)(?:\*\*)?\s*[:：]\s*(.*)$/i);
			if (localPathMatch) {
				instLocalPath = localPathMatch[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
				continue;
			}
			if (line.startsWith('---') || (line.startsWith('## ') && !line.startsWith('## Overview'))) {
				isPastInstMeta = true;
			}
			if (isPastInstMeta) {
				instNotesLines.push(line);
			}
		}

		const rawFolderId = this._entityUri ? basename(this._entityUri) : '';
		const ticketId = metadata['Ticket ID'] || instTicketId || readmeTicketId || (rawFolderId && !rawFolderId.includes(' ') ? rawFolderId : '') || this._entityName || '';
		const workspaceId = metadata['Workspace ID'] || instWorkspaceId || readmeWorkspaceId || '';
		const ticketType = metadata['Ticket Type'] || this._entityType || 'job';
		const title = readmeTitle || metadata['Title'] || customMetadata['Title'] || customMetadata['title'] || this._entityName || ticketId;
		const description = (readmeDesc && readmeDesc !== 'None') ? readmeDesc : (metadata['Description'] || customMetadata['Description'] || customMetadata['description'] || '');

		const resolvedGitRemote = metadata['Git Remote URL'] ||
			metadata['Git Repository'] ||
			metadata['Git Repository URL'] ||
			metadata['Git Repo'] ||
			customMetadata['Git Remote URL'] ||
			customMetadata['Git Repository'] ||
			instGitRemote ||
			'';
		const resolvedGitBranch = metadata['Git Branch'] ||
			customMetadata['Git Branch'] ||
			instGitBranch ||
			'';
		const resolvedLocalPath = metadata['Local Path'] ||
			customMetadata['Local Path'] ||
			instLocalPath ||
			'';

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
			gitRemoteUrl: resolvedGitRemote,
			gitBranch: resolvedGitBranch,
			localPath: resolvedLocalPath,
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

	private _escapeHtml(str: string | undefined): string {
		return this._escapeHtmlAttr(str);
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

	private _buildHierarchyTree(data: IParsedTicketData | undefined, agents: any[], allTickets: any[] = [], customModule?: any): any[] {
		if (!data) return [];
		if (!customModule) customModule = this._lastCustomModule;
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
				currentValue: data.status || this._workspaceStatuses.statuses[0] || 'Todo',
				options: isAgent ? ['idle', 'busy', 'offline'] : this._workspaceStatuses.statuses
			},
			{
				path: '/Attributes/Priority',
				label: 'Priority',
				fieldType: 'priority',
				currentValue: data.priority || 'Medium',
				options: ['Very High', 'High', 'Medium', 'Low', 'Very Low']
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
			const internalLifecycleKeys = ['Ticket Statuses', 'Status Mapping', 'Removed Status', 'Git Remote URL', 'Git Branch', 'Title', 'title', 'Description', 'description'];
			for (const [k, v] of Object.entries(data.customMetadata)) {
				if (internalLifecycleKeys.includes(k)) {
					continue;
				}

				const modField = customModule?.fields && Array.isArray(customModule.fields)
					? customModule.fields.find((f: any) =>
						(f.label && f.label.toLowerCase() === k.toLowerCase()) ||
						(f.id && f.id.toLowerCase() === k.toLowerCase()) ||
						(f.id && f.id.toLowerCase().replace(/_/g, ' ') === k.toLowerCase()) ||
						(f.label && f.label.toLowerCase().replace(/_/g, ' ') === k.toLowerCase().replace(/_/g, ' '))
					)
					: undefined;

				const isAttachment = (modField && modField.type === 'attachment') ||
					k.toLowerCase().includes('attachment') ||
					(typeof v === 'string' && (v.trim().startsWith('[{"name":') || v.trim().startsWith('{"name":'))) ||
					(Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] && 'name' in v[0]) ||
					(v && typeof v === 'object' && 'name' in v);

				if (isAttachment) {
					const rawVal = v !== undefined && v !== null ? String(v).trim() : '';
					const isValEmpty = !rawVal || rawVal === 'None' || rawVal === 'null' || rawVal === 'undefined' || rawVal === 'N/A';
					const strVal = isValEmpty ? 'None' : (typeof v === 'string' ? v : JSON.stringify(v));
					customChildren.push({
						path: `/Custom/${k}`,
						label: k,
						fieldType: 'attachment',
						currentValue: strVal,
						options: []
					});
					continue;
				}

				const isDeclaredNonList = modField && modField.type && modField.type !== 'dynamic_list' && modField.type !== 'container';

				let parsedItems: any[] | null = null;
				if (!isDeclaredNonList) {
					if (typeof v === 'string' && v.trim().startsWith('[')) {
						try {
							parsedItems = JSON.parse(v);
						} catch { }
					} else if (Array.isArray(v)) {
						parsedItems = v;
					}
				}

				if (parsedItems && Array.isArray(parsedItems) && !isDeclaredNonList) {
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
							currentValue: JSON.stringify(item),
							children: itemFields
						});
					});

					customChildren.push({
						path: `/Custom/${k}`,
						label: k,
						fieldType: 'dynamic_list',
						currentValue: typeof v === 'string' ? v : JSON.stringify(v),
						children: listItems
					});
				} else {
					const rawVal = v !== undefined && v !== null ? String(v).trim() : '';
					const isValEmpty = !rawVal || rawVal === 'None' || rawVal === 'null' || rawVal === 'undefined' || rawVal === 'N/A';
					const strVal = isValEmpty ? 'None' : rawVal;
					const isRange = strVal !== 'None' && (strVal.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(strVal));
					const isMultiline = strVal.length > 80 || strVal.includes('\n');

					let resolvedType = modField?.type;
					if (!resolvedType) {
						if (isAttachment) resolvedType = 'attachment';
						else if (isRange) resolvedType = 'date_range';
						else if (strVal.toLowerCase() === 'true' || strVal.toLowerCase() === 'false') resolvedType = 'switch';
						else if (isMultiline) resolvedType = 'textarea';
						else resolvedType = 'text';
					}

					customChildren.push({
						path: `/Custom/${k}`,
						label: k,
						fieldType: resolvedType,
						currentValue: strVal,
						options: modField?.options || modField?.choices || [],
						unit: modField?.unit,
						precision: modField?.precision
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
				const rawFolderId = this._entityUri ? basename(this._entityUri) : '';
				const ticketId = this._lastParsedData?.ticketId || (rawFolderId && !rawFolderId.includes(' ') ? rawFolderId : '') || this._entityName || '';
				const workspaceId = this._lastParsedData?.workspaceId || '';
				const field = (e as any).field || '';

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
				const hierarchyTree = this._buildHierarchyTree(this._lastParsedData, agents, allTickets, this._lastCustomModule);

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
						hierarchyTree: hierarchyTree,
						entityUri: this._entityUri?.toString()
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
			'### AI Execution Log',
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

	private async _executeActionTransition(targetStatus: string, actionLabel: string): Promise<void> {
		const currentStatus = this._lastParsedData?.status || 'Todo';
		if (!targetStatus || targetStatus.trim() === '') {
			this._notificationService.info(`Action '${actionLabel}' triggered.`);
			if (this._workLogUri) {
				const logEntry = `- **Action**: Clicked '${actionLabel}'\n- **Status Transition**: None configured. Current status remains **${currentStatus}**.`;
				await this._handleMessage({ type: 'addWorkLog', log: logEntry });
			}
			return;
		}

		if (currentStatus.trim().toLowerCase() === targetStatus.trim().toLowerCase()) {
			this._notificationService.info(`Ticket '${this._entityName || 'ticket'}' is already in '${targetStatus}' status.`);
			return;
		}

		try {
			await this._handleMessage({
				type: 'saveMetadata',
				metadata: { 'Status': targetStatus },
				customMetadata: {}
			});

			if (this._workLogUri) {
				const logEntry = `- **Action Triggered**: '${actionLabel}'\n- **Status Transition**: Changed status from **${currentStatus}** to **${targetStatus}**.`;
				await this._handleMessage({ type: 'addWorkLog', log: logEntry });
			}

			this._notificationService.info(`Ticket status updated to '${targetStatus}' via '${actionLabel}'.`);
		} catch (err) {
			console.error('Failed to execute action transition:', err);
			this._notificationService.error(`Failed to transition status: ${String(err)}`);
		}
	}

	private async _fetchUrlContent(
		rawUrl: string,
		credentials?: Array<{ key: string; value: string }>
	): Promise<{ title: string; content: string; isAuthRequired?: boolean; rawError?: string }> {
		let targetUrl = rawUrl.trim();
		if (!/^https?:\/\//i.test(targetUrl)) {
			targetUrl = 'https://' + targetUrl;
		}

		// 1. Try headless extraction via IWebContentExtractorService first
		// This uses the integrated browser's session partition ('persist:vscode-browser'),
		// so logged-in cookies and JavaScript dynamic single-page applications (SPA) are executed seamlessly!
		try {
			const extractorService = this._instantiationService.invokeFunction(accessor => accessor.get(IWebContentExtractorService));
			if (extractorService) {
				const uri = URI.parse(targetUrl);
				const extractResults = await Promise.race([
					extractorService.extract([uri], { followRedirects: true, bypassCache: true }),
					new Promise<WebContentExtractResult[]>((_, reject) => setTimeout(() => reject(new Error('Extraction timed out')), 25000))
				]);
				if (extractResults && extractResults.length > 0) {
					const first = extractResults[0];
					if (first.status === 'ok' && first.result && first.result.length > 30) {
						const title = first.title || targetUrl;
						const formatted = `# ${title}\nURL: ${targetUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${first.result}`;
						return { title, content: formatted };
					} else if (first.status === 'error' && /auth|401|403|login|session|verification/i.test(first.error)) {
						return {
							title: targetUrl,
							content: first.result || first.error,
							isAuthRequired: true,
							rawError: first.error
						};
					}
				}
			}
		} catch {
			// Fallback to HTTP request
		}

		// 2. Fallback to direct HTTP request with bridged browser cookies & user credentials
		let html = '';
		let statusCode = 200;
		try {
			let reqService: IRequestService = this._requestService;
			try {
				const mainProcessService = this._instantiationService.invokeFunction(accessor => accessor.get(IMainProcessService));
				if (mainProcessService) {
					reqService = new RequestChannelClient(mainProcessService.getChannel('request'));
				}
			} catch {
				// Fallback to renderer requestService
			}

			const extraHeaders: Record<string, string> = {};
			if (credentials && Array.isArray(credentials)) {
				for (const c of credentials) {
					if (!c.key || !c.value) { continue; }
					const lowerKey = c.key.toLowerCase().trim();
					if (lowerKey === 'cookie') {
						extraHeaders['Cookie'] = c.value;
					} else if (lowerKey === 'li_at') {
						extraHeaders['Cookie'] = (extraHeaders['Cookie'] ? extraHeaders['Cookie'] + '; ' : '') + `li_at=${c.value}`;
					} else if (lowerKey === 'token' || lowerKey === 'bearer') {
						extraHeaders['Authorization'] = `Bearer ${c.value}`;
					} else if (lowerKey === 'authorization') {
						extraHeaders['Authorization'] = c.value;
					} else {
						extraHeaders[c.key.trim()] = c.value;
					}
				}
			}

			const requestOptions = {
				type: 'GET',
				url: targetUrl,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.9',
					'Sec-Fetch-Dest': 'document',
					'Sec-Fetch-Mode': 'navigate',
					'Sec-Fetch-Site': 'none',
					...extraHeaders
				},
				timeout: 20000,
				callSite: 'browserPrimitive'
			};
			const context = await reqService.request(requestOptions, CancellationToken.None);
			statusCode = context.res.statusCode || 200;
			const text = await asText(context);
			html = text || '';
		} catch (err: any) {
			const rawErr = err?.message || String(err);
			return {
				title: targetUrl,
				content: `Failed to fetch URL (${targetUrl}): ${rawErr}`,
				rawError: rawErr
			};
		}

		if (!html) {
			return { title: targetUrl, content: `Empty response received from ${targetUrl}`, rawError: 'Empty response body' };
		}

		// Detect true authentication walls (redirects to login, 401, 403, or authwall pages)
		const isAuthPage = statusCode === 401 || statusCode === 403 ||
			(html.includes('/uas/login') && !targetUrl.includes('/login') && !targetUrl.includes('/signup')) ||
			(html.includes('authwall') && !targetUrl.includes('authwall'));

		if (isAuthPage) {
			return {
				title: targetUrl,
				content: html,
				isAuthRequired: true,
				rawError: `HTTP ${statusCode}: Authentication or Session Verification Required`
			};
		}

		try {
			let title = targetUrl;
			const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
			}

			const cleanedText = this._cleanHtmlToText(html);
			const maxChars = 25000;
			const displayContent = cleanedText.length > maxChars
				? cleanedText.slice(0, maxChars) + '\n\n... [Content truncated for display and AI context]'
				: cleanedText;

			const formatted = `# ${title}\nURL: ${targetUrl}\nFetched At: ${new Date().toLocaleString()}\n\n${displayContent}`;
			return { title, content: formatted };
		} catch (parseErr: any) {
			const cleaned = this._cleanHtmlToText(html);
			return { title: targetUrl, content: cleaned };
		}
	}

	private _extractJobsFromHtml(html: string): string {
		try {
			const seenIds = new Set<string>();
			const jobs: Array<{ jobId: string; title: string; company: string; location: string; link: string }> = [];

			// 1. Regex search for Voyager JobPosting entities in embedded JSON
			const entityRegex = /"entityUrn":"urn:li:(?:fsd_)?jobPosting:([0-9]+)"/g;
			let match: RegExpExecArray | null;
			while ((match = entityRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);

				const contextStart = Math.max(0, match.index - 500);
				const contextEnd = Math.min(html.length, match.index + 1500);
				const snippet = html.slice(contextStart, contextEnd);

				let title = '';
				const titleMatch = snippet.match(/"title":\{"text":"([^"]+)"\}|"title":"([^"]+)"/);
				if (titleMatch) {
					title = titleMatch[1] || titleMatch[2] || '';
				}

				let company = '';
				const compMatch = snippet.match(/"companyName":"([^"]+)"|"primaryDescription":\{"text":"([^"]+)"\}/);
				if (compMatch) {
					company = compMatch[1] || compMatch[2] || '';
				}

				let location = '';
				const locMatch = snippet.match(/"formattedLocation":"([^"]+)"|"secondaryDescription":\{"text":"([^"]+)"\}/);
				if (locMatch) {
					location = locMatch[1] || locMatch[2] || '';
				}

				jobs.push({
					jobId,
					title: title || 'Job Posting',
					company: company || 'Unknown Company',
					location: location || '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			// 2. Regex search for currentJobId or /jobs/view/ in HTML attributes
			const hrefRegex = /(?:currentJobId=|\/jobs\/view\/)([0-9]+)/g;
			while ((match = hrefRegex.exec(html)) !== null) {
				const jobId = match[1];
				if (seenIds.has(jobId)) { continue; }
				seenIds.add(jobId);
				jobs.push({
					jobId,
					title: 'Job Posting',
					company: 'Unknown Company',
					location: '',
					link: `https://www.linkedin.com/jobs/view/${jobId}/`
				});
			}

			if (jobs.length === 0) {
				return '';
			}

			let md = `## Extracted Job Listings (${jobs.length} Jobs Found)\n\n`;
			md += `| # | Job ID | Job Title | Company | Location | Direct Link |\n`;
			md += `|---|---|---|---|---|---|\n`;
			for (let i = 0; i < jobs.length; i++) {
				const j = jobs[i];
				md += `| ${i + 1} | ${j.jobId} | ${j.title} | ${j.company} | ${j.location || '-'} | [${j.title}](${j.link}) |\n`;
			}
			md += `\n---\n\n`;
			return md;
		} catch {
			return '';
		}
	}

	private _cleanHtmlToText(html: string): string {
		try {
			const jobTable = this._extractJobsFromHtml(html);

			// 1. Remove non-content tags including script, style, svg, iframe, noscript, etc.
			let clean = html.replace(/<(script|style|svg|noscript|iframe|canvas|video|audio|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
			// 2. Convert block-level tags and line-breaks to newlines
			clean = clean.replace(/<\/?(p|div|li|h[1-6]|tr|article|section|header|footer|br|blockquote|table|ol|ul)[^>]*>/gi, '\n');
			// 3. Strip all remaining HTML tags
			clean = clean.replace(/<[^>]+>/g, ' ');
			// 4. Decode common HTML entities
			clean = clean
				.replace(/&nbsp;/gi, ' ')
				.replace(/&amp;/gi, '&')
				.replace(/&lt;/gi, '<')
				.replace(/&gt;/gi, '>')
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/&middot;/gi, '·');
			// 5. Clean up multiple spaces and empty lines
			const lines = clean.split('\n')
				.map(l => l.replace(/[ \t]+/g, ' ').trim())
				.filter(l => l.length > 0);

			const mainText = lines.join('\n');
			return jobTable ? (jobTable + mainText) : mainText;
		} catch {
			return html.replace(/<[^>]+>/g, ' ').slice(0, 10000);
		}
	}

	private async _executeBrowserFetch(card: HTMLElement, fieldKey: string, openTab: boolean): Promise<void> {
		const urlInput = card.querySelector('.browser-url-input') as HTMLInputElement | null;
		let url = urlInput?.value.trim() || '';
		if (!url) {
			this._notificationService.warn('Please enter a target URL before fetching.');
			urlInput?.focus();
			return;
		}

		if (!/^https?:\/\//i.test(url)) {
			url = 'https://' + url;
			if (urlInput) urlInput.value = url;
		}

		const finalUrl = this._interpolateParameters(url);

		const statusEl = card.querySelector('.browser-fetch-status') as HTMLElement | null;
		const contentEl = card.querySelector('.browser-content-display') as HTMLElement | null;

		if (openTab) {
			try {
				const uri = URI.parse(finalUrl);
				await this._commandService.executeCommand('simpleBrowser.api.open', uri, {
					viewColumn: -2, // ViewColumn.Beside
					preserveFocus: false
				});
			} catch (e) {
				try {
					await this._commandService.executeCommand('simpleBrowser.show', finalUrl);
				} catch (err) {
					console.error('Failed to open simpleBrowser:', err);
				}
			}
		}

		if (statusEl) {
			statusEl.textContent = 'Fetching webpage content...';
			statusEl.style.color = '#38bdf8';
		}

		let creds: Array<{ key: string; value: string }> | undefined;
		const rawVal = this._lastParsedData ? ((this._lastParsedData as any)[fieldKey] || (this._lastParsedData as any).data?.[fieldKey]) : undefined;
		if (rawVal) {
			if (typeof rawVal === 'object' && Array.isArray(rawVal.credentials)) {
				creds = rawVal.credentials;
			} else if (typeof rawVal === 'string') {
				try {
					const parsed = JSON.parse(rawVal);
					if (Array.isArray(parsed.credentials)) {
						creds = parsed.credentials;
					}
				} catch {}
			}
		}
		if (!creds && this._lastCustomModule?.fields) {
			const matchingF = this._lastCustomModule.fields.find((f: any) => f.label?.toLowerCase() === fieldKey.toLowerCase() || f.id?.toLowerCase() === fieldKey.toLowerCase() || f.key?.toLowerCase() === fieldKey.toLowerCase());
			if (matchingF?.credentials) {
				creds = matchingF.credentials;
			}
		}

		try {
			const result = await this._fetchUrlContent(finalUrl, creds);
			if (result.isAuthRequired) {
				throw new Error(result.rawError || 'Authentication Required');
			}
			if (result.content.startsWith('Failed to fetch URL')) {
				throw new Error(result.rawError || result.content);
			}
			if (contentEl) {
				contentEl.textContent = result.content;
			}
			const charCount = result.content.length;
			const timestamp = new Date().toLocaleTimeString();
			if (statusEl) {
				statusEl.textContent = `Fetched at ${timestamp} (${charCount} chars)`;
				statusEl.style.color = '#34d399';
			}
			await this._saveBrowserPrimitiveData(fieldKey, url, result.content, `${new Date().toLocaleDateString()} ${timestamp}`);
			// Suppress notificationService.info toast to prevent webview "Paused due to Notification" overlay
		} catch (err: any) {
			const rawErr = err?.message || String(err);
			const isAuthOrCors = /auth|401|403|login|session|verification/i.test(rawErr);
			const timestamp = new Date().toLocaleString();
			if (isAuthOrCors) {
				if (statusEl) {
					statusEl.textContent = 'Auth Required / Protected Page (Raw Error Logged)';
					statusEl.style.color = '#fbbf24';
				}
				const formattedNotice = `[AUTH REQUIRED / PROTECTED PAGE]
Target URL: ${url}
Timestamp: ${timestamp}
Status: Authentication Required / Access Restricted

--- [RAW SERVER & NETWORK RESPONSE] ---
${rawErr}

--- [AUTOMATION & TROUBLESHOOTING GUIDANCE] ---
1. Why this happened:
   The destination endpoint (${url}) requires an active authenticated session or blocks unauthenticated automated background crawlers (CORS / Anti-Scraping / 307 Redirect to Login).

2. Interactive Login:
   Click the "Open in Tab" or "+ New Tab" button directly above this card to open a browser tab beside and log in.

3. Automated AI Agent usage:
   In the "Credentials / Authentication" section above, configure your login credentials (username/email & password or session token). AI agents will use these credentials when automating tasks on this ticket.`;

				if (contentEl) {
					contentEl.textContent = formattedNotice;
				}
				await this._saveBrowserPrimitiveData(fieldKey, url, formattedNotice, `${new Date().toLocaleDateString()} ${timestamp}`);
				// Avoid notificationService.warn toast to prevent webview "Paused due to Notification" overlay
			} else {
				if (statusEl) {
					statusEl.textContent = `Fetch failed: ${rawErr.slice(0, 30)}`;
					statusEl.style.color = '#ef4444';
				}
				const formattedErr = `[HTTP / NETWORK FETCH ERROR]
Target URL: ${url}
Timestamp: ${timestamp}

--- [RAW SERVER & NETWORK ERROR] ---
${rawErr}

--- [TROUBLESHOOTING GUIDANCE] ---
1. Verify that the URL is correct, online, and publicly reachable.
2. If the site blocks cross-origin requests, click "Open in Tab" or "+ New Tab" to inspect or view the site directly.`;

				if (contentEl) {
					contentEl.textContent = formattedErr;
				}
				await this._saveBrowserPrimitiveData(fieldKey, url, formattedErr, `${new Date().toLocaleDateString()} ${timestamp}`);
				// Avoid notificationService.error toast to prevent webview "Paused due to Notification" overlay
			}
		}
	}

	private async _saveBrowserPrimitiveData(fieldKey: string, url: string, content: string, lastFetched: string): Promise<void> {
		const rawVal = this._lastParsedData?.customMetadata?.[fieldKey];
		let creds: any[] = [];
		if (rawVal) {
			try {
				const parsed = JSON.parse(rawVal);
				if (Array.isArray(parsed.credentials)) {
					creds = parsed.credentials;
				}
			} catch {}
		}
		if (creds.length === 0 && this._lastCustomModule?.fields) {
			const matchingF = this._lastCustomModule.fields.find((f: any) => f.label?.toLowerCase() === fieldKey.toLowerCase() || f.id?.toLowerCase() === fieldKey.toLowerCase());
			if (matchingF?.credentials) {
				creds = matchingF.credentials;
			}
		}
		const bData = {
			url,
			credentials: creds,
			content,
			lastFetched
		};
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(bData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _saveTicketParameterValue(fieldKey: string, paramName: string, newValue: string): Promise<void> {
		const rawVal = this._lastParsedData?.customMetadata?.[fieldKey];
		let paramValues: { [name: string]: string } = {};
		if (rawVal) {
			try {
				const parsed = JSON.parse(rawVal);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					paramValues = parsed;
				}
			} catch {}
		}
		paramValues[paramName] = newValue;
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(paramValues)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private _interpolateParameters(text: string): string {
		if (!text) return text;

		const paramMap = new Map<string, string>();

		// 0. Base Ticket Attributes
		if (this._lastParsedData) {
			if (this._lastParsedData.title) paramMap.set('title', this._lastParsedData.title);
			if (this._lastParsedData.description) paramMap.set('description', this._lastParsedData.description);
			if (this._lastParsedData.ticketId) paramMap.set('ticketId', this._lastParsedData.ticketId);
		}

		// 1. Schema default parameters
		if (this._lastCustomModule?.fields) {
			for (const f of this._lastCustomModule.fields) {
				if (f.type === 'parameters' && f.parameters) {
					for (const p of f.parameters) {
						if (p.name) {
							paramMap.set(p.name, p.defaultValue || '');
						}
					}
				}
			}
		}

		// 2. Saved customMetadata parameter values
		if (this._lastParsedData?.customMetadata) {
			for (const [, v] of Object.entries(this._lastParsedData.customMetadata)) {
				if (typeof v === 'string') {
					try {
						const parsed = JSON.parse(v);
						if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
							for (const [pName, pVal] of Object.entries(parsed)) {
								paramMap.set(pName, String(pVal ?? ''));
							}
						}
					} catch {}
				}
			}
		}

		// 3. Live DOM inputs if currently typed
		if (this._container) {
			const inputs = this._container.querySelectorAll('.ticket-parameter-input') as NodeListOf<HTMLInputElement | HTMLSelectElement>;
			inputs.forEach(input => {
				const pName = input.getAttribute('data-param-name');
				if (pName) {
					paramMap.set(pName, input.value);
				}
			});
		}

		// 4. Resolve primitives by Field Label & Field ID
		if (this._lastCustomModule?.fields) {
			for (const f of this._lastCustomModule.fields) {
				const label = f.label || f.id;
				const id = f.id;
				const fKey = f.label || f.id;

				let primitiveVal = '';
				const subProps: Record<string, string> = {};

				// Look up saved metadata
				const rawSaved = this._lastParsedData?.customMetadata?.[fKey] ?? this._lastParsedData?.customMetadata?.[f.id];
				let savedObj: any = null;
				if (typeof rawSaved === 'string') {
					try { savedObj = JSON.parse(rawSaved); } catch { savedObj = rawSaved; }
				} else if (rawSaved) {
					savedObj = rawSaved;
				}

				if (f.type === 'browser') {
					let url = '';
					let content = '';
					if (this._container) {
						const card = this._container.querySelector(`.custom-primitive-card[data-field-key="${fKey}"]`) ||
									this._container.querySelector(`.custom-primitive-card[data-field-id="${f.id}"]`);
						if (card) {
							const urlInput = card.querySelector('.browser-url-input') as HTMLInputElement | null;
							const contentEl = card.querySelector('.browser-content-display') as HTMLElement | null;
							if (urlInput) url = urlInput.value.trim();
							if (contentEl) content = contentEl.textContent || '';
						}
					}
					if (!url && savedObj && typeof savedObj === 'object') {
						url = savedObj.url || '';
					}
					if (!content && savedObj && typeof savedObj === 'object') {
						content = savedObj.content || '';
					}
					if (!url) url = f.defaultUrl || '';

					if (content.includes('No webpage content extracted yet.')) {
						content = '';
					}

					subProps['url'] = url;
					subProps['content'] = content;
					primitiveVal = `--- [Primitive: ${label} (Browser)] ---\nTarget URL: ${url}\nExtracted Web Content:\n${content}\n--- [End of ${label}] ---`;
				} else if (f.type === 'prompt') {
					let prompt = '';
					let output = '';
					if (this._container) {
						const card = this._container.querySelector(`.custom-primitive-card[data-field-key="${fKey}"]`) ||
									this._container.querySelector(`.custom-primitive-card[data-field-id="${f.id}"]`);
						if (card) {
							const ta = card.querySelector('.prompt-instruction-textarea') as HTMLTextAreaElement | null;
							const out = card.querySelector('.prompt-output-display') as HTMLElement | null;
							if (ta) prompt = ta.value;
							if (out) output = out.textContent || '';
						}
					}
					if (!prompt && savedObj && typeof savedObj === 'object') {
						prompt = savedObj.prompt || '';
					}
					if (!output && savedObj && typeof savedObj === 'object') {
						output = savedObj.output || '';
					}
					if (!prompt) prompt = f.defaultContent || '';

					if (output.includes('No execution output yet.')) {
						output = '';
					}

					subProps['prompt'] = prompt;
					subProps['output'] = output;
					primitiveVal = output || prompt;
				} else if (f.type === 'output' || f.type === 'result') {
					let resText = '';
					if (this._container) {
						const card = this._container.querySelector(`.custom-primitive-card[data-field-key="${fKey}"]`) ||
									this._container.querySelector(`.custom-primitive-card[data-field-id="${f.id}"]`);
						if (card) {
							const contentEl = card.querySelector('.result-raw-content') as HTMLTextAreaElement | null;
							if (contentEl) { resText = contentEl.value || ''; }
							const specItems = card.querySelectorAll('.output-spec-item');
							specItems.forEach(it => {
								const sKey = it.getAttribute('data-spec-key') || '';
								const ta = it.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
								if (sKey && ta?.value) {
									subProps[sKey] = ta.value;
								}
							});
						}
					}
					if (!resText && savedObj) {
						if (typeof savedObj === 'object' && savedObj !== null) {
							resText = savedObj.result || savedObj.output || JSON.stringify(savedObj, null, 2);
							for (const [sK, sV] of Object.entries(savedObj)) {
								if (typeof sV === 'object' && sV !== null && (sV as Record<string, unknown>).text !== undefined) {
									subProps[sK] = String((sV as Record<string, unknown>).text);
								} else if (typeof sV === 'string') {
									subProps[sK] = sV;
								}
							}
						} else {
							resText = String(savedObj);
						}
					}
					primitiveVal = resText;
					subProps['result'] = resText;
					subProps['output'] = resText;
				} else if (f.type === 'parameters') {
					const lines: string[] = [];
					if (f.parameters) {
						for (const p of f.parameters) {
							const val = paramMap.get(p.name) || p.defaultValue || '';
							lines.push(`${p.name}: ${val}`);
							subProps[p.name] = val;
						}
					}
					primitiveVal = lines.join('\n');
				} else {
					if (savedObj) {
						primitiveVal = typeof savedObj === 'object' ? JSON.stringify(savedObj, null, 2) : String(savedObj);
					} else {
						primitiveVal = f.defaultContent || '';
					}
				}

				const currentTicketId = this._lastParsedData?.ticketId || '';
				if (label) {
					paramMap.set(label, primitiveVal);
					for (const [subKey, subVal] of Object.entries(subProps)) {
						paramMap.set(`${label}.${subKey}`, subVal);
					}
					if (currentTicketId) {
						paramMap.set(`${currentTicketId}.${label}`, primitiveVal);
						for (const [subKey, subVal] of Object.entries(subProps)) {
							paramMap.set(`${currentTicketId}.${label}.${subKey}`, subVal);
						}
					}
					paramMap.set(`output.${label}`, primitiveVal);
					paramMap.set(`result.${label}`, primitiveVal);
				}
				if (id && id !== label) {
					paramMap.set(id, primitiveVal);
					for (const [subKey, subVal] of Object.entries(subProps)) {
						paramMap.set(`${id}.${subKey}`, subVal);
					}
					if (currentTicketId) {
						paramMap.set(`${currentTicketId}.${id}`, primitiveVal);
						for (const [subKey, subVal] of Object.entries(subProps)) {
							paramMap.set(`${currentTicketId}.${id}.${subKey}`, subVal);
						}
					}
					paramMap.set(`output.${id}`, primitiveVal);
					paramMap.set(`result.${id}`, primitiveVal);
				}
			}
		}

		// Interpolate {{param}} and {param}
		const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		let result = text;
		for (const [pName, pVal] of paramMap.entries()) {
			if (!pName) { continue; }
			const escapedName = escapeRegExp(pName);
			const reDouble = new RegExp(`\\{\\{\\s*${escapedName}\\s*\\}\\}`, 'gi');
			const reSingle = new RegExp(`\\{\\s*${escapedName}\\s*\\}`, 'gi');
			result = result.replace(reDouble, pVal).replace(reSingle, pVal);
		}
		return result;
	}

	private async _savePromptPrimitiveData(fieldKey: string, promptData: any): Promise<void> {
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(promptData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _savePromptDataFromCard(card: HTMLElement, fieldKey: string, outputOverride?: string): Promise<any> {
		const textarea = card.querySelector('.prompt-instruction-textarea') as HTMLTextAreaElement | null;
		const modelSelect = card.querySelector('.prompt-model-select') as HTMLSelectElement | null;
		const agentSelect = card.querySelector('.prompt-agent-select') as HTMLSelectElement | null;
		const modelBtn = card.querySelector('.prompt-mode-model-btn') as HTMLElement | null;
		const isModel = modelBtn?.style.background.includes('rgba(236') || false;
		const outputDisplay = card.querySelector('.prompt-output-display') as HTMLElement | null;

		const targetMode = isModel ? 'model' : 'agent';
		const targetModel = modelSelect?.value.trim() || 'gemini-1.5-flash';
		const targetAgentId = agentSelect?.value.trim() || '';
		const targetAgentName = agentSelect?.selectedOptions[0]?.textContent?.split('(')[0]?.trim() || '';
		const prompt = textarea?.value || '';
		const output = outputOverride !== undefined ? outputOverride : (outputDisplay?.textContent || '');
		const lastExecuted = outputOverride !== undefined && outputOverride === '' ? '' : `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;

		const promptData = {
			prompt,
			targetMode,
			targetModel,
			targetAgentId,
			targetAgentName,
			output,
			lastExecuted
		};

		await this._savePromptPrimitiveData(fieldKey, promptData);
		return promptData;
	}

	private _togglePromptMode(card: HTMLElement, fieldKey: string, mode: 'model' | 'agent'): void {
		const isAgent = mode === 'agent';
		const modelBtn = card.querySelector('.prompt-mode-model-btn') as HTMLElement | null;
		const agentBtn = card.querySelector('.prompt-mode-agent-btn') as HTMLElement | null;
		const modelSelect = card.querySelector('.prompt-model-select') as HTMLElement | null;
		const agentSelect = card.querySelector('.prompt-agent-select') as HTMLElement | null;
		const runModelBtn = card.querySelector('.prompt-run-model-btn') as HTMLElement | null;
		const dispatchAgentBtn = card.querySelector('.prompt-dispatch-agent-btn') as HTMLElement | null;
		const targetBadge = card.querySelector('.prompt-target-badge') as HTMLElement | null;

		if (modelBtn && agentBtn) {
			if (isAgent) {
				agentBtn.style.border = '1px solid rgba(56,189,248,0.5)';
				agentBtn.style.background = 'rgba(56,189,248,0.2)';
				agentBtn.style.color = '#38bdf8';
				modelBtn.style.border = '1px solid rgba(255,255,255,0.1)';
				modelBtn.style.background = 'transparent';
				modelBtn.style.color = 'inherit';
			} else {
				modelBtn.style.border = '1px solid rgba(59,130,246,0.5)';
				modelBtn.style.background = 'rgba(59,130,246,0.18)';
				modelBtn.style.color = '#60a5fa';
				agentBtn.style.border = '1px solid rgba(255,255,255,0.1)';
				agentBtn.style.background = 'transparent';
				agentBtn.style.color = 'inherit';
			}
		}

		if (modelSelect && agentSelect) {
			modelSelect.style.display = isAgent ? 'none' : 'block';
			agentSelect.style.display = isAgent ? 'block' : 'none';
		}

		if (runModelBtn && dispatchAgentBtn) {
			runModelBtn.style.display = isAgent ? 'none' : 'inline-flex';
			dispatchAgentBtn.style.display = isAgent ? 'inline-flex' : 'none';
		}

		if (targetBadge) {
			if (isAgent) {
				const agName = (agentSelect as HTMLSelectElement)?.selectedOptions[0]?.textContent?.split('(')[0]?.trim() || 'Agent';
				targetBadge.textContent = `🤖 Agent: ${agName}`;
				targetBadge.style.background = 'rgba(56, 189, 248, 0.15)';
				targetBadge.style.color = '#38bdf8';
			} else {
				const mName = (modelSelect as HTMLSelectElement)?.value || 'gemini-1.5-flash';
				targetBadge.textContent = `⚡ Model: ${mName}`;
				targetBadge.style.background = 'rgba(59, 130, 246, 0.15)';
				targetBadge.style.color = '#60a5fa';
			}
		}

		this._savePromptDataFromCard(card, fieldKey).catch(() => {});
	}

	private async _executePromptWithModel(card: HTMLElement, fieldKey: string): Promise<void> {
		const textarea = card.querySelector('.prompt-instruction-textarea') as HTMLTextAreaElement | null;
		const rawPrompt = textarea?.value.trim() || '';
		if (!rawPrompt) {
			this._notificationService.warn('Please enter a prompt instruction before running.');
			textarea?.focus();
			return;
		}

		const modelSelect = card.querySelector('.prompt-model-select') as HTMLSelectElement | null;
		const modelId = modelSelect?.value.trim() || 'gemini-1.5-flash';

		const interpolatedPrompt = this._interpolateParameters(rawPrompt);

		const statusText = card.querySelector('.prompt-status-text') as HTMLElement | null;
		const outputDisplay = card.querySelector('.prompt-output-display') as HTMLElement | null;

		if (statusText) {
			statusText.textContent = `Running with ${modelId}... ⏳`;
			statusText.style.color = '#f472b6';
		}
		if (outputDisplay) {
			outputDisplay.textContent = `Processing prompt with ${modelId}...`;
		}

		try {
			const credService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentCredentialService); } catch { return undefined; }
			});

			if (!credService || !credService.executePrompt) {
				throw new Error('AI Credential service not available.');
			}

			const res = await credService.executePrompt(modelId, interpolatedPrompt);

			if (res.success && res.text) {
				if (outputDisplay) {
					outputDisplay.textContent = res.text;
				}
				if (statusText) {
					statusText.textContent = `Completed at ${new Date().toLocaleTimeString()} (${res.text.length} chars)`;
					statusText.style.color = '#34d399';
				}
				await this._savePromptDataFromCard(card, fieldKey, res.text);
				await this._autoUpdateOutputPrimitives(res.text, fieldKey);
			} else {
				throw new Error(res.error || 'Execution failed');
			}
		} catch (err: any) {
			const errMsg = err?.message || String(err);
			if (outputDisplay) {
				outputDisplay.textContent = `[Execution Error]\n${errMsg}`;
			}
			if (statusText) {
				statusText.textContent = `Failed: ${errMsg.slice(0, 30)}`;
				statusText.style.color = '#ef4444';
			}
			await this._savePromptDataFromCard(card, fieldKey, `[Error: ${errMsg}]`);
		}
	}

	private async _savePythonPrimitiveData(fieldKey: string, pythonData: any): Promise<void> {
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: typeof pythonData === 'string' ? pythonData : JSON.stringify(pythonData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _savePythonDataFromCard(card: HTMLElement, fieldKey: string, outputOverride?: string, exitCodeOverride?: number, durationMsOverride?: number, resultOverride?: any): Promise<any> {
		const interpInput = card.querySelector('.python-interpreter-input') as HTMLInputElement | null;
		const codeTextarea = card.querySelector('.python-code-textarea') as HTMLTextAreaElement | null;
		const outputDisplay = card.querySelector('.python-output-display') as HTMLElement | null;

		const pythonPath = interpInput?.value.trim() || '';
		const code = codeTextarea?.value || '';
		let output = outputOverride !== undefined ? outputOverride : (outputDisplay?.textContent || '');
		if (output.startsWith('No execution output yet') || output.startsWith('No execution logs yet')) output = '';

		let result = resultOverride;
		if (result === undefined && (card as any)._lastPythonResult !== undefined) {
			result = (card as any)._lastPythonResult;
		}

		const pythonData: any = {
			pythonPath,
			code,
			output,
			result,
			exitCode: exitCodeOverride,
			durationMs: durationMsOverride,
			lastExecuted: outputOverride !== undefined && outputOverride === '' ? '' : new Date().toISOString()
		};

		await this._savePythonPrimitiveData(fieldKey, pythonData);
		return pythonData;
	}

	private async _executePythonScriptInEditor(card: HTMLElement, fieldKey: string): Promise<void> {
		const interpInput = card.querySelector('.python-interpreter-input') as HTMLInputElement | null;
		const codeTextarea = card.querySelector('.python-code-textarea') as HTMLTextAreaElement | null;
		const statusText = card.querySelector('.python-status-text') as HTMLElement | null;
		const outputDisplay = card.querySelector('.python-output-display') as HTMLElement | null;
		const runBtn = card.querySelector('.python-run-script-btn') as HTMLElement | null;

		const pythonPath = interpInput?.value.trim() || '';
		const rawCode = codeTextarea?.value || '';

		if (!rawCode.trim()) {
			this._notificationService.warn('Please enter Python code before running.');
			codeTextarea?.focus();
			return;
		}

		if (runBtn) {
			runBtn.setAttribute('disabled', 'true');
			runBtn.style.opacity = '0.6';
		}
		if (statusText) {
			statusText.textContent = 'Running script... ⏳';
			statusText.style.color = '#facc15';
		}
		if (outputDisplay) {
			outputDisplay.textContent = 'Executing Python automation script...\n';
		}

		const interpolatedCode = this._interpolateParameters(rawCode);

		try {
			const runtimeService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
			});

			if (!runtimeService) {
				throw new Error('Ticket workflow runtime service not available.');
			}

			const workspaceUri = this._entityUri ? this._workspacesExplorerService.findRootWorkspace(this._entityUri) || this._entityUri : this._entityUri;
			if (!workspaceUri || !this._entityUri) {
				throw new Error('No active ticket or workspace selected.');
			}

			const ticketContext: { [key: string]: any } = {
				title: this._lastParsedData?.title || '',
				description: this._lastParsedData?.description || '',
				ticketId: this._lastParsedData?.ticketId || '',
				status: this._lastParsedData?.status || '',
				...((this._lastParsedData as any)?.data || {}),
				...(this._lastParsedData?.customMetadata || {})
			};

			const res = await runtimeService.executePythonScript(
				workspaceUri,
				this._entityUri,
				pythonPath,
				interpolatedCode,
				ticketContext
			);

			(card as any)._lastPythonResult = res.result;

			let resultBlock = card.querySelector('.python-result-block') as HTMLElement | null;
			if (res.result !== undefined) {
				const formattedResult = typeof res.result === 'object' ? JSON.stringify(res.result, null, 2) : String(res.result);
				if (!resultBlock) {
					const outSection = card.querySelector('.python-output-section') as HTMLElement | null;
					if (outSection) {
						resultBlock = document.createElement('div');
						resultBlock.className = 'python-result-block';
						resultBlock.style.cssText = 'background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 5px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;';
						resultBlock.innerHTML = `
							<div style="display: flex; justify-content: space-between; align-items: center;">
								<span style="font-size: 11px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">Return Value (Output):</span>
								<span style="font-size: 9.5px; opacity: 0.65; color: #38bdf8;">Consumed by Output Manifest & Downstream Primitives</span>
							</div>
							<pre class="python-result-display" style="margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: #e0f2fe; max-height: 180px; overflow-y: auto;"></pre>
						`;
						outSection.insertBefore(resultBlock, outSection.firstChild);
					}
				}
				const pre = resultBlock?.querySelector('.python-result-display') as HTMLElement | null;
				if (pre) pre.textContent = formattedResult;
			} else if (resultBlock) {
				resultBlock.remove();
			}

			if (outputDisplay) {
				outputDisplay.textContent = res.output || (res.success ? '(Script completed with 0 exit code and no stdout/stderr output)' : `Error: ${res.error || 'Execution failed'}`);
			}

			if (statusText) {
				statusText.textContent = res.success
					? `Completed in ${res.durationMs}ms (exit 0)`
					: `Failed with exit code ${res.exitCode} (${res.durationMs}ms)`;
				statusText.style.color = res.success ? '#4ade80' : '#f87171';
			}

			// Update customMetadata
			await this._savePythonDataFromCard(card, fieldKey, res.output, res.exitCode, res.durationMs, res.result);

			// Also update interpreter input if auto-resolved
			if (interpInput && !pythonPath && res.pythonPath) {
				interpInput.value = res.pythonPath;
			}
		} catch (err: any) {
			if (outputDisplay) {
				outputDisplay.textContent = `Execution Error: ${err.message || String(err)}`;
			}
			if (statusText) {
				statusText.textContent = 'Execution failed';
				statusText.style.color = '#f87171';
			}
			this._notificationService.error(`Python execution error: ${err.message || String(err)}`);
		} finally {
			if (runBtn) {
				runBtn.removeAttribute('disabled');
				runBtn.style.opacity = '1';
			}
		}
	}

	private async _createVenvInEditor(card: HTMLElement, fieldKey: string): Promise<void> {
		const interpInput = card.querySelector('.python-interpreter-input') as HTMLInputElement | null;
		const statusEl = card.querySelector('.python-test-status') as HTMLElement | null;
		const createBtn = card.querySelector('.python-create-venv-btn') as HTMLElement | null;
		const envBadge = card.querySelector('.python-env-badge') as HTMLElement | null;

		const currentPath = interpInput?.value.trim() || '.venv';
		const venvName = currentPath.endsWith('/bin/python') || currentPath.endsWith('\\Scripts\\python.exe')
			? currentPath.replace(/\/bin\/python$/, '').replace(/\\Scripts\\python\.exe$/, '')
			: (currentPath || '.venv');

		if (createBtn) {
			createBtn.setAttribute('disabled', 'true');
			createBtn.textContent = 'Creating...';
		}
		if (statusEl) {
			statusEl.textContent = `Creating virtualenv at '${venvName}'... ⏳`;
			statusEl.style.color = '#facc15';
		}

		try {
			const runtimeService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
			});
			if (!runtimeService) {
				throw new Error('Ticket workflow runtime service not available.');
			}
			const workspaceUri = this._entityUri ? this._workspacesExplorerService.findRootWorkspace(this._entityUri) || this._entityUri : this._entityUri;
			if (!workspaceUri) {
				throw new Error('No workspace context.');
			}

			const res = await runtimeService.createVirtualEnv(workspaceUri, venvName);
			if (res.success) {
				if (interpInput) {
					interpInput.value = res.pythonPath;
				}
				if (envBadge) {
					envBadge.textContent = res.pythonPath;
				}
				if (statusEl) {
					statusEl.textContent = `Venv created: ${res.pythonPath} ✓`;
					statusEl.style.color = '#4ade80';
				}
				this._notificationService.info(`Virtual environment successfully created at ${res.pythonPath}`);
				await this._savePythonDataFromCard(card, fieldKey);
			} else {
				if (statusEl) {
					statusEl.textContent = `Venv creation failed ✗`;
					statusEl.style.color = '#f87171';
				}
				this._notificationService.error(`Failed to create venv: ${res.error || res.output}`);
			}
		} catch (err: any) {
			if (statusEl) {
				statusEl.textContent = `Error: ${err.message}`;
				statusEl.style.color = '#f87171';
			}
			this._notificationService.error(`Failed to create venv: ${err.message || String(err)}`);
		} finally {
			if (createBtn) {
				createBtn.removeAttribute('disabled');
				createBtn.textContent = 'Create venv';
			}
		}
	}

	private async _browsePythonInterpreterInEditor(card: HTMLElement, fieldKey: string): Promise<void> {
		const interpInput = card.querySelector('.python-interpreter-input') as HTMLInputElement | null;
		try {
			const uris = await this._fileDialogService.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: true,
				canSelectMany: false,
				title: 'Select Python Interpreter or Virtualenv Folder'
			});
			if (uris && uris.length > 0) {
				const pickedUri = uris[0];
				const wsUri = this._entityUri ? this._workspacesExplorerService.findRootWorkspace(this._entityUri) || this._entityUri : this._entityUri;
				let finalPath = pickedUri.fsPath;
				if (wsUri && finalPath.startsWith(wsUri.fsPath)) {
					finalPath = finalPath.substring(wsUri.fsPath.length).replace(/^[/\\]+/, '');
				}
				if (interpInput) {
					interpInput.value = finalPath;
				}
				await this._savePythonDataFromCard(card, fieldKey);
				await this._testPythonInterpreterInEditor(card, fieldKey);
			}
		} catch (err: any) {
			this._notificationService.error(`Failed to pick folder: ${err.message || err}`);
		}
	}

	private async _testPythonInterpreterInEditor(card: HTMLElement, fieldKey: string): Promise<void> {
		const interpInput = card.querySelector('.python-interpreter-input') as HTMLInputElement | null;
		const statusEl = card.querySelector('.python-test-status') as HTMLElement | null;
		const testBtn = card.querySelector('.python-test-interpreter-btn') as HTMLElement | null;
		const pythonPath = interpInput?.value.trim() || '';

		if (testBtn) {
			testBtn.setAttribute('disabled', 'true');
			testBtn.textContent = 'Testing...';
		}
		if (statusEl) {
			statusEl.textContent = 'Testing interpreter... ⏳';
			statusEl.style.color = '#facc15';
		}

		try {
			const runtimeService = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(ITicketWorkflowRuntimeService); } catch { return undefined; }
			});
			if (!runtimeService) {
				throw new Error('Ticket workflow runtime service not available.');
			}
			const workspaceUri = this._entityUri ? this._workspacesExplorerService.findRootWorkspace(this._entityUri) || this._entityUri : this._entityUri;
			if (!workspaceUri) {
				throw new Error('No workspace context.');
			}

			const res = await runtimeService.testPythonInterpreter(workspaceUri, pythonPath);
			if (res.success) {
				if (statusEl) {
					statusEl.textContent = `${res.version} ✓`;
					statusEl.style.color = '#4ade80';
				}
				this._notificationService.info(`Python interpreter verified: ${res.version}`);
			} else {
				if (statusEl) {
					statusEl.textContent = 'Interpreter not found / failed ✗';
					statusEl.style.color = '#f87171';
				}
				this._notificationService.warn(`Python interpreter test failed: ${res.error}`);
			}
		} catch (err: any) {
			if (statusEl) {
				statusEl.textContent = `Error: ${err.message}`;
				statusEl.style.color = '#f87171';
			}
		} finally {
			if (testBtn) {
				testBtn.removeAttribute('disabled');
				testBtn.textContent = 'Test';
			}
		}
	}

	private async _autoUpdateOutputPrimitives(output: string, sourceFieldKey?: string): Promise<void> {
		if (!this._container) { return; }
		const outputCards = this._container.querySelectorAll('.output-primitive-card, .result-primitive-card') as NodeListOf<HTMLElement>;
		if (outputCards.length === 0) { return; }

		for (const card of Array.from(outputCards)) {
			const fieldKey = card.getAttribute('data-field-key') || '';
			const subItems = card.querySelectorAll('.output-spec-item') as NodeListOf<HTMLElement>;
			if (subItems.length > 0) {
				let targetItem: HTMLElement | null = null;
				if (sourceFieldKey) {
					for (const item of Array.from(subItems)) {
						const specKey = item.getAttribute('data-spec-key') || '';
						if (specKey.toLowerCase() === sourceFieldKey.toLowerCase()) {
							targetItem = item;
							break;
						}
					}
				}
				if (!targetItem) {
					targetItem = subItems[0];
				}
				if (targetItem) {
					const specKey = targetItem.getAttribute('data-spec-key') || '';
					await this._setOutputItemContent(card, fieldKey, specKey, output);
				}
			} else {
				await this._setResultCardContent(card, fieldKey, output);
			}
		}
	}

	private async _autoUpdateResultPrimitives(output: string): Promise<void> {
		await this._autoUpdateOutputPrimitives(output);
	}

	private async _setOutputItemContent(card: HTMLElement, fieldKey: string, specKey: string, content: string): Promise<void> {
		const itemContainer = card.querySelector(`.output-spec-item[data-spec-key="${specKey}"]`) as HTMLElement | null;
		if (!itemContainer) { return; }

		const rawTa = itemContainer.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
		if (rawTa) { rawTa.value = content; }

		const formatSelector = itemContainer.querySelector('.output-item-format-selector') as HTMLSelectElement | null;
		const format = formatSelector?.value || 'table';

		const viewport = itemContainer.querySelector('.output-item-viewport') as HTMLElement | null;
		if (viewport) {
			if (format === 'table') {
				viewport.innerHTML = this._renderResultTableHtml(content);
			} else if (format === 'markdown') {
				viewport.innerHTML = this._markdownToHtml(content);
			} else if (format === 'json') {
				viewport.innerHTML = this._renderResultJsonHtml(content);
			} else {
				viewport.innerHTML = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(content)}</pre>`;
			}
		}

		let currentData: Record<string, unknown> = {};
		const rawVal = this._lastParsedData?.customMetadata?.[fieldKey];
		if (typeof rawVal === 'string') {
			try { currentData = JSON.parse(rawVal); } catch {}
		} else if (typeof rawVal === 'object' && rawVal !== null) {
			currentData = rawVal as Record<string, unknown>;
		}

		const existingItem = (currentData[specKey] && typeof currentData[specKey] === 'object')
			? (currentData[specKey] as Record<string, unknown>)
			: {};

		currentData[specKey] = {
			...existingItem,
			text: content,
			format,
			lastUpdated: new Date().toLocaleTimeString()
		};

		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(currentData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _updateOutputItemFormat(card: HTMLElement, fieldKey: string, specKey: string, format: string): Promise<void> {
		const itemContainer = card.querySelector(`.output-spec-item[data-spec-key="${specKey}"]`) as HTMLElement | null;
		if (!itemContainer) { return; }

		const rawTa = itemContainer.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
		const text = rawTa?.value || '';

		const viewport = itemContainer.querySelector('.output-item-viewport') as HTMLElement | null;
		if (viewport) {
			if (format === 'table') {
				viewport.innerHTML = this._renderResultTableHtml(text);
			} else if (format === 'markdown') {
				viewport.innerHTML = this._markdownToHtml(text);
			} else if (format === 'json') {
				viewport.innerHTML = this._renderResultJsonHtml(text);
			} else {
				viewport.innerHTML = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(text)}</pre>`;
			}
		}

		let currentData: Record<string, unknown> = {};
		const rawVal = this._lastParsedData?.customMetadata?.[fieldKey];
		if (typeof rawVal === 'string') {
			try { currentData = JSON.parse(rawVal); } catch {}
		} else if (typeof rawVal === 'object' && rawVal !== null) {
			currentData = rawVal as Record<string, unknown>;
		}

		const existingItem = (currentData[specKey] && typeof currentData[specKey] === 'object')
			? (currentData[specKey] as Record<string, unknown>)
			: {};

		currentData[specKey] = {
			...existingItem,
			text,
			format,
			lastUpdated: new Date().toLocaleTimeString()
		};

		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(currentData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _syncAllOutputItems(card: HTMLElement, fieldKey: string): Promise<void> {
		const items = card.querySelectorAll('.output-spec-item') as NodeListOf<HTMLElement>;
		if (items.length === 0) {
			const promptCard = this._container?.querySelector('.prompt-primitive-card');
			const promptOut = promptCard?.querySelector('.prompt-output-display');
			const text = promptOut?.textContent || '';
			if (text && !text.includes('No execution output yet.')) {
				await this._setResultCardContent(card, fieldKey, text);
				this._notificationService.info(`Output synced from AI Prompt into '${fieldKey}'.`);
			} else {
				this._notificationService.warn('No AI Prompt output available to sync.');
			}
			return;
		}

		let currentData: Record<string, unknown> = {};
		const rawVal = this._lastParsedData?.customMetadata?.[fieldKey];
		if (typeof rawVal === 'string') {
			try { currentData = JSON.parse(rawVal); } catch {}
		} else if (typeof rawVal === 'object' && rawVal !== null) {
			currentData = rawVal as Record<string, unknown>;
		}

		for (const item of Array.from(items)) {
			const specKey = item.getAttribute('data-spec-key') || '';
			if (!specKey) { continue; }

			let resolvedText = '';

			if (this._container) {
				const matchedCard = this._container.querySelector(`.section-card[data-field-key="${specKey}"], [data-field-key="${specKey}"]`);
				if (matchedCard) {
					const browserContent = matchedCard.querySelector('.browser-content-display') as HTMLElement | null;
					const promptContent = matchedCard.querySelector('.prompt-output-display') as HTMLElement | null;
					if (browserContent && !browserContent.textContent?.startsWith('No webpage content')) {
						resolvedText = browserContent.textContent || '';
					} else if (promptContent && !promptContent.textContent?.includes('No execution output yet.')) {
						resolvedText = promptContent.textContent || '';
					}
				}
			}

			if (!resolvedText && this._lastParsedData?.customMetadata) {
				const mVal = this._lastParsedData.customMetadata[specKey];
				const matchingField = this._lastCustomModule?.fields?.find((f: any) =>
					(f.label && f.label.toLowerCase() === specKey.toLowerCase()) ||
					(f.id && f.id.toLowerCase() === specKey.toLowerCase())
				);
				const isBrowserField = matchingField?.type === 'browser' || specKey.toLowerCase().includes('browser');
				const isPromptField = matchingField?.type === 'prompt' || specKey.toLowerCase().includes('prompt');

				if (typeof mVal === 'string') {
					try {
						const parsed = JSON.parse(mVal);
						if (typeof parsed === 'object' && parsed !== null) {
							const pRec = parsed as Record<string, unknown>;
							if (isBrowserField) {
								resolvedText = String(pRec.content ?? matchingField?.defaultContent ?? '');
							} else if (isPromptField) {
								resolvedText = String(pRec.output ?? '');
							} else {
								resolvedText = String(pRec.output ?? pRec.content ?? pRec.result ?? '');
							}
						} else if (isBrowserField) {
							resolvedText = matchingField?.defaultContent || '';
						} else if (isPromptField) {
							resolvedText = '';
						}
					} catch {
						if (isBrowserField) {
							resolvedText = matchingField?.defaultContent || '';
						}
					}
				} else if (typeof mVal === 'object' && mVal !== null) {
					const mRec = mVal as Record<string, unknown>;
					if (isBrowserField) {
						resolvedText = String(mRec.content ?? matchingField?.defaultContent ?? '');
					} else if (isPromptField) {
						resolvedText = String(mRec.output ?? '');
					} else {
						resolvedText = String(mRec.output ?? mRec.content ?? mRec.result ?? '');
					}
				}
			}

			if (resolvedText) {
				const rawTa = item.querySelector('.output-item-raw-content') as HTMLTextAreaElement | null;
				if (rawTa) { rawTa.value = resolvedText; }

				const formatSelector = item.querySelector('.output-item-format-selector') as HTMLSelectElement | null;
				const format = formatSelector?.value || 'table';

				const viewport = item.querySelector('.output-item-viewport') as HTMLElement | null;
				if (viewport) {
					if (format === 'table') {
						viewport.innerHTML = this._renderResultTableHtml(resolvedText);
					} else if (format === 'markdown') {
						viewport.innerHTML = this._markdownToHtml(resolvedText);
					} else if (format === 'json') {
						viewport.innerHTML = this._renderResultJsonHtml(resolvedText);
					} else {
						viewport.innerHTML = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(resolvedText)}</pre>`;
					}
				}

				currentData[specKey] = {
					text: resolvedText,
					format,
					lastUpdated: new Date().toLocaleTimeString()
				};
			}
		}

		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(currentData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});

		this._notificationService.info(`Output items synchronized from live primitives.`);
	}

	private async _setResultCardContent(card: HTMLElement, fieldKey: string, output: string): Promise<void> {
		const formatSelector = card.querySelector('.result-format-selector') as HTMLSelectElement | null;
		const format = formatSelector?.value || 'table';
		const rawTa = card.querySelector('.result-raw-content') as HTMLTextAreaElement | null;
		if (rawTa) rawTa.value = output;

		const viewport = card.querySelector('.result-viewport-container') as HTMLElement | null;
		if (viewport) {
			if (format === 'table') {
				viewport.innerHTML = this._renderResultTableHtml(output);
			} else if (format === 'markdown') {
				viewport.innerHTML = this._markdownToHtml(output);
			} else if (format === 'json') {
				viewport.innerHTML = this._renderResultJsonHtml(output);
			} else {
				viewport.innerHTML = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(output)}</pre>`;
			}
		}

		const statusEl = card.querySelector('.result-status-text') as HTMLElement | null;
		const timeStr = `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;
		if (statusEl) {
			statusEl.textContent = `Updated: ${new Date().toLocaleTimeString()} (${output.length} chars)`;
			statusEl.style.color = '#34d399';
		}

		const resultData = {
			result: output,
			format,
			lastUpdated: timeStr
		};
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(resultData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private async _updateResultCardFormat(card: HTMLElement, fieldKey: string, format: string): Promise<void> {
		const rawTa = card.querySelector('.result-raw-content') as HTMLTextAreaElement | null;
		const text = rawTa?.value || '';

		const viewport = card.querySelector('.result-viewport-container') as HTMLElement | null;
		if (viewport) {
			if (format === 'table') {
				viewport.innerHTML = this._renderResultTableHtml(text);
			} else if (format === 'markdown') {
				viewport.innerHTML = this._markdownToHtml(text);
			} else if (format === 'json') {
				viewport.innerHTML = this._renderResultJsonHtml(text);
			} else {
				viewport.innerHTML = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(text)}</pre>`;
			}
		}

		const statusEl = card.querySelector('.result-status-text') as HTMLElement | null;
		const rawStatus = statusEl?.textContent || '';
		const resultData = {
			result: text,
			format,
			lastUpdated: rawStatus.includes(':') ? rawStatus.replace(/^(?:Updated|Auto-synced):\s*/, '') : ''
		};
		const updatedCustom = {
			...(this._lastParsedData?.customMetadata || {}),
			[fieldKey]: JSON.stringify(resultData)
		};
		await this._handleMessage({
			type: 'saveMetadata',
			metadata: {},
			customMetadata: updatedCustom
		});
	}

	private _renderResultTableHtml(text: string): string {
		if (!text || !text.trim()) {
			return '<span style="opacity: 0.4; font-style: italic;">No result content to display in table.</span>';
		}

		const trimmed = text.trim();

		// 1. Try parsing JSON array of objects
		let jsonObj: any = null;
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				jsonObj = JSON.parse(trimmed);
			} catch {
				const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (jsonMatch) {
					try { jsonObj = JSON.parse(jsonMatch[1]); } catch {}
				}
			}
		}

		if (jsonObj) {
			const rows = Array.isArray(jsonObj) ? jsonObj : (Array.isArray(jsonObj.data) ? jsonObj.data : (Array.isArray(jsonObj.items) ? jsonObj.items : (Array.isArray(jsonObj.results) ? jsonObj.results : null)));
			if (rows && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
				const headers = Array.from(new Set(rows.flatMap(r => typeof r === 'object' && r !== null ? Object.keys(r) : [])));
				let tableHtml = '<div style="overflow-x: auto; max-height: 380px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">';
				tableHtml += '<table class="result-data-table" style="width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;">';
				tableHtml += '<thead><tr style="background: rgba(255,255,255,0.08); border-bottom: 2px solid rgba(255,255,255,0.15); position: sticky; top: 0; z-index: 1;">';
				for (const h of headers) {
					tableHtml += `<th style="padding: 8px 12px; font-weight: 600; color: #a5b4fc; text-transform: capitalize; white-space: nowrap;">${this._escapeHtml(h)}</th>`;
				}
				tableHtml += '</tr></thead><tbody>';
				rows.forEach((r, idx) => {
					const bg = idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.12)';
					tableHtml += `<tr style="background: ${bg}; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s ease;">`;
					for (const h of headers) {
						const cellVal = r[h] !== undefined && r[h] !== null ? (typeof r[h] === 'object' ? JSON.stringify(r[h]) : String(r[h])) : '';
						const isLink = /^https?:\/\//i.test(cellVal.trim());
						const displayVal = isLink
							? `<a href="${this._escapeHtmlAttr(cellVal.trim())}" target="_blank" style="color: #38bdf8; text-decoration: underline;">${this._escapeHtml(cellVal.trim())}</a>`
							: this._escapeHtml(cellVal);
						tableHtml += `<td style="padding: 7px 12px; vertical-align: top; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.4;">${displayVal}</td>`;
					}
					tableHtml += '</tr>';
				});
				tableHtml += '</tbody></table></div>';
				return tableHtml;
			}
		}

		// 2. Try parsing Markdown table
		const lines = trimmed.split('\n');
		const tableLines = lines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
		if (tableLines.length >= 2) {
			const headerLine = tableLines[0];
			let dataLines = tableLines.slice(1);
			if (dataLines.length > 0 && /^\s*\|(?:\s*[-:]+[-| :]*)\|?\s*$/.test(dataLines[0])) {
				dataLines = dataLines.slice(1);
			}

			const splitCells = (line: string) => {
				const trimmedL = line.trim();
				const inner = trimmedL.startsWith('|') && trimmedL.endsWith('|') ? trimmedL.slice(1, -1) : trimmedL;
				return inner.split('|').map(c => c.trim());
			};

			const headers = splitCells(headerLine);
			let tableHtml = '<div style="overflow-x: auto; max-height: 380px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">';
			tableHtml += '<table class="result-data-table" style="width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;">';
			tableHtml += '<thead><tr style="background: rgba(255,255,255,0.08); border-bottom: 2px solid rgba(255,255,255,0.15); position: sticky; top: 0; z-index: 1;">';
			for (const h of headers) {
				tableHtml += `<th style="padding: 8px 12px; font-weight: 600; color: #a5b4fc; white-space: nowrap;">${this._escapeHtml(h)}</th>`;
			}
			tableHtml += '</tr></thead><tbody>';
			dataLines.forEach((line, idx) => {
				const cells = splitCells(line);
				const bg = idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.12)';
				tableHtml += `<tr style="background: ${bg}; border-bottom: 1px solid rgba(255,255,255,0.05);">`;
				for (let cIdx = 0; cIdx < headers.length; cIdx++) {
					const cellVal = cells[cIdx] || '';
					const isLink = /^https?:\/\//i.test(cellVal.trim());
					const displayVal = isLink
						? `<a href="${this._escapeHtmlAttr(cellVal.trim())}" target="_blank" style="color: #38bdf8; text-decoration: underline;">${this._escapeHtml(cellVal.trim())}</a>`
						: this._escapeHtml(cellVal);
					tableHtml += `<td style="padding: 7px 12px; vertical-align: top; line-height: 1.4;">${displayVal}</td>`;
				}
				tableHtml += '</tr>';
			});
			tableHtml += '</tbody></table></div>';
			return tableHtml;
		}

		// 3. Fallback: Key-Value pairs check
		const kvPairs: Array<{ key: string; val: string }> = [];
		for (const line of lines) {
			const m = line.match(/^([^:\n]{1,40}):\s*(.+)$/);
			if (m) {
				kvPairs.push({ key: m[1].trim(), val: m[2].trim() });
			}
		}
		if (kvPairs.length >= 2) {
			let tableHtml = '<div style="overflow-x: auto; max-height: 380px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">';
			tableHtml += '<table class="result-data-table" style="width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left;">';
			tableHtml += '<thead><tr style="background: rgba(255,255,255,0.08); border-bottom: 2px solid rgba(255,255,255,0.15);"><th style="padding: 8px 12px; font-weight: 600; color: #a5b4fc; width: 30%;">Property</th><th style="padding: 8px 12px; font-weight: 600; color: #a5b4fc;">Value</th></tr></thead><tbody>';
			kvPairs.forEach((kv, idx) => {
				const bg = idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.12)';
				tableHtml += `<tr style="background: ${bg}; border-bottom: 1px solid rgba(255,255,255,0.05);"><td style="padding: 7px 12px; font-weight: 500; opacity: 0.85;">${this._escapeHtml(kv.key)}</td><td style="padding: 7px 12px;">${this._escapeHtml(kv.val)}</td></tr>`;
			});
			tableHtml += '</tbody></table></div>';
			return tableHtml;
		}

		// 4. Default fallback: Render as pre-formatted text with suggestion note
		return `
			<div style="margin-bottom: 8px; font-size: 10.5px; color: #fbbf24; opacity: 0.85;">ℹ Output is plain text or unstructured. Switch to Markdown or Text view for optimal layout:</div>
			<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 5px;">${this._escapeHtml(trimmed)}</pre>
		`;
	}

	private _renderResultJsonHtml(text: string): string {
		if (!text || !text.trim()) {
			return '<span style="opacity: 0.4; font-style: italic;">No JSON content to display.</span>';
		}
		const trimmed = text.trim();
		let parsed: any = null;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
			if (m) {
				try { parsed = JSON.parse(m[1]); } catch {}
			}
		}

		if (parsed !== null) {
			const formatted = JSON.stringify(parsed, null, 2);
			return `<pre style="font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: #818cf8; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 0; border: 1px solid rgba(129, 140, 248, 0.2);">${this._escapeHtml(formatted)}</pre>`;
		}

		return `
			<div style="margin-bottom: 8px; font-size: 10.5px; color: #fbbf24; opacity: 0.85;">⚠ Content is not strictly valid JSON. Displaying raw format:</div>
			<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 6px; margin: 0;">${this._escapeHtml(trimmed)}</pre>
		`;
	}

	private _exportResultToCsv(rawText: string, fieldKey: string): void {
		if (!rawText || !rawText.trim()) {
			this._notificationService.warn('No result data available to export.');
			return;
		}

		let csv = '';
		const trimmed = rawText.trim();

		// Check JSON
		let jsonObj: any = null;
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				jsonObj = JSON.parse(trimmed);
			} catch {
				const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
				if (m) {
					try { jsonObj = JSON.parse(m[1]); } catch {}
				}
			}
		}

		if (jsonObj) {
			const rows = Array.isArray(jsonObj) ? jsonObj : (Array.isArray(jsonObj.data) ? jsonObj.data : (Array.isArray(jsonObj.items) ? jsonObj.items : (Array.isArray(jsonObj.results) ? jsonObj.results : null)));
			if (rows && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
				const headers = Array.from(new Set(rows.flatMap(r => typeof r === 'object' && r !== null ? Object.keys(r) : [])));
				const escapeCsv = (val: any) => {
					const str = val !== undefined && val !== null ? String(val) : '';
					if (str.includes(',') || str.includes('"') || str.includes('\n')) {
						return `"${str.replace(/"/g, '""')}"`;
					}
					return str;
				};
				csv += headers.map(escapeCsv).join(',') + '\n';
				rows.forEach(r => {
					csv += headers.map(h => escapeCsv(r[h])).join(',') + '\n';
				});
			}
		}

		if (!csv) {
			// Check Markdown table
			const lines = trimmed.split('\n');
			const tableLines = lines.filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
			if (tableLines.length >= 2) {
				const splitCells = (line: string) => {
					const trimmedL = line.trim();
					const inner = trimmedL.startsWith('|') && trimmedL.endsWith('|') ? trimmedL.slice(1, -1) : trimmedL;
					return inner.split('|').map(c => c.trim());
				};
				const escapeCsv = (val: string) => {
					if (val.includes(',') || val.includes('"') || val.includes('\n')) {
						return `"${val.replace(/"/g, '""')}"`;
					}
					return val;
				};
				const headerCells = splitCells(tableLines[0]);
				csv += headerCells.map(escapeCsv).join(',') + '\n';
				let dataLines = tableLines.slice(1);
				if (dataLines.length > 0 && /^\s*\|(?:\s*[-:]+[-| :]*)\|?\s*$/.test(dataLines[0])) {
					dataLines = dataLines.slice(1);
				}
				dataLines.forEach(l => {
					const cells = splitCells(l);
					csv += cells.map(escapeCsv).join(',') + '\n';
				});
			}
		}

		if (!csv) {
			csv = `Content\n"${trimmed.replace(/"/g, '""')}"`;
		}

		const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `result_${fieldKey.replace(/\s+/g, '_')}_${Date.now()}.csv`;
		a.click();
		URL.revokeObjectURL(url);
		this._notificationService.info(`CSV exported for '${fieldKey}'.`);
	}

	private async _dispatchPromptToAgent(card: HTMLElement, fieldKey: string): Promise<void> {
		const textarea = card.querySelector('.prompt-instruction-textarea') as HTMLTextAreaElement | null;
		const rawPrompt = textarea?.value.trim() || '';
		if (!rawPrompt) {
			this._notificationService.warn('Please enter a prompt instruction before dispatching.');
			textarea?.focus();
			return;
		}

		const agentSelect = card.querySelector('.prompt-agent-select') as HTMLSelectElement | null;
		const agentId = agentSelect?.value.trim();
		if (!agentId) {
			this._notificationService.warn('Please select a target AI Agent.');
			agentSelect?.focus();
			return;
		}

		const agentName = agentSelect.selectedOptions[0]?.textContent?.split('(')[0]?.trim() || 'AI Agent';
		const interpolatedPrompt = this._interpolateParameters(rawPrompt);
		const taskTitle = `Task (${fieldKey}): ${this._lastParsedData?.title || 'Ticket Task'}`;

		const statusText = card.querySelector('.prompt-status-text') as HTMLElement | null;
		const outputDisplay = card.querySelector('.prompt-output-display') as HTMLElement | null;

		if (statusText) {
			statusText.textContent = `Dispatching to ${agentName}... ⏳`;
			statusText.style.color = '#38bdf8';
		}

		try {
			await this._agentsManagerService.assignTaskToAgent(agentId, taskTitle, interpolatedPrompt);
			const timeStr = new Date().toLocaleTimeString();
			const dispatchOutput = `[Task Dispatched to AI Agent]
Agent Name: ${agentName}
Agent ID: ${agentId}
Dispatched At: ${timeStr}
Status: Agent set to 'busy'. Task appended to agent work_log.md.

--- [INSTRUCTION PAYLOAD] ---
${interpolatedPrompt}`;

			if (outputDisplay) {
				outputDisplay.textContent = dispatchOutput;
			}
			if (statusText) {
				statusText.textContent = `Dispatched to ${agentName} at ${timeStr}`;
				statusText.style.color = '#38bdf8';
			}

			await this._savePromptDataFromCard(card, fieldKey, dispatchOutput);
			this._notificationService.info(`Task successfully assigned to Agent '${agentName}'.`);
		} catch (err: any) {
			const errMsg = err?.message || String(err);
			if (outputDisplay) {
				outputDisplay.textContent = `[Dispatch Error]\n${errMsg}`;
			}
			if (statusText) {
				statusText.textContent = `Failed: ${errMsg.slice(0, 30)}`;
				statusText.style.color = '#ef4444';
			}
		}
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

		const statusCategory = this._workspaceStatuses.getCategory(status);

		if (statusCategory === 'In Progress') {
			statusColor = '#38bdf8';
			statusBg = 'rgba(56, 189, 248, 0.16)';
			statusBorder = 'rgba(56, 189, 248, 0.35)';
		} else if (statusCategory === 'Done') {
			statusColor = '#34d399';
			statusBg = 'rgba(52, 211, 153, 0.16)';
			statusBorder = 'rgba(52, 211, 153, 0.35)';
		} else if (statusCategory === 'Blocked') {
			statusColor = '#f87171';
			statusBg = 'rgba(248, 113, 113, 0.16)';
			statusBorder = 'rgba(248, 113, 113, 0.35)';
		} else if (statusCategory === 'Removed') {
			statusColor = '#94a3b8';
			statusBg = 'rgba(148, 163, 184, 0.16)';
			statusBorder = 'rgba(148, 163, 184, 0.35)';
		}

		if (customModule && Array.isArray(customModule.statuses)) {
			const customDef = customModule.statuses.find((s: any) =>
				(s.label && s.label.toLowerCase() === status.toLowerCase()) ||
				(s.id && s.id.toLowerCase() === status.toLowerCase())
			);
			if (customDef && customDef.color) {
				statusColor = customDef.color;
				statusBg = hexToRgba(customDef.color, 0.16);
				statusBorder = hexToRgba(customDef.color, 0.35);
			}
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
				if (header.toLowerCase() === 'overview' || header.toLowerCase() === 'metadata') {
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
		const internalLifecycleKeys = ['Ticket Statuses', 'Status Mapping', 'Removed Status', 'Git Remote URL', 'Git Branch', 'Title', 'title', 'Description', 'description'];
		const rawCustomMap = new Map<string, any>(Object.entries(data.customMetadata || {}));
		for (const k of internalLifecycleKeys) {
			rawCustomMap.delete(k);
		}

		interface IRenderField {
			key: string;
			label: string;
			type: string;
			val: any;
			options?: any[];
			buttons?: IActionButton[];
			unit?: string;
			precision?: number;
			defaultUrl?: string;
			credentials?: ICredentialPair[];
			gitRemoteUrl?: string;
			gitBranch?: string;
			parameters?: IParameterDefinition[];
			outputSpecs?: IOutputSpec[];
			defaultFormat?: string;
			defaultContent?: string;
		}

		const fieldsToRender: IRenderField[] = [];
		const handledKeys = new Set<string>();

		if (customModule && Array.isArray(customModule.fields)) {
			// 1. Follow canonical order defined in the module schema
			for (const f of customModule.fields) {
				const fLabel = f.label || f.id;
				const fKey = f.id || f.label;
				// Skip mandatory root fields (Title and Description) as they are already rendered in ticket header and main description card
				if (fKey.toLowerCase() === 'title' || fLabel.toLowerCase() === 'title' || fKey.toLowerCase() === 'description' || fLabel.toLowerCase() === 'description') {
					continue;
				}

				// If this field is a parameters primitive, mark all its child param names/labels as handled so they are not rendered as orphan cards
				if (f.type === 'parameters' && Array.isArray(f.parameters)) {
					for (const p of f.parameters) {
						if (p.name) handledKeys.add(p.name);
						if (p.id) handledKeys.add(p.id);
						if (p.label) handledKeys.add(p.label);
					}
				}

				let matchedKey = '';
				let val: any = '';
				for (const [k, v] of rawCustomMap.entries()) {
					if (k.toLowerCase() === fLabel.toLowerCase() ||
						k.toLowerCase() === fKey.toLowerCase() ||
						k.toLowerCase() === fKey.toLowerCase().replace(/_/g, ' ') ||
						k.toLowerCase().replace(/_/g, ' ') === fLabel.toLowerCase().replace(/_/g, ' ')) {
						matchedKey = k;
						val = v;
						break;
					}
				}
				if (matchedKey) {
					handledKeys.add(matchedKey);
				}

				// If f is parameters, construct/hydrate paramObj from rawCustomMap if individual parameters were stored
				if (f.type === 'parameters' && Array.isArray(f.parameters)) {
					let paramObj: Record<string, any> = {};
					if (val) {
						if (typeof val === 'string') {
							try { paramObj = JSON.parse(val); } catch { }
						} else if (typeof val === 'object' && val !== null) {
							paramObj = { ...val };
						}
					}
					for (const p of f.parameters) {
						const pKey = p.name || p.id;
						if (paramObj[pKey] === undefined) {
							const found = rawCustomMap.get(pKey) ?? (p.label ? rawCustomMap.get(p.label) : undefined);
							if (found !== undefined) {
								paramObj[pKey] = found;
							} else if (p.defaultValue !== undefined) {
								paramObj[pKey] = p.defaultValue;
							}
						}
					}
					val = JSON.stringify(paramObj);
				}

				fieldsToRender.push({
					key: matchedKey || fLabel,
					label: fLabel,
					type: f.type || 'text',
					val: val,
					options: f.options || f.choices || [],
					buttons: (f as any).buttons || [],
					unit: f.unit,
					precision: f.precision !== undefined ? f.precision : 2,
					defaultUrl: (f as any).defaultUrl,
					credentials: (f as any).credentials,
					gitRemoteUrl: (f as any).gitRemoteUrl,
					gitBranch: (f as any).gitBranch,
					parameters: (f as any).parameters,
					outputSpecs: (f as any).outputSpecs,
					defaultFormat: (f as any).defaultFormat,
					defaultContent: (f as any).defaultContent
				});
			}

			// 2. Extra keys in ticket.md not in customModule.fields
			// If value is non-empty, preserve it so historical user data is never lost.
			for (const [k, v] of rawCustomMap.entries()) {
				if (!handledKeys.has(k)) {
					if (k.toLowerCase() === 'title' || k.toLowerCase() === 'description') {
						continue;
					}
					const isNonEmpty = v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '[]' && String(v).trim() !== '{}';
					if (isNonEmpty) {
						const isAtt = k.toLowerCase().includes('attachment') || (typeof v === 'string' && (v.trim().startsWith('[{"name":') || v.trim().startsWith('{"name":')));
						fieldsToRender.push({
							key: k,
							label: k,
							type: isAtt ? 'attachment' : ((typeof v === 'string' && v.trim().startsWith('[') && v.trim().endsWith(']')) ? 'dynamic_list' : 'text'),
							val: v,
							options: []
						});
					}
				}
			}
		} else {
			for (const [k, v] of rawCustomMap.entries()) {
				if (k.toLowerCase() === 'title' || k.toLowerCase() === 'description') {
					continue;
				}
				const isAtt = k.toLowerCase().includes('attachment') || (typeof v === 'string' && (v.trim().startsWith('[{"name":') || v.trim().startsWith('{"name":')));
				fieldsToRender.push({
					key: k,
					label: k,
					type: isAtt ? 'attachment' : ((typeof v === 'string' && v.trim().startsWith('[') && v.trim().endsWith(']')) ? 'dynamic_list' : 'text'),
					val: v,
					options: []
				});
			}
		}

		if (fieldsToRender.length > 0) {
			for (const fieldItem of fieldsToRender) {
				const k = fieldItem.label;
				const rawKey = fieldItem.key;
				const v = fieldItem.val;
				const fType = fieldItem.type;

				// 1:1 DEDICATED ATTACHMENT COMPONENT - ATOMIC, NEVER TREATED AS DYNAMIC LIST OR CONTAINER
				const isAttachmentField = fType === 'attachment' ||
					(customModule?.fields && Array.isArray(customModule.fields) && customModule.fields.some((f: any) => (f.label?.toLowerCase() === k.toLowerCase() || f.id?.toLowerCase() === k.toLowerCase()) && f.type === 'attachment')) ||
					k.toLowerCase().includes('attachment') ||
					(typeof v === 'string' && (v.trim().startsWith('[{"name":') || v.trim().startsWith('{"name":')));

				if (isAttachmentField) {
					let parsedAttachmentList: Array<{ name: string; size?: number }> | null = null;
					if (typeof v === 'string') {
						const trimmed = v.trim();
						if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
							try {
								const parsedJson = JSON.parse(trimmed);
								if (Array.isArray(parsedJson)) {
									parsedAttachmentList = parsedJson;
								} else if (parsedJson && typeof parsedJson === 'object' && parsedJson.name) {
									parsedAttachmentList = [parsedJson];
								}
							} catch { }
						}
					} else if (Array.isArray(v)) {
						parsedAttachmentList = v;
					} else if (v && typeof v === 'object' && (v as any).name) {
						parsedAttachmentList = [v as any];
					}

					let fileItemsHtml = '';
					const filesToRender: Array<{ name: string; size?: number }> = parsedAttachmentList || (v && String(v).trim() !== '' && String(v).trim() !== 'None' ? [{ name: String(v) }] : []);
					if (filesToRender.length === 0) {
						fileItemsHtml = '<div style="opacity: 0.5; font-style: italic; font-size: 0.88em; padding: 6px 0;">No attachments linked to this field yet.</div>';
					} else {
						fileItemsHtml = '<div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px;">';
						for (const f of filesToRender) {
							const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name);
							const isPdf = /\.pdf$/i.test(f.name);
							const iconSvg = isImg
								? '<svg width="13" height="13" viewBox="0 0 16 16" fill="#10b981"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v8.793l3.146-3.147a.5.5 0 0 1 .708 0L8 10.293l3.646-3.647a.5.5 0 0 1 .708 0L14 8.293V2.5a.5.5 0 0 0-.5-.5h-11zm11.5 7.707-2.146-2.147-3.646 3.647a.5.5 0 0 1-.708 0L5.354 9.06 2 12.414V13.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-3.793z"/></svg>'
								: (isPdf
									? '<svg width="13" height="13" viewBox="0 0 16 16" fill="#ef4444"><path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/></svg>'
									: '<svg width="13" height="13" viewBox="0 0 16 16" fill="#10b981"><path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/></svg>');

							fileItemsHtml += `
								<div class="attachment-card-download" data-file-name="${this._escapeHtmlAttr(f.name)}" style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 6px; cursor: pointer; transition: all 0.15s ease;" title="Download attachment">
									${iconSvg}
									<span style="font-size: 0.9em; font-weight: 500; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this._escapeHtmlAttr(f.name)}</span>
									${f.size ? `<span style="font-size: 0.75em; opacity: 0.5;">(${(f.size / 1024).toFixed(0)} KB)</span>` : ''}
								</div>
							`;
						}
						fileItemsHtml += '</div>';
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; font-weight: 700; text-transform: uppercase;">Attachment</span>
								</div>
								<div style="display: flex; align-items: center; gap: 8px;">
									<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="attachment" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(parsedAttachmentList ? JSON.stringify(parsedAttachmentList) : String(v || ''))}" title="Edit ${k} with AI">
										<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
									</button>
								</div>
							</div>
							<div class="custom-field-view">
								${fileItemsHtml}
							</div>
						</div>
					`;
				} else if (fType === 'dynamic_list' || (typeof v === 'string' && v.trim().startsWith('[') && v.trim().endsWith(']'))) {
					let parsedArray: any[] | null = null;
					if (typeof v === 'string' && v.trim().startsWith('[')) {
						try {
							const parsed = JSON.parse(v.trim());
							if (Array.isArray(parsed)) {
								parsedArray = parsed;
							}
						} catch {}
					} else if (Array.isArray(v)) {
						parsedArray = v;
					} else {
						parsedArray = [];
					}

					// Dynamic List Container
					let subCardsViewHtml = '';

					if (!parsedArray || parsedArray.length === 0) {
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
											<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}/${idxNum}/${subK}" data-ai-field-type="${isDateOrRange ? 'date_range' : (isLong ? 'textarea' : 'text')}" data-ai-field-label="${subK}" data-ai-current-value="${this._escapeHtmlAttr(subVal)}" title="Edit ${subK} with AI" style="padding: 2px 5px; font-size: 0.75em;">
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
										<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}/${idxNum}" data-ai-field-type="composite" data-ai-field-label="${itemTitle}" data-ai-current-value="${this._escapeHtmlAttr(itemTitle)}" title="Edit ${itemTitle} with AI">
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
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="dynamic_list" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(typeof v === 'string' ? v : JSON.stringify(v))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view">
								${subCardsViewHtml}
							</div>
						</div>
					`;
				} else if (fType === 'switch' || fType === 'boolean' || k.toLowerCase().includes('flag')) {
					const isChecked = String(v).trim().toLowerCase() === 'true';
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: ${isChecked ? 'rgba(16,185,129,0.15)' : 'rgba(148,163,184,0.15)'}; color: ${isChecked ? '#10b981' : '#94a3b8'}; font-weight: 700; text-transform: uppercase;">Switch</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="switch" data-ai-field-label="${k}" data-ai-current-value="${isChecked ? 'true' : 'false'}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="display: flex; align-items: center; gap: 10px; padding: 6px 0;">
								<div style="width: 36px; height: 20px; border-radius: 10px; background: ${isChecked ? '#10b981' : 'rgba(255,255,255,0.14)'}; position: relative; border: 1px solid ${isChecked ? '#059669' : 'rgba(255,255,255,0.2)'};">
									<div style="width: 14px; height: 14px; border-radius: 50%; background: #fff; position: absolute; top: 2px; left: ${isChecked ? '18px' : '2px'}; box-shadow: 0 1px 3px rgba(0,0,0,0.4);"></div>
								</div>
								<span style="font-size: 0.9em; font-weight: 600; color: ${isChecked ? '#10b981' : '#94a3b8'};">
									${isChecked ? 'ON (true)' : 'OFF (false)'}
								</span>
							</div>
						</div>
					`;
				} else if (fType === 'select' || fType === 'single_select') {
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.15); color: #60a5fa; font-weight: 700; text-transform: uppercase;">Select</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="select" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(fieldItem.options || []))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${v ? `
									<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 4px; background: rgba(59,130,246,0.12); color: #93c5fd; border: 1px solid rgba(59,130,246,0.25); font-size: 0.9em; font-weight: 500;">
										<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
										${v}
									</span>
								` : '<span style="opacity: 0.45; font-style: italic;">No option selected.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'multiselect' || fType === 'tags') {
					let selectedArr: string[] = [];
					if (Array.isArray(v)) {
						selectedArr = v;
					} else if (typeof v === 'string') {
						const tr = v.trim();
						if (tr.startsWith('[')) {
							try { selectedArr = JSON.parse(tr); } catch {}
						} else if (tr && tr !== 'None' && tr !== 'null' && tr !== 'undefined') {
							selectedArr = tr.split(',').map(s => s.trim()).filter(Boolean);
						}
					}
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(99,102,241,0.15); color: #818cf8; font-weight: 700; text-transform: uppercase;">Multiselect</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="multiselect" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(fieldItem.options || []))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0;">
								${selectedArr.length > 0 ? selectedArr.map(item => `
									<span style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 12px; background: rgba(99,102,241,0.15); color: #818cf8; border: 1px solid rgba(99,102,241,0.3); font-size: 0.85em; font-weight: 500;">
										🏷️ ${this._escapeHtmlAttr(String(item))}
									</span>
								`).join('') : '<span style="opacity: 0.45; font-style: italic;">No options selected.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'date') {
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.15); color: #60a5fa; font-weight: 700; text-transform: uppercase;">Date</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="date" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${v ? `
									<span style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 4px; background: rgba(59,130,246,0.12); color: #60a5fa; border: 1px solid rgba(59,130,246,0.25); font-size: 0.9em; font-weight: 500;">
										📅 ${v}
									</span>
								` : '<span style="opacity: 0.45; font-style: italic;">No date set.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'time') {
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(234,179,8,0.15); color: #facc15; font-weight: 700; text-transform: uppercase;">Time</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="time" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${v ? `
									<span style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 4px; background: rgba(234,179,8,0.12); color: #facc15; border: 1px solid rgba(234,179,8,0.25); font-size: 0.9em; font-weight: 500;">
										🕒 ${v}
									</span>
								` : '<span style="opacity: 0.45; font-style: italic;">No time set.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'datetime') {
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(168,85,247,0.15); color: #c084fc; font-weight: 700; text-transform: uppercase;">DateTime</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="datetime" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${v ? `
									<span style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 4px; background: rgba(168,85,247,0.12); color: #c084fc; border: 1px solid rgba(168,85,247,0.25); font-size: 0.9em; font-weight: 500;">
										📅 🕒 ${v}
									</span>
								` : '<span style="opacity: 0.45; font-style: italic;">No datetime set.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'date_range' || fType === 'time_range' || fType === 'datetime_range' || (typeof v === 'string' && (v.includes('~') || /^\d{4}-\d{2}-\d{2}/.test(v)))) {
					const rangeType = fType || 'date_range';
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; font-weight: 700; text-transform: uppercase;">Range</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="${rangeType}" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${v ? `
									<span class="range-badge" style="font-size: 0.9em; font-weight: 600; padding: 3px 10px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); display: inline-flex; align-items: center; gap: 6px;">
										${v}
									</span>
								` : '<span style="opacity: 0.45; font-style: italic;">No range set.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'button_group' || fType === 'button') {
					const buttonsList: IActionButton[] = (fieldItem.buttons && fieldItem.buttons.length > 0)
						? fieldItem.buttons
						: [
							{ id: 'btn_1', label: 'Approve', color: '#10b981', targetStatus: 'Done' },
							{ id: 'btn_2', label: 'Reject', color: '#ef4444', targetStatus: 'Blocked' }
						];

					const buttonsHtml = buttonsList.map(btn => {
						const btnColor = btn.color || '#3b82f6';
						const targetStatus = btn.targetStatus || '';
						return `
							<button type="button" class="ticket-action-transition-btn"
								data-action-id="${this._escapeHtmlAttr(btn.id)}"
								data-action-label="${this._escapeHtmlAttr(btn.label)}"
								data-target-status="${this._escapeHtmlAttr(targetStatus)}"
								data-field-key="${this._escapeHtmlAttr(rawKey)}"
								style="--btn-accent-color: ${btnColor};"
								title="${targetStatus ? `Trigger '${btn.label}' and transition to '${targetStatus}'` : `Trigger '${btn.label}'`}">
								<span class="action-btn-text">${this._escapeHtmlAttr(btn.label)}</span>
							</button>
						`;
					}).join('');

					customFieldsHtml += `
						<div class="section-card custom-property-card action-button-group-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.15); color: #60a5fa; font-weight: 700; text-transform: uppercase;">Actions</span>
								</div>
							</div>
							<div class="custom-field-view" style="padding: 6px 0;">
								<div class="action-buttons-group-row">
									${buttonsHtml}
								</div>
							</div>
						</div>
					`;
				} else if (fType === 'number') {
					let formattedVal = '';
					const numVal = (v !== undefined && v !== null && String(v).trim() !== '') ? Number(v) : NaN;
					const prec = fieldItem.precision !== undefined ? fieldItem.precision : 2;
					if (!isNaN(numVal)) {
						const formattedNum = numVal.toLocaleString('en-US', {
							minimumFractionDigits: prec,
							maximumFractionDigits: prec
						});
						const unit = (fieldItem.unit || '').trim();
						if (unit) {
							if (/^[$€¥£₹₽₿]/.test(unit)) {
								formattedVal = `${unit}${formattedNum}`;
							} else {
								formattedVal = `${formattedNum} ${unit}`;
							}
						} else {
							formattedVal = formattedNum;
						}
					}
					customFieldsHtml += `
						<div class="section-card custom-property-card number-field-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(234, 179, 8, 0.18); color: #facc15; font-weight: 700; text-transform: uppercase;">Number</span>
									${fieldItem.unit ? `<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.08); color: #94a3b8; font-weight: 600;">${this._escapeHtmlAttr(fieldItem.unit)}</span>` : ''}
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="number" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v ?? ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="padding: 4px 0;">
								${formattedVal ? `
									<div style="display: inline-flex; align-items: baseline; gap: 6px; background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.25); border-radius: 6px; padding: 6px 14px;">
										<span style="font-size: 1.25em; font-weight: 700; color: #facc15; font-variant-numeric: tabular-nums;">${formattedVal}</span>
									</div>
								` : '<span style="opacity: 0.45; font-style: italic;">No number set.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'git') {
					// Git primitive is integrated into the dedicated sidebar Git repository binding
					continue;
				} else if (fType === 'parameters') {
					// Inputs Primitive
					const paramDefs: IParameterDefinition[] = fieldItem.parameters || [];
					let paramValues: { [name: string]: string } = {};
					if (v) {
						if (typeof v === 'string') {
							try {
								paramValues = JSON.parse(v);
								if (typeof paramValues !== 'object' || paramValues === null || Array.isArray(paramValues)) {
									paramValues = {};
								}
							} catch {
								paramValues = {};
							}
						} else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
							paramValues = v as { [name: string]: string };
						}
					}

					const rowsHtml = paramDefs.map(param => {
						const currentVal = paramValues[param.name] !== undefined ? paramValues[param.name] : (param.defaultValue || '');
						const hasOptions = Array.isArray(param.options) && param.options.length > 0;
						const copyToken = `{{${param.name}}}`;

						let controlHtml = '';
						if (hasOptions) {
							const optionsHtml = param.options!.map(opt => {
								const selected = String(opt) === String(currentVal) ? 'selected' : '';
								return `<option value="${this._escapeHtmlAttr(opt)}" ${selected}>${this._escapeHtml(opt)}</option>`;
							}).join('');
							controlHtml = `
								<select class="ticket-parameter-input monaco-select-box" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-param-name="${this._escapeHtmlAttr(param.name)}" style="flex: 1; min-width: 140px; padding: 5px 8px; font-size: 12px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit;">
									${optionsHtml}
								</select>
							`;
						} else {
							controlHtml = `
								<input type="text" class="ticket-parameter-input monaco-inputbox" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-param-name="${this._escapeHtmlAttr(param.name)}" value="${this._escapeHtmlAttr(currentVal)}" placeholder="${this._escapeHtmlAttr(param.defaultValue || '')}" style="flex: 1; min-width: 140px; padding: 5px 10px; font-size: 12px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.3); color: inherit; font-family: var(--vscode-editor-font-family, monospace);" />
							`;
						}

						return `
							<div class="ticket-parameter-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: 6px; background: rgba(255, 255, 255, 0.025); border: 1px solid rgba(255, 255, 255, 0.06);">
								<div style="display: flex; flex-direction: column; gap: 2px; min-width: 130px;">
									<div style="display: flex; align-items: center; gap: 6px;">
										<span style="font-size: 12px; font-weight: 600;">${this._escapeHtml(param.label || param.name)}</span>
										<button type="button" class="ticket-param-copy-tag" data-token="${this._escapeHtmlAttr(copyToken)}" title="Click to copy '${copyToken}'" style="border: 1px solid rgba(168, 85, 247, 0.35); background: rgba(168, 85, 247, 0.12); color: #c084fc; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; font-weight: 700; border-radius: 4px; padding: 1px 6px; cursor: pointer; transition: all 0.15s ease;">
											${this._escapeHtml(copyToken)}
										</button>
									</div>
									${param.description ? `<span style="font-size: 10px; opacity: 0.55;">${this._escapeHtml(param.description)}</span>` : ''}
								</div>
								<div style="display: flex; align-items: center; gap: 8px; flex: 1; max-width: 380px;">
									${controlHtml}
								</div>
							</div>
						`;
					}).join('');

					customFieldsHtml += `
						<div class="section-card custom-property-card ticket-parameters-card" data-field-key="${this._escapeHtmlAttr(rawKey)}">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(168, 85, 247, 0.18); color: #c084fc; font-weight: 700; text-transform: uppercase;">Parameters</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(255, 255, 255, 0.06); color: #a1a1aa; font-weight: 600;">${paramDefs.length} Vars</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="parameters" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(typeof v === 'string' ? v : JSON.stringify(paramValues))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div style="font-size: 11px; opacity: 0.65; margin-bottom: 8px;">
								Runtime parameters can be referenced across URLs, prompts, and actions using <code>{{variable_name}}</code>.
							</div>
							<div class="parameters-rows-container" style="display: flex; flex-direction: column; gap: 6px;">
								${rowsHtml || '<span style="opacity: 0.4; font-style: italic;">No parameters defined in schema.</span>'}
							</div>
						</div>
					`;
				} else if (fType === 'python') {
					let pythonPath = fieldItem.pythonPath || '';
					let pythonCode = fieldItem.pythonCode || '';
					let pythonOutput = '';
					let pythonResult: any = undefined;
					let exitCode: number | undefined;
					let durationMs: number | undefined;
					let lastExecutedText = '';

					if (v) {
						if (typeof v === 'string') {
							const trimmed = v.trim();
							if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
								try {
									const pObj = JSON.parse(trimmed);
									if (pObj.pythonPath !== undefined) {
										const p = pObj.pythonPath;
										if (typeof p === 'object' && p !== null) {
											pythonPath = String(p.interpreterPath || p.pythonPath || '');
										} else {
											const s = String(p);
											pythonPath = s === '[object Object]' ? '' : s;
										}
									}
									if (pObj.code !== undefined) pythonCode = pObj.code;
									if (pObj.pythonCode !== undefined && !pythonCode) pythonCode = pObj.pythonCode;
									if (pObj.result !== undefined) pythonResult = pObj.result;
									if (pObj.output !== undefined) pythonOutput = pObj.output;
									if (pObj.exitCode !== undefined) exitCode = pObj.exitCode;
									if (pObj.durationMs !== undefined) durationMs = pObj.durationMs;
									if (pObj.lastExecuted) lastExecutedText = pObj.lastExecuted;
								} catch {
									pythonCode = trimmed;
								}
							} else {
								pythonCode = trimmed;
							}
						} else if (typeof v === 'object' && v !== null) {
							const obj = v as Record<string, unknown>;
							if (obj.pythonPath !== undefined) {
								const p = obj.pythonPath;
								if (typeof p === 'object' && p !== null) {
									pythonPath = String((p as any).interpreterPath || (p as any).pythonPath || '');
								} else {
									const s = String(p);
									pythonPath = s === '[object Object]' ? '' : s;
								}
							}
							if (obj.code !== undefined) pythonCode = String(obj.code);
							if (obj.pythonCode !== undefined && !pythonCode) pythonCode = String(obj.pythonCode);
							if (obj.result !== undefined) pythonResult = obj.result;
							if (obj.output !== undefined) pythonOutput = String(obj.output);
							if (obj.exitCode !== undefined) exitCode = Number(obj.exitCode);
							if (obj.durationMs !== undefined) durationMs = Number(obj.durationMs);
							if (obj.lastExecuted) lastExecutedText = String(obj.lastExecuted);
						}
					}

					if (typeof pythonPath === 'object' && pythonPath !== null) {
						pythonPath = String((pythonPath as any).interpreterPath || (pythonPath as any).pythonPath || '');
					}
					if (pythonPath === '[object Object]' || pythonPath === 'undefined' || pythonPath === 'null') {
						pythonPath = '';
					}

					if (!pythonCode) {
						pythonCode = '# Write Python automation script\n# Context variables are available via TICKET_CONTEXT dictionary (e.g. TICKET_CONTEXT[\'Field Name\'])\n# Define the clean return value for Output Manifest & downstream primitives:\nOUTPUT = {"status": "ready"}\n';
					}

					const statusTag = lastExecutedText
						? `Executed: ${lastExecutedText.substring(0, 16)} (${durationMs !== undefined ? `${durationMs}ms` : 'ok'})`
						: 'Ready to execute';

					const otherFields = (customModule?.fields || []).filter(f => f && f.id !== rawKey && (f.label || f.id) !== k);
					const baseChipHtml = `<button type="button" class="python-insert-ctx-chip" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-insert="TICKET_CONTEXT['']" data-cursor-offset="-2" style="padding: 2px 7px; font-size: 10.5px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;" title="Insert TICKET_CONTEXT[''] into script">+ TICKET_CONTEXT['']</button>`;
					const outputChipHtml = `<button type="button" class="python-insert-ctx-chip" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-insert="&#10;OUTPUT = " data-cursor-offset="0" style="padding: 2px 7px; font-size: 10.5px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.1); color: #34d399; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;" title="Insert return value assignment OUTPUT = ... (consumed by downstream primitives & Output Manifest)">+ OUTPUT =</button>`;

					const maxInitialVisible = 2;
					const visibleFields = otherFields.slice(0, maxInitialVisible);
					const hiddenFields = otherFields.slice(maxInitialVisible);

					const visibleChipsHtml = visibleFields.map(of => {
						const ofLabel = of.label || of.id;
						return `<button type="button" class="python-insert-ctx-chip" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-insert="TICKET_CONTEXT['${this._escapeHtmlAttr(ofLabel)}']" data-cursor-offset="0" style="padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;" title="Insert TICKET_CONTEXT['${this._escapeHtmlAttr(ofLabel)}']">+ TICKET_CONTEXT['${this._escapeHtml(ofLabel)}']</button>`;
					}).join('');

					let hiddenChipsHtml = '';
					let moreBtnHtml = '';
					if (hiddenFields.length > 0) {
						hiddenChipsHtml = `
							<span class="python-ctx-hidden-group" style="display: none;">
								${hiddenFields.map(of => {
									const ofLabel = of.label || of.id;
									return `<button type="button" class="python-insert-ctx-chip" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-insert="TICKET_CONTEXT['${this._escapeHtmlAttr(ofLabel)}']" data-cursor-offset="0" style="padding: 2px 7px; font-size: 10.5px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.1); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap;" title="Insert TICKET_CONTEXT['${this._escapeHtmlAttr(ofLabel)}']">+ TICKET_CONTEXT['${this._escapeHtml(ofLabel)}']</button>`;
								}).join('')}
							</span>
						`;
						moreBtnHtml = `<button type="button" class="python-ctx-more-btn" data-count="${hiddenFields.length}" style="padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 4px; border: 1px dashed rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.06); color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; white-space: nowrap;" title="Toggle more context fields">+${hiddenFields.length} More...</button>`;
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card python-primitive-card" data-field-key="${this._escapeHtmlAttr(rawKey)}">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(56,189,248,0.12); color: #38bdf8; font-weight: 700; text-transform: uppercase;">Python</span>
									<span class="python-env-badge" style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); font-family: monospace;">${this._escapeHtml(pythonPath || '.venv / python3')}</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="python" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(pythonCode)}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>

							<div class="custom-field-view" style="display: flex; flex-direction: column; gap: 10px; padding: 4px 0;">
								<!-- Virtual Environment & Interpreter Row -->
								<div style="background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px;">
									<div style="display: flex; justify-content: space-between; align-items: center;">
										<label style="font-size: 11px; font-weight: 600; opacity: 0.85; color: inherit; display: flex; align-items: center; gap: 6px;">
											<span>Virtual Environment / Interpreter:</span>
										</label>
										<span class="python-test-status" style="font-size: 10px; opacity: 0.65;"></span>
									</div>
									<div style="display: flex; gap: 6px; align-items: center;">
										<input type="text" class="python-interpreter-input monaco-inputbox" data-field-key="${this._escapeHtmlAttr(rawKey)}" value="${this._escapeHtmlAttr(pythonPath)}" placeholder="Auto-detect (.venv or system python3) — or click Browse... to select" style="flex: 1; padding: 6px 10px; font-size: 11.5px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.28); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);" />
										<button type="button" class="python-browse-interpreter-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Select Python Interpreter or Virtualenv Folder" style="padding: 5px 10px; font-size: 11px; border-radius: 5px; cursor: pointer; background: rgba(255,255,255,0.08); color: inherit; border: 1px solid rgba(255,255,255,0.15); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10l-.5-.5zm-.5 10H2V3h4.29l.85.85.35.15H14v9z"/></svg><span>Browse...</span></button>
										<button type="button" class="python-test-interpreter-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Test Python binary and check version" style="padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(255,255,255,0.08); color: inherit; border: 1px solid rgba(255,255,255,0.15); white-space: nowrap;">Test</button>
										<button type="button" class="python-create-venv-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Initialize a local virtual environment (.venv) via python3 -m venv" style="padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56,189,248,0.12); color: #38bdf8; border: 1px solid rgba(56,189,248,0.35); white-space: nowrap;">Create venv</button>
									</div>
								</div>

								<!-- Python Source Code Textarea -->
								<div style="display: flex; flex-direction: column; gap: 4px;">
									<div style="display: flex; justify-content: space-between; align-items: center;">
										<label style="font-size: 11px; font-weight: 600; opacity: 0.85;">Source Code:</label>
										<div style="display: flex; align-items: center; gap: 8px;">
											<span style="font-size: 10px; opacity: 0.55;">Supports TICKET_CONTEXT, {{variables}}, and ANY_AGENT_CONTEXT</span>
											<span class="python-mode-badge" style="font-size: 9.5px; padding: 1.5px 6px; border-radius: 3px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); font-weight: 600; cursor: pointer; user-select: none;" title="Click to toggle between Code Highlight Preview and Raw Text Editor">🎨 Highlighted</span>
										</div>
									</div>
									<div class="python-code-wrapper" style="position: relative; width: 100%; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); box-sizing: border-box; overflow: hidden; transition: border-color 0.15s ease;">
										<div class="python-code-display" style="width: 100%; min-height: 120px; max-height: 380px; overflow-y: auto; padding: 8px 10px; font-size: 11.5px; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.5; tab-size: 4; white-space: pre-wrap; word-break: break-word; color: #d4d4d4; cursor: text; box-sizing: border-box;" title="Click to edit Python script">${highlightPythonToHTML(pythonCode, { showLineNumbers: true })}</div>
										<textarea class="python-code-textarea monaco-inputbox" data-field-key="${this._escapeHtmlAttr(rawKey)}" rows="6" placeholder="Enter Python script to execute..." spellcheck="false" style="width: 100%; min-height: 120px; padding: 8px 10px; font-size: 11.5px; border: none; outline: none; background: rgba(0,0,0,0.4); color: #f1f5f9; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.5; resize: vertical; tab-size: 4; display: none;">${this._escapeHtml(pythonCode)}</textarea>
									</div>
									<div class="python-ctx-chips-bar" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 0;">
										<span style="font-size: 10.5px; opacity: 0.65;">Insert Context:</span>
										${baseChipHtml}
										${outputChipHtml}
										${visibleChipsHtml}
										${hiddenChipsHtml}
										${moreBtnHtml}
									</div>
								</div>

								<!-- Action Buttons Row -->
								<div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
									<div style="display: flex; gap: 8px; align-items: center;">
										<button type="button" class="python-run-script-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; font-size: 11.5px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.45); transition: all 0.15s ease;" title="Run Python script in virtualenv or interpreter">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5l9 5.5-9 5.5v-11z"/></svg>
											<span>Run Script</span>
										</button>
										<button type="button" class="python-save-code-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(255,255,255,0.08); color: inherit; border: 1px solid rgba(255,255,255,0.15);" title="Save code without running">
											<span>Save Code</span>
										</button>
									</div>
									<span class="python-status-text" style="font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.06); opacity: 0.7;">${statusTag}</span>
								</div>

								<!-- Debug & Execution Output Box -->
								<div class="python-output-section" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
									${pythonResult !== undefined ? `
										<div class="python-result-block" style="background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 5px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
											<div style="display: flex; justify-content: space-between; align-items: center;">
												<span style="font-size: 11px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">Return Value (Output):</span>
												<span style="font-size: 9.5px; opacity: 0.65; color: #38bdf8;">Consumed by Output Manifest & Downstream Primitives</span>
											</div>
											<pre class="python-result-display" style="margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: #e0f2fe; max-height: 180px; overflow-y: auto;">${this._escapeHtml(typeof pythonResult === 'object' ? JSON.stringify(pythonResult, null, 2) : String(pythonResult))}</pre>
										</div>
									` : ''}
									<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
										<div style="display: flex; align-items: center; gap: 8px;">
											<span style="font-size: 11px; font-weight: 600; opacity: 0.85;">Console Logs & Execution:</span>
											${exitCode !== undefined ? `<span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; background: ${exitCode === 0 ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)'}; color: ${exitCode === 0 ? '#4ade80' : '#f87171'};">Exit code: ${exitCode}</span>` : ''}
										</div>
										<div style="display: flex; gap: 6px;">
											<button type="button" class="python-copy-output-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Copy Logs</button>
											<button type="button" class="python-clear-output-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Clear</button>
										</div>
									</div>
									<div class="python-output-display desc-content-box" style="max-height: 280px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${pythonOutput ? this._escapeHtml(pythonOutput) : '<span style="opacity: 0.4; font-style: italic;">No execution logs yet. Click "Run Script" above to execute the automation code.</span>'}</div>
								</div>
							</div>
						</div>
					`;
				} else if (fType === 'browser') {
					let browserUrl = fieldItem.defaultUrl || '';
					let browserCreds: ICredentialPair[] = fieldItem.credentials || [];
					let browserContent = '';
					let lastFetchedText = '';

					if (v) {
						if (typeof v === 'string') {
							const trimmed = v.trim();
							if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
								try {
									const parsedObj = JSON.parse(trimmed);
									if (parsedObj.url !== undefined) browserUrl = parsedObj.url;
									if (Array.isArray(parsedObj.credentials) && parsedObj.credentials.length > 0) browserCreds = parsedObj.credentials;
									if (parsedObj.content) browserContent = parsedObj.content;
									if (parsedObj.lastFetched) lastFetchedText = parsedObj.lastFetched;
								} catch {
									browserUrl = trimmed;
								}
							} else {
								browserUrl = trimmed;
							}
						} else if (typeof v === 'object' && v !== null) {
							if ((v as any).url) browserUrl = (v as any).url;
							if (Array.isArray((v as any).credentials)) browserCreds = (v as any).credentials;
							if ((v as any).content) browserContent = (v as any).content;
							if ((v as any).lastFetched) lastFetchedText = (v as any).lastFetched;
						}
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card browser-primitive-card" data-field-key="${this._escapeHtmlAttr(rawKey)}">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(56,189,248,0.18); color: #38bdf8; font-weight: 700; text-transform: uppercase;">Browser</span>
									${browserCreds.length > 0 ? `<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(167,139,250,0.15); color: #c084fc; font-weight: 600;">🔑 ${browserCreds.length} Credentials</span>` : ''}
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="browser" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(browserUrl)}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>

							<!-- URL Input Bar (Full Width) -->
							<div style="width: 100%; margin-bottom: 8px;">
								<input type="text" class="browser-url-input" value="${this._escapeHtmlAttr(browserUrl)}" placeholder="https://example.com..." style="width: 100%; padding: 7px 12px; font-size: 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.28); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);" />
							</div>

							<!-- Action Buttons Row (Below URL) -->
							<div style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;">
								<!-- Silent Fetch Button -->
								<button type="button" class="browser-silent-fetch-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Fetch webpage in background and extract text/HTML for AI" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 11.5px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); transition: all 0.15s ease;">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12l-4-4h2.5V3h3v5H12l-4 4zm-7 2h14v1.5H1V14z"/></svg>
									<span>Fetch (Silent)</span>
								</button>
								<!-- Open in Tab Button -->
								<button type="button" class="browser-open-tab-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Open webpage in a new VS Code browser tab" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 11.5px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(167, 139, 250, 0.15); color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.35); transition: all 0.15s ease;">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.5A1.5 1.5 0 0 1 3 1h10a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-11zM3 2a.5.5 0 0 0-.5.5V4h11V2.5a.5.5 0 0 0-.5-.5H3zm11 3H2v8.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V5z"/></svg>
									<span>Open in Tab</span>
								</button>
								<!-- New Tab Button -->
								<button type="button" class="browser-new-tab-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Open a new independent browser tab beside (e.g. for login, cookies, or manual navigation)" style="display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; font-size: 11.5px; font-weight: 600; border-radius: 6px; cursor: pointer; background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.35); transition: all 0.15s ease;">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg>
									<span>New Tab</span>
								</button>
							</div>

							<!-- Credentials Drawer -->
							${browserCreds.length > 0 ? `
								<div style="background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px;">
									<div style="font-size: 10.5px; font-weight: 700; color: #a78bfa; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px;">
										<span>🔑 Credentials / Authentication</span>
										<span style="font-size: 9.5px; opacity: 0.5; font-weight: normal; text-transform: none;">(Available for AI automated navigation)</span>
									</div>
									<div style="display: flex; flex-wrap: wrap; gap: 8px;">
										${browserCreds.map(c => `
											<div class="browser-cred-item" style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 3px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 6px;">
												<span style="opacity: 0.7; font-weight: 600;">${this._escapeHtmlAttr(c.key)}:</span>
												<span class="cred-secret-text" data-real="${this._escapeHtmlAttr(c.value)}" style="font-family: monospace;">••••••••</span>
												<span class="cred-toggle-eye" style="cursor: pointer; opacity: 0.6; font-size: 11px;" title="Click to show/hide">👁️</span>
											</div>
										`).join('')}
									</div>
								</div>
							` : ''}

							<!-- Web Content Display Area -->
							<div class="browser-content-container" style="display: flex; flex-direction: column; gap: 6px;">
								<div style="display: flex; justify-content: space-between; align-items: center;">
									<div style="display: flex; align-items: center; gap: 8px;">
										<span style="font-size: 11px; font-weight: 600; opacity: 0.75; text-transform: uppercase;">Extracted Web Content (AI-Ready):</span>
										<span class="browser-fetch-status" style="font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,0.06); opacity: 0.65;">${lastFetchedText ? `Last fetched: ${this._escapeHtmlAttr(lastFetchedText)}` : 'Not fetched yet'}</span>
									</div>
									<div style="display: flex; gap: 6px;">
										<button type="button" class="browser-copy-content-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Copy Text</button>
										<button type="button" class="browser-clear-content-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Clear</button>
									</div>
								</div>
								<div class="browser-content-display desc-content-box" style="max-height: 240px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${browserContent ? this._escapeHtml(browserContent) : '<span style="opacity: 0.4; font-style: italic;">No webpage content extracted yet. Enter a URL above and click "Fetch (Silent)" or "Open in Tab" to extract page contents.</span>'}</div>
							</div>
						</div>
					`;
				} else if (fType === 'prompt') {
					let promptText = fieldItem.defaultContent || '';
					let promptMode: 'model' | 'agent' = fieldItem.targetMode || 'model';
					let promptModel = fieldItem.targetModel || 'gemini-1.5-flash';
					let promptAgentId = fieldItem.targetAgentId || '';
					let promptAgentName = fieldItem.targetAgentName || '';
					let promptOutput = '';
					let lastExecutedText = '';

					if (v) {
						if (typeof v === 'string') {
							const trimmed = v.trim();
							if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
								try {
									const pObj = JSON.parse(trimmed);
									if (pObj.prompt !== undefined) promptText = pObj.prompt;
									if (pObj.targetMode) promptMode = pObj.targetMode;
									if (pObj.targetModel) promptModel = pObj.targetModel;
									if (pObj.targetAgentId) promptAgentId = pObj.targetAgentId;
									if (pObj.targetAgentName) promptAgentName = pObj.targetAgentName;
									if (pObj.output) promptOutput = pObj.output;
									if (pObj.lastExecuted) lastExecutedText = pObj.lastExecuted;
								} catch {
									promptText = trimmed;
								}
							} else {
								promptText = trimmed;
							}
						} else if (typeof v === 'object' && v !== null) {
							const obj = v as Record<string, unknown>;
							if (obj.prompt !== undefined) { promptText = String(obj.prompt); }
							if (obj.targetMode) { promptMode = obj.targetMode as 'model' | 'agent'; }
							if (obj.targetModel) { promptModel = String(obj.targetModel); }
							if (obj.targetAgentId) { promptAgentId = String(obj.targetAgentId); }
							if (obj.targetAgentName) { promptAgentName = String(obj.targetAgentName); }
							if (obj.output) { promptOutput = String(obj.output); }
							if (obj.lastExecuted) { lastExecutedText = String(obj.lastExecuted); }
						}
					}

					if (promptAgentId && !promptAgentName) {
						const matchingAg = agents.find(a => a.id === promptAgentId);
						if (matchingAg) { promptAgentName = matchingAg.name; }
					}

					const isAgentMode = promptMode === 'agent';
					const targetBadgeText = isAgentMode
						? `🤖 Agent: ${promptAgentName || promptAgentId || 'Unassigned'}`
						: `⚡ Model: ${promptModel || 'gemini-1.5-flash'}`;
					const targetBadgeBg = isAgentMode ? 'rgba(56, 189, 248, 0.15)' : 'rgba(59, 130, 246, 0.15)';
					const targetBadgeColor = isAgentMode ? '#38bdf8' : '#60a5fa';

					const agentOptionsHtml = agents.length > 0
						? agents.map(ag => `<option value="${this._escapeHtmlAttr(ag.id)}" ${ag.id === promptAgentId ? 'selected' : ''}>${this._escapeHtml(ag.name)} (${this._escapeHtml(ag.role || 'Agent')})</option>`).join('')
						: '<option value="">-- No AI Agents configured --</option>';

					const presetModels = [
						{ id: 'gemini-1.5-flash', label: 'Google Gemini 1.5 Flash' },
						{ id: 'gemini-1.5-pro', label: 'Google Gemini 1.5 Pro' },
						{ id: 'gpt-4o', label: 'OpenAI GPT-4o' },
						{ id: 'gpt-4o-mini', label: 'OpenAI GPT-4o-mini' },
						{ id: 'claude-3-5-sonnet-20241022', label: 'Anthropic Claude 3.5 Sonnet' },
						{ id: 'claude-3-5-haiku-20241022', label: 'Anthropic Claude 3.5 Haiku' },
						{ id: 'deepseek-chat', label: 'DeepSeek Chat' }
					];
					let modelOptionsHtml = presetModels.map(pm => `<option value="${this._escapeHtmlAttr(pm.id)}" ${pm.id === promptModel ? 'selected' : ''}>${this._escapeHtml(pm.label)}</option>`).join('');
					if (!presetModels.some(pm => pm.id === promptModel) && promptModel) {
						modelOptionsHtml += `<option value="${this._escapeHtmlAttr(promptModel)}" selected>Custom: ${this._escapeHtml(promptModel)}</option>`;
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card prompt-primitive-card" data-field-key="${this._escapeHtmlAttr(rawKey)}">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(59,130,246,0.18); color: #60a5fa; font-weight: 700; text-transform: uppercase;">Prompt</span>
									<span class="prompt-target-badge" style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: ${targetBadgeBg}; color: ${targetBadgeColor}; font-weight: 600;">${this._escapeHtml(targetBadgeText)}</span>
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="prompt" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(promptText)}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view" style="display: flex; flex-direction: column; gap: 10px; padding: 4px 0;">
								<!-- Mode Switcher & Target Row -->
								<div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);">
									<div style="display: flex; align-items: center; gap: 6px;">
										<span style="font-size: 11px; font-weight: 600; opacity: 0.75;">Target:</span>
										<button type="button" class="prompt-mode-btn prompt-mode-model-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-mode="model" style="padding: 3px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; border: 1px solid ${!isAgentMode ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)'}; background: ${!isAgentMode ? 'rgba(59,130,246,0.18)' : 'transparent'}; color: ${!isAgentMode ? '#60a5fa' : 'inherit'};">⚡ Model</button>
										<button type="button" class="prompt-mode-btn prompt-mode-agent-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-mode="agent" style="padding: 3px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; border: 1px solid ${isAgentMode ? 'rgba(56,189,248,0.5)' : 'rgba(255,255,255,0.1)'}; background: ${isAgentMode ? 'rgba(56,189,248,0.2)' : 'transparent'}; color: ${isAgentMode ? '#38bdf8' : 'inherit'};">🤖 AI Agent</button>
									</div>
									<div class="prompt-target-selector-box" style="flex: 1; max-width: 320px; min-width: 200px;">
										<select class="prompt-model-select monaco-select" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="width: 100%; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(59,130,246,0.35); background: #1a1a1a; color: inherit; ${isAgentMode ? 'display: none;' : ''}">
											${modelOptionsHtml}
										</select>
										<select class="prompt-agent-select monaco-select" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="width: 100%; padding: 4px 8px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(56,189,248,0.3); background: #1a1a1a; color: inherit; ${!isAgentMode ? 'display: none;' : ''}">
											${agentOptionsHtml}
										</select>
									</div>
								</div>

								<!-- Prompt Instruction Input -->
								<div style="display: flex; flex-direction: column; gap: 4px;">
									<div style="display: flex; justify-content: space-between; align-items: center;">
										<label style="font-size: 11px; font-weight: 600; opacity: 0.85;">Instruction Prompt:</label>
										<span style="font-size: 10px; opacity: 0.55;">Use {{param_name}} to reference variables</span>
									</div>
									<textarea class="prompt-instruction-textarea monaco-inputbox" data-field-key="${this._escapeHtmlAttr(rawKey)}" rows="3" placeholder="Enter prompt instruction for model or AI agent..." style="width: 100%; padding: 8px 10px; font-size: 11.5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: inherit; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.45; resize: vertical;">${this._escapeHtml(promptText)}</textarea>
								</div>

								<!-- Action Buttons Row -->
								<div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
									<div style="display: flex; gap: 8px; align-items: center;">
										<button type="button" class="prompt-run-model-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(59,130,246,0.18); color: #60a5fa; border: 1px solid rgba(59,130,246,0.4); ${isAgentMode ? 'display: none;' : ''}" title="Execute prompt with selected model">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5l9 5.5-9 5.5v-11z"/></svg>
											<span>Run with Model</span>
										</button>
										<button type="button" class="prompt-dispatch-agent-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(56,189,248,0.18); color: #38bdf8; border: 1px solid rgba(56,189,248,0.4); ${!isAgentMode ? 'display: none;' : ''}" title="Dispatch task to selected AI Agent">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L2 5v6l6 4 6-4V5L8 1z"/></svg>
											<span>Dispatch to Agent</span>
										</button>
										<button type="button" class="prompt-open-agent-central-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.35);" title="Open Agent Central Chat with this prompt">
											<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 00-1 1v9a1 1 0 001 1h3v3l3.5-3H14a1 1 0 001-1V2a1 1 0 00-1-1z"/></svg>
											<span>Agent Central</span>
										</button>
									</div>
									<button type="button" class="prompt-save-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; font-size: 11px; font-weight: 600; border-radius: 5px; cursor: pointer; background: rgba(255,255,255,0.08); color: inherit; border: 1px solid rgba(255,255,255,0.15);" title="Save prompt instruction & settings">
										<span>Save Prompt</span>
									</button>
								</div>

								<!-- Output Area -->
								<div class="prompt-output-section" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
									<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
										<div style="display: flex; align-items: center; gap: 8px;">
											<span style="font-size: 11px; font-weight: 600; opacity: 0.85;">AI Execution Output:</span>
											<span class="prompt-status-text" style="font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(255,255,255,0.06); opacity: 0.65;">${lastExecutedText ? `Executed: ${this._escapeHtmlAttr(lastExecutedText)}` : 'Ready'}</span>
										</div>
										<div style="display: gap: 6px;">
											<button type="button" class="prompt-copy-output-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Copy</button>
											<button type="button" class="prompt-clear-output-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="background: transparent; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 7px; font-size: 10.5px; opacity: 0.75; cursor: pointer; color: inherit;">Clear</button>
										</div>
									</div>
									<div class="prompt-output-display desc-content-box" style="max-height: 280px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">${promptOutput ? this._escapeHtml(promptOutput) : '<span style="opacity: 0.4; font-style: italic;">No execution output yet. Click "Run with Model" or "Dispatch to Agent" above to run instructions.</span>'}</div>
								</div>
							</div>
						</div>
					`;
				} else if (fType === 'output' || fType === 'result') {
					const enabledSpecs = (fieldItem.outputSpecs || []).filter(s => s.enabled);
					let savedMap: Record<string, unknown> = {};
					let singleResultText = fieldItem.defaultContent || '';
					let singleResultFormat = fieldItem.defaultFormat || 'text';
					let lastUpdatedText = '';

					if (v) {
						if (typeof v === 'string') {
							const trimmed = v.trim();
							if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
								try {
									const parsed = JSON.parse(trimmed);
									if (typeof parsed === 'object' && parsed !== null) {
										const pRec = parsed as Record<string, unknown>;
										if (pRec.result !== undefined || pRec.output !== undefined) {
											singleResultText = String(pRec.result ?? pRec.output ?? '');
											if (pRec.format) { singleResultFormat = String(pRec.format); }
											if (pRec.lastUpdated) { lastUpdatedText = String(pRec.lastUpdated); }
										}
										savedMap = pRec;
									}
								} catch {
									singleResultText = v;
								}
							} else {
								singleResultText = v;
							}
						} else if (typeof v === 'object' && v !== null) {
							const rObj = v as Record<string, unknown>;
							if (rObj.result !== undefined || rObj.output !== undefined) {
								singleResultText = String(rObj.result ?? rObj.output ?? '');
								if (rObj.format) { singleResultFormat = String(rObj.format); }
								if (rObj.lastUpdated) { lastUpdatedText = String(rObj.lastUpdated); }
							}
							savedMap = rObj;
						}
					}

					let itemsHtml = '';

					if (enabledSpecs.length > 0) {
						for (const spec of enabledSpecs) {
							let itemText = '';
							let itemFormat = spec.defaultFormat || 'text';
							const specData = savedMap[spec.fieldKey] || savedMap[spec.label];

							// Find matching schema field to determine its primitive type
							const matchingField = customModule?.fields?.find((f: any) =>
								(f.label && f.label.toLowerCase() === spec.fieldKey.toLowerCase()) ||
								(f.id && f.id.toLowerCase() === spec.fieldKey.toLowerCase()) ||
								(f.label && f.label.toLowerCase() === spec.label.toLowerCase()) ||
								(f.id && f.id.toLowerCase() === spec.label.toLowerCase())
							);
							const isBrowserField = matchingField?.type === 'browser' || spec.fieldKey.toLowerCase().includes('browser') || spec.label.toLowerCase().includes('browser');
							const isPromptField = matchingField?.type === 'prompt' || spec.fieldKey.toLowerCase().includes('prompt') || spec.label.toLowerCase().includes('summary') || spec.label.toLowerCase().includes('instruction');

							if (specData) {
								if (typeof specData === 'object' && specData !== null) {
									const sRec = specData as Record<string, unknown>;
									if (isBrowserField) {
										itemText = String(sRec.content ?? sRec.text ?? '');
									} else if (isPromptField) {
										itemText = String(sRec.output ?? sRec.result ?? '');
									} else {
										itemText = String(sRec.text ?? sRec.content ?? sRec.result ?? sRec.output ?? JSON.stringify(specData, null, 2));
									}
									if (sRec.format) { itemFormat = String(sRec.format); }
								} else {
									itemText = String(specData);
								}
							} else {
								const primRaw = this._lastParsedData?.customMetadata?.[spec.fieldKey] ?? this._lastParsedData?.customMetadata?.[spec.label];
								if (primRaw) {
									if (typeof primRaw === 'string') {
										try {
											const pObj = JSON.parse(primRaw);
											if (typeof pObj === 'object' && pObj !== null) {
												const pRec = pObj as Record<string, unknown>;
												if (isBrowserField) {
													itemText = String(pRec.content ?? matchingField?.defaultContent ?? '');
												} else if (isPromptField) {
													itemText = String(pRec.output ?? '');
												} else {
													itemText = String(pRec.output ?? pRec.content ?? pRec.result ?? '');
												}
											} else if (isBrowserField) {
												itemText = matchingField?.defaultContent || '';
											} else if (isPromptField) {
												itemText = '';
											} else {
												itemText = primRaw;
											}
										} catch {
											if (isBrowserField) {
												itemText = matchingField?.defaultContent || '';
											} else if (isPromptField) {
												itemText = '';
											} else {
												itemText = primRaw;
											}
										}
									} else if (typeof primRaw === 'object' && primRaw !== null) {
										const pRec = primRaw as Record<string, unknown>;
										if (isBrowserField) {
											itemText = String(pRec.content ?? matchingField?.defaultContent ?? '');
										} else if (isPromptField) {
											itemText = String(pRec.output ?? '');
										} else {
											itemText = String(pRec.output ?? pRec.content ?? pRec.result ?? '');
										}
									}
								} else if (isBrowserField && matchingField?.defaultContent) {
									itemText = matchingField.defaultContent;
								}
							}

							let itemViewportHtml = '';
							if (!itemText) {
								const notReadyHint = isBrowserField
									? 'Web content not fetched yet. Click "Fetch (Silent)" in the Browser card above to extract content.'
									: (isPromptField
										? 'No AI output generated yet. Run Model or Agent in the Prompt card above or run workflow.'
										: 'No output data recorded yet.');
								itemViewportHtml = `<div style="opacity: 0.45; font-style: italic; font-size: 11px; padding: 4px 0;">${notReadyHint}</div>`;
							} else if (itemFormat === 'table') {
								itemViewportHtml = this._renderResultTableHtml(itemText);
							} else if (itemFormat === 'markdown') {
								itemViewportHtml = this._markdownToHtml(itemText);
							} else if (itemFormat === 'json') {
								itemViewportHtml = this._renderResultJsonHtml(itemText);
							} else {
								itemViewportHtml = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${this._escapeHtml(itemText)}</pre>`;
							}

							itemsHtml += `
								<div class="output-spec-item" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-spec-key="${this._escapeHtmlAttr(spec.fieldKey)}" style="display: flex; flex-direction: column; gap: 6px;">
									<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
										<div style="display: flex; align-items: center; gap: 6px;">
											<span style="font-weight: 600; font-size: 12px; color: #a5b4fc;">${this._escapeHtml(spec.label)}</span>
										</div>
										<div style="display: flex; align-items: center; gap: 6px;">
											<span style="font-size: 10.5px; opacity: 0.65;">Format:</span>
											<select class="output-item-format-selector" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-spec-key="${this._escapeHtmlAttr(spec.fieldKey)}" style="padding: 2px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer;">
												<option value="text" ${itemFormat === 'text' ? 'selected' : ''}>Text</option>
												<option value="markdown" ${itemFormat === 'markdown' ? 'selected' : ''}>Markdown</option>
												<option value="table" ${itemFormat === 'table' ? 'selected' : ''}>Table</option>
												<option value="json" ${itemFormat === 'json' ? 'selected' : ''}>JSON</option>
											</select>
											<button type="button" class="output-item-copy-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-spec-key="${this._escapeHtmlAttr(spec.fieldKey)}" title="Copy output content" style="background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: inherit;">Copy</button>
										</div>
									</div>
									<textarea class="output-item-raw-content" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-spec-key="${this._escapeHtmlAttr(spec.fieldKey)}" style="display: none;">${this._escapeHtml(itemText)}</textarea>
									<div class="output-item-viewport desc-content-box" data-spec-key="${this._escapeHtmlAttr(spec.fieldKey)}" style="min-height: 80px; max-height: 300px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">
										${itemViewportHtml}
									</div>
								</div>
							`;
						}
					} else {
						let initialViewportHtml = '';
						if (singleResultFormat === 'table') {
							initialViewportHtml = this._renderResultTableHtml(singleResultText);
						} else if (singleResultFormat === 'markdown') {
							initialViewportHtml = singleResultText ? this._markdownToHtml(singleResultText) : '<span style="opacity: 0.4; font-style: italic;">No markdown content to display.</span>';
						} else if (singleResultFormat === 'json') {
							initialViewportHtml = this._renderResultJsonHtml(singleResultText);
						} else {
							initialViewportHtml = `<pre style="white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; color: inherit; margin: 0;">${singleResultText ? this._escapeHtml(singleResultText) : '<span style="opacity: 0.4; font-style: italic;">No text content.</span>'}</pre>`;
						}

						itemsHtml = `
							<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
								<div style="display: flex; align-items: center; gap: 4px; font-size: 11px;">
									<span style="opacity: 0.65; font-weight: 500;">Format:</span>
									<select class="result-format-selector" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="padding: 2px 6px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: inherit; cursor: pointer;">
										<option value="text" ${singleResultFormat === 'text' ? 'selected' : ''}>Text</option>
										<option value="markdown" ${singleResultFormat === 'markdown' ? 'selected' : ''}>Markdown</option>
										<option value="table" ${singleResultFormat === 'table' ? 'selected' : ''}>Table</option>
										<option value="json" ${singleResultFormat === 'json' ? 'selected' : ''}>JSON</option>
									</select>
								</div>
								<div style="display: flex; align-items: center; gap: 6px;">
									<button type="button" class="result-copy-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Copy Result Text to Clipboard" style="background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: inherit;">Copy</button>
									<button type="button" class="result-sync-prompt-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Sync latest output from AI Prompt" style="background: rgba(129, 140, 248, 0.12); border: 1px solid rgba(129, 140, 248, 0.3); color: #818cf8; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">Sync</button>
								</div>
							</div>
							<textarea class="result-raw-content" data-field-key="${this._escapeHtmlAttr(rawKey)}" style="display: none;">${this._escapeHtml(singleResultText)}</textarea>
							<div class="result-viewport-container desc-content-box" style="max-height: 240px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">
								${initialViewportHtml}
							</div>
						`;
					}

					customFieldsHtml += `
						<div class="section-card custom-property-card output-primitive-card result-primitive-card custom-primitive-card" data-field-key="${this._escapeHtmlAttr(rawKey)}" data-field-id="${this._escapeHtmlAttr(fieldItem.id || '')}" data-field-type="output">
							<!-- Card Header -->
							<div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${this._escapeHtml(k)}</span>
									<span style="font-size: 0.72em; padding: 2px 7px; border-radius: 4px; background: rgba(129, 140, 248, 0.18); color: #818cf8; font-weight: 700; text-transform: uppercase;">OUTPUT</span>
								</div>
								<div style="display: flex; align-items: center; gap: 6px;">
									<button type="button" class="output-sync-all-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Sync outputs from ticket primitives" style="background: rgba(129, 140, 248, 0.12); border: 1px solid rgba(129, 140, 248, 0.3); color: #818cf8; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;">Sync Outputs</button>
									<button type="button" class="output-copy-all-btn" data-field-key="${this._escapeHtmlAttr(rawKey)}" title="Copy all output data as JSON" style="background: transparent; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; color: inherit;">Copy All</button>
								</div>
							</div>

							<!-- Body Items Container -->
							<div class="output-items-container" style="display: flex; flex-direction: column; gap: 12px;">
								${itemsHtml}
							</div>
						</div>
					`;
				} else {
					// Textarea or Single-line Text
					const isMultiline = fType === 'textarea' || (typeof v === 'string' && (v.length > 80 || v.includes('\n') || ['experience', 'description', 'detail', 'content', 'notes', 'summary', 'project', 'background'].some(sub => k.toLowerCase().includes(sub))));
					customFieldsHtml += `
						<div class="section-card custom-property-card">
							<div class="section-title">
								<div style="display: flex; align-items: center; gap: 8px;">
									<span>${k}</span>
									${isMultiline ? '<span style="font-size: 0.72em; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); color: #ccc; font-weight: 700; text-transform: uppercase;">Textarea</span>' : ''}
								</div>
								<button type="button" class="ai-edit-btn" data-ai-field="/Custom/${rawKey}" data-ai-field-type="${isMultiline ? 'textarea' : 'text'}" data-ai-field-label="${k}" data-ai-current-value="${this._escapeHtmlAttr(String(v || ''))}" title="Edit ${k} with AI">
									<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
								</button>
							</div>
							<div class="custom-field-view desc-content-box">
								${v ? this._markdownToHtml(String(v)) : '<span style="opacity: 0.45; font-style: italic;">No content provided.</span>'}
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
					gap: 6px;
					font-size: 0.85em;
					opacity: 0.75;
					margin-bottom: 6px;
					font-weight: 500;
					text-align: left;
					flex-wrap: wrap;
				}
				.entity-detail-editor .header-breadcrumb .breadcrumb-item[data-uri]:hover {
					opacity: 1;
					color: #38bdf8;
					text-decoration: underline;
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
			<div style="width: 100%; margin: 0 0 20px 0; text-align: left; display: flex; justify-content: space-between; align-items: flex-start;">
				<div style="flex: 1; min-width: 0;">
					<div class="header-breadcrumb">
						${(data.breadcrumbSegments && data.breadcrumbSegments.length > 0)
							? data.breadcrumbSegments.map((s, idx) => `
								<span class="breadcrumb-item" data-uri="${this._escapeHtmlAttr(s.uri || '')}" style="${s.uri ? 'cursor: pointer;' : ''}" title="${s.uri ? 'Click to navigate to ' + this._escapeHtmlAttr(s.label) : ''}">${this._escapeHtml(s.label)}</span>
								${idx < data.breadcrumbSegments!.length - 1 ? '<span class="breadcrumb-sep" style="opacity: 0.35; margin: 0 4px;">/</span>' : ''}
							`).join('')
							: `<span>${this._escapeHtml(data.workspaceId || 'Workspace')}</span><span class="breadcrumb-sep" style="opacity: 0.35; margin: 0 4px;">/</span><span>${this._escapeHtml(data.ticketId)}</span>`
						}
						<span style="font-size: 8.5px; padding: 1px 5px; border-radius: 3px; background: ${colorSetting.bg}; color: ${colorSetting.text}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; display: inline-block; margin-left: 6px;">${typeUpper}</span>
					</div>
					<div class="header-title-row">
						<h1 class="ticket-title" id="title-heading">${data.title}</h1>
						<button type="button" class="ai-edit-btn" data-ai-field="/Title" data-ai-field-type="text" data-ai-field-label="Title" data-ai-current-value="${this._escapeHtmlAttr(data.title)}" title="Edit Title with AI">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
						</button>
					</div>
				</div>
				<div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
					<button type="button" id="entity-detail-refresh-btn" class="btn-secondary" style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; font-size: 0.84em; border-radius: 6px; cursor: pointer;" title="Refresh Ticket (Reload latest data from disk)">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;"><path d="M13.65 2.35A7.958 7.958 0 0 0 8 0a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H16V0l-2.35 2.35z"/></svg>
						<span>Refresh</span>
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
								<button type="button" class="ai-edit-btn" data-ai-field="${isAgent ? '/Instructions/System Prompt' : '/Instructions'}" data-ai-field-type="${isAgent ? 'textarea' : 'container'}" data-ai-field-label="${isAgent ? 'System Prompt' : 'Instructions'}" data-ai-current-value="${this._escapeHtmlAttr(agentSystemPrompt || data.ticketPrompt || '')}" title="Edit with AI">
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
						</div>
					</div>

					<!-- Custom Properties -->
					${customFieldsHtml}

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
					<div class="sidebar-row" style="position: relative;">
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<div style="display: flex; align-items: center; gap: 6px;">
								<span class="sidebar-label">STATUS</span>
								<button type="button" id="status-lifecycle-info-btn" class="status-lifecycle-info-btn" title="View Workspace Status Lifecycle & Mapping" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; border-radius: 50%; padding: 0; transition: all 0.15s ease;" onmouseenter="this.style.color='var(--vscode-foreground)'; this.style.borderColor='rgba(56, 189, 248, 0.6)'; this.style.background='rgba(56, 189, 248, 0.1)';" onmouseleave="this.style.color='var(--vscode-descriptionForeground)'; this.style.borderColor='rgba(255, 255, 255, 0.15)'; this.style.background='rgba(255, 255, 255, 0.06)';">
									<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none; display: block;">
										<circle cx="8" cy="8" r="6.75"></circle>
										<line x1="8" y1="7.2" x2="8" y2="11.5"></line>
										<circle cx="8" cy="4.75" r="0.75" fill="currentColor" stroke="none"></circle>
									</svg>
								</button>
							</div>
							<button type="button" class="ai-edit-btn" data-ai-field="/Attributes/Status" data-ai-field-type="status" data-ai-field-label="Status" data-ai-current-value="${this._escapeHtmlAttr(status)}" data-ai-options="${this._escapeHtmlAttr(JSON.stringify(isAgent ? ['idle', 'busy', 'offline'] : (customModule?.statuses && customModule.statuses.length > 0 ? customModule.statuses.map(s => s.label || s.id) : this._workspaceStatuses.statuses)))}" title="Edit Status with AI">
								<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 0.5L9.2 5.5L14.2 7.2L9.2 8.9L7.5 13.9L5.8 8.9L0.8 7.2L5.8 5.5L7.5 0.5Z"/></svg>
							</button>
						</div>
						<div style="padding: 2px 0;">
							<span id="status-view-val" style="display: inline-block; font-size: 0.88em; font-weight: 700; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder}; padding: 3px 10px; border-radius: 5px; text-transform: uppercase;">${status}</span>
						</div>

						<!-- Status Lifecycle & Mapping Popover -->
						<div id="status-lifecycle-popover" class="status-lifecycle-popover" style="display: none; position: absolute; top: calc(100% + 6px); right: 0; width: 330px; background: var(--vscode-editorWidget-background, #1e1e1e); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 10px; box-shadow: 0 16px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06); z-index: 1000; padding: 14px; box-sizing: border-box; flex-direction: column; gap: 10px;">
							<!-- Header -->
							<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px;">
								<div style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--vscode-editor-foreground);">
									<span style="color: #38bdf8; display: inline-flex; align-items: center;">
										<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
											<circle cx="8" cy="8" r="6.75"></circle>
											<line x1="8" y1="7.2" x2="8" y2="11.5"></line>
											<circle cx="8" cy="4.75" r="0.75" fill="currentColor" stroke="none"></circle>
										</svg>
									</span>
									<span>Status Lifecycle & Mapping</span>
								</div>
								<button type="button" id="close-status-lifecycle-popover-btn" style="background: transparent; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 14px; padding: 0 4px; border-radius: 4px; line-height: 1;" title="Close">✕</button>
							</div>

							<!-- Current Status Indicator -->
							<div style="font-size: 11px; display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); padding: 5px 8px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.06);">
								<span style="opacity: 0.7;">Current Status:</span>
								<span style="font-weight: 700; color: ${statusColor}; text-transform: uppercase;">${status}</span>
							</div>

							<!-- 5 Categories -->
							<div style="display: flex; flex-direction: column; gap: 6px;">
								${(() => {
									let mappingObj: { [key: string]: string } = {};
									let hasCustomMapping = false;
									if (customModule?.statuses && Array.isArray(customModule.statuses) && customModule.statuses.length > 0) {
										for (const stDef of customModule.statuses) {
											const stName = stDef.label || stDef.id;
											mappingObj[stName] = stDef.category || 'Todo';
										}
										hasCustomMapping = true;
									} else if (this._workspaceStatuses?.mapping && Object.keys(this._workspaceStatuses.mapping).length > 0) {
										mappingObj = { ...this._workspaceStatuses.mapping };
										hasCustomMapping = true;
									} else if (data.customMetadata?.['Status Mapping']) {
										try {
											mappingObj = JSON.parse(data.customMetadata['Status Mapping']);
											hasCustomMapping = true;
										} catch {}
									}
									if (Object.keys(mappingObj).length === 0) {
										mappingObj = {
											'Todo': 'Todo',
											'In Progress': 'In Progress',
											'Done': 'Done',
											'Blocked': 'Blocked',
											'Removed': 'Removed'
										};
										hasCustomMapping = false;
									}

									const categoriesDef = [
										{ id: 'Todo', label: 'Todo', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.15)', desc: 'Initial backlog / pending' },
										{ id: 'In Progress', label: 'In Progress', color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.15)', desc: 'Active development' },
										{ id: 'Done', label: 'Done', color: '#34d399', bg: 'rgba(52, 211, 153, 0.15)', desc: 'Completed & delivered' },
										{ id: 'Blocked', label: 'Blocked', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.15)', desc: 'Waiting / on hold' },
										{ id: 'Removed', label: 'Removed', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.15)', desc: 'Archived / purged' }
									];

									const categoryGroupMap: { [cat: string]: string[] } = {
										'Todo': [],
										'In Progress': [],
										'Done': [],
										'Blocked': [],
										'Removed': []
									};
									for (const [st, cat] of Object.entries(mappingObj)) {
										if (categoryGroupMap[cat]) {
											if (!categoryGroupMap[cat].includes(st)) {
												categoryGroupMap[cat].push(st);
											}
										} else {
											categoryGroupMap['Todo'].push(st);
										}
									}

									let htmlRows = '';
									for (const cat of categoriesDef) {
										const mappedList = categoryGroupMap[cat.id] || [];
										let chipsHtml = '';
										if (mappedList.length === 0) {
											chipsHtml = `<span style="font-size: 10.5px; opacity: 0.45; font-style: italic;">None mapped</span>`;
										} else {
											for (const st of mappedList) {
												const isCur = st.toLowerCase() === (status || '').toLowerCase();
												chipsHtml += `
													<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: ${isCur ? '700' : '500'}; background: ${isCur ? `${cat.color}25` : 'rgba(255,255,255,0.04)'}; color: ${isCur ? cat.color : 'inherit'}; border: ${isCur ? `1px solid ${cat.color}80` : '1px solid rgba(255,255,255,0.1)'};">
														${this._escapeHtmlAttr(st)}
														${isCur ? `<span style="font-size: 8.5px; background: ${cat.color}; color: #000; padding: 0 3px; border-radius: 2px; font-weight: 800;">CURRENT</span>` : ''}
													</span>
												`;
											}
										}

										htmlRows += `
											<div style="display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px;">
												<div style="width: 80px; flex-shrink: 0;">
													<span style="display: inline-block; font-size: 10.5px; font-weight: 700; color: ${cat.color}; background: ${cat.bg}; border: 1px solid ${cat.color}40; padding: 1px 6px; border-radius: 3px;">${cat.label}</span>
												</div>
												<div style="flex: 1; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">
													${chipsHtml}
												</div>
											</div>
										`;
									}

									const noticeHtml = hasCustomMapping ? `
										<div style="font-size: 10.5px; color: #34d399; background: rgba(52, 211, 153, 0.08); border: 1px solid rgba(52, 211, 153, 0.2); padding: 5px 8px; border-radius: 5px; line-height: 1.3;">
											✓ Configured with workspace custom status mapping (${Object.keys(mappingObj).length} entries).
										</div>
									` : `
										<div style="font-size: 10.5px; color: var(--vscode-descriptionForeground); background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); padding: 5px 8px; border-radius: 5px; line-height: 1.3;">
											ℹ️ No custom mapping configured (using default 1:1 lifecycle mapping for standard stages).
										</div>
									`;

									return htmlRows + noticeHtml;
								})()}
							</div>
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

					<div class="sidebar-row" style="${(data.gitRemoteUrl || data.gitBranch || this._entityType === 'workspace' || (customModule && Array.isArray(customModule.fields) && customModule.fields.some(f => f.type === 'git'))) ? '' : 'border-bottom: none; margin-bottom: 0;'}">
						<span class="sidebar-label">LAST UPDATED AT</span>
						<span class="sidebar-value" style="font-size: 0.85em; opacity: 0.85;">${data.lastUpdatedAt}</span>
					</div>

					<!-- Git Configuration (Repository & Branch) -->
					${(data.gitRemoteUrl || data.gitBranch || this._entityType === 'workspace' || (customModule && Array.isArray(customModule.fields) && customModule.fields.some(f => f.type === 'git'))) ? `
						<div class="sidebar-row" style="margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);">
							<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
								<span class="sidebar-label" style="display: flex; align-items: center; gap: 5px;">
									<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color: #38bdf8;"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25zm6.56 0a.75.75 0 0 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06l-4.25-4.25z"/></svg>
									GIT REPOSITORY
								</span>
								${data.gitRemoteUrl ? `
									<button type="button" class="copy-git-url-btn" data-git-url="${this._escapeHtmlAttr(data.gitRemoteUrl)}" title="Copy Git URL to clipboard" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); cursor: pointer; color: var(--vscode-descriptionForeground); display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 4px; font-size: 10.5px; transition: all 0.15s ease;" onmouseenter="this.style.color='var(--vscode-foreground)'" onmouseleave="this.style.color='var(--vscode-descriptionForeground)'">
										<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4 4h5v2H4V4zm0 3h5v1H4V7zm0 2h3v1H4V9zm7.5-6H11V2H4v1H2.5A1.5 1.5 0 0 0 1 4.5v9A1.5 1.5 0 0 0 2.5 15h9a1.5 1.5 0 0 0 1.5-1.5V11h1a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-2.5zM12 4.5V10h-1V4.5a.5.5 0 0 1 .5-.5h.5zm-9.5 0a.5.5 0 0 1 .5-.5H10a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H2.5a.5.5 0 0 1-.5-.5v-9zm12-.5h-.5v6h.5V4z"/></svg>
										<span>Copy</span>
									</button>
								` : ''}
							</div>
							<div class="git-url-box" title="${this._escapeHtmlAttr(data.gitRemoteUrl || 'Inherited')}" style="background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; padding: 5px 8px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-editor-foreground); display: flex; align-items: center; overflow: hidden;">
								<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${data.gitRemoteUrl || '<span style="opacity:0.4; font-style:italic;">None</span>'}</span>
							</div>
						</div>

						<div class="sidebar-row" style="border-bottom: none; margin-bottom: 0;">
							<span class="sidebar-label" style="display: flex; align-items: center; gap: 5px;">
								<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color: #a78bfa;"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.75 2a2.25 2.25 0 1 0-1.77 3.635A4.75 4.75 0 0 0 5.5 10.158V6.635a2.25 2.25 0 1 0-1.5 0v5.73a2.25 2.25 0 1 0 1.5 0V11.5a3.25 3.25 0 0 1 3.25-3.25h1.23a2.25 2.25 0 1 0 1.77-6.25zM4.75 3.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm0 10a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm7-10a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm0 6a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z"/></svg>
								GIT BRANCH
							</span>
							<div style="display: flex; align-items: center; gap: 6px; padding: 2px 0;">
								<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; font-family: monospace; background: rgba(167, 139, 250, 0.15); color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.35); padding: 2px 8px; border-radius: 4px;">
									${data.gitBranch || 'main'}
								</span>
							</div>
						</div>
					` : ''}
				</div>
			</div>
		`;
	}
}
