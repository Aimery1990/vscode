/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { normalizeTicketLabels } from './ticketLabels.js';
import { isLongTicketText } from './ticketFieldStore.js';

/*
 * Ticket field change log (CI-50): pure logic.
 *
 * Every write of a ticket's field files (`.agents/ticket.md`, `README.md`, `instruction.md`) is diffed field by field
 * (old persisted value vs new value). Each changed field becomes a structured change record, written into the ticket's
 * work log (`Worklogs/*.log`) as a human readable summary plus a machine readable JSON block. The IO side lives in
 * `browser/ticketChangeRecorder.ts`; everything here is side effect free. Full versions of large values are stored per
 * field (see `ticketFieldStore.ts`).
 */

// ------------------------------------------------------------------------------------------------
// Policy constants
// ------------------------------------------------------------------------------------------------

// Values up to LONG_TEXT_MIN_BYTES UTF-8 bytes on both sides (`ticketFieldStore.ts`, shared with the CI-51 field
// externalization) are recorded inline, old → new; a longer side makes the change "long" (stats, diff, versions).
/** A large value's line diff is cut after this many lines ... */
export const TICKET_CHANGE_DIFF_MAX_LINES = 40;
/** ... or this many bytes (UTF-16 chars, close enough), whichever comes first. */
export const TICKET_CHANGE_DIFF_MAX_BYTES = 4096;
/** Preview length of a large value that has no counterpart (empty → 10k words). */
export const TICKET_CHANGE_PREVIEW_CHARS = 300;
/** Consecutive saves by the same actor within this window (since the entry's last change) update the same log entry. */
export const TICKET_CHANGE_COALESCE_WINDOW_MS = 5 * 60 * 1000;
/** A coalesced log entry is never extended beyond this age (since its first change). */
export const TICKET_CHANGE_COALESCE_MAX_AGE_MS = 30 * 60 * 1000;
/** A `data:...;base64,` payload at least this long is treated as media: never inlined, only type / size / hash logged. */
export const TICKET_CHANGE_MEDIA_MIN_PAYLOAD_CHARS = 256;
/** Item level details listed for a dynamic list / table change. */
export const TICKET_CHANGE_LIST_MAX_DETAILS = 10;
/** Lines longer than this are split (sentences, then word wrapped) before the line diff. */
export const TICKET_CHANGE_DIFF_WRAP_CHARS = 160;

/** `entry_kind` front matter value of an automatically recorded field change entry. */
export const TICKET_CHANGE_ENTRY_KIND = 'field_changes';
/** Heading of the machine readable block in a change entry. */
export const TICKET_CHANGE_RECORDS_HEADING = '### Change Records';

// ------------------------------------------------------------------------------------------------
// Actors
// ------------------------------------------------------------------------------------------------

/** `System` is the app itself, e.g. `System (detected)` for attachment changes found when a ticket is opened. */
export type TicketChangeActorKind = 'User' | 'AI Agent' | 'Workflow' | 'System';

/** Who changed a ticket: the kind (written as `update_by`) and, when known, the agent / workflow name. */
export interface ITicketChangeActor {
	readonly kind: TicketChangeActorKind;
	readonly name?: string;
}

export type TicketChangeActorInput = ITicketChangeActor | TicketChangeActorKind | undefined;

export function toTicketChangeActor(input: TicketChangeActorInput, fallback: TicketChangeActorKind = 'User'): ITicketChangeActor {
	if (!input) {
		return { kind: fallback };
	}
	if (typeof input === 'string') {
		return { kind: input };
	}
	const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
	return name ? { kind: input.kind, name } : { kind: input.kind };
}

/** `User`, `AI Agent (Coder)`, `Workflow (Daily Report)`. */
export function formatTicketChangeActor(actor: ITicketChangeActor): string {
	return actor.name ? `${actor.kind} (${actor.name})` : actor.kind;
}

export function sameTicketChangeActor(a: ITicketChangeActor, b: ITicketChangeActor): boolean {
	return a.kind === b.kind && (a.name || '') === (b.name || '');
}

// ------------------------------------------------------------------------------------------------
// Field extraction
// ------------------------------------------------------------------------------------------------

export type TicketFieldSource = 'README.md' | 'ticket.md' | 'instruction.md';

export interface ITicketFieldValue {
	/** Stable id: `title`, `status`, ... or `custom:<key>` for template / Freestyle values. */
	readonly id: string;
	readonly label: string;
	readonly source: TicketFieldSource;
	readonly value: string;
}

/** Standard fields of ticket.md (top level `- **Key**: value` lines). */
const TICKET_MD_STANDARD_FIELDS: ReadonlyMap<string, string> = new Map([
	['Status', 'status'],
	['Priority', 'priority'],
	['Labels', 'labels'],
	['Current AI Agent', 'current_ai_agent'],
	['Link To', 'link_to'],
	['Depends On', 'depends_on'],
	['Update Status From Dependencies', 'update_status_from_dependencies'],
	['Independent from Parent', 'independent_from_parent'],
]);

export const CUSTOM_FIELD_ID_PREFIX = 'custom:';

/** Which tracked file a file name is (case-insensitive), or undefined for any other file. */
export function ticketFieldSourceOf(fileName: string): TicketFieldSource | undefined {
	switch ((fileName || '').toLowerCase()) {
		case 'ticket.md': return 'ticket.md';
		case 'readme.md': return 'README.md';
		case 'instruction.md': return 'instruction.md';
		default: return undefined;
	}
}

const KEY_LINE_RE = /^-\s*\*\*([^*]+)\*\*:\s?(.*)$/;
const CUSTOM_KEY_LINE_RE = /^ {1,3}-\s*\*\*([^*]+)\*\*:\s?(.*)$/;
const ANY_KEY_LINE_RE = /^\s*-\s*\*\*[^*]+\*\*:/;

function isSectionBreak(line: string): boolean {
	return /^#{1,6}\s/.test(line) || line.startsWith('---');
}

