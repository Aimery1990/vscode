/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/centeredChat.css';
import { $, append, addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IAgentCredentialService, IAgentCredential } from '../../../../workbench/contrib/agentsManager/common/agentsManager.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AccountManagementDialog } from '../../../../workbench/contrib/accountManagement/browser/accountManagementDialog.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { listenStream } from '../../../../base/common/stream.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILanguageModelToolsService } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IVoiceModelService } from '../../../../workbench/contrib/voiceModels/common/voiceModel.js';
import { IWorkspacesExplorerService } from '../../../../workbench/contrib/workspacesExplorer/common/workspacesExplorer.js';
import { TicketDataEngine } from '../../../../workbench/contrib/workspacesExplorer/browser/tools/ticketDataEngine.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

interface IAttachment {
	name: string;
	content: string;
	size: number;
	url?: string;
	isAudio?: boolean;
	duration?: number;
}

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

function getTypeColorInfo(typeStr: string | undefined): { text: string; bg: string; border: string } {
	const typeLower = (typeStr || 'task').toLowerCase().trim();
	const typeColors: { [key: string]: { text: string; bg: string; border: string } } = {
		workspace: { text: '#38bdf8', bg: 'rgba(56, 189, 248, 0.14)', border: 'rgba(56, 189, 248, 0.3)' },
		job: { text: '#fbbf24', bg: 'rgba(251, 191, 36, 0.14)', border: 'rgba(251, 191, 36, 0.3)' },
		task: { text: '#a78bfa', bg: 'rgba(167, 139, 250, 0.14)', border: 'rgba(167, 139, 250, 0.3)' },
		project: { text: '#60a5fa', bg: 'rgba(96, 165, 250, 0.14)', border: 'rgba(96, 165, 250, 0.3)' },
		workflow: { text: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.14)', border: 'rgba(45, 212, 191, 0.3)' },
		agent: { text: '#f472b6', bg: 'rgba(244, 114, 182, 0.14)', border: 'rgba(244, 114, 182, 0.3)' },
		case: { text: '#a3e635', bg: 'rgba(163, 230, 53, 0.14)', border: 'rgba(163, 230, 53, 0.3)' },
		issue: { text: '#f87171', bg: 'rgba(248, 113, 113, 0.14)', border: 'rgba(248, 113, 113, 0.3)' },
		analysis: { text: '#34d399', bg: 'rgba(52, 211, 153, 0.14)', border: 'rgba(52, 211, 153, 0.3)' },
		note: { text: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.14)', border: 'rgba(45, 212, 191, 0.3)' },
		resume: { text: '#34d399', bg: 'rgba(52, 211, 153, 0.14)', border: 'rgba(52, 211, 153, 0.3)' }
	};

	if (typeColors[typeLower]) {
		return typeColors[typeLower];
	}

	const baseColor = getColorForName(typeLower);
	return {
		text: baseColor,
		bg: hexToRgba(baseColor, 0.14),
		border: hexToRgba(baseColor, 0.3)
	};
}

const STORAGE_KEY_CREDENTIAL_ID = 'anyagent.centeredChat.activeCredentialId';
const STORAGE_KEY_MODEL_ID = 'anyagent.centeredChat.activeModelId';
const STORAGE_KEY_SESSIONS = 'anyagent.centeredChat.sessions.v1';
const STORAGE_KEY_ACTIVE_SESSION = 'anyagent.centeredChat.activeSessionId.v1';

export interface IChatMessageRecord {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	modelBadge?: string;
	locatorTag?: string;
}

export interface IChatSessionRecord {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	workspaceId?: string;
	ticketId?: string;
	messages: IChatMessageRecord[];
}

export interface IContextLocator {
	workspaceId?: string;
	ticketId?: string;
	field?: string;
	label?: string;
	fieldType?: string;
	currentValue?: string;
	options?: any[];
	interactiveModifiedValue?: string;
	hierarchyTree?: any[];
	entityUri?: string;
}

export class CenteredChatWidget extends Disposable {

	private element: HTMLElement | undefined;
	private messagesContainer: HTMLElement | undefined;
	private inputField: HTMLTextAreaElement | undefined;
	private attachmentsContainer: HTMLElement | undefined;
	private micBtn: HTMLElement | undefined;
	private recordingIndicator: HTMLElement | undefined;
	private recordingTimeSpan: HTMLElement | undefined;
	private sendBtn: HTMLButtonElement | undefined;

	// Track last active editable input element and cursor position for STT dictation
	private lastActiveEditableElement: HTMLInputElement | HTMLTextAreaElement | null = null;
	private lastSelectionStart: number = 0;
	private lastSelectionEnd: number = 0;

	private recordLastActiveEditable(el: HTMLInputElement | HTMLTextAreaElement): void {
		this.lastActiveEditableElement = el;
		this.lastSelectionStart = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
		this.lastSelectionEnd = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
	}

	// Session Management
	private sessions: IChatSessionRecord[] = [];
	private currentSessionId: string = '';
	private historyDropdown: HTMLElement | undefined;
	private isHistoryOpen = false;

	// Scoped Disposables to prevent any memory leaks
	private readonly viewDisposables = this._register(new DisposableStore());
	private readonly modelListDisposables = this._register(new DisposableStore());
	private readonly attachmentDisposables = this._register(new DisposableStore());
	private readonly messageDisposables = this._register(new DisposableStore());
	private readonly historyDisposables = this._register(new DisposableStore());

	// Provider & Searchable Model Picker UI elements
	private providerSelect: HTMLSelectElement | undefined;
	private modelPickerBtn: HTMLElement | undefined;
	private modelPickerLabel: HTMLElement | undefined;
	private modelDropdown: HTMLElement | undefined;
	private modelSearchInput: HTMLInputElement | undefined;
	private modelListContainer: HTMLElement | undefined;

	private isModelDropdownOpen = false;

	// Active selection state
	private availableCredentials: IAgentCredential[] = [];
	private activeCredentialId: string = '';
	private activeModelId: string = '';

	// Context Target Locator (Breadcrumb tag + Interactive Modifier above chat input)
	private activeContextLocator: IContextLocator | null = null;
	private contextLocatorContainer: HTMLElement | undefined;

	// Active Streaming state
	private isStreaming = false;
	private activeCts: CancellationTokenSource | null = null;
	private readonly requestService: IRequestService;

	private activeAttachments: IAttachment[] = [];
	private isDragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private elementStartX = 0;
	private elementStartY = 0;

	// Media recording fields
	private mediaRecorder: any = undefined;
	private audioChunks: Blob[] = [];
	private recordingTimer: any = undefined;
	private recordingSeconds = 0;
	private isRecording = false;
	private isTranscribing = false;

	// Keep track of the last position and size in memory so it doesn't reset on toggle
	private static lastPosition: { top: number; left: number } | undefined = undefined;
	private static lastSize: { width: number; height: number } | undefined = undefined;

