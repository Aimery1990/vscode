/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ISubtitleSegment } from './subtitles.js';

/**
 * Pure dictation logic (CI-45): dictation units (per subtitle segment or fixed N seconds),
 * word tokenisation / normalisation and a word-level diff between the reference and the user's answer.
 */

export type DictationUnitKind = 'segment' | 'seconds';

export interface IDictationUnit {
	/** Stable key for stored answers: `seg@12.34` or `s5@10.00` (kind + unit start in seconds). */
	readonly key: string;
	readonly start: number;
	readonly end: number;
	/** Text the user should type for this unit (may be empty for a silent window). */
	readonly reference: string;
}

/** One stored dictation answer (kept in the ticket's field data, keyed by {@link IDictationUnit.key}). */
export interface IDictationAnswer {
	readonly text: string;
	readonly correct: number;
	readonly total: number;
	/** 0..1 */
	readonly score: number;
	/** Epoch ms of the last submit. */
	readonly at: number;
}

export function dictationUnitKey(kind: DictationUnitKind, seconds: number, start: number): string {
	return `${kind === 'segment' ? 'seg' : `s${seconds}`}@${start.toFixed(2)}`;
}

/** Minimum length of a fixed-seconds unit. */
export const MIN_DICTATION_SECONDS = 1;

interface ITimedWord {
	readonly text: string;
	readonly mid: number;
}

/** Spreads a segment's words over its time span in proportion to their length (no word timestamps are available). */
export function estimateWordTimes(segment: ISubtitleSegment): ITimedWord[] {
	const words = segment.text.split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const weights = words.map(w => w.length + 1);
	const total = weights.reduce((a, b) => a + b, 0);
	const span = Math.max(0, segment.end - segment.start);
	const out: ITimedWord[] = [];
	let acc = 0;
	for (let i = 0; i < words.length; i++) {
		const mid = segment.start + span * (acc + weights[i] / 2) / total;
		out.push({ text: words[i], mid });
		acc += weights[i];
	}
	return out;
}

/**
 * Builds dictation units. `segment`: one unit per subtitle segment. `seconds`: consecutive windows of
 * `seconds` (at least 1 s) covering the whole media; the reference is the words whose estimated time falls in the window.
 */
export function buildDictationUnits(segments: readonly ISubtitleSegment[], kind: DictationUnitKind, seconds: number, duration: number): IDictationUnit[] {
	if (kind === 'segment') {
		return segments.map(s => ({ key: dictationUnitKey('segment', 0, s.start), start: s.start, end: s.end, reference: s.text }));
	}
	const step = Math.max(MIN_DICTATION_SECONDS, Math.round(Number.isFinite(seconds) ? seconds : MIN_DICTATION_SECONDS));
	const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;
	const total = Math.max(Number.isFinite(duration) ? duration : 0, lastEnd);
	if (total <= 0) {
		return [];
	}
	const words = segments.flatMap(estimateWordTimes);
	const units: IDictationUnit[] = [];
	let wi = 0;
	for (let start = 0; start < total - 0.01; start += step) {
		const end = Math.min(total, start + step);
		const ref: string[] = [];
		while (wi < words.length && words[wi].mid < end) {
			if (words[wi].mid >= start) {
				ref.push(words[wi].text);
			}
			wi++;
		}
		units.push({ key: dictationUnitKey('seconds', step, start), start, end, reference: ref.join(' ') });
	}
	return units;
}

/** Index of the unit containing `t` (the last one when past the end), or -1 when there are none. */
export function findUnitAt(units: readonly IDictationUnit[], t: number): number {
	if (units.length === 0) {
		return -1;
	}
	for (let i = 0; i < units.length; i++) {
		if (t < units[i].end) {
			return i;
		}
	}
	return units.length - 1;
}

const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** Lower-case, NFC, unify apostrophes / dashes, strip punctuation at the word edges. Accents are kept (they matter in French). */
export function normalizeWord(word: string): string {
	return word.normalize('NFC').toLowerCase().replace(/[\u2018\u2019\u02BC`]/g, '\'').replace(/[\u2010-\u2015]/g, '-').replace(EDGE_PUNCT, '');
}

/** Splits text into words for comparison; tokens that are only punctuation are dropped. */
export function tokenizeWords(text: string): string[] {
	return text.split(/\s+/).filter(w => normalizeWord(w).length > 0);
}

export type WordDiffKind = 'correct' | 'wrong' | 'missing' | 'extra';

export interface IWordDiffOp {
	readonly kind: WordDiffKind;
	/** Reference word (correct / wrong / missing). */
	readonly expected?: string;
	/** User's word (correct / wrong / extra). */
	readonly actual?: string;
}

export interface IWordDiffResult {
	readonly ops: IWordDiffOp[];
	readonly correct: number;
	/** Number of reference words. */
	readonly total: number;
	/** correct / total, or 1 when both are empty. */
	readonly score: number;
}

/**
 * Word-level diff (LCS on normalised words). Between two matches, missing reference words and extra
 * typed words are paired up as `wrong`; the rest stay `missing` / `extra`.
 */
export function diffWords(reference: string, answer: string): IWordDiffResult {
	const ref = tokenizeWords(reference);
	const ans = tokenizeWords(answer);
	const a = ref.map(normalizeWord);
	const b = ans.map(normalizeWord);
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const ops: IWordDiffOp[] = [];
	let pendingMissing: string[] = [];
	let pendingExtra: string[] = [];
	const flush = () => {
		const pairs = Math.min(pendingMissing.length, pendingExtra.length);
		for (let k = 0; k < pairs; k++) {
			ops.push({ kind: 'wrong', expected: pendingMissing[k], actual: pendingExtra[k] });
		}
		for (let k = pairs; k < pendingMissing.length; k++) {
			ops.push({ kind: 'missing', expected: pendingMissing[k] });
		}
		for (let k = pairs; k < pendingExtra.length; k++) {
			ops.push({ kind: 'extra', actual: pendingExtra[k] });
		}
		pendingMissing = [];
		pendingExtra = [];
	};
	let i = 0;
	let j = 0;
	let correct = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			flush();
			ops.push({ kind: 'correct', expected: ref[i], actual: ans[j] });
			correct++;
			i++;
			j++;
		} else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
			pendingExtra.push(ans[j]);
			j++;
		} else {
			pendingMissing.push(ref[i]);
			i++;
		}
	}
	flush();
	return { ops, correct, total: n, score: n === 0 ? (m === 0 ? 1 : 0) : correct / n };
}
