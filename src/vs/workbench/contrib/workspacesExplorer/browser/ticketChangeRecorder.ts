/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, encodeHex } from '../../../../base/common/buffer.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	diffTicketFieldMaps, extractTicketFields, ITicketChangeActor, ITicketChangeRecord, ITicketFieldChange, planTicketFieldChange,
	renderTicketChangeEntry, TICKET_CHANGE_ENTRY_KIND, TicketChangeActorInput,
	TicketChangeCoalescer, ticketChangeCoalescer, ticketFieldSourceOf, toTicketChangeActor
} from '../common/ticketChangeLog.js';
import {
	findTicketFieldVersionByHash, isTicketFieldVersionRelativePath, sanitizeTicketFieldKey, TICKET_FIELD_VERSION_PLAIN_EXTENSION,
	ticketFieldVersionFileName, ticketFieldVersionRelativePath, ticketFieldVersionsDir
} from '../common/ticketFieldStore.js';
import { TicketWorklogStorage } from './ticketWorklogStorage.js';

/*
 * Ticket field change recorder (CI-50): the shared write path of a ticket's field files.
 *
 * Every writer of `.agents/ticket.md`, `README.md` or `instruction.md` goes through {@link writeTicketFiles} /
 * {@link writeTicketFile} with the actor (User / AI Agent / Workflow). It reads the persisted files, writes the new
 * contents, diffs the tracked fields and records the changes into the ticket's work log (one `Worklogs/*.log` entry,
 * coalesced for consecutive saves of the same actor). Full versions of large values are stored per field in
 * `.agents/fields/<field_key>.versions/` (see `common/ticketFieldStore.ts`).
 * Logging never fails a write: errors are only reported to the console.
 */

export interface ITicketFileWrite {
	readonly uri: URI;
	readonly content: string;
}

/** Writes are serialized per ticket config folder so that "read old, write new, diff" never interleaves. */
const ticketQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = ticketQueues.get(key) || Promise.resolve();
	const next = previous.then(task, task);
	const settled = next.then(() => undefined, () => undefined);
	ticketQueues.set(key, settled);
	settled.then(() => {
		if (ticketQueues.get(key) === settled) {
			ticketQueues.delete(key);
		}
	});
	return next;
}

/** Waits until every queued ticket write and its change logging finished (tests). */
export async function flushTicketChangeRecorder(): Promise<void> {
	await Promise.all([...ticketQueues.values()]);
}

/** The ticket's `.agents` folder for a file in it (legacy tickets keep ticket.md in the ticket folder itself). */
function configDirOf(fileUri: URI): URI {
	const dir = dirname(fileUri);
	return basename(dir) === '.agents' ? dir : URI.joinPath(dir, '.agents');
}

async function readIfExists(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}

/** Writes one ticket file and records its field changes. See {@link writeTicketFiles}. */
export function writeTicketFile(fileService: IFileService, uri: URI, content: string, actor?: TicketChangeActorInput): Promise<void> {
	return writeTicketFiles(fileService, [{ uri, content }], actor);
}

/**
 * Writes ticket files (any file is accepted; only ticket.md / README.md / instruction.md are diffed) and records the
 * changed field values of existing files into the ticket's work log. A newly created file records nothing.
 * `actor` defaults to User.
 */
export async function writeTicketFiles(fileService: IFileService, writes: readonly ITicketFileWrite[], actorInput?: TicketChangeActorInput): Promise<void> {
	const actor = toTicketChangeActor(actorInput);
	const groups = new Map<string, { configDir: URI; writes: ITicketFileWrite[] }>();
	for (const w of writes) {
		const configDir = configDirOf(w.uri);
		const key = configDir.toString();
		if (!groups.has(key)) {
			groups.set(key, { configDir, writes: [] });
		}
		groups.get(key)!.writes.push(w);
	}
	await Promise.all([...groups.entries()].map(([key, g]) => enqueue(key, () => writeGroup(fileService, g.configDir, g.writes, actor))));
}

async function writeGroup(fileService: IFileService, configDir: URI, writes: readonly ITicketFileWrite[], actor: ITicketChangeActor): Promise<void> {
	const olds: (string | undefined)[] = [];
	for (const w of writes) {
		olds.push(ticketFieldSourceOf(basename(w.uri)) ? await readIfExists(fileService, w.uri) : undefined);
	}
	for (const w of writes) {
		await fileService.writeFile(w.uri, VSBuffer.fromString(w.content));
	}
	try {
		const changes: ITicketFieldChange[] = [];
		writes.forEach((w, i) => {
			const source = ticketFieldSourceOf(basename(w.uri));
			const old = olds[i];
			if (!source || old === undefined || old === w.content) {
				return;
			}
			changes.push(...diffTicketFieldMaps(extractTicketFields(source, old), extractTicketFields(source, w.content)));
		});
		if (changes.length > 0) {
			await recordTicketFieldChanges(fileService, configDir, changes, actor);
		}
	} catch (err) {
		console.warn('[TicketChangeRecorder] Failed to record ticket field changes:', err);
	}
}

// ------------------------------------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return encodeHex(VSBuffer.wrap(new Uint8Array(digest)));
}

async function gzip(text: string): Promise<Uint8Array | undefined> {
	if (typeof CompressionStream === 'undefined') {
		return undefined;
	}
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text();
}

/**
 * Stores a full value as a version of its field (`.agents/fields/<key>.versions/<stamp>_<sha12>.txt.gz`), reusing an
 * existing version with the same hash. Returns the full SHA-256 and the path relative to the ticket folder.
 */
