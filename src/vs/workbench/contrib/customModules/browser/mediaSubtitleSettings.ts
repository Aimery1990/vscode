/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ICustomField } from '../../entityPersistence/common/entityPersistence.js';
import { IVoiceModelService, SUBTITLE_MODEL_CATALOG, VOICE_PROVIDER_CATALOG } from '../../voiceModels/common/voiceModel.js';
import { DEFAULT_MEDIA_MAX_UPLOAD_MB, resolveMediaSubtitlesConfig, SUBTITLE_DISPLAY_MODES } from '../../voiceModels/common/subtitleConfig.js';
import { MIN_DICTATION_SECONDS } from '../../voiceModels/common/dictation.js';

const LABEL_STYLE = 'font-size: 11px; color: rgba(255, 255, 255, 0.7); min-width: 150px;';
const INPUT_STYLE = 'background: rgba(0, 0, 0, 0.3); color: #f8fafc; border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 4px; padding: 3px 6px; font-size: 11px; outline: none;';
const OPTION_STYLE = 'background: #1e1e2e; color: #f8fafc;';
const OTHER_MODEL = '__other__';

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
export function renderMediaSubtitleSettings(container: HTMLElement, field: ICustomField, voiceModelService: IVoiceModelService | undefined, onChange: () => void): IDisposable {
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

	// Limits
	const sizeInput = append(row(details, 'Max file size (MB)', 'Larger files are rejected before decoding.'), $<HTMLInputElement>('input', { type: 'number', min: '1', step: '1', style: `${INPUT_STYLE} width: 80px;` }));
	sizeInput.value = String(cfg.maxUploadMb);
	store.add(addDisposableListener(sizeInput, 'change', () => {
		const n = Math.round(Number(sizeInput.value));
		field.mediaMaxUploadMb = Number.isFinite(n) && n > 0 ? n : DEFAULT_MEDIA_MAX_UPLOAD_MB;
		sizeInput.value = String(field.mediaMaxUploadMb);
		onChange();
	}));
	const durationInput = append(row(details, 'Max duration (min)', '0 = no limit.'), $<HTMLInputElement>('input', { type: 'number', min: '0', step: '1', style: `${INPUT_STYLE} width: 80px;` }));
	durationInput.value = String(cfg.maxDurationMin);
	store.add(addDisposableListener(durationInput, 'change', () => {
		const n = Math.round(Number(durationInput.value));
		field.mediaMaxDurationMin = Number.isFinite(n) && n > 0 ? n : 0;
		durationInput.value = String(field.mediaMaxDurationMin);
		onChange();
	}));

	// Display + dictation defaults
	const modeSelect = append(row(details, 'Default display'), $<HTMLSelectElement>('select', { style: INPUT_STYLE }));
	for (const m of SUBTITLE_DISPLAY_MODES) {
		modeSelect.appendChild(option(m.id, m.label));
	}
	modeSelect.value = cfg.displayMode;
	store.add(addDisposableListener(modeSelect, 'change', () => {
		field.mediaSubtitleDisplayMode = modeSelect.value === 'scroll' ? 'scroll' : modeSelect.value === 'dictation' ? 'dictation' : 'single';
		onChange();
	}));

	const unitRow = row(details, 'Dictation unit', 'Sentence = one subtitle line; Seconds = fixed windows (minimum 1 s).');
	const unitSelect = append(unitRow, $<HTMLSelectElement>('select', { style: INPUT_STYLE }, option('segment', 'Sentence'), option('seconds', 'Fixed seconds')));
	unitSelect.value = cfg.dictationUnit;
	const secondsInput = append(unitRow, $<HTMLInputElement>('input', { type: 'number', min: String(MIN_DICTATION_SECONDS), step: '1', title: 'Seconds per unit', style: `${INPUT_STYLE} width: 60px;` }));
	secondsInput.value = String(cfg.dictationSeconds);
	const syncSeconds = () => { secondsInput.style.display = unitSelect.value === 'seconds' ? 'inline-block' : 'none'; };
	syncSeconds();
	store.add(addDisposableListener(unitSelect, 'change', () => {
		field.mediaDictationUnit = unitSelect.value === 'seconds' ? 'seconds' : 'segment';
		syncSeconds();
		onChange();
	}));
	store.add(addDisposableListener(secondsInput, 'change', () => {
		const n = Math.round(Number(secondsInput.value));
		field.mediaDictationSeconds = Number.isFinite(n) && n >= MIN_DICTATION_SECONDS ? n : MIN_DICTATION_SECONDS;
		secondsInput.value = String(field.mediaDictationSeconds);
		onChange();
	}));

	const autoLabel = append(row(details, 'Auto-pause'), $('label', { style: 'display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: rgba(255, 255, 255, 0.75); cursor: pointer;' }));
	const autoBox = append(autoLabel, $<HTMLInputElement>('input', { type: 'checkbox' }));
	autoBox.checked = cfg.autoPause;
	append(autoLabel, $('span', undefined, 'Pause at the end of each dictation unit'));
	store.add(addDisposableListener(autoBox, 'change', () => { field.mediaDictationAutoPause = autoBox.checked; onChange(); }));

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

	return store;
}
