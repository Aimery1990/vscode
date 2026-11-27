/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { LcsDiff } from '../../../../base/common/diff/diff.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { normalizeTicketLabels } from './ticketLabels.js';

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

/** Values up to this many characters (both sides) are recorded inline, old → new. */
export const TICKET_CHANGE_INLINE_MAX_CHARS = 500;
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

export type TicketChangeActorKind = 'User' | 'AI Agent' | 'Workflow';

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
 * Reads the value of a top level `- **Key**: value` line plus its continuation lines (lines up to the next key line,
 * heading or `---`), as a multi-line description / prompt is stored.
 */
function readBlockValue(lines: readonly string[], key: string): string | undefined {
	const re = new RegExp(`^\\s*-\\s*\\*\\*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:\\s?(.*)$`, 'i');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (!m) {
			continue;
		}
		const parts = [m[1]];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (ANY_KEY_LINE_RE.test(next) || isSectionBreak(next)) {
				break;
			}
			parts.push(next);
		}
		return parts.join('\n').trim();
	}
	return undefined;
}

/** The tracked field values of one ticket file. */
export function extractTicketFields(source: TicketFieldSource, content: string): Map<string, ITicketFieldValue> {
	const result = new Map<string, ITicketFieldValue>();
	const lines = (content || '').split(/\r?\n/);
	const put = (id: string, label: string, value: string) => result.set(id, { id, label, source, value });

	if (source === 'README.md') {
		const title = readBlockValue(lines, 'Title');
		if (title !== undefined) {
			put('title', 'Title', title);
		}
		const description = readBlockValue(lines, 'Description');
		if (description !== undefined) {
			put('description', 'Description', description);
		}
		return result;
	}

	if (source === 'instruction.md') {
		const prompt = readBlockValue(lines, 'Ticket Prompt');
		if (prompt !== undefined) {
			put('ticket_prompt', 'Ticket Prompt', prompt);
		}
		return result;
	}

	// ticket.md
	let inSelfDefined = false;
	let currentCustom: string | undefined;
	const custom = new Map<string, string[]>();
	for (const line of lines) {
		if (/^###\s+Self Defined Data/.test(line)) {
			inSelfDefined = true;
			currentCustom = undefined;
			continue;
		}
		if (isSectionBreak(line)) {
			inSelfDefined = false;
			currentCustom = undefined;
			continue;
		}
		if (inSelfDefined) {
			const cm = line.match(CUSTOM_KEY_LINE_RE);
			if (cm) {
				currentCustom = cm[1].trim();
				custom.set(currentCustom, [cm[2]]);
				continue;
			}
			const top = line.match(KEY_LINE_RE);
			if (top) {
				const key = top[1].trim();
				if (key === 'Self Defined Data Structure' || key === 'Self Defined Data Value') {
					currentCustom = undefined;
					continue;
				}
				// A top level key ends the Self Defined Data section (e.g. `- **Current AI Agent**:`).
				inSelfDefined = false;
				currentCustom = undefined;
			} else {
				if (currentCustom !== undefined) {
					custom.get(currentCustom)!.push(line);
				}
				continue;
			}
		}
		const m = line.match(KEY_LINE_RE);
		if (m) {
			const id = TICKET_MD_STANDARD_FIELDS.get(m[1].trim());
			if (id && !result.has(id)) {
				put(id, m[1].trim(), m[2].trim());
			}
		}
	}
	for (const [key, parts] of custom) {
		put(CUSTOM_FIELD_ID_PREFIX + key, key, parts.join('\n').trim());
	}
	return result;
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

/**
 * The comparison form of a field value: re-serialization noise (line endings, whitespace runs, surrounding quotes,
 * `None` placeholders, JSON formatting, label / link list spacing) must not count as a change.
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
		return canonicalJson(json.value);
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
 * The changed fields between two versions of one tracked file. A field missing on one side counts as empty.
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
		const oldValue = o?.value ?? '';
		const newValue = n?.value ?? '';
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

export type TicketChangeKind = 'inline' | 'diff' | 'blob' | 'binary' | 'list';

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

	const isLarge = o.text.length > TICKET_CHANGE_INLINE_MAX_CHARS || n.text.length > TICKET_CHANGE_INLINE_MAX_CHARS;
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
		case 'diff': {
			const s = r.stats!;
			return `${head} ${fmtCount(s.old.words)} → ${fmtCount(s.new.words)} words, ${fmtCount(s.old.chars)} → ${fmtCount(s.new.chars)} chars, ${fmtCount(s.old.lines)} → ${fmtCount(s.new.lines)} lines; +${r.linesAdded ?? 0} / -${r.linesRemoved ?? 0} diff lines${r.diffTruncated ? ' (diff truncated)' : ''}; full texts old ${versionRef(r.oldPath)}, new ${versionRef(r.newPath)}`;
		}
	}
}

/** A one line summary for worklog.md: `Status: Todo → Done; Description changed`. */
export function summarizeTicketChangeRecords(records: readonly ITicketChangeRecord[]): string {
	const one = (v: string | undefined) => {
		const s = (v || '(empty)').replace(/\s+/g, ' ');
		return s.length > 40 ? `${s.slice(0, 39)}…` : s;
	};
	return records.map(r => r.kind === 'inline' ? `${r.label}: ${one(r.old)} → ${one(r.new)}` : `${r.label} changed`).join('; ');
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
 * In-memory state of the latest change entry per ticket, so consecutive saves of the same actor update one entry.
 * Any other entry written to the ticket's work log, a different actor, an expired window or an app restart starts a
 * new entry.
 */
export class TicketChangeCoalescer {
	private readonly _entries = new Map<string, ITicketChangeEntryState>();

	constructor(
		private readonly windowMs = TICKET_CHANGE_COALESCE_WINDOW_MS,
		private readonly maxAgeMs = TICKET_CHANGE_COALESCE_MAX_AGE_MS
	) { }

	/** The entry the next change set of `actor` at `now` can be merged into, if any. */
	mergeTarget(ticketKey: string, actor: ITicketChangeActor, now: number): ITicketChangeEntryState | undefined {
		const e = this._entries.get(ticketKey);
		if (!e) {
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
		this._entries.set(ticketKey, state);
		return state;
	}

	/** Merges changes into the entry: the first old value is kept, the latest new value wins, reverted fields drop out. */
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
			if (ticketFieldValuesEqual(c.field, existing.oldValue, existing.newValue)) {
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
