/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IVoiceModelService } from '../../../voiceModels/common/voiceModel.js';
import { confirmLargeMediaDecode, confirmSubtitleReextract, extractMediaSubtitleDocument, readMediaSubtitleDocument, resolveMediaUri, writeMediaSubtitleDocument } from '../../../voiceModels/browser/mediaSubtitleJob.js';
import { findLastStartedSegment, findSegmentAt, formatClock, ISubtitleDocument, ISubtitleSegment, matchSubtitleDocument, toSrt, toVtt } from '../../../voiceModels/common/subtitles.js';
import { buildDictationUnits, DictationUnitKind, diffWords, findUnitAt, IDictationAnswer, IDictationUnit, IWordDiffOp, MIN_DICTATION_SECONDS } from '../../../voiceModels/common/dictation.js';
import { dictationModeToggleTitle, IMediaSubtitlesConfig, IMediaSubtitlesState, SubtitleDisplayMode } from '../../../voiceModels/common/subtitleConfig.js';

/** What the media player card provides to the subtitle panel. */
export interface IMediaSubtitlesHost {
	/** Ticket folder; subtitles are stored in its `attachments/` folder. */
	readonly ticketFolder: URI | undefined;
	readonly fieldKey: string;
	/** Both media elements of the card (audio + video); the panel listens to both. */
	readonly mediaElements: readonly HTMLMediaElement[];
	/** The element currently playing the loaded file. */
	getActiveMedia(): HTMLMediaElement;
	/** The loaded media: local path when known, else the in-memory blob URL. Undefined when nothing is loaded. */
	getMediaSource(): { readonly name: string; readonly path?: string; readonly blobUrl?: string } | undefined;
	/** Persists the panel state into the ticket's data for this field. */
	saveState(state: IMediaSubtitlesState): void;
}

const ACCENT = '#38bdf8';
const BTN_STYLE = 'width: 26px; height: 24px; border-radius: 5px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(0, 122, 204, 0.16); color: #7dd3fc; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; flex-shrink: 0;';
const BTN_ACTIVE_BG = 'rgba(0, 122, 204, 0.55)';
const BTN_IDLE_BG = 'rgba(0, 122, 204, 0.16)';
const DIFF_COLORS: Record<IWordDiffOp['kind'], string> = { correct: '#4ade80', wrong: '#f87171', missing: '#fbbf24', extra: '#94a3b8' };

function iconButton(icon: string, title: string): HTMLButtonElement {
	return $<HTMLButtonElement>('button.media-subs-btn', { type: 'button', title, 'aria-label': title, style: BTN_STYLE }, $(`span.codicon.codicon-${icon}`, { style: 'font-size: 13px;' }));
}

