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
	{ id: 'dictation', label: 'Dictation practice' }
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
	/** "Dictation mode": stop playback at the end of each dictation unit so the user can type it (default true). */
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

// --- "Dictation mode" wording (CI-46) ----------------------------------------------------------------
// The stored property stays `mediaDictationAutoPause` / `dictationAutoPause`; only the labels changed.

/** Name of the option everywhere it is shown (settings row, card toggle, help). */
export const DICTATION_MODE_LABEL = 'Dictation mode';

/** "sentence" / "5-second part": what one dictation unit is called in the wording. */
export function dictationUnitNoun(unit: DictationUnitKind, seconds: number): string {
	return unit === 'seconds' ? `${Math.max(MIN_DICTATION_SECONDS, Math.round(seconds))}-second part` : 'sentence';
}

/** Checkbox text of the settings row: `Stop after each sentence so I can type what I hear`. */
export function dictationModeCheckboxText(unit: DictationUnitKind, seconds: number): string {
	return `Stop after each ${dictationUnitNoun(unit, seconds)} so I can type what I hear`;
}

/** Tooltip of the settings row: what the option changes in the Dictation practice display. */
export function dictationModeDescription(unit: DictationUnitKind, seconds: number): string {
	const noun = dictationUnitNoun(unit, seconds);
	return `Used by the Dictation practice display. On: playback stops at the end of each ${noun} and waits until you have typed it (Enter checks, Enter again plays the next one). Off: playback keeps going and the dictation box follows along.`;
}

/** Tooltip of the card's toggle button for the current state. */
export function dictationModeToggleTitle(on: boolean, unit: DictationUnitKind, seconds: number): string {
	const noun = dictationUnitNoun(unit, seconds);
	return on
		? `${DICTATION_MODE_LABEL} is on: playback stops after each ${noun} so you can type what you hear. Click to let it keep playing.`
		: `${DICTATION_MODE_LABEL} is off: playback keeps going and the dictation box follows along. Click to stop after each ${noun}.`;
}

/** Ticket-relative path of the subtitles JSON of a media player field: `attachments/subtitles_<field>.json`. */
export function mediaSubtitlesFileName(fieldKey: string): string {
	const safeKey = fieldKey.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'media';
	return `attachments/subtitles_${safeKey}.json`;
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

// --- current file facts and limits ---------------------------------------------------------------

/** One "MB" of the size limit (binary megabyte, as the limit has always been checked). */
export const MEDIA_BYTES_PER_MB = 1024 * 1024;

/** What is known about the loaded media file (either may be unknown). */
export interface IMediaFileFacts {
	readonly sizeBytes?: number;
	readonly durationSec?: number;
}

export interface IMediaLimitCheck {
	readonly sizeExceeded: boolean;
	readonly durationExceeded: boolean;
}

function known(n: number | undefined): n is number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** File size in the unit of the limit: `201.4 MB`, `0.3 MB`, `512 KB` below 0.1 MB, `1.22 GB` from 1 GB on. */
export function formatMediaSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return '0 MB';
	}
	const mb = bytes / MEDIA_BYTES_PER_MB;
	if (mb >= 1024) {
		return `${(mb / 1024).toFixed(2)} GB`;
	}
	if (mb > 0 && mb < 0.1) {
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
	return `${mb.toFixed(1)} MB`;
}

/** Media duration as a clock: `25:06`, `1:02:03` (whole seconds). */
export function formatMediaDuration(seconds: number): string {
	const total = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = s < 10 ? `0${s}` : String(s);
	if (h > 0) {
		return `${h}:${m < 10 ? `0${m}` : m}:${ss}`;
	}
	return `${m}:${ss}`;
}

/** `201.4 MB, 25:06` / `201.4 MB` / `25:06`; empty when nothing is known. */
export function describeMediaFacts(facts: IMediaFileFacts | undefined): string {
	const parts: string[] = [];
	const size = facts?.sizeBytes;
	const duration = facts?.durationSec;
	if (known(size)) {
		parts.push(formatMediaSize(size));
	}
	if (known(duration)) {
		parts.push(formatMediaDuration(duration));
	}
	return parts.join(', ');
}

/** Whether the file is over the size limit (MB) or the duration limit (minutes, 0 = no limit). Unknown facts never exceed. */
export function checkMediaLimits(limits: Pick<IMediaSubtitlesConfig, 'maxUploadMb' | 'maxDurationMin'>, facts: IMediaFileFacts | undefined): IMediaLimitCheck {
	const maxBytes = Math.max(0, limits.maxUploadMb) * MEDIA_BYTES_PER_MB;
	const size = facts?.sizeBytes;
	const duration = facts?.durationSec;
	return {
		sizeExceeded: known(size) && maxBytes > 0 && size > maxBytes,
		// Half a second of tolerance: container and decoded durations differ slightly
		durationExceeded: known(duration) && limits.maxDurationMin > 0 && duration > limits.maxDurationMin * 60 + 0.5
	};
}

/** Refusal message of the extraction when the file is over the size limit (states both sizes). */
export function mediaSizeLimitMessage(name: string, sizeBytes: number, maxUploadMb: number): string {
	return `"${name}" is ${formatMediaSize(sizeBytes)}, over the ${maxUploadMb} MB limit for subtitle extraction. Raise "Max file size (MB)" in the component settings (gear) or use a smaller file.`;
}

/** Refusal message of the extraction when the media is longer than the duration limit (states both durations). */
export function mediaDurationLimitMessage(name: string, durationSec: number, maxDurationMin: number): string {
	return `"${name}" is ${formatMediaDuration(durationSec)} long, over the ${maxDurationMin} min (${formatMediaDuration(maxDurationMin * 60)}) limit for subtitle extraction. Raise "Max duration (min)" in the component settings (gear), or set it to 0 for no limit.`;
}

/**
 * Peak renderer memory of Chromium's `decodeAudioData`, which decodes the whole file at its own sample rate.
 * Measured in Electron 42 (CI-45): 48 kHz stereo AAC (MP4 / M4A) about 2.3 MB per second of audio (3.4 GB for
 * 25 min), 44.1 kHz stereo MP3 about 1 MB/s, 16 kHz mono AAC about 0.25 MB/s. The worst case is used.
 */
export const DECODE_PEAK_MB_PER_SECOND = 2.3;

/** Above this duration the extraction asks before decoding (about 6 GB peak for 48 kHz stereo). */
export const LARGE_DECODE_WARN_SECONDS = 45 * 60;

/** Worst-case peak memory (MB) to decode `durationSec` of audio in the renderer. */
export function estimateDecodePeakMb(durationSec: number): number {
	return Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec * DECODE_PEAK_MB_PER_SECOND) : 0;
}
