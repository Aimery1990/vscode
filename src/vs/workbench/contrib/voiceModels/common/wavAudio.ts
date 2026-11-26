/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ITimeRange } from './subtitles.js';

/**
 * Pure audio helpers for subtitle extraction (CI-45): mono mixing, linear resampling,
 * 16-bit PCM WAV encode / decode, energy-based speech detection, and chunk / utterance planning.
 */

/** Sample rate sent to speech-to-text models. */
export const ASR_SAMPLE_RATE = 16000;

/** Averages channels into one mono channel. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
	if (channels.length === 0) {
		return new Float32Array(0);
	}
	if (channels.length === 1) {
		return channels[0];
	}
	const len = Math.min(...channels.map(c => c.length));
	const out = new Float32Array(len);
	for (const ch of channels) {
		for (let i = 0; i < len; i++) {
			out[i] += ch[i];
		}
	}
	const n = channels.length;
	for (let i = 0; i < len; i++) {
		out[i] /= n;
	}
	return out;
}

/** Linear-interpolation resampler (used only when the decoder did not already resample). */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || samples.length === 0) {
		return samples;
	}
	const outLen = Math.max(1, Math.round(samples.length * toRate / fromRate));
	const out = new Float32Array(outLen);
	const ratio = fromRate / toRate;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(samples.length - 1, i0 + 1);
		const f = pos - i0;
		out[i] = samples[Math.min(i0, samples.length - 1)] * (1 - f) + samples[i1] * f;
	}
	return out;
}

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const buf = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buf);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) {
			view.setUint8(offset + i, s.charCodeAt(i));
		}
	};
	writeStr(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeStr(8, 'WAVE');
	writeStr(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, 'data');
	view.setUint32(40, dataBytes, true);
	let o = 44;
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
		o += 2;
	}
	return new Uint8Array(buf);
}

/** Decodes a 16-bit PCM WAV (any channel count, mixed to mono). Returns undefined for other formats. */
export function decodeWav16(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | undefined {
	if (bytes.length < 44) {
		return undefined;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const str = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
	if (str(0) !== 'RIFF' || str(8) !== 'WAVE') {
		return undefined;
	}
	let offset = 12;
	let channels = 1;
	let sampleRate = 0;
	let bits = 0;
	while (offset + 8 <= bytes.length) {
		const id = str(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === 'fmt ') {
			if (view.getUint16(body, true) !== 1) {
				return undefined;
			}
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bits = view.getUint16(body + 14, true);
		} else if (id === 'data') {
			if (bits !== 16 || !sampleRate || channels < 1) {
				return undefined;
			}
			const frames = Math.floor(Math.min(size, bytes.length - body) / (2 * channels));
			const out = new Float32Array(frames);
			for (let i = 0; i < frames; i++) {
				let sum = 0;
				for (let c = 0; c < channels; c++) {
					sum += view.getInt16(body + (i * channels + c) * 2, true) / 0x8000;
				}
				out[i] = sum / channels;
			}
			return { samples: out, sampleRate };
		}
		offset = body + size + (size % 2);
	}
	return undefined;
}

export interface ISpeechDetectionOptions {
	/** Analysis frame length in seconds (default 0.03). */
	readonly frameSeconds?: number;
	/** Silence shorter than this joins the surrounding speech (default 0.2). */
	readonly minSilenceSeconds?: number;
	/** Speech shorter than this is dropped as noise (default 0.12). */
	readonly minSpeechSeconds?: number;
}

/**
 * Energy-based voice activity detection. The threshold adapts to the clip: a point between the
 * noise floor (10th percentile of frame energy, in dB) and the loud level (95th percentile).
 */
export function detectSpeechRegions(samples: Float32Array, sampleRate: number, options: ISpeechDetectionOptions = {}): ITimeRange[] {
	const frameSec = options.frameSeconds ?? 0.03;
	const frameLen = Math.max(1, Math.round(frameSec * sampleRate));
	const frames = Math.floor(samples.length / frameLen);
	if (frames === 0) {
		return [];
	}
	const db = new Float32Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		const base = f * frameLen;
		for (let i = 0; i < frameLen; i++) {
			const v = samples[base + i];
			sum += v * v;
		}
		db[f] = 10 * Math.log10(sum / frameLen + 1e-10);
	}
	const sorted = Array.from(db).sort((a, b) => a - b);
	const floor = sorted[Math.floor(frames * 0.1)];
	const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.95))];
	if (loud < -60) {
		return []; // silence
	}
	const threshold = Math.max(floor + 6, Math.min(loud - 25, floor + (loud - floor) * 0.35));
	const regions: { start: number; end: number }[] = [];
	let cur: { start: number; end: number } | undefined;
	for (let f = 0; f < frames; f++) {
		if (db[f] >= threshold) {
			const t = f * frameSec;
			if (cur) {
				cur.end = t + frameSec;
			} else {
				cur = { start: t, end: t + frameSec };
			}
		} else if (cur) {
			regions.push(cur);
			cur = undefined;
		}
	}
	if (cur) {
		regions.push(cur);
	}
	const minSil = options.minSilenceSeconds ?? 0.2;
	const minSpeech = options.minSpeechSeconds ?? 0.12;
	const merged: { start: number; end: number }[] = [];
	for (const r of regions) {
		const prev = merged[merged.length - 1];
		if (prev && r.start - prev.end < minSil) {
			prev.end = r.end;
		} else {
			merged.push({ ...r });
		}
	}
	const total = samples.length / sampleRate;
	return merged
		.filter(r => r.end - r.start >= minSpeech)
		.map(r => ({ start: round3(r.start), end: round3(Math.min(total, r.end)) }));
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/**
 * Splits `[0, duration]` into chunks of at most `maxChunkSeconds`, cutting in the middle of the
 * longest pause found in the last third of each window (falls back to a hard cut when there is none).
 */