	private isZenMode = false;
	private readonly ticketDataEngine: TicketDataEngine;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentCredentialService private readonly agentCredentialService: IAgentCredentialService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@ILanguageModelToolsService private readonly languageModelToolsService: ILanguageModelToolsService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVoiceModelService private readonly voiceModelService: IVoiceModelService,
		@IWorkspacesExplorerService private readonly workspacesExplorerService: IWorkspacesExplorerService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService
	) {
		super();
		this.ticketDataEngine = this.instantiationService.createInstance(TicketDataEngine);

		// Use RequestChannelClient to route all network requests via Electron main process (bypasses browser CORS completely!)
		this.requestService = new RequestChannelClient(this.mainProcessService.getChannel('request'));

		// Listen to credential changes to update provider/model options dynamically
		this._register(this.agentCredentialService.onDidChangeCredentials(() => {
			this.loadCredentialsAndModels();
		}));

		// Load saved active selection
		this.activeCredentialId = this.storageService.get(STORAGE_KEY_CREDENTIAL_ID, StorageScope.PROFILE, '');
		this.activeModelId = this.storageService.get(STORAGE_KEY_MODEL_ID, StorageScope.PROFILE, '');
	}

	private activeBreadcrumbDropdown: HTMLElement | undefined;

	private _findNodeByPath(nodes: any[] | undefined, targetPath: string): any {
		if (!nodes || !targetPath) return undefined;
		for (const node of nodes) {
			if (node.path === targetPath) {
				return node;
			}
			if (node.children && node.children.length > 0) {
				const found = this._findNodeByPath(node.children, targetPath);
				if (found) return found;
			}
		}
		return undefined;
	}

	private _getAncestors(nodes: any[] | undefined, targetPath: string, currentTrail: any[] = []): any[] | undefined {
		if (!nodes || !targetPath) return undefined;
		for (const node of nodes) {
			const trail = [...currentTrail, node];
			if (node.path === targetPath) {
				return trail;
			}
			if (node.children && node.children.length > 0) {
				const found = this._getAncestors(node.children, targetPath, trail);
				if (found) return found;
			}
		}
		return undefined;
	}

	public drillDownTo(targetPath: string): void {
		if (!this.activeContextLocator) return;
		const tree = this.activeContextLocator.hierarchyTree;
		const node = this._findNodeByPath(tree, targetPath);
		if (node) {
			this.activeContextLocator.field = node.path;
			this.activeContextLocator.label = node.label;
			this.activeContextLocator.fieldType = node.fieldType;
			this.activeContextLocator.currentValue = node.currentValue || '';
			this.activeContextLocator.options = node.options;
			this.activeContextLocator.interactiveModifiedValue = node.currentValue || '';
		} else {
			this.activeContextLocator.field = targetPath;
		}
		this.setContextLocator(this.activeContextLocator);
	}

	private toggleBreadcrumbDropdown(ancNode: any, anchorEl: HTMLElement): void {
		if (this.activeBreadcrumbDropdown) {
			try {
				this.activeBreadcrumbDropdown.remove();
			} catch { }
			this.activeBreadcrumbDropdown = undefined;
			return;
		}

		if (!ancNode || !ancNode.children || ancNode.children.length === 0) return;

		const menu = append(document.body, $('.context-breadcrumb-dropdown'));
		menu.style.position = 'fixed';
		menu.style.zIndex = '100002';
		menu.style.background = '#1e1e1e';
		menu.style.border = '1px solid rgba(255, 255, 255, 0.15)';
		menu.style.borderRadius = '5px';
		menu.style.padding = '4px';
		menu.style.minWidth = '170px';
		menu.style.boxShadow = '0 6px 16px rgba(0,0,0,0.5)';
		menu.style.display = 'flex';
		menu.style.flexDirection = 'column';
		menu.style.gap = '2px';

		const rect = anchorEl.getBoundingClientRect();
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;

		ancNode.children.forEach((child: any) => {
			const item = append(menu, $('.dropdown-item'));
			item.style.padding = '5px 8px';
			item.style.borderRadius = '3px';
			item.style.fontSize = '11px';
			item.style.color = '#ccc';
			item.style.cursor = 'pointer';
			item.style.display = 'flex';
			item.style.justifyContent = 'space-between';
			item.style.alignItems = 'center';
			item.style.gap = '8px';

			const labelSpan = append(item, $('span'));
			labelSpan.textContent = child.label;

			if (child.currentValue !== undefined && child.currentValue !== '') {
				const valStr = String(child.currentValue).trim();
				const isNoneOrUnassigned = valStr === 'None' || valStr === 'Unassigned' || valStr === 'none' || valStr === 'null' || valStr === 'undefined';

				const valSpan = append(item, $('span'));
				valSpan.style.fontSize = '9.5px';
				valSpan.style.maxWidth = '100px';
				valSpan.style.overflow = 'hidden';
				valSpan.style.textOverflow = 'ellipsis';
				valSpan.style.whiteSpace = 'nowrap';
				valSpan.textContent = valStr;

				if (isNoneOrUnassigned) {
					valSpan.style.opacity = '0.35';
					valSpan.style.fontStyle = 'italic';
				} else {
					valSpan.style.color = '#38bdf8';
					valSpan.style.opacity = '0.9';
				}
			} else if (child.children && child.children.length > 0) {
				append(item, $('span.codicon.codicon-chevron-right', { style: 'font-size: 10px; opacity: 0.5;' }));
			}

			item.onmouseenter = () => {
				item.style.background = 'rgba(255,255,255,0.08)';
				item.style.color = '#fff';
			};
			item.onmouseleave = () => {
				item.style.background = 'transparent';
				item.style.color = '#ccc';
			};

			item.onclick = (e) => {
				e.stopPropagation();
				try {
					menu.remove();
				} catch { }
				this.activeBreadcrumbDropdown = undefined;
				this.drillDownTo(child.path);
			};
		});

		const closeListener = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && e.target !== anchorEl) {
				try {
					menu.remove();
				} catch { }
				this.activeBreadcrumbDropdown = undefined;
				document.removeEventListener('click', closeListener);
			}
		};
		setTimeout(() => {
			document.addEventListener('click', closeListener);
		}, 10);
		this.activeBreadcrumbDropdown = menu;
	}

	public setContextLocator(locator: IContextLocator | null): void {
		this.activeContextLocator = locator;
		if (!this.contextLocatorContainer) {
			return;
		}

		if (!locator || (!locator.workspaceId && !locator.ticketId && !locator.field)) {
			this.contextLocatorContainer.style.display = 'none';
			this.contextLocatorContainer.textContent = '';
			return;
		}

		this.contextLocatorContainer.style.display = 'flex';
		this.contextLocatorContainer.style.flexDirection = 'column';
		this.contextLocatorContainer.style.gap = '6px';
		this.contextLocatorContainer.textContent = '';

		// 1. Breadcrumb Top Row
		const topRow = append(this.contextLocatorContainer, $('.context-locator-top-row'));
		topRow.style.display = 'flex';
		topRow.style.alignItems = 'center';
		topRow.style.justifyContent = 'space-between';
		topRow.style.width = '100%';

		const chipsRow = append(topRow, $('.centered-chat-context-chips'));
		chipsRow.style.display = 'flex';
		chipsRow.style.alignItems = 'center';
		chipsRow.style.gap = '5px';
		chipsRow.style.flex = '1';
		chipsRow.style.overflow = 'hidden';
		chipsRow.style.flexWrap = 'wrap';

		if (locator.workspaceId) {
			const wsChip = append(chipsRow, $('.context-chip'));
			wsChip.style.display = 'inline-flex';
			wsChip.style.alignItems = 'center';
			wsChip.style.gap = '5px';
			wsChip.style.fontSize = '10.5px';
			wsChip.style.padding = '2px 6px';
			wsChip.style.borderRadius = '4px';
			wsChip.style.background = 'rgba(255,255,255,0.06)';
			wsChip.style.color = '#ccc';
			append(wsChip, $('span.codicon.codicon-folder', { style: 'font-size: 11px; opacity: 0.8;' }));
			append(wsChip, $('span', {}, locator.workspaceId));
		}

		if (locator.ticketId) {
			if (locator.workspaceId) {
				append(chipsRow, $('span', { style: 'font-size: 10px; opacity: 0.4;' }, '›'));
			}
			const tChip = append(chipsRow, $('.context-chip'));
			tChip.style.display = 'inline-flex';
			tChip.style.alignItems = 'center';
			tChip.style.gap = '5px';
			tChip.style.fontSize = '10.5px';
			tChip.style.fontWeight = '600';
			tChip.style.padding = '2px 6px';
			tChip.style.borderRadius = '4px';
			tChip.style.background = 'rgba(56,189,248,0.15)';
			tChip.style.color = '#38bdf8';
			append(tChip, $('span.codicon.codicon-tag', { style: 'font-size: 11px; opacity: 0.9;' }));
			append(tChip, $('span', {}, locator.ticketId));
		}

		// Resolve hierarchy ancestry
		const hierarchyTree = locator.hierarchyTree;
		const activeField = locator.field || '';
		const ancestors = (hierarchyTree && activeField) ? (this._getAncestors(hierarchyTree, activeField) || []) : [];
		const activeNode = (hierarchyTree && activeField) ? this._findNodeByPath(hierarchyTree, activeField) : undefined;

		if (ancestors.length > 0) {
			ancestors.forEach((ancNode, idx) => {
				append(chipsRow, $('span', { style: 'font-size: 10px; opacity: 0.4;' }, '›'));

				const isLeaf = (idx === ancestors.length - 1);
				const chip = append(chipsRow, $('.context-chip'));
				chip.style.display = 'inline-flex';
				chip.style.alignItems = 'center';
				chip.style.gap = '4px';
				chip.style.fontSize = '10.5px';
				chip.style.fontWeight = isLeaf ? '700' : '500';
				chip.style.padding = '2px 6px';
				chip.style.borderRadius = '4px';
				chip.style.background = isLeaf ? 'rgba(167,139,250,0.22)' : 'rgba(167,139,250,0.1)';
				chip.style.color = isLeaf ? '#c4b5fd' : '#a78bfa';
				chip.style.cursor = 'pointer';
				chip.title = isLeaf ? `Current: ${ancNode.path}` : `Drill up to ${ancNode.label || ancNode.path}`;

				if (idx === 0) {
					append(chip, $('span.codicon.codicon-target', { style: 'font-size: 11px; opacity: 0.9;' }));
				}

				append(chip, $('span', {}, ancNode.label || ancNode.path));

				if (!isLeaf) {
					chip.onclick = () => this.drillDownTo(ancNode.path);
				}

				// If node has children, add a dropdown trigger
				if (ancNode.children && ancNode.children.length > 0) {
					const dropBtn = append(chip, $('span.codicon.codicon-chevron-down', {
						style: 'font-size: 9px; opacity: 0.7; margin-left: 2px; cursor: pointer;'
					}));
					dropBtn.title = 'Drill down to sub-items';
					dropBtn.onclick = (e) => {
						e.stopPropagation();
						this.toggleBreadcrumbDropdown(ancNode, chip);
					};
				}
			});
		} else if (locator.field) {
			if (locator.ticketId || locator.workspaceId) {
				append(chipsRow, $('span', { style: 'font-size: 10px; opacity: 0.4;' }, '›'));
			}
			const fChip = append(chipsRow, $('.context-chip'));
			fChip.style.display = 'inline-flex';
			fChip.style.alignItems = 'center';
			fChip.style.gap = '5px';
			fChip.style.fontSize = '10.5px';
			fChip.style.fontWeight = '600';
			fChip.style.padding = '2px 6px';
			fChip.style.borderRadius = '4px';
			fChip.style.background = 'rgba(167,139,250,0.15)';
			fChip.style.color = '#a78bfa';
			fChip.style.fontFamily = 'monospace';
			append(fChip, $('span.codicon.codicon-target', { style: 'font-size: 11px; opacity: 0.9;' }));
			append(fChip, $('span', {}, locator.field));
		}

		const closeBtn = append(topRow, $('.context-chip-close'));
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.opacity = '0.6';
		closeBtn.style.padding = '2px 4px';
		closeBtn.style.fontSize = '11px';
		closeBtn.style.display = 'flex';
		closeBtn.style.alignItems = 'center';
		closeBtn.title = 'Remove target locator';
		append(closeBtn, $('span.codicon.codicon-close'));
		closeBtn.onclick = (e) => {
			e.stopPropagation();
			this.setContextLocator(null);
		};

		// 2. Interactive Area
		if (activeNode && activeNode.children && activeNode.children.length > 0) {
			// Container Exploration Mode (Parent Node selected)
			const containerBox = append(this.contextLocatorContainer, $('.context-interactive-editor-box'));
			containerBox.style.display = 'flex';
			containerBox.style.flexDirection = 'column';
			containerBox.style.gap = '6px';
			containerBox.style.background = 'rgba(0, 0, 0, 0.28)';
			containerBox.style.border = '1px solid rgba(255, 255, 255, 0.08)';
			containerBox.style.borderRadius = '5px';
			containerBox.style.padding = '7px 10px';
			containerBox.style.boxSizing = 'border-box';
			containerBox.style.width = '100%';

			const headRow = append(containerBox, $('div'));
			headRow.style.display = 'flex';
			headRow.style.justifyContent = 'space-between';
			headRow.style.alignItems = 'center';

			const labelEl = append(headRow, $('label'));
			labelEl.style.fontSize = '10px';
			labelEl.style.opacity = '0.8';
			labelEl.style.fontWeight = '700';
			labelEl.style.textTransform = 'uppercase';
			labelEl.style.letterSpacing = '0.04em';
			labelEl.style.color = '#a78bfa';
			labelEl.textContent = `EXPLORE ${activeNode.label || 'PROPERTIES'} (CLICK TO DRILL DOWN):`;

			const firstChildWithChildren = activeNode.children.find((c: any) => c.children && c.children.length > 0);
			if (firstChildWithChildren && firstChildWithChildren.children) {
				const schemaBar = append(containerBox, $('div'));
				schemaBar.style.display = 'flex';
				schemaBar.style.alignItems = 'center';
				schemaBar.style.gap = '5px';
				schemaBar.style.flexWrap = 'wrap';
				schemaBar.style.padding = '3px 8px';
				schemaBar.style.borderRadius = '4px';
				schemaBar.style.background = 'rgba(167, 139, 250, 0.08)';
				schemaBar.style.border = '1px solid rgba(167, 139, 250, 0.18)';
				schemaBar.style.marginTop = '2px';

				append(schemaBar, $('span', { style: 'font-size: 9px; font-weight: 700; color: #a78bfa; text-transform: uppercase;' }, 'UNDERLYING SCHEMA:'));
				firstChildWithChildren.children.forEach((sf: any) => {
					append(schemaBar, $('span', {
						style: 'font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); color: #e2e8f0; font-family: monospace;'
					}, `${sf.label}${sf.fieldType ? ` (${sf.fieldType})` : ''}`));
				});
			}

			const grid = append(containerBox, $('div'));
			grid.style.display = 'flex';
			grid.style.flexWrap = 'wrap';
			grid.style.gap = '6px';
			grid.style.marginTop = '2px';

			activeNode.children.forEach((child: any) => {
				const card = append(grid, $('.sub-property-pill'));
				card.style.display = 'inline-flex';
				card.style.alignItems = 'center';
				card.style.gap = '6px';
				card.style.padding = '4px 8px';
				card.style.borderRadius = '4px';
				card.style.background = 'rgba(255, 255, 255, 0.05)';
				card.style.border = '1px solid rgba(255, 255, 255, 0.09)';
				card.style.cursor = 'pointer';
				card.style.transition = 'all 0.15s ease';

				const nameSpan = append(card, $('span'));
				nameSpan.style.fontSize = '10.5px';
				nameSpan.style.fontWeight = '600';
				nameSpan.style.color = 'var(--vscode-editor-foreground)';
				nameSpan.textContent = child.label;

				if (child.currentValue !== undefined && child.currentValue !== '') {
					const valStr = String(child.currentValue).trim();
					const isNoneOrUnassigned = valStr === 'None' || valStr === 'Unassigned' || valStr === 'none' || valStr === 'null' || valStr === 'undefined';

					const valBadge = append(card, $('span'));
					valBadge.style.fontSize = '9.5px';
					valBadge.style.padding = '1px 5px';
					valBadge.style.borderRadius = '3px';
					valBadge.style.maxWidth = '120px';
					valBadge.style.overflow = 'hidden';
					valBadge.style.textOverflow = 'ellipsis';
					valBadge.style.whiteSpace = 'nowrap';
					valBadge.textContent = valStr;

					if (isNoneOrUnassigned) {
						valBadge.style.background = 'rgba(255, 255, 255, 0.06)';
						valBadge.style.color = 'rgba(255, 255, 255, 0.4)';
						valBadge.style.fontStyle = 'italic';
					} else {
						valBadge.style.background = 'rgba(56, 189, 248, 0.12)';
						valBadge.style.color = '#38bdf8';
					}
				} else if (child.children && child.children.length > 0) {
					const countBadge = append(card, $('span'));
					countBadge.style.fontSize = '9.5px';
					countBadge.style.opacity = '0.6';
					countBadge.textContent = `${child.children.length} items ›`;
				}

				card.onmouseenter = () => {
					card.style.background = 'rgba(167, 139, 250, 0.18)';
					card.style.borderColor = 'rgba(167, 139, 250, 0.4)';
				};
				card.onmouseleave = () => {
					card.style.background = 'rgba(255, 255, 255, 0.05)';
					card.style.borderColor = 'rgba(255, 255, 255, 0.09)';
				};

				card.onclick = (e) => {
					e.stopPropagation();
					this.drillDownTo(child.path);
				};
			});

			const hintEl = append(containerBox, $('div'));
			hintEl.style.fontSize = '9.5px';
			hintEl.style.opacity = '0.55';
			hintEl.style.marginTop = '4px';
			hintEl.textContent = '✦ Click an item above to drill down into specific fields, or type/speak below to instruct the AI agent to modify or add items.';
		} else if (locator.field && !locator.field.startsWith('/Create')) {
			// Leaf Field Editor Mode
			const editorBox = append(this.contextLocatorContainer, $('.context-interactive-editor-box'));
			editorBox.style.display = 'flex';
			editorBox.style.flexDirection = 'column';
			editorBox.style.alignItems = 'stretch';
			editorBox.style.gap = '6px';
			editorBox.style.background = 'rgba(0, 0, 0, 0.28)';
			editorBox.style.border = '1px solid rgba(255, 255, 255, 0.08)';
			editorBox.style.borderRadius = '5px';
			editorBox.style.padding = '7px 10px';
			editorBox.style.boxSizing = 'border-box';
			editorBox.style.width = '100%';

			const headRow = append(editorBox, $('div'));
			headRow.style.display = 'flex';
			headRow.style.justifyContent = 'space-between';
			headRow.style.alignItems = 'center';

			const labelEl = append(headRow, $('label'));
			labelEl.style.fontSize = '10.5px';
			labelEl.style.opacity = '0.75';
			labelEl.style.fontWeight = '600';
			labelEl.style.textTransform = 'uppercase';
			labelEl.style.letterSpacing = '0.03em';
			labelEl.style.color = 'var(--vscode-editor-foreground)';
			labelEl.textContent = `${locator.label || (activeNode ? activeNode.label : 'Target Value')}:`;

			if (ancestors.length > 1) {
				const parentNode = ancestors[ancestors.length - 2];
				const upLink = append(headRow, $('span'));
				upLink.style.fontSize = '10px';
				upLink.style.color = '#38bdf8';
				upLink.style.cursor = 'pointer';
				upLink.style.opacity = '0.85';
				upLink.style.display = 'inline-flex';
				upLink.style.alignItems = 'center';
				upLink.style.gap = '3px';
				append(upLink, $('span.codicon.codicon-arrow-left', { style: 'font-size: 10px;' }));
				append(upLink, $('span', {}, `Back to ${parentNode.label}`));
				upLink.onclick = () => this.drillDownTo(parentNode.path);
			}

			const currentVal = locator.currentValue || (activeNode ? activeNode.currentValue : '') || '';
			const isNoneOrUnassigned = currentVal === 'None' || currentVal === 'Unassigned' || currentVal === 'null' || currentVal === 'undefined';
			const editableValue = isNoneOrUnassigned ? '' : currentVal;
			locator.interactiveModifiedValue = editableValue;

			const fType = locator.fieldType || (activeNode ? activeNode.fieldType : undefined) || (editableValue.includes('~') ? 'date_range' : (/^\d{4}-\d{2}-\d{2}/.test(editableValue) ? 'date' : (editableValue.toLowerCase() === 'true' || editableValue.toLowerCase() === 'false' ? 'switch' : 'text')));

			if (fType === 'date_range') {
				const [sDate, eDate] = editableValue.split('~').map((s: string) => s.trim());
				const dateWrapper = append(editorBox, $('div'));
				dateWrapper.style.display = 'flex';
				dateWrapper.style.alignItems = 'center';
				dateWrapper.style.gap = '8px';
				dateWrapper.style.width = '100%';

				const sInput = append(dateWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				sInput.type = 'date';
				sInput.value = sDate || '';
				sInput.style.flex = '1';
				sInput.style.minWidth = '0';
				sInput.style.padding = '4px 8px';
				sInput.style.fontSize = '11.5px';
				sInput.style.background = 'rgba(255,255,255,0.06)';
				sInput.style.border = '1px solid rgba(255,255,255,0.12)';
				sInput.style.borderRadius = '4px';
				sInput.style.color = '#fff';
				sInput.style.colorScheme = 'dark';
				sInput.style.boxSizing = 'border-box';

				append(dateWrapper, $('span', { style: 'font-size: 11.5px; opacity: 0.5; font-weight: 600;' }, '~'));

				const eInput = append(dateWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				eInput.type = 'date';
				eInput.value = eDate || '';
				eInput.style.flex = '1';
				eInput.style.minWidth = '0';
				eInput.style.padding = '4px 8px';
				eInput.style.fontSize = '11.5px';
				eInput.style.background = 'rgba(255,255,255,0.06)';
				eInput.style.border = '1px solid rgba(255,255,255,0.12)';
				eInput.style.borderRadius = '4px';
				eInput.style.color = '#fff';
				eInput.style.colorScheme = 'dark';
				eInput.style.boxSizing = 'border-box';

				const updateDateRange = () => {
					locator.interactiveModifiedValue = `${sInput.value.trim()} ~ ${eInput.value.trim()}`.trim();
				};
				sInput.oninput = updateDateRange;
				eInput.oninput = updateDateRange;
			} else if (fType === 'date') {
				const dInput = append(editorBox, $('input.monaco-inputbox')) as HTMLInputElement;
				dInput.type = 'date';
				dInput.value = editableValue;
				dInput.style.width = '100%';
				dInput.style.padding = '4px 8px';
				dInput.style.fontSize = '11.5px';
				dInput.style.background = 'rgba(255,255,255,0.06)';
				dInput.style.border = '1px solid rgba(255,255,255,0.12)';
				dInput.style.borderRadius = '4px';
				dInput.style.color = '#fff';
				dInput.style.colorScheme = 'dark';
				dInput.style.boxSizing = 'border-box';
				dInput.oninput = () => { locator.interactiveModifiedValue = dInput.value; };
			} else if (fType === 'time_range') {
				const [sTime, eTime] = editableValue.split('~').map((s: string) => s.trim());
				const timeWrapper = append(editorBox, $('div'));
				timeWrapper.style.display = 'flex';
				timeWrapper.style.alignItems = 'center';
				timeWrapper.style.gap = '8px';
				timeWrapper.style.width = '100%';

				const sInput = append(timeWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				sInput.type = 'time';
				sInput.value = sTime || '';
				sInput.style.flex = '1';
				sInput.style.minWidth = '0';
				sInput.style.padding = '4px 8px';
				sInput.style.fontSize = '11.5px';
				sInput.style.background = 'rgba(255,255,255,0.06)';
				sInput.style.border = '1px solid rgba(255,255,255,0.12)';
				sInput.style.borderRadius = '4px';
				sInput.style.color = '#fff';
				sInput.style.colorScheme = 'dark';
				sInput.style.boxSizing = 'border-box';

				append(timeWrapper, $('span', { style: 'font-size: 11.5px; opacity: 0.5; font-weight: 600;' }, '~'));

				const eInput = append(timeWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				eInput.type = 'time';
				eInput.value = eTime || '';
				eInput.style.flex = '1';
				eInput.style.minWidth = '0';
				eInput.style.padding = '4px 8px';
				eInput.style.fontSize = '11.5px';
				eInput.style.background = 'rgba(255,255,255,0.06)';
				eInput.style.border = '1px solid rgba(255,255,255,0.12)';
				eInput.style.borderRadius = '4px';
				eInput.style.color = '#fff';
				eInput.style.colorScheme = 'dark';
				eInput.style.boxSizing = 'border-box';

				const updateTimeRange = () => {
					locator.interactiveModifiedValue = `${sInput.value.trim()} ~ ${eInput.value.trim()}`.trim();
				};
				sInput.oninput = updateTimeRange;
				eInput.oninput = updateTimeRange;
			} else if (fType === 'time') {
				const tInput = append(editorBox, $('input.monaco-inputbox')) as HTMLInputElement;
				tInput.type = 'time';
				tInput.value = editableValue;
				tInput.style.width = '100%';
				tInput.style.padding = '4px 8px';
				tInput.style.fontSize = '11.5px';
				tInput.style.background = 'rgba(255,255,255,0.06)';
				tInput.style.border = '1px solid rgba(255,255,255,0.12)';
				tInput.style.borderRadius = '4px';
				tInput.style.color = '#fff';
				tInput.style.colorScheme = 'dark';
				tInput.style.boxSizing = 'border-box';
				tInput.oninput = () => { locator.interactiveModifiedValue = tInput.value; };
			} else if (fType === 'datetime_range') {
				const [sDt, eDt] = editableValue.split('~').map((s: string) => s.trim());
				const dtWrapper = append(editorBox, $('div'));
				dtWrapper.style.display = 'flex';
				dtWrapper.style.alignItems = 'center';
				dtWrapper.style.gap = '8px';
				dtWrapper.style.width = '100%';

				const sInput = append(dtWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				sInput.type = 'datetime-local';
				sInput.value = sDt || '';
				sInput.style.flex = '1';
				sInput.style.minWidth = '0';
				sInput.style.padding = '4px 8px';
				sInput.style.fontSize = '11.5px';
				sInput.style.background = 'rgba(255,255,255,0.06)';
				sInput.style.border = '1px solid rgba(255,255,255,0.12)';
				sInput.style.borderRadius = '4px';
				sInput.style.color = '#fff';
				sInput.style.colorScheme = 'dark';
				sInput.style.boxSizing = 'border-box';

				append(dtWrapper, $('span', { style: 'font-size: 11.5px; opacity: 0.5; font-weight: 600;' }, '~'));

				const eInput = append(dtWrapper, $('input.monaco-inputbox')) as HTMLInputElement;
				eInput.type = 'datetime-local';
				eInput.value = eDt || '';
				eInput.style.flex = '1';
				eInput.style.minWidth = '0';
				eInput.style.padding = '4px 8px';
				eInput.style.fontSize = '11.5px';
				eInput.style.background = 'rgba(255,255,255,0.06)';
				eInput.style.border = '1px solid rgba(255,255,255,0.12)';
				eInput.style.borderRadius = '4px';
				eInput.style.color = '#fff';
				eInput.style.colorScheme = 'dark';
				eInput.style.boxSizing = 'border-box';

				const updateDtRange = () => {
					locator.interactiveModifiedValue = `${sInput.value.trim()} ~ ${eInput.value.trim()}`.trim();
				};
				sInput.oninput = updateDtRange;
				eInput.oninput = updateDtRange;
			} else if (fType === 'datetime') {
				const dtInput = append(editorBox, $('input.monaco-inputbox')) as HTMLInputElement;
				dtInput.type = 'datetime-local';
				dtInput.value = editableValue;
				dtInput.style.width = '100%';
				dtInput.style.padding = '4px 8px';
				dtInput.style.fontSize = '11.5px';
				dtInput.style.background = 'rgba(255,255,255,0.06)';
				dtInput.style.border = '1px solid rgba(255,255,255,0.12)';
				dtInput.style.borderRadius = '4px';
				dtInput.style.color = '#fff';
				dtInput.style.colorScheme = 'dark';
				dtInput.style.boxSizing = 'border-box';
				dtInput.oninput = () => { locator.interactiveModifiedValue = dtInput.value; };
			} else if (fType === 'status') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; box-sizing: border-box;'
				})) as HTMLSelectElement;
				const statuses = (locator.options && Array.isArray(locator.options) && locator.options.length > 0)
					? locator.options
					: ((activeNode && activeNode.options && activeNode.options.length > 0)
						? activeNode.options
						: ['Todo', 'In Progress', 'Done', 'Blocked', 'Removed']);
				statuses.forEach((st: string) => {
					const opt = append(select, $('option', { value: st }, st)) as HTMLOptionElement;
					if (st.toLowerCase() === currentVal.toLowerCase()) opt.selected = true;
				});
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
				select.onkeydown = (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						locator.interactiveModifiedValue = select.value;
						this.sendMessage();
					}
				};
			} else if (fType === 'priority') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; box-sizing: border-box;'
				})) as HTMLSelectElement;
				const priorities = (locator.options && Array.isArray(locator.options) && locator.options.length > 0)
					? locator.options
					: ((activeNode && activeNode.options && activeNode.options.length > 0)
						? activeNode.options
						: ['Very High', 'High', 'Medium', 'Low', 'Very Low']);
				priorities.forEach((pr: string) => {
					const opt = append(select, $('option', { value: pr }, pr)) as HTMLOptionElement;
					if (pr.toLowerCase() === currentVal.toLowerCase()) opt.selected = true;
				});
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
				select.onkeydown = (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						locator.interactiveModifiedValue = select.value;
						this.sendMessage();
					}
				};
			} else if (fType === 'agent') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; box-sizing: border-box;'
				})) as HTMLSelectElement;
				append(select, $('option', { value: '' }, 'None (Unassigned)'));
				const optionsList = locator.options || (activeNode ? activeNode.options : []);
				if (optionsList && Array.isArray(optionsList)) {
					optionsList.forEach(ag => {
						const opt = append(select, $('option', { value: ag.id || ag.name }, ag.name || ag.id)) as HTMLOptionElement;
						if (!isNoneOrUnassigned && (ag.id === currentVal || ag.name === currentVal)) opt.selected = true;
					});
				}
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
				select.onkeydown = (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						locator.interactiveModifiedValue = select.value;
						this.sendMessage();
					}
				};
			} else if (fType === 'link_to') {
				const linkContainer = append(editorBox, $('.link-to-multi-select-container'));
				linkContainer.style.display = 'flex';
				linkContainer.style.flexDirection = 'column';
				linkContainer.style.gap = '6px';
				linkContainer.style.width = '100%';

				// Parse current selected IDs
				const rawVals = editableValue ? editableValue.split(/[,;\n]+/).map((s: string) => s.trim()).filter(Boolean) : [];
				const selectedSet = new Set<string>(rawVals);

				const allTickets: Array<{ id: string; code?: string; title?: string; summary?: string; type?: string; workspaceName?: string }> =
					(locator.options && Array.isArray(locator.options)) ? locator.options : (activeNode && activeNode.options ? activeNode.options : []);

				let isChecklistExpanded = true;

				// 1. Top row: Pills Container + Minimal Chevron Toggle Icon
				const pillsWrapper = append(linkContainer, $('div'));
				pillsWrapper.style.display = 'flex';
				pillsWrapper.style.alignItems = 'center';
				pillsWrapper.style.justifyContent = 'space-between';
				pillsWrapper.style.gap = '6px';
				pillsWrapper.style.width = '100%';

				const pillsContainer = append(pillsWrapper, $('.selected-tickets-pills'));
				pillsContainer.style.display = 'flex';
				pillsContainer.style.flexWrap = 'wrap';
				pillsContainer.style.gap = '5px';
				pillsContainer.style.minHeight = '26px';
				pillsContainer.style.padding = '4px 8px';
				pillsContainer.style.background = 'rgba(255, 255, 255, 0.04)';
				pillsContainer.style.border = '1px solid rgba(255, 255, 255, 0.09)';
				pillsContainer.style.borderRadius = '4px';
				pillsContainer.style.flex = '1';
				pillsContainer.style.cursor = 'pointer';
				pillsContainer.title = 'Click to toggle ticket picker';

				const chevronToggleBtn = append(pillsWrapper, $('div', {
					style: 'display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 4px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); cursor: pointer; color: var(--vscode-foreground); opacity: 0.75; transition: all 0.15s ease;'
				}));
				const chevronIcon = append(chevronToggleBtn, $('span.codicon'));

				const updateToggleBtn = () => {
					if (isChecklistExpanded) {
						chevronIcon.className = 'codicon codicon-chevron-up';
						chevronToggleBtn.title = 'Collapse ticket picker';
						chevronToggleBtn.style.color = '#38bdf8';
						chevronToggleBtn.style.borderColor = 'rgba(56, 189, 248, 0.3)';
						chevronToggleBtn.style.background = 'rgba(56, 189, 248, 0.1)';
					} else {
						chevronIcon.className = 'codicon codicon-chevron-down';
						chevronToggleBtn.title = 'Expand ticket picker';
						chevronToggleBtn.style.color = 'var(--vscode-foreground)';
						chevronToggleBtn.style.borderColor = 'rgba(255, 255, 255, 0.08)';
						chevronToggleBtn.style.background = 'rgba(255, 255, 255, 0.04)';
					}
				};

				chevronToggleBtn.onmouseenter = () => chevronToggleBtn.style.opacity = '1';
				chevronToggleBtn.onmouseleave = () => chevronToggleBtn.style.opacity = '0.75';

				// 2. Expandable Dropdown Area
				const dropdownArea = append(linkContainer, $('.tickets-dropdown-area'));
				dropdownArea.style.display = 'flex';
				dropdownArea.style.flexDirection = 'column';
				dropdownArea.style.gap = '6px';
				dropdownArea.style.width = '100%';

				// Search input
				const searchInput = append(dropdownArea, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; box-sizing: border-box;'
				})) as HTMLInputElement;
				searchInput.placeholder = 'Search tickets across workspaces to link...';

				// Scrollable Checklist
				const checklistContainer = append(dropdownArea, $('.tickets-checklist'));
				checklistContainer.style.maxHeight = '120px';
				checklistContainer.style.overflowY = 'auto';
				checklistContainer.style.display = 'flex';
				checklistContainer.style.flexDirection = 'column';
				checklistContainer.style.gap = '2px';
				checklistContainer.style.background = 'rgba(0, 0, 0, 0.2)';
				checklistContainer.style.border = '1px solid rgba(255, 255, 255, 0.08)';
				checklistContainer.style.borderRadius = '4px';
				checklistContainer.style.padding = '4px';

				// Bottom interactive collapse bar with centered chevron handle
				const collapseHandleBar = append(dropdownArea, $('div.tickets-collapse-handle', {
					style: 'display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; border-radius: 4px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); cursor: pointer; user-select: none; transition: all 0.15s ease;'
				}));

				const countLabel = append(collapseHandleBar, $('span', { style: 'font-size: 10.5px; opacity: 0.6; color: var(--vscode-descriptionForeground);' }));

				const centerChevron = append(collapseHandleBar, $('div', {
					style: 'display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: #38bdf8; font-weight: 500;'
				}));
				append(centerChevron, $('span.codicon.codicon-chevron-up', { style: 'font-size: 11px;' }));
				append(centerChevron, $('span', {}, 'Collapse'));

				append(collapseHandleBar, $('span', { style: 'font-size: 9.5px; opacity: 0.35; font-family: monospace;' }, 'Done'));

				collapseHandleBar.onmouseenter = () => {
					collapseHandleBar.style.background = 'rgba(56, 189, 248, 0.08)';
					collapseHandleBar.style.borderColor = 'rgba(56, 189, 248, 0.25)';
				};
				collapseHandleBar.onmouseleave = () => {
					collapseHandleBar.style.background = 'rgba(255, 255, 255, 0.03)';
					collapseHandleBar.style.borderColor = 'rgba(255, 255, 255, 0.06)';
				};

				const toggleChecklist = () => {
					isChecklistExpanded = !isChecklistExpanded;
					dropdownArea.style.display = isChecklistExpanded ? 'flex' : 'none';
					updateToggleBtn();
					if (isChecklistExpanded) {
						searchInput.focus();
					} else {
						this.inputField?.focus();
					}
				};

				chevronToggleBtn.onclick = () => toggleChecklist();
				pillsContainer.onclick = () => toggleChecklist();
				collapseHandleBar.onclick = () => toggleChecklist();

				const updateState = () => {
					locator.interactiveModifiedValue = selectedSet.size > 0 ? Array.from(selectedSet).join(', ') : 'None';
					countLabel.textContent = `${selectedSet.size} ticket${selectedSet.size === 1 ? '' : 's'} linked`;
					renderPills();
					renderChecklist(searchInput.value);
				};

				const renderPills = () => {
					pillsContainer.textContent = '';
					if (selectedSet.size === 0) {
						append(pillsContainer, $('span', { style: 'font-size: 10.5px; opacity: 0.4; font-style: italic;' }, 'No tickets linked (None)'));
						return;
					}
					selectedSet.forEach(tid => {
						const matched = allTickets.find(t => t.id === tid || t.code === tid);
						const colorInfo = getTypeColorInfo(matched?.type);
						const pill = append(pillsContainer, $('.ticket-pill'));
						pill.style.display = 'inline-flex';
						pill.style.alignItems = 'center';
						pill.style.gap = '5px';
						pill.style.fontSize = '10.5px';
						pill.style.fontWeight = '600';
						pill.style.padding = '2px 8px';
						pill.style.borderRadius = '4px';
						pill.style.background = colorInfo.bg;
						pill.style.border = `1px solid ${colorInfo.border}`;
						pill.style.color = colorInfo.text;
						if (matched) {
							pill.title = `${matched.id} [${(matched.type || 'task').toUpperCase()}]: ${matched.title || ''}\n${matched.summary || ''}\nWorkspace: ${matched.workspaceName || ''}`;
						}

						if (matched?.type) {
							append(pill, $('span', {
								style: `font-size: 8px; padding: 1px 4px; border-radius: 3px; background: ${colorInfo.bg}; color: ${colorInfo.text}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;`
							}, matched.type));
						} else {
							append(pill, $('span.codicon.codicon-tag', { style: 'font-size: 10px;' }));
						}

						const isTitleSameAsId = !matched || !matched.title || matched.title.toLowerCase() === matched.id.toLowerCase() || (matched.code && matched.title.toLowerCase() === matched.code.toLowerCase());
						const displayLabel = matched ? (isTitleSameAsId ? (matched.summary ? `${matched.id}: ${matched.summary}` : matched.id) : `${matched.id}: ${matched.title}`) : tid;
						append(pill, $('span', { style: 'max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, displayLabel));

						const remBtn = append(pill, $('span', { style: 'cursor: pointer; opacity: 0.7; margin-left: 3px; font-weight: bold;' }, '×'));
						remBtn.onmouseenter = () => remBtn.style.opacity = '1';
						remBtn.onmouseleave = () => remBtn.style.opacity = '0.7';
						remBtn.onclick = (e) => {
							e.stopPropagation();
							selectedSet.delete(tid);
							updateState();
						};
					});
				};

				const renderChecklist = (query: string) => {
					checklistContainer.textContent = '';
					const q = query.trim().toLowerCase();
					const filtered = allTickets.filter(t => {
						if (!q) return true;
						return (t.id && t.id.toLowerCase().includes(q)) ||
							(t.code && t.code.toLowerCase().includes(q)) ||
							(t.title && t.title.toLowerCase().includes(q)) ||
							(t.type && t.type.toLowerCase().includes(q)) ||
							(t.summary && t.summary.toLowerCase().includes(q)) ||
							(t.workspaceName && t.workspaceName.toLowerCase().includes(q));
					});

					if (filtered.length === 0) {
						append(checklistContainer, $('div', { style: 'font-size: 10.5px; opacity: 0.5; padding: 10px; text-align: center;' }, 'No matching tickets found'));
						return;
					}

					filtered.forEach(ticket => {
						const isSelected = selectedSet.has(ticket.id) || (ticket.code ? selectedSet.has(ticket.code) : false);
						const colorInfo = getTypeColorInfo(ticket.type);
						const row = append(checklistContainer, $('.ticket-check-row'));
						row.style.display = 'flex';
						row.style.alignItems = 'center';
						row.style.justifyContent = 'space-between';
						row.style.padding = '5px 8px';
						row.style.borderRadius = '4px';
						row.style.fontSize = '11px';
						row.style.cursor = 'pointer';
						row.style.transition = 'all 0.15s ease';
						row.style.background = isSelected ? colorInfo.bg : 'transparent';
						row.style.border = isSelected ? `1px solid ${colorInfo.border}` : '1px solid transparent';
						row.title = `${ticket.id} [${(ticket.type || 'task').toUpperCase()}]: ${ticket.title || ''}\n${ticket.summary ? `Summary: ${ticket.summary}\n` : ''}Workspace: ${ticket.workspaceName || ''}`;

						const left = append(row, $('div', { style: 'display: flex; align-items: center; gap: 7px; overflow: hidden; flex: 1; min-width: 0;' }));
						const checkbox = append(left, $('input')) as HTMLInputElement;
						checkbox.type = 'checkbox';
						checkbox.checked = isSelected;
						checkbox.style.cursor = 'pointer';
						checkbox.style.flexShrink = '0';

						// 1. Ticket ID Badge with Type Color
						append(left, $('span', {
							style: `font-weight: 700; color: ${colorInfo.text}; font-family: monospace; font-size: 10.5px; background: ${colorInfo.bg}; border: 1px solid ${colorInfo.border}; padding: 1px 5px; border-radius: 3px; flex-shrink: 0;`
						}, ticket.id));

						// 2. Type Tag Badge (Unified 100% with Left Sidebar Explorer!)
						const typeLabel = (ticket.type || 'TASK').toUpperCase();
						append(left, $('span', {
							style: `font-size: 8.5px; padding: 1px 5px; border-radius: 3px; background: ${colorInfo.bg}; color: ${colorInfo.text}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; display: inline-block;`
						}, typeLabel));

						// 3. Text container for Title and Summary
						const textWrapper = append(left, $('div', {
							style: 'display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; min-width: 0;'
						}));

						// Determine primary and secondary text without any duplicate code
						const isTitleSameAsId = !ticket.title || ticket.title.toLowerCase() === ticket.id.toLowerCase() || (ticket.code && ticket.title.toLowerCase() === ticket.code.toLowerCase());
						const primaryText = isTitleSameAsId ? (ticket.summary || '') : ticket.title;
						const secondaryText = (!isTitleSameAsId && ticket.summary && ticket.summary !== ticket.title) ? ticket.summary : '';

						if (primaryText) {
							append(textWrapper, $('span', {
								style: 'font-weight: 600; color: #ffffff; font-size: 11px; flex-shrink: 0;'
							}, primaryText));
						}

						if (secondaryText) {
							append(textWrapper, $('span', {
								style: 'font-size: 10.5px; opacity: 0.55; color: rgba(255,255,255,0.75); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
							}, `— ${secondaryText}`));
						}

						// Right: Workspace tag
						const right = append(row, $('div', { style: 'display: flex; align-items: center; gap: 4px; margin-left: 8px; flex-shrink: 0;' }));
						if (ticket.workspaceName) {
							append(right, $('span', {
								style: 'font-size: 9.5px; opacity: 0.45; font-family: monospace; padding: 1px 5px; border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; background: rgba(255,255,255,0.02);'
							}, ticket.workspaceName));
						}

						row.onmouseenter = () => {
							if (!isSelected) row.style.background = 'rgba(255, 255, 255, 0.05)';
						};
						row.onmouseleave = () => {
							if (!isSelected) row.style.background = 'transparent';
						};

						const toggle = () => {
							const key = ticket.id;
							if (selectedSet.has(key)) {
								selectedSet.delete(key);
								if (ticket.code) selectedSet.delete(ticket.code);
							} else {
								selectedSet.add(key);
							}
							updateState();
						};

						checkbox.onchange = toggle;
						row.onclick = (e) => {
							if (e.target !== checkbox) toggle();
						};
					});
				};

				searchInput.oninput = () => {
					renderChecklist(searchInput.value);
				};

				updateToggleBtn();
				updateState();
				renderChecklist('');
			} else if (fType === 'read_only') {
				const roBox = append(editorBox, $('div', {
					style: 'padding: 6px 10px; font-size: 11px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; color: rgba(255,255,255,0.8); display: flex; align-items: center; justify-content: space-between;'
				}));
				append(roBox, $('span', { style: 'font-family: monospace;' }, currentVal));
				append(roBox, $('span', { style: 'font-size: 10px; opacity: 0.5; font-style: italic;' }, 'Read-only (Managed by linking tickets)'));
			} else if (fType === 'switch' || fType === 'boolean') {
				let isChecked = String(currentVal).toLowerCase() === 'true' || currentVal === true || String(currentVal).toLowerCase() === 'yes' || String(currentVal).toLowerCase() === '1';
				locator.interactiveModifiedValue = isChecked ? 'true' : 'false';

				const switchWrapper = append(editorBox, $('div.switch-interactive-control', {
					style: 'display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 6px; cursor: pointer; user-select: none; transition: all 0.15s ease;'
				}));
				switchWrapper.onmouseenter = () => { switchWrapper.style.background = 'rgba(255, 255, 255, 0.07)'; };
				switchWrapper.onmouseleave = () => { switchWrapper.style.background = 'rgba(255, 255, 255, 0.04)'; };

				const stateInfo = append(switchWrapper, $('div', {
					style: 'display: flex; align-items: center; gap: 8px;'
				}));
				const stateIndicator = append(stateInfo, $('span', {
					style: 'font-size: 12px; font-weight: 600; letter-spacing: 0.2px;'
				}));

				const switchTrack = append(switchWrapper, $('div', {
					style: 'position: relative; width: 42px; height: 22px; border-radius: 11px; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); flex-shrink: 0;'
				}));
				const switchThumb = append(switchTrack, $('div', {
					style: 'position: absolute; top: 2px; width: 18px; height: 18px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 4px rgba(0,0,0,0.4); transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);'
				}));

				const updateSwitchVisual = () => {
					if (isChecked) {
						switchTrack.style.background = '#10b981';
						switchTrack.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.45)';
						switchThumb.style.left = '22px';
						stateIndicator.textContent = 'ON (true)';
						stateIndicator.style.color = '#34d399';
					} else {
						switchTrack.style.background = 'rgba(255, 255, 255, 0.18)';
						switchTrack.style.boxShadow = 'none';
						switchThumb.style.left = '2px';
						stateIndicator.textContent = 'OFF (false)';
						stateIndicator.style.color = 'rgba(255, 255, 255, 0.45)';
					}
					locator.interactiveModifiedValue = isChecked ? 'true' : 'false';
				};

				updateSwitchVisual();

				switchWrapper.onclick = (e) => {
					e.preventDefault();
					isChecked = !isChecked;
					updateSwitchVisual();
				};
			} else if (fType === 'select' || fType === 'single_select') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 6px 10px; font-size: 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.45); color: #fff; cursor: pointer; box-sizing: border-box; outline: none;'
				})) as HTMLSelectElement;

				const optionsList = (locator.options && Array.isArray(locator.options) && locator.options.length > 0)
					? locator.options
					: ((activeNode && activeNode.options && activeNode.options.length > 0)
						? activeNode.options
						: []);

				if (!currentVal || currentVal === 'None' || currentVal === 'Unassigned') {
					const defOpt = append(select, $('option', { value: '' }, '-- Select an option --')) as HTMLOptionElement;
					defOpt.selected = true;
				}

				if (optionsList && Array.isArray(optionsList) && optionsList.length > 0) {
					let matched = false;
					optionsList.forEach(op => {
						const valStr = typeof op === 'object' && op ? (op.value || op.id || op.name || JSON.stringify(op)) : String(op);
						const labelStr = typeof op === 'object' && op ? (op.label || op.name || op.title || valStr) : String(op);
						const opt = append(select, $('option', { value: valStr }, labelStr)) as HTMLOptionElement;
						if (currentVal && (valStr.toLowerCase() === currentVal.toLowerCase() || labelStr.toLowerCase() === currentVal.toLowerCase())) {
							opt.selected = true;
							matched = true;
						}
					});
					if (!matched && currentVal && currentVal !== 'None' && currentVal !== 'Unassigned') {
						const customOpt = append(select, $('option', { value: currentVal }, currentVal)) as HTMLOptionElement;
						customOpt.selected = true;
					}
				} else if (currentVal && currentVal !== 'None') {
					const currentOpt = append(select, $('option', { value: currentVal }, currentVal)) as HTMLOptionElement;
					currentOpt.selected = true;
				}

				locator.interactiveModifiedValue = select.value;
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
				select.onkeydown = (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						locator.interactiveModifiedValue = select.value;
						this.sendMessage();
					}
				};
			} else if (fType === 'multiselect' || fType === 'tags') {
				let initialArr: string[] = [];
				if (Array.isArray(currentVal)) {
					initialArr = currentVal.map(s => String(s).trim());
				} else if (typeof currentVal === 'string') {
					const tr = currentVal.trim();
					if (tr.startsWith('[')) {
						try {
							const parsed = JSON.parse(tr);
							if (Array.isArray(parsed)) initialArr = parsed.map((s: any) => String(s).trim());
						} catch { }
					} else if (tr && tr !== 'None' && tr !== 'null' && tr !== 'undefined') {
						initialArr = tr.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
					}
				}
				const selectedSet = new Set<string>(initialArr);

				const rawOptions = (locator.options && Array.isArray(locator.options) && locator.options.length > 0)
					? locator.options
					: ((activeNode && activeNode.options && activeNode.options.length > 0)
						? activeNode.options
						: []);

				const optionStrings: string[] = rawOptions.map((o: any) => typeof o === 'object' && o ? (o.value || o.name || o.label || String(o)) : String(o));
				selectedSet.forEach(item => {
					if (!optionStrings.includes(item)) {
						optionStrings.push(item);
					}
				});

				const multiWrapper = append(editorBox, $('div.multiselect-interactive-container', {
					style: 'display: flex; flex-direction: column; gap: 8px; width: 100%;'
				}));

				const chipsArea = append(multiWrapper, $('div', {
					style: 'display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0;'
				}));

				const countRow = append(multiWrapper, $('div', {
					style: 'display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; opacity: 0.65; padding: 0 2px;'
				}));
				const countLabel = append(countRow, $('span'));

				const updateMultiState = () => {
					locator.interactiveModifiedValue = JSON.stringify(Array.from(selectedSet));
					countLabel.textContent = `${selectedSet.size} option${selectedSet.size === 1 ? '' : 's'} selected`;
					renderChips();
				};

				const renderChips = () => {
					chipsArea.textContent = '';
					if (optionStrings.length === 0) {
						append(chipsArea, $('span', { style: 'font-size: 11px; opacity: 0.45; font-style: italic;' }, 'No options defined'));
						return;
					}
					optionStrings.forEach(opt => {
						const isSelected = selectedSet.has(opt);
						const chip = append(chipsArea, $('div.interactive-tag-chip', {
							style: `display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; user-select: none; transition: all 0.15s ease; ${isSelected
								? 'background: rgba(99, 102, 241, 0.22); border: 1px solid rgba(99, 102, 241, 0.55); color: #a5b4fc; font-weight: 600;'
								: 'background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.65); font-weight: 400;'
								}`
						}));
						append(chip, $('span', {
							style: `font-size: 11px; font-weight: bold; ${isSelected ? 'color: #818cf8;' : 'opacity: 0.4;'}`
						}, isSelected ? '✓' : '+'));
						append(chip, $('span', {}, opt));

						chip.onmouseenter = () => {
							chip.style.opacity = '1';
							if (!isSelected) chip.style.background = 'rgba(255, 255, 255, 0.09)';
						};
						chip.onmouseleave = () => {
							if (!isSelected) chip.style.background = 'rgba(255, 255, 255, 0.05)';
						};
						chip.onclick = (e) => {
							e.preventDefault();
							e.stopPropagation();
							if (selectedSet.has(opt)) {
								selectedSet.delete(opt);
							} else {
								selectedSet.add(opt);
							}
							updateMultiState();
						};
					});
				};

				updateMultiState();
			} else if (fType === 'attachment') {
				interface IAttachmentItem {
					name: string;
					size?: number;
				}
				let existingFiles: IAttachmentItem[] = [];
				if (currentVal && currentVal !== 'None' && currentVal !== 'null' && currentVal !== 'undefined') {
					if (typeof currentVal === 'string' && currentVal.trim().startsWith('[')) {
						try {
							const parsed = JSON.parse(currentVal);
							if (Array.isArray(parsed)) {
								existingFiles = parsed.map((item: any) => ({
									name: item.name || String(item),
									size: typeof item.size === 'number' ? item.size : undefined
								}));
							}
						} catch { }
					} else {
						existingFiles = [{ name: String(currentVal).trim() }];
					}
				}

				const markedForDeletion = new Set<string>();
				const stagedNewFiles: Array<{ name: string; size?: number; sourceUri?: URI }> = [];

				const formatSize = (size?: number): string => {
					if (!size || size <= 0) return '';
					if (size < 1024) return `${size} B`;
					if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
					return `${(size / (1024 * 1024)).toFixed(1)} MB`;
				};

				const appendFileIcon = (container: HTMLElement, fileName: string) => {
					const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
					const isPdf = /\.pdf$/i.test(fileName);
					if (isImg) {
						append(container, $('span.codicon.codicon-file-media', { style: 'font-size: 13px; color: #10b981; flex-shrink: 0;' }));
					} else if (isPdf) {
						append(container, $('span.codicon.codicon-file-pdf', { style: 'font-size: 13px; color: #ef4444; flex-shrink: 0;' }));
					} else {
						append(container, $('span.codicon.codicon-file', { style: 'font-size: 13px; color: #38bdf8; flex-shrink: 0;' }));
					}
				};

				const attachWrapper = append(editorBox, $('.centered-chat-attachment-editor'));
				attachWrapper.style.display = 'flex';
				attachWrapper.style.flexDirection = 'column';
				attachWrapper.style.gap = '8px';
				attachWrapper.style.width = '100%';

				// 1. Existing Attachments List
				const existingSection = append(attachWrapper, $('div'));
				existingSection.style.display = 'flex';
				existingSection.style.flexDirection = 'column';
				existingSection.style.gap = '4px';

				const existingHeader = append(existingSection, $('div'));
				existingHeader.style.display = 'flex';
				existingHeader.style.justifyContent = 'space-between';
				existingHeader.style.alignItems = 'center';

				const existingTitle = append(existingHeader, $('span'));
				existingTitle.style.fontSize = '10px';
				existingTitle.style.fontWeight = '700';
				existingTitle.style.opacity = '0.7';
				existingTitle.style.textTransform = 'uppercase';
				existingTitle.style.letterSpacing = '0.03em';
				existingTitle.textContent = `Existing Attachments (${existingFiles.length}):`;

				const existingListEl = append(existingSection, $('div'));
				existingListEl.style.display = 'flex';
				existingListEl.style.flexWrap = 'wrap';
				existingListEl.style.gap = '6px';

				// 2. Staged New Attachments List
				const stagedSection = append(attachWrapper, $('div'));
				stagedSection.style.display = 'flex';
				stagedSection.style.flexDirection = 'column';
				stagedSection.style.gap = '4px';

				const stagedHeader = append(stagedSection, $('div'));
				stagedHeader.style.display = 'flex';
				stagedHeader.style.justifyContent = 'space-between';
				stagedHeader.style.alignItems = 'center';

				const stagedTitle = append(stagedHeader, $('span'));
				stagedTitle.style.fontSize = '10px';
				stagedTitle.style.fontWeight = '700';
				stagedTitle.style.color = '#10b981';
				stagedTitle.style.textTransform = 'uppercase';
				stagedTitle.style.letterSpacing = '0.03em';
				stagedTitle.textContent = 'Staged to Add (0):';

				const stagedListEl = append(stagedSection, $('div'));
				stagedListEl.style.display = 'flex';
				stagedListEl.style.flexWrap = 'wrap';
				stagedListEl.style.gap = '6px';

				// 3. Dropzone & Browse Box
				const dropzone = append(attachWrapper, $('.attachment-dropzone-box'));
				dropzone.style.display = 'flex';
				dropzone.style.flexDirection = 'column';
				dropzone.style.alignItems = 'center';
				dropzone.style.justifyContent = 'center';
				dropzone.style.gap = '4px';
				dropzone.style.padding = '10px 14px';
				dropzone.style.borderRadius = '5px';
				dropzone.style.border = '1px dashed rgba(255, 255, 255, 0.2)';
				dropzone.style.background = 'rgba(255, 255, 255, 0.02)';
				dropzone.style.cursor = 'pointer';
				dropzone.style.transition = 'all 0.15s ease';

				const dzTopRow = append(dropzone, $('div'));
				dzTopRow.style.display = 'flex';
				dzTopRow.style.alignItems = 'center';
				dzTopRow.style.gap = '6px';

				const cloudIcon = append(dzTopRow, $('span.codicon.codicon-cloud-upload'));
				cloudIcon.style.fontSize = '16px';
				cloudIcon.style.color = '#38bdf8';

				const dzPrompt = append(dzTopRow, $('span', { style: 'font-size: 11px; font-weight: 500;' }));
				append(dzPrompt, $('span', {}, 'Drag & drop files here, or '));
				append(dzPrompt, $('span', { style: 'color: #38bdf8; text-decoration: underline;' }, 'browse files...'));

				const dzHint = append(dropzone, $('div'));
				dzHint.style.fontSize = '9.5px';
				dzHint.style.opacity = '0.5';
				dzHint.textContent = 'Files will be copied to ticket attachments and submitted to AI';

				// 4. Diff & Action Summary Banner
				const diffBanner = append(attachWrapper, $('div'));
				diffBanner.style.display = 'flex';
				diffBanner.style.flexDirection = 'column';
				diffBanner.style.gap = '3px';
				diffBanner.style.padding = '5px 8px';
				diffBanner.style.borderRadius = '4px';
				diffBanner.style.background = 'rgba(0, 0, 0, 0.2)';
				diffBanner.style.border = '1px solid rgba(255, 255, 255, 0.06)';

				const syncInteractiveValue = () => {
					const surviving = existingFiles.filter(f => !markedForDeletion.has(f.name));
					const finalAll = [...surviving, ...stagedNewFiles.map(f => ({ name: f.name, size: f.size }))];
					if (markedForDeletion.size === 0 && stagedNewFiles.length === 0) {
						locator.interactiveModifiedValue = currentVal;
					} else {
						locator.interactiveModifiedValue = JSON.stringify(finalAll);
					}
					renderDiffBanner();
				};

				const renderExistingList = () => {
					existingListEl.textContent = '';
					existingTitle.textContent = `Existing Attachments (${existingFiles.length}):`;
					if (existingFiles.length === 0) {
						const empty = append(existingListEl, $('div'));
						empty.style.fontSize = '10.5px';
						empty.style.opacity = '0.45';
						empty.style.fontStyle = 'italic';
						empty.textContent = 'No existing attachments.';
						return;
					}

					existingFiles.forEach(f => {
						const isMarked = markedForDeletion.has(f.name);
						const card = append(existingListEl, $('.attachment-file-chip'));
						card.style.display = 'inline-flex';
						card.style.alignItems = 'center';
						card.style.gap = '6px';
						card.style.padding = '3px 8px';
						card.style.borderRadius = '4px';
						card.style.transition = 'all 0.15s ease';

						if (isMarked) {
							card.style.background = 'rgba(239, 68, 68, 0.14)';
							card.style.border = '1px dashed rgba(239, 68, 68, 0.45)';

							const delBadge = append(card, $('span'));
							delBadge.style.fontSize = '8.5px';
							delBadge.style.fontWeight = '700';
							delBadge.style.color = '#ef4444';
							delBadge.style.background = 'rgba(239, 68, 68, 0.2)';
							delBadge.style.padding = '1px 4px';
							delBadge.style.borderRadius = '2px';
							delBadge.textContent = 'TO DELETE';

							const nameSpan = append(card, $('span'));
							nameSpan.style.fontSize = '11px';
							nameSpan.style.textDecoration = 'line-through';
							nameSpan.style.color = '#fca5a5';
							nameSpan.style.opacity = '0.7';
							nameSpan.style.maxWidth = '150px';
							nameSpan.style.overflow = 'hidden';
							nameSpan.style.textOverflow = 'ellipsis';
							nameSpan.style.whiteSpace = 'nowrap';
							nameSpan.textContent = f.name;

							const undoBtn = append(card, $('span'));
							undoBtn.style.fontSize = '10px';
							undoBtn.style.color = '#38bdf8';
							undoBtn.style.cursor = 'pointer';
							undoBtn.style.padding = '1px 4px';
							undoBtn.style.borderRadius = '2px';
							undoBtn.style.background = 'rgba(56, 189, 248, 0.1)';
							undoBtn.style.marginLeft = '2px';
							undoBtn.textContent = '↺ Undo';
							undoBtn.title = 'Restore attachment';
							undoBtn.onclick = (e) => {
								e.stopPropagation();
								markedForDeletion.delete(f.name);
								renderExistingList();
								syncInteractiveValue();
							};
						} else {
							card.style.background = 'rgba(255, 255, 255, 0.05)';
							card.style.border = '1px solid rgba(255, 255, 255, 0.1)';

							appendFileIcon(card, f.name);

							const nameSpan = append(card, $('span'));
							nameSpan.style.fontSize = '11px';
							nameSpan.style.fontWeight = '500';
							nameSpan.style.color = 'var(--vscode-editor-foreground)';
							nameSpan.style.maxWidth = '160px';
							nameSpan.style.overflow = 'hidden';
							nameSpan.style.textOverflow = 'ellipsis';
							nameSpan.style.whiteSpace = 'nowrap';
							nameSpan.textContent = f.name;

							if (f.size) {
								const sizeSpan = append(card, $('span'));
								sizeSpan.style.fontSize = '9px';
								sizeSpan.style.opacity = '0.5';
								sizeSpan.textContent = `(${formatSize(f.size)})`;
							}

							const removeBtn = append(card, $('span'));
							removeBtn.style.fontSize = '9.5px';
							removeBtn.style.color = '#f87171';
							removeBtn.style.cursor = 'pointer';
							removeBtn.style.padding = '1px 5px';
							removeBtn.style.borderRadius = '3px';
							removeBtn.style.background = 'rgba(239, 68, 68, 0.1)';
							removeBtn.style.border = '1px solid rgba(239, 68, 68, 0.25)';
							removeBtn.style.marginLeft = '4px';
							removeBtn.textContent = '✕ Remove';
							removeBtn.title = 'Mark for deletion with AI';
							removeBtn.onclick = (e) => {
								e.stopPropagation();
								markedForDeletion.add(f.name);
								renderExistingList();
								syncInteractiveValue();
							};
						}
					});
				};

				const renderStagedList = () => {
					stagedListEl.textContent = '';
					stagedTitle.textContent = `Staged to Add (${stagedNewFiles.length}):`;
					if (stagedNewFiles.length === 0) {
						stagedSection.style.display = 'none';
						return;
					}
					stagedSection.style.display = 'flex';

					stagedNewFiles.forEach((f, idx) => {
						const card = append(stagedListEl, $('.attachment-file-chip'));
						card.style.display = 'inline-flex';
						card.style.alignItems = 'center';
						card.style.gap = '6px';
						card.style.padding = '3px 8px';
						card.style.borderRadius = '4px';
						card.style.background = 'rgba(16, 185, 129, 0.12)';
						card.style.border = '1px solid rgba(16, 185, 129, 0.3)';

						const addBadge = append(card, $('span'));
						addBadge.style.fontSize = '8.5px';
						addBadge.style.fontWeight = '700';
						addBadge.style.color = '#10b981';
						addBadge.style.background = 'rgba(16, 185, 129, 0.2)';
						addBadge.style.padding = '1px 4px';
						addBadge.style.borderRadius = '2px';
						addBadge.textContent = '+ ADD';

						appendFileIcon(card, f.name);

						const nameSpan = append(card, $('span'));
						nameSpan.style.fontSize = '11px';
						nameSpan.style.fontWeight = '500';
						nameSpan.style.color = '#6ee7b7';
						nameSpan.style.maxWidth = '160px';
						nameSpan.style.overflow = 'hidden';
						nameSpan.style.textOverflow = 'ellipsis';
						nameSpan.style.whiteSpace = 'nowrap';
						nameSpan.textContent = f.name;

						if (f.size) {
							const sizeSpan = append(card, $('span'));
							sizeSpan.style.fontSize = '9px';
							sizeSpan.style.opacity = '0.6';
							sizeSpan.textContent = `(${formatSize(f.size)})`;
						}

						const cancelBtn = append(card, $('span'));
						cancelBtn.style.fontSize = '11px';
						cancelBtn.style.cursor = 'pointer';
						cancelBtn.style.opacity = '0.7';
						cancelBtn.style.marginLeft = '3px';
						cancelBtn.textContent = '✕';
						cancelBtn.title = 'Cancel staged addition';
						cancelBtn.onclick = (e) => {
							e.stopPropagation();
							stagedNewFiles.splice(idx, 1);
							renderStagedList();
							syncInteractiveValue();
						};
					});
				};

				const renderDiffBanner = () => {
					diffBanner.textContent = '';
					const hasChanges = markedForDeletion.size > 0 || stagedNewFiles.length > 0;
					if (!hasChanges) {
						const emptyHint = append(diffBanner, $('div'));
						emptyHint.style.fontSize = '9.5px';
						emptyHint.style.opacity = '0.45';
						emptyHint.style.fontStyle = 'italic';
						emptyHint.textContent = 'No pending attachment changes. Use Remove or Browse/Drop to modify.';
						return;
					}

					const changesRow = append(diffBanner, $('div'));
					changesRow.style.display = 'flex';
					changesRow.style.alignItems = 'center';
					changesRow.style.gap = '8px';
					changesRow.style.flexWrap = 'wrap';

					if (stagedNewFiles.length > 0) {
						const addTag = append(changesRow, $('span'));
						addTag.style.fontSize = '10px';
						addTag.style.fontWeight = '600';
						addTag.style.color = '#10b981';
						addTag.textContent = `+ Added: [${stagedNewFiles.map(f => f.name).join(', ')}]`;
					}

					if (markedForDeletion.size > 0) {
						const delTag = append(changesRow, $('span'));
						delTag.style.fontSize = '10px';
						delTag.style.fontWeight = '600';
						delTag.style.color = '#ef4444';
						delTag.textContent = `- Removed: [${Array.from(markedForDeletion).join(', ')}]`;
					}

					const hint = append(diffBanner, $('div'));
					hint.style.fontSize = '9px';
					hint.style.opacity = '0.6';
					hint.textContent = '✦ Press Enter or Send below to instruct the AI agent to apply these changes.';
				};

				const processIncomingFiles = async (items: Array<{ uri: URI; name: string }>) => {
					if (!items || items.length === 0) return;
					try {
						let targetAttachmentsDir: URI | undefined = undefined;
						if (!locator.entityUri && (locator.workspaceId || locator.ticketId)) {
							try {
								const wsUri = await this.ticketDataEngine.findWorkspaceUri(locator.workspaceId, locator.ticketId);
								if (wsUri && locator.ticketId) {
									const paths = await this.ticketDataEngine.resolveTicketPaths(wsUri, locator.ticketId);
									if (paths) {
										locator.entityUri = paths.folderUri.toString();
									}
								}
							} catch { }
						}
						if (locator.entityUri) {
							const baseUri = locator.entityUri.includes('://') ? URI.parse(locator.entityUri) : URI.file(locator.entityUri);
							targetAttachmentsDir = URI.joinPath(baseUri, 'attachments');
							if (!(await this.fileService.exists(targetAttachmentsDir))) {
								await this.fileService.createFolder(targetAttachmentsDir);
							}
						}

						for (const item of items) {
							let fileSize = 0;
							if (targetAttachmentsDir) {
								const targetFileUri = URI.joinPath(targetAttachmentsDir, item.name);
								await this.fileService.copy(item.uri, targetFileUri, true);
								const stat = await this.fileService.stat(targetFileUri);
								fileSize = stat.size;
							} else {
								try {
									const stat = await this.fileService.stat(item.uri);
									fileSize = stat.size;
								} catch { }
							}
							if (markedForDeletion.has(item.name)) {
								markedForDeletion.delete(item.name);
							}
							if (!stagedNewFiles.some(f => f.name === item.name)) {
								stagedNewFiles.push({ name: item.name, size: fileSize, sourceUri: item.uri });
							}
						}
						renderExistingList();
						renderStagedList();
						syncInteractiveValue();
					} catch (err) {
						this.notificationService.error(`Failed to stage attachment: ${String(err)}`);
					}
				};

				dropzone.onclick = async (e) => {
					e.preventDefault();
					e.stopPropagation();
					try {
						const picked = await this.fileDialogService.showOpenDialog({
							canSelectFiles: true,
							canSelectFolders: false,
							canSelectMany: true,
							title: 'Select Attachments to Add'
						});
						if (picked && picked.length > 0) {
							const items = picked.map(p => ({
								uri: p,
								name: p.path.split('/').filter(Boolean).pop() || 'file'
							}));
							await processIncomingFiles(items);
						}
					} catch (err) {
						console.error('Failed to open file dialog:', err);
						this.notificationService.error(`Failed to select files: ${String(err)}`);
					}
				};

				dropzone.ondragover = (e) => {
					e.preventDefault();
					e.stopPropagation();
					dropzone.style.borderColor = '#38bdf8';
					dropzone.style.background = 'rgba(56, 189, 248, 0.08)';
				};
				dropzone.ondragleave = (e) => {
					e.preventDefault();
					e.stopPropagation();
					dropzone.style.borderColor = 'rgba(255, 255, 255, 0.2)';
					dropzone.style.background = 'rgba(255, 255, 255, 0.02)';
				};
				dropzone.ondrop = async (e) => {
					e.preventDefault();
					e.stopPropagation();
					dropzone.style.borderColor = 'rgba(255, 255, 255, 0.2)';
					dropzone.style.background = 'rgba(255, 255, 255, 0.02)';
					if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
						const items: Array<{ uri: URI; name: string }> = [];
						for (let i = 0; i < e.dataTransfer.files.length; i++) {
							const f = e.dataTransfer.files[i];
							const filePath = (f as any).path;
							if (filePath) {
								items.push({
									uri: URI.file(filePath),
									name: f.name
								});
							}
						}
						if (items.length > 0) {
							await processIncomingFiles(items);
						}
					}
				};

				renderExistingList();
				renderStagedList();
				renderDiffBanner();
			} else if (fType === 'textarea') {
				const ta = append(editorBox, $('textarea.monaco-inputbox', {
					style: 'width: 100%; min-height: 62px; max-height: 200px; padding: 6px 8px; font-size: 11.5px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; resize: vertical; box-sizing: border-box;'
				})) as HTMLTextAreaElement;
				ta.rows = 3;
				ta.value = editableValue;
				ta.placeholder = isNoneOrUnassigned ? currentVal : '';
				ta.onfocus = () => this.recordLastActiveEditable(ta);
				ta.onkeyup = () => this.recordLastActiveEditable(ta);
				ta.onmouseup = () => this.recordLastActiveEditable(ta);
				ta.onselect = () => this.recordLastActiveEditable(ta);
				ta.oninput = () => {
					locator.interactiveModifiedValue = ta.value;
					this.recordLastActiveEditable(ta);
				};
				this.recordLastActiveEditable(ta);
			} else {
				const txt = append(editorBox, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; box-sizing: border-box;'
				})) as HTMLInputElement;
				txt.type = 'text';
				txt.value = editableValue;
				txt.placeholder = isNoneOrUnassigned ? currentVal : '';
				txt.onfocus = () => this.recordLastActiveEditable(txt);
				txt.onkeyup = () => this.recordLastActiveEditable(txt);
				txt.onmouseup = () => this.recordLastActiveEditable(txt);
				txt.onselect = () => this.recordLastActiveEditable(txt);
				txt.oninput = () => {
					locator.interactiveModifiedValue = txt.value;
					this.recordLastActiveEditable(txt);
				};
				this.recordLastActiveEditable(txt);
			}
		}
	}

	public show(initialContext?: { prompt?: string; workspaceId?: string; ticketId?: string; field?: string; label?: string; fieldType?: string; currentValue?: string; options?: any[]; hierarchyTree?: any[]; companionMode?: boolean; companionPosition?: { left: number; top?: string; width: number; height: number }; entityUri?: string }): void {
		if (this.element) {
			if (initialContext) {
				if (initialContext.workspaceId || initialContext.ticketId || initialContext.field) {
					this.setContextLocator({
						workspaceId: initialContext.workspaceId,
						ticketId: initialContext.ticketId,
						field: initialContext.field,
						label: initialContext.label,
						fieldType: initialContext.fieldType,
						currentValue: initialContext.currentValue,
						options: initialContext.options,
						hierarchyTree: initialContext.hierarchyTree,
						entityUri: initialContext.entityUri
					});
				}
				if (initialContext.prompt && (!initialContext.field || initialContext.field.startsWith('/Create')) && this.inputField) {
					this.inputField.value = initialContext.prompt;
				}
				if (initialContext.companionMode || initialContext.companionPosition) {
					this.restorePosition(initialContext.companionMode, initialContext.companionPosition);
				}
			}
			this.inputField?.focus();
			if (this.inputField?.value) {
				const len = this.inputField.value.length;
				this.inputField.setSelectionRange(len, len);
			}
			this.scrollToBottom();
			return;
		}

		// Clear any previous view session disposables
		this.viewDisposables.clear();

		const parent = this.layoutService.mainContainer;
		this.element = append(parent, $('.centered-chat-popup-container'));

		// Titlebar / Header - AnyAgent Logo
		const header = append(this.element, $('.centered-chat-popup-header'));

		const title = append(header, $('.centered-chat-popup-title'));
		append(title, $('span.centered-chat-popup-title-icon'));
		const titleText = append(title, $('span'));
		titleText.textContent = 'Agent Central';

		const controls = append(header, $('.centered-chat-popup-controls'));
		controls.style.display = 'flex';
		controls.style.alignItems = 'center';
		controls.style.gap = '6px';

		// New Chat Button
		const newChatBtn = append(controls, $('button.centered-chat-header-btn'));
		append(newChatBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
		append(newChatBtn, $('span', {}, 'New Chat'));
		newChatBtn.title = 'Start a fresh conversation';
		this.viewDisposables.add(addDisposableListener(newChatBtn, 'click', (e) => {
			e.stopPropagation();
			this.startNewSession();
		}));

		// History Button
		const historyBtn = append(controls, $('button.centered-chat-header-btn'));
		append(historyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.history)));
		append(historyBtn, $('span', {}, 'History'));
		historyBtn.title = 'View and switch conversation history';
		this.viewDisposables.add(addDisposableListener(historyBtn, 'click', (e) => {
			e.stopPropagation();
			this.toggleHistoryDropdown();
		}));

		// Zen Toggle (Collapse) Button
		const toggleZenBtn = append(controls, $('.centered-chat-popup-zen-btn'));
		toggleZenBtn.style.cursor = 'pointer';
		toggleZenBtn.style.display = 'flex';
		toggleZenBtn.style.alignItems = 'center';
		toggleZenBtn.style.justifyContent = 'center';
		const zenIcon = append(toggleZenBtn, $('span.codicon.codicon-chrome-minimize'));

		this.viewDisposables.add(addDisposableListener(toggleZenBtn, 'click', async (e) => {
			e.stopPropagation();
			await this.toggleZenMode(zenIcon);
		}));

		// Close Button
		const closeBtn = append(controls, $('.centered-chat-popup-close-btn'));
		append(closeBtn, $('span.codicon.codicon-close'));
		this.viewDisposables.add(addDisposableListener(closeBtn, 'click', () => this.hide()));

		// Floating History Dropdown Container
		this.historyDropdown = append(this.element, $('.centered-chat-history-dropdown'));
		this.historyDropdown.style.display = 'none';

		// Close History Dropdown on click outside
		this.viewDisposables.add(addDisposableListener(this.element, 'click', (e) => {
			if (this.isHistoryOpen && !historyBtn.contains(e.target as Node) && !this.historyDropdown?.contains(e.target as Node)) {
				this.closeHistoryDropdown();
			}
		}));

		// Messages Body
		this.messagesContainer = append(this.element, $('.centered-chat-popup-messages'));

		// Load active conversation session or add welcome
		const activeSession = this.getOrCreateCurrentSession(initialContext);
		this.renderSessionMessages(activeSession);

		// Attachments Area (hidden by default)
		this.attachmentsContainer = append(this.element, $('.centered-chat-popup-attachments'));
		this.attachmentsContainer!.style.display = 'none';

		// Input Section - Rounded bubble following Antigravity layout
		const inputArea = append(this.element, $('.centered-chat-popup-input-area'));

		// Track active editable element & caret position for speech-to-text dictation
		const updateActiveEditable = (e: Event) => {
			const target = e.target;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
				this.recordLastActiveEditable(target);
			}
		};
		this.viewDisposables.add(addDisposableListener(this.element, 'focusin', updateActiveEditable));
		this.viewDisposables.add(addDisposableListener(this.element, 'keyup', updateActiveEditable));
		this.viewDisposables.add(addDisposableListener(this.element, 'mouseup', updateActiveEditable));
		this.viewDisposables.add(addDisposableListener(this.element, 'input', updateActiveEditable));
		this.viewDisposables.add(addDisposableListener(this.element, 'select', updateActiveEditable));

		// Hidden File Input
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.multiple = true;
		fileInput.style.display = 'none';
		inputArea.appendChild(fileInput);

		// Voice Recording Pulse Timer Indicator
		this.recordingIndicator = append(inputArea, $('.centered-chat-popup-recording-indicator'));
		this.recordingIndicator.style.display = 'none';
		append(this.recordingIndicator, $('.centered-chat-popup-recording-dot'));
		this.recordingTimeSpan = append(this.recordingIndicator, $('span'));
		this.recordingTimeSpan.textContent = '0:00 / 2:00';

		// Context Locator Tag Bar (Cursor-style breadcrumb above input)
		this.contextLocatorContainer = append(inputArea, $('.centered-chat-context-locator-bar'));
		this.contextLocatorContainer.style.display = 'none';
		this.contextLocatorContainer.style.alignItems = 'center';
		this.contextLocatorContainer.style.justifyContent = 'space-between';
		this.contextLocatorContainer.style.gap = '8px';
		this.contextLocatorContainer.style.background = 'rgba(56,189,248,0.06)';
		this.contextLocatorContainer.style.border = '1px solid rgba(56,189,248,0.2)';
		this.contextLocatorContainer.style.borderRadius = '6px';
		this.contextLocatorContainer.style.padding = '4px 8px';
		this.contextLocatorContainer.style.marginBottom = '6px';

		// Input Text Area
		const inputWrapper = append(inputArea, $('.centered-chat-popup-input-wrapper'));
		this.inputField = append(inputWrapper, $('textarea.centered-chat-popup-input')) as HTMLTextAreaElement;
		this.inputField.placeholder = 'Ask anything, @ to mention, / for actions... (Enter to send)';
		this.recordLastActiveEditable(this.inputField);

		// Toolbar below textarea
		const toolbar = append(inputArea, $('.centered-chat-popup-toolbar'));

		// Left side of toolbar
		const toolbarLeft = append(toolbar, $('.centered-chat-popup-toolbar-left'));

		// Add/Attach button (+)
		const attachBtn = append(toolbarLeft, $('.centered-chat-popup-attach-btn'));
		append(attachBtn, $('span.codicon.codicon-add'));
		attachBtn.title = 'Add attachments';
		this.viewDisposables.add(addDisposableListener(attachBtn, 'click', () => fileInput.click()));

		// 1. Provider Select Dropdown
		this.providerSelect = append(toolbarLeft, $('select.centered-chat-provider-select')) as HTMLSelectElement;
		this.viewDisposables.add(addDisposableListener(this.providerSelect, 'change', () => this.handleProviderChange()));

		// 2. Searchable Model Picker Button & Dropdown Container
		const modelPickerWrapper = append(toolbarLeft, $('.centered-chat-model-picker-wrapper'));
		this.modelPickerBtn = append(modelPickerWrapper, $('.centered-chat-model-picker-btn'));
		append(this.modelPickerBtn, $('span.codicon.codicon-hubot'));
		this.modelPickerLabel = append(this.modelPickerBtn, $('span.centered-chat-model-picker-label'));
		this.modelPickerLabel.textContent = 'Select Model';
		append(this.modelPickerBtn, $('span.codicon.codicon-chevron-down'));

		this.viewDisposables.add(addDisposableListener(this.modelPickerBtn, 'click', (e) => {
			e.stopPropagation();
			this.toggleModelDropdown();
		}));

		// Floating Model Dropdown
		this.modelDropdown = append(modelPickerWrapper, $('.centered-chat-model-dropdown'));
		this.modelDropdown.style.display = 'none';

		const searchBoxWrapper = append(this.modelDropdown, $('.centered-chat-model-search-wrapper'));
		append(searchBoxWrapper, $('span.codicon.codicon-search'));
		this.modelSearchInput = append(searchBoxWrapper, $('input.centered-chat-model-search-input')) as HTMLInputElement;
		this.modelSearchInput.placeholder = 'Search models (e.g. flash, sonnet, 4o)...';

		this.viewDisposables.add(addDisposableListener(this.modelSearchInput, 'input', () => {
			this.renderModelList(this.modelSearchInput?.value || '');
		}));

		this.viewDisposables.add(addDisposableListener(this.modelSearchInput, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				this.closeModelDropdown();
			}
		}));

		this.modelListContainer = append(this.modelDropdown, $('.centered-chat-model-list-container'));

		// Close dropdown on click outside
		this.viewDisposables.add(addDisposableListener(document, 'click', (e: MouseEvent) => {
			if (this.isModelDropdownOpen && !modelPickerWrapper.contains(e.target as Node)) {
				this.closeModelDropdown();
			}
		}));

		// Right side of toolbar
		const toolbarRight = append(toolbar, $('.centered-chat-popup-toolbar-right'));

		// Mic button for recording
		this.micBtn = append(toolbarRight, $('.centered-chat-popup-mic-btn'));
		append(this.micBtn, $('span.codicon.codicon-mic'));
		this.micBtn.title = 'Record voice message';
		this.viewDisposables.add(addDisposableListener(this.micBtn, 'mousedown', (e: MouseEvent) => {
			e.preventDefault();
		}));
		this.viewDisposables.add(addDisposableListener(this.micBtn, 'click', () => this.toggleRecording()));

		// Send / Stop button
		this.sendBtn = append(toolbarRight, $('button.centered-chat-popup-send-btn')) as HTMLButtonElement;
		append(this.sendBtn, $('span.codicon.codicon-arrow-right'));
		this.sendBtn.title = 'Send Prompt (Enter)';

		// Event handlers
		this.viewDisposables.add(addDisposableListener(fileInput, 'change', (e: Event) => this.handleFileSelection(e)));
		this.viewDisposables.add(addDisposableListener(this.sendBtn, 'click', () => {
			if (this.isStreaming) {
				this.abortStreaming();
				return;
			}
			if (this.isTranscribing || this.isRecording) {
				return;
			}
			this.sendMessage();
		}));

		// Prevent VS Code keybinding intercepting when typing
		const stopPropagation = (e: KeyboardEvent) => e.stopPropagation();
		this.viewDisposables.add(addDisposableListener(this.inputField, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				if (this.isStreaming || this.isTranscribing || this.isRecording) {
					return;
				}
				this.sendMessage();
			}
		}));
		this.viewDisposables.add(addDisposableListener(this.inputField, 'keyup', stopPropagation));
		this.viewDisposables.add(addDisposableListener(this.inputField, 'keypress', stopPropagation));

		// Drag and Drop
		this.setupDragging(header);

		// Position restores
		this.restorePosition(initialContext?.companionMode, initialContext?.companionPosition);

		// Load Credentials and populate Model Picker
		this.loadCredentialsAndModels();

		// Auto Focus on load and populate pre-filled context
		if (initialContext) {
			if (initialContext.workspaceId || initialContext.ticketId || initialContext.field) {
				this.setContextLocator({
					workspaceId: initialContext.workspaceId,
					ticketId: initialContext.ticketId,
					field: initialContext.field,
					label: initialContext.label,
					fieldType: initialContext.fieldType,
					currentValue: initialContext.currentValue,
					options: initialContext.options,
					hierarchyTree: initialContext.hierarchyTree,
					entityUri: initialContext.entityUri
				});
			}
			if (initialContext.prompt && (!initialContext.field || initialContext.field.startsWith('/Create')) && this.inputField) {
				this.inputField.value = initialContext.prompt;
			}
		}
		this.inputField.focus();
		if (this.inputField.value) {
			const len = this.inputField.value.length;
			this.inputField.setSelectionRange(len, len);
		}
		this.scrollToBottom();
	}

	public hide(): void {
		if (this.element) {
			this.stopRecording();
			this.closeModelDropdown();
			this.closeHistoryDropdown();

			if (this.isZenMode) {
				this.restoreWindowFromZenOnHide();
			}

			// Save the final position and size
			const rect = this.element.getBoundingClientRect();
			const parentRect = this.layoutService.mainContainer.getBoundingClientRect();
			CenteredChatWidget.lastPosition = {
				top: rect.top - parentRect.top,
				left: rect.left - parentRect.left
			};
			CenteredChatWidget.lastSize = {
				width: rect.width,
				height: rect.height
			};

			// Dispose DOM-related stores cleanly
			this.viewDisposables.clear();
			this.modelListDisposables.clear();
			this.attachmentDisposables.clear();
			this.messageDisposables.clear();
			this.historyDisposables.clear();

			this.element.remove();
			this.element = undefined;
			this.messagesContainer = undefined;
			this.historyDropdown = undefined;
			this.inputField = undefined;
			this.attachmentsContainer = undefined;
			this.providerSelect = undefined;
			this.modelPickerBtn = undefined;
			this.modelPickerLabel = undefined;
			this.modelDropdown = undefined;
			this.modelSearchInput = undefined;
			this.modelListContainer = undefined;
			this.micBtn = undefined;
			this.recordingIndicator = undefined;
			this.recordingTimeSpan = undefined;
			this.sendBtn = undefined;
		}
	}

	public toggle(initialContext?: { prompt?: string; workspaceId?: string; ticketId?: string; field?: string; label?: string; fieldType?: string; currentValue?: string; options?: any[]; hierarchyTree?: any[]; companionMode?: boolean; companionPosition?: { left: number; top?: string; width: number; height: number }; entityUri?: string }): void {
		if (this.element) {
			if (initialContext) {
				if (initialContext.workspaceId || initialContext.ticketId || initialContext.field) {
					this.setContextLocator({
						workspaceId: initialContext.workspaceId,
						ticketId: initialContext.ticketId,
						field: initialContext.field,
						label: initialContext.label,
						fieldType: initialContext.fieldType,
						currentValue: initialContext.currentValue,
						options: initialContext.options,
						hierarchyTree: initialContext.hierarchyTree,
						entityUri: initialContext.entityUri
					});
				}
				if (initialContext.prompt && (!initialContext.field || initialContext.field.startsWith('/Create')) && this.inputField) {
					this.inputField.value = initialContext.prompt;
				}
				if (initialContext.companionMode || initialContext.companionPosition) {
					this.restorePosition(initialContext.companionMode, initialContext.companionPosition);
				}
			} else {
				this.hide();
				return;
			}
			this.inputField?.focus();
			if (this.inputField?.value) {
				const len = this.inputField.value.length;
				this.inputField.setSelectionRange(len, len);
			}
			this.scrollToBottom();
		} else {
			this.show(initialContext);
		}
	}

	private loadSessions(): IChatSessionRecord[] {
		try {
			const raw = this.storageService.get(STORAGE_KEY_SESSIONS, StorageScope.PROFILE, '[]');
			return JSON.parse(raw);
		} catch {
			return [];
		}
	}

	private saveSessions(sessions: IChatSessionRecord[]): void {
		try {
			this.storageService.store(STORAGE_KEY_SESSIONS, JSON.stringify(sessions), StorageScope.PROFILE, StorageTarget.USER);
		} catch (err) {
			console.error('Failed to save chat sessions:', err);
		}
	}

	private getOrCreateCurrentSession(initialContext?: { workspaceId?: string; ticketId?: string }): IChatSessionRecord {
		this.sessions = this.loadSessions();
		const savedActiveId = this.storageService.get(STORAGE_KEY_ACTIVE_SESSION, StorageScope.PROFILE, '');
		let session = this.sessions.find(s => s.id === savedActiveId);

		if (!session) {
			session = {
				id: `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				title: initialContext?.ticketId ? `Chat on ${initialContext.ticketId}` : (initialContext?.workspaceId ? `Chat in ${initialContext.workspaceId}` : 'New Conversation'),
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workspaceId: initialContext?.workspaceId,
				ticketId: initialContext?.ticketId,
				messages: []
			};
			this.sessions.unshift(session);
			this.saveSessions(this.sessions);
		}
		this.currentSessionId = session.id;
		this.storageService.store(STORAGE_KEY_ACTIVE_SESSION, session.id, StorageScope.PROFILE, StorageTarget.USER);
		return session;
	}

	private appendMessageToCurrentSession(msg: IChatMessageRecord): void {
		const session = this.sessions.find(s => s.id === this.currentSessionId);
		if (session) {
			session.messages.push(msg);
			session.updatedAt = Date.now();
			if (session.messages.length === 1 && msg.role === 'user') {
				const cleanTitle = msg.content.replace(/^\[.*?\]\s*/g, '').trim().substring(0, 32);
				if (cleanTitle) {
					session.title = cleanTitle;
				}
			}
			this.saveSessions(this.sessions);
		}
	}

	private renderSessionMessages(session: IChatSessionRecord): void {
		if (!this.messagesContainer) { return; }
		this.messageDisposables.clear();
		this.messagesContainer.textContent = '';

		if (session.messages.length === 0) {
			this.addWelcomeMessage();
			return;
		}

		for (const msg of session.messages) {
			if (msg.role === 'user') {
				const userMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-user'));
				if (msg.locatorTag) {
					const locBar = append(userMsg, $('.centered-chat-context-locator-tag-bubble'));
					locBar.textContent = msg.locatorTag;
				}
				const contentSpan = append(userMsg, $('span'));
				contentSpan.textContent = msg.content;

				const userFooter = append(userMsg, $('.centered-chat-msg-footer'));
				userFooter.style.display = 'flex';
				userFooter.style.alignItems = 'center';
				userFooter.style.justifyContent = 'space-between';
				userFooter.style.marginTop = '6px';
				userFooter.style.gap = '8px';

				const timeSpan = append(userFooter, $('.centered-chat-msg-time'));
				timeSpan.textContent = msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

				const copyBtn = append(userFooter, $('button.centered-chat-bubble-copy-btn'));
				copyBtn.title = 'Copy user prompt';
				append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
				const copyLabel = append(copyBtn, $('span'));
				copyLabel.textContent = 'Copy';
				copyBtn.onclick = (e) => {
					e.stopPropagation();
					this.copyToClipboard(msg.content, copyLabel);
				};
			} else {
				const aiMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));
				if (msg.modelBadge) {
					const aiHeader = append(aiMsg, $('.centered-chat-msg-ai-header'));
					const modelBadge = append(aiHeader, $('.centered-chat-msg-model-badge'));
					modelBadge.textContent = msg.modelBadge;
				}
				const aiContent = append(aiMsg, $('.centered-chat-ai-markdown-content'));
				const mdString = new MarkdownString(msg.content || '...');
				mdString.isTrusted = true;
				const rendered = renderMarkdown(mdString, { fillInIncompleteTokens: true });
				this.messageDisposables.add(rendered);
				aiContent.appendChild(rendered.element);
				this.injectCopyButtons(aiContent);

				const aiFooter = append(aiMsg, $('.centered-chat-msg-footer'));
				aiFooter.style.display = 'flex';
				aiFooter.style.alignItems = 'center';
				aiFooter.style.justifyContent = 'space-between';
				aiFooter.style.marginTop = '8px';
				aiFooter.style.gap = '8px';

				const timeSpan = append(aiFooter, $('.centered-chat-msg-time'));
				timeSpan.textContent = msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

				const copyBtn = append(aiFooter, $('button.centered-chat-bubble-copy-btn'));
				copyBtn.title = 'Copy AI response';
				append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
				const copyLabel = append(copyBtn, $('span'));
				copyLabel.textContent = 'Copy';
				copyBtn.onclick = (e) => {
					e.stopPropagation();
					this.copyToClipboard(msg.content, copyLabel);
				};
			}
		}

		this.scrollToBottom();
	}

	private scrollToBottom(): void {
		if (!this.messagesContainer) { return; }
		const doScroll = () => {
			if (this.messagesContainer) {
				this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
			}
		};
		doScroll();
		requestAnimationFrame(() => {
			doScroll();
			setTimeout(doScroll, 50);
			setTimeout(doScroll, 150);
		});
	}

	private startNewSession(): void {
		const newSession: IChatSessionRecord = {
			id: `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
			title: 'New Conversation',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: []
		};
		this.sessions.unshift(newSession);
		this.currentSessionId = newSession.id;
		this.saveSessions(this.sessions);
		this.storageService.store(STORAGE_KEY_ACTIVE_SESSION, newSession.id, StorageScope.PROFILE, StorageTarget.USER);
		this.closeHistoryDropdown();
		this.renderSessionMessages(newSession);
		this.notificationService.info('Started a new conversation');
	}

	private switchSession(sessionId: string): void {
		const session = this.sessions.find(s => s.id === sessionId);
		if (session) {
			this.currentSessionId = session.id;
			this.storageService.store(STORAGE_KEY_ACTIVE_SESSION, session.id, StorageScope.PROFILE, StorageTarget.USER);
			this.closeHistoryDropdown();
			this.renderSessionMessages(session);
		}
	}

	private deleteSession(sessionId: string): void {
		this.sessions = this.sessions.filter(s => s.id !== sessionId);
		this.saveSessions(this.sessions);
		if (this.currentSessionId === sessionId) {
			if (this.sessions.length > 0) {
				this.switchSession(this.sessions[0].id);
			} else {
				this.startNewSession();
			}
		} else {
			this.renderHistoryList();
		}
	}

	private toggleHistoryDropdown(): void {
		if (!this.historyDropdown) { return; }
		this.isHistoryOpen = !this.isHistoryOpen;
		this.historyDropdown.style.display = this.isHistoryOpen ? 'flex' : 'none';
		if (this.isHistoryOpen) {
			this.renderHistoryList();
		}
	}

	private closeHistoryDropdown(): void {
		if (this.historyDropdown) {
			this.isHistoryOpen = false;
			this.historyDropdown.style.display = 'none';
		}
	}

	private renderHistoryList(): void {
		if (!this.historyDropdown) { return; }
		this.historyDisposables.clear();
		this.historyDropdown.textContent = '';

		const header = append(this.historyDropdown, $('.centered-chat-history-header'));
		const title = append(header, $('span'));
		title.textContent = `Chat History (${this.sessions.length})`;

		const clearBtn = append(header, $('button.centered-chat-header-btn'));
		clearBtn.textContent = '+ New Chat';
		clearBtn.onclick = (e) => {
			e.stopPropagation();
			this.startNewSession();
		};

		const list = append(this.historyDropdown, $('.centered-chat-history-list'));
		if (this.sessions.length === 0) {
			const empty = append(list, $('div', { style: 'padding: 16px; text-align: center; font-size: 11px; opacity: 0.5;' }));
			empty.textContent = 'No past conversations';
			return;
		}

		for (const session of this.sessions) {
			const item = append(list, $('.centered-chat-history-item'));
			if (session.id === this.currentSessionId) {
				item.classList.add('active');
			}

			const info = append(item, $('.centered-chat-history-item-info'));
			const titleSpan = append(info, $('.centered-chat-history-item-title'));
			titleSpan.textContent = session.title || 'Untitled Chat';

			const meta = append(info, $('.centered-chat-history-item-meta'));
			const dateStr = new Date(session.updatedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
			meta.textContent = `${dateStr} · ${session.messages.length} msgs`;

			const delBtn = append(item, $('.centered-chat-history-item-delete'));
			append(delBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.trash)));
			delBtn.title = 'Delete conversation';
			delBtn.onclick = (e) => {
				e.stopPropagation();
				this.deleteSession(session.id);
			};

			item.onclick = () => {
				this.switchSession(session.id);
			};
		}
	}

	private async copyToClipboard(text: string, labelSpan?: HTMLElement): Promise<void> {
		try {
			await this.clipboardService.writeText(text);
			if (labelSpan) {
				labelSpan.textContent = '✓ Copied!';
				setTimeout(() => { labelSpan.textContent = 'Copy'; }, 2000);
			}
			this.notificationService.info('Copied to clipboard');
		} catch (err) {
			try {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.focus();
				ta.select();
				document.execCommand('copy');
				ta.remove();
				if (labelSpan) {
					labelSpan.textContent = '✓ Copied!';
					setTimeout(() => { labelSpan.textContent = 'Copy'; }, 2000);
				}
				this.notificationService.info('Copied to clipboard');
			} catch (fallbackErr) {
				console.error('Failed to copy text:', fallbackErr);
			}
		}
	}

	private restorePosition(companionMode?: boolean, companionPosition?: { left: number; top?: string; width: number; height: number }): void {
		if (!this.element) { return; }

		if (companionPosition) {
			this.element.style.width = `${companionPosition.width}px`;
			this.element.style.height = `${companionPosition.height}px`;
			this.element.style.top = companionPosition.top || '50%';
			this.element.style.left = `${companionPosition.left}px`;
			this.element.style.transform = companionPosition.top && companionPosition.top !== '50%' ? 'none' : 'translateY(-50%)';
			return;
		}

		if (companionMode) {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const gap = 12;
			const maxPairWidth = Math.min(1340, vw - 32);
			const leftW = Math.floor((maxPairWidth - gap) * 0.52);
			const rightW = Math.floor((maxPairWidth - gap) * 0.48);
			const startX = Math.max(12, Math.floor((vw - (leftW + gap + rightW)) / 2));
			const targetH = Math.min(800, Math.floor(vh * 0.88));
			const topY = Math.floor((vh - targetH) / 2);

			this.element.style.width = `${rightW}px`;
			this.element.style.height = `${targetH}px`;
			this.element.style.top = `${topY}px`;
			this.element.style.left = `${startX + leftW + gap}px`;
			this.element.style.transform = 'none';
			return;
		}

		if (CenteredChatWidget.lastSize) {
			const w = Math.max(CenteredChatWidget.lastSize.width, 680);
			const h = Math.max(CenteredChatWidget.lastSize.height, 540);
			this.element.style.width = `${w}px`;
			this.element.style.height = `${h}px`;
		} else {
			this.element.style.width = '700px';
			this.element.style.height = '580px';
		}

		if (CenteredChatWidget.lastPosition) {
			this.element.style.top = `${CenteredChatWidget.lastPosition.top}px`;
			this.element.style.left = `${CenteredChatWidget.lastPosition.left}px`;
			this.element.style.transform = 'none';
		} else {
			this.element.style.top = '50%';
			this.element.style.left = '50%';
			this.element.style.transform = 'translate(-50%, -50%)';
		}
	}

	private async loadCredentialsAndModels(): Promise<void> {
		try {
			const allCreds = await this.agentCredentialService.getCredentials();
			this.availableCredentials = allCreds.filter(c => c.isEnabled !== false);

			if (!this.providerSelect) {
				return;
			}

			this.providerSelect.textContent = '';

			if (this.availableCredentials.length === 0) {
				const optNone = document.createElement('option');
				optNone.value = '__none__';
				optNone.textContent = 'No API Keys configured';
				this.providerSelect.appendChild(optNone);
			} else {
				for (const cred of this.availableCredentials) {
					const opt = document.createElement('option');
					opt.value = cred.id;
					opt.textContent = `${cred.name} (${cred.providerId.toUpperCase()})`;
					this.providerSelect.appendChild(opt);
				}
			}

			// Add Settings link option
			const optConfig = document.createElement('option');
			optConfig.value = '__configure__';
			optConfig.textContent = 'Configure API Keys...';
			this.providerSelect.appendChild(optConfig);

			// Match previously selected credential
			const matchedCred = this.availableCredentials.find(c => c.id === this.activeCredentialId);
			if (matchedCred) {
				this.providerSelect.value = matchedCred.id;
			} else if (this.availableCredentials.length > 0) {
				this.activeCredentialId = this.availableCredentials[0].id;
				this.providerSelect.value = this.activeCredentialId;
				this.storageService.store(STORAGE_KEY_CREDENTIAL_ID, this.activeCredentialId, StorageScope.PROFILE, StorageTarget.USER);
			}

			this.updateActiveModelSelection();
		} catch (err) {
			console.error('Failed to load credentials in CenteredChatWidget:', err);
		}
	}

	private handleProviderChange(): void {
		if (!this.providerSelect) { return; }
		const val = this.providerSelect.value;

		if (val === '__configure__') {
			this.openAccountSettings('Models');
			// Revert selection back to active
			if (this.activeCredentialId) {
				this.providerSelect.value = this.activeCredentialId;
			}
			return;
		}

		if (val === '__none__') {
			return;
		}

		this.activeCredentialId = val;
		this.storageService.store(STORAGE_KEY_CREDENTIAL_ID, this.activeCredentialId, StorageScope.PROFILE, StorageTarget.USER);
		this.updateActiveModelSelection(true);
	}

	private getActiveCredential(): IAgentCredential | undefined {
		return this.availableCredentials.find(c => c.id === this.activeCredentialId);
	}

	private getModelsForActiveProvider(): string[] {
		const cred = this.getActiveCredential();
		if (!cred) {
			return [];
		}

		if (cred.cachedModels && cred.cachedModels.length > 0) {
			return cred.cachedModels;
		}

		// Fallback defaults if not cached
		if (cred.providerId === 'gemini') {
			return [
				'gemini-2.5-flash',
				'gemini-2.5-pro',
				'gemini-2.0-flash',
				'gemini-1.5-pro',
				'gemini-1.5-flash'
			];
		} else if (cred.providerId === 'anthropic') {
			return [
				'claude-3-7-sonnet-20250219',
				'claude-3-5-sonnet-20241022',
				'claude-3-5-haiku-20241022',
				'claude-3-opus-20240229'
			];
		} else if (cred.providerId === 'openai') {
			return [
				'gpt-4o',
				'gpt-4o-mini',
				'gpt-4-turbo',
				'o1',
				'o3-mini'
			];
		} else {
			return ['default-model'];
		}
	}

	private updateActiveModelSelection(forceFirst = false): void {
		const models = this.getModelsForActiveProvider();
		if (models.length === 0) {
			this.activeModelId = 'No Model';
		} else if (forceFirst || !this.activeModelId || !models.includes(this.activeModelId)) {
			this.activeModelId = models[0];
			this.storageService.store(STORAGE_KEY_MODEL_ID, this.activeModelId, StorageScope.PROFILE, StorageTarget.USER);
		}

		if (this.modelPickerLabel) {
			this.modelPickerLabel.textContent = this.activeModelId;
			this.modelPickerLabel.title = `Active Model: ${this.activeModelId}`;
		}
	}

	private toggleModelDropdown(): void {
		if (this.isModelDropdownOpen) {
			this.closeModelDropdown();
		} else {
			this.openModelDropdown();
		}
	}

	private openModelDropdown(): void {
		if (!this.modelDropdown || !this.modelSearchInput) { return; }
		this.modelDropdown.style.display = 'flex';
		this.isModelDropdownOpen = true;
		this.modelSearchInput.value = '';
		this.renderModelList('');
		setTimeout(() => this.modelSearchInput?.focus(), 50);
	}

	private closeModelDropdown(): void {
		if (!this.modelDropdown) { return; }
		this.modelDropdown.style.display = 'none';
		this.isModelDropdownOpen = false;
	}

	private renderModelList(filterText: string): void {
		if (!this.modelListContainer) { return; }
		this.modelListDisposables.clear();
		this.modelListContainer.textContent = '';

		const models = this.getModelsForActiveProvider();
		const query = filterText.trim().toLowerCase();
		const filtered = query ? models.filter(m => m.toLowerCase().includes(query)) : models;

		if (filtered.length === 0) {
			const emptyItem = append(this.modelListContainer, $('.centered-chat-model-item.is-empty'));
			emptyItem.textContent = query ? `No models matching "${filterText}"` : 'No models available for provider';
			return;
		}

		const cred = this.getActiveCredential();
		const providerBadgeText = cred ? cred.providerId.toUpperCase() : 'LLM';

		for (const model of filtered) {
			const item = append(this.modelListContainer, $('.centered-chat-model-item'));
			if (model === this.activeModelId) {
				item.classList.add('is-active');
			}

			const left = append(item, $('.centered-chat-model-item-left'));
			const badge = append(left, $('.centered-chat-model-provider-badge'));
			badge.textContent = providerBadgeText;

			const name = append(left, $('.centered-chat-model-name'));
			name.textContent = model;

			if (model === this.activeModelId) {
				const check = append(item, $('span.codicon.codicon-check.centered-chat-model-check'));
				check.setAttribute('aria-hidden', 'true');
			}

			this.modelListDisposables.add(addDisposableListener(item, 'click', (e) => {
				e.stopPropagation();
				this.selectModel(model);
			}));
		}
	}

	private selectModel(model: string): void {
		this.activeModelId = model;
		this.storageService.store(STORAGE_KEY_MODEL_ID, this.activeModelId, StorageScope.PROFILE, StorageTarget.USER);
		if (this.modelPickerLabel) {
			this.modelPickerLabel.textContent = this.activeModelId;
			this.modelPickerLabel.title = `Active Model: ${this.activeModelId}`;
		}
		this.closeModelDropdown();
		this.inputField?.focus();
	}

	private openAccountSettings(initialTab: 'Models' = 'Models'): void {
		const dialog = this.instantiationService.createInstance(AccountManagementDialog);
		dialog.show(initialTab);
	}

	private addWelcomeMessage(): void {
		if (!this.messagesContainer) { return; }
		const welcomeMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));
		const content = append(welcomeMsg, $('span'));

		content.appendChild(document.createTextNode('Welcome to '));
		const bold1 = append(content, $('b'));
		bold1.textContent = 'Agent Central';
		content.appendChild(document.createTextNode('!'));
		append(content, $('br'));
		content.appendChild(document.createTextNode("I'm your workspace AI assistant. Select any configured Provider and Model from the toolbar below to start real streaming chat and code operations."));

		const time = append(welcomeMsg, $('.centered-chat-msg-time'));
		time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	private setupDragging(header: HTMLElement): void {
		this.viewDisposables.add(addDisposableListener(header, 'mousedown', (e: MouseEvent) => {
			if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLOptionElement || (e.target as HTMLElement).closest('.centered-chat-model-picker-wrapper')) {
				return;
			}
			this.isDragging = true;
			this.dragStartX = e.clientX;
			this.dragStartY = e.clientY;

			const rect = this.element!.getBoundingClientRect();
			const parentRect = this.layoutService.mainContainer.getBoundingClientRect();
			this.elementStartX = rect.left - parentRect.left;
			this.elementStartY = rect.top - parentRect.top;

			const onMouseMove = (moveEvent: MouseEvent) => {
				if (!this.isDragging || !this.element) { return; }
				const deltaX = moveEvent.clientX - this.dragStartX;
				const deltaY = moveEvent.clientY - this.dragStartY;

				const maxLeft = parentRect.width - this.element.offsetWidth;
				const maxTop = parentRect.height - this.element.offsetHeight;

				const newLeft = Math.min(Math.max(0, this.elementStartX + deltaX), Math.max(0, maxLeft));
				const newTop = Math.min(Math.max(0, this.elementStartY + deltaY), Math.max(0, maxTop));

				this.element.style.left = `${newLeft}px`;
				this.element.style.top = `${newTop}px`;
				this.element.style.transform = 'none';
			};

			const onMouseUp = () => {
				this.isDragging = false;
				window.removeEventListener('mousemove', onMouseMove);
				window.removeEventListener('mouseup', onMouseUp);
			};

			window.addEventListener('mousemove', onMouseMove);
			window.addEventListener('mouseup', onMouseUp);
		}));
	}

	private handleFileSelection(e: Event): void {
		const target = e.target as HTMLInputElement;
		if (!target.files || target.files.length === 0) { return; }

		for (let i = 0; i < target.files.length; i++) {
			const file = target.files[i];
			const reader = new FileReader();
			reader.onload = () => {
				this.activeAttachments.push({
					name: file.name,
					content: reader.result as string,
					size: file.size,
					url: file.type.startsWith('audio/') || file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
					isAudio: file.type.startsWith('audio/')
				});
				this.renderAttachmentTags();
			};
			reader.readAsDataURL(file);
		}
		target.value = '';
	}

	private renderAttachmentTags(): void {
		if (!this.attachmentsContainer) { return; }
		this.attachmentDisposables.clear();
		this.attachmentsContainer.textContent = '';

		if (this.activeAttachments.length === 0) {
			this.attachmentsContainer.style.display = 'none';
			return;
		}

		this.attachmentsContainer.style.display = 'flex';
		this.activeAttachments.forEach((attach, index) => {
			const tag = append(this.attachmentsContainer!, $('.centered-chat-attachment-tag'));
			append(tag, $('span.codicon.codicon-file'));
			const nameSpan = append(tag, $('span'));
			nameSpan.textContent = attach.name;

			const removeBtn = append(tag, $('.centered-chat-attachment-remove'));
			removeBtn.textContent = '×';
			this.attachmentDisposables.add(addDisposableListener(removeBtn, 'click', () => {
				this.activeAttachments.splice(index, 1);
				this.renderAttachmentTags();
			}));
		});
	}

	private static readonly ANYAGENT_SYSTEM_PROMPT = `You are AnyAgent Workspace Central AI Assistant.
You have direct access to tool capabilities that manage the AnyAgent Workspace & Ticketing System.
When the user gives you a request or when structured context is provided (such as "[Workspace: ... | Ticket: ... | Target: ...]"), you MUST call the appropriate tool(s) to fulfill the operation.

AVAILABLE ANYAGENT TOOLS:
- anyagent_get_ticket_data: Query current ticket values, metadata, field types, allowed workspace statuses, and dynamic list of direct children sub-tickets under it.
- anyagent_query_workspace_tree: Explore and search the hierarchical ticket/job tree of a workspace on-demand with optional parent ticket filter and keyword query.
- anyagent_create_ticket: Create a new sub-entity (job, task, note, resume, workflow, custom types).
- anyagent_delete_ticket: Mark a ticket and its sub-tickets as Removed and clean up references.
- anyagent_update_ticket: Update standard attributes (/Title, /Status, /Description, /Custom/...), or custom card items.
- anyagent_manage_links: Add, remove, or set bidirectional links between tickets (supports 1-to-N, N-to-1, N-to-M).
- anyagent_list_custom_modules: List existing custom modules, Base Primitives catalog, and reusable classes.
- anyagent_generate_custom_module: Synthesize and register a new Custom Module (entity type schema) or update an existing module with Type Definition, Type Prompt, and fields composed from Base Primitives and Reusable Classes.
- anyagent_toggle_custom_module_status: Disable (deactivate) or re-enable an existing custom module so it hides or shows in ticket type options.
- anyagent_delete_custom_module: Permanently delete an existing custom module's YAML schema file.

CRITICAL PARAMETER DISCIPLINE:
When the user context contains a structured tag like [Workspace: <WSP> | Ticket: <TICKET_ID> | Target: <FIELD>] or [Ticket: <TICKET_ID> | Target: <FIELD>]:
- You MUST pass '<TICKET_ID>' verbatim as 'ticket_id' in your tool calls (e.g. if Ticket is 'Init-SW-Developer', pass 'Init-SW-Developer').
- You MUST pass '<WSP>' verbatim as 'workspace_id' if present in the tag. If 'Workspace:' is not present or empty, DO NOT invent a workspace name from the ticket ID! Pass '' or omit workspace_id.
- NEVER split words, alter hyphens, strip prefixes, or invent workspace names from ticket IDs (e.g. NEVER convert 'Init-SW-Developer' into workspace_id='Init' and ticket_id='SW Developer').

WORKLOG INTEGRATION REQUIREMENT:
Whenever performing any mutating tool call (create, update, delete, manage_links), you MUST provide a complete, well-formed 'worklog_record' object:
{
  "user_request": "<clear description of user request>",
  "update_summary": "<concise summary of changes made>",
  "update_details": ["<detailed bullet 1>", "<detailed bullet 2>"],
  "update_conclusion": "<short final verdict e.g. Successfully updated link to FNDJ1-0004>"
}

SUB-TICKET PATH DISAMBIGUATION:
When operating on a sub-ticket (e.g. deleting or updating a child returned in a parent's 'children' list), you MUST pass either:
- The sub-ticket's full path as 'ticket_id' (e.g. ticket_id: "/FNDJ1-0006/FNDJ1-0001"), or
- The 'parent_path' parameter (e.g. parent_path: "/FNDJ1-0006", ticket_id: "FNDJ1-0001").
This guarantees that you operate on the intended child ticket without accidentally targeting top-level tickets.

When user input looks like:
[Workspace: WSP | Ticket: TICKET_ID | Target: /Attributes/Link To | Proposed Value: TARGET_ID]
or:
TICKET_ID > /Attributes/Link To > -> TARGET_ID
You must invoke 'anyagent_manage_links' with action 'add_links' (or 'set_links') from source_ticket_ids [TICKET_ID] to target_ticket_ids [TARGET_ID].

TEXT & TEXTAREA CLEAR / DELETE CONVENTIONS:
When the user targets a text or textarea field (such as /Description, /Custom/Description 1, /Custom/Text Field 1) and:
- 'Proposed Value' is "" (empty string) or (empty), OR
- 'Action' includes 'Clear' or 'Delete' or 'Keep empty', OR
- The user requests to clear, remove, or empty the field content, OR
- The user targets a text/textarea field without providing new content:
1. If the field currently has content, you MUST invoke 'anyagent_update_ticket' with updates: { "<Target>": "" } (an empty string).
2. If the field is already empty, confirm to the user that the field is already empty and no update is needed (or invoke 'anyagent_update_ticket' with updates: { "<Target>": "" }).
3. In ALL these cases, DO NOT ask the user to provide a proposed new value! An empty proposed value IS the desired target state.

CUSTOM MODULES & DATA TYPE SYNTHESIS RULES:
When the user asks you to create, synthesize, design, or generate a new entity type, approval flow form, custom module, or template (e.g. expense reimbursement, contract review, leave request, purchase order, equipment inspection):
1. COMPONENT LIBRARY (BASE PRIMITIVES & REUSABLE CLASSES):
   You have access to the following Base Primitives:
   - 'text': Single-line Input for short strings, titles, codes, monetary sums formatted as string, names.
   - 'textarea': Multiline text for justifications, descriptions, remarks, breakdown notes.
   - 'select': Dropdown menu for single selection. Requires 'options' array of string choices (e.g. ['Travel & Lodging', 'Meals & Entertainment', 'Office Supplies', 'Other']).
   - 'multiselect': Checkboxes for multi-selection. Requires 'options' array of strings.
   - 'switch': Toggle switch for boolean flags (e.g. is_billable, urgent_flag, cfo_review_required).
   - 'date': Single date picker (YYYY-MM-DD).
   - 'time': Single time picker (HH:MM).
   - 'datetime': Single datetime picker.
   - 'date_range': Date range with start and end dates (e.g. travel period, event dates).
   - 'time_range': Time range with start and end times.
   - 'datetime_range': DateTime range.
   - 'dynamic_list': Container (Nested Subfields / Repeatable table). Contains 'itemFields' (array of sub-fields) or 'componentRef' (referencing reusable composite class). Use this whenever repeating items (such as expense line items, invoice lines, task milestones) are needed.
   - 'attachment': File upload for receipts, proof documents, PDF files, and image attachments.
2. SYNTHESIS & EXTRACTION PROCESS:
   From the user's verbal or written description, you MUST extract and construct:
   - 'module_id': Unique kebab-case or snake-case identifier (e.g. 'expense_reimbursement', 'basic_approval_flow').
   - 'module_name': Clear human-readable title (e.g. 'Expense Reimbursement Flow', 'Contract Review Process').
   - 'color': Appropriate hex color code (e.g. '#10b981' for finance/reimbursement, '#3b82f6' for generic approval/process, '#8b5cf6' for workflows, '#f59e0b' for urgent).
   - 'type_definition': Rich explanation of the entity's purpose, business context, lifecycle, and scope based on user instructions.
   - 'type_prompt': Specific AI guidelines & instructions telling subsequent AI agents how to process, validate, calculate, check compliance, and route tickets of this module type.
   - 'fields': Thoughtfully mapped array of fields choosing the best primitives. For approval workflows, always include relevant fields such as approval subject/title, category dropdown, amount/cost, date/period, itemized sub-table ('dynamic_list'), justification ('textarea'), approval flags ('switch'), and attachments for proof documents ('attachment').
   - 'auto_open': Set to true (default) so the Schema Designer immediately opens for the user.

Always explain the result clearly to the user once tool execution completes.`;

	private async getDynamicSystemPrompt(): Promise<string> {
		let prompt = CenteredChatWidget.ANYAGENT_SYSTEM_PROMPT;
		try {
			const workspaces = await this.workspacesExplorerService.getWorkspaces();
			if (workspaces && workspaces.length > 0) {
				const activeTicketId = this.activeContextLocator?.ticketId;
				const wsBlocks: string[] = [];

				for (const w of workspaces) {
					const codeStr = w.code ? ` (Code: ${w.code})` : '';
					const activeStr = w.isCurrent ? ' [CURRENT ACTIVE WORKSPACE]' : '';
					let block = `📁 Workspace "${w.name}"${codeStr}${activeStr}`;

					try {
						// Render ultra-compact ASCII skeleton tree
						const treeView = await this.ticketDataEngine.buildCompactWorkspaceTree(w.uri, activeTicketId, 2);
						block += `\n${treeView}`;
					} catch (treeErr) {
						block += `\n  (Could not read workspace tree: ${treeErr})`;
					}

					wsBlocks.push(block);
				}

				prompt += `\n\n=== ACCESSIBLE WORKSPACES & COMPACT HIERARCHICAL TREES ===
${wsBlocks.join('\n\n')}

CRITICAL WORKSPACE & HIERARCHICAL ENTITY MATCHING RULES:
1. Workspace Resolution: When calling tools such as 'anyagent_create_ticket', you MUST specify a valid 'workspace_id' matching one of the accessible workspaces above (use exact Name or Code). Resolve acoustic STT variants (e.g. "new workspace" -> "neoWorkspace").
2. Parent Ticket Resolution: When a user asks to perform CRUD (create, update, delete, view, link) under or on an existing entity:
   - Match against the hierarchical tree above! For example, "job 0001", "job 1", or "0001" corresponds to the job ticket whose ID ends with "-0001" (e.g. "NEOWO-0001").
   - Set 'parent_path' to the exact Ticket ID (e.g. "NEOWO-0001" or "/NEOWO-0001").
   - NEVER pass an arbitrary folder string like "/job 0001"!
   - If creating at the workspace root, pass "/".
3. On-Demand Tree Exploration: If a branch is deep or collapsed, or if you need to find a ticket by keyword/content, invoke 'anyagent_query_workspace_tree' to search and retrieve the updated sub-tree before acting.
4. Non-existent Entities: If the user refers to a workspace or parent ticket that genuinely does not exist in the list above, STOP and ask the user to clarify, rather than inventing fake folders or creating in the wrong place.`;
			}
		} catch (err) {
			console.warn('Failed to retrieve dynamic workspaces for system prompt:', err);
		}
		return prompt;
	}

	private async sendMessage(): Promise<void> {
		if (this.isStreaming || this.isTranscribing || this.isRecording) { return; }

		const text = this.inputField?.value.trim() || '';
		const hasModifiedLocator = !!(this.activeContextLocator && (
			(this.activeContextLocator.interactiveModifiedValue !== undefined) ||
			this.activeContextLocator.field ||
			this.activeContextLocator.ticketId
		));
		if (!text && this.activeAttachments.length === 0 && !hasModifiedLocator) {
			return;
		}

		if (!this.messagesContainer) { return; }

		// Ensure we have a valid model/credential
		const cred = await this.agentCredentialService.getCredential(this.activeCredentialId);
		if (!cred) {
			this.notificationService.warn('Please select a valid AI Provider & Model in Agent Central first.');
			return;
		}

		const apiKey = await this.agentCredentialService.getApiKey(cred.id);
		if (!apiKey && cred.providerId !== 'ollama' && cred.providerId !== 'custom') {
			this.notificationService.error(`No API Key configured for ${cred.providerId}. Please open Settings (⚙️) to set API key.`);
			return;
		}

		// 1. Render User Message Bubble
		const userMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-user'));
		const userHeader = append(userMsg, $('.centered-chat-msg-user-header'));
		const userBadge = append(userHeader, $('.centered-chat-msg-user-badge'));
		userBadge.textContent = 'You';

		let fullPrompt = text;
		let displayText = text;
		let locatorSummary = '';
		if (this.activeContextLocator && (this.activeContextLocator.workspaceId || this.activeContextLocator.ticketId || this.activeContextLocator.field)) {
			const loc = this.activeContextLocator;
			const locators: string[] = [];
			if (loc.workspaceId) { locators.push(`Workspace: ${loc.workspaceId}`); }
			if (loc.ticketId) { locators.push(`Ticket: ${loc.ticketId}`); }
			if (loc.field) { locators.push(`Target: ${loc.field}`); }

			if (loc.fieldType === 'attachment') {
				let origNames: string[] = [];
				if (loc.currentValue && loc.currentValue !== 'None' && loc.currentValue !== 'null' && loc.currentValue !== 'undefined') {
					if (typeof loc.currentValue === 'string' && loc.currentValue.trim().startsWith('[')) {
						try {
							const parsed = JSON.parse(loc.currentValue);
							if (Array.isArray(parsed)) origNames = parsed.map((p: any) => p.name || String(p));
						} catch { }
					} else {
						origNames = [String(loc.currentValue).trim()];
					}
				}
				let propNames: string[] = [];
				if (loc.interactiveModifiedValue) {
					try {
						const parsed = JSON.parse(loc.interactiveModifiedValue);
						if (Array.isArray(parsed)) propNames = parsed.map((p: any) => p.name || String(p));
					} catch { }
				}
				const added = propNames.filter(n => !origNames.includes(n));
				const removed = origNames.filter(n => !propNames.includes(n));
				const diffParts: string[] = [];
				if (added.length > 0) diffParts.push(`+Added: [${added.join(', ')}]`);
				if (removed.length > 0) diffParts.push(`-Removed: [${removed.join(', ')}]`);
				const diffActionStr = diffParts.join(', ');

				if (diffActionStr) {
					locators.push(`Attachment Action: ${diffActionStr}`);
					locators.push(`Proposed Value: ${loc.interactiveModifiedValue}`);
				} else if (loc.interactiveModifiedValue !== undefined && loc.interactiveModifiedValue !== '') {
					locators.push(`Current Value: ${loc.currentValue}`);
				}

				const fieldLabel = loc.label || loc.field || 'Attachment';
				const prefix = `[${locators.join(' | ')}]\n`;
				fullPrompt = `${prefix}${text || (diffActionStr ? `Please update attachment field '${fieldLabel}': ${diffActionStr}. Update the ticket accordingly and record the change in work_log.md.` : 'Please update this attachment field.')}`;
				displayText = text || (diffActionStr ? `Update ${fieldLabel}: ${diffActionStr}` : `Update ${fieldLabel}`);

				const ctxTag = append(userMsg, $('.centered-chat-msg-context-tag'));
				ctxTag.style.display = 'inline-flex';
				ctxTag.style.alignItems = 'center';
				ctxTag.style.gap = '6px';
				ctxTag.style.fontSize = '9.5px';
				ctxTag.style.opacity = '0.85';
				ctxTag.style.marginBottom = '6px';
				ctxTag.style.background = 'rgba(255,255,255,0.08)';
				ctxTag.style.padding = '2px 6px';
				ctxTag.style.borderRadius = '4px';

				const parts: string[] = [];
				if (loc.workspaceId) { parts.push(loc.workspaceId); }
				if (loc.ticketId) { parts.push(loc.ticketId); }
				if (loc.field) { parts.push(loc.field); }
				if (diffActionStr) {
					parts.push(diffActionStr);
				}
				locatorSummary = parts.join(' › ');
				ctxTag.textContent = locatorSummary;

				this.setContextLocator(null);
			} else {
				const targetNode = this._findNodeByPath(loc.hierarchyTree, loc.field || '');
				if (targetNode && targetNode.children && targetNode.children.length > 0) {
					const firstWithSub = targetNode.children.find((c: any) => c.children && c.children.length > 0);
					if (firstWithSub && firstWithSub.children) {
						const subFieldSpecs = firstWithSub.children.map((f: any) => `${f.label} (${f.fieldType || 'text'})`);
						locators.push(`Schema: [${subFieldSpecs.join(', ')}]`);
					} else if (targetNode.fieldType === 'composite') {
						const subFieldSpecs = targetNode.children.map((f: any) => `${f.label} (${f.fieldType || 'text'})`);
						locators.push(`Item Fields: [${subFieldSpecs.join(', ')}]`);
					}
				}

				const hasOrigContent = !!(loc.currentValue && loc.currentValue.trim() !== '' && loc.currentValue !== 'None' && loc.currentValue !== 'null' && loc.currentValue !== 'undefined');
				const isTextType = loc.fieldType === 'text' || loc.fieldType === 'textarea' || (!loc.fieldType && (loc.field?.includes('Description') || loc.field?.includes('Text') || loc.field?.includes('Title') || loc.field?.includes('Notes')));
				const isExplicitClear = isTextType && (loc.interactiveModifiedValue !== undefined) && (loc.interactiveModifiedValue.trim() === '') && hasOrigContent;
				const isAlreadyEmpty = isTextType && (loc.interactiveModifiedValue !== undefined) && (loc.interactiveModifiedValue.trim() === '') && !hasOrigContent;

				if (isExplicitClear) {
					if (hasOrigContent) {
						locators.push(`Current Value: ${loc.currentValue}`);
					}
					locators.push(`Proposed Value: ""`);
					locators.push(`Action: Clear / Delete field content (set to empty)`);
				} else if (isAlreadyEmpty) {
					locators.push(`Current Value: "" (empty)`);
					locators.push(`Proposed Value: ""`);
					locators.push(`Action: Keep empty / Confirm already empty`);
				} else if (loc.interactiveModifiedValue !== undefined && loc.interactiveModifiedValue.trim() !== '') {
					if (hasOrigContent && loc.interactiveModifiedValue !== loc.currentValue) {
						locators.push(`Current Value: ${loc.currentValue}`);
					}
					if (loc.interactiveModifiedValue !== loc.currentValue) {
						locators.push(`Proposed Value: ${loc.interactiveModifiedValue}`);
					} else {
						locators.push(`Current Value: ${loc.currentValue}`);
					}
				} else if (hasOrigContent) {
					locators.push(`Current Value: ${loc.currentValue}`);
				}

				const fieldLabel = loc.label || loc.field || 'field';
				const prefix = `[${locators.join(' | ')}]\n`;

				let formattedDisplayVal = loc.interactiveModifiedValue || '';
				if (formattedDisplayVal.startsWith('[') && formattedDisplayVal.endsWith(']')) {
					try {
						const parsed = JSON.parse(formattedDisplayVal);
						if (Array.isArray(parsed)) formattedDisplayVal = parsed.join(', ');
					} catch { }
				}

				if (isExplicitClear) {
					fullPrompt = `${prefix}${text || `Please clear the content of '${fieldLabel}', setting it to empty as specified.`}`;
					displayText = text || `Clear ${fieldLabel} (set to empty)`;
				} else if (isAlreadyEmpty) {
					fullPrompt = `${prefix}${text || `The field '${fieldLabel}' is already empty and the proposed value is empty. If no other instruction is provided, please confirm it remains empty without asking for a new value.`}`;
					displayText = text || `Confirm ${fieldLabel} is empty`;
				} else if (loc.interactiveModifiedValue !== undefined && loc.interactiveModifiedValue.trim() !== '' && loc.interactiveModifiedValue !== loc.currentValue) {
					fullPrompt = `${prefix}${text || `Please update '${fieldLabel}' to the proposed value.`}`;
					displayText = text || (text ? text : `Update ${fieldLabel} to "${formattedDisplayVal.length > 40 ? formattedDisplayVal.substring(0, 40) + '...' : formattedDisplayVal}"`);
				} else {
					fullPrompt = `${prefix}${text || 'Please update this field as specified.'}`;
					displayText = text || (loc.field && loc.interactiveModifiedValue ? `Update ${loc.field} to ${formattedDisplayVal}` : (text || 'Update field as specified.'));
				}

				// Render nice context tag pill above the user text in the bubble
				const ctxTag = append(userMsg, $('.centered-chat-msg-context-tag'));
				ctxTag.style.display = 'inline-flex';
				ctxTag.style.alignItems = 'center';
				ctxTag.style.gap = '6px';
				ctxTag.style.fontSize = '9.5px';
				ctxTag.style.opacity = '0.85';
				ctxTag.style.marginBottom = '6px';
				ctxTag.style.background = 'rgba(255,255,255,0.08)';
				ctxTag.style.padding = '2px 6px';
				ctxTag.style.borderRadius = '4px';

				const parts: string[] = [];
				if (loc.workspaceId) { parts.push(loc.workspaceId); }
				if (loc.ticketId) { parts.push(loc.ticketId); }
				if (loc.field) { parts.push(loc.field); }
				if (isExplicitClear) {
					parts.push(`-> (cleared)`);
				} else if (isAlreadyEmpty) {
					parts.push(`-> (empty)`);
				} else if (loc.interactiveModifiedValue && loc.interactiveModifiedValue !== loc.currentValue) {
					let tagVal = loc.interactiveModifiedValue;
					if (tagVal.startsWith('[') && tagVal.endsWith(']')) {
						try {
							const parsed = JSON.parse(tagVal);
							if (Array.isArray(parsed)) tagVal = parsed.join(', ');
						} catch { }
					}
					parts.push(`-> ${tagVal}`);
				}
				locatorSummary = parts.join(' › ');
				ctxTag.textContent = locatorSummary;

				// Clear locator for subsequent messages
				this.setContextLocator(null);
			}
		}

		if (this.activeAttachments.length > 0) {
			this.activeAttachments.forEach(att => {
				const attachmentLabel = append(userMsg, $('div'));
				attachmentLabel.style.fontSize = '9px';
				attachmentLabel.style.opacity = '0.7';
				attachmentLabel.style.marginBottom = '4px';
				attachmentLabel.style.fontWeight = 'bold';
				attachmentLabel.textContent = `Attached: ${att.name}`;
			});
		}

		if (displayText) {
			const promptContent = append(userMsg, $('span'));
			promptContent.textContent = displayText;
		}

		// Collapsible Prompt Inspector (Click to expand Full System Prompt & Tools)
		const promptInspector = append(userMsg, document.createElement('details'));
		promptInspector.className = 'centered-chat-prompt-inspector';

		const summary = append(promptInspector, document.createElement('summary'));
		summary.className = 'centered-chat-prompt-summary';
		summary.textContent = '🔍 View Injected System Prompt & Tools (Full Trace)';

		const promptBody = append(promptInspector, $('.centered-chat-prompt-body'));

		const dynamicSystemPrompt = await this.getDynamicSystemPrompt();
		const promptSectionTitle = append(promptBody, $('.centered-chat-prompt-section-title'));
		promptSectionTitle.textContent = 'System Prompt:';
		const sysPromptPre = append(promptBody, $('pre.centered-chat-prompt-pre'));
		sysPromptPre.textContent = dynamicSystemPrompt;

		const payloadTitle = append(promptBody, $('.centered-chat-prompt-section-title'));
		payloadTitle.textContent = 'User Payload Sent to LLM:';
		const payloadPre = append(promptBody, $('pre.centered-chat-prompt-pre'));
		payloadPre.textContent = fullPrompt;

		const copyFullPromptBtn = append(promptBody, $('button.centered-chat-copy-full-prompt-btn'));
		copyFullPromptBtn.textContent = '📋 Copy Complete Prompt & System Context';
		copyFullPromptBtn.onclick = (e) => {
			e.stopPropagation();
			const fullTraceText = `=== SYSTEM PROMPT ===\n${dynamicSystemPrompt}\n\n=== USER PAYLOAD ===\n${fullPrompt}`;
			this.copyToClipboard(fullTraceText);
		};

		// User Message Footer with Time and Bottom Copy Button
		const userFooter = append(userMsg, $('.centered-chat-msg-footer'));
		userFooter.style.display = 'flex';
		userFooter.style.alignItems = 'center';
		userFooter.style.justifyContent = 'space-between';
		userFooter.style.marginTop = '6px';
		userFooter.style.gap = '8px';

		const userTime = append(userFooter, $('.centered-chat-msg-time'));
		const userTimeFormatted = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		userTime.textContent = userTimeFormatted;

		const userCopyBtn = append(userFooter, $('button.centered-chat-bubble-copy-btn'));
		userCopyBtn.title = 'Copy user prompt';
		append(userCopyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
		const userCopyLabel = append(userCopyBtn, $('span'));
		userCopyLabel.textContent = 'Copy';
		userCopyBtn.onclick = (e) => {
			e.stopPropagation();
			this.copyToClipboard(fullPrompt, userCopyLabel);
		};

		// Append user message to active session
		this.appendMessageToCurrentSession({
			role: 'user',
			content: fullPrompt,
			timestamp: userTimeFormatted,
			locatorTag: locatorSummary || undefined
		});

		// Clear inputs
		if (this.inputField) {
			this.inputField.value = '';
		}
		this.activeAttachments = [];
		this.renderAttachmentTags();
		if (this.messagesContainer) {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}

		// 2. Start Real Streaming Response
		await this.startStreamingResponse(fullPrompt, cred, apiKey);
	}

	private async startStreamingResponse(prompt: string, cred: IAgentCredential, apiKey: string | undefined): Promise<void> {
		if (!this.messagesContainer) { return; }

		this.isStreaming = true;
		this.activeCts = new CancellationTokenSource();
		this.setStreamingButtonState(true);

		const streamSessionDisposables = new DisposableStore();

		// Render AI Message Bubble
		const aiMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));

		const aiHeader = append(aiMsg, $('.centered-chat-msg-ai-header'));
		const modelBadge = append(aiHeader, $('.centered-chat-msg-model-badge'));
		modelBadge.textContent = `${this.activeModelId} (${cred.providerId.toUpperCase()})`;

		const aiContent = append(aiMsg, $('.centered-chat-ai-markdown-content'));
		const typingCursor = append(aiContent, $('span.centered-chat-typing-cursor'));
		typingCursor.textContent = '▊';

		let fullResponseText = '';
		let animationFrameId: number | null = null;
		let isUserScrolledUp = false;
		let streamRenderDisposable: IDisposable | null = null;

		const scrollHandler = () => {
			if (!this.messagesContainer) { return; }
			const isAtBottom = this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop - this.messagesContainer.clientHeight < 30;
			isUserScrolledUp = !isAtBottom;
		};
		streamSessionDisposables.add(addDisposableListener(this.messagesContainer, 'scroll', scrollHandler));

		const flushRender = (isFinal = false) => {
			animationFrameId = null;

			// Clean up previous rendered markdown
			if (streamRenderDisposable) {
				streamRenderDisposable.dispose();
				streamRenderDisposable = null;
			}
			aiContent.textContent = '';

			const mdString = new MarkdownString(fullResponseText || '...');
			mdString.isTrusted = true;
			const rendered = renderMarkdown(mdString, { fillInIncompleteTokens: true });
			if (isFinal) {
				this.messageDisposables.add(rendered);
			} else {
				streamRenderDisposable = rendered;
			}
			aiContent.appendChild(rendered.element);

			if (this.isStreaming) {
				aiContent.appendChild(typingCursor);
			}

			if (!isUserScrolledUp && this.messagesContainer) {
				this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
			}
		};

		const onToken = (delta: string) => {
			fullResponseText += delta;
			if (!animationFrameId) {
				animationFrameId = requestAnimationFrame(() => flushRender(false));
			}
		};

		try {
			await this.executeLlmStreamRequest({
				providerId: cred.providerId,
				modelId: this.activeModelId,
				prompt,
				apiKey: apiKey || '',
				customUrl: cred.customUrl,
				cancellationTokenSource: this.activeCts,
				onToken
			});
		} catch (err: any) {
			if (this.activeCts.token.isCancellationRequested) {
				fullResponseText += '\n\n*(Generation stopped by user)*';
			} else {
				console.error('Streaming request error:', err);
				fullResponseText += `\n\n**Error:** ${err.message || err}`;
			}
		} finally {
			if (animationFrameId) {
				cancelAnimationFrame(animationFrameId);
				animationFrameId = null;
			}
			if (streamRenderDisposable) {
				(streamRenderDisposable as any).dispose();
				streamRenderDisposable = null;
			}
			streamSessionDisposables.dispose();
			this.isStreaming = false;
			this.activeCts.dispose();
			this.activeCts = null;
			this.setStreamingButtonState(false);

			// Final flush and register in message store
			flushRender(true);
			try {
				typingCursor.remove();
			} catch { }
			this.injectCopyButtons(aiContent);

			// AI Message Footer with Time and Bottom Copy Button
			const aiFooter = append(aiMsg, $('.centered-chat-msg-footer'));
			aiFooter.style.display = 'flex';
			aiFooter.style.alignItems = 'center';
			aiFooter.style.justifyContent = 'space-between';
			aiFooter.style.marginTop = '8px';
			aiFooter.style.gap = '8px';

			const aiTime = append(aiFooter, $('.centered-chat-msg-time'));
			const aiTimeFormatted = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			aiTime.textContent = aiTimeFormatted;

			const aiCopyBtn = append(aiFooter, $('button.centered-chat-bubble-copy-btn'));
			aiCopyBtn.title = 'Copy entire AI response';
			append(aiCopyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));
			const aiCopyLabel = append(aiCopyBtn, $('span'));
			aiCopyLabel.textContent = 'Copy';
			aiCopyBtn.onclick = (e) => {
				e.stopPropagation();
				this.copyToClipboard(fullResponseText, aiCopyLabel);
			};

			// Append AI message to active session
			this.appendMessageToCurrentSession({
				role: 'assistant',
				content: fullResponseText,
				timestamp: aiTimeFormatted,
				modelBadge: `${this.activeModelId} (${cred.providerId.toUpperCase()})`
			});

			if (this.messagesContainer) {
				this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
			}
			this.inputField?.focus();
		}
	}

	private getAnthropicTools(): any[] {
		const toolIds = [
			'anyagent_get_ticket_data',
			'anyagent_query_workspace_tree',
			'anyagent_create_ticket',
			'anyagent_delete_ticket',
			'anyagent_update_ticket',
			'anyagent_manage_links',
			'anyagent_list_custom_modules',
			'anyagent_generate_custom_module',
			'anyagent_toggle_custom_module_status',
			'anyagent_delete_custom_module'
		];
		const tools: any[] = [];
		for (const id of toolIds) {
			const tool = this.languageModelToolsService.getTool(id);
			if (tool) {
				tools.push({
					name: tool.id,
					description: tool.modelDescription || tool.userDescription || tool.displayName,
					input_schema: tool.inputSchema || { type: 'object', properties: {} }
				});
			}
		}
		return tools;
	}

	private getOpenAITools(): any[] {
		const toolIds = [
			'anyagent_get_ticket_data',
			'anyagent_query_workspace_tree',
			'anyagent_create_ticket',
			'anyagent_delete_ticket',
			'anyagent_update_ticket',
			'anyagent_manage_links',
			'anyagent_list_custom_modules',
			'anyagent_generate_custom_module',
			'anyagent_toggle_custom_module_status',
			'anyagent_delete_custom_module'
		];
		const tools: any[] = [];
		for (const id of toolIds) {
			const tool = this.languageModelToolsService.getTool(id);
			if (tool) {
				tools.push({
					type: 'function',
					function: {
						name: tool.id,
						description: tool.modelDescription || tool.userDescription || tool.displayName,
						parameters: tool.inputSchema || { type: 'object', properties: {} }
					}
				});
			}
		}
		return tools;
	}

	private getGeminiTools(): any[] {
		const toolIds = [
			'anyagent_get_ticket_data',
			'anyagent_query_workspace_tree',
			'anyagent_create_ticket',
			'anyagent_delete_ticket',
			'anyagent_update_ticket',
			'anyagent_manage_links',
			'anyagent_list_custom_modules',
			'anyagent_generate_custom_module',
			'anyagent_toggle_custom_module_status',
			'anyagent_delete_custom_module'
		];
		const declarations: any[] = [];
		for (const id of toolIds) {
			const tool = this.languageModelToolsService.getTool(id);
			if (tool) {
				declarations.push({
					name: tool.id,
					description: tool.modelDescription || tool.userDescription || tool.displayName,
					parameters: tool.inputSchema || { type: 'object', properties: {} }
				});
			}
		}
		return declarations.length > 0 ? [{ function_declarations: declarations }] : [];
	}

	private async extractResponseErrorMessage(response: any, providerName: string): Promise<string> {
		let rawBody = '';
		try {
			await new Promise<void>((resolve) => {
				listenStream(response.stream, {
					onData: (chunk: VSBuffer) => { rawBody += chunk.toString(); },
					onError: () => resolve(),
					onEnd: () => resolve()
				});
			});
		} catch { }

		let detailed = '';
		if (rawBody) {
			try {
				const json = JSON.parse(rawBody);
				if (json.error?.message) {
					detailed = json.error.message;
				} else if (typeof json.error === 'string') {
					detailed = json.error;
				} else if (json.message) {
					detailed = json.message;
				}
			} catch {
				detailed = rawBody.slice(0, 300);
			}
		}

		return detailed
			? `HTTP ${response.res.statusCode} Error from ${providerName}: ${detailed}`
			: `HTTP ${response.res.statusCode} Error from ${providerName}.`;
	}

	private async executeLlmStreamRequest(options: {
		providerId: string;
		modelId: string;
		prompt: string;
		apiKey: string;
		customUrl?: string;
		cancellationTokenSource: CancellationTokenSource;
		onToken: (token: string) => void;
	}): Promise<void> {
		const { providerId, modelId, prompt, apiKey, customUrl, cancellationTokenSource, onToken } = options;
		const sanitizedModel = modelId.replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-').trim();

		const systemPrompt = await this.getDynamicSystemPrompt();
		const maxTurns = 5;

		if (providerId === 'anthropic') {
			let messages: any[] = [{ role: 'user', content: prompt }];
			const tools = this.getAnthropicTools();
			const cleanModel = sanitizedModel || 'claude-3-5-sonnet-20241022';
			const url = 'https://api.anthropic.com/v1/messages';
			const headers = {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			};

			for (let turn = 0; turn < maxTurns; turn++) {
				if (cancellationTokenSource.token.isCancellationRequested) break;

				const data = JSON.stringify({
					model: cleanModel,
					max_tokens: 4096,
					stream: true,
					system: systemPrompt,
					messages,
					tools: tools.length > 0 ? tools : undefined
				});

				const pendingToolUses: { id: string; name: string; inputJson: string }[] = [];
				let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
				let currentText = '';

				const response = await this.requestService.request({
					type: 'POST',
					url,
					headers,
					data,
					callSite: 'centeredChat.streamLlm'
				}, cancellationTokenSource.token);

				if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
					const errMsg = await this.extractResponseErrorMessage(response, 'ANTHROPIC API');
					throw new Error(errMsg);
				}

				await new Promise<void>((resolve, reject) => {
					const streamDisposables = new DisposableStore();
					streamDisposables.add(cancellationTokenSource.token.onCancellationRequested(() => {
						streamDisposables.dispose();
						resolve();
					}));

					let buffer = '';
					listenStream(response.stream, {
						onData: (chunk: VSBuffer) => {
							buffer += chunk.toString();
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								const trimmed = line.trim();
								if (trimmed.startsWith('data: ')) {
									const dataStr = trimmed.slice(6).trim();
									if (dataStr === '[DONE]') continue;
									try {
										const json = JSON.parse(dataStr);
										if (json.type === 'content_block_start') {
											if (json.content_block?.type === 'tool_use') {
												currentToolUse = {
													id: json.content_block.id,
													name: json.content_block.name,
													inputJson: ''
												};
											}
										} else if (json.type === 'content_block_delta') {
											if (json.delta?.type === 'text_delta' && json.delta.text) {
												currentText += json.delta.text;
												onToken(json.delta.text);
											} else if (json.delta?.type === 'input_json_delta' && json.delta.partial_json) {
												if (currentToolUse) {
													currentToolUse.inputJson += json.delta.partial_json;
												}
											}
										} else if (json.type === 'content_block_stop') {
											if (currentToolUse) {
												pendingToolUses.push(currentToolUse);
												currentToolUse = null;
											}
										}
									} catch { }
								}
							}
						},
						onError: (err) => { streamDisposables.dispose(); reject(err); },
						onEnd: () => { streamDisposables.dispose(); resolve(); }
					}, cancellationTokenSource.token);
				});

				if (pendingToolUses.length === 0) {
					break;
				}

				const assistantBlocks: any[] = [];
				if (currentText) {
					assistantBlocks.push({ type: 'text', text: currentText });
				}
				for (const tu of pendingToolUses) {
					let parsedInput: any = {};
					try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { }
					assistantBlocks.push({
						type: 'tool_use',
						id: tu.id,
						name: tu.name,
						input: parsedInput
					});
				}
				messages.push({ role: 'assistant', content: assistantBlocks });

				const toolResultBlocks: any[] = [];
				for (const tu of pendingToolUses) {
					let parsedInput: any = {};
					try { parsedInput = JSON.parse(tu.inputJson || '{}'); } catch { }

					const formattedArgs = JSON.stringify(parsedInput, null, 2);
					onToken(`\n\n> ⚙️ **AI Invoking Tool:** \`${tu.name}\`\n>\n> **Parameters:**\n> \`\`\`json\n> ${formattedArgs.split('\n').join('\n> ')}\n> \`\`\`\n`);
					let resultContent = '';
					try {
						const result = await this.languageModelToolsService.invokeTool(
							{ callId: tu.id, toolId: tu.name, parameters: parsedInput, context: undefined },
							async (t) => Math.ceil(t.length / 4),
							cancellationTokenSource.token
						);
						const toolMsg = typeof result.toolResultMessage === 'string' ? result.toolResultMessage : result.toolResultMessage?.value;
						resultContent = result.content?.map(c => (c as any).value).join('\n') || toolMsg || (result.toolResultError ? `Error: ${result.toolResultError}` : 'Success');

						let prettyResult = resultContent;
						try {
							const parsed = JSON.parse(resultContent);
							prettyResult = JSON.stringify(parsed, null, 2);
						} catch { }
						onToken(`>\n> **Result:**\n> \`\`\`json\n> ${prettyResult.split('\n').join('\n> ')}\n> \`\`\`\n> ✅ **Tool Completed Successfully**\n\n`);
					} catch (err: any) {
						resultContent = `Tool execution error: ${err.message || String(err)}`;
						onToken(`>\n> ❌ **Tool Error:** ${err.message || String(err)}\n\n`);
					}

					toolResultBlocks.push({
						type: 'tool_result',
						tool_use_id: tu.id,
						content: resultContent
					});
				}
				messages.push({ role: 'user', content: toolResultBlocks });
			}
		} else if (providerId === 'gemini') {
			let contents: any[] = [{ role: 'user', parts: [{ text: prompt }] }];
			const tools = this.getGeminiTools();
			const cleanModel = sanitizedModel || 'gemini-1.5-flash';
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
			const headers = { 'Content-Type': 'application/json' };

			for (let turn = 0; turn < maxTurns; turn++) {
				if (cancellationTokenSource.token.isCancellationRequested) break;

				const data = JSON.stringify({
					contents,
					system_instruction: { parts: [{ text: systemPrompt }] },
					tools: tools.length > 0 ? tools : undefined
				});

				const functionCalls: { name: string; args: any }[] = [];
				let currentText = '';

				const response = await this.requestService.request({
					type: 'POST',
					url,
					headers,
					data,
					callSite: 'centeredChat.streamLlm'
				}, cancellationTokenSource.token);

				if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
					const errMsg = await this.extractResponseErrorMessage(response, 'GEMINI API');
					throw new Error(errMsg);
				}

				await new Promise<void>((resolve, reject) => {
					const streamDisposables = new DisposableStore();
					streamDisposables.add(cancellationTokenSource.token.onCancellationRequested(() => {
						streamDisposables.dispose();
						resolve();
					}));

					let buffer = '';
					listenStream(response.stream, {
						onData: (chunk: VSBuffer) => {
							buffer += chunk.toString();
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								const trimmed = line.trim();
								if (trimmed.startsWith('data: ')) {
									const dataStr = trimmed.slice(6).trim();
									if (dataStr === '[DONE]') continue;
									try {
										const json = JSON.parse(dataStr);
										const candidate = json.candidates?.[0];
										const parts = candidate?.content?.parts;
										if (parts && Array.isArray(parts)) {
											for (const p of parts) {
												if (p.text) {
													currentText += p.text;
													onToken(p.text);
												}
												if (p.functionCall) {
													functionCalls.push({
														name: p.functionCall.name,
														args: p.functionCall.args || {}
													});
												}
											}
										}
									} catch { }
								}
							}
						},
						onError: (err) => { streamDisposables.dispose(); reject(err); },
						onEnd: () => { streamDisposables.dispose(); resolve(); }
					}, cancellationTokenSource.token);
				});

				if (functionCalls.length === 0) {
					break;
				}

				contents.push({
					role: 'model',
					parts: [
						...(currentText ? [{ text: currentText }] : []),
						...functionCalls.map(fc => ({ functionCall: { name: fc.name, args: fc.args } }))
					]
				});

				const responseParts: any[] = [];
				for (const fc of functionCalls) {
					const formattedArgs = JSON.stringify(fc.args || {}, null, 2);
					onToken(`\n\n> ⚙️ **AI Invoking Tool:** \`${fc.name}\`\n>\n> **Parameters:**\n> \`\`\`json\n> ${formattedArgs.split('\n').join('\n> ')}\n> \`\`\`\n`);
					let resultContent: any = {};
					try {
						const result = await this.languageModelToolsService.invokeTool(
							{ callId: `gemini_${Date.now()}`, toolId: fc.name, parameters: fc.args, context: undefined },
							async (t) => Math.ceil(t.length / 4),
							cancellationTokenSource.token
						);
						const toolMsg = typeof result.toolResultMessage === 'string' ? result.toolResultMessage : result.toolResultMessage?.value;
						const textVal = result.content?.map(c => (c as any).value).join('\n') || toolMsg || (result.toolResultError ? `Error: ${result.toolResultError}` : 'Success');
						try { resultContent = JSON.parse(textVal); } catch { resultContent = { response: textVal }; }

						const prettyResult = JSON.stringify(resultContent, null, 2);
						onToken(`>\n> **Result:**\n> \`\`\`json\n> ${prettyResult.split('\n').join('\n> ')}\n> \`\`\`\n> ✅ **Tool Completed Successfully**\n\n`);
					} catch (err: any) {
						resultContent = { error: err.message || String(err) };
						onToken(`>\n> ❌ **Tool Error:** ${err.message || String(err)}\n\n`);
					}

					responseParts.push({
						functionResponse: {
							name: fc.name,
							response: resultContent
						}
					});
				}

				contents.push({
					role: 'user',
					parts: responseParts
				});
			}
		} else {
			// OpenAI & Custom-OpenAI
			let messages: any[] = [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt }
			];
			const tools = this.getOpenAITools();
			const baseEndpoint = customUrl || 'https://api.openai.com/v1';
			const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '');
			const url = `${cleanBase}/chat/completions`;
			const headers = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			};

			for (let turn = 0; turn < maxTurns; turn++) {
				if (cancellationTokenSource.token.isCancellationRequested) break;

				const data = JSON.stringify({
					model: sanitizedModel || 'gpt-4o',
					stream: true,
					messages,
					tools: tools.length > 0 ? tools : undefined
				});

				const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
				let currentText = '';

				const response = await this.requestService.request({
					type: 'POST',
					url,
					headers,
					data,
					callSite: 'centeredChat.streamLlm'
				}, cancellationTokenSource.token);

				if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
					const errMsg = await this.extractResponseErrorMessage(response, 'OPENAI API');
					throw new Error(errMsg);
				}

				await new Promise<void>((resolve, reject) => {
					const streamDisposables = new DisposableStore();
					streamDisposables.add(cancellationTokenSource.token.onCancellationRequested(() => {
						streamDisposables.dispose();
						resolve();
					}));

					let buffer = '';
					listenStream(response.stream, {
						onData: (chunk: VSBuffer) => {
							buffer += chunk.toString();
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								const trimmed = line.trim();
								if (trimmed.startsWith('data: ')) {
									const dataStr = trimmed.slice(6).trim();
									if (dataStr === '[DONE]') continue;
									try {
										const json = JSON.parse(dataStr);
										const delta = json.choices?.[0]?.delta;
										if (delta?.content) {
											currentText += delta.content;
											onToken(delta.content);
										}
										if (delta?.tool_calls) {
											for (const tc of delta.tool_calls) {
												const idx = tc.index ?? 0;
												const entry = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' };
												if (tc.id) entry.id = tc.id;
												if (tc.function?.name) entry.name += tc.function.name;
												if (tc.function?.arguments) entry.arguments += tc.function.arguments;
												toolCallsMap.set(idx, entry);
											}
										}
									} catch { }
								}
							}
						},
						onError: (err) => { streamDisposables.dispose(); reject(err); },
						onEnd: () => { streamDisposables.dispose(); resolve(); }
					}, cancellationTokenSource.token);
				});

				if (toolCallsMap.size === 0) {
					break;
				}

				const toolCalls = Array.from(toolCallsMap.values()).map(tc => ({
					id: tc.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					type: 'function' as const,
					function: { name: tc.name, arguments: tc.arguments }
				}));

				messages.push({
					role: 'assistant',
					content: currentText || '',
					tool_calls: toolCalls
				});

				for (const tc of toolCalls) {
					let parsedArgs: any = {};
					try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch { }

					const formattedArgs = JSON.stringify(parsedArgs, null, 2);
					onToken(`\n\n> ⚙️ **AI Invoking Tool:** \`${tc.function.name}\`\n>\n> **Parameters:**\n> \`\`\`json\n> ${formattedArgs.split('\n').join('\n> ')}\n> \`\`\`\n`);
					let resultContent = '';
					try {
						const result = await this.languageModelToolsService.invokeTool(
							{ callId: tc.id, toolId: tc.function.name, parameters: parsedArgs, context: undefined },
							async (t) => Math.ceil(t.length / 4),
							cancellationTokenSource.token
						);
						const toolMsg = typeof result.toolResultMessage === 'string' ? result.toolResultMessage : result.toolResultMessage?.value;
						resultContent = result.content?.map(c => (c as any).value).join('\n') || toolMsg || (result.toolResultError ? `Error: ${result.toolResultError}` : 'Success');

						let prettyResult = resultContent;
						try {
							const parsed = JSON.parse(resultContent);
							prettyResult = JSON.stringify(parsed, null, 2);
						} catch { }
						onToken(`>\n> **Result:**\n> \`\`\`json\n> ${prettyResult.split('\n').join('\n> ')}\n> \`\`\`\n> ✅ **Tool Completed Successfully**\n\n`);
					} catch (err: any) {
						resultContent = `Tool execution error: ${err.message || String(err)}`;
						onToken(`>\n> ❌ **Tool Error:** ${err.message || String(err)}\n\n`);
					}

					messages.push({
						role: 'tool',
						tool_call_id: tc.id,
						content: resultContent
					});
				}
			}
		}
	}

	private abortStreaming(): void {
		if (this.activeCts) {
			this.activeCts.cancel();
		}
	}

	private updateSendButtonState(): void {
		if (!this.sendBtn) { return; }
		this.sendBtn.textContent = '';
		if (this.isStreaming) {
			this.sendBtn.disabled = false;
			this.sendBtn.classList.remove('disabled', 'is-transcribing');
			this.sendBtn.classList.add('is-streaming');
			this.sendBtn.title = 'Stop Generating (Click to Abort)';
			append(this.sendBtn, $('span.codicon.codicon-primitive-square'));
		} else if (this.isTranscribing) {
			this.sendBtn.disabled = true;
			this.sendBtn.classList.remove('is-streaming');
			this.sendBtn.classList.add('disabled', 'is-transcribing');
			this.sendBtn.title = 'Transcribing voice input... Please wait';
			append(this.sendBtn, $('span.codicon.codicon-loading.codicon-modifier-spin'));
		} else if (this.isRecording) {
			this.sendBtn.disabled = true;
			this.sendBtn.classList.remove('is-streaming', 'is-transcribing');
			this.sendBtn.classList.add('disabled');
			this.sendBtn.title = 'Recording voice... Finish recording first';
			append(this.sendBtn, $('span.codicon.codicon-arrow-right'));
		} else {
			this.sendBtn.disabled = false;
			this.sendBtn.classList.remove('is-streaming', 'disabled', 'is-transcribing');
			this.sendBtn.title = 'Send Prompt (Enter)';
			append(this.sendBtn, $('span.codicon.codicon-arrow-right'));
		}
	}

	private setStreamingButtonState(isStreaming: boolean): void {
		this.isStreaming = isStreaming;
		this.updateSendButtonState();
	}

	private injectCopyButtons(container: HTMLElement): void {
		const codeBlocks = container.querySelectorAll('pre');
		codeBlocks.forEach(pre => {
			if (pre.querySelector('.centered-chat-copy-code-btn')) {
				return;
			}
			const copyBtn = document.createElement('button');
			copyBtn.className = 'centered-chat-copy-code-btn';
			copyBtn.textContent = 'Copy';
			copyBtn.title = 'Copy code to clipboard';
			copyBtn.onclick = (e) => {
				e.stopPropagation();
				const code = pre.querySelector('code')?.innerText || pre.innerText;
				navigator.clipboard.writeText(code).then(() => {
					copyBtn.textContent = 'Copied!';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
				});
			};
			pre.style.position = 'relative';
			pre.appendChild(copyBtn);
		});
	}

	private toggleRecording(): void {
		if (this.isRecording) {
			this.stopRecording();
		} else {
			const activeEl = document.activeElement;
			if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
				this.recordLastActiveEditable(activeEl);
			}
			this.startRecording();
		}
	}

	private async startRecording(): Promise<void> {
		const activeEl = document.activeElement;
		if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
			this.recordLastActiveEditable(activeEl);
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			this.audioChunks = [];
			this.mediaRecorder = new (window as any).MediaRecorder(stream);

			this.mediaRecorder.ondataavailable = (e: any) => {
				if (e.data && e.data.size > 0) {
					this.audioChunks.push(e.data);
				}
			};

			this.mediaRecorder.onstop = async () => {
				this.isTranscribing = true;
				this.updateSendButtonState();

				const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
				const audioUrl = URL.createObjectURL(audioBlob);
				const duration = this.recordingSeconds;

				// Determine target input element: last active focused input (e.g. locator textarea/input) or main chat inputField
				let targetEl: HTMLInputElement | HTMLTextAreaElement | undefined = undefined;
				if (this.lastActiveEditableElement && document.body.contains(this.lastActiveEditableElement)) {
					targetEl = this.lastActiveEditableElement;
				} else if (this.inputField && document.body.contains(this.inputField)) {
					targetEl = this.inputField;
				}

				// Only add Voice Note attachment to the main chat if dictating into the main inputField
				if (!targetEl || targetEl === this.inputField) {
					const recordingName = `Voice Note ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.webm`;
					this.activeAttachments.push({
						name: recordingName,
						content: '',
						size: audioBlob.size,
						url: audioUrl,
						isAudio: true,
						duration: duration
					});
					this.renderAttachmentTags();
				}

				stream.getTracks().forEach(track => track.stop());

				// Speech-to-Text transcription with active Voice Model
				if (this.recordingIndicator && this.recordingTimeSpan) {
					this.recordingIndicator.style.display = 'flex';
					this.recordingTimeSpan.textContent = 'Transcribing voice...';
				}

				try {
					const result = await this.voiceModelService.transcribeAudio(audioBlob);
					if (result.text && result.text.trim()) {
						const transcribed = result.text.trim();

						if (targetEl) {
							const existing = targetEl.value || '';
							let start = (targetEl === this.lastActiveEditableElement && typeof this.lastSelectionStart === 'number')
								? this.lastSelectionStart
								: (targetEl.selectionStart ?? existing.length);
							let end = (targetEl === this.lastActiveEditableElement && typeof this.lastSelectionEnd === 'number')
								? this.lastSelectionEnd
								: (targetEl.selectionEnd ?? existing.length);

							if (start < 0 || start > existing.length) { start = existing.length; }
							if (end < 0 || end > existing.length) { end = existing.length; }
							if (start > end) { const tmp = start; start = end; end = tmp; }

							// Smart whitespace handling around insertion point
							const beforeText = existing.substring(0, start);
							const afterText = existing.substring(end);
							let insertText = transcribed;
							if (start > 0 && !/\s$/.test(beforeText) && !/^\s/.test(insertText)) {
								insertText = ' ' + insertText;
							}
							if (end < existing.length && !/^\s/.test(afterText) && !/\s$/.test(insertText)) {
								insertText = insertText + ' ';
							}

							targetEl.value = beforeText + insertText + afterText;
							const newCursorPos = start + insertText.length;
							targetEl.selectionStart = newCursorPos;
							targetEl.selectionEnd = newCursorPos;
							targetEl.focus();

							targetEl.dispatchEvent(new Event('input', { bubbles: true }));
							targetEl.dispatchEvent(new Event('change', { bubbles: true }));

							// If editing inside context locator, keep locator.interactiveModifiedValue in sync
							if (targetEl !== this.inputField && this.activeContextLocator) {
								this.activeContextLocator.interactiveModifiedValue = targetEl.value;
							}

							this.recordLastActiveEditable(targetEl);
						}
					} else if (result.error) {
						this.notificationService.warn(`Voice Transcription: ${result.error}`);
					}
				} catch (err: any) {
					console.error('Failed to transcribe voice input:', err);
					this.notificationService.error(`Voice transcription error: ${err.message || err}`);
				} finally {
					this.isTranscribing = false;
					this.updateSendButtonState();
					if (this.recordingIndicator) {
						this.recordingIndicator.style.display = 'none';
					}
				}
			};

			this.mediaRecorder.start();
			this.isRecording = true;
			this.updateSendButtonState();
			this.recordingSeconds = 0;

			if (this.recordingIndicator) {
				this.recordingIndicator.style.display = 'flex';
			}
			if (this.recordingTimeSpan) {
				this.recordingTimeSpan.textContent = '0:00 / 5:00';
			}
			if (this.micBtn) {
				this.micBtn.classList.add('recording');
			}

			this.recordingTimer = setInterval(() => {
				this.recordingSeconds++;
				if (this.recordingTimeSpan) {
					const mins = Math.floor(this.recordingSeconds / 60);
					const secs = this.recordingSeconds % 60;
					this.recordingTimeSpan.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs} / 5:00`;
				}
				if (this.recordingSeconds >= 300) {
					this.stopRecording();
				}
			}, 1000);

		} catch (err) {
			console.error('Error accessing microphone:', err);
		}
	}

	private stopRecording(): void {
		if (this.recordingTimer) {
			clearInterval(this.recordingTimer);
			this.recordingTimer = undefined;
		}

		if (this.mediaRecorder && this.isRecording) {
			this.mediaRecorder.stop();
			this.isRecording = false;
			this.updateSendButtonState();
		} else {
			this.isRecording = false;
			this.updateSendButtonState();
			if (this.recordingIndicator) {
				this.recordingIndicator.style.display = 'none';
			}
		}

		if (this.micBtn) {
			this.micBtn.classList.remove('recording');
		}
	}

	private restoreWindowFromZenOnHide(): void {
		const mainContainer = this.layoutService.mainContainer;
		mainContainer.classList.remove('centered-chat-zen-mode');
		this.isZenMode = false;
	}

	private async toggleZenMode(zenIcon: HTMLElement): Promise<void> {
		const mainContainer = this.layoutService.mainContainer;
		if (this.isZenMode) {
			mainContainer.classList.remove('centered-chat-zen-mode');
			zenIcon.className = 'codicon codicon-chrome-minimize';
			this.isZenMode = false;
		} else {
			mainContainer.classList.add('centered-chat-zen-mode');
			zenIcon.className = 'codicon codicon-chrome-restore';
			this.isZenMode = true;
		}
	}
}
