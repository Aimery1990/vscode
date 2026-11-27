/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for timed subtitles (CI-45): segment validation / repair, parsing model output,
 * merging chunk results, snapping model timestamps to detected speech, and SRT / VTT / plain text export.
 */

/** One subtitle line. Times are in seconds from the start of the media. */
export interface ISubtitleSegment {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/** A time range in seconds (speech region, chunk, ...). */
export interface ITimeRange {
	readonly start: number;
	readonly end: number;
}

/** The JSON document stored next to the media (ticket `attachments/subtitles_<field>.json`). */
export interface ISubtitleDocument {
	readonly version: 1;
	readonly mediaName: string;
	/** Absolute path (or `file://` URI) of the media the subtitles were extracted from, when known (CI-46). */
	readonly mediaPath?: string;
	readonly mediaSize?: number;
	readonly duration?: number;
	readonly provider: string;
	readonly model: string;
	readonly language?: string;
	readonly createdAt: number;
	readonly segments: ISubtitleSegment[];
}

/** How a provider / model produces timestamps. */
export type TimedTranscriptionStrategy =
	/** The API returns segment timestamps itself (OpenAI whisper-1 verbose_json, diarized_json, OpenAI-compatible servers). */
	| 'native'
	/** An audio-understanding LLM is asked for strict JSON `[{start,end,text}]`; times are then snapped to detected speech. */
	| 'llm-json'
	/** Text-only ASR: the audio is cut into utterances at pauses locally and each utterance is transcribed separately. */
	| 'utterances';

export interface ITimedTranscriptionPlan {
	readonly strategy: TimedTranscriptionStrategy;
	/** Longest audio sent in one request, in seconds. */
	readonly maxChunkSeconds: number;
}

/** Chooses the timestamp strategy for a provider / model id. */
export function getTimedTranscriptionPlan(provider: string, modelId: string): ITimedTranscriptionPlan {
	const model = (modelId || '').toLowerCase();
	switch (provider) {
		case 'openai':
			if (model === 'whisper-1' || model.includes('diarize')) {
				// 25 MB upload limit; 16 kHz 16-bit mono WAV is 32 KB/s, so 10 minutes is ~19 MB.
				return { strategy: 'native', maxChunkSeconds: 600 };
			}
			// gpt-4o(-mini)-transcribe and newer text-only models do not return timestamps.
			return { strategy: 'utterances', maxChunkSeconds: 15 };
		case 'custom':
			return { strategy: 'native', maxChunkSeconds: 600 };
		case 'aliyun':
			if (model.includes('asr')) {
				// qwen3-asr-flash(-us) returns text only (no timestamps in the US region).
				return { strategy: 'utterances', maxChunkSeconds: 15 };
			}
			return { strategy: 'llm-json', maxChunkSeconds: 120 };
		case 'gemini':
		default:
			return { strategy: 'llm-json', maxChunkSeconds: 120 };
	}
}

/** Prompt used for `llm-json` models. */
export function buildTimedTranscriptionPrompt(language?: string): string {
	const lang = language && language !== 'auto' ? ` The spoken language is "${language}".` : '';
	return 'Transcribe this audio into subtitles.' + lang
		+ ' Return ONLY a JSON array, no markdown, where each item is {"start": number, "end": number, "text": string}:'
		+ ' one item per sentence or short phrase (at most about 12 seconds each), start and end in seconds from the beginning of this audio clip,'
		+ ' text verbatim in the original spoken language with punctuation. Do not translate. Do not add commentary.';
}

const TIME_HMS = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/;

/** Parses seconds from a number, a numeric string, or `[hh:]mm:ss[.,ms]`. Returns undefined when not a time. */
export function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const s = value.trim().replace(/s$/i, '');
	if (!s) {
		return undefined;
	}
	if (/^\d+(?:\.\d+)?$/.test(s)) {
		return Number(s);
	}
	const m = TIME_HMS.exec(s);
	if (!m) {
		return undefined;
	}
	const h = m[1] ? Number(m[1]) : 0;
	return h * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.'));
}

