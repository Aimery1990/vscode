/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ITicketChangeActor, ITicketChangeRecord, ITicketAttachmentChangeItem } from './ticketChangeLog.js';

/*
 * Ticket attachment integrity: pure logic.
 *
 * The files directly inside a ticket's `attachments/` folder are tracked in a small manifest,
 * `.agents/fields/attachments.manifest.json`, with the SHA-256 and size of each file plus the (size, mtime) at which it
 * was hashed. Reconciling the folder against the manifest finds added, removed and changed files:
 * - after the app itself adds or removes an attachment: logged with the acting User / AI Agent / Workflow;
 * - when a ticket is opened / refreshed / run: logged as `System (detected)`; a same-named file whose content changed
 *   outside the app (even at the same size) is flagged as tampered and shown with a warning in the UI.
 * A file is only re-hashed when its (size, mtime) differ from the recorded ones, and each pass hashes at most
 * {@link ATTACHMENT_HASH_MAX_FILES_PER_PASS} files / {@link ATTACHMENT_HASH_MAX_BYTES_PER_PASS} bytes; the rest is
 * left for the next pass (kept as recorded, never reported as removed). The IO side lives in
 * `browser/ticketAttachmentIntegrity.ts`.
 */

export const ATTACHMENT_MANIFEST_FILE_NAME = 'attachments.manifest.json';
export const ATTACHMENT_MANIFEST_VERSION = 1;
/** At most this many files are hashed in one reconcile pass ... */
export const ATTACHMENT_HASH_MAX_FILES_PER_PASS = 50;
/** ... and at most this many bytes (a single larger file is still hashed when it comes first). */
export const ATTACHMENT_HASH_MAX_BYTES_PER_PASS = 256 * 1024 * 1024;
/** Files above this size are never read into memory for hashing: tracked by size / mtime only. */
export const ATTACHMENT_HASH_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** The actor of changes found by a reconcile on open / refresh / run. */
export const ATTACHMENT_DETECTED_ACTOR: ITicketChangeActor = { kind: 'System', name: 'detected' };

/** Content of a file changed outside the app (the warning shown on the attachment). */
export interface IAttachmentTamperInfo {
	readonly previousSha256: string;
	readonly previousSize: number;
	/** ISO time of the detection. */
	readonly detectedAt: string;
}

export interface IAttachmentManifestEntry {
	readonly name: string;
	/** Lowercase hex SHA-256 of the content; empty when the file is too large to hash. */
	readonly sha256: string;
	readonly size: number;
	/** mtime (ms) of the file when it was hashed: (size, mtime) unchanged means the hash is still valid. */
	readonly mtime: number;
	/** ISO time the current hash was recorded. */
	readonly recordedAt: string;
	readonly tampered?: IAttachmentTamperInfo;
}

export interface IAttachmentManifest {
	readonly version: number;
	readonly files: Readonly<Record<string, IAttachmentManifestEntry>>;
}

export function emptyAttachmentManifest(): IAttachmentManifest {
	return { version: ATTACHMENT_MANIFEST_VERSION, files: {} };
}

