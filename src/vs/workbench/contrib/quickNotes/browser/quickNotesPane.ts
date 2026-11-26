/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import './media/quickNotes.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IVoiceModelService } from '../../voiceModels/common/voiceModel.js';
import { IQuickNoteAttachment, IQuickNoteItem, IQuickNotesService, QuickNoteStatus } from '../common/quickNotes.js';

interface IActiveVoiceRecording {
	readonly noteId: string;
	readonly mediaRecorder: MediaRecorder;
	readonly stream: MediaStream;
	timer?: number;
	seconds: number;
	cancelled: boolean;
	selectionStart?: number;
	selectionEnd?: number;
}

interface IVoiceCardElements {
	readonly micBtn: HTMLButtonElement;
	readonly micIcon: HTMLElement;
	readonly statusEl: HTMLElement;
	readonly statusTextEl: HTMLElement;
}

export class QuickNotesPane extends ViewPane {
	private static copiedNotePayload?: {
		text: string;
		attachments: Array<Omit<IQuickNoteAttachment, 'id' | 'createdAt'>>;
	};

	private listContainerEl?: HTMLElement;
	private readonly listDisposables = this._register(new DisposableStore());
	private readonly textareaById = new Map<string, HTMLTextAreaElement>();
	private readonly voiceUiById = new Map<string, IVoiceCardElements>();
	private readonly lastSelectionById = new Map<string, { start: number; end: number }>();
	private readonly transcribingNoteIds = new Set<string>();
	private activeRecording?: IActiveVoiceRecording;
	private activeAudioEl?: HTMLAudioElement;
	private activeAudioBlobUrl?: string;
	private activeAudioAttachmentId?: string;
	private activeAudioChipEl?: HTMLElement;
	private pendingFocusNoteId?: string;
	private lastCreatedNoteId?: string;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IQuickNotesService private readonly quickNotesService: IQuickNotesService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVoiceModelService private readonly voiceModelService: IVoiceModelService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);

		this._register(this.quickNotesService.onDidCreateNote(note => {
			this.lastCreatedNoteId = note.id;
			this.pendingFocusNoteId = note.id;
		}));

		this._register(this.quickNotesService.onDidChangeNotes(() => {
			// If the note currently being recorded was removed (e.g. deleted or cleared), abort recording
			if (this.activeRecording) {
				const stillExists = this.quickNotesService.getNotes().some(n => n.id === this.activeRecording!.noteId);
				if (!stillExists) {
					this.cancelActiveRecording();
				}
			}
			if (this.listContainerEl) {
				this.renderNotes();
			}
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && this.listContainerEl) {
				this.renderNotes();
			}
		}));

		this._register({
			dispose: () => {
				this.cancelActiveRecording();
				this.stopActiveAudio();
			}
		});
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('quick-notes-viewpane');

		const rootEl = append(container, $('.quick-notes-container'));
		this.listContainerEl = append(rootEl, $('.quick-notes-list'));

		this.renderNotes();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
		const targetId = this.pendingFocusNoteId ?? this.quickNotesService.getNotes()[0]?.id;
		if (targetId) {
			this.focusNote(targetId);
		}
	}

	focusNote(id: string): void {
		this.pendingFocusNoteId = id;
		const textarea = this.textareaById.get(id);
		if (textarea) {
			if (this.listContainerEl) {
				this.listContainerEl.scrollTop = 0;
			}
			textarea.focus();
			this.pendingFocusNoteId = undefined;
		}
	}

	private getTimestampParts(ts: number): { year: string; monthDay: string; time: string; full: string } {
		const date = new Date(ts);
		const yyyy = String(date.getFullYear());
		const mm = String(date.getMonth() + 1).padStart(2, '0');
		const dd = String(date.getDate()).padStart(2, '0');
		const hh = String(date.getHours()).padStart(2, '0');
		const min = String(date.getMinutes()).padStart(2, '0');
		return {
			year: `${yyyy}-`,
			monthDay: `${mm}-${dd}`,
			time: ` ${hh}:${min}`,
			full: `${yyyy}-${mm}-${dd} ${hh}:${min}`
		};
	}

	private formatRecordingDuration(totalSeconds: number): string {
		const mins = Math.floor(totalSeconds / 60);
		const secs = totalSeconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	private adjustTextareaHeight(textarea: HTMLTextAreaElement): void {
		textarea.style.height = 'auto';
		const minHeight = 80;
		const maxHeight = 360;
		const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
		textarea.style.height = `${nextHeight}px`;
	}

	private syncVoiceUiState(noteId: string): void {
		const ui = this.voiceUiById.get(noteId);
		if (!ui) {
			return;
		}
		const isRecording = this.activeRecording?.noteId === noteId;
		const isTranscribing = this.transcribingNoteIds.has(noteId);

		ui.micBtn.classList.toggle('recording', isRecording);
		ui.micBtn.classList.toggle('transcribing', !isRecording && isTranscribing);

		if (isRecording) {
			ui.micIcon.className = ThemeIcon.asClassName(Codicon.micFilled);
			ui.micBtn.title = localize('quickNotes.stopRecording', "Stop recording and transcribe");
			ui.micBtn.setAttribute('aria-label', localize('quickNotes.stopRecording', "Stop recording and transcribe"));
			ui.statusEl.classList.add('visible', 'recording');
			ui.statusTextEl.textContent = this.formatRecordingDuration(this.activeRecording?.seconds ?? 0);
		} else if (isTranscribing) {
			ui.micIcon.className = `${ThemeIcon.asClassName(Codicon.loading)} codicon-modifier-spin`;
			ui.micBtn.title = localize('quickNotes.transcribing', "Transcribing voice...");
			ui.micBtn.setAttribute('aria-label', localize('quickNotes.transcribing', "Transcribing voice..."));
			ui.statusEl.classList.add('visible');
			ui.statusEl.classList.remove('recording');
			ui.statusTextEl.textContent = localize('quickNotes.transcribingShort', "Transcribing...");
		} else {
			ui.micIcon.className = ThemeIcon.asClassName(Codicon.mic);
			ui.micBtn.title = localize('quickNotes.recordVoice', "Record voice input (Speech-to-Text)");
			ui.micBtn.setAttribute('aria-label', localize('quickNotes.recordVoice', "Record voice input (Speech-to-Text)"));
			ui.statusEl.classList.remove('visible', 'recording');
			ui.statusTextEl.textContent = '';
		}
	}

	private cancelActiveRecording(): void {
		const rec = this.activeRecording;
		if (!rec) {
			return;
		}
		rec.cancelled = true;
		if (rec.timer !== undefined) {
			mainWindow.clearInterval(rec.timer);
			rec.timer = undefined;
		}
		this.activeRecording = undefined;
		try {
			if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
				rec.mediaRecorder.stop();
			}
		} catch {
			// Ignore recorder stop errors
		}
		try {
			rec.stream.getTracks().forEach(track => track.stop());
		} catch {
			// Ignore track stop errors
		}
		this.syncVoiceUiState(rec.noteId);
	}

	private stopActiveRecording(): void {
		const rec = this.activeRecording;
		if (!rec) {
			return;
		}
		if (rec.timer !== undefined) {
			mainWindow.clearInterval(rec.timer);
			rec.timer = undefined;
		}
		this.activeRecording = undefined;
		try {
			if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
				rec.mediaRecorder.stop();
			} else {
				rec.stream.getTracks().forEach(track => track.stop());
			}
		} catch {
			rec.stream.getTracks().forEach(track => track.stop());
		}
		this.syncVoiceUiState(rec.noteId);
	}

	private async toggleVoiceRecording(noteId: string): Promise<void> {
		// If currently recording this note, stop and trigger transcription
		if (this.activeRecording?.noteId === noteId) {
			this.stopActiveRecording();
			return;
		}

		// Ignore click while this note is already transcribing
		if (this.transcribingNoteIds.has(noteId)) {
			return;
		}

		// If another note is recording, stop it first so its audio transcribes cleanly
		if (this.activeRecording) {
			this.stopActiveRecording();
		}

		const textarea = this.textareaById.get(noteId);
		const savedSel = this.lastSelectionById.get(noteId);
		const selectionStart = (textarea && typeof textarea.selectionStart === 'number')
			? textarea.selectionStart
			: savedSel?.start;
		const selectionEnd = (textarea && typeof textarea.selectionEnd === 'number')
			? textarea.selectionEnd
			: savedSel?.end;

		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const audioChunks: BlobPart[] = [];
			const mediaRecorder = new mainWindow.MediaRecorder(stream);

			const recording: IActiveVoiceRecording = {
				noteId,
				mediaRecorder,
				stream,
				seconds: 0,
				cancelled: false,
				selectionStart,
				selectionEnd
			};
			this.activeRecording = recording;

			mediaRecorder.ondataavailable = (e: BlobEvent) => {
				if (e.data && e.data.size > 0) {
					audioChunks.push(e.data);
				}
			};

			mediaRecorder.onstop = async () => {
				if (recording.timer !== undefined) {
					mainWindow.clearInterval(recording.timer);
					recording.timer = undefined;
				}
				stream.getTracks().forEach(track => track.stop());

				if (this.activeRecording === recording) {
					this.activeRecording = undefined;
				}

				if (recording.cancelled) {
					this.syncVoiceUiState(noteId);
					return;
				}

				const noteExists = this.quickNotesService.getNotes().some(n => n.id === noteId);
				if (!noteExists || audioChunks.length === 0) {
					this.syncVoiceUiState(noteId);
					return;
				}

				this.transcribingNoteIds.add(noteId);
				this.syncVoiceUiState(noteId);

				try {
					const actualMime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
					const audioBlob = new Blob(audioChunks, { type: actualMime });

					// Optionally retain the recorded audio file as an attachment when user enabled Keep Voice Audio
					if (this.quickNotesService.getKeepVoiceAudio()) {
						try {
							const dataUrl = await this.blobToDataUrl(audioBlob);
							this.quickNotesService.addAttachment(noteId, {
								kind: 'audio',
								mimeType: actualMime,
								dataUrl,
								durationSeconds: Math.max(1, recording.seconds)
							});
						} catch {
							// Non-fatal: continue transcription even if audio attachment save failed
						}
					}

					const result = await this.voiceModelService.transcribeAudio(audioBlob);

					if (result.text && result.text.trim()) {
						this.insertTranscribedText(noteId, result.text.trim(), recording.selectionStart, recording.selectionEnd);
					} else if (result.error) {
						this.notificationService.warn(localize('quickNotes.transcribeWarn', "Voice Transcription: {0}", result.error));
					}
				} catch (err) {
					this.notificationService.error(localize('quickNotes.transcribeError', "Voice transcription error: {0}", (err as Error | undefined)?.message || String(err)));
				} finally {
					this.transcribingNoteIds.delete(noteId);
					this.syncVoiceUiState(noteId);
				}
			};

			mediaRecorder.start();
			recording.timer = mainWindow.setInterval(() => {
				recording.seconds += 1;
				this.syncVoiceUiState(noteId);
			}, 1000);
			this.syncVoiceUiState(noteId);
		} catch (err) {
			this.notificationService.error(localize('quickNotes.micError', "Unable to access microphone: {0}", (err as Error | undefined)?.message || String(err)));
			this.syncVoiceUiState(noteId);
		}
	}

	private insertTranscribedText(noteId: string, transcribed: string, recordedStart?: number, recordedEnd?: number): void {
		const note = this.quickNotesService.getNotes().find(n => n.id === noteId);
		if (!note) {
			return;
		}

		const textarea = this.textareaById.get(noteId);
		const existing = textarea ? textarea.value : note.content;
		const savedSel = this.lastSelectionById.get(noteId);

		let start = typeof recordedStart === 'number'
			? recordedStart
			: (savedSel ? savedSel.start : existing.length);
		let end = typeof recordedEnd === 'number'
			? recordedEnd
			: (savedSel ? savedSel.end : existing.length);

		if (start < 0 || start > existing.length) { start = existing.length; }
		if (end < 0 || end > existing.length) { end = existing.length; }
		if (start > end) { const tmp = start; start = end; end = tmp; }

		const beforeText = existing.substring(0, start);
		const afterText = existing.substring(end);
		let insertText = transcribed;
		if (start > 0 && !/\s$/.test(beforeText) && !/^\s/.test(insertText)) {
			insertText = ' ' + insertText;
		}
		if (end < existing.length && !/^\s/.test(afterText) && !/\s$/.test(insertText)) {
			insertText = insertText + ' ';
		}

		const nextValue = beforeText + insertText + afterText;
		const newCursorPos = start + insertText.length;

		this.quickNotesService.updateNote(noteId, nextValue);
		this.lastSelectionById.set(noteId, { start: newCursorPos, end: newCursorPos });

		if (textarea && textarea.isConnected) {
			textarea.value = nextValue;
			textarea.selectionStart = newCursorPos;
			textarea.selectionEnd = newCursorPos;
			this.adjustTextareaHeight(textarea);
			textarea.focus({ preventScroll: true });
		}
	}

	private renderNotes(): void {
		if (!this.listContainerEl) {
			return;
		}

		this.listDisposables.clear();
		this.textareaById.clear();
		this.voiceUiById.clear();
		clearNode(this.listContainerEl);

		const notes = this.quickNotesService.getNotes();

		if (notes.length === 0) {
			const emptyEl = append(this.listContainerEl, $('.quick-notes-empty'));
			append(emptyEl, $('span.quick-notes-empty-icon' + ThemeIcon.asCSSSelector(Codicon.note)));
			const textEl = append(emptyEl, $('.quick-notes-empty-text'));
			textEl.textContent = localize('quickNotes.empty', "No quick notes yet. Click the note icon in the top toolbar or the button below to create one.");

			const createBtn = append(emptyEl, $('button.quick-notes-empty-btn', { type: 'button' }));
			append(createBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.add)));
			const btnLabel = append(createBtn, $('span'));
			btnLabel.textContent = localize('quickNotes.newNoteBtn', "New Note");

			this.listDisposables.add(addDisposableListener(createBtn, EventType.CLICK, () => {
				const note = this.quickNotesService.createNote();
				this.focusNote(note.id);
			}));
			return;
		}

		for (const note of notes) {
			this.renderNoteCard(this.listContainerEl, note);
		}

		const focusId = this.pendingFocusNoteId;
		this.lastCreatedNoteId = undefined;

		if (focusId) {
			const textarea = this.textareaById.get(focusId);
			if (textarea) {
				this.listContainerEl.scrollTop = 0;
				setTimeout(() => {
					textarea.focus();
				}, 0);
				this.pendingFocusNoteId = undefined;
			}
		}
	}

	private blobToDataUrl(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(String(reader.result || ''));
			reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
			reader.readAsDataURL(blob);
		});
	}

	private dataUrlToBlob(dataUrl: string, fallbackMime = 'application/octet-stream'): Blob {
		const commaIdx = dataUrl.indexOf(',');
		if (commaIdx === -1) {
			return new Blob([], { type: fallbackMime });
		}
		const header = dataUrl.substring(0, commaIdx);
		const b64 = dataUrl.substring(commaIdx + 1);
		const mimeMatch = header.match(/data:([^;]+)/i);
		const mime = (mimeMatch ? mimeMatch[1] : '') || fallbackMime;
		const bstr = atob(b64);
		const u8arr = new Uint8Array(bstr.length);
		for (let i = 0; i < bstr.length; i++) {
			u8arr[i] = bstr.charCodeAt(i);
		}
		return new Blob([u8arr], { type: mime });
	}

	private stopActiveAudio(): void {
		if (this.activeAudioEl) {
			try {
				this.activeAudioEl.onended = null;
				this.activeAudioEl.onerror = null;
				this.activeAudioEl.pause();
				this.activeAudioEl.currentTime = 0;
			} catch { }
			this.activeAudioEl = undefined;
		}
		if (this.activeAudioBlobUrl) {
			try {
				URL.revokeObjectURL(this.activeAudioBlobUrl);
			} catch { }
			this.activeAudioBlobUrl = undefined;
		}
		if (this.activeAudioChipEl) {
			this.activeAudioChipEl.classList.remove('playing');
			this.activeAudioChipEl = undefined;
		}
		this.activeAudioAttachmentId = undefined;
	}

	private togglePlayAudioAttachment(attachment: IQuickNoteAttachment, chipEl: HTMLElement): void {
		if (this.activeAudioAttachmentId === attachment.id) {
			this.stopActiveAudio();
			return;
		}
		this.stopActiveAudio();
		try {
			const blob = this.dataUrlToBlob(attachment.dataUrl, attachment.mimeType || 'audio/webm');
			const blobUrl = URL.createObjectURL(blob);
			const audio = new Audio(blobUrl);
			this.activeAudioEl = audio;
			this.activeAudioBlobUrl = blobUrl;
			this.activeAudioAttachmentId = attachment.id;
			this.activeAudioChipEl = chipEl;
			chipEl.classList.add('playing');
			audio.onended = () => this.stopActiveAudio();
			audio.onerror = () => {
				this.notificationService.error(localize('quickNotes.audioPlayError', "Unable to play recorded voice clip."));
				this.stopActiveAudio();
			};
			void audio.play().catch(err => {
				this.notificationService.error(localize('quickNotes.audioPlayErrorDetail', "Voice playback error: {0}", err?.message || String(err)));
				this.stopActiveAudio();
			});
		} catch (err) {
			this.notificationService.error(localize('quickNotes.audioPlayErrorDetail', "Voice playback error: {0}", (err as Error | undefined)?.message || String(err)));
			this.stopActiveAudio();
		}
	}

	private async attachFilesToNote(noteId: string, files: Iterable<File>): Promise<number> {
		let added = 0;
		for (const file of files) {
			if (!file) {
				continue;
			}
			const mime = (file.type || '').toLowerCase();
			const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
			const isAudio = mime.startsWith('audio/') || /\.(webm|mp3|wav|m4a|ogg|aac)$/i.test(file.name || '');
			if (!isImage && !isAudio) {
				continue;
			}
			try {
				const dataUrl = await this.blobToDataUrl(file);
				if (dataUrl) {
					this.quickNotesService.addAttachment(noteId, {
						kind: isImage ? 'image' : 'audio',
						name: file.name || (isImage ? 'Screenshot.png' : 'Voice.webm'),
						mimeType: mime || (isImage ? 'image/png' : 'audio/webm'),
						dataUrl
					});
					added++;
				}
			} catch {
				// Ignore unreadable dropped file
			}
		}
		return added;
	}

	private openImagePreviewModal(attachment: IQuickNoteAttachment): void {
		const overlay = document.createElement('div');
		overlay.className = 'quick-note-image-lightbox';
		const img = document.createElement('img');
		img.src = attachment.dataUrl;
		img.alt = attachment.name || 'Image attachment';
		overlay.appendChild(img);

		const close = () => {
			overlay.remove();
			mainWindow.removeEventListener('keydown', onKeyDown, true);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				close();
			}
		};
		overlay.addEventListener('click', close);
		mainWindow.addEventListener('keydown', onKeyDown, true);
		mainWindow.document.body.appendChild(overlay);
	}

	private renderNoteCard(parent: HTMLElement, note: IQuickNoteItem): void {
		const isNew = this.lastCreatedNoteId === note.id;
		const cardEl = append(parent, $(isNew ? '.quick-note-card.is-new' : '.quick-note-card'));

		// Hidden file picker for "Add Image..." menu action
		const hiddenFileInput = append(cardEl, $('input', {
			type: 'file',
			accept: 'image/*,audio/*',
			multiple: 'true',
			style: 'display: none;'
		})) as HTMLInputElement;
		this.listDisposables.add(addDisposableListener(hiddenFileInput, EventType.CHANGE, async () => {
			if (hiddenFileInput.files && hiddenFileInput.files.length > 0) {
				await this.attachFilesToNote(note.id, Array.from(hiddenFileInput.files));
				hiddenFileInput.value = '';
			}
		}));

		// Drag & Drop support for macOS screenshots / images / audio files directly onto the note card
		this.listDisposables.add(addDisposableListener(cardEl, EventType.DRAG_OVER, (e: DragEvent) => {
			if (e.dataTransfer && (e.dataTransfer.types.includes('Files') || Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file'))) {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = 'copy';
				cardEl.classList.add('drag-over');
			}
		}));
		this.listDisposables.add(addDisposableListener(cardEl, EventType.DRAG_LEAVE, (e: DragEvent) => {
			if (!cardEl.contains(e.relatedTarget as Node | null)) {
				cardEl.classList.remove('drag-over');
			}
		}));
		this.listDisposables.add(addDisposableListener(cardEl, EventType.DROP, async (e: DragEvent) => {
			cardEl.classList.remove('drag-over');
			const dt = e.dataTransfer;
			if (!dt || !dt.files || dt.files.length === 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			await this.attachFilesToNote(note.id, Array.from(dt.files));
		}));

		const headerEl = append(cardEl, $('.quick-note-card-header'));
		const headerLeftEl = append(headerEl, $('.quick-note-header-left'));

		// Compact Status Colored Dot (click to expand To Do / Doing / Done menu)
		const currentStatus: QuickNoteStatus = note.status ?? 'todo';
		const statusLabelMap: Record<QuickNoteStatus, string> = {
			todo: localize('quickNotes.status.todo', "To Do"),
			doing: localize('quickNotes.status.doing', "Doing"),
			done: localize('quickNotes.status.done', "Done")
		};
		const statusDotBtn = append(headerLeftEl, $('button.quick-note-status-dot-btn', {
			type: 'button',
			title: localize('quickNotes.statusDotTitle', "Status: {0} (Click to change)", statusLabelMap[currentStatus]),
			'aria-label': localize('quickNotes.statusDotTitle', "Status: {0} (Click to change)", statusLabelMap[currentStatus])
		})) as HTMLButtonElement;
		const statusDot = append(statusDotBtn, $(`span.quick-note-status-dot.status-${currentStatus}`));
		void statusDot;

		this.listDisposables.add(addDisposableListener(statusDotBtn, EventType.CLICK, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = statusDotBtn.getBoundingClientRect();
			const statuses: QuickNoteStatus[] = ['todo', 'doing', 'done'];
			const actions = statuses.map(st => new Action(
				`quickNotes.setStatus.${st}`,
				statusLabelMap[st],
				undefined,
				true,
				() => {
					this.quickNotesService.updateNoteStatus(note.id, st);
				}
			));
			actions.forEach((act, idx) => {
				act.checked = statuses[idx] === currentStatus;
			});
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: rect.left, y: rect.bottom + 2 }),
				getActions: () => actions
			});
		}));

		const tsParts = this.getTimestampParts(note.createdAt);
		const metaEl = append(headerLeftEl, $('.quick-note-meta', { title: tsParts.full }));
		append(metaEl, $('span.qn-ts-year', {}, tsParts.year));
		append(metaEl, $('span.qn-ts-md', {}, tsParts.monthDay));
		append(metaEl, $('span.qn-ts-time', {}, tsParts.time));

		const actionsEl = append(headerEl, $('.quick-note-actions'));

		// Copy button (copies text + all image/audio attachments)
		const copyBtn = append(actionsEl, $('button.quick-note-action-btn.copy-btn', {
			type: 'button',
			title: localize('quickNotes.copyNoteAll', "Copy note (text + attachments)"),
			'aria-label': localize('quickNotes.copyNoteAll', "Copy note (text + attachments)")
		}));
		const copyIcon = append(copyBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.copy)));

		let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
		this.listDisposables.add({
			dispose: () => {
				if (copyResetTimer !== undefined) {
					clearTimeout(copyResetTimer);
				}
			}
		});

		this.listDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, async () => {
			const atts = (note.attachments || []).map(a => ({
				kind: a.kind,
				name: a.name,
				mimeType: a.mimeType,
				dataUrl: a.dataUrl,
				durationSeconds: a.durationSeconds
			}));
			QuickNotesPane.copiedNotePayload = {
				text: note.content || '',
				attachments: atts
			};
			await this.clipboardService.writeText(note.content || '');
			// Also write first image to OS clipboard if available for pasting into external apps
			const firstImg = atts.find(a => a.kind === 'image');
			if (firstImg && typeof navigator.clipboard?.write === 'function' && typeof mainWindow.ClipboardItem === 'function') {
				try {
					const imgBlob = this.dataUrlToBlob(firstImg.dataUrl, firstImg.mimeType || 'image/png');
					const itemPayload: Record<string, Blob> = {};
					if (imgBlob.type === 'image/png') {
						itemPayload['image/png'] = imgBlob;
					}
					if (note.content) {
						itemPayload['text/plain'] = new Blob([note.content], { type: 'text/plain' });
					}
					if (Object.keys(itemPayload).length > 0) {
						await navigator.clipboard.write([new mainWindow.ClipboardItem(itemPayload)]);
					}
				} catch {
					// Fallback already succeeded via clipboardService.writeText
				}
			}
			copyBtn.classList.add('copied');
			copyIcon.className = ThemeIcon.asClassName(Codicon.check);
			if (copyResetTimer !== undefined) {
				clearTimeout(copyResetTimer);
			}
			copyResetTimer = setTimeout(() => {
				copyBtn.classList.remove('copied');
				copyIcon.className = ThemeIcon.asClassName(Codicon.copy);
				copyResetTimer = undefined;
			}, 1200);
		}));

		// Paste button (pastes text and/or images/attachments from OS clipboard or copied Quick Note)
		const pasteBtn = append(actionsEl, $('button.quick-note-action-btn.paste-btn', {
			type: 'button',
			title: localize('quickNotes.pasteNoteAll', "Paste text or image/attachments from clipboard"),
			'aria-label': localize('quickNotes.pasteNoteAll', "Paste text or image/attachments from clipboard")
		}));
		const pasteIcon = append(pasteBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.clippy)));

		let pasteResetTimer: ReturnType<typeof setTimeout> | undefined;
		this.listDisposables.add({
			dispose: () => {
				if (pasteResetTimer !== undefined) {
					clearTimeout(pasteResetTimer);
				}
			}
		});

		this.listDisposables.add(addDisposableListener(pasteBtn, EventType.MOUSE_DOWN, e => {
			e.preventDefault();
			e.stopPropagation();
			const ta = this.textareaById.get(note.id);
			if (ta && typeof ta.selectionStart === 'number' && typeof ta.selectionEnd === 'number') {
				this.lastSelectionById.set(note.id, { start: ta.selectionStart, end: ta.selectionEnd });
			}
		}));

		const insertTextAtCursor = (clipText: string) => {
			const ta = this.textareaById.get(note.id);
			const existing = ta ? ta.value : note.content;
			const savedSel = this.lastSelectionById.get(note.id);

			let start = (ta && ta.ownerDocument.activeElement === ta && typeof ta.selectionStart === 'number')
				? ta.selectionStart
				: (savedSel ? savedSel.start : existing.length);
			let end = (ta && ta.ownerDocument.activeElement === ta && typeof ta.selectionEnd === 'number')
				? ta.selectionEnd
				: (savedSel ? savedSel.end : existing.length);

			if (start < 0 || start > existing.length) { start = existing.length; }
			if (end < 0 || end > existing.length) { end = existing.length; }
			if (start > end) { const tmp = start; start = end; end = tmp; }

			const nextValue = existing.substring(0, start) + clipText + existing.substring(end);
			const newCursorPos = start + clipText.length;

			this.quickNotesService.updateNote(note.id, nextValue);
			this.lastSelectionById.set(note.id, { start: newCursorPos, end: newCursorPos });

			if (ta && ta.isConnected) {
				ta.value = nextValue;
				ta.selectionStart = newCursorPos;
				ta.selectionEnd = newCursorPos;
				this.adjustTextareaHeight(ta);
				ta.focus({ preventScroll: true });
			}
		};

		this.listDisposables.add(addDisposableListener(pasteBtn, EventType.CLICK, async () => {
			let pastedAnything = false;
			const clipText = await this.clipboardService.readText();
			const richPayload = QuickNotesPane.copiedNotePayload;

			// 1. If user copied a Quick Note (rich payload matches OS text), paste both text & all attachments
			if (richPayload && richPayload.attachments.length > 0 && (clipText || '') === richPayload.text) {
				if (richPayload.text) {
					insertTextAtCursor(richPayload.text);
					pastedAnything = true;
				}
				for (const att of richPayload.attachments) {
					this.quickNotesService.addAttachment(note.id, { ...att });
					pastedAnything = true;
				}
			} else {
				// 2. Check OS clipboard for pasted images (e.g. macOS screenshot)
				if (typeof navigator.clipboard?.read === 'function') {
					try {
						const clipItems = await navigator.clipboard.read();
						for (const item of clipItems) {
							const imgType = (item.types || []).find((t: string) => t.startsWith('image/'));
							if (imgType) {
								const blob: Blob = await item.getType(imgType);
								const dataUrl = await this.blobToDataUrl(blob);
								if (dataUrl) {
									this.quickNotesService.addAttachment(note.id, {
										kind: 'image',
										name: `Pasted Image.${imgType.split('/')[1] || 'png'}`,
										mimeType: imgType,
										dataUrl
									});
									pastedAnything = true;
								}
							}
						}
					} catch {
						// Clipboard image read not permitted or empty — fall back to text
					}
				}
				if (clipText) {
					insertTextAtCursor(clipText);
					pastedAnything = true;
				}
			}

			if (!pastedAnything) {
				return;
			}

			pasteBtn.classList.add('copied');
			pasteIcon.className = ThemeIcon.asClassName(Codicon.check);
			if (pasteResetTimer !== undefined) {
				clearTimeout(pasteResetTimer);
			}
			pasteResetTimer = setTimeout(() => {
				pasteBtn.classList.remove('copied');
				pasteIcon.className = ThemeIcon.asClassName(Codicon.clippy);
				pasteResetTimer = undefined;
			}, 1200);
		}));

		// More Actions Menu (...) — consolidates Keep Voice Audio toggle, Add Image, and Delete Note
		const moreBtn = append(actionsEl, $('button.quick-note-action-btn.more-btn', {
			type: 'button',
			title: localize('quickNotes.moreActions', "More actions..."),
			'aria-label': localize('quickNotes.moreActions', "More actions...")
		})) as HTMLButtonElement;
		append(moreBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.ellipsis)));

		this.listDisposables.add(addDisposableListener(moreBtn, EventType.CLICK, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = moreBtn.getBoundingClientRect();
			const keepVoice = this.quickNotesService.getKeepVoiceAudio();
			const keepVoiceAction = new Action(
				'quickNotes.toggleKeepVoiceAudio',
				localize('quickNotes.keepVoiceAudio', "Keep Voice Audio"),
				undefined,
				true,
				() => {
					const nextVal = !this.quickNotesService.getKeepVoiceAudio();
					this.quickNotesService.setKeepVoiceAudio(nextVal);
				}
			);
			keepVoiceAction.checked = keepVoice;

			const addImageAction = new Action(
				'quickNotes.addImage',
				localize('quickNotes.addAttachment', "Add Image / Audio..."),
				undefined,
				true,
				() => {
					hiddenFileInput.click();
				}
			);

			const deleteAction = new Action(
				'quickNotes.deleteNoteAction',
				localize('quickNotes.deleteNote', "Delete Note"),
				undefined,
				true,
				() => {
					if (this.activeRecording?.noteId === note.id) {
						this.cancelActiveRecording();
					}
					if (this.activeAudioAttachmentId && (note.attachments || []).some(a => a.id === this.activeAudioAttachmentId)) {
						this.stopActiveAudio();
					}
					this.quickNotesService.deleteNote(note.id);
				}
			);

			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: rect.right, y: rect.bottom + 2 }),
				getActions: () => [
					keepVoiceAction,
					addImageAction,
					new Separator(),
					deleteAction
				]
			});
		}));

		// Editor area wrapper (textarea + attachments tray + voice microphone control)
		const editorWrap = append(cardEl, $('.quick-note-editor-wrap'));

		const textarea = append(editorWrap, $('textarea.quick-note-textarea', {
			placeholder: localize('quickNotes.placeholderRich', "Type, paste/drop images, or use the mic..."),
			spellcheck: 'false'
		})) as HTMLTextAreaElement;
		textarea.value = note.content;
		this.textareaById.set(note.id, textarea);

		const recordSelection = () => {
			if (typeof textarea.selectionStart === 'number' && typeof textarea.selectionEnd === 'number') {
				this.lastSelectionById.set(note.id, {
					start: textarea.selectionStart,
					end: textarea.selectionEnd
				});
			}
		};

		this.listDisposables.add(addDisposableListener(textarea, EventType.KEY_UP, recordSelection));
		this.listDisposables.add(addDisposableListener(textarea, EventType.MOUSE_UP, recordSelection));
		this.listDisposables.add(addDisposableListener(textarea, EventType.SELECT, recordSelection));

		// Support direct Cmd+V / Ctrl+V image pasting inside the textarea (Teams / ChatGPT style)
		this.listDisposables.add(addDisposableListener(textarea, 'paste', async (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) {
				return;
			}
			const imageFiles: File[] = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.kind === 'file' && item.type.startsWith('image/')) {
					const f = item.getAsFile();
					if (f) {
						imageFiles.push(f);
					}
				}
			}
			if (imageFiles.length > 0) {
				e.preventDefault();
				await this.attachFilesToNote(note.id, imageFiles);
			}
		}));

		// Defer initial auto-height calculation until attached/laid out
		setTimeout(() => {
			if (textarea.isConnected) {
				this.adjustTextareaHeight(textarea);
			}
		}, 0);

		this.listDisposables.add(addDisposableListener(textarea, EventType.INPUT, () => {
			recordSelection();
			this.quickNotesService.updateNote(note.id, textarea.value);
			this.adjustTextareaHeight(textarea);
		}));

		// Compact Attachments Tray (images thumbnails + recorded audio chips)
		const attachments = Array.isArray(note.attachments) ? note.attachments : [];
		if (attachments.length > 0) {
			const trayEl = append(editorWrap, $('.quick-note-attachments'));
			for (const att of attachments) {
				if (att.kind === 'image') {
					const imgChip = append(trayEl, $('.quick-note-img-chip'));
					const imgEl = append(imgChip, $('img', {
						src: att.dataUrl,
						alt: att.name || 'Image',
						title: localize('quickNotes.clickPreviewImage', "{0} — Click to preview", att.name || 'Image')
					})) as HTMLImageElement;
					this.listDisposables.add(addDisposableListener(imgEl, EventType.CLICK, (e: MouseEvent) => {
						e.stopPropagation();
						this.openImagePreviewModal(att);
					}));
					const removeBtn = append(imgChip, $('button.quick-note-att-remove', {
						type: 'button',
						title: localize('quickNotes.removeAttachment', "Remove attachment")
					}));
					append(removeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
					this.listDisposables.add(addDisposableListener(removeBtn, EventType.CLICK, (e: MouseEvent) => {
						e.stopPropagation();
						this.quickNotesService.removeAttachment(note.id, att.id);
					}));
				} else if (att.kind === 'audio') {
					const isPlaying = this.activeAudioAttachmentId === att.id;
					const audioChip = append(trayEl, $(`.quick-note-audio-chip${isPlaying ? '.playing' : ''}`));
					if (isPlaying) {
						this.activeAudioChipEl = audioChip;
					}
					const playBtn = append(audioChip, $('button.quick-note-audio-play-btn', {
						type: 'button',
						title: localize('quickNotes.playAudioClip', "Play / stop recorded voice clip")
					}));
					append(playBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.unmute)));
					const durText = append(playBtn, $('span.quick-note-audio-dur'));
					durText.textContent = this.formatRecordingDuration(att.durationSeconds || 0);
					this.listDisposables.add(addDisposableListener(playBtn, EventType.CLICK, (e: MouseEvent) => {
						e.stopPropagation();
						this.togglePlayAudioAttachment(att, audioChip);
					}));
					const removeBtn = append(audioChip, $('button.quick-note-att-remove-inline', {
						type: 'button',
						title: localize('quickNotes.removeVoiceClip', "Remove voice clip")
					}));
					append(removeBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
					this.listDisposables.add(addDisposableListener(removeBtn, EventType.CLICK, (e: MouseEvent) => {
						e.stopPropagation();
						if (this.activeAudioAttachmentId === att.id) {
							this.stopActiveAudio();
						}
						this.quickNotesService.removeAttachment(note.id, att.id);
					}));
				}
			}
		}

		// Voice recording bar inside editing area
		const voiceBar = append(editorWrap, $('.quick-note-voice-bar'));
		const statusEl = append(voiceBar, $('.quick-note-voice-status'));
		append(statusEl, $('span.quick-note-voice-dot'));
		const statusTextEl = append(statusEl, $('span'));

		const micBtn = append(voiceBar, $('button.quick-note-mic-btn', {
			type: 'button',
			title: localize('quickNotes.recordVoice', "Record voice input (Speech-to-Text)"),
			'aria-label': localize('quickNotes.recordVoice', "Record voice input (Speech-to-Text)")
		})) as HTMLButtonElement;
		const micIcon = append(micBtn, $('span' + ThemeIcon.asCSSSelector(Codicon.mic)));

		this.voiceUiById.set(note.id, { micBtn, micIcon, statusEl, statusTextEl });
		this.syncVoiceUiState(note.id);

		// Preserve textarea selection when clicking the mic button
		this.listDisposables.add(addDisposableListener(micBtn, EventType.MOUSE_DOWN, e => {
			e.preventDefault();
			e.stopPropagation();
			recordSelection();
		}));

		this.listDisposables.add(addDisposableListener(micBtn, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			void this.toggleVoiceRecording(note.id);
		}));
	}
}