export function planChunks(duration: number, speech: readonly ITimeRange[], maxChunkSeconds: number): ITimeRange[] {
	const chunks: ITimeRange[] = [];
	let start = 0;
	while (duration - start > maxChunkSeconds) {
		const hardEnd = start + maxChunkSeconds;
		const minCut = start + maxChunkSeconds * 2 / 3;
		let bestCut = hardEnd;
		let bestGap = 0;
		for (let i = 0; i + 1 < speech.length; i++) {
			const gapStart = speech[i].end;
			const gapEnd = speech[i + 1].start;
			const mid = (gapStart + gapEnd) / 2;
			if (mid <= minCut || mid >= hardEnd) {
				continue;
			}
			const gap = gapEnd - gapStart;
			if (gap > bestGap) {
				bestGap = gap;
				bestCut = mid;
			}
		}
		chunks.push({ start: round3(start), end: round3(bestCut) });
		start = bestCut;
	}
	if (duration > start || chunks.length === 0) {
		chunks.push({ start: round3(start), end: round3(duration) });
	}
	return chunks;
}

export interface IUtterancePlanOptions {
	/** An utterance is closed at a pause of at least this length (default 0.6 s). */
	readonly pauseSeconds?: number;
	/** Utterances are kept below this length; longer speech without pauses is cut into equal parts (default 20 s). */
	readonly maxSeconds?: number;
	/** Padding added around each utterance, clamped to neighbours (default 0.15 s). */
	readonly paddingSeconds?: number;
}

/**
 * Groups speech regions into utterances (sentence-like units separated by pauses) for text-only ASR models.
 * Each utterance is transcribed on its own, and its range becomes the subtitle timing.
 */
export function planUtterances(speech: readonly ITimeRange[], duration: number, options: IUtterancePlanOptions = {}): ITimeRange[] {
	const pause = options.pauseSeconds ?? 0.6;
	const maxLen = options.maxSeconds ?? 20;
	const padding = options.paddingSeconds ?? 0.15;
	const groups: ITimeRange[][] = [];
	for (const r of speech) {
		const g = groups[groups.length - 1];
		if (g && r.start - g[g.length - 1].end < pause && r.end - g[0].start <= maxLen) {
			g.push(r);
		} else {
			groups.push([r]);
		}
	}
	// Split groups that are still too long (one long region) into equal parts.
	const ranges: ITimeRange[] = [];
	for (const g of groups) {
		const start = g[0].start;
		const end = g[g.length - 1].end;
		const len = end - start;
		if (len <= maxLen) {
			ranges.push({ start, end });
			continue;
		}
		const parts = Math.ceil(len / maxLen);
		for (let p = 0; p < parts; p++) {
			ranges.push({ start: start + len * p / parts, end: start + len * (p + 1) / parts });
		}
	}
	return ranges.map((r, i) => {
		const prevEnd = i > 0 ? ranges[i - 1].end : 0;
		const nextStart = i + 1 < ranges.length ? ranges[i + 1].start : duration;
		return {
			start: round3(Math.max(prevEnd, Math.max(0, r.start - padding))),
			end: round3(Math.min(nextStart, Math.min(duration, r.end + padding)))
		};
	});
}

/** Samples of `[range.start, range.end)` seconds. */
export function sliceSamples(samples: Float32Array, sampleRate: number, range: ITimeRange): Float32Array {
	const a = Math.max(0, Math.floor(range.start * sampleRate));
	const b = Math.min(samples.length, Math.ceil(range.end * sampleRate));
	return samples.subarray(a, Math.max(a, b));
}