/**
 * Where a field value sits in its file: the key line `startLine` (its text up to the value is `prefix`) plus its
 * continuation lines, up to `endLine` (exclusive; trailing blank lines are not part of the span). Replacing lines
 * `[startLine, endLine)` by `prefix + value lines` rewrites exactly this value (see CI-51 field externalization).
 */
export interface ITicketFieldSpan extends ITicketFieldValue {
	readonly startLine: number;
	readonly endLine: number;
	readonly prefix: string;
}

function lastContentLine(lines: readonly string[], start: number, end: number): number {
	let last = start;
	for (let k = start + 1; k < end; k++) {
		if (lines[k].trim() !== '') {
			last = k;
		}
	}
	return last + 1;
}

/**
 * The span of a top level `- **Key**: value` line plus its continuation lines (lines up to the next key line,
 * heading or `---`), as a multi-line description / prompt is stored.
 */
function readBlockSpan(lines: readonly string[], key: string): { value: string; startLine: number; endLine: number; prefix: string } | undefined {
	const re = new RegExp(`^\\s*-\\s*\\*\\*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:\\s?(.*)$`, 'i');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (!m) {
			continue;
		}
		const parts = [m[1]];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const next = lines[j];
			if (ANY_KEY_LINE_RE.test(next) || isSectionBreak(next)) {
				break;
			}
			parts.push(next);
		}
		return { value: parts.join('\n').trim(), startLine: i, endLine: lastContentLine(lines, i, j), prefix: lines[i].slice(0, lines[i].length - m[1].length) };
	}
	return undefined;
}

/** The tracked field values of one ticket file, with their location in the file (lines split by `\r?\n`). */
export function locateTicketFieldSpans(source: TicketFieldSource, content: string): ITicketFieldSpan[] {
	const lines = (content || '').split(/\r?\n/);
	const spans: ITicketFieldSpan[] = [];
	const block = (id: string, label: string) => {
		const b = readBlockSpan(lines, label);
		if (b) {
			spans.push({ id, label, source, ...b });
		}
	};

	if (source === 'README.md') {
		block('title', 'Title');
		block('description', 'Description');
		return spans;
	}

	if (source === 'instruction.md') {
		block('ticket_prompt', 'Ticket Prompt');
		return spans;
	}

	// ticket.md
	const seen = new Set<string>();
	let inSelfDefined = false;
	let current: { key: string; startLine: number; prefix: string; parts: string[]; last: number } | undefined;
	const custom = new Map<string, ITicketFieldSpan>();
	const finish = () => {
		if (current) {
			const key = current.key;
			custom.set(key, {
				id: CUSTOM_FIELD_ID_PREFIX + key, label: key, source, value: current.parts.join('\n').trim(),
				startLine: current.startLine, endLine: current.last + 1, prefix: current.prefix
			});
			current = undefined;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^###\s+Self Defined Data/.test(line)) {
			finish();
			inSelfDefined = true;
			continue;
		}
		if (isSectionBreak(line)) {
			finish();
			inSelfDefined = false;
			continue;
		}
		if (inSelfDefined) {
			const cm = line.match(CUSTOM_KEY_LINE_RE);
			if (cm) {
				finish();
				current = { key: cm[1].trim(), startLine: i, prefix: line.slice(0, line.length - cm[2].length), parts: [cm[2]], last: i };
				continue;
			}
			const top = line.match(KEY_LINE_RE);
			if (top) {
				const key = top[1].trim();
				finish();
				if (key === 'Self Defined Data Structure' || key === 'Self Defined Data Value') {
					continue;
				}
				// A top level key ends the Self Defined Data section (e.g. `- **Current AI Agent**:`).
				inSelfDefined = false;
			} else {
				if (current) {
					current.parts.push(line);
					if (line.trim() !== '') {
						current.last = i;
					}
				}
				continue;
			}
		}
		const m = line.match(KEY_LINE_RE);
		if (m) {
			const label = m[1].trim();
			const id = TICKET_MD_STANDARD_FIELDS.get(label);
			if (id && !seen.has(id)) {
				seen.add(id);
				spans.push({ id, label, source, value: m[2].trim(), startLine: i, endLine: i + 1, prefix: line.slice(0, line.length - m[2].length) });
			}
		}
	}
	finish();
	spans.push(...custom.values());
	return spans;
}

/** The tracked field values of one ticket file. */
export function extractTicketFields(source: TicketFieldSource, content: string): Map<string, ITicketFieldValue> {
	const result = new Map<string, ITicketFieldValue>();
	for (const s of locateTicketFieldSpans(source, content)) {
		result.set(s.id, { id: s.id, label: s.label, source: s.source, value: s.value });
	}
	return result;
}

/**
 * Replaces field values in a ticket file: `replace(span)` returns the new value text (may be multi-line) or undefined
 * to keep the span. Returns the content unchanged (same string) when nothing was replaced.
 */
export function replaceTicketFieldValues(source: TicketFieldSource, content: string, replace: (span: ITicketFieldSpan) => string | undefined): string {
	const spans = locateTicketFieldSpans(source, content);
	const edits: { span: ITicketFieldSpan; value: string }[] = [];
	for (const span of spans) {
		const value = replace(span);
		if (value !== undefined) {
			edits.push({ span, value });
		}
	}
	if (edits.length === 0) {
		return content;
	}
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	edits.sort((a, b) => b.span.startLine - a.span.startLine);
	for (const { span, value } of edits) {
		const valueLines = value.split(/\r?\n/);
		valueLines[0] = span.prefix + valueLines[0];
		lines.splice(span.startLine, span.endLine - span.startLine, ...valueLines);
	}
	return lines.join(eol);
}

// ------------------------------------------------------------------------------------------------
// Normalization
// ------------------------------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	const t = text.trim();
	if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) {
		return { ok: false };
	}
	try {
		return { ok: true, value: JSON.parse(t) };
	} catch {
		return { ok: false };
	}
}