function setActive(btn: HTMLButtonElement, active: boolean): void {
	btn.style.background = active ? BTN_ACTIVE_BG : BTN_IDLE_BG;
	btn.style.color = active ? '#ffffff' : '#7dd3fc';
	btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function show(el: HTMLElement, visible: boolean, display = 'flex'): void {
	el.style.display = visible ? display : 'none';
}

/**
 * Subtitles + dictation UI under the MP3 / MP4 player card (CI-45): extraction with progress / cancel,
 * single-line, scrolling and dictation display modes, SRT / VTT export, and dictation answers saved per unit.
 */
export class MediaSubtitlesPanel extends Disposable {

	private readonly root: HTMLElement;
	private readonly statusText: HTMLElement;
	private readonly extractBtn: HTMLButtonElement;
	private readonly cancelBtn: HTMLButtonElement;
	private readonly exportBtn: HTMLButtonElement;
	private readonly modeBtns: Record<SubtitleDisplayMode, HTMLButtonElement>;
	private readonly progressWrap: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly progressText: HTMLElement;
	private readonly errorBox: HTMLElement;
	private readonly singleView: HTMLElement;
	private readonly singleText: HTMLElement;
	private readonly scrollView: HTMLElement;
	private readonly dictationView: HTMLElement;
	private readonly unitLabel: HTMLElement;
	private readonly scoreLabel: HTMLElement;
	private readonly prevBtn: HTMLButtonElement;
	private readonly replayBtn: HTMLButtonElement;
	private readonly nextBtn: HTMLButtonElement;
	private readonly autoPauseBtn: HTMLButtonElement;
	private readonly revealBtn: HTMLButtonElement;
	private readonly unitSelect: HTMLSelectElement;
	private readonly secondsInput: HTMLInputElement;
	private readonly contextLine: HTMLElement;
	private readonly answerInput: HTMLTextAreaElement;
	private readonly resultBox: HTMLElement;

	private doc: ISubtitleDocument | undefined;
	private segments: ISubtitleSegment[] = [];
	private scrollRows: HTMLElement[] = [];
	private units: IDictationUnit[] = [];
	private unitIndex = 0;
	private lastShownIndex = -2;
	private revealed = false;
	private checkedText: string | undefined;
	private mode: SubtitleDisplayMode;
	private unitKind: DictationUnitKind;
	private unitSeconds: number;
	private autoPause: boolean;
	private answers: Record<string, IDictationAnswer>;
	private subtitlesFile: string | undefined;
	private running: CancellationTokenSource | undefined;
	private readonly frame = this._register(new MutableDisposable());
	private readonly rowListeners = this._register(new DisposableStore());
	private readonly saveScheduler: RunOnceScheduler;

	constructor(
		container: HTMLElement,
		private readonly host: IMediaSubtitlesHost,
		private readonly config: IMediaSubtitlesConfig,
		initialState: IMediaSubtitlesState,
		@IVoiceModelService private readonly voiceModelService: IVoiceModelService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();
		this.mode = initialState.subtitleDisplayMode ?? config.displayMode;
		this.unitKind = initialState.dictationUnit ?? config.dictationUnit;
		this.unitSeconds = Math.max(MIN_DICTATION_SECONDS, initialState.dictationSeconds ?? config.dictationSeconds);
		this.autoPause = initialState.dictationAutoPause ?? config.autoPause;
		this.answers = { ...(initialState.dictation ?? {}) };
		this.subtitlesFile = initialState.subtitlesFile;
		this.saveScheduler = this._register(new RunOnceScheduler(() => this.host.saveState(this.getState()), 400));

		this.root = append(container, $('div.media-subtitles-panel', { style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.28); border: 1px solid rgba(56, 189, 248, 0.25);' }));

		// Toolbar
		const toolbar = append(this.root, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
		append(toolbar, $('span.codicon.codicon-symbol-text', { style: `font-size: 13px; color: ${ACCENT};` }));
		append(toolbar, $('span', { style: 'font-size: 11.5px; font-weight: 700; color: #e2e8f0;' }, 'Subtitles'));
		this.statusText = append(toolbar, $('span', { style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.55); flex: 1; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }));
		const modelLabel = config.provider ? `${config.provider} / ${config.model || 'default model'}` : 'the active voice model';
		this.extractBtn = append(toolbar, iconButton('sparkle', `Extract subtitles with ${modelLabel}`));
		this.cancelBtn = append(toolbar, iconButton('debug-stop', 'Cancel extraction'));
		show(this.cancelBtn, false, 'inline-flex');
		append(toolbar, $('span', { style: 'width: 1px; height: 18px; background: rgba(255, 255, 255, 0.15); margin: 0 2px;' }));
		this.modeBtns = {
			single: append(toolbar, iconButton('symbol-string', 'Single line: show the current subtitle')),
			scroll: append(toolbar, iconButton('list-flat', 'Scrolling: all subtitles, current line centred (click a line to jump)')),
			dictation: append(toolbar, iconButton('keyboard', 'Dictation practice: type what you hear and compare'))
		};
		this.exportBtn = append(toolbar, iconButton('desktop-download', 'Export subtitles as SRT or VTT'));

		// Progress + error
		this.progressWrap = append(this.root, $('div', { style: 'display: none; flex-direction: column; gap: 4px;' }));
		const track = append(this.progressWrap, $('div', { style: 'height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden;' }));
		this.progressFill = append(track, $('div', { style: `height: 100%; width: 0%; background: linear-gradient(90deg, #007acc, ${ACCENT}); transition: width 0.2s ease;` }));
		this.progressText = append(this.progressWrap, $('span', { style: 'font-size: 10.5px; color: #7dd3fc;' }));
		this.errorBox = append(this.root, $('div', { style: 'display: none; padding: 6px 10px; border-radius: 6px; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.45); color: #fca5a5; font-size: 11px; line-height: 1.4; white-space: pre-wrap;' }));

		// Single line view
		this.singleView = append(this.root, $('div', { style: 'display: none; min-height: 46px; align-items: center; justify-content: center; padding: 8px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.35);' }));
		this.singleText = append(this.singleView, $('div', { style: 'font-size: 15px; line-height: 1.45; color: #f8fafc; text-align: center; font-weight: 500;' }));

		// Scrolling view
		this.scrollView = append(this.root, $('div', { style: 'display: none; position: relative; max-height: 240px; overflow-y: auto; flex-direction: column; gap: 2px; padding: 4px; border-radius: 6px; background: rgba(0, 0, 0, 0.35);' }));

		// Dictation view
		this.dictationView = append(this.root, $('div', { style: 'display: none; flex-direction: column; gap: 6px;' }));
		const dictHeader = append(this.dictationView, $('div', { style: 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }));
		this.prevBtn = append(dictHeader, iconButton('chevron-left', 'Previous unit (Ctrl+B)'));
		this.replayBtn = append(dictHeader, iconButton('debug-restart', 'Replay this unit (Ctrl+R)'));
		this.nextBtn = append(dictHeader, iconButton('chevron-right', 'Next unit (Ctrl+N)'));
		this.autoPauseBtn = append(dictHeader, iconButton('debug-pause', dictationModeToggleTitle(this.autoPause, this.unitKind, this.unitSeconds)));
		this.revealBtn = append(dictHeader, iconButton('eye', 'Reveal the original text (Ctrl+E)'));
		this.unitSelect = append(dictHeader, $<HTMLSelectElement>('select', { title: 'Dictation unit', style: 'background: rgba(0, 122, 204, 0.22); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 5px; padding: 2px 4px; font-size: 10.5px; outline: none;' },
			$('option', { value: 'segment', style: 'background: #1e1e2e; color: #f8fafc;' }, 'Sentence'),
			$('option', { value: 'seconds', style: 'background: #1e1e2e; color: #f8fafc;' }, 'Seconds')
		));
		this.secondsInput = append(dictHeader, $<HTMLInputElement>('input', { type: 'number', min: String(MIN_DICTATION_SECONDS), step: '1', title: 'Seconds per unit (minimum 1)', style: 'width: 46px; background: rgba(0, 0, 0, 0.3); color: #f8fafc; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 5px; padding: 2px 4px; font-size: 10.5px;' }));
		this.unitLabel = append(dictHeader, $('span', { style: 'font-size: 10.5px; font-family: var(--vscode-editor-font-family, monospace); color: #7dd3fc; margin-left: 4px;' }));
		this.scoreLabel = append(dictHeader, $('span', { style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.6); margin-left: auto;' }));
		this.contextLine = append(this.dictationView, $('div', { style: 'font-size: 11.5px; color: rgba(255, 255, 255, 0.5); line-height: 1.4; min-height: 16px;' }));
		this.answerInput = append(this.dictationView, $<HTMLTextAreaElement>('textarea.monaco-inputbox', { rows: '2', spellcheck: 'false', placeholder: 'Type what you hear. Enter: check / continue. Ctrl+R: replay. Ctrl+B / Ctrl+N: previous / next. Ctrl+E: reveal.', style: 'width: 100%; box-sizing: border-box; resize: vertical; padding: 6px 8px; font-size: 13px; line-height: 1.45; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(0, 0, 0, 0.3); color: #f8fafc;' }));
		this.resultBox = append(this.dictationView, $('div', { style: 'display: none; flex-direction: column; gap: 4px; padding: 6px 10px; border-radius: 6px; background: rgba(0, 0, 0, 0.3); font-size: 13px; line-height: 1.6;' }));

		this.wireEvents();
		this.syncControls();
		this.render();
		this.loadStoredSubtitles().catch(err => this.showError(`Could not load saved subtitles: ${(err as Error)?.message || err}`));
	}

	private wireEvents(): void {
		this._register(addDisposableListener(this.extractBtn, 'click', e => { e.stopPropagation(); this.onExtract(); }));
		this._register(addDisposableListener(this.cancelBtn, 'click', e => { e.stopPropagation(); this.running?.cancel(); }));
		this._register(addDisposableListener(this.exportBtn, 'click', e => { e.stopPropagation(); this.onExport(); }));
		for (const mode of ['single', 'scroll', 'dictation'] as const) {
			this._register(addDisposableListener(this.modeBtns[mode], 'click', e => {
				e.stopPropagation();
				this.mode = mode;
				this.lastShownIndex = -2;
				if (mode === 'dictation' && this.units.length > 0) {
					this.selectUnit(findUnitAt(this.units, this.currentTime()));
				}
				this.syncControls();
				this.render();
				this.scheduleSave();
			}));
		}
		this._register(addDisposableListener(this.prevBtn, 'click', e => { e.stopPropagation(); this.goToUnit(this.unitIndex - 1, true); }));
		this._register(addDisposableListener(this.nextBtn, 'click', e => { e.stopPropagation(); this.goToUnit(this.unitIndex + 1, true); }));
		this._register(addDisposableListener(this.replayBtn, 'click', e => { e.stopPropagation(); this.playUnit(); }));
		this._register(addDisposableListener(this.autoPauseBtn, 'click', e => {
			e.stopPropagation();
			this.autoPause = !this.autoPause;
			this.syncControls();
			this.scheduleSave();
		}));
		this._register(addDisposableListener(this.revealBtn, 'click', e => { e.stopPropagation(); this.toggleReveal(); }));
		this._register(addDisposableListener(this.unitSelect, 'change', () => {
			this.unitKind = this.unitSelect.value === 'seconds' ? 'seconds' : 'segment';
			this.onUnitSettingsChanged();
		}));
		this._register(addDisposableListener(this.secondsInput, 'change', () => {
			const n = Math.round(Number(this.secondsInput.value));
			this.unitSeconds = Number.isFinite(n) && n >= MIN_DICTATION_SECONDS ? n : MIN_DICTATION_SECONDS;
			this.onUnitSettingsChanged();
		}));
		for (const el of [this.unitSelect, this.secondsInput, this.answerInput]) {
			this._register(addDisposableListener(el, 'click', e => e.stopPropagation()));
			this._register(addDisposableListener(el, 'mousedown', e => e.stopPropagation()));
		}
		this._register(addDisposableListener(this.answerInput, 'keydown', (e: KeyboardEvent) => this.onAnswerKeyDown(e)));

		for (const media of this.host.mediaElements) {
			this._register(addDisposableListener(media, 'play', () => this.onPlay(media)));
			this._register(addDisposableListener(media, 'pause', () => { this.frame.clear(); this.render(); }));
			this._register(addDisposableListener(media, 'ended', () => { this.frame.clear(); this.render(); }));
			this._register(addDisposableListener(media, 'seeked', () => this.onSeeked(media)));
			this._register(addDisposableListener(media, 'loadedmetadata', () => { this.rebuildUnits(); this.render(); }));
		}
		this._register(toDisposable(() => this.running?.cancel()));
	}

	// --- state -------------------------------------------------------------------------------

	getState(): IMediaSubtitlesState {
		return {
			subtitlesFile: this.subtitlesFile,
			subtitleDisplayMode: this.mode,
			dictationUnit: this.unitKind,
			dictationSeconds: this.unitSeconds,
			dictationAutoPause: this.autoPause,
			dictation: this.answers
		};
	}

	private scheduleSave(): void {
		this.saveScheduler.schedule();
	}

	/** Called by the card when a file was loaded or cleared. */
	onMediaChanged(): void {
		this.updateStatusSummary();
		this.checkDocumentIsCurrent().catch(() => { /* the summary stays */ });
		this.rebuildUnits();
		this.render();
	}

	/** Says so when the stored subtitles belong to another file, or the file changed since (CI-46). */
	private async checkDocumentIsCurrent(): Promise<void> {
		const doc = this.doc;
		const src = this.host.getMediaSource();
		if (!doc || !src) {
			return;
		}
		const uri = resolveMediaUri(src.path, this.host.ticketFolder);
		let sizeBytes: number | undefined;
		if (uri) {
			try {
				sizeBytes = (await this.fileService.stat(uri)).size;
			} catch {
				// size unknown: compare by name / path only
			}
		}
		if (doc !== this.doc || this._store.isDisposed) {
			return;
		}
		const match = matchSubtitleDocument(doc, { name: src.name, path: uri?.fsPath ?? src.path, sizeBytes });
		if (match === 'other-file') {
			this.setStatus(`These subtitles were extracted from "${doc.mediaName}". Extract again for this file.`);
		} else if (match === 'changed') {
			this.setStatus(`"${src.name}" changed since its subtitles were extracted. Extract again.`);
		}
	}

	private async loadStoredSubtitles(): Promise<void> {
		if (!this.subtitlesFile || !this.host.ticketFolder) {
			this.updateStatusSummary();
			return;
		}
		const uri = URI.joinPath(this.host.ticketFolder, this.subtitlesFile);
		if (!(await this.fileService.exists(uri))) {
			this.setStatus('Saved subtitles file is missing. Extract again.');
			return;
		}
		const doc = await readMediaSubtitleDocument(this.fileService, this.host.ticketFolder, this.subtitlesFile);
		if (!doc) {
			this.showError(`${this.subtitlesFile} is not a valid subtitles file.`);
			return;
		}
		this.setDocument(doc);
		this.onMediaChanged();
	}

	// --- used by the component settings dialog (CI-46) ---------------------------------------

	/** The subtitles shown by the card, if any. */
	getDocument(): ISubtitleDocument | undefined {
		return this.doc;
	}

	/** Number of saved dictation answers. */
	answerCount(): number {
		return Object.keys(this.answers).length;
	}

	/** True while the card's own extraction runs. */
	isExtracting(): boolean {
		return !!this.running;
	}

	/** Saves subtitles extracted elsewhere (the settings dialog) for this field and shows them at once. */
	async storeExtracted(doc: ISubtitleDocument): Promise<void> {
		await this.writeDocument(doc);
		this.showError(undefined);
		this.setDocument(doc);
		this.onMediaChanged();
		this.saveScheduler.cancel();
		this.host.saveState(this.getState());
	}

	private setDocument(doc: ISubtitleDocument | undefined): void {
		this.doc = doc;
		this.segments = doc?.segments ?? [];
		this.buildScrollRows();
		this.rebuildUnits();
		this.lastShownIndex = -2;
		this.syncControls();
		this.render();
	}

	private updateStatusSummary(): void {
		if (this.segments.length > 0 && this.doc) {
			this.setStatus(`${this.segments.length} lines \u00B7 ${this.doc.model || this.doc.provider}`);
		} else {
			this.setStatus(this.host.getMediaSource() ? 'No subtitles yet. Click the sparkle to extract.' : 'Load an audio or video file first.');
		}
	}

	private setStatus(text: string): void {
		this.statusText.textContent = text;
		this.statusText.title = text;
	}

	private showError(message: string | undefined): void {
		this.errorBox.textContent = message ?? '';
		show(this.errorBox, !!message, 'block');
	}

	// --- extraction --------------------------------------------------------------------------

	private async onExtract(): Promise<void> {
		if (this.running) {
			return;
		}
		this.showError(undefined);
		const src = this.host.getMediaSource();
		if (!src) {
			this.showError('Load an audio or video file first.');
			return;
		}
		if (this.segments.length > 0 && !(await confirmSubtitleReextract(this.dialogService, this.answerCount()))) {
			return;
		}
		const playerDuration = this.knownMediaDuration();
		if (!(await confirmLargeMediaDecode(this.dialogService, playerDuration, this.config))) {
			return;
		}

		const cts = new CancellationTokenSource();
		this.running = cts;
		this.syncControls();
		this.setProgress(0, 'Reading the media file...');
		try {
			const doc = await extractMediaSubtitleDocument(this.voiceModelService, this.fileService, { ...src, durationSec: playerDuration }, this.config, this.host.ticketFolder, (pct, message) => this.setProgress(pct, message), cts.token);
			await this.writeDocument(doc);
			this.setDocument(doc);
			this.updateStatusSummary();
			this.scheduleSave();
		} catch (err) {
			if (isCancellationError(err) || cts.token.isCancellationRequested) {
				this.setStatus('Extraction cancelled.');
			} else {
				this.showError((err as Error)?.message || String(err));
				this.updateStatusSummary();
			}
		} finally {
			cts.dispose();
			this.running = undefined;
			show(this.progressWrap, false);
			this.syncControls();
		}
	}

	private setProgress(percent: number, message: string): void {
		show(this.progressWrap, true);
		this.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
		this.progressText.textContent = message;
	}

	/** Duration of the loaded media according to the player, if known. */
	private knownMediaDuration(): number | undefined {
		const d = this.host.getActiveMedia().duration;
		return Number.isFinite(d) && d > 0 ? d : undefined;
	}

	private async writeDocument(doc: ISubtitleDocument): Promise<void> {
		if (!this.host.ticketFolder) {
			throw new Error('The ticket folder is not available, so the subtitles cannot be saved.');
		}
		this.subtitlesFile = await writeMediaSubtitleDocument(this.fileService, this.host.ticketFolder, this.host.fieldKey, doc);
	}

	private async onExport(): Promise<void> {
		if (this.segments.length === 0) {
			this.showError('There are no subtitles to export yet.');
			return;
		}
		const base = (this.doc?.mediaName || this.host.fieldKey || 'subtitles').replace(/\.[^.]+$/, '');
		const folder = this.host.ticketFolder ? URI.joinPath(this.host.ticketFolder, 'attachments') : undefined;
		const target = await this.fileDialogService.showSaveDialog({
			title: 'Export Subtitles',
			defaultUri: folder ? URI.joinPath(folder, `${base}.srt`) : undefined,
			filters: [{ name: 'SubRip (SRT)', extensions: ['srt'] }, { name: 'WebVTT', extensions: ['vtt'] }]
		});
		if (!target) {
			return;
		}
		const content = target.path.toLowerCase().endsWith('.vtt') ? toVtt(this.segments) : toSrt(this.segments);
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(content));
			this.setStatus(`Exported to ${target.path.split('/').pop()}`);
		} catch (err) {
			this.showError(`Export failed: ${(err as Error)?.message || err}`);
		}
	}

	// --- playback sync -----------------------------------------------------------------------

	private currentTime(): number {
		const t = this.host.getActiveMedia().currentTime;
		return Number.isFinite(t) ? t : 0;
	}

	private mediaDuration(): number {
		const d = this.host.getActiveMedia().duration;
		return Number.isFinite(d) && d > 0 ? d : (this.doc?.duration ?? 0);
	}

	private onPlay(media: HTMLMediaElement): void {
		if (media !== this.host.getActiveMedia()) {
			return;
		}
		if (this.mode === 'dictation' && this.units.length > 0) {
			const unit = this.units[this.unitIndex];
			const t = media.currentTime;
			if (!unit || t < unit.start - 0.3 || t >= unit.end - 0.05) {
				this.selectUnit(findUnitAt(this.units, t));
			}
		}
		this.startLoop();
	}

	private onSeeked(media: HTMLMediaElement): void {
		if (media !== this.host.getActiveMedia()) {
			return;
		}
		if (this.mode === 'dictation' && media.paused && this.units.length > 0) {
			const idx = findUnitAt(this.units, media.currentTime);
			const unit = this.units[this.unitIndex];
			if (idx !== this.unitIndex && !(unit && Math.abs(media.currentTime - unit.end) < 0.05)) {
				this.selectUnit(idx);
			}
		}
		this.render();
	}

	private startLoop(): void {
		const media = this.host.getActiveMedia();
		const targetWindow = getWindow(this.root);
		const step = () => {
			if (media.paused || media.ended) {
				this.frame.clear();
				return;
			}
			this.onTick(media);
			if (!media.paused) {
				this.frame.value = scheduleAtNextAnimationFrame(targetWindow, step);
			}
		};
		this.frame.value = scheduleAtNextAnimationFrame(targetWindow, step);
	}

	private onTick(media: HTMLMediaElement): void {
		if (this.mode === 'dictation' && this.units.length > 0) {
			const unit = this.units[this.unitIndex];
			if (this.autoPause) {
				if (unit && media.currentTime >= unit.end - 0.03) {
					media.pause();
					this.answerInput.focus();
				}
			} else {
				const idx = findUnitAt(this.units, media.currentTime);
				if (idx !== this.unitIndex) {
					this.selectUnit(idx);
				}
			}
			return;
		}
		this.render();
	}

	// --- rendering ---------------------------------------------------------------------------

	private syncControls(): void {
		const busy = !!this.running;
		const hasSubs = this.segments.length > 0;
		this.extractBtn.disabled = busy;
		this.extractBtn.style.opacity = busy ? '0.5' : '1';
		show(this.cancelBtn, busy, 'inline-flex');
		this.exportBtn.disabled = !hasSubs;
		this.exportBtn.style.opacity = hasSubs ? '1' : '0.4';
		for (const mode of ['single', 'scroll', 'dictation'] as const) {
			setActive(this.modeBtns[mode], this.mode === mode);
		}
		setActive(this.autoPauseBtn, this.autoPause);
		this.autoPauseBtn.title = dictationModeToggleTitle(this.autoPause, this.unitKind, this.unitSeconds);
		this.autoPauseBtn.setAttribute('aria-label', this.autoPauseBtn.title);
		setActive(this.revealBtn, this.revealed);
		this.unitSelect.value = this.unitKind;
		this.secondsInput.value = String(this.unitSeconds);
		show(this.secondsInput, this.unitKind === 'seconds', 'inline-block');
		show(this.singleView, hasSubs && this.mode === 'single');
		show(this.scrollView, hasSubs && this.mode === 'scroll');
		show(this.dictationView, hasSubs && this.mode === 'dictation');
	}

	private render(): void {
		if (this.segments.length === 0) {
			return;
		}
		const t = this.currentTime();
		if (this.mode === 'single') {
			let idx = findSegmentAt(this.segments, t);
			if (idx < 0) {
				const last = findLastStartedSegment(this.segments, t);
				// Keep the previous line during short pauses.
				idx = last >= 0 && t - this.segments[last].end < 0.8 ? last : -1;
			}
			if (idx !== this.lastShownIndex) {
				this.lastShownIndex = idx;
				this.singleText.textContent = idx >= 0 ? this.segments[idx].text : '\u2026';
				this.singleText.style.opacity = idx >= 0 ? '1' : '0.35';
			}
		} else if (this.mode === 'scroll') {
			const idx = findLastStartedSegment(this.segments, t);
			if (idx !== this.lastShownIndex) {
				const prev = this.scrollRows[this.lastShownIndex];
				if (prev) {
					this.styleRow(prev, false);
				}
				this.lastShownIndex = idx;
				const row = this.scrollRows[idx];
				if (row) {
					this.styleRow(row, true);
					this.scrollView.scrollTop = Math.max(0, row.offsetTop - this.scrollView.clientHeight / 2 + row.offsetHeight / 2);
				}
			}
		} else {
			this.renderDictation();
		}
	}

	private styleRow(row: HTMLElement, current: boolean): void {
		row.style.background = current ? 'rgba(0, 122, 204, 0.35)' : 'transparent';
		row.style.color = current ? '#ffffff' : 'rgba(226, 232, 240, 0.7)';
		row.style.borderLeftColor = current ? ACCENT : 'transparent';
	}

	private buildScrollRows(): void {
		clearNode(this.scrollView);
		this.rowListeners.clear();
		this.scrollRows = this.segments.map(seg => {
			const row = append(this.scrollView, $('div.media-subs-row', { title: 'Click to play from here', style: 'display: flex; gap: 8px; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12.5px; line-height: 1.45; border-left: 2px solid transparent;' },
				$('span', { style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: #7dd3fc; opacity: 0.8; flex-shrink: 0; padding-top: 2px;' }, formatClock(seg.start)),
				$('span', undefined, seg.text)
			));
			this.styleRow(row, false);
			this.rowListeners.add(addDisposableListener(row, 'click', e => {
				e.stopPropagation();
				const media = this.host.getActiveMedia();
				media.currentTime = seg.start;
				this.lastShownIndex = -2;
				this.render();
			}));
			return row;
		});
	}

	// --- dictation ---------------------------------------------------------------------------

	private onUnitSettingsChanged(): void {
		const t = this.units[this.unitIndex]?.start ?? this.currentTime();
		this.rebuildUnits();
		this.selectUnit(findUnitAt(this.units, t));
		this.syncControls();
		this.scheduleSave();
	}

	private rebuildUnits(): void {
		this.units = buildDictationUnits(this.segments, this.unitKind, this.unitSeconds, this.mediaDuration());
		this.unitIndex = Math.max(0, Math.min(this.unitIndex, this.units.length - 1));
		this.loadAnswerIntoInput();
	}

	private selectUnit(index: number): void {
		if (this.units.length === 0) {
			return;
		}
		const next = Math.max(0, Math.min(index, this.units.length - 1));
		const pending = this.answerInput.value.trim();
		if (next !== this.unitIndex && pending && pending !== this.checkedText) {
			// Do not lose typed text when playback moves on: check it for the unit it was typed for.
			this.submitAnswer(pending);
		}
		this.unitIndex = next;
		this.revealed = false;
		setActive(this.revealBtn, false);
		this.loadAnswerIntoInput();
		this.renderDictation();
	}

	private goToUnit(index: number, play: boolean): void {
		if (this.units.length === 0) {
			return;
		}
		this.selectUnit(index);
		if (play) {
			this.playUnit();
		}
	}

	private playUnit(): void {
		const unit = this.units[this.unitIndex];
		if (!unit) {
			return;
		}
		const media = this.host.getActiveMedia();
		if (!media.src) {
			return;
		}
		media.currentTime = unit.start;
		media.play().catch(err => this.showError(`Playback error: ${(err as Error)?.message || err}`));
		this.answerInput.focus();
	}

	private loadAnswerIntoInput(): void {
		const unit = this.units[this.unitIndex];
		const saved = unit ? this.answers[unit.key] : undefined;
		this.answerInput.value = saved?.text ?? '';
		this.checkedText = saved ? saved.text : undefined;
	}

	private toggleReveal(): void {
		this.revealed = !this.revealed;
		setActive(this.revealBtn, this.revealed);
		this.renderDictation();
	}

	private onAnswerKeyDown(e: KeyboardEvent): void {
		e.stopPropagation();
		const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			const text = this.answerInput.value.trim();
			if (text && text !== this.checkedText) {
				this.submitAnswer(text);
			} else {
				this.goToUnit(this.unitIndex + 1, true);
			}
		} else if (ctrl && e.code === 'KeyR') {
			e.preventDefault();
			this.playUnit();
		} else if (ctrl && e.code === 'KeyB') {
			e.preventDefault();
			this.goToUnit(this.unitIndex - 1, true);
		} else if (ctrl && e.code === 'KeyN') {
			e.preventDefault();
			this.goToUnit(this.unitIndex + 1, true);
		} else if (ctrl && e.code === 'KeyE') {
			e.preventDefault();
			this.toggleReveal();
		}
	}

	private submitAnswer(text: string): void {
		const unit = this.units[this.unitIndex];
		if (!unit) {
			return;
		}
		const diff = diffWords(unit.reference, text);
		this.answers = { ...this.answers, [unit.key]: { text, correct: diff.correct, total: diff.total, score: Math.round(diff.score * 1000) / 1000, at: Date.now() } };
		this.checkedText = text;
		this.renderDictation();
		this.scheduleSave();
	}

	private renderDictation(): void {
		if (this.mode !== 'dictation') {
			return;
		}
		const unit = this.units[this.unitIndex];
		const answered = this.units.filter(u => !!this.answers[u.key]);
		const avg = answered.length > 0 ? answered.reduce((n, u) => n + this.answers[u.key].score, 0) / answered.length : 0;
		this.scoreLabel.textContent = answered.length > 0 ? `${answered.length} / ${this.units.length} answered \u00B7 avg ${Math.round(avg * 100)}%` : `${this.units.length} units`;
		if (!unit) {
			this.unitLabel.textContent = '';
			show(this.resultBox, false);
			return;
		}
		this.unitLabel.textContent = `${this.unitIndex + 1} / ${this.units.length} \u00B7 ${formatClock(unit.start)} - ${formatClock(unit.end)}`;
		const prevUnit = this.units[this.unitIndex - 1];
		this.contextLine.textContent = prevUnit?.reference ? `\u2026 ${prevUnit.reference}` : '';

		const saved = this.answers[unit.key];
		clearNode(this.resultBox);
		const isChecked = !!saved && this.checkedText === saved.text;
		if (isChecked || this.revealed) {
			show(this.resultBox, true);
			if (isChecked && saved) {
				const diff = diffWords(unit.reference, saved.text);
				const line = append(this.resultBox, $('div', { style: 'display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline;' }));
				append(line, $('span', { style: `font-size: 10.5px; font-weight: 700; color: ${diff.score >= 0.999 ? DIFF_COLORS.correct : diff.score >= 0.6 ? DIFF_COLORS.missing : DIFF_COLORS.wrong}; margin-right: 4px;` }, `${Math.round(diff.score * 100)}%`));
				for (const op of diff.ops) {
					append(line, this.renderDiffOp(op));
				}
				if (diff.total === 0) {
					append(line, $('span', { style: 'font-size: 11px; color: rgba(255, 255, 255, 0.5);' }, '(no speech in this unit)'));
				}
				append(this.resultBox, $('div', { style: 'font-size: 10px; color: rgba(255, 255, 255, 0.45);' }, 'Green: correct \u00B7 red: wrong (expected in brackets) \u00B7 amber: missing \u00B7 grey: extra. Enter: next unit.'));
			}
			if (this.revealed) {
				append(this.resultBox, $('div', { style: 'font-size: 12.5px; color: #e2e8f0; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 4px;' }, unit.reference || '(no speech in this unit)'));
			}
		} else {
			show(this.resultBox, false);
		}
	}

	private renderDiffOp(op: IWordDiffOp): HTMLElement {
		const color = DIFF_COLORS[op.kind];
		switch (op.kind) {
			case 'correct':
				return $('span', { style: `color: ${color};` }, op.actual ?? '');
			case 'wrong':
				return $('span', { style: `color: ${color}; text-decoration: line-through;`, title: `Expected: ${op.expected}` }, op.actual ?? '', $('span', { style: `color: ${DIFF_COLORS.correct}; text-decoration: none; font-size: 11.5px; margin-left: 2px;` }, `[${op.expected}]`));
			case 'missing':
				return $('span', { style: `color: ${color}; border-bottom: 1px dashed ${color};`, title: 'Missing word' }, op.expected ?? '');
			case 'extra':
			default:
				return $('span', { style: `color: ${color}; text-decoration: line-through;`, title: 'Extra word' }, op.actual ?? '');
		}
	}

	override dispose(): void {
		if (this.saveScheduler.isScheduled()) {
			this.saveScheduler.cancel();
			this.host.saveState(this.getState());
		}
		this.root.remove();
		super.dispose();
	}
}
