/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	diffTicketFieldMaps, extractTicketFields, ITicketChangeActor, ITicketChangeRecord, ITicketFieldChange, planTicketFieldChange,
	renderTicketChangeEntry, TICKET_CHANGE_ENTRY_KIND, TicketChangeActorInput,
	TicketChangeCoalescer, ticketChangeCoalescer, toTicketChangeActor
} from '../common/ticketChangeLog.js';
import { isTicketFieldVersionRelativePath } from '../common/ticketFieldStore.js';
import { ensureExternalizedVersions, executeTicketFileWritePlan, gunzip, planTicketFileWrites, storeTicketFieldVersion, ticketConfigDirOf } from './ticketFieldFiles.js';
import { TicketWorklogStorage } from './ticketWorklogStorage.js';

/*
 * Ticket field change recorder (CI-50): the shared write path of a ticket's field files.
 *
 * Every writer of `.agents/ticket.md`, `README.md` or `instruction.md` goes through {@link writeTicketFiles} /
 * {@link writeTicketFile} with the actor (User / AI Agent / Workflow). It reads the persisted files, writes the new
 * contents, diffs the tracked fields and records the changes into the ticket's work log (one `Worklogs/*.log` entry,
 * coalesced for consecutive saves of the same actor, except that Status / Priority changes always get an entry of
 * their own, UI-19). Full versions of large values are stored per field in
 * `.agents/fields/<field_key>.versions/` (see `common/ticketFieldStore.ts`).
 * CI-51: long values are written to `.agents/fields/<field_key>.txt` and referenced from the field (see
 * `ticketFieldFiles.ts`); the change log compares the resolved values, never the reference lines.
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
		const configDir = ticketConfigDirOf(w.uri);
		const key = configDir.toString();
		if (!groups.has(key)) {
			groups.set(key, { configDir, writes: [] });
		}
		groups.get(key)!.writes.push(w);
	}
	await Promise.all([...groups.entries()].map(([key, g]) => enqueue(key, () => writeGroup(fileService, g.configDir, g.writes, actor))));
}

async function writeGroup(fileService: IFileService, configDir: URI, writes: readonly ITicketFileWrite[], actor: ITicketChangeActor): Promise<void> {
	const plan = await planTicketFileWrites(fileService, configDir, writes);
	await executeTicketFileWritePlan(fileService, plan);
	try {
		const changes: ITicketFieldChange[] = [];
		for (const item of plan.items) {
			if (!item.source || item.oldResolved === undefined || item.oldResolved === item.newResolved) {
				continue;
			}
			changes.push(...diffTicketFieldMaps(extractTicketFields(item.source, item.oldResolved), extractTicketFields(item.source, item.newResolved)));
		}
		if (changes.length > 0) {
			await recordTicketFieldChanges(fileService, configDir, changes, actor);
		}
	} catch (err) {
		console.warn('[TicketChangeRecorder] Failed to record ticket field changes:', err);
	}
	try {
		await ensureExternalizedVersions(fileService, plan, new Date());
	} catch (err) {
		console.warn('[TicketChangeRecorder] Failed to store versions of externalized field values:', err);
	}
}

// ------------------------------------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------------------------------------

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
			const v = await storeTicketFieldVersion(fileService, configDir, { id: c.field, label: c.label }, planned.blobs.old, at);
			planned.record.oldHash = v.hash;
			planned.record.oldPath = v.path;
		}
		if (planned.blobs.new !== undefined) {
			const v = await storeTicketFieldVersion(fileService, configDir, { id: c.field, label: c.label }, planned.blobs.new, at);
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

	const target = ticketChangeCoalescer.mergeTarget(ticketKey, actor, nowMs, changes);
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

/**
 * Writes ready-made change records (e.g. attachment changes) as a new change entry of the ticket, serialized with the
 * ticket's field writes. The entry is never coalesced; the next field change starts a new entry.
 */
export function recordTicketChangeEntry(fileService: IFileService, configDir: URI, records: readonly ITicketChangeRecord[], actor: ITicketChangeActor, now: Date = new Date()): Promise<void> {
	return enqueue(configDir.toString(), async () => {
		const storage = new TicketWorklogStorage(fileService);
		const startedAt = storage.formatFullDateTime(now);
		const save = (timestamp: string) => {
			const text = renderTicketChangeEntry(records, actor, timestamp);
			return {
				raw_content: text.markdown,
				update_summary: text.summary,
				update_by: actor.kind,
				actor_name: actor.name,
				entry_kind: TICKET_CHANGE_ENTRY_KIND
			};
		};
		const entry = await storage.saveWorklog(configDir, save(startedAt), { customDate: now });
		if (entry.meta.totalParts === 1 && entry.meta.timestamp !== startedAt) {
			await storage.rewriteSinglePartEntry(configDir, entry.meta.partFiles[0], entry.meta.timestamp, save(entry.meta.timestamp));
		}
		ticketChangeCoalescer.invalidate(URI.joinPath(configDir, 'Worklogs').toString());
	});
}