/** Pure UI state that a component saves on its own inside its JSON field value. */
export interface ITicketUiStateRule {
	readonly component: string;
	/** A JSON object value belongs to the component when it has all of these keys (its save always writes them). */
	readonly signature: readonly string[];
	/** Top level keys holding pure UI state. */
	readonly keys: readonly string[];
	/** `{ mapKey: keys }`: keys to drop from every entry of the object map stored under `mapKey`. */
	readonly entryKeys?: Readonly<Record<string, readonly string[]>>;
}

/**
 * UI state keys that a component saves quietly with its value but that are not a change of the ticket (CI-50
 * follow-up): playback speed menus, the subtitle display mode toggle (single / scroll / dictation view), the TTS
 * "Show AI Section" expand state and the time stamp of a dictation check. They are still saved; they are only left out
 * of the field change log. Everything the user enters (media file, subtitles file, dictation settings and answers, TTS
 * text / voice / model / format / audio, voice clips) stays logged.
 */
export const TICKET_UI_STATE_RULES: readonly ITicketUiStateRule[] = [
	{ component: 'media_player', signature: ['mediaFilePath', 'mediaKind'], keys: ['mediaPlaybackRate', 'subtitleDisplayMode'], entryKeys: { dictation: ['at'] } },
	{ component: 'tts', signature: ['ttsFormat', 'ttsVoice'], keys: ['ttsPlaybackRate', 'ttsShowSpeechTextInTicket'] },
	{ component: 'voice_note', signature: ['voiceClips'], keys: ['voicePlaybackRate'] },
];

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The value without the UI state keys of {@link TICKET_UI_STATE_RULES}; `undefined` when nothing was dropped. */
function withoutUiState(value: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}
	let out: Record<string, unknown> | undefined;
	for (const rule of TICKET_UI_STATE_RULES) {
		if (!rule.signature.every(k => hasOwn(value, k))) {
			continue;
		}
		for (const k of rule.keys) {
			if (hasOwn(value, k)) {
				out ??= { ...value };
				delete out[k];
			}
		}
		for (const [mapKey, drop] of Object.entries(rule.entryKeys ?? {})) {
			const map = value[mapKey];
			if (!isPlainObject(map)) {
				continue;
			}
			let changed = false;
			const entries: Record<string, unknown> = {};
			for (const [key, entry] of Object.entries(map)) {
				if (isPlainObject(entry) && drop.some(d => hasOwn(entry, d))) {
					const copy = { ...entry };
					for (const d of drop) {
						delete copy[d];
					}
					entries[key] = copy;
					changed = true;
				} else {
					entries[key] = entry;
				}
			}
			if (changed) {
				out ??= { ...value };
				out[mapKey] = entries;
			}
		}
	}
	return out;
}

/**
 * A field value as the change log sees it: a component JSON value without its pure UI state keys (see
 * {@link TICKET_UI_STATE_RULES}). Any other value is returned unchanged.
 */
export function stripTicketUiState(value: string): string {
	const json = tryParseJson(value);
	if (!json.ok) {
		return value;
	}
	const stripped = withoutUiState(json.value);
	return stripped ? JSON.stringify(stripped) : value;
}

/**
 * The comparison form of a field value: re-serialization noise (line endings, whitespace runs, surrounding quotes,
 * `None` placeholders, JSON formatting, label / link list spacing) and pure UI state ({@link TICKET_UI_STATE_RULES})
 * must not count as a change.
 */
export function normalizeTicketFieldValue(fieldId: string, value: string | undefined): string {
	let v = (value ?? '').replace(/\r\n?/g, '\n').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
	if (v === 'None' || v === 'none') {
		v = '';
	}
	if (fieldId === 'labels') {
		return normalizeTicketLabels(v.split(',')).join(', ');
	}
	if (fieldId === 'link_to') {
		return v.split(',').map(s => s.trim()).filter(Boolean).join(', ');
	}
	const json = tryParseJson(v);
	if (json.ok) {
		return canonicalJson(withoutUiState(json.value) ?? json.value);
	}
	return v.replace(/\s+/g, ' ');
}

export function ticketFieldValuesEqual(fieldId: string, a: string | undefined, b: string | undefined): boolean {
	return normalizeTicketFieldValue(fieldId, a) === normalizeTicketFieldValue(fieldId, b);
}

/** A raw (not yet planned) field change. */
export interface ITicketFieldChange {
	readonly field: string;
	readonly label: string;
	readonly source: TicketFieldSource;
	readonly oldValue: string;
	readonly newValue: string;
}

/**
 * The changed fields between two versions of one tracked file. A field missing on one side counts as empty. Values are
 * compared and recorded without their pure UI state ({@link stripTicketUiState}): a save that only moves such state
 * yields no change, one that also changes real data records only the real data.
 */
export function diffTicketFieldMaps(oldFields: ReadonlyMap<string, ITicketFieldValue>, newFields: ReadonlyMap<string, ITicketFieldValue>): ITicketFieldChange[] {
	const changes: ITicketFieldChange[] = [];
	const ids: string[] = [...oldFields.keys()];
	for (const id of newFields.keys()) {
		if (!oldFields.has(id)) {
			ids.push(id);
		}
	}
	for (const id of ids) {
		const o = oldFields.get(id);
		const n = newFields.get(id);
		const oldValue = stripTicketUiState(o?.value ?? '');
		const newValue = stripTicketUiState(n?.value ?? '');
		if (ticketFieldValuesEqual(id, oldValue, newValue)) {
			continue;
		}
		changes.push({ field: id, label: (n ?? o)!.label, source: (n ?? o)!.source, oldValue, newValue });
	}
	return changes;
}

// ------------------------------------------------------------------------------------------------
// Media
// ------------------------------------------------------------------------------------------------

export interface ITicketMediaRef {
	readonly mime: string;
	readonly bytes: number;
	/** SHA-1 of the base64 payload (fingerprint only; media is not stored again). */
	readonly sha1: string;
}

