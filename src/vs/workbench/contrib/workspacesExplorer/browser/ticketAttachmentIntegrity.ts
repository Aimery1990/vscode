/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, encodeHex } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ITicketChangeActor, TicketChangeActorInput, toTicketChangeActor } from '../common/ticketChangeLog.js';
import { ticketFieldsDir } from '../common/ticketFieldStore.js';
import {
	ATTACHMENT_DETECTED_ACTOR, ATTACHMENT_MANIFEST_FILE_NAME, attachmentChangeRecord, emptyAttachmentManifest, IAttachmentManifest,
	IObservedAttachment, parseAttachmentManifest, reconcileAttachmentManifest, selectAttachmentsToHash, serializeAttachmentManifest
} from '../common/ticketAttachmentIntegrity.js';
import { recordTicketChangeEntry } from './ticketChangeRecorder.js';

/*
 * Ticket attachment integrity: IO side (see `common/ticketAttachmentIntegrity.ts` for the policy).
 *
 * - {@link checkTicketAttachments}: on ticket open / refresh / run. Changes are logged as `System (detected)`; a
 *   changed content is flagged as tampered in the manifest.
 * - {@link withTicketAttachmentChange}: wraps an in-app write / delete under `attachments/` so the change is logged with
 *   the acting User / AI Agent / Workflow.
 * Passes of one ticket are serialized. Errors never fail the caller: they are reported to the console.
 */

/** `<ticket>/.agents/fields/attachments.manifest.json` */
export function ticketAttachmentManifestUri(ticketFolder: URI): URI {
	return URI.joinPath(ticketFieldsDir(URI.joinPath(ticketFolder, '.agents')), ATTACHMENT_MANIFEST_FILE_NAME);
}

const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
	const next = (queues.get(key) || Promise.resolve()).then(task, task);
	const settled = next.then(() => undefined, () => undefined);
	queues.set(key, settled);
	settled.then(() => {
		if (queues.get(key) === settled) {
			queues.delete(key);
		}
	});
	return next;
}

async function readManifest(fileService: IFileService, ticketFolder: URI): Promise<IAttachmentManifest | undefined> {
	const uri = ticketAttachmentManifestUri(ticketFolder);
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		return parseAttachmentManifest((await fileService.readFile(uri)).value.toString()) ?? emptyAttachmentManifest();
	} catch {
		return undefined;
	}
}

/** The recorded attachment manifest of a ticket (for the UI), or undefined when none was written yet. */
export function readTicketAttachmentManifest(fileService: IFileService, ticketFolder: URI): Promise<IAttachmentManifest | undefined> {
	return readManifest(fileService, ticketFolder);
}

async function listAttachments(fileService: IFileService, ticketFolder: URI): Promise<IObservedAttachment[]> {
	try {
		const stat = await fileService.resolve(URI.joinPath(ticketFolder, 'attachments'), { resolveMetadata: true });
		return (stat.children || []).filter(c => !c.isDirectory && !c.isSymbolicLink).map(c => ({ name: c.name, size: c.size, mtime: c.mtime }));
	} catch {
		return []; // no attachments folder
	}
}

async function sha256OfFile(fileService: IFileService, uri: URI): Promise<string> {
	const bytes = (await fileService.readFile(uri)).value.buffer;
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return encodeHex(VSBuffer.wrap(new Uint8Array(digest)));
}

async function hashAll(fileService: IFileService, ticketFolder: URI, files: readonly IObservedAttachment[]): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const f of files) {
		try {
			hashes.set(f.name, await sha256OfFile(fileService, URI.joinPath(ticketFolder, 'attachments', f.name)));
		} catch {
			// vanished or unreadable: retried in a later pass
		}
	}
	return hashes;
}

/**
 * One reconcile pass. Without a manifest every current file is recorded silently (baseline, not budgeted, once per
 * ticket); otherwise new / changed files are hashed within the per-pass budget and the changes are logged.
 */
async function reconcile(fileService: IFileService, ticketFolder: URI, mode: 'detected' | 'app', actor: ITicketChangeActor): Promise<IAttachmentManifest | undefined> {
	const observed = await listAttachments(fileService, ticketFolder);
	const current = await readManifest(fileService, ticketFolder);
	if (!current && observed.length === 0) {
		return undefined;
	}
	const baseline = !current;
	const manifest = current ?? emptyAttachmentManifest();
	const toHash = baseline ? selectAttachmentsToHash(manifest, observed, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) : selectAttachmentsToHash(manifest, observed);
	const hashes = await hashAll(fileService, ticketFolder, toHash);
	const now = new Date();
	const result = reconcileAttachmentManifest(manifest, observed, hashes, { now: now.toISOString(), mode, baseline });
	if (result.manifestChanged || baseline) {
		await fileService.writeFile(ticketAttachmentManifestUri(ticketFolder), VSBuffer.fromString(serializeAttachmentManifest(result.manifest)));
	}
	if (result.changes.length > 0) {
		await recordTicketChangeEntry(fileService, URI.joinPath(ticketFolder, '.agents'), [attachmentChangeRecord(result.changes, actor, now)], actor, now);
	}
	return result.manifest;
}

/**
 * Checks the ticket's attachments against the recorded hashes (ticket opened / refreshed / run). Returns the updated
 * manifest (undefined when the ticket has no attachments and no manifest, or on error).
 */
export function checkTicketAttachments(fileService: IFileService, ticketFolder: URI): Promise<IAttachmentManifest | undefined> {
	return serialize(ticketFolder.toString(), async () => {
		try {
			return await reconcile(fileService, ticketFolder, 'detected', ATTACHMENT_DETECTED_ACTOR);
		} catch (err) {
			console.warn('[TicketAttachmentIntegrity] Failed to check attachments:', err);
			return undefined;
		}
	});
}

/**
 * Runs an in-app change of the ticket's `attachments/` folder and logs the added / removed / changed files with their
 * SHA-256 for `actor`. Changes made outside the app before are first recorded as detected, so they are not attributed
 * to `actor`.
 */
export function withTicketAttachmentChange<T>(fileService: IFileService, ticketFolder: URI, actorInput: TicketChangeActorInput, change: () => Promise<T>): Promise<T> {
	const actor = toTicketChangeActor(actorInput);
	return serialize(ticketFolder.toString(), async () => {
		try {
			const before = await reconcile(fileService, ticketFolder, 'detected', ATTACHMENT_DETECTED_ACTOR);
			if (!before) {
				// No attachments and no manifest yet: start an empty one so the first file is logged, not baselined.
				await fileService.writeFile(ticketAttachmentManifestUri(ticketFolder), VSBuffer.fromString(serializeAttachmentManifest(emptyAttachmentManifest())));
			}
		} catch (err) {
			console.warn('[TicketAttachmentIntegrity] Failed to check attachments:', err);
		}
		const result = await change();
		try {
			await reconcile(fileService, ticketFolder, 'app', actor);
		} catch (err) {
			console.warn('[TicketAttachmentIntegrity] Failed to record attachment changes:', err);
		}
		return result;
	});
}
