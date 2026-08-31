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

	// Scoped Disposables to prevent any memory leaks
	private readonly viewDisposables = this._register(new DisposableStore());
	private readonly modelListDisposables = this._register(new DisposableStore());
	private readonly attachmentDisposables = this._register(new DisposableStore());
	private readonly messageDisposables = this._register(new DisposableStore());

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

	// Keep track of the last position and size in memory so it doesn't reset on toggle
	private static lastPosition: { top: number; left: number } | undefined = undefined;
	private static lastSize: { width: number; height: number } | undefined = undefined;

	private isZenMode = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentCredentialService private readonly agentCredentialService: IAgentCredentialService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService
	) {
		super();

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
			this.activeBreadcrumbDropdown.remove();
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
				menu.remove();
				this.activeBreadcrumbDropdown = undefined;
				this.drillDownTo(child.path);
			};
		});

		const closeListener = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node) && e.target !== anchorEl) {
				menu.remove();
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
		} else if (locator.field) {
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

			const fType = locator.fieldType || (activeNode ? activeNode.fieldType : undefined) || (editableValue.includes('~') ? 'date_range' : (/^\d{4}-\d{2}-\d{2}/.test(editableValue) ? 'date' : 'text'));

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
			} else if (fType === 'priority') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; box-sizing: border-box;'
				})) as HTMLSelectElement;
				const priorities = (locator.options && Array.isArray(locator.options) && locator.options.length > 0)
					? locator.options
					: ((activeNode && activeNode.options && activeNode.options.length > 0)
						? activeNode.options
						: ['Low', 'Medium', 'High', 'Urgent']);
				priorities.forEach((pr: string) => {
					const opt = append(select, $('option', { value: pr }, pr)) as HTMLOptionElement;
					if (pr.toLowerCase() === currentVal.toLowerCase()) opt.selected = true;
				});
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
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
			} else if (fType === 'select') {
				const select = append(editorBox, $('select.monaco-select-box', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; box-sizing: border-box;'
				})) as HTMLSelectElement;
				const optionsList = locator.options || (activeNode ? activeNode.options : []);
				if (optionsList && Array.isArray(optionsList)) {
					optionsList.forEach(op => {
						const opt = append(select, $('option', { value: op }, op)) as HTMLOptionElement;
						if (op === currentVal) opt.selected = true;
					});
				}
				select.onchange = () => { locator.interactiveModifiedValue = select.value; };
			} else if (fType === 'textarea') {
				const ta = append(editorBox, $('textarea.monaco-inputbox', {
					style: 'width: 100%; min-height: 62px; max-height: 200px; padding: 6px 8px; font-size: 11.5px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; resize: vertical; box-sizing: border-box;'
				})) as HTMLTextAreaElement;
				ta.rows = 3;
				ta.value = editableValue;
				ta.placeholder = isNoneOrUnassigned ? currentVal : '';
				ta.oninput = () => { locator.interactiveModifiedValue = ta.value; };
			} else {
				const txt = append(editorBox, $('input.monaco-inputbox', {
					style: 'width: 100%; padding: 4px 8px; font-size: 11.5px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; box-sizing: border-box;'
				})) as HTMLInputElement;
				txt.type = 'text';
				txt.value = editableValue;
				txt.placeholder = isNoneOrUnassigned ? currentVal : '';
				txt.oninput = () => { locator.interactiveModifiedValue = txt.value; };
			}
		}
	}

	public show(initialContext?: { prompt?: string; workspaceId?: string; ticketId?: string; field?: string; label?: string; fieldType?: string; currentValue?: string; options?: any[]; hierarchyTree?: any[] }): void {
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
						hierarchyTree: initialContext.hierarchyTree
					});
				}
				if (initialContext.prompt && !initialContext.field && !initialContext.ticketId && this.inputField) {
					this.inputField.value = initialContext.prompt;
				}
			}
			this.inputField?.focus();
			return;
		}

		// Clear any previous view session disposables
		this.viewDisposables.clear();

		const parent = this.layoutService.mainContainer;
		this.element = append(parent, $('.centered-chat-popup-container'));

		// Titlebar / Header - ONLY keep the sparkle icon
		const header = append(this.element, $('.centered-chat-popup-header'));

		const title = append(header, $('.centered-chat-popup-title'));
		append(title, $('span.codicon.codicon-sparkle'));
		const titleText = append(title, $('span'));
		titleText.textContent = 'Agent Central';

		const controls = append(header, $('.centered-chat-popup-controls'));

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

		// Messages Body
		this.messagesContainer = append(this.element, $('.centered-chat-popup-messages'));

		// Add welcome message
		this.addWelcomeMessage();

		// Attachments Area (hidden by default)
		this.attachmentsContainer = append(this.element, $('.centered-chat-popup-attachments'));
		this.attachmentsContainer!.style.display = 'none';

		// Input Section - Rounded bubble following Antigravity layout
		const inputArea = append(this.element, $('.centered-chat-popup-input-area'));

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
			} else {
				this.sendMessage();
			}
		}));

		// Prevent VS Code keybinding intercepting when typing
		const stopPropagation = (e: KeyboardEvent) => e.stopPropagation();
		this.viewDisposables.add(addDisposableListener(this.inputField, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				if (this.isStreaming) {
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
		this.restorePosition();

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
					hierarchyTree: initialContext.hierarchyTree
				});
			}
			if (initialContext.prompt && !initialContext.field && !initialContext.ticketId && this.inputField) {
				this.inputField.value = initialContext.prompt;
			}
		}
		this.inputField.focus();
		if (this.inputField.value) {
			const len = this.inputField.value.length;
			this.inputField.setSelectionRange(len, len);
		}
	}

	public hide(): void {
		if (this.element) {
			this.stopRecording();
			this.closeModelDropdown();

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

			this.element.remove();
			this.element = undefined;
			this.messagesContainer = undefined;
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

	public toggle(initialContext?: { prompt?: string; workspaceId?: string; ticketId?: string; field?: string; label?: string; fieldType?: string; currentValue?: string; options?: any[]; hierarchyTree?: any[] }): void {
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
						hierarchyTree: initialContext.hierarchyTree
					});
				}
				if (initialContext.prompt && !initialContext.field && !initialContext.ticketId && this.inputField) {
					this.inputField.value = initialContext.prompt;
				}
			}
			this.inputField?.focus();
			if (this.inputField?.value) {
				const len = this.inputField.value.length;
				this.inputField.setSelectionRange(len, len);
			}
		} else {
			this.show(initialContext);
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

	private restorePosition(): void {
		if (!this.element) { return; }

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

	private async sendMessage(): Promise<void> {
		if (!this.inputField || !this.messagesContainer) { return; }

		const text = this.inputField.value.trim();
		const hasModifiedValue = !!(this.activeContextLocator && this.activeContextLocator.interactiveModifiedValue && this.activeContextLocator.interactiveModifiedValue !== this.activeContextLocator.currentValue);
		if (!text && this.activeAttachments.length === 0 && !hasModifiedValue) { return; }

		const cred = this.getActiveCredential();
		if (!cred) {
			this.notificationService.warn('Please configure an API Key in Settings first.');
			this.openAccountSettings('Models');
			return;
		}

		const apiKey = await this.agentCredentialService.getApiKey(cred.id);
		if (!apiKey) {
			this.notificationService.warn(`No API Key found for ${cred.name}. Please configure it in Settings.`);
			this.openAccountSettings('Models');
			return;
		}

		// 1. Render User Message
		const userMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-user'));

		let fullPrompt = text;
		if (this.activeContextLocator && (this.activeContextLocator.workspaceId || this.activeContextLocator.ticketId || this.activeContextLocator.field)) {
			const loc = this.activeContextLocator;
			const locators: string[] = [];
			if (loc.workspaceId) { locators.push(`Workspace: ${loc.workspaceId}`); }
			if (loc.ticketId) { locators.push(`Ticket: ${loc.ticketId}`); }
			if (loc.field) { locators.push(`Target: ${loc.field}`); }
			if (loc.interactiveModifiedValue !== undefined && loc.interactiveModifiedValue !== '') {
				if (loc.interactiveModifiedValue !== loc.currentValue) {
					locators.push(`Proposed Value: ${loc.interactiveModifiedValue}`);
				} else {
					locators.push(`Current Value: ${loc.currentValue}`);
				}
			}
			const prefix = `[${locators.join(' | ')}]\n`;
			fullPrompt = `${prefix}${text || 'Please update this field as specified.'}`;

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
			if (loc.interactiveModifiedValue && loc.interactiveModifiedValue !== loc.currentValue) {
				parts.push(`-> ${loc.interactiveModifiedValue}`);
			}
			ctxTag.textContent = parts.join(' › ');

			// Clear locator for subsequent messages
			this.setContextLocator(null);
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

		if (text) {
			const promptContent = append(userMsg, $('span'));
			promptContent.textContent = text;
		}

		const userTime = append(userMsg, $('.centered-chat-msg-time'));
		userTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

		// Clear inputs
		this.inputField.value = '';
		this.activeAttachments = [];
		this.renderAttachmentTags();
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		// 2. Start Real Streaming Response
		await this.startStreamingResponse(fullPrompt, cred, apiKey);
	}

	private async startStreamingResponse(prompt: string, cred: IAgentCredential, apiKey: string): Promise<void> {
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
			const atBottom = this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop - this.messagesContainer.clientHeight < 40;
			isUserScrolledUp = !atBottom;
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
				apiKey,
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
			streamSessionDisposables.dispose();
			this.isStreaming = false;
			this.activeCts.dispose();
			this.activeCts = null;
			this.setStreamingButtonState(false);

			// Final flush and register in message store
			flushRender(true);
			typingCursor.remove();
			this.injectCopyButtons(aiContent);

			const aiTime = append(aiMsg, $('.centered-chat-msg-time'));
			aiTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

			if (this.messagesContainer) {
				this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
			}
			this.inputField?.focus();
		}
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

		let url = '';
		let headers: Record<string, string> = { 'Content-Type': 'application/json' };
		let data = '';

		if (providerId === 'gemini') {
			const cleanModel = sanitizedModel || 'gemini-1.5-flash';
			url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
			data = JSON.stringify({
				contents: [{
					role: 'user',
					parts: [{ text: prompt }]
				}]
			});
		} else if (providerId === 'anthropic') {
			const cleanModel = sanitizedModel || 'claude-3-5-sonnet-20241022';
			url = 'https://api.anthropic.com/v1/messages';
			headers = {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			};
			data = JSON.stringify({
				model: cleanModel,
				max_tokens: 4096,
				stream: true,
				messages: [{ role: 'user', content: prompt }]
			});
		} else {
			// OpenAI & Custom-OpenAI
			const baseEndpoint = customUrl || 'https://api.openai.com/v1';
			const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '');
			url = `${cleanBase}/chat/completions`;
			headers = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			};
			data = JSON.stringify({
				model: sanitizedModel || 'gpt-4o',
				stream: true,
				messages: [{ role: 'user', content: prompt }]
			});
		}

		const response = await this.requestService.request({
			type: 'POST',
			url,
			headers,
			data,
			callSite: 'centeredChat.streamLlm'
		}, cancellationTokenSource.token);

		if (response.res.statusCode && (response.res.statusCode < 200 || response.res.statusCode >= 300)) {
			throw new Error(`HTTP ${response.res.statusCode} Error from ${providerId.toUpperCase()} API.`);
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
							if (dataStr === '[DONE]') {
								continue;
							}
							try {
								const json = JSON.parse(dataStr);
								if (providerId === 'anthropic') {
									if (json.type === 'content_block_delta' && json.delta?.text) {
										onToken(json.delta.text);
									}
								} else if (providerId === 'gemini') {
									const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
									if (text) {
										onToken(text);
									}
								} else {
									const delta = json.choices?.[0]?.delta?.content;
									if (delta) {
										onToken(delta);
									}
								}
							} catch {
								// ignore split json
							}
						}
					}
				},
				onError: (err) => {
					streamDisposables.dispose();
					reject(err);
				},
				onEnd: () => {
					streamDisposables.dispose();
					resolve();
				}
			}, cancellationTokenSource.token);
		});
	}

	private abortStreaming(): void {
		if (this.activeCts) {
			this.activeCts.cancel();
		}
	}

	private setStreamingButtonState(isStreaming: boolean): void {
		if (!this.sendBtn) { return; }
		this.sendBtn.textContent = '';
		if (isStreaming) {
			this.sendBtn.classList.add('is-streaming');
			this.sendBtn.title = 'Stop Generating (Click to Abort)';
			append(this.sendBtn, $('span.codicon.codicon-primitive-square'));
		} else {
			this.sendBtn.classList.remove('is-streaming');
			this.sendBtn.title = 'Send Prompt (Enter)';
			append(this.sendBtn, $('span.codicon.codicon-arrow-right'));
		}
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
			this.startRecording();
		}
	}

	private async startRecording(): Promise<void> {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			this.audioChunks = [];
			this.mediaRecorder = new (window as any).MediaRecorder(stream);

			this.mediaRecorder.ondataavailable = (e: any) => {
				if (e.data && e.data.size > 0) {
					this.audioChunks.push(e.data);
				}
			};

			this.mediaRecorder.onstop = () => {
				const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
				const audioUrl = URL.createObjectURL(audioBlob);
				const duration = this.recordingSeconds;

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

				stream.getTracks().forEach(track => track.stop());
			};

			this.mediaRecorder.start();
			this.isRecording = true;
			this.recordingSeconds = 0;

			if (this.recordingIndicator) {
				this.recordingIndicator.style.display = 'flex';
			}
			if (this.micBtn) {
				this.micBtn.classList.add('recording');
			}

			this.recordingTimer = setInterval(() => {
				this.recordingSeconds++;
				if (this.recordingTimeSpan) {
					const mins = Math.floor(this.recordingSeconds / 60);
					const secs = this.recordingSeconds % 60;
					this.recordingTimeSpan.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs} / 2:00`;
				}
				if (this.recordingSeconds >= 120) {
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
		}

		if (this.recordingIndicator) {
			this.recordingIndicator.style.display = 'none';
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
