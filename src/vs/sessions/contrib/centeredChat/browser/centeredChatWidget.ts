/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/centeredChat.css';
import { $, append, addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IRectangle } from '../../../../platform/window/common/window.js';

interface IAttachment {
	name: string;
	content: string;
	size: number;
	url?: string;
	isAudio?: boolean;
	duration?: number;
}

export class CenteredChatWidget extends Disposable {

	private element: HTMLElement | undefined;
	private messagesContainer: HTMLElement | undefined;
	private inputField: HTMLTextAreaElement | undefined;
	private attachmentsContainer: HTMLElement | undefined;
	private modelSelect: HTMLSelectElement | undefined;
	private micBtn: HTMLElement | undefined;
	private recordingIndicator: HTMLElement | undefined;
	private recordingTimeSpan: HTMLElement | undefined;

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
	private originalWindowPosition: IRectangle | undefined = undefined;
	private originalFullScreen = false;
	private originalMaximized = false;
	private osWindowStartPos: IRectangle | undefined = undefined;
	private osDragStartX = 0;
	private osDragStartY = 0;
	private zenWidth = 600;
	private zenHeight = 400;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INativeHostService private readonly nativeHostService: INativeHostService
	) {
		super();
	}

	public show(): void {
		if (this.element) {
			return;
		}

		const parent = this.layoutService.mainContainer;
		this.element = append(parent, $('.centered-chat-popup-container'));

		// Titlebar / Header - ONLY keep the sparkle icon as requested by the user.
		const header = append(this.element, $('.centered-chat-popup-header'));

		const title = append(header, $('.centered-chat-popup-title'));
		const titleIcon = append(title, $('span.codicon.codicon-sparkle'));
		titleIcon.style.color = '#007aff';

		const controls = append(header, $('.centered-chat-popup-controls'));

		// Zen Toggle (Collapse) Button
		const toggleZenBtn = append(controls, $('.centered-chat-popup-zen-btn'));
		toggleZenBtn.style.cursor = 'pointer';
		toggleZenBtn.style.display = 'flex';
		toggleZenBtn.style.alignItems = 'center';
		toggleZenBtn.style.justifyContent = 'center';
		const zenIcon = append(toggleZenBtn, $('span.codicon.codicon-chrome-minimize'));

		this._register(addDisposableListener(toggleZenBtn, 'click', async (e) => {
			e.stopPropagation();
			await this.toggleZenMode(zenIcon);
		}));

		// Close Button
		const closeBtn = append(controls, $('.centered-chat-popup-close-btn'));
		append(closeBtn, $('span.codicon.codicon-close'));
		this._register(addDisposableListener(closeBtn, 'click', () => this.hide()));

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

		// Voice Recording Pulse Timer Indicator (Above the text area within inputArea)
		this.recordingIndicator = append(inputArea, $('.centered-chat-popup-recording-indicator'));
		this.recordingIndicator.style.display = 'none';
		append(this.recordingIndicator, $('.centered-chat-popup-recording-dot'));
		this.recordingTimeSpan = append(this.recordingIndicator, $('span'));
		this.recordingTimeSpan.textContent = '0:00 / 2:00';

		// Input Text Area
		const inputWrapper = append(inputArea, $('.centered-chat-popup-input-wrapper'));
		this.inputField = append(inputWrapper, $('textarea.centered-chat-popup-input')) as HTMLTextAreaElement;
		this.inputField.placeholder = 'Ask anything, @ to mention, / for actions';

		// Toolbar below textarea
		const toolbar = append(inputArea, $('.centered-chat-popup-toolbar'));

		// Left side of toolbar
		const toolbarLeft = append(toolbar, $('.centered-chat-popup-toolbar-left'));
		// Add/Attach button (+)
		const attachBtn = append(toolbarLeft, $('.centered-chat-popup-attach-btn'));
		append(attachBtn, $('span.codicon.codicon-add')); // '+' icon
		this._register(addDisposableListener(attachBtn, 'click', () => fileInput.click()));

		// Model Selector dropdown moved here
		this.modelSelect = append(toolbarLeft, $('select.centered-chat-popup-model-select')) as HTMLSelectElement;
		const models = ['Gemini 1.5 Pro', 'Claude 3.5 Sonnet', 'GPT-4o', 'DeepSeek Coder'];
		for (const model of models) {
			const option = document.createElement('option');
			option.value = model;
			option.textContent = model;
			this.modelSelect.appendChild(option);
		}

		// Right side of toolbar
		const toolbarRight = append(toolbar, $('.centered-chat-popup-toolbar-right'));
		// Mic button for recording
		this.micBtn = append(toolbarRight, $('.centered-chat-popup-mic-btn'));
		append(this.micBtn, $('span.codicon.codicon-mic'));
		this._register(addDisposableListener(this.micBtn, 'click', () => this.toggleRecording()));

		// Send button (blue circle with right arrow)
		const sendBtn = append(toolbarRight, $('button.centered-chat-popup-send-btn')) as HTMLButtonElement;
		append(sendBtn, $('span.codicon.codicon-arrow-right'));

		// Event handlers
		this._register(addDisposableListener(fileInput, 'change', (e: Event) => this.handleFileSelection(e)));
		this._register(addDisposableListener(sendBtn, 'click', () => this.sendMessage()));

		// Critical: Stop keyboard event propagation to prevent VS Code keybinding intercepting when typing!
		const stopPropagation = (e: KeyboardEvent) => e.stopPropagation();
		this._register(addDisposableListener(this.inputField, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		}));
		this._register(addDisposableListener(this.inputField, 'keyup', stopPropagation));
		this._register(addDisposableListener(this.inputField, 'keypress', stopPropagation));

		// Drag and Drop
		this.setupDragging(header);

		// Position restores
		this.restorePosition();

		// Auto Focus on load
		this.inputField.focus();
	}

	public hide(): void {
		if (this.element) {
			// Stop recording if active on hide
			this.stopRecording();

			if (this.isZenMode) {
				this.restoreWindowFromZenOnHide();
			}

			// Save the final position and size before removing
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

			this.element.remove();
			this.element = undefined;
			this.messagesContainer = undefined;
			this.inputField = undefined;
			this.attachmentsContainer = undefined;
			this.modelSelect = undefined;
			this.micBtn = undefined;
			this.recordingIndicator = undefined;
			this.recordingTimeSpan = undefined;
		}
	}

	public toggle(): void {
		if (this.element) {
			this.hide();
		} else {
			this.show();
		}
	}

	private addWelcomeMessage(): void {
		if (!this.messagesContainer) { return; }
		const welcomeMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));
		const content = append(welcomeMsg, $('span'));

		// Build DOM nodes dynamically to fully comply with TrustedHTML policies
		content.appendChild(document.createTextNode('Welcome to '));
		const bold1 = append(content, $('b'));
		bold1.textContent = 'Agent Central';
		content.appendChild(document.createTextNode('! 👋'));
		append(content, $('br'));
		content.appendChild(document.createTextNode("I'm your workspace orchestrator. You can prompt me, select models, upload files/images, and direct code operations directly from here."));

		const time = append(welcomeMsg, $('.centered-chat-msg-time'));
		time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	private setupDragging(header: HTMLElement): void {
		this._register(addDisposableListener(header, 'mousedown', async (e: MouseEvent) => {
			if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLOptionElement) {
				return; // Don't drag when selecting options
			}
			this.isDragging = true;
			this.dragStartX = e.clientX;
			this.dragStartY = e.clientY;

			if (this.isZenMode) {
				this.osWindowStartPos = await this.nativeHostService.getActiveWindowPosition();
				this.osDragStartX = e.screenX;
				this.osDragStartY = e.screenY;
			} else {
				const rect = this.element!.getBoundingClientRect();
				const parentRect = this.layoutService.mainContainer.getBoundingClientRect();
				this.elementStartX = rect.left - parentRect.left;
				this.elementStartY = rect.top - parentRect.top;
			}

			header.style.cursor = 'grabbing';
			e.preventDefault();
		}));

		const onMouseMove = async (e: MouseEvent) => {
			if (!this.isDragging || !this.element) { return; }

			if (this.isZenMode) {
				if (this.osWindowStartPos) {
					const deltaX = e.screenX - this.osDragStartX;
					const deltaY = e.screenY - this.osDragStartY;
					await this.nativeHostService.positionWindow({
						x: this.osWindowStartPos.x + deltaX,
						y: this.osWindowStartPos.y + deltaY,
						width: this.zenWidth,
						height: this.zenHeight
					});
				}
				return;
			}

			const deltaX = e.clientX - this.dragStartX;
			const deltaY = e.clientY - this.dragStartY;

			const parentRect = this.layoutService.mainContainer.getBoundingClientRect();
			const elementRect = this.element.getBoundingClientRect();

			let newLeft = this.elementStartX + deltaX;
			let newTop = this.elementStartY + deltaY;

			// Collision Boundary checks inside the VS Code main window layout
			if (newLeft < 0) {
				newLeft = 0;
			} else if (newLeft + elementRect.width > parentRect.width) {
				newLeft = parentRect.width - elementRect.width;
			}

			if (newTop < 0) {
				newTop = 0;
			} else if (newTop + elementRect.height > parentRect.height) {
				newTop = parentRect.height - elementRect.height;
			}

			// Apply new layout positions and clear transform/bottom defaults
			this.element.style.bottom = 'auto';
			this.element.style.transform = 'none';
			this.element.style.left = `${newLeft}px`;
			this.element.style.top = `${newTop}px`;
		};

		const onMouseUp = () => {
			if (this.isDragging) {
				this.isDragging = false;
				header.style.cursor = 'move';
			}
		};

		this._register(addDisposableListener(window, 'mousemove', onMouseMove));
		this._register(addDisposableListener(window, 'mouseup', onMouseUp));
	}

	private restorePosition(): void {
		if (!this.element) { return; }

		const parentRect = this.layoutService.mainContainer.getBoundingClientRect();
		const defaultWidth = CenteredChatWidget.lastSize?.width ?? 600;
		const defaultHeight = CenteredChatWidget.lastSize?.height ?? 400;

		this.element.style.width = `${defaultWidth}px`;
		this.element.style.height = `${defaultHeight}px`;

		if (CenteredChatWidget.lastPosition) {
			this.element.style.bottom = 'auto';
			this.element.style.transform = 'none';
			this.element.style.left = `${CenteredChatWidget.lastPosition.left}px`;
			this.element.style.top = `${CenteredChatWidget.lastPosition.top}px`;
		} else {
			// Center layout cleanly at bootstrap using absolute pixels to support native dragging & resizing
			const left = (parentRect.width - defaultWidth) / 2;
			const top = parentRect.height - defaultHeight - 80;
			this.element.style.bottom = 'auto';
			this.element.style.transform = 'none';
			this.element.style.left = `${left}px`;
			this.element.style.top = `${top}px`;
		}
	}

	private toggleRecording(): void {
		if (this.isRecording) {
			this.stopRecording();
		} else {
			this.startRecording();
		}
	}

	private async startRecording(): Promise<void> {
		if (this.isRecording) { return; }

		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			this.audioChunks = [];

			// Detect support format for macOS Electron compatibility
			let mimeType = 'audio/webm';
			if (!(window as any).MediaRecorder.isTypeSupported(mimeType)) {
				if ((window as any).MediaRecorder.isTypeSupported('audio/mp4')) {
					mimeType = 'audio/mp4';
				} else if ((window as any).MediaRecorder.isTypeSupported('audio/ogg')) {
					mimeType = 'audio/ogg';
				} else if ((window as any).MediaRecorder.isTypeSupported('audio/wav')) {
					mimeType = 'audio/wav';
				}
			}

			this.mediaRecorder = new (window as any).MediaRecorder(stream, { mimeType });

			this.mediaRecorder.ondataavailable = (e: any) => {
				if (e.data && e.data.size > 0) {
					this.audioChunks.push(e.data);
				}
			};

			this.mediaRecorder.onstop = () => {
				if (this.audioChunks.length > 0) {
					const actualMimeType = this.mediaRecorder.mimeType || mimeType;
					const audioBlob = new Blob(this.audioChunks, { type: actualMimeType });
					const audioUrl = URL.createObjectURL(audioBlob);

					// Unique background naming using timestamp and random ID
					const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
					const uniqueId = Math.random().toString(36).substring(2, 8);
					const ext = actualMimeType.split('/')[1]?.split(';')[0] || 'webm';

					const audioAttachment: IAttachment = {
						name: `voice_${timestamp}_${uniqueId}.${ext}`,
						content: '',
						size: audioBlob.size,
						url: audioUrl,
						isAudio: true,
						duration: this.recordingSeconds // Store the tracked duration!
					};

					this.activeAttachments.push(audioAttachment);
					this.renderAttachmentTags();
				}

				// Release the microphone input stream
				stream.getTracks().forEach(track => track.stop());
			};

			this.mediaRecorder.start();
			this.isRecording = true;
			this.recordingSeconds = 0;
			this.updateMicUI();

			// Timer increment every second up to 120s limit (2 minutes)
			this.recordingTimer = setInterval(() => {
				this.recordingSeconds++;
				if (this.recordingSeconds >= 120) {
					this.stopRecording();
				} else {
					this.updateRecordingTimerDisplay();
				}
			}, 1000);

		} catch (err) {
			console.error('Microphone access failure:', err);
			if (this.messagesContainer) {
				const errorMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));
				const span = append(errorMsg, $('span'));
				span.style.color = '#ff3b30';
				span.textContent = 'System: Failed to access microphone. Please check system permissions.';
				this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
			}
		}
	}

	private stopRecording(): void {
		if (this.isRecording && this.mediaRecorder) {
			this.mediaRecorder.stop();
			clearInterval(this.recordingTimer);
			this.isRecording = false;
			this.updateMicUI();
		}
	}

	private updateMicUI(): void {
		if (!this.micBtn || !this.recordingIndicator) { return; }

		if (this.isRecording) {
			this.micBtn.classList.add('recording');
			this.recordingIndicator.style.display = 'flex';
			this.updateRecordingTimerDisplay();
		} else {
			this.micBtn.classList.remove('recording');
			this.recordingIndicator.style.display = 'none';
		}
	}

	private updateRecordingTimerDisplay(): void {
		if (!this.recordingTimeSpan) { return; }
		const mins = Math.floor(this.recordingSeconds / 60);
		const secs = this.recordingSeconds % 60;
		this.recordingTimeSpan.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs} / 2:00`;
	}

	private handleFileSelection(e: Event): void {
		const files = (e.target as HTMLInputElement).files;
		if (!files || files.length === 0) { return; }

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const reader = new FileReader();

			reader.onload = (event) => {
				const content = event.target?.result as string;
				const attachment: IAttachment = {
					name: file.name,
					content: content || '',
					size: file.size
				};
				this.activeAttachments.push(attachment);
				this.renderAttachmentTags();
			};

			reader.readAsText(file);
		}
	}

	private renderAttachmentTags(): void {
		if (!this.attachmentsContainer) { return; }

		// Clear children cleanly to avoid innerHTML TrustedHTML errors
		while (this.attachmentsContainer.firstChild) {
			this.attachmentsContainer.removeChild(this.attachmentsContainer.firstChild);
		}
		if (this.activeAttachments.length === 0) {
			this.attachmentsContainer.style.display = 'none';
			return;
		}

		this.attachmentsContainer.style.display = 'flex';
		this.activeAttachments.forEach((attach, index) => {
			const tag = append(this.attachmentsContainer!, $('.centered-chat-attachment-tag'));

			if (attach.isAudio && attach.url) {
				// Style as a custom inline player (following Antigravity design)
				tag.classList.add('centered-chat-attachment-audio-tag');

				const playBtn = append(tag, $('.audio-preview-play-btn'));
				const playIcon = append(playBtn, $('span.codicon.codicon-play'));

				const progressTrack = append(tag, $('.audio-preview-progress-track'));
				const progressBar = append(progressTrack, $('.audio-preview-progress-bar'));

				const timeDisplay = append(tag, $('span.audio-preview-time'));

				const totalDuration = attach.duration || 0;
				const audio = new Audio(attach.url);
				let isPlaying = false;
				let intervalId: any = null;

				const formatTime = (secs: number) => {
					if (isNaN(secs) || !isFinite(secs)) { return '0:00'; }
					const m = Math.floor(secs / 60);
					const s = Math.floor(secs % 60);
					return `${m}:${s < 10 ? '0' : ''}${s}`;
				};

				// Immediately show duration using tracked value, avoiding webm Infinity bug
				timeDisplay.textContent = `0:00 / ${formatTime(totalDuration)}`;

				const updateProgress = () => {
					const cur = audio.currentTime;
					const dur = totalDuration || 1;
					const percent = Math.min((cur / dur) * 100, 100);
					progressBar.style.width = `${percent}%`;
					timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
				};

				this._register(addDisposableListener(playBtn, 'click', (e) => {
					e.stopPropagation();
					if (isPlaying) {
						audio.pause();
						playIcon.className = 'codicon codicon-play';
						isPlaying = false;
						if (intervalId) {
							clearInterval(intervalId);
							intervalId = null;
						}
					} else {
						// Reset playhead to 0 if finished or at 0, helping bypass Chromium live stream end bug
						if (audio.readyState > 0) {
							if (audio.currentTime >= (totalDuration || 1) || audio.currentTime === 0) {
								audio.currentTime = 0;
							}
						}

						audio.play().then(() => {
							playIcon.className = 'codicon codicon-debug-pause';
							isPlaying = true;
							intervalId = setInterval(updateProgress, 100);
						}).catch(err => {
							console.error('Audio play failure:', err);
						});

						audio.onended = () => {
							if (audio.readyState > 0) {
								audio.currentTime = 0;
							}
							progressBar.style.width = '0%';
							playIcon.className = 'codicon codicon-play';
							isPlaying = false;
							if (intervalId) {
								clearInterval(intervalId);
								intervalId = null;
							}
							timeDisplay.textContent = `0:00 / ${formatTime(totalDuration)}`;
						};
					}
				}));

				this._register(addDisposableListener(progressTrack, 'click', (e: MouseEvent) => {
					e.stopPropagation();
					const rect = progressTrack.getBoundingClientRect();
					const clickX = e.clientX - rect.left;
					const width = rect.width || 1;
					const ratio = clickX / width;
					if (totalDuration) {
						if (audio.readyState > 0) {
							audio.currentTime = ratio * totalDuration;
						}
						updateProgress();
					}
				}));

				this._register({
					dispose: () => {
						audio.pause();
						if (intervalId) { clearInterval(intervalId); }
					}
				});
			} else {
				// Non-audio file tag
				append(tag, $('span.codicon.codicon-file'));
				const nameSpan = append(tag, $('span'));
				nameSpan.textContent = attach.name;
			}

			const removeBtn = append(tag, $('.centered-chat-attachment-remove'));
			removeBtn.textContent = '×';
			addDisposableListener(removeBtn, 'click', () => {
				this.activeAttachments.splice(index, 1);
				this.renderAttachmentTags();
			});
		});
	}

	private sendMessage(): void {
		if (!this.inputField || !this.messagesContainer) { return; }

		const text = this.inputField.value.trim();
		if (!text && this.activeAttachments.length === 0) { return; }

		// 1. Render User Message
		const userMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-user'));

		// Attachment previews inside message bubble if present
		if (this.activeAttachments.length > 0) {
			this.activeAttachments.forEach(att => {
				if (att.isAudio && att.url) {
					const audioContainer = append(userMsg, $('.centered-chat-msg-audio-container'));
					audioContainer.style.margin = '6px 0';
					const audioEl = append(audioContainer, $('audio')) as HTMLAudioElement;
					audioEl.controls = true;
					audioEl.src = att.url;
					audioEl.style.maxHeight = '32px';
					audioEl.style.width = '100%';
					audioEl.style.minWidth = '240px';
					audioEl.style.outline = 'none';

					// Chromium WebM duration calculation hack
					const applyHack = () => {
						try {
							audioEl.currentTime = 1e101;
							const onTimeUpdate = () => {
								audioEl.removeEventListener('timeupdate', onTimeUpdate);
								audioEl.currentTime = 0;
							};
							audioEl.addEventListener('timeupdate', onTimeUpdate);
						} catch (err) {
							console.error('Failed to apply duration hack:', err);
						}
					};

					if (audioEl.readyState > 0) {
						applyHack();
					} else {
						audioEl.addEventListener('loadedmetadata', applyHack, { once: true });
					}
				} else {
					const attachmentLabel = append(userMsg, $('div'));
					attachmentLabel.style.fontSize = '9px';
					attachmentLabel.style.opacity = '0.7';
					attachmentLabel.style.marginBottom = '4px';
					attachmentLabel.style.fontWeight = 'bold';
					attachmentLabel.textContent = `Attached: ${att.name}`;
				}
			});
		}

		if (text) {
			const promptContent = append(userMsg, $('span'));
			promptContent.textContent = text;
		} else if (this.activeAttachments.length > 0 && this.activeAttachments.every(a => a.isAudio)) {
			const promptContent = append(userMsg, $('span'));
			promptContent.textContent = '(Sent Voice Recording)';
		}

		const userTime = append(userMsg, $('.centered-chat-msg-time'));
		userTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

		// Clear inputs
		this.inputField.value = '';
		const attachmentsToSend = [...this.activeAttachments];
		this.activeAttachments = [];
		this.renderAttachmentTags();

		// Auto scroll
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		// 2. Simulated AI response trigger
		const model = this.modelSelect?.value || 'Gemini 1.5 Pro';
		setTimeout(() => {
			if (!this.messagesContainer) { return; }

			const aiMsg = append(this.messagesContainer, $('.centered-chat-msg.centered-chat-msg-ai'));
			const aiText = append(aiMsg, $('span'));

			aiText.appendChild(document.createTextNode('Hi there! This is a mock response from '));
			const boldModel = append(aiText, $('b'));
			boldModel.textContent = model;
			aiText.appendChild(document.createTextNode(". I've received your prompt."));

			if (attachmentsToSend.length > 0) {
				append(aiText, $('br'));
				append(aiText, $('br'));

				const emoji = append(aiText, $('span'));
				emoji.textContent = '📁 ';
				const boldTitle = append(aiText, $('b'));
				boldTitle.textContent = `Analyzed ${attachmentsToSend.length} file(s) successfully:`;

				attachmentsToSend.forEach(att => {
					append(aiText, $('br'));

					const bullet = append(aiText, $('span'));
					bullet.textContent = att.isAudio ? '• 🎙️ ' : '• 📄 ';

					const codeTag = append(aiText, $('code'));
					codeTag.textContent = att.name;

					const sizeText = append(aiText, $('span'));
					sizeText.textContent = ` (${Math.round(att.size / 1024)} KB)`;
				});
			}

			const aiTime = append(aiMsg, $('.centered-chat-msg-time'));
			aiTime.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}, 1000);
	}

	private restoreWindowFromZenOnHide(): void {
		const mainContainer = this.layoutService.mainContainer;
		mainContainer.classList.remove('centered-chat-zen-mode');

		this.nativeHostService.setWindowButtonVisibility(true);

		if (this.originalFullScreen) {
			this.nativeHostService.toggleFullScreen();
		} else if (this.originalMaximized) {
			this.nativeHostService.maximizeWindow();
		} else if (this.originalWindowPosition) {
			this.nativeHostService.positionWindow(this.originalWindowPosition);
		}

		this.isZenMode = false;
	}

	private async toggleZenMode(zenIcon: HTMLElement): Promise<void> {
		const mainContainer = this.layoutService.mainContainer;
		if (this.isZenMode) {
			// Restore normal mode
			mainContainer.classList.remove('centered-chat-zen-mode');
			zenIcon.className = 'codicon codicon-chrome-minimize';
			await this.nativeHostService.setWindowButtonVisibility(true);

			if (this.originalFullScreen) {
				await this.nativeHostService.toggleFullScreen();
			} else if (this.originalMaximized) {
				await this.nativeHostService.maximizeWindow();
			} else if (this.originalWindowPosition) {
				await this.nativeHostService.positionWindow(this.originalWindowPosition);
			}

			// Restore draggable state and resizability
			if (this.element) {
				this.element.style.position = 'absolute';
				const defaultWidth = CenteredChatWidget.lastSize?.width ?? 600;
				const defaultHeight = CenteredChatWidget.lastSize?.height ?? 400;
				this.element.style.width = `${defaultWidth}px`;
				this.element.style.height = `${defaultHeight}px`;
				if (CenteredChatWidget.lastPosition) {
					this.element.style.left = `${CenteredChatWidget.lastPosition.left}px`;
					this.element.style.top = `${CenteredChatWidget.lastPosition.top}px`;
				} else {
					this.element.style.left = '50%';
					this.element.style.top = '50%';
					this.element.style.transform = 'translate(-50%, -50%)';
				}
			}

			this.isZenMode = false;
		} else {
			// Save current state
			this.originalFullScreen = await this.nativeHostService.isFullScreen();
			this.originalMaximized = await this.nativeHostService.isMaximized();
			const activePos = await this.nativeHostService.getActiveWindowPosition();
			if (activePos) {
				this.originalWindowPosition = activePos;
			}

			// Switch to Zen Mode class on workbench
			mainContainer.classList.add('centered-chat-zen-mode');
			zenIcon.className = 'codicon codicon-chrome-restore';
			await this.nativeHostService.setWindowButtonVisibility(false);

			// Measure current card dimensions before removing positioning styles
			if (this.element) {
				const rect = this.element.getBoundingClientRect();
				this.zenWidth = Math.max(Math.round(rect.width), 350) || 600;
				this.zenHeight = Math.max(Math.round(rect.height), 250) || 400;

				this.element.style.transform = 'none';
				this.element.style.left = '0';
				this.element.style.top = '0';
				this.element.style.width = '100%';
				this.element.style.height = '100%';
			}

			// Transition out of fullscreen/maximized first to allow sizing
			const isFullScreen = await this.nativeHostService.isFullScreen();
			if (isFullScreen) {
				await this.nativeHostService.toggleFullScreen();
				await new Promise(resolve => setTimeout(resolve, 1000)); // wait for macOS transition space animation
			}
			await this.nativeHostService.unmaximizeWindow();
			await new Promise(resolve => setTimeout(resolve, 300)); // wait for unmaximize zoom transition

			// Center the collapsed window (zenWidth width, zenHeight height) on the screen
			const screenPos = this.originalWindowPosition || activePos;
			if (screenPos) {
				const centerX = screenPos.x + screenPos.width / 2;
				const centerY = screenPos.y + screenPos.height / 2;
				const newLeft = Math.round(centerX - this.zenWidth / 2);
				const newTop = Math.round(centerY - this.zenHeight / 2);
				await this.nativeHostService.positionWindow({
					x: newLeft,
					y: newTop,
					width: this.zenWidth,
					height: this.zenHeight
				});
			}

			this.isZenMode = true;
		}
	}
}