const DATA_URL_RE = /data:([a-z0-9.+\/-]+)((?:;[a-z0-9.+=-]+)*);base64,([A-Za-z0-9+/=]+)/gi;

/** Replaces embedded media (`data:<mime>;base64,...` above the size threshold) by a short placeholder. */
export function sanitizeTicketMedia(text: string): { text: string; media: ITicketMediaRef[] } {
	const media: ITicketMediaRef[] = [];
	const out = (text || '').replace(DATA_URL_RE, (whole: string, mime: string, _params: string, payload: string) => {
		if (payload.length < TICKET_CHANGE_MEDIA_MIN_PAYLOAD_CHARS) {
			return whole;
		}
		const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
		const bytes = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
		const sha = new StringSHA1();
		sha.update(payload);
		const ref: ITicketMediaRef = { mime: mime.toLowerCase(), bytes, sha1: sha.digest() };
		media.push(ref);
		return `[media ${ref.mime}, ${ref.bytes} bytes, sha1:${ref.sha1.slice(0, 12)}]`;
	});
	return { text: out, media };
}

// ------------------------------------------------------------------------------------------------
// Text stats and line diff
// ------------------------------------------------------------------------------------------------

export interface ITicketTextStats {
	readonly chars: number;
	readonly words: number;
	readonly lines: number;
}

export function ticketTextStats(text: string): ITicketTextStats {
	const t = text || '';
	if (!t) {
		return { chars: 0, words: 0, lines: 0 };
	}
	// CJK characters count as one word each; other words are whitespace separated.
	const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
	const latin = t.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, ' ').split(/\s+/).filter(Boolean).length;
	return { chars: t.length, words: cjk + latin, lines: t.split('\n').length };
}

function wrapLongLine(line: string, max: number): string[] {
	if (line.length <= max) {
		return [line];
	}
	const sentences = line.split(/(?<=[.!?;])\s+|(?<=[\u3002\uff01\uff1f\uff1b])/).filter(s => s.length > 0);
	const out: string[] = [];
	for (const sentence of sentences) {
		let rest = sentence;
		while (rest.length > max) {
			let cut = rest.lastIndexOf(' ', max);
			if (cut < max / 2) {
				cut = max;
			}
			out.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\s+/, '');
		}
		if (rest) {
			out.push(rest);
		}
	}
	return out;
}

function flattenJsonLines(value: unknown, path: string, out: string[]): void {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.push(`${path || '$'}: []`);
		}
		value.forEach((v, i) => flattenJsonLines(v, `${path}[${i}]`, out));
		return;
	}
	if (value && typeof value === 'object') {
		const keys = Object.keys(value);
		if (keys.length === 0) {
			out.push(`${path || '$'}: {}`);
		}
		for (const k of keys) {
			flattenJsonLines((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
		}
		return;
	}
	if (typeof value === 'string' && value.includes('\n')) {
		out.push(`${path || '$'}:`);
		for (const l of value.split('\n')) {
			out.push(`  ${l}`);
		}
		return;
	}
	out.push(`${path || '$'}: ${JSON.stringify(value)}`);
}

/** The lines a value is diffed by: JSON is flattened to `path: value` lines, long lines are split. */
export function toTicketDiffLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const json = tryParseJson(text);
	let lines: string[];
	if (json.ok) {
		lines = [];
		flattenJsonLines(json.value, '', lines);
	} else {
		lines = text.replace(/\r\n?/g, '\n').split('\n');
	}
	const out: string[] = [];
	for (const l of lines) {
		out.push(...wrapLongLine(l, TICKET_CHANGE_DIFF_WRAP_CHARS));
	}
	return out;
}

export interface ITicketLineDiff {
	readonly text: string;
	readonly truncated: boolean;
	readonly added: number;
	readonly removed: number;
}

/** A unified style line diff (`@@ -a,b +c,d @@`, `- ` / `+ ` lines), cut at the line / byte caps. */
export function computeTicketLineDiff(oldText: string, newText: string, maxLines = TICKET_CHANGE_DIFF_MAX_LINES, maxBytes = TICKET_CHANGE_DIFF_MAX_BYTES): ITicketLineDiff {
	const a = toTicketDiffLines(oldText);
	const b = toTicketDiffLines(newText);
	const changes = new LcsDiff({ getElements: () => a }, { getElements: () => b }).ComputeDiff(false).changes;
	const all: string[] = [];
	let added = 0;
	let removed = 0;
	for (const c of changes) {
		all.push(`@@ -${c.originalStart + 1},${c.originalLength} +${c.modifiedStart + 1},${c.modifiedLength} @@`);
		for (let i = 0; i < c.originalLength; i++) {
			all.push(`- ${a[c.originalStart + i]}`);
		}
		for (let i = 0; i < c.modifiedLength; i++) {
			all.push(`+ ${b[c.modifiedStart + i]}`);
		}
		added += c.modifiedLength;
		removed += c.originalLength;
	}
	const kept: string[] = [];
	let bytes = 0;
	for (const line of all) {
		if (kept.length >= maxLines || bytes + line.length + 1 > maxBytes) {
			break;
		}
		kept.push(line);
		bytes += line.length + 1;
	}
	const truncated = kept.length < all.length;
	if (truncated) {
		kept.push(`… truncated (${all.length - kept.length} more diff lines; full texts in the field versions)`);
	}
	return { text: kept.join('\n'), truncated, added, removed };
}

// ------------------------------------------------------------------------------------------------
// Dynamic lists / tables
// ------------------------------------------------------------------------------------------------

export interface ITicketListChangeSummary {
	readonly added: number;
	readonly removed: number;
	readonly changed: number;
	readonly details: string[];
}