async function storeFieldVersion(fileService: IFileService, configDir: URI, fieldId: string, label: string, text: string, at: Date): Promise<{ hash: string; path: string }> {
	const hash = await sha256Hex(text);
	const key = sanitizeTicketFieldKey(fieldId, label);
	const dir = ticketFieldVersionsDir(configDir, key);
	let existing: string[] = [];
	try {
		existing = ((await fileService.resolve(dir)).children || []).filter(c => !c.isDirectory).map(c => c.name);
	} catch {
		// folder does not exist yet
	}
	const reuse = findTicketFieldVersionByHash(existing, hash);
	if (reuse) {
		return { hash, path: ticketFieldVersionRelativePath(key, reuse) };
	}
	const compressed = await gzip(text);
	const name = compressed ? ticketFieldVersionFileName(at, hash) : ticketFieldVersionFileName(at, hash, TICKET_FIELD_VERSION_PLAIN_EXTENSION);
	await fileService.writeFile(URI.joinPath(dir, name), compressed ? VSBuffer.wrap(compressed) : VSBuffer.fromString(text));
	return { hash, path: ticketFieldVersionRelativePath(key, name) };
}

/** Reads a stored field version by its path relative to the ticket folder (from a change record), or undefined. */
export async function readTicketFieldVersion(fileService: IFileService, ticketFolderOrConfigDir: URI, relativePath: string): Promise<string | undefined> {
	if (!isTicketFieldVersionRelativePath(relativePath)) {
		return undefined;
	}
	const ticketFolder = basename(ticketFolderOrConfigDir) === '.agents' ? dirname(ticketFolderOrConfigDir) : ticketFolderOrConfigDir;
	const uri = URI.joinPath(ticketFolder, ...relativePath.split('/'));
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		const bytes = (await fileService.readFile(uri)).value;
		return relativePath.endsWith('.gz') ? await gunzip(bytes.buffer) : bytes.toString();
	} catch (err) {
		console.warn('[TicketChangeRecorder] Failed to read field version:', err);
		return undefined;
	}
}

async function buildRecords(fileService: IFileService, configDir: URI, changes: readonly (ITicketFieldChange & { at: number })[], actor: ITicketChangeActor): Promise<ITicketChangeRecord[]> {
	const records: ITicketChangeRecord[] = [];
	for (const c of changes) {
		const at = new Date(c.at);
		const planned = planTicketFieldChange(c, actor, at);
		if (planned.blobs.old !== undefined) {
			const v = await storeFieldVersion(fileService, configDir, c.field, c.label, planned.blobs.old, at);
			planned.record.oldHash = v.hash;
			planned.record.oldPath = v.path;
		}
		if (planned.blobs.new !== undefined) {
			const v = await storeFieldVersion(fileService, configDir, c.field, c.label, planned.blobs.new, at);
			planned.record.newHash = v.hash;
			planned.record.newPath = v.path;
		}
		records.push(planned.record);
	}
	return records;
}

/**
 * Records field changes of one ticket into its work log: merged into the latest change entry when the same actor
 * saved within the coalescing window and no other entry was written since, otherwise as a new entry.
 */
export async function recordTicketFieldChanges(fileService: IFileService, configDir: URI, changes: readonly ITicketFieldChange[], actor: ITicketChangeActor, now: Date = new Date()): Promise<void> {
	const storage = new TicketWorklogStorage(fileService);
	const ticketKey = URI.joinPath(configDir, 'Worklogs').toString();
	const nowMs = now.getTime();

	const target = ticketChangeCoalescer.mergeTarget(ticketKey, actor, nowMs);
	if (target && await fileService.exists(URI.joinPath(configDir, 'Worklogs', target.filename))) {
		TicketChangeCoalescer.merge(target, changes, nowMs);
		if (target.fields.size === 0) {
			await storage.deleteSinglePartEntry(configDir, target.filename);
			ticketChangeCoalescer.invalidate(ticketKey);
			return;
		}
		const records = await buildRecords(fileService, configDir, [...target.fields.values()], actor);
		const text = renderTicketChangeEntry(records, actor, target.timestamp, storage.formatFullDateTime(now));
		await storage.rewriteSinglePartEntry(configDir, target.filename, target.timestamp, {
			raw_content: text.markdown,
			update_summary: text.summary,
			update_by: actor.kind,
			actor_name: actor.name,
			entry_kind: TICKET_CHANGE_ENTRY_KIND
		});
		return;
	}

	const records = await buildRecords(fileService, configDir, changes.map(c => ({ ...c, at: nowMs })), actor);
	const startedAt = storage.formatFullDateTime(now);
	const text = renderTicketChangeEntry(records, actor, startedAt);
	const entry = await storage.saveWorklog(configDir, {
		raw_content: text.markdown,
		update_summary: text.summary,
		update_by: actor.kind,
		actor_name: actor.name,
		entry_kind: TICKET_CHANGE_ENTRY_KIND
	}, { customDate: new Date(nowMs) });
	if (entry.meta.totalParts === 1) {
		// saveWorklog may have moved the time stamp forward to avoid a file name clash: keep the header consistent
		if (entry.meta.timestamp !== startedAt) {
			const fixed = renderTicketChangeEntry(records, actor, entry.meta.timestamp);
			await storage.rewriteSinglePartEntry(configDir, entry.meta.partFiles[0], entry.meta.timestamp, {
				raw_content: fixed.markdown,
				update_summary: fixed.summary,
				update_by: actor.kind,
				actor_name: actor.name,
				entry_kind: TICKET_CHANGE_ENTRY_KIND
			});
		}
		ticketChangeCoalescer.start(ticketKey, { filename: entry.meta.partFiles[0], timestamp: entry.meta.timestamp }, actor, changes, nowMs);
	} else {
		ticketChangeCoalescer.invalidate(ticketKey);
	}
}
