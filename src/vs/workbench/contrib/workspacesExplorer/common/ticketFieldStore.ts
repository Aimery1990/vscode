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
 * - CI-51 (planned, not implemented here): the CURRENT value of a long field in `fields/<field_key>.txt`, with
 *   ticket.md keeping only a reference. {@link ticketFieldCurrentValueUri} already names that file.
 */

export const TICKET_FIELDS_DIR_NAME = 'fields';
export const TICKET_FIELD_VERSIONS_SUFFIX = '.versions';
export const TICKET_FIELD_VERSION_EXTENSION = '.txt.gz';
/** Plain text fallback when gzip (CompressionStream) is not available. */
export const TICKET_FIELD_VERSION_PLAIN_EXTENSION = '.txt';
export const TICKET_FIELD_VERSION_HASH_CHARS = 12;

const CUSTOM_PREFIX = 'custom:';

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 80);
}

/**
 * The file name key of a field: the field id sanitized for file names (lowercase, `[a-z0-9_-]`), e.g. `title`,
 * `description`, `ticket_prompt`, `status`, `custom:Expected Salary` → `expected_salary`. Falls back to the label's slug,
 * then to `field_<sha1 of the id, 8 chars>` (e.g. a label written only in CJK characters).
 */
export function sanitizeTicketFieldKey(fieldId: string, label?: string): string {
	const id = (fieldId || '').startsWith(CUSTOM_PREFIX) ? fieldId.slice(CUSTOM_PREFIX.length) : (fieldId || '');
	const fromId = slug(id);
	if (fromId) {
		return fromId;
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

/** `<agentsDir>/fields/<fieldKey>.txt` — the current value file of a long field (CI-51, not used yet). */
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