function readNumberField(obj: Record<string, unknown>, keys: readonly string[], msKeys: readonly string[]): number | undefined {
	for (const k of keys) {
		const v = parseTimestamp(obj[k]);
		if (v !== undefined) {
			return v;
		}
	}
	for (const k of msKeys) {
		const v = obj[k];
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
			return v / 1000;
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapses whitespace in a subtitle line. */
export function cleanSubtitleText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Validates and repairs a raw segment list: accepts `{start,end,text}` and common variants
 * (`begin`, `begin_time` / `end_time` in ms, `"00:01.5"` strings, `{segments: [...]}`), drops empty lines,
 * sorts by start, fills a missing / invalid end from the next start, removes overlaps and clamps to `duration`.
 */
export function normalizeSegments(raw: unknown, duration?: number): ISubtitleSegment[] {
	let list: unknown = raw;
	if (isRecord(list)) {
		list = list.segments ?? list.subtitles ?? list.sentences ?? list.items;
	}
	if (!Array.isArray(list)) {
		return [];
	}
	const maxT = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
	const items: { start: number; end: number | undefined; text: string }[] = [];
	for (const item of list) {
		if (!isRecord(item)) {
			continue;
		}
		const textRaw = item.text ?? item.sentence ?? item.content ?? item.transcript;
		const text = typeof textRaw === 'string' ? cleanSubtitleText(textRaw) : '';
		if (!text) {
			continue;
		}
		const start = readNumberField(item, ['start', 'begin', 'start_time', 'startTime', 'from'], ['begin_time', 'start_ms', 'startMs']);
		if (start === undefined) {
			continue;
		}
		const end = readNumberField(item, ['end', 'stop', 'end_time', 'endTime', 'to'], ['end_ms', 'endMs']);
		items.push({ start, end, text });
	}
	items.sort((a, b) => a.start - b.start);
	const out: ISubtitleSegment[] = [];
	for (let i = 0; i < items.length; i++) {
		const cur = items[i];
		const start = Math.min(cur.start, maxT);
		const next = items[i + 1];
		let end = cur.end;
		if (end === undefined || end <= start) {
			end = next && next.start > start ? next.start : start + estimateSpeechSeconds(cur.text);
		}
		if (next && end > next.start && next.start > start) {
			end = next.start;
		}
		end = Math.min(end, maxT);
		if (end <= start) {
			if (start >= maxT) {
				continue;
			}
			end = Math.min(maxT, start + 0.5);
		}
		out.push({ start: round3(start), end: round3(end), text: cur.text });
	}
	return out;
}

/** Rough speaking time of a text: ~15 characters per second, at least one second. */
export function estimateSpeechSeconds(text: string): number {
	return Math.max(1, text.length / 15);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** Removes trailing commas before `]` / `}` (a common LLM JSON mistake). */
function repairJson(text: string): string {
	return text.replace(/,\s*([\]}])/g, '$1');
}

/**
 * Parses subtitle JSON returned by an LLM: strips code fences, cuts the outermost array (or object),
 * repairs trailing commas, then {@link normalizeSegments}. Returns undefined when nothing could be parsed.
 */
export function parseSubtitleJson(text: string, duration?: number): ISubtitleSegment[] | undefined {
	let body = (text || '').trim();
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
	if (fence) {
		body = fence[1].trim();
	}
	const candidates: string[] = [body];
	const a0 = body.indexOf('[');
	const a1 = body.lastIndexOf(']');
	if (a0 >= 0 && a1 > a0) {
		candidates.push(body.slice(a0, a1 + 1));
	}
	const o0 = body.indexOf('{');
	const o1 = body.lastIndexOf('}');
	if (o0 >= 0 && o1 > o0) {
		candidates.push(body.slice(o0, o1 + 1));
	}
	for (const c of candidates) {
		for (const attempt of [c, repairJson(c)]) {
			try {
				const parsed: unknown = JSON.parse(attempt);
				const segs = normalizeSegments(parsed, duration);
				if (segs.length > 0) {
					return segs;
				}
			} catch {
				// try the next candidate
			}
		}
	}
	return undefined;
}

/** Shifts segments by `offset` seconds. */
export function offsetSegments(segments: readonly ISubtitleSegment[], offset: number): ISubtitleSegment[] {
	return segments.map(s => ({ start: round3(s.start + offset), end: round3(s.end + offset), text: s.text }));
}

/**
 * Merges per-chunk results (segment times relative to each chunk) into one timeline:
 * offsets every chunk, clamps segments to their chunk and removes overlaps across chunk borders.
 */
export function mergeChunkSegments(chunks: readonly { readonly range: ITimeRange; readonly segments: readonly ISubtitleSegment[] }[]): ISubtitleSegment[] {
	const all: ISubtitleSegment[] = [];
	for (const chunk of chunks) {
		const len = chunk.range.end - chunk.range.start;
		for (const s of chunk.segments) {
			const start = Math.max(0, Math.min(s.start, len));
			const end = Math.max(start, Math.min(s.end, len));
			if (end - start < 0.05 && start >= len) {
				continue;
			}
			all.push({ start: round3(chunk.range.start + start), end: round3(chunk.range.start + end), text: s.text });
		}
	}
	all.sort((a, b) => a.start - b.start);
	const out: ISubtitleSegment[] = [];
	for (const s of all) {
		const prev = out[out.length - 1];
		if (prev && prev.end > s.start) {
			out[out.length - 1] = { ...prev, end: Math.max(prev.start, s.start) };
		}
		out.push(s);
	}
	return out;
}

/**
 * Improves model-generated (`llm-json`) timestamps with locally detected speech regions:
 * if the model ran past the clip, times are rescaled to the last speech end; then every start / end
 * is snapped to the nearest speech onset / offset within `tolerance` seconds, keeping the order.
 */
export function snapSegmentsToSpeech(segments: readonly ISubtitleSegment[], speech: readonly ITimeRange[], clipDuration: number, tolerance = 0.8): ISubtitleSegment[] {
	if (segments.length === 0 || speech.length === 0) {
		return segments.slice();
	}
	const lastSpeechEnd = speech[speech.length - 1].end;
	const maxEnd = Math.max(...segments.map(s => s.end));
	const scale = maxEnd > clipDuration + 0.25 && maxEnd > 0 ? lastSpeechEnd / maxEnd : 1;
	const onsets = speech.map(r => r.start);
	const offsets = speech.map(r => r.end);
	const nearest = (points: readonly number[], t: number, min: number): number | undefined => {
		let best: number | undefined;
		let bestD = tolerance;
		for (const p of points) {
			if (p < min) {
				continue;
			}
			const d = Math.abs(p - t);
			if (d <= bestD) {
				best = p;
				bestD = d;
			}
		}
		return best;
	};
	const out: ISubtitleSegment[] = [];
	let floor = 0;
	for (const seg of segments) {
		const s0 = seg.start * scale;
		const e0 = seg.end * scale;
		const start = nearest(onsets, s0, floor) ?? Math.max(s0, floor);
		const endSnap = nearest(offsets, e0, start + 0.1);
		const end = Math.min(clipDuration, Math.max(start + 0.1, endSnap ?? e0));
		out.push({ start: round3(start), end: round3(end), text: seg.text });
		floor = end;
	}
	return out;
}

/** Splits text into sentences after `. ! ? ...` (and CJK sentence marks), keeping the punctuation. */
export function splitSentences(text: string): string[] {
	return cleanSubtitleText(text)
		.split(/(?<=[.!?\u2026\u3002\uFF01\uFF1F](?:["'\u201D\u00BB)\]]*))\s+(?=\S)|(?<=[\u3002\uFF01\uFF1F])/u)
		.map(s => s.trim())
		.filter(Boolean);
}

/**
 * Splits one transcribed range into sentence segments. Sentence borders are placed by character share of the
 * speech time inside `range`, then moved to the nearest pause between speech regions (within `tolerance` s), so a
 * long utterance or a single long LLM segment becomes sentence-level subtitles with pause-accurate times.
 */
export function distributeSentences(text: string, range: ITimeRange, speech: readonly ITimeRange[], tolerance = 1.2): ISubtitleSegment[] {
	const sentences = splitSentences(text);
	const regions = speech
		.map(r => ({ start: Math.max(r.start, range.start), end: Math.min(r.end, range.end) }))
		.filter(r => r.end > r.start);
	if (sentences.length <= 1 || regions.length === 0) {
		const t = cleanSubtitleText(text);
		return t ? [{ start: round3(range.start), end: round3(range.end), text: t }] : [];
	}
	const speechTotal = regions.reduce((n, r) => n + (r.end - r.start), 0);
	const chars = sentences.map(s => s.length);
	const charTotal = chars.reduce((a, b) => a + b, 0);
	// Absolute time at a given amount of elapsed speech time.
	const timeAtSpeech = (elapsed: number): number => {
		let acc = 0;
		for (const r of regions) {
			const len = r.end - r.start;
			if (acc + len >= elapsed) {
				return r.start + (elapsed - acc);
			}
			acc += len;
		}
		return regions[regions.length - 1].end;
	};
	const gaps = regions.slice(1).map((r, i) => ({ before: regions[i].end, after: r.start }));
	const borders: { end: number; start: number }[] = [];
	let acc = 0;
	let minT = range.start;
	for (let i = 0; i < sentences.length - 1; i++) {
		acc += chars[i];
		const target = timeAtSpeech(speechTotal * acc / charTotal);
		let best: { before: number; after: number } | undefined;
		let bestD = tolerance;
		for (const g of gaps) {
			const d = Math.abs((g.before + g.after) / 2 - target);
			if (g.before > minT && d <= bestD) {
				best = g;
				bestD = d;
			}
		}
		const border = best ? { end: best.before, start: best.after } : { end: Math.max(target, minT), start: Math.max(target, minT) };
		borders.push(border);
		minT = border.start;
	}
	const out: ISubtitleSegment[] = [];
	for (let i = 0; i < sentences.length; i++) {
		const start = i === 0 ? range.start : borders[i - 1].start;
		const end = i === sentences.length - 1 ? range.end : borders[i].end;
		const prev = out[out.length - 1];
		if (end - start < 0.2 && prev) {
			// Two borders snapped to the same pause: keep the text with the previous sentence.
			out[out.length - 1] = { ...prev, end: round3(Math.max(prev.end, end)), text: `${prev.text} ${sentences[i]}` };
			continue;
		}
		out.push({ start: round3(start), end: round3(Math.max(start, end)), text: sentences[i] });
	}
	return out;
}

/** Index of the segment that contains `t`, or -1. Segments must be sorted. */
export function findSegmentAt(segments: readonly ISubtitleSegment[], t: number): number {
	let lo = 0;
	let hi = segments.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const s = segments[mid];
		if (t < s.start) {
			hi = mid - 1;
		} else if (t >= s.end) {
			lo = mid + 1;
		} else {
			return mid;
		}
	}
	return -1;
}

/** Index of the last segment that started at or before `t` (the one to keep highlighted between lines), or -1. */
export function findLastStartedSegment(segments: readonly ISubtitleSegment[], t: number): number {
	let lo = 0;
	let hi = segments.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (segments[mid].start <= t) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, '0');
}

/** `hh:mm:ss<sep>mmm` for SRT (`,`) / VTT (`.`). */
export function formatCueTime(seconds: number, msSeparator: ',' | '.'): string {
	const totalMs = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(totalMs / 3600000);
	const m = Math.floor((totalMs % 3600000) / 60000);
	const s = Math.floor((totalMs % 60000) / 1000);
	const ms = totalMs % 1000;
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(ms, 3)}`;
}

/** Short clock for UI and plain text: `m:ss.d` or `h:mm:ss.d`. */
export function formatClock(seconds: number): string {
	const t = Math.max(0, seconds);
	const tenths = Math.floor(t * 10) % 10;
	const total = Math.floor(t);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}.${tenths}` : `${m}:${pad(s, 2)}.${tenths}`;
}

export function toSrt(segments: readonly ISubtitleSegment[]): string {
	return segments.map((s, i) => `${i + 1}\n${formatCueTime(s.start, ',')} --> ${formatCueTime(s.end, ',')}\n${s.text}\n`).join('\n');
}

export function toVtt(segments: readonly ISubtitleSegment[]): string {
	return 'WEBVTT\n\n' + segments.map(s => `${formatCueTime(s.start, '.')} --> ${formatCueTime(s.end, '.')}\n${s.text}\n`).join('\n');
}

/** Plain text with timestamps, one line per segment: `[0:01.2 - 0:03.4] text`. Used as the field output for workflows. */
export function toTimedText(segments: readonly ISubtitleSegment[]): string {
	return segments.map(s => `[${formatClock(s.start)} - ${formatClock(s.end)}] ${s.text}`).join('\n');
}

/** Reads a stored subtitle document, tolerating hand edits. Returns undefined when it is not one. */
export function parseSubtitleDocument(json: string): ISubtitleDocument | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) {
		return undefined;
	}
	const segments = normalizeSegments(parsed.segments);
	return {
		version: 1,
		mediaName: typeof parsed.mediaName === 'string' ? parsed.mediaName : '',
		mediaPath: typeof parsed.mediaPath === 'string' && parsed.mediaPath ? parsed.mediaPath : undefined,
		mediaSize: typeof parsed.mediaSize === 'number' ? parsed.mediaSize : undefined,
		duration: typeof parsed.duration === 'number' ? parsed.duration : undefined,
		provider: typeof parsed.provider === 'string' ? parsed.provider : '',
		model: typeof parsed.model === 'string' ? parsed.model : '',
		language: typeof parsed.language === 'string' ? parsed.language : undefined,
		createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
		segments
	};
}

