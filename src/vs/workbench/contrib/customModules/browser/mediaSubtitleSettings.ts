/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, isHTMLElement } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { IVoiceModelService, SUBTITLE_MODEL_CATALOG, VOICE_PROVIDER_CATALOG } from '../../voiceModels/common/voiceModel.js';
import { checkMediaLimits, DEFAULT_MEDIA_MAX_UPLOAD_MB, describeMediaFacts, DICTATION_MODE_LABEL, dictationModeCheckboxText, dictationModeDescription, formatMediaDuration, IMediaFileFacts, resolveMediaSubtitlesConfig, SUBTITLE_DISPLAY_MODES } from '../../voiceModels/common/subtitleConfig.js';
import { MIN_DICTATION_SECONDS } from '../../voiceModels/common/dictation.js';
import { formatClock, ISubtitleDocument, matchSubtitleDocument, toTimedText } from '../../voiceModels/common/subtitles.js';
import { confirmLargeMediaDecode, confirmSubtitleReextract, extractMediaSubtitleDocument, IMediaSubtitleSource, IMediaSubtitleStore, resolveMediaUri } from '../../voiceModels/browser/mediaSubtitleJob.js';

const LABEL_STYLE = 'font-size: 11px; color: rgba(255, 255, 255, 0.7); min-width: 150px;';
const INPUT_STYLE = 'background: rgba(0, 0, 0, 0.3); color: #f8fafc; border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 4px; padding: 3px 6px; font-size: 11px; outline: none;';
const OPTION_STYLE = 'background: #1e1e2e; color: #f8fafc;';
const OTHER_MODEL = '__other__';
const INFO_STYLE = 'font-size: 10.5px; color: rgba(255, 255, 255, 0.55);';
const WARNING_STYLE = 'display: none; font-size: 10.5px; color: #fbbf24; font-weight: 600; padding-left: 158px; line-height: 1.4;';

/** What the Extract button of the settings block needs (CI-46). */
export interface IMediaSubtitleSettingsExtraction {
	readonly fileService: IFileService;
	readonly dialogService: IDialogService;
	/** Where extracted subtitles are saved (the ticket of the card); undefined in the template designer. */
	readonly store?: IMediaSubtitleStore;
	/** Folder that relative media paths are resolved against (the ticket folder). */
	readonly baseFolder?: URI;
	/** The file loaded in the settings player (undefined = none). */
	getMediaSource(): IMediaSubtitleSource | undefined;
}

/** Shown on the disabled Extract button when the settings are not opened from a ticket. */
export const EXTRACT_NEEDS_TICKET_HINT = 'Subtitles are saved per ticket. Open this component\'s settings from a ticket (gear on the card) to extract.';

/** The settings block; the host tells it which media file is loaded so the limits can be compared with it. */
export interface IMediaSubtitleSettingsWidget extends IDisposable {
	/** Size / duration of the file currently loaded in the player (undefined = no file). */
	setCurrentMedia(facts: IMediaFileFacts | undefined): void;
}