function shortValue(v: unknown, max = 60): string {
	const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? 'null');
	const one = s.replace(/\s+/g, ' ');
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function itemIdentity(item: unknown): string | undefined {
	if (item && typeof item === 'object' && !Array.isArray(item)) {
		const o = item as Record<string, unknown>;
		for (const k of ['id', 'key', 'name', 'title']) {
			if (typeof o[k] === 'string' && (o[k] as string).trim()) {
				return (o[k] as string).trim();
			}
			if (typeof o[k] === 'number') {
				return String(o[k]);
			}
		}
		return undefined;
	}
	if (typeof item === 'string' || typeof item === 'number') {
		return String(item);
	}
	return undefined;
}

function describeItemChange(label: string, before: unknown, after: unknown): string {
	if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
		const b = before as Record<string, unknown>;
		const a = after as Record<string, unknown>;
		const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(k => canonicalJson(b[k]) !== canonicalJson(a[k]));
		const shown = keys.slice(0, 3).map(k => `${k}: ${shortValue(b[k] ?? '')} → ${shortValue(a[k] ?? '')}`);
		return `~ ${label}: ${shown.join('; ')}${keys.length > 3 ? `; … ${keys.length - 3} more` : ''}`;
	}
	return `~ ${label}: ${shortValue(before)} → ${shortValue(after)}`;
}

/** The item array of a list value: a JSON array, or the `rows` of a table object. */
function listItemsOf(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows)) {
		return (value as { rows: unknown[] }).rows;
	}
	return undefined;
}

/** Item level add / remove / change of two list values, or undefined when they are not both lists. */
export function summarizeTicketListChange(oldText: string, newText: string): ITicketListChangeSummary | undefined {
	const oldJson = oldText.trim() ? tryParseJson(oldText) : { ok: true as const, value: [] as unknown[] };
	const newJson = newText.trim() ? tryParseJson(newText) : { ok: true as const, value: [] as unknown[] };
	if (!oldJson.ok || !newJson.ok) {
		return undefined;
	}
	const before = listItemsOf(oldJson.value);
	const after = listItemsOf(newJson.value);
	if (!before || !after) {
		return undefined;
	}
	const details: string[] = [];
	let added = 0;
	let removed = 0;
	let changed = 0;

	const tableCols = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)) ? canonicalJson((v as { columns?: unknown }).columns ?? null) : '';
	if (tableCols(oldJson.value) !== tableCols(newJson.value)) {
		details.push('~ columns changed');
	}

	const beforeIds = before.map(itemIdentity);
	const afterIds = after.map(itemIdentity);
	const unique = (ids: (string | undefined)[]) => ids.every(id => id !== undefined) && new Set(ids).size === ids.length;
	if (unique(beforeIds) && unique(afterIds)) {
		const beforeMap = new Map(before.map((item, i) => [beforeIds[i]!, item]));
		const afterMap = new Map(after.map((item, i) => [afterIds[i]!, item]));
		for (const [id, item] of afterMap) {
			if (!beforeMap.has(id)) {
				added++;
				details.push(`+ ${shortValue(id)}`);
			} else if (canonicalJson(beforeMap.get(id)) !== canonicalJson(item)) {
				changed++;
				details.push(describeItemChange(shortValue(id), beforeMap.get(id), item));
			}
		}
		for (const id of beforeMap.keys()) {
			if (!afterMap.has(id)) {
				removed++;
				details.push(`- ${shortValue(id)}`);
			}
		}
	} else {
		const n = Math.max(before.length, after.length);
		for (let i = 0; i < n; i++) {
			if (i >= before.length) {
				added++;
				details.push(`+ #${i + 1}: ${shortValue(after[i])}`);
			} else if (i >= after.length) {
				removed++;
				details.push(`- #${i + 1}: ${shortValue(before[i])}`);
			} else if (canonicalJson(before[i]) !== canonicalJson(after[i])) {
				changed++;
				details.push(describeItemChange(`#${i + 1}`, before[i], after[i]));
			}
		}
	}
	const shown = details.slice(0, TICKET_CHANGE_LIST_MAX_DETAILS);
	if (details.length > shown.length) {
		shown.push(`… ${details.length - shown.length} more`);
	}
	return { added, removed, changed, details: shown };
}

// ------------------------------------------------------------------------------------------------
// Change records
// ------------------------------------------------------------------------------------------------

export type TicketChangeKind = 'inline' | 'diff' | 'blob' | 'binary' | 'list' | 'attachments';

/** One file of an `attachments` record: added / removed / content changed (see `ticketAttachmentIntegrity.ts`). */
export interface ITicketAttachmentChangeItem {
	readonly op: 'added' | 'removed' | 'changed';
	readonly name: string;
	/** SHA-256 (lowercase hex) of the current (removed: last recorded) content; empty when too large to hash. */
	readonly sha256: string;
	readonly size: number;
	/** changed: the previously recorded hash / size. */
	readonly oldSha256?: string;
	readonly oldSize?: number;
	/** changed: found when the ticket was opened / run, i.e. changed outside the app. */
	readonly detected?: boolean;
}

/** One field change as written into the machine readable block of a change entry. */
export interface ITicketChangeRecord {
	field: string;
	label: string;
	source: TicketFieldSource;
	actor: TicketChangeActorKind;
	actorName?: string;
	/** ISO time of the (latest) change. */
	at: string;
	kind: TicketChangeKind;
	/** inline / small list: the full value. diff / blob / binary: a preview (or omitted). */
	old?: string;
	new?: string;
	/** SHA-256 of the full old / new text ... */
	oldHash?: string;
	newHash?: string;
	/** ... stored as `.agents/fields/<field_key>.versions/<YYYYMMDD-HHMMSS>_<sha12>.txt.gz` (relative to the ticket folder). */
	oldPath?: string;
	newPath?: string;
	stats?: { old: ITicketTextStats; new: ITicketTextStats };
	diff?: string;
	diffTruncated?: boolean;
	linesAdded?: number;
	linesRemoved?: number;
	items?: ITicketListChangeSummary;
	media?: { old: ITicketMediaRef[]; new: ITicketMediaRef[] };
	attachments?: ITicketAttachmentChangeItem[];
}