// --- is a stored subtitle document current for the loaded media (CI-46) ---------------------------

/** The media file a stored subtitle document is compared with (any part may be unknown). */
export interface ISubtitleMediaIdentity {
	readonly name?: string;
	readonly path?: string;
	readonly sizeBytes?: number;
}

/**
 * - `current`: the subtitles were extracted from this file and can be used as they are;
 * - `changed`: same file name / path, but the size differs (the file was replaced or edited);
 * - `other-file`: the subtitles belong to another file.
 */
export type SubtitleDocumentMatch = 'current' | 'changed' | 'other-file';

/** `file:///a/b%20c.mp3`, `C:\\a\\b.mp3` and `/a//b.mp3` compared as plain forward-slash paths. */
export function normalizeMediaPath(path: string | undefined): string {
	let s = (path || '').trim();
	if (!s) {
		return '';
	}
	if (/^file:\/\//i.test(s)) {
		s = s.replace(/^file:\/\//i, '');
		try {
			s = decodeURIComponent(s);
		} catch {
			// keep the raw text
		}
		// file:///C:/x -> C:/x
		s = s.replace(/^\/([a-zA-Z]:\/)/, '$1');
	}
	s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	return s.length > 1 ? s.replace(/\/$/, '') : s;
}

function knownSize(n: number | undefined): n is number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Whether stored subtitles were extracted from `media`: the same path, or the same file name (case-insensitive);
 * then a known size that differs means the file changed. A document that records neither name nor path (hand-made)
 * cannot be checked and is trusted.
 */
export function matchSubtitleDocument(doc: Pick<ISubtitleDocument, 'mediaName' | 'mediaPath' | 'mediaSize'>, media: ISubtitleMediaIdentity): SubtitleDocumentMatch {
	const docPath = normalizeMediaPath(doc.mediaPath);
	const mediaPath = normalizeMediaPath(media.path);
	const docName = ((doc.mediaName || '').trim() || docPath.split('/').pop() || '').toLowerCase();
	const mediaName = ((media.name || '').trim() || mediaPath.split('/').pop() || '').toLowerCase();
	if (!docName && !docPath) {
		return 'current';
	}
	const samePath = !!docPath && docPath === mediaPath;
	const sameName = !!docName && docName === mediaName;
	if (!samePath && !sameName) {
		return 'other-file';
	}
	if (knownSize(doc.mediaSize) && knownSize(media.sizeBytes) && doc.mediaSize !== media.sizeBytes) {
		return 'changed';
	}
	return 'current';
}