function row(parent: HTMLElement, label: string, title?: string): HTMLElement {
	const r = append(parent, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
	append(r, $('span', { style: LABEL_STYLE, title: title ?? '' }, label));
	return r;
}

function option(value: string, label: string, title?: string): HTMLOptionElement {
	return $<HTMLOptionElement>('option', { value, style: OPTION_STYLE, title: title ?? '' }, label);
}

/**
 * Subtitles + dictation settings of an MP3 / MP4 Player field (CI-45), shown in the template designer and in the
 * Freestyle component settings dialog. Writes the `media*` subtitle props onto `field` and calls `onChange`.
 */
export function renderMediaSubtitleSettings(container: HTMLElement, field: ICustomField, voiceModelService: IVoiceModelService | undefined, onChange: () => void, initialMedia?: IMediaFileFacts, extraction?: IMediaSubtitleSettingsExtraction): IMediaSubtitleSettingsWidget {
	const store = new DisposableStore();
	const box = append(container, $('div.media-subtitle-settings', { style: 'display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(251, 191, 36, 0.2);' }));

	const header = append(box, $('label', { style: 'display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 11.5px; font-weight: 600; color: #fbbf24;' }));
	const enabledBox = append(header, $<HTMLInputElement>('input', { type: 'checkbox' }));
	enabledBox.checked = !!field.mediaSubtitlesEnabled;
	append(header, $('span.codicon.codicon-symbol-text', { style: 'font-size: 13px;' }));
	append(header, $('span', undefined, 'Subtitles & dictation'));
	append(box, $('div', { style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.5); line-height: 1.4;' }, 'Extract timed subtitles from the audio / video with a voice model, then follow them line by line, in a scrolling list, or practise dictation. Off by default.'));

	const details = append(box, $('div', { style: 'display: flex; flex-direction: column; gap: 6px;' }));
	const cfg = resolveMediaSubtitlesConfig(field);

	// Provider + model
	const providerSelect = append(row(details, 'Provider', 'Voice provider used to transcribe. Keys come from AI LLM Providers / Voice & Audio Models.'), $<HTMLSelectElement>('select', { style: INPUT_STYLE }));
	providerSelect.appendChild(option('', 'Active voice model (Settings)'));
	for (const p of VOICE_PROVIDER_CATALOG) {
		providerSelect.appendChild(option(p.id, p.label));
	}
	providerSelect.value = cfg.provider;

	const modelRow = row(details, 'Model');
	const modelSelect = append(modelRow, $<HTMLSelectElement>('select', { style: INPUT_STYLE }));
	const modelInput = append(modelRow, $<HTMLInputElement>('input', { type: 'text', placeholder: 'model id', style: `${INPUT_STYLE} width: 180px;` }));
	const modelHint = append(details, $('div', { style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.5); padding-left: 158px; line-height: 1.4;' }));
	let registered: { provider: string; modelId: string; name: string }[] = [];

	const fillModels = () => {
		const provider = providerSelect.value;
		clearNode(modelSelect);
		modelRow.style.display = provider ? 'flex' : 'none';
		if (!provider) {
			modelHint.textContent = 'Uses the voice model marked active in Settings > Voice & Audio Models.';
			return;
		}
		const catalog = SUBTITLE_MODEL_CATALOG[provider] ?? [];
		const ids = new Set<string>();
		for (const m of catalog) {
			modelSelect.appendChild(option(m.id, `${m.label}${m.recommended ? ' (recommended)' : ''}`, m.description));
			ids.add(m.id);
		}
		for (const m of registered) {
			if (m.provider === provider && m.modelId && !ids.has(m.modelId)) {
				modelSelect.appendChild(option(m.modelId, `${m.modelId} (registered)`, m.name));
				ids.add(m.modelId);
			}
		}
		modelSelect.appendChild(option(OTHER_MODEL, 'Other model id...'));
		const current = (field.mediaSubtitleModel || '').trim();
		if (current && ids.has(current)) {
			modelSelect.value = current;
		} else if (current) {
			modelSelect.value = OTHER_MODEL;
		} else {
			modelSelect.value = catalog.find(m => m.recommended)?.id ?? catalog[0]?.id ?? OTHER_MODEL;
		}
		modelInput.value = current;
		modelInput.style.display = modelSelect.value === OTHER_MODEL ? 'inline-block' : 'none';
		const info = catalog.find(m => m.id === (modelSelect.value === OTHER_MODEL ? current : modelSelect.value));
		modelHint.textContent = info
			? `${info.description} Timing: ${info.timing}.`
			: provider === 'custom'
				? 'Any OpenAI-compatible /audio/transcriptions endpoint (URL from the custom voice model); verbose_json segments are used when returned.'
				: 'Custom model id. Timestamp method is chosen from the provider (see the help guide).';
	};

	const commitModel = () => {
		field.mediaSubtitleProvider = providerSelect.value;
		field.mediaSubtitleModel = !providerSelect.value ? '' : modelSelect.value === OTHER_MODEL ? modelInput.value.trim() : modelSelect.value;
		onChange();
	};

	store.add(addDisposableListener(providerSelect, 'change', () => {
		field.mediaSubtitleModel = '';
		fillModels();
		commitModel();
	}));
	store.add(addDisposableListener(modelSelect, 'change', () => {
		if (modelSelect.value !== OTHER_MODEL) {
			field.mediaSubtitleModel = modelSelect.value;
		}
		fillModels();
		if (modelSelect.value === OTHER_MODEL) {
			modelInput.focus();
		}
		commitModel();
	}));
	store.add(addDisposableListener(modelInput, 'change', () => commitModel()));

	// Language
	const languageInput = append(row(details, 'Language hint', 'ISO code such as en, fr, zh. Leave empty to detect automatically.'), $<HTMLInputElement>('input', { type: 'text', placeholder: 'auto (e.g. en, fr)', style: `${INPUT_STYLE} width: 120px;` }));
	languageInput.value = cfg.language;
	store.add(addDisposableListener(languageInput, 'change', () => { field.mediaSubtitleLanguage = languageInput.value.trim(); onChange(); }));

	// Limits, compared with the file loaded in the player
	let currentMedia = initialMedia;
	const sizeRow = row(details, 'Max file size (MB)', 'Larger files are refused before they are read and decoded.');
	const sizeInput = append(sizeRow, $<HTMLInputElement>('input', { type: 'number', min: '1', step: '1', style: `${INPUT_STYLE} width: 80px;` }));
	sizeInput.value = String(cfg.maxUploadMb);
	const sizeInfo = append(sizeRow, $('span', { style: INFO_STYLE }));
	const durationRow = row(details, 'Max duration (min)', 'Longer audio is refused before it is sent to the model. 0 = no limit.');
	const durationInput = append(durationRow, $<HTMLInputElement>('input', { type: 'number', min: '0', step: '1', placeholder: '0 = no limit', style: `${INPUT_STYLE} width: 80px;` }));
	durationInput.value = String(cfg.maxDurationMin);
	const durationInfo = append(durationRow, $('span', { style: INFO_STYLE }));
	const limitWarning = append(details, $('div.media-subtitle-limit-warning', { style: WARNING_STYLE, role: 'status' }));

	const syncLimitInfo = () => {
		const limits = resolveMediaSubtitlesConfig(field);
		const facts = describeMediaFacts(currentMedia);
		sizeInfo.textContent = facts ? `Current file: ${facts}` : 'No file loaded';
		const check = checkMediaLimits(limits, currentMedia);
		const currentDuration = currentMedia?.durationSec;
		durationInfo.textContent = typeof currentDuration === 'number' && currentDuration > 0
			? `0 = no limit \u00B7 current file: ${formatMediaDuration(currentDuration)}`
			: '0 = no limit';
		durationInfo.style.color = check.durationExceeded ? '#fbbf24' : 'rgba(255, 255, 255, 0.55)';
		const warnings: string[] = [];
		if (check.sizeExceeded) {
			warnings.push(`Current file exceeds the ${limits.maxUploadMb} MB size limit - extraction will be refused.`);
		}
		if (check.durationExceeded) {
			warnings.push(`Current file is longer than ${limits.maxDurationMin} min - extraction will be refused.`);
		}
		limitWarning.textContent = warnings.join(' ');
		limitWarning.style.display = warnings.length ? 'block' : 'none';
		sizeInfo.style.color = check.sizeExceeded ? '#fbbf24' : 'rgba(255, 255, 255, 0.55)';
	};
	syncLimitInfo();

	store.add(addDisposableListener(sizeInput, 'change', () => {
		const n = Math.round(Number(sizeInput.value));
		field.mediaMaxUploadMb = Number.isFinite(n) && n > 0 ? n : DEFAULT_MEDIA_MAX_UPLOAD_MB;
		sizeInput.value = String(field.mediaMaxUploadMb);
		syncLimitInfo();
		onChange();
	}));
	store.add(addDisposableListener(durationInput, 'change', () => {
		const n = Math.round(Number(durationInput.value));
		field.mediaMaxDurationMin = Number.isFinite(n) && n > 0 ? n : 0;
		durationInput.value = String(field.mediaMaxDurationMin);
		syncLimitInfo();
		onChange();
	}));

	// Display + dictation defaults
	const modeSelect = append(row(details, 'Default display', 'What the card shows when the ticket opens; the buttons on the card switch between them.'), $<HTMLSelectElement>('select', { style: INPUT_STYLE }));
	for (const m of SUBTITLE_DISPLAY_MODES) {
		modeSelect.appendChild(option(m.id, m.label));
	}
	modeSelect.value = cfg.displayMode;
	store.add(addDisposableListener(modeSelect, 'change', () => {
		field.mediaSubtitleDisplayMode = modeSelect.value === 'scroll' ? 'scroll' : modeSelect.value === 'dictation' ? 'dictation' : 'single';
		onChange();
	}));

	const unitRow = row(details, 'Dictation unit', 'What you type at a time in Dictation practice. Sentence = one subtitle line; Fixed seconds = fixed windows (minimum 1 s).');
	const unitSelect = append(unitRow, $<HTMLSelectElement>('select', { style: INPUT_STYLE }, option('segment', 'Sentence'), option('seconds', 'Fixed seconds')));
	unitSelect.value = cfg.dictationUnit;
	const secondsInput = append(unitRow, $<HTMLInputElement>('input', { type: 'number', min: String(MIN_DICTATION_SECONDS), step: '1', title: 'Seconds per unit', style: `${INPUT_STYLE} width: 60px;` }));
	secondsInput.value = String(cfg.dictationSeconds);
	const syncSeconds = () => { secondsInput.style.display = unitSelect.value === 'seconds' ? 'inline-block' : 'none'; };
	syncSeconds();
	store.add(addDisposableListener(unitSelect, 'change', () => {
		field.mediaDictationUnit = unitSelect.value === 'seconds' ? 'seconds' : 'segment';
		syncSeconds();
		syncDictationModeText();
		onChange();
	}));
	store.add(addDisposableListener(secondsInput, 'change', () => {
		const n = Math.round(Number(secondsInput.value));
		field.mediaDictationSeconds = Number.isFinite(n) && n >= MIN_DICTATION_SECONDS ? n : MIN_DICTATION_SECONDS;
		secondsInput.value = String(field.mediaDictationSeconds);
		syncDictationModeText();
		onChange();
	}));

	// "Dictation mode" (stored as mediaDictationAutoPause): stop after each unit so the user can type it
	const dictationModeRow = row(details, DICTATION_MODE_LABEL);
	const autoLabel = append(dictationModeRow, $('label', { style: 'display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: rgba(255, 255, 255, 0.75); cursor: pointer;' }));
	const autoBox = append(autoLabel, $<HTMLInputElement>('input', { type: 'checkbox' }));
	autoBox.checked = cfg.autoPause;
	const autoText = append(autoLabel, $('span'));
	const syncDictationModeText = (): void => {
		const now = resolveMediaSubtitlesConfig(field);
		autoText.textContent = dictationModeCheckboxText(now.dictationUnit, now.dictationSeconds);
		const tip = dictationModeDescription(now.dictationUnit, now.dictationSeconds);
		autoLabel.title = tip;
		const rowLabel = dictationModeRow.firstElementChild;
		if (isHTMLElement(rowLabel)) {
			rowLabel.title = tip;
		}
	};
	syncDictationModeText();
	store.add(addDisposableListener(autoBox, 'change', () => { field.mediaDictationAutoPause = autoBox.checked; onChange(); }));

	const extractUi = renderExtractSection(details, field, voiceModelService, extraction, () => currentMedia, store);
	// A changed provider / model / limit changes the button's tooltip and the file check
	store.add(addDisposableListener(details, 'change', () => extractUi.refresh()));

	const syncEnabled = () => { details.style.display = enabledBox.checked ? 'flex' : 'none'; };
	syncEnabled();
	store.add(addDisposableListener(enabledBox, 'change', () => {
		field.mediaSubtitlesEnabled = enabledBox.checked;
		syncEnabled();
		onChange();
	}));

	for (const el of [providerSelect, modelSelect, modelInput, languageInput, sizeInput, durationInput, modeSelect, unitSelect, secondsInput, enabledBox, autoBox]) {
		store.add(addDisposableListener(el, 'click', e => e.stopPropagation()));
		store.add(addDisposableListener(el, 'keydown', e => e.stopPropagation()));
	}

	fillModels();
	voiceModelService?.getVoiceModels().then(models => {
		if (store.isDisposed) {
			return;
		}
		registered = models.map(m => ({ provider: m.provider, modelId: m.modelId, name: m.name }));
		fillModels();
	}, () => { /* the catalog alone is fine */ });

	return {
		setCurrentMedia: facts => {
			currentMedia = facts;
			if (!store.isDisposed) {
				syncLimitInfo();
				extractUi.refresh();
			}
		},
		dispose: () => store.dispose()
	};
}

// --- Extract subtitles from the settings dialog (CI-46) ----------------------------------------------

const EXTRACT_BTN_STYLE = 'display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; background: rgba(251, 191, 36, 0.16); border: 1px solid rgba(251, 191, 36, 0.45); color: #fcd34d;';
const CANCEL_BTN_STYLE = 'display: none; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; background: transparent; border: 1px solid rgba(255, 255, 255, 0.25); color: rgba(255, 255, 255, 0.8);';

function formatDocDate(createdAt: number): string {
	if (!createdAt) {
		return '';
	}
	const d = new Date(createdAt);
	const pad = (n: number) => n < 10 ? `0${n}` : String(n);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeDoc(doc: ISubtitleDocument): string {
	const date = formatDocDate(doc.createdAt);
	return `${doc.segments.length} lines (${doc.model || doc.provider || 'unknown model'}${date ? `, ${date}` : ''})`;
}

/**
 * Extract button, status, progress and preview under the subtitle settings. Uses the settings currently in the dialog
 * (saved or not) and stores the result in the ticket at once, like the card's sparkle button does.
 */
function renderExtractSection(details: HTMLElement, field: ICustomField, voiceModelService: IVoiceModelService | undefined, extraction: IMediaSubtitleSettingsExtraction | undefined, getFacts: () => IMediaFileFacts | undefined, store: DisposableStore): { refresh(): void } {
	const section = append(details, $('div.media-subtitle-extract', { style: 'display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(251, 191, 36, 0.18);' }));
	const bar = append(section, $('div', { style: 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;' }));
	const extractBtn = append(bar, $<HTMLButtonElement>('button.media-subtitle-extract-btn', { type: 'button', style: EXTRACT_BTN_STYLE }));
	append(extractBtn, $('span.codicon.codicon-sparkle', { style: 'font-size: 12px;' }));
	const extractLabel = append(extractBtn, $('span', undefined, 'Extract subtitles'));
	const cancelBtn = append(bar, $<HTMLButtonElement>('button', { type: 'button', title: 'Cancel extraction', style: CANCEL_BTN_STYLE }));
	append(cancelBtn, $('span.codicon.codicon-debug-stop', { style: 'font-size: 12px;' }));
	append(cancelBtn, $('span', undefined, 'Cancel'));
	const status = append(bar, $('span.media-subtitle-extract-status', { style: 'font-size: 10.5px; color: rgba(255, 255, 255, 0.65); flex: 1; min-width: 160px; line-height: 1.4;', role: 'status' }));

	const progressWrap = append(section, $('div', { style: 'display: none; flex-direction: column; gap: 4px;' }));
	const track = append(progressWrap, $('div', { style: 'height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden;' }));
	const progressFill = append(track, $('div', { style: 'height: 100%; width: 0%; background: linear-gradient(90deg, #d97706, #fbbf24); transition: width 0.2s ease;' }));
	const progressText = append(progressWrap, $('span', { style: 'font-size: 10.5px; color: #fcd34d;' }));
	const errorBox = append(section, $('div', { style: 'display: none; padding: 6px 10px; border-radius: 6px; background: rgba(239, 68, 68, 0.14); border: 1px solid rgba(239, 68, 68, 0.45); color: #fca5a5; font-size: 11px; line-height: 1.4; white-space: pre-wrap;' }));
	// Full transcript: every line, scrollable, with a copy icon on top.
	const previewWrap = append(section, $('div.media-subtitle-extract-preview-wrap', { style: 'display: none; flex-direction: column; border-radius: 4px; background: rgba(0, 0, 0, 0.25);' }));
	const previewHead = append(previewWrap, $('div', { style: 'display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);' }));
	const previewCount = append(previewHead, $('span', { style: 'flex: 1; font-size: 10px; color: rgba(255, 255, 255, 0.5);' }));
	const copyBtn = append(previewHead, $<HTMLButtonElement>('button.media-subtitle-copy-btn', { type: 'button', title: 'Copy all subtitles (with timestamps)', 'aria-label': 'Copy all subtitles', style: 'display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; padding: 0; border-radius: 4px; cursor: pointer; background: transparent; border: 1px solid rgba(251, 191, 36, 0.35); color: #fcd34d;' }));
	const copyIcon = append(copyBtn, $('span.codicon.codicon-copy', { style: 'font-size: 13px;' }));
	const preview = append(previewWrap, $('div.media-subtitle-extract-preview', { style: 'display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; max-height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.45; color: rgba(255, 255, 255, 0.8); user-select: text;' }));
	let previewDoc: ISubtitleDocument | undefined;
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
	store.add(toDisposable(() => { if (copyResetTimer) { clearTimeout(copyResetTimer); } }));
	store.add(addDisposableListener(copyBtn, 'click', async e => {
		e.preventDefault();
		e.stopPropagation();
		if (!previewDoc || !previewDoc.segments.length) {
			return;
		}
		let ok = true;
		try {
			await navigator.clipboard.writeText(toTimedText(previewDoc.segments));
		} catch {
			ok = false;
		}
		copyIcon.className = ok ? 'codicon codicon-check' : 'codicon codicon-error';
		copyBtn.title = ok ? `Copied ${previewDoc.segments.length} lines` : 'Copy failed';
		if (copyResetTimer) {
			clearTimeout(copyResetTimer);
		}
		copyResetTimer = setTimeout(() => {
			copyIcon.className = 'codicon codicon-copy';
			copyBtn.title = 'Copy all subtitles (with timestamps)';
		}, 1500);
	}));

	let running: CancellationTokenSource | undefined;
	let storedDoc: ISubtitleDocument | undefined;
	let storedLoaded = false;
	let lastResult: string | undefined;
	let refreshSeq = 0;
	store.add(toDisposable(() => running?.cancel()));

	const showError = (message: string | undefined) => {
		errorBox.textContent = message ?? '';
		errorBox.style.display = message ? 'block' : 'none';
	};
	const setProgress = (percent: number, message: string) => {
		progressWrap.style.display = 'flex';
		progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
		progressText.textContent = message;
	};
	const showPreview = (doc: ISubtitleDocument | undefined) => {
		clearNode(preview);
		previewDoc = doc && doc.segments.length ? doc : undefined;
		previewWrap.style.display = previewDoc ? 'flex' : 'none';
		if (!previewDoc) {
			return;
		}
		previewCount.textContent = `${previewDoc.segments.length} lines - scroll to read all`;
		for (const seg of previewDoc.segments) {
			append(preview, $('div', { style: 'display: flex; gap: 8px;' },
				$('span', { style: 'font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: #fcd34d; opacity: 0.85; flex-shrink: 0; padding-top: 1px;' }, formatClock(seg.start)),
				$('span', undefined, seg.text)
			));
		}
		preview.scrollTop = 0;
	};
	const setEnabled = (enabled: boolean, title: string) => {
		extractBtn.disabled = !enabled;
		extractBtn.style.opacity = enabled ? '1' : '0.45';
		extractBtn.style.cursor = enabled ? 'pointer' : 'default';
		extractBtn.title = title;
	};

	/** Current file vs stored subtitles: updates the button, the status line and the preview. */
	const refresh = async () => {
		const seq = ++refreshSeq;
		if (running) {
			return;
		}
		if (!extraction?.store) {
			extractLabel.textContent = 'Extract subtitles';
			setEnabled(false, EXTRACT_NEEDS_TICKET_HINT);
			status.textContent = 'Open from a ticket to extract: subtitles are saved per ticket.';
			status.title = EXTRACT_NEEDS_TICKET_HINT;
			showPreview(undefined);
			return;
		}
		if (!storedLoaded) {
			try {
				storedDoc = await extraction.store.load();
			} catch {
				storedDoc = undefined;
			}
			storedLoaded = true;
			if (seq !== refreshSeq || store.isDisposed) {
				return;
			}
		}
		const src = extraction.getMediaSource();
		const facts = getFacts();
		if (!src) {
			extractLabel.textContent = 'Extract subtitles';
			setEnabled(false, 'Load an audio or video file in the player above first.');
			status.textContent = 'No media file: load an audio or video file in the player above first.';
			status.title = '';
			showPreview(undefined);
			return;
		}
		const path = resolveMediaUri(src.path, extraction.baseFolder)?.fsPath ?? src.path;
		const match = storedDoc ? matchSubtitleDocument(storedDoc, { name: src.name, path, sizeBytes: facts?.sizeBytes }) : undefined;
		const model = resolveMediaSubtitlesConfig(field);
		const modelLabel = model.provider ? `${model.provider} / ${model.model || 'default model'}` : 'the active voice model';
		if (storedDoc && match === 'current') {
			extractLabel.textContent = 'Re-extract';
			setEnabled(!extraction.store.isBusy(), extraction.store.isBusy() ? 'The card is extracting subtitles right now.' : `Extract "${src.name}" again with ${modelLabel} (replaces the current subtitles; dictation answers are kept)`);
			status.textContent = lastResult ?? `Subtitles ready: ${describeDoc(storedDoc)}`;
			showPreview(storedDoc);
		} else {
			extractLabel.textContent = 'Extract subtitles';
			setEnabled(!extraction.store.isBusy(), extraction.store.isBusy() ? 'The card is extracting subtitles right now.' : `Extract subtitles from "${src.name}" with ${modelLabel}`);
			status.textContent = !storedDoc
				? `No subtitles for "${src.name}" yet.`
				: match === 'changed'
					? `"${src.name}" changed since its subtitles were extracted (${describeDoc(storedDoc)}). Extract again.`
					: `The saved subtitles are for "${storedDoc.mediaName}" (${describeDoc(storedDoc)}). Extract for this file.`;
			showPreview(undefined);
		}
		status.title = status.textContent;
	};

	const onExtract = async () => {
		const target = extraction?.store;
		const src = extraction?.getMediaSource();
		if (running || !extraction || !target || !src || !voiceModelService) {
			if (!voiceModelService) {
				showError('The voice model service is not available.');
			}
			return;
		}
		showError(undefined);
		const facts = getFacts();
		const path = resolveMediaUri(src.path, extraction.baseFolder)?.fsPath ?? src.path;
		if (storedDoc && matchSubtitleDocument(storedDoc, { name: src.name, path, sizeBytes: facts?.sizeBytes }) === 'current'
			&& !(await confirmSubtitleReextract(extraction.dialogService, target.answerCount()))) {
			return;
		}
		// The current, possibly unsaved settings of this dialog
		const config = resolveMediaSubtitlesConfig(field);
		const durationSec = src.durationSec ?? facts?.durationSec;
		if (!(await confirmLargeMediaDecode(extraction.dialogService, durationSec, config)) || store.isDisposed) {
			return;
		}
		const cts = new CancellationTokenSource();
		running = cts;
		const started = Date.now();
		lastResult = undefined;
		setEnabled(false, 'Extracting...');
		cancelBtn.style.display = 'inline-flex';
		showPreview(undefined);
		setProgress(0, 'Reading the media file...');
		status.textContent = `Extracting "${src.name}"...`;
		try {
			const doc = await extractMediaSubtitleDocument(voiceModelService, extraction.fileService, { ...src, durationSec }, config, extraction.baseFolder, (pct, message) => {
				if (!store.isDisposed) {
					setProgress(pct, message);
				}
			}, cts.token);
			// Saved at once (a paid result): Cancel on the dialog does not undo it
			await target.save(doc);
			storedDoc = doc;
			const first = doc.segments[0];
			const last = doc.segments[doc.segments.length - 1];
			const took = Math.max(1, Math.round((Date.now() - started) / 1000));
			lastResult = `Extracted ${doc.segments.length} lines covering ${formatClock(first.start)} - ${formatClock(last.end)} of ${formatMediaDuration(doc.duration ?? last.end)} with ${doc.model || doc.provider} in ${formatMediaDuration(took)} (${formatDocDate(doc.createdAt)}). Saved to the ticket.`;
		} catch (err) {
			if (isCancellationError(err) || cts.token.isCancellationRequested) {
				lastResult = undefined;
				if (!store.isDisposed) {
					showError(undefined);
				}
			} else if (!store.isDisposed) {
				showError((err as Error)?.message || String(err));
			}
		} finally {
			const wasCancelled = cts.token.isCancellationRequested;
			cts.dispose();
			running = undefined;
			if (!store.isDisposed) {
				progressWrap.style.display = 'none';
				cancelBtn.style.display = 'none';
				await refresh();
				if (wasCancelled) {
					status.textContent = 'Extraction cancelled.';
				}
			}
		}
	};

	store.add(addDisposableListener(extractBtn, 'click', e => { e.stopPropagation(); onExtract(); }));
	store.add(addDisposableListener(cancelBtn, 'click', e => { e.stopPropagation(); running?.cancel(); }));
	refresh();
	return { refresh: () => { refresh(); } };
}