export interface IPlannedTicketChange {
	readonly record: ITicketChangeRecord;
	/** Full texts to store as field versions (then set `oldHash` / `oldPath`, `newHash` / `newPath`). */
	readonly blobs: { old?: string; new?: string };
}

function preview(text: string, max = TICKET_CHANGE_PREVIEW_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Applies the inline / diff / blob / binary / list policy to one field change. */
export function planTicketFieldChange(change: ITicketFieldChange, actor: ITicketChangeActor, at: Date): IPlannedTicketChange {
	const o = sanitizeTicketMedia(change.oldValue);
	const n = sanitizeTicketMedia(change.newValue);
	const record: ITicketChangeRecord = {
		field: change.field,
		label: change.label,
		source: change.source,
		actor: actor.kind,
		...(actor.name ? { actorName: actor.name } : {}),
		at: at.toISOString(),
		kind: 'inline'
	};

	if (o.media.length > 0 || n.media.length > 0) {
		record.kind = 'binary';
		record.media = { old: o.media, new: n.media };
		record.old = preview(o.text);
		record.new = preview(n.text);
		return { record, blobs: {} };
	}

	const isLarge = isLongTicketText(o.text) || isLongTicketText(n.text);
	const list = summarizeTicketListChange(o.text, n.text);
	if (list) {
		record.kind = 'list';
		record.items = list;
		if (!isLarge) {
			record.old = o.text;
			record.new = n.text;
			return { record, blobs: {} };
		}
		record.stats = { old: ticketTextStats(o.text), new: ticketTextStats(n.text) };
		return { record, blobs: { old: o.text || undefined, new: n.text || undefined } };
	}

	if (!isLarge) {
		record.old = o.text;
		record.new = n.text;
		return { record, blobs: {} };
	}

	const oldEmpty = normalizeTicketFieldValue(change.field, o.text) === '';
	const newEmpty = normalizeTicketFieldValue(change.field, n.text) === '';
	record.stats = { old: ticketTextStats(oldEmpty ? '' : o.text), new: ticketTextStats(newEmpty ? '' : n.text) };
	if (oldEmpty || newEmpty) {
		record.kind = 'blob';
		record.old = oldEmpty ? '' : preview(o.text);
		record.new = newEmpty ? '' : preview(n.text);
		return { record, blobs: { old: oldEmpty ? undefined : o.text, new: newEmpty ? undefined : n.text } };
	}

	record.kind = 'diff';
	const diff = computeTicketLineDiff(o.text, n.text);
	record.diff = diff.text;
	record.diffTruncated = diff.truncated;
	record.linesAdded = diff.added;
	record.linesRemoved = diff.removed;
	return { record, blobs: { old: o.text, new: n.text } };
}

// ------------------------------------------------------------------------------------------------
// Rendering / parsing of a change entry
// ------------------------------------------------------------------------------------------------

function inlineValue(v: string | undefined): string {
	if (!v) {
		return '(empty)';
	}
	const one = v.replace(/\r?\n/g, ' ⏎ ');
	const ticks = one.match(/`+/g)?.reduce((m, t) => Math.max(m, t.length), 0) ?? 0;
	const fence = '`'.repeat(ticks + 1);
	const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${one}${pad}${fence}`;
}

function fmtCount(n: number): string {
	return n.toLocaleString('en-US');
}

/** A version file reference for the human readable line: `` `.agents/fields/description.versions/2026...gz` ``. */
function versionRef(path: string | undefined): string {
	return path ? `\`${path}\`` : '(not stored)';
}

/** One human readable line per record, e.g. ``- **Status**: `Todo` → `Done` ``. */
export function describeTicketChangeRecord(r: ITicketChangeRecord): string {
	const head = `- **${r.label}**:`;
	switch (r.kind) {
		case 'inline':
			return `${head} ${inlineValue(r.old)} → ${inlineValue(r.new)}`;
		case 'list': {
			const it = r.items!;
			const counts = `+${it.added} added, -${it.removed} removed, ~${it.changed} changed`;
			const values = r.oldPath || r.newPath
				? ` (full values: ${[r.oldPath && `old ${versionRef(r.oldPath)}`, r.newPath && `new ${versionRef(r.newPath)}`].filter(Boolean).join(', ')})`
				: '';
			const details = it.details.map(d => `\n  - ${inlineValue(d)}`).join('');
			return `${head} ${counts}${values}${details}`;
		}
		case 'binary': {
			const media = (refs: ITicketMediaRef[]) => refs.length ? refs.map(m => `${m.mime} ${fmtCount(m.bytes)} bytes (sha1:${m.sha1.slice(0, 12)})`).join(' + ') : '(no media)';
			return `${head} media ${media(r.media!.old)} → ${media(r.media!.new)}`;
		}
		case 'blob': {
			const s = r.stats!;
			const fromEmpty = !r.oldPath;
			const words = `${fmtCount(s.old.words)} → ${fmtCount(s.new.words)} words, ${fmtCount(s.old.chars)} → ${fmtCount(s.new.chars)} chars`;
			const hash = fromEmpty ? `new ${versionRef(r.newPath)}` : `old ${versionRef(r.oldPath)}`;
			const pv = fromEmpty ? r.new : r.old;
			return `${head} ${fromEmpty ? '(empty) → text' : 'text → (empty)'}; ${words}; full text ${hash}\n  - preview: ${inlineValue(pv)}`;
		}
		case 'attachments':
			return `${head} ${attachmentCounts(r.attachments ?? [])}${(r.attachments ?? []).map(a => `\n  - ${describeTicketAttachmentChange(a)}`).join('')}`;
		case 'diff': {
			const s = r.stats!;
			return `${head} ${fmtCount(s.old.words)} → ${fmtCount(s.new.words)} words, ${fmtCount(s.old.chars)} → ${fmtCount(s.new.chars)} chars, ${fmtCount(s.old.lines)} → ${fmtCount(s.new.lines)} lines; +${r.linesAdded ?? 0} / -${r.linesRemoved ?? 0} diff lines${r.diffTruncated ? ' (diff truncated)' : ''}; full texts old ${versionRef(r.oldPath)}, new ${versionRef(r.newPath)}`;
		}
	}
}

function shaRef(sha: string | undefined): string {
	return sha ? `sha256:${sha}` : 'sha256: not hashed (file too large)';
}

/** `+ resume.pdf (sha256:…, 182,331 bytes)`, `- old.docx (sha256:…, 1,024 bytes)`, `~ resume.pdf content changed: …`. */
export function describeTicketAttachmentChange(a: ITicketAttachmentChangeItem): string {
	const name = inlineValue(a.name);
	switch (a.op) {
		case 'added':
			return `+ ${name} (${shaRef(a.sha256)}, ${fmtCount(a.size)} bytes)`;
		case 'removed':
			return `- ${name} (${shaRef(a.sha256)}, ${fmtCount(a.size)} bytes)`;
		case 'changed':
			return `~ ${name} content changed${a.detected ? ' outside the app' : ''}: sha256 ${a.oldSha256 || '(not hashed)'} → ${a.sha256 || '(not hashed)'}, ${fmtCount(a.oldSize ?? 0)} → ${fmtCount(a.size)} bytes`;
	}
}

function attachmentCounts(items: readonly ITicketAttachmentChangeItem[]): string {
	const n = (op: ITicketAttachmentChangeItem['op']) => items.filter(a => a.op === op).length;
	return [n('added') && `${n('added')} added`, n('removed') && `${n('removed')} removed`, n('changed') && `${n('changed')} content changed`].filter(Boolean).join(', ') || 'no change';
}

/** A one line summary for worklog.md: `Status: Todo → Done; Description changed`. */
export function summarizeTicketChangeRecords(records: readonly ITicketChangeRecord[]): string {
	const one = (v: string | undefined) => {
		const s = (v || '(empty)').replace(/\s+/g, ' ');
		return s.length > 40 ? `${s.slice(0, 39)}…` : s;
	};
	return records.map(r => r.kind === 'inline' ? `${r.label}: ${one(r.old)} → ${one(r.new)}`
		: r.kind === 'attachments' ? `${r.label}: ${attachmentCounts(r.attachments ?? [])}`
			: `${r.label} changed`).join('; ');
}

function codeFence(content: string): string {
	const ticks = content.match(/`{3,}/g)?.reduce((m, t) => Math.max(m, t.length), 0) ?? 0;
	return '`'.repeat(Math.max(3, ticks + 1));
}

/** Serializes records as JSON without backticks (so a ``` fence can never be closed early). */
export function serializeTicketChangeRecords(records: readonly ITicketChangeRecord[]): string {
	return JSON.stringify(records, undefined, 2).replace(/`/g, '\\u0060');
}

export interface ITicketChangeEntryText {
	/** Full markdown, starting with the `## ` header line. */
	readonly markdown: string;
	readonly summary: string;
}

/**
 * The markdown of a change entry: header, update by, one line per field, the (truncated) diffs of large values and the
 * machine readable `### Change Records` JSON block.
 */
export function renderTicketChangeEntry(records: readonly ITicketChangeRecord[], actor: ITicketChangeActor, startedAt: string, lastChangeAt?: string): ITicketChangeEntryText {
	const lines: string[] = [];
	lines.push(`## ${startedAt} · Field changes`);
	lines.push('');
	lines.push(`- **Update Datetime**: ${startedAt}`);
	if (lastChangeAt && lastChangeAt !== startedAt) {
		lines.push(`- **Last Change**: ${lastChangeAt}`);
	}
	lines.push(`- **Update By**: ${actor.kind}`);
	if (actor.name) {
		lines.push(`- **Actor Name**: ${actor.name}`);
	}
	lines.push(`- **Entry Type**: Field changes (recorded automatically)`);
	lines.push('');
	lines.push('### Field Changes');
	for (const r of records) {
		lines.push(describeTicketChangeRecord(r));
	}
	for (const r of records) {
		if (r.kind === 'diff' && r.diff) {
			const fence = codeFence(r.diff);
			lines.push('');
			lines.push(`#### ${r.label} — diff`);
			lines.push(`${fence}diff`);
			lines.push(r.diff);
			lines.push(fence);
		}
	}
	lines.push('');
	lines.push(TICKET_CHANGE_RECORDS_HEADING);
	lines.push('```json');
	lines.push(serializeTicketChangeRecords(records));
	lines.push('```');
	return { markdown: lines.join('\n'), summary: summarizeTicketChangeRecords(records) };
}

/** The change records of a work log entry (empty when it has no `### Change Records` block). */
export function parseTicketChangeRecords(entryText: string): ITicketChangeRecord[] {
	const idx = (entryText || '').indexOf(TICKET_CHANGE_RECORDS_HEADING);
	if (idx < 0) {
		return [];
	}
	const m = entryText.slice(idx + TICKET_CHANGE_RECORDS_HEADING.length).match(/^\s*```json\r?\n([\s\S]*?)\r?\n```/);
	if (!m) {
		return [];
	}
	try {
		const parsed = JSON.parse(m[1]);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((r): r is ITicketChangeRecord => !!r && typeof r === 'object' && typeof r.field === 'string' && typeof r.kind === 'string');
	} catch {
		return [];
	}
}

/** Whether a record matches a field filter given by id (`status`, `custom:Notes`) or label (case-insensitive). */
export function ticketChangeRecordMatchesField(r: ITicketChangeRecord, field: string): boolean {
	const f = field.trim().toLowerCase().replace(/^\/+/, '').replace(/^(custom|attributes|readme|instructions)\//, '');
	if (!f) {
		return true;
	}
	const id = r.field.toLowerCase();
	return id === f || r.label.toLowerCase() === f || id === CUSTOM_FIELD_ID_PREFIX + f || id.replace(/_/g, ' ') === f;
}

// ------------------------------------------------------------------------------------------------
// worklog.md summary blocks
// ------------------------------------------------------------------------------------------------

/**
 * Replaces (or, with `newBlock` undefined, removes) the worklog.md summary block that references `logFilename`
 * (`## header` ... `- **Log File**: [<logFilename>](...)` ... up to the next `## ` heading). Unchanged when absent.
 */
export function replaceWorklogMdSummaryBlock(content: string, logFilename: string, newBlock: string | undefined): string {
	const lines = content.split('\n');
	const refIdx = lines.findIndex(l => l.startsWith(`- **Log File**: [${logFilename}]`));
	if (refIdx < 0) {
		return content;
	}
	let start = refIdx;
	while (start > 0 && !lines[start].startsWith('## ')) {
		start--;
	}
	if (!lines[start].startsWith('## ')) {
		return content;
	}
	let end = refIdx + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) {
		end++;
	}
	// keep one blank line before the next block
	const replacement = newBlock === undefined ? [] : [...newBlock.replace(/^\n+|\n+$/g, '').split('\n'), ''];
	const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
	return next.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------------------------------------
// Coalescing
// ------------------------------------------------------------------------------------------------

export interface ICoalescedFieldState {
	readonly field: string;
	label: string;
	source: TicketFieldSource;
	/** The value before the first change of this entry (kept when merging). */
	readonly oldValue: string;
	newValue: string;
	/** Time of the latest change. */
	at: number;
}

export interface ITicketChangeEntryState {
	/** First part file name of the entry (`Ticket_<ID>_<stamp>_001.log`). */
	readonly filename: string;
	/** The entry's display timestamp (`2026-11-27 10:00:00 -05:00`). */
	readonly timestamp: string;
	readonly actor: ITicketChangeActor;
	readonly startedAt: number;
	lastAt: number;
	readonly fields: Map<string, ICoalescedFieldState>;
}

/**
 * Fields whose every change is a discrete event (UI-19): a change set that touches one of them is never merged into an
 * earlier entry and its entry is never merged into, so each Status / Priority change keeps its own record (e.g.
 * In Progress → Removed is not hidden in a coalesced Todo → Removed, which restoring a ticket relies on).
 */
export const TICKET_CHANGE_DISCRETE_FIELDS: ReadonlySet<string> = new Set(['status', 'priority']);

/** Whether a change set touches a {@link TICKET_CHANGE_DISCRETE_FIELDS discrete field} (it must not be coalesced). */
export function hasDiscreteTicketFieldChange(changes: readonly { readonly field: string }[]): boolean {
	return changes.some(c => TICKET_CHANGE_DISCRETE_FIELDS.has(c.field));
}

/**
 * In-memory state of the latest change entry per ticket, so consecutive saves of the same actor update one entry.
 * Any other entry written to the ticket's work log, a different actor, an expired window or an app restart starts a
 * new entry. So does a change set that touches a discrete field (Status, Priority): it gets an entry of its own.
 */
export class TicketChangeCoalescer {
	private readonly _entries = new Map<string, ITicketChangeEntryState>();

	constructor(
		private readonly windowMs = TICKET_CHANGE_COALESCE_WINDOW_MS,
		private readonly maxAgeMs = TICKET_CHANGE_COALESCE_MAX_AGE_MS
	) { }

	/** The entry the next change set (`changes`) of `actor` at `now` can be merged into, if any. */
	mergeTarget(ticketKey: string, actor: ITicketChangeActor, now: number, changes: readonly { readonly field: string }[] = []): ITicketChangeEntryState | undefined {
		const e = this._entries.get(ticketKey);
		if (!e) {
			return undefined;
		}
		if (hasDiscreteTicketFieldChange(changes)) {
			this._entries.delete(ticketKey);
			return undefined;
		}
		if (!sameTicketChangeActor(e.actor, actor) || now - e.lastAt > this.windowMs || now - e.startedAt > this.maxAgeMs || now < e.lastAt) {
			this._entries.delete(ticketKey);
			return undefined;
		}
		return e;
	}

	start(ticketKey: string, entry: { filename: string; timestamp: string }, actor: ITicketChangeActor, changes: readonly ITicketFieldChange[], now: number): ITicketChangeEntryState {
		const fields = new Map<string, ICoalescedFieldState>();
		for (const c of changes) {
			fields.set(c.field, { field: c.field, label: c.label, source: c.source, oldValue: c.oldValue, newValue: c.newValue, at: now });
		}
		const state: ITicketChangeEntryState = { filename: entry.filename, timestamp: entry.timestamp, actor, startedAt: now, lastAt: now, fields };
		if (hasDiscreteTicketFieldChange(changes)) {
			// an entry holding a Status / Priority change is final: the next change set starts a new entry
			this._entries.delete(ticketKey);
		} else {
			this._entries.set(ticketKey, state);
		}
		return state;
	}

	/** Merges changes into the entry: the first old value is kept, the latest new value wins, reverted fields drop out (except discrete fields). */
	static merge(state: ITicketChangeEntryState, changes: readonly ITicketFieldChange[], now: number): void {
		for (const c of changes) {
			const existing = state.fields.get(c.field);
			if (!existing) {
				state.fields.set(c.field, { field: c.field, label: c.label, source: c.source, oldValue: c.oldValue, newValue: c.newValue, at: now });
				continue;
			}
			existing.newValue = c.newValue;
			existing.label = c.label;
			existing.at = now;
			// a discrete field round trip (never merged by mergeTarget anyway) is history, not a no-op
			if (!TICKET_CHANGE_DISCRETE_FIELDS.has(c.field) && ticketFieldValuesEqual(c.field, existing.oldValue, existing.newValue)) {
				state.fields.delete(c.field);
			}
		}
		state.lastAt = now;
	}

	invalidate(ticketKey: string): void {
		this._entries.delete(ticketKey);
	}

	clear(): void {
		this._entries.clear();
	}
}

/** The process wide coalescer (state is lost on restart, which simply starts a new entry). */
export const ticketChangeCoalescer = new TicketChangeCoalescer();