function isSha(v: unknown): v is string {
	return typeof v === 'string' && (v === '' || /^[0-9a-f]{64}$/.test(v));
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Parses a manifest, dropping malformed entries; undefined when the text is not a manifest at all. */
export function parseAttachmentManifest(text: string | undefined): IAttachmentManifest | undefined {
	if (!text || !text.trim()) {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const rawFiles = (raw as { files?: unknown }).files;
	const files: Record<string, IAttachmentManifestEntry> = {};
	if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
		for (const [name, value] of Object.entries(rawFiles as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const e = value as Record<string, unknown>;
			const size = num(e.size);
			const mtime = num(e.mtime);
			if (!isSha(e.sha256) || size === undefined || mtime === undefined) {
				continue;
			}
			let tampered: IAttachmentTamperInfo | undefined;
			const t = e.tampered as Record<string, unknown> | undefined;
			if (t && typeof t === 'object' && isSha(t.previousSha256) && num(t.previousSize) !== undefined && typeof t.detectedAt === 'string') {
				tampered = { previousSha256: t.previousSha256, previousSize: num(t.previousSize)!, detectedAt: t.detectedAt };
			}
			files[name] = {
				name,
				sha256: e.sha256,
				size,
				mtime,
				recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : '',
				...(tampered ? { tampered } : {})
			};
		}
	}
	return { version: ATTACHMENT_MANIFEST_VERSION, files };
}

/** Stable JSON (files sorted by name) so unchanged manifests serialize identically. */
export function serializeAttachmentManifest(manifest: IAttachmentManifest): string {
	const files: Record<string, IAttachmentManifestEntry> = {};
	for (const name of Object.keys(manifest.files).sort()) {
		const e = manifest.files[name];
		files[name] = { name: e.name, sha256: e.sha256, size: e.size, mtime: e.mtime, recordedAt: e.recordedAt, ...(e.tampered ? { tampered: e.tampered } : {}) };
	}
	return JSON.stringify({ version: ATTACHMENT_MANIFEST_VERSION, files }, undefined, 2) + '\n';
}

/** A file currently in the attachments folder (from a directory stat). */
export interface IObservedAttachment {
	readonly name: string;
	readonly size: number;
	readonly mtime: number;
}

/**
 * The files whose content must be hashed in this pass: new files and files whose (size, mtime) differ from the
 * recorded ones, in name order, within the per-pass budget. Files above the size cap are not hashed (see
 * {@link reconcileAttachmentManifest}).
 */
export function selectAttachmentsToHash(manifest: IAttachmentManifest, observed: readonly IObservedAttachment[], maxFiles = ATTACHMENT_HASH_MAX_FILES_PER_PASS, maxBytes = ATTACHMENT_HASH_MAX_BYTES_PER_PASS): IObservedAttachment[] {
	const out: IObservedAttachment[] = [];
	let bytes = 0;
	for (const f of [...observed].sort((a, b) => a.name.localeCompare(b.name))) {
		const known = manifest.files[f.name];
		if (known && known.size === f.size && known.mtime === f.mtime) {
			continue;
		}
		if (f.size > ATTACHMENT_HASH_MAX_FILE_BYTES) {
			continue;
		}
		if (out.length >= maxFiles || (out.length > 0 && bytes + f.size > maxBytes)) {
			break;
		}
		out.push(f);
		bytes += f.size;
	}
	return out;
}

export interface IAttachmentReconcileResult {
	readonly manifest: IAttachmentManifest;
	readonly changes: readonly ITicketAttachmentChangeItem[];
	/** Whether the manifest differs from the input one (and must be written). */
	readonly manifestChanged: boolean;
}

export interface IAttachmentReconcileOptions {
	/** ISO time of this pass. */
	readonly now: string;
	/**
	 * `detected`: changes found on open / refresh / run (a changed content is flagged as tampered).
	 * `app`: right after the app wrote / deleted attachments (a changed content clears the tamper flag).
	 */
	readonly mode: 'detected' | 'app';
	/** No manifest existed yet: record every file silently (existing tickets get hashes lazily). */
	readonly baseline?: boolean;
}

/**
 * Applies one pass: `observed` is the folder listing, `hashes` the SHA-256 of the files hashed in this pass (see
 * {@link selectAttachmentsToHash}). A file that needed hashing but has no hash yet (over budget) keeps its recorded
 * entry and is not reported; a recorded file missing from the listing is removed.
 */
export function reconcileAttachmentManifest(manifest: IAttachmentManifest, observed: readonly IObservedAttachment[], hashes: ReadonlyMap<string, string>, options: IAttachmentReconcileOptions): IAttachmentReconcileResult {
	const files: Record<string, IAttachmentManifestEntry> = {};
	const changes: ITicketAttachmentChangeItem[] = [];
	let manifestChanged = false;
	const seen = new Set<string>();

	for (const f of [...observed].sort((a, b) => a.name.localeCompare(b.name))) {
		seen.add(f.name);
		const known = manifest.files[f.name];
		if (known && known.size === f.size && known.mtime === f.mtime) {
			files[f.name] = known;
			continue;
		}
		const tooLarge = f.size > ATTACHMENT_HASH_MAX_FILE_BYTES;
		const sha = tooLarge ? '' : hashes.get(f.name);
		if (sha === undefined) {
			// Deferred to a later pass.
			if (known) {
				files[f.name] = known;
			}
			continue;
		}
		manifestChanged = true;
		if (!known) {
			files[f.name] = { name: f.name, sha256: sha, size: f.size, mtime: f.mtime, recordedAt: options.now };
			if (!options.baseline) {
				changes.push({ op: 'added', name: f.name, sha256: sha, size: f.size });
			}
			continue;
		}
		const sameContent = sha !== '' && sha === known.sha256 && f.size === known.size;
		const sizeOnlyUnchanged = sha === '' && known.sha256 === '' && f.size === known.size;
		if (sameContent || sizeOnlyUnchanged) {
			// Touched (mtime) but not changed: refresh the stat, keep the flag.
			files[f.name] = { ...known, mtime: f.mtime };
			continue;
		}
		const tampered: IAttachmentTamperInfo | undefined = options.mode === 'detected'
			? { previousSha256: known.sha256, previousSize: known.size, detectedAt: options.now }
			: undefined;
		files[f.name] = { name: f.name, sha256: sha, size: f.size, mtime: f.mtime, recordedAt: options.now, ...(tampered ? { tampered } : {}) };
		changes.push({ op: 'changed', name: f.name, sha256: sha, size: f.size, oldSha256: known.sha256, oldSize: known.size, ...(tampered ? { detected: true } : {}) });
	}

	for (const name of Object.keys(manifest.files).sort()) {
		if (seen.has(name)) {
			continue;
		}
		const known = manifest.files[name];
		manifestChanged = true;
		if (!options.baseline) {
			changes.push({ op: 'removed', name, sha256: known.sha256, size: known.size });
		}
	}

	return { manifest: { version: ATTACHMENT_MANIFEST_VERSION, files }, changes, manifestChanged };
}

/** The change log record of attachment changes (one record per pass). */
export function attachmentChangeRecord(changes: readonly ITicketAttachmentChangeItem[], actor: ITicketChangeActor, at: Date): ITicketChangeRecord {
	return {
		field: 'attachments',
		label: 'Attachments',
		source: 'ticket.md',
		actor: actor.kind,
		...(actor.name ? { actorName: actor.name } : {}),
		at: at.toISOString(),
		kind: 'attachments',
		attachments: [...changes]
	};
}

/** Tooltip of the warning shown on a tampered attachment. */
export function attachmentTamperTooltip(entry: IAttachmentManifestEntry): string | undefined {
	const t = entry.tampered;
	if (!t) {
		return undefined;
	}
	return [
		`Content changed outside the app (detected ${t.detectedAt}).`,
		`Recorded sha256: ${t.previousSha256 || '(not hashed)'} (${t.previousSize} bytes)`,
		`Current sha256: ${entry.sha256 || '(not hashed)'} (${entry.size} bytes)`
	].join('\n');
}
