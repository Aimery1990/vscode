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

const STORAGE_KEY_CREDENTIAL_ID = 'anyagent.centeredChat.activeCredentialId';
const STORAGE_KEY_MODEL_ID = 'anyagent.centeredChat.activeModelId';

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

	public show(initialContext?: { prompt?: string; field?: string; ticketId?: string; currentValue?: string }): void {
		if (this.element) {
			this.element.style.display = 'flex';
			if (initialContext && this.inputField) {
				if (initialContext.prompt) {
					this.inputField.value = initialContext.prompt;
				}
				setTimeout(() => this.inputField?.focus(), 50);
			}
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

		if (initialContext && this.inputField) {
			if (initialContext.prompt) {
				this.inputField.value = initialContext.prompt;
			}
		}

		// Auto Focus on load
		this.inputField.focus();
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

	public toggle(initialContext?: { prompt?: string; field?: string; ticketId?: string; currentValue?: string }): void {
		if (this.element) {
			if (initialContext) {
				this.show(initialContext);
			} else {
				this.hide();
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
			optConfig.textContent = '⚙️ Configure API Keys...';
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
		content.appendChild(document.createTextNode('! 👋'));
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
			this.element.style.width = `${CenteredChatWidget.lastSize.width}px`;
			this.element.style.height = `${CenteredChatWidget.lastSize.height}px`;
		} else {
			this.element.style.width = '640px';
			this.element.style.height = '480px';
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
		if (!text && this.activeAttachments.length === 0) { return; }

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
		await this.startStreamingResponse(text, cred, apiKey);
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
		modelBadge.textContent = `🤖 ${this.activeModelId} (${cred.providerId.toUpperCase()})`;

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
				fullResponseText += `\n\n⚠️ **Error:** ${err.message || err}`;
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
