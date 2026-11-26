/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { DictationUnitKind, IDictationAnswer, MIN_DICTATION_SECONDS } from './dictation.js';

/**
 * Configuration (template / Freestyle component settings) and per-ticket state of the
 * MP3 / MP4 Player subtitles and dictation feature (CI-45). Subtitles are opt-in: a field without
 * `mediaSubtitlesEnabled` behaves exactly as before.
 */

export type SubtitleDisplayMode = 'single' | 'scroll' | 'dictation';

export const SUBTITLE_DISPLAY_MODES: readonly { readonly id: SubtitleDisplayMode; readonly label: string }[] = [
	{ id: 'single', label: 'Single line' },
	{ id: 'scroll', label: 'Scrolling list' },
	{ id: 'dictation', label: 'Dictation' }
];

export const DEFAULT_MEDIA_MAX_UPLOAD_MB = 200;

/** Field properties (on `ICustomField`) that configure subtitles. */
export interface IMediaSubtitleFieldProps {
	/** Show the subtitles panel under the player (default false). */
	mediaSubtitlesEnabled?: boolean;
	/** Voice provider id (`openai` / `aliyun` / `gemini` / `custom`); empty = the active voice model. */
	mediaSubtitleProvider?: string;
	/** Model id for that provider; empty = provider default. */
	mediaSubtitleModel?: string;
	/** Language hint such as `en`, `fr` (empty / `auto` = detect). */
	mediaSubtitleLanguage?: string;
	/** Largest media file accepted for extraction, in MB (default 200). */
	mediaMaxUploadMb?: number;
	/** Longest audio accepted for extraction, in minutes (0 / empty = no limit). */
	mediaMaxDurationMin?: number;
	/** Display mode when the ticket opens (default single line). */
	mediaSubtitleDisplayMode?: SubtitleDisplayMode;
	/** Dictation unit: one subtitle sentence or a fixed number of seconds (default sentence). */
	mediaDictationUnit?: DictationUnitKind;
	/** Seconds per unit when the unit is `seconds` (minimum 1, default 5). */
	mediaDictationSeconds?: number;
	/** Pause at the end of each dictation unit (default true). */
	mediaDictationAutoPause?: boolean;
}

export interface IMediaSubtitlesConfig {
	readonly provider: string;
	readonly model: string;
	readonly language: string;
	readonly maxUploadMb: number;
	readonly maxDurationMin: number;
	readonly displayMode: SubtitleDisplayMode;
	readonly dictationUnit: DictationUnitKind;
	readonly dictationSeconds: number;
	readonly autoPause: boolean;
}

/** Per-ticket state, stored inside the field's JSON value in the ticket next to `mediaFilePath`. */
export interface IMediaSubtitlesState {
	/** Ticket-relative path of the subtitles JSON (`attachments/subtitles_<field>.json`). */
	readonly subtitlesFile?: string;
	readonly subtitleDisplayMode?: SubtitleDisplayMode;
	readonly dictationUnit?: DictationUnitKind;
	readonly dictationSeconds?: number;
	readonly dictationAutoPause?: boolean;
	/** Dictation answers keyed by unit kind + start time (see `dictationUnitKey`). */
	readonly dictation?: Record<string, IDictationAnswer>;
}

function isMode(v: unknown): v is SubtitleDisplayMode {
	return v === 'single' || v === 'scroll' || v === 'dictation';
}

function isUnit(v: unknown): v is DictationUnitKind {
	return v === 'segment' || v === 'seconds';
}

function positive(v: unknown, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveMediaSubtitlesConfig(field: IMediaSubtitleFieldProps): IMediaSubtitlesConfig {
	return {
		provider: (field.mediaSubtitleProvider || '').trim(),
		model: (field.mediaSubtitleModel || '').trim(),
		language: (field.mediaSubtitleLanguage || '').trim(),
		maxUploadMb: positive(field.mediaMaxUploadMb, DEFAULT_MEDIA_MAX_UPLOAD_MB),
		maxDurationMin: positive(field.mediaMaxDurationMin, 0),
		displayMode: isMode(field.mediaSubtitleDisplayMode) ? field.mediaSubtitleDisplayMode : 'single',
		dictationUnit: isUnit(field.mediaDictationUnit) ? field.mediaDictationUnit : 'segment',
		dictationSeconds: Math.max(MIN_DICTATION_SECONDS, Math.round(positive(field.mediaDictationSeconds, 5))),
		autoPause: field.mediaDictationAutoPause !== false
	};
}

/** Keys of {@link IMediaSubtitlesState} inside the stored field value. */
export const MEDIA_SUBTITLE_STATE_KEYS: readonly string[] = ['subtitlesFile', 'subtitleDisplayMode', 'dictationUnit', 'dictationSeconds', 'dictationAutoPause', 'dictation'];

/** Reads the subtitles state from a stored field value object, ignoring malformed entries. */
export function parseMediaSubtitlesState(value: Record<string, unknown> | undefined): IMediaSubtitlesState {
	if (!value) {
		return {};
	}
	const dictation: Record<string, IDictationAnswer> = {};
	const rawDictation = value.dictation;
	if (typeof rawDictation === 'object' && rawDictation !== null && !Array.isArray(rawDictation)) {
		for (const [key, raw] of Object.entries(rawDictation)) {
			if (typeof raw !== 'object' || raw === null) {
				continue;
			}
			const r = raw as Record<string, unknown>;
			if (typeof r.text !== 'string') {
				continue;
			}
			dictation[key] = {
				text: r.text,
				correct: typeof r.correct === 'number' ? r.correct : 0,
				total: typeof r.total === 'number' ? r.total : 0,
				score: typeof r.score === 'number' ? r.score : 0,
				at: typeof r.at === 'number' ? r.at : 0
			};
		}
	}
	return {
		subtitlesFile: typeof value.subtitlesFile === 'string' && value.subtitlesFile ? value.subtitlesFile : undefined,
		subtitleDisplayMode: isMode(value.subtitleDisplayMode) ? value.subtitleDisplayMode : undefined,
		dictationUnit: isUnit(value.dictationUnit) ? value.dictationUnit : undefined,
		dictationSeconds: typeof value.dictationSeconds === 'number' && value.dictationSeconds >= MIN_DICTATION_SECONDS ? value.dictationSeconds : undefined,
		dictationAutoPause: typeof value.dictationAutoPause === 'boolean' ? value.dictationAutoPause : undefined,
		dictation
	};
}

/** Keeps the subtitles state keys of a previously stored field value (so saving the player settings never drops answers). */
export function pickMediaSubtitlesState(value: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!value) {
		return out;
	}
	for (const key of MEDIA_SUBTITLE_STATE_KEYS) {
		if (value[key] !== undefined) {
			out[key] = value[key];
		}
	}
	return out;
}
