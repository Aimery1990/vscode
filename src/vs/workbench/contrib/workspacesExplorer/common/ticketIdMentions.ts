/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ticket ID mentions in free text (UI-31): pure parsing.
 *
 * A mention is an upper-case ticket ID such as `ANYAG-0115`, `FINDJ-3436` or `DEMOW-0002`: a letter, 1-9 more
 * letters / digits, a dash and at least three digits. It must stand on its own: no letter, digit, `_` or `-` right
 * before it and no letter, digit or `_` right after it, so `XANYAG-0115`, `ANYAG-01150a` or `my_ANYAG-0115` are not
 * mentions while CJK text and punctuation around it (e.g. an ideographic comma or full stop) is fine. IDs inside URLs and
 * inside markdown code (`inline` or fenced blocks) are not mentions. Whether a mention is a real ticket is decided by
 * the caller (the ticket search index); this module only finds the candidates.
 */

export interface ITicketIdMention {
	/** The ticket ID as written (always upper case). */
	readonly id: string;
	/** Offset of the first character in the text. */
	readonly start: number;
	/** Offset right after the last character. */
	readonly end: number;
}

export interface ITicketIdMentionOptions {
	/** Ignore IDs inside markdown code (`inline` and ``` fenced ``` blocks). Default true. */
	readonly skipCode?: boolean;
}

/** One ticket ID (without the stand-alone checks, see {@link findTicketIdMentions}). */
export const TICKET_ID_PATTERN = /[A-Z][A-Z0-9]{1,9}-\d{3,}/;

const TICKET_ID_GLOBAL = new RegExp(TICKET_ID_PATTERN.source, 'g');
/** Characters that glue an ID to the word before / after it. */
const GLUE_BEFORE = /[A-Za-z0-9_\-]/;
const GLUE_AFTER = /[A-Za-z0-9_]/;
/** URLs (with a scheme, or starting with `www.`) up to the next white space or closing bracket / quote. */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`()\[\]{}\u3000-\u303f\uff08\uff09]*/gi;
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

/** True when `text` is exactly one ticket ID. */
export function isTicketId(text: string): boolean {
	return new RegExp(`^${TICKET_ID_PATTERN.source}$`).test(text);
}

function excludedRanges(text: string, skipCode: boolean): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const collect = (re: RegExp) => {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			if (m[0].length === 0) {
				re.lastIndex++;
				continue;
			}
			ranges.push([m.index, m.index + m[0].length]);
		}
	};
	if (skipCode) {
		collect(FENCED_CODE_RE);
		collect(INLINE_CODE_RE);
	}
	collect(URL_RE);
	return ranges;
}

/** Every stand-alone ticket ID in `text`, in order (duplicates included), outside URLs and (by default) code. */
export function findTicketIdMentions(text: string, options: ITicketIdMentionOptions = {}): ITicketIdMention[] {
	if (!text) {
		return [];
	}
	const excluded = excludedRanges(text, options.skipCode !== false);
	const out: ITicketIdMention[] = [];
	TICKET_ID_GLOBAL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TICKET_ID_GLOBAL.exec(text))) {
		const start = m.index;
		const end = start + m[0].length;
		if (start > 0 && GLUE_BEFORE.test(text[start - 1])) {
			continue;
		}
		if (end < text.length && GLUE_AFTER.test(text[end])) {
			continue;
		}
		if (excluded.some(([s, e]) => start < e && end > s)) {
			continue;
		}
		out.push({ id: m[0], start, end });
	}
	return out;
}

/** The distinct IDs of `mentions`, in order of first appearance. */
export function uniqueTicketIds(mentions: readonly ITicketIdMention[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of mentions) {
		if (!seen.has(m.id)) {
			seen.add(m.id);
			out.push(m.id);
		}
	}
	return out;
}

/** The mention under the caret at `offset` (a caret right before or right after the ID counts), or undefined. */
export function ticketIdMentionAt(text: string, offset: number, options: ITicketIdMentionOptions = {}): ITicketIdMention | undefined {
	if (!text || offset < 0 || offset > text.length) {
		return undefined;
	}
	return findTicketIdMentions(text, options).find(m => offset >= m.start && offset <= m.end);
}

/** A text split into plain runs and mention runs (for linkifying a text node). */
export type TicketIdTextPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mention'; readonly text: string; readonly id: string };

/**
 * Splits `text` at the mentions for which `accept(id)` is true; returns undefined when there is none (nothing to
 * replace).
 */
export function splitTicketIdMentions(text: string, accept: (id: string) => boolean, options: ITicketIdMentionOptions = {}): TicketIdTextPart[] | undefined {
	const mentions = findTicketIdMentions(text, options).filter(m => accept(m.id));
	if (mentions.length === 0) {
		return undefined;
	}
	const parts: TicketIdTextPart[] = [];
	let pos = 0;
	for (const m of mentions) {
		if (m.start > pos) {
			parts.push({ kind: 'text', text: text.slice(pos, m.start) });
		}
		parts.push({ kind: 'mention', text: text.slice(m.start, m.end), id: m.id });
		pos = m.end;
	}
	if (pos < text.length) {
		parts.push({ kind: 'text', text: text.slice(pos) });
	}
	return parts;
}
