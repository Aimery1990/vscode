/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { StringSHA1 } from '../../../../base/common/hash.js';

/*
 * Per-field file store of a ticket: `<ticket>/.agents/fields/`.
 *
 * - CI-50 (implemented): full versions of large field values, written when a change is recorded:
 *   `fields/<field_key>.versions/<YYYYMMDD-HHMMSS>_<sha256 first 12>.txt.gz` (gzip, full content, deduplicated by hash).
 * - CI-51: the CURRENT value of a long field lives in `fields/<field_key>.txt` (plain UTF-8, exactly the field value),
 *   and ticket.md / README.md / instruction.md keep only a one line reference as the field value:
 *
 *       - **Description**: @file(.agents/fields/description.txt) sha256:<64 lowercase hex> chars:<n>
 *
 *   The path is relative to the ticket folder, `sha256` is the SHA-256 of the file content (UTF-8) and `chars` its
 *   length in UTF-16 code units (informational). A value is a reference only when the WHOLE trimmed value matches
 *   {@link TICKET_FIELD_REFERENCE_RE} (fixed path shape, 64 hex digits, single spaces), so normal text never parses as
 *   one. The same SHA-256 names a version in `fields/<field_key>.versions/` (`<stamp>_<sha first 12>.txt.gz`), which
 *   links the current value to its history. Which values are externalized: {@link shouldExternalizeTicketField}.
 *   Parsing / rewriting the references inside a file: `ticketFieldReferences.ts`; the IO side (write splitting, read
 *   resolving) is `browser/ticketFieldFiles.ts`.
 */

export const TICKET_FIELDS_DIR_NAME = 'fields';
export const TICKET_FIELD_VERSIONS_SUFFIX = '.versions';
export const TICKET_FIELD_VERSION_EXTENSION = '.txt.gz';
/** Plain text fallback when gzip (CompressionStream) is not available. */
export const TICKET_FIELD_VERSION_PLAIN_EXTENSION = '.txt';
export const TICKET_FIELD_VERSION_HASH_CHARS = 12;

const CUSTOM_PREFIX = 'custom:';

/** Keys of the standard fields: a custom field whose key would collide gets the `custom_` prefix. */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(['title', 'description', 'ticket_prompt', 'status', 'priority', 'labels', 'current_ai_agent', 'link_to']);

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 80);
}

/**
 * The file name key of a field: the field id sanitized for file names (lowercase, `[a-z0-9_-]`), e.g. `title`,
 * `description`, `ticket_prompt`, `status`, `custom:Expected Salary` → `expected_salary` (a custom key equal to a standard
 * field key is prefixed: `custom:Description` → `custom_description`). Falls back to the label's slug,
 * then to `field_<sha1 of the id, 8 chars>` (e.g. a label written only in CJK characters).
 */
export function sanitizeTicketFieldKey(fieldId: string, label?: string): string {
	const isCustom = (fieldId || '').startsWith(CUSTOM_PREFIX);
	const id = isCustom ? fieldId.slice(CUSTOM_PREFIX.length) : (fieldId || '');
	const fromId = slug(id);
	if (fromId) {
		return isCustom && RESERVED_FIELD_KEYS.has(fromId) ? `custom_${fromId}` : fromId;
	}
	const fromLabel = slug(label || '');
	if (fromLabel) {
		return fromLabel;
	}
	const sha = new StringSHA1();
	sha.update(fieldId || label || '');
	return `field_${sha.digest().slice(0, 8)}`;
}

/** `<agentsDir>/fields` */
export function ticketFieldsDir(agentsDir: URI): URI {
	return URI.joinPath(agentsDir, TICKET_FIELDS_DIR_NAME);
}

/** `<agentsDir>/fields/<fieldKey>.versions` */
export function ticketFieldVersionsDir(agentsDir: URI, fieldKey: string): URI {
	return URI.joinPath(ticketFieldsDir(agentsDir), `${fieldKey}${TICKET_FIELD_VERSIONS_SUFFIX}`);
}

/** `<agentsDir>/fields/<fieldKey>.txt` — the current value file of a long field (CI-51). */
export function ticketFieldCurrentValueUri(agentsDir: URI, fieldKey: string): URI {
	return URI.joinPath(ticketFieldsDir(agentsDir), `${fieldKey}.txt`);
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `<YYYYMMDD-HHMMSS>_<sha256 first 12><extension>` (local time). */
export function ticketFieldVersionFileName(date: Date, sha256: string, extension = TICKET_FIELD_VERSION_EXTENSION): string {
	return `${stamp(date)}_${sha256.toLowerCase().slice(0, TICKET_FIELD_VERSION_HASH_CHARS)}${extension}`;
}

/** Parses a version file name, or undefined for any other file. */
export function parseTicketFieldVersionFileName(name: string): { stamp: string; hashPrefix: string; gzip: boolean } | undefined {
	const m = name.match(/^(\d{8}-\d{6})_([0-9a-f]{12})\.txt(\.gz)?$/);
	return m ? { stamp: m[1], hashPrefix: m[2], gzip: !!m[3] } : undefined;
}

/** The existing version file (name) holding the content with this hash, if any (dedup). */
export function findTicketFieldVersionByHash(fileNames: readonly string[], sha256: string): string | undefined {
	const prefix = sha256.toLowerCase().slice(0, TICKET_FIELD_VERSION_HASH_CHARS);
	return fileNames.find(n => parseTicketFieldVersionFileName(n)?.hashPrefix === prefix);
}

/** Path of a version file relative to the ticket folder: `.agents/fields/<fieldKey>.versions/<file>`. */
export function ticketFieldVersionRelativePath(fieldKey: string, fileName: string): string {
	return `.agents/${TICKET_FIELDS_DIR_NAME}/${fieldKey}${TICKET_FIELD_VERSIONS_SUFFIX}/${fileName}`;
}

/** Whether a relative path (from a log record) is a version file of this store (guards reads against `..` paths). */
export function isTicketFieldVersionRelativePath(path: string): boolean {
	return /^\.agents\/fields\/[a-z0-9_-]+\.versions\/\d{8}-\d{6}_[0-9a-f]{12}\.txt(\.gz)?$/.test(path || '');
}

// ------------------------------------------------------------------------------------------------
// CI-51: externalized current values
// ------------------------------------------------------------------------------------------------

/**
 * The ONE long-text threshold of ticket fields, in UTF-8 bytes (about 1000 CJK characters or 500 English words):
 * - a value of at most this size is "short": stored inline in ticket.md / README.md / instruction.md and logged
 *   inline (old → new) in the change log;
 * - a larger value is "long": stored in `fields/<key>.txt` (CI-51), logged with stats + a truncated diff, and its full
 *   versions kept in `fields/<key>.versions/` (CI-50). A change is "long" when either side is long.
 */
export const LONG_TEXT_MIN_BYTES = 3072;

/** UTF-8 byte length of a string (lone surrogates count as 3 bytes, like TextEncoder's replacement character). */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) {
			bytes += 1;
		} else if (c < 0x800) {
			bytes += 2;
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/** Whether a value is "long" (more than {@link LONG_TEXT_MIN_BYTES} UTF-8 bytes). */
export function isLongTicketText(value: string | undefined): boolean {
	const v = value || '';
	// cheap bounds: every UTF-16 unit is 1..3 bytes
	if (v.length > LONG_TEXT_MIN_BYTES) {
		return true;
	}
	if (v.length * 3 <= LONG_TEXT_MIN_BYTES) {
		return false;
	}
	return utf8ByteLength(v) > LONG_TEXT_MIN_BYTES;
}

const REFERENCE_MARKER = '@file(.agents/fields/';
/** The whole (trimmed) value of a reference. */
export const TICKET_FIELD_REFERENCE_RE = /^@file\((\.agents\/fields\/([a-z0-9_-]+)\.txt)\) sha256:([0-9a-f]{64}) chars:(0|[1-9]\d{0,9})$/;

export interface ITicketFieldReference {
	/** Path relative to the ticket folder: `.agents/fields/<key>.txt`. */
	readonly path: string;
	readonly fieldKey: string;
	readonly sha256: string;
	readonly chars: number;
}

/**
 * Workspace configuration kept in ticket.md (also as Self Defined Data entries) and read with plain regular expressions
 * all over the app: never externalized.
 */
const NEVER_EXTERNALIZED_CUSTOM_KEYS: ReadonlySet<string> = new Set(['ticket statuses', 'status mapping', 'removed status', 'ticket labels']);

/**
 * Whether a field may be externalized: Description, Ticket Prompt and template / Freestyle values (never Title, the
 * short standard fields or the workspace configuration entries).
 */
export function isExternalizableTicketField(fieldId: string): boolean {
	if (fieldId === 'description' || fieldId === 'ticket_prompt') {
		return true;
	}
	return (fieldId || '').startsWith(CUSTOM_PREFIX) && !NEVER_EXTERNALIZED_CUSTOM_KEYS.has(fieldId.slice(CUSTOM_PREFIX.length).trim().toLowerCase());
}

/**
 * Whether a (resolved) value is stored in `fields/<key>.txt`: an externalizable field whose value is long
 * ({@link isLongTicketText}). Short values stay (or become again) inline.
 */
export function shouldExternalizeTicketField(fieldId: string, value: string): boolean {
	if (!isExternalizableTicketField(fieldId) || parseTicketFieldReference(value)) {
		return false;
	}
	return isLongTicketText(value);
}

/** `.agents/fields/<fieldKey>.txt` (relative to the ticket folder). */
export function ticketFieldCurrentValueRelativePath(fieldKey: string): string {
	return `.agents/${TICKET_FIELDS_DIR_NAME}/${fieldKey}.txt`;
}

/** The single line reference stored as the field value. */
export function formatTicketFieldReference(ref: { fieldKey: string; sha256: string; chars: number }): string {
	return `@file(${ticketFieldCurrentValueRelativePath(ref.fieldKey)}) sha256:${ref.sha256.toLowerCase()} chars:${ref.chars}`;
}

/** Parses a field value that is exactly a reference (surrounding whitespace ignored), otherwise undefined. */
export function parseTicketFieldReference(value: string | undefined): ITicketFieldReference | undefined {
	const v = (value || '').trim();
	if (!v.startsWith(REFERENCE_MARKER)) {
		return undefined;
	}
	const m = v.match(TICKET_FIELD_REFERENCE_RE);
	return m ? { path: m[1], fieldKey: m[2], sha256: m[3], chars: Number(m[4]) } : undefined;
}

/** Cheap pre-check: whether a file content may contain a reference at all. */
export function mayContainTicketFieldReference(content: string | undefined): boolean {
	return !!content && content.includes(REFERENCE_MARKER);
}
