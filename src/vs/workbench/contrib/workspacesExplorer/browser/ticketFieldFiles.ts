/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, encodeHex } from '../../../../base/common/buffer.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ticketFieldSourceOf, TicketFieldSource } from '../common/ticketChangeLog.js';
import {
	applyTicketFieldReferences, collectTicketFieldReferences, ITicketFieldExternalization, planTicketFieldExternalization,
	resolveTicketFieldReferencesInContent
} from '../common/ticketFieldReferences.js';
import {
	findTicketFieldVersionByHash, formatTicketFieldReference, mayContainTicketFieldReference, parseTicketFieldVersionFileName,
	sanitizeTicketFieldKey, ticketFieldCurrentValueUri, TICKET_FIELD_VERSION_HASH_CHARS, TICKET_FIELD_VERSION_PLAIN_EXTENSION, ticketFieldVersionFileName, ticketFieldVersionRelativePath, ticketFieldVersionsDir
} from '../common/ticketFieldStore.js';

/*
 * Field files of a ticket (CI-50 / CI-51), IO side:
 * - versions: `.agents/fields/<key>.versions/<stamp>_<sha12>.txt.gz` (CI-50),
 * - current values of long fields: `.agents/fields/<key>.txt`, referenced from the field value in ticket.md /
 *   README.md / instruction.md (CI-51, format in `common/ticketFieldStore.ts`).
 *
 * Every READER of those three files resolves the references through {@link resolveTicketFileContent} /
 * {@link readTicketFileResolved}: the resolved text is exactly the text the file had before the value was moved out,
 * so the existing parsers work unchanged. Every WRITER goes through `writeTicketFiles` (ticketChangeRecorder.ts),
 * which splits long values out again.
 */

/** The ticket's `.agents` folder for a file in it (legacy tickets keep ticket.md in the ticket folder itself). */
export function ticketConfigDirOf(fileUri: URI): URI {
	const dir = dirname(fileUri);
	return basename(dir) === '.agents' ? dir : URI.joinPath(dir, '.agents');
}

/** The ticket folder of a ticket file (`<ticket>/.agents/ticket.md` or legacy `<ticket>/ticket.md`). */
export function ticketFolderOfFile(fileUri: URI): URI {
	return dirname(ticketConfigDirOf(fileUri));
}

export async function sha256Hex(text: string): Promise<string> {
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

export async function gunzip(bytes: Uint8Array): Promise<string> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text();
}

async function listFileNames(fileService: IFileService, dir: URI): Promise<string[]> {
	try {
		return ((await fileService.resolve(dir)).children || []).filter(c => !c.isDirectory).map(c => c.name);
	} catch {
		return []; // folder does not exist yet
	}
}

/**
 * Stores a full value as a version of its field (`.agents/fields/<key>.versions/<stamp>_<sha12>.txt.gz`), reusing an
 * existing version with the same hash. With `requireNewest`, an existing version is reused only when it is the newest
 * one (so the newest version always equals the current value file). Returns the full SHA-256 and the path relative to
 * the ticket folder. `fieldKey` overrides the key derived from the field id.
 */
export async function storeTicketFieldVersion(fileService: IFileService, configDir: URI, field: { id: string; label: string; key?: string }, text: string, at: Date, requireNewest = false): Promise<{ hash: string; path: string }> {
	const hash = await sha256Hex(text);
	const key = field.key ?? sanitizeTicketFieldKey(field.id, field.label);
	const dir = ticketFieldVersionsDir(configDir, key);
	const existing = await listFileNames(fileService, dir);
	let reuse = findTicketFieldVersionByHash(existing, hash);
	if (reuse && requireNewest) {
		const stamps = existing.map(n => parseTicketFieldVersionFileName(n)?.stamp).filter((s): s is string => !!s).sort();
		const newest = stamps[stamps.length - 1];
		const prefix = hash.slice(0, TICKET_FIELD_VERSION_HASH_CHARS);
		reuse = existing.find(n => {
			const p = parseTicketFieldVersionFileName(n);
			return p?.hashPrefix === prefix && p.stamp === newest;
		});
	}
	if (reuse) {
		return { hash, path: ticketFieldVersionRelativePath(key, reuse) };
	}
	const compressed = await gzip(text);
	const name = compressed ? ticketFieldVersionFileName(at, hash) : ticketFieldVersionFileName(at, hash, TICKET_FIELD_VERSION_PLAIN_EXTENSION);
	await fileService.writeFile(URI.joinPath(dir, name), compressed ? VSBuffer.wrap(compressed) : VSBuffer.fromString(text));
	return { hash, path: ticketFieldVersionRelativePath(key, name) };
}

// ------------------------------------------------------------------------------------------------
// Read path (CI-51)
// ------------------------------------------------------------------------------------------------

/** Reads current value files by their paths relative to the ticket folder; missing / unreadable files are left out. */
async function readCurrentValues(fileService: IFileService, ticketFolder: URI, paths: Iterable<string>): Promise<Map<string, string>> {
	const values = new Map<string, string>();
	for (const path of new Set(paths)) {
		const uri = URI.joinPath(ticketFolder, ...path.split('/'));
		try {
			values.set(path, (await fileService.readFile(uri)).value.toString());
		} catch {
			console.warn(`[TicketFieldFiles] Referenced field file is missing: ${uri.toString()}`);
		}
	}
	return values;
}

/**
 * Resolves the field references of a ticket file's content (ticket.md / README.md / instruction.md; other files are
 * returned unchanged): every `@file(.agents/fields/<key>.txt) ...` value is replaced by the content of that file.
 * A missing file leaves the reference text in place. The file is the source of truth: a stale `sha256` / `chars` in
 * the reference is ignored (and rewritten on the next save).
 */
export async function resolveTicketFileContent(fileService: IFileService, fileUri: URI, content: string): Promise<string> {
	const source = ticketFieldSourceOf(basename(fileUri));
	if (!source || !mayContainTicketFieldReference(content)) {
		return content;
	}
	return resolveTicketFileContentOf(fileService, source, ticketFolderOfFile(fileUri), content);
}

async function resolveTicketFileContentOf(fileService: IFileService, source: TicketFieldSource, ticketFolder: URI, content: string): Promise<string> {
	const refs = collectTicketFieldReferences(source, content);
	if (refs.length === 0) {
		return content;
	}
	const values = await readCurrentValues(fileService, ticketFolder, refs.map(r => r.ref.path));
	return resolveTicketFieldReferencesInContent(source, content, values);
}

/** Reads a ticket file with its field references resolved. Throws like `readFile` when the file is missing. */
export async function readTicketFileResolved(fileService: IFileService, uri: URI, options?: { length?: number }): Promise<string> {
	const content = (await fileService.readFile(uri, options)).value.toString();
	return resolveTicketFileContent(fileService, uri, content);
}

/** {@link readTicketFileResolved}, or undefined when the file does not exist / cannot be read. */
export async function readTicketFileResolvedIfExists(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		return await readTicketFileResolved(fileService, uri);
	} catch {
		return undefined;
	}
}

// ------------------------------------------------------------------------------------------------
// Write path (CI-51)
// ------------------------------------------------------------------------------------------------

const TRACKED_FILE_NAMES = ['ticket.md', 'README.md', 'instruction.md'];

export interface ITicketFileWritePlanItem {
	readonly uri: URI;
	/** Content as given by the writer. */
	readonly content: string;
	readonly source: TicketFieldSource | undefined;
	/** Persisted content before the write (raw), undefined for a new or untracked file. */
	readonly oldRaw: string | undefined;
	/** Old / new content with every reference resolved (what the change log compares). */
	readonly oldResolved: string | undefined;
	readonly newResolved: string;
	/** What is written: long values replaced by references. */
	finalContent: string;
	readonly externalized: ITicketFieldExternalization[];
}

export interface ITicketFileWritePlan {
	readonly configDir: URI;
	readonly ticketFolder: URI;
	readonly items: ITicketFileWritePlanItem[];
	/** Field keys referenced by the tracked files of the ticket that are not part of this write. */
	readonly otherKeys: Set<string>;
}

async function readRaw(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}

/**
 * Plans a write of one ticket's files: resolves old and new contents and splits the long values of the new contents
 * into current value files. Nothing is written here.
 */
export async function planTicketFileWrites(fileService: IFileService, configDir: URI, writes: readonly { uri: URI; content: string }[]): Promise<ITicketFileWritePlan> {
	const ticketFolder = dirname(configDir);
	const items: ITicketFileWritePlanItem[] = [];
	for (const w of writes) {
		const source = ticketFieldSourceOf(basename(w.uri));
		if (!source) {
			items.push({ uri: w.uri, content: w.content, source, oldRaw: undefined, oldResolved: undefined, newResolved: w.content, finalContent: w.content, externalized: [] });
			continue;
		}
		const oldRaw = await readRaw(fileService, w.uri);
		const oldResolved = oldRaw === undefined ? undefined : await resolveTicketFileContentOf(fileService, source, ticketFolder, oldRaw);
		const newResolved = await resolveTicketFileContentOf(fileService, source, ticketFolder, w.content);
		items.push({ uri: w.uri, content: w.content, source, oldRaw, oldResolved, newResolved, finalContent: newResolved, externalized: [] });
	}

	// Keys claimed by the other tracked files of the ticket (not written now) and by the previous contents.
	const claimed = new Map<string, string>();
	const otherKeys = new Set<string>();
	const written = new Set(items.map(i => i.uri.toString()));
	for (const name of TRACKED_FILE_NAMES) {
		const source = ticketFieldSourceOf(name)!;
		for (const uri of [URI.joinPath(configDir, name), URI.joinPath(ticketFolder, name)]) {
			if (written.has(uri.toString())) {
				break;
			}
			const raw = await readRaw(fileService, uri);
			if (raw === undefined) {
				continue;
			}
			for (const r of collectTicketFieldReferences(source, raw)) {
				claimed.set(r.ref.fieldKey, `${source}:${r.fieldId}`);
				otherKeys.add(r.ref.fieldKey);
			}
			break;
		}
	}
	const previousKeysOf = new Map<ITicketFileWritePlanItem, Map<string, string>>();
	for (const item of items) {
		const previous = new Map<string, string>();
		if (item.source && item.oldRaw !== undefined) {
			for (const r of collectTicketFieldReferences(item.source, item.oldRaw)) {
				previous.set(r.fieldId, r.ref.fieldKey);
				if (!claimed.has(r.ref.fieldKey)) {
					claimed.set(r.ref.fieldKey, `${item.source}:${r.fieldId}`);
				}
			}
		}
		previousKeysOf.set(item, previous);
	}

	for (const item of items) {
		if (!item.source) {
			continue;
		}
		const plan = planTicketFieldExternalization(item.source, item.newResolved, claimed, previousKeysOf.get(item));
		if (plan.length === 0) {
			continue;
		}
		const refs = new Map<string, string>();
		for (const e of plan) {
			refs.set(e.fieldId, formatTicketFieldReference({ fieldKey: e.fieldKey, sha256: await sha256Hex(e.value), chars: e.value.length }));
		}
		item.externalized.push(...plan);
		item.finalContent = applyTicketFieldReferences(item.source, item.newResolved, refs);
	}
	return { configDir, ticketFolder, items, otherKeys };
}

/**
 * Executes a planned write: current value files first (an unchanged file is not rewritten), then the ticket files,
 * then removes current value files that are no longer referenced (versions are kept). When a value file cannot be
 * written, its ticket file is written with the values inline instead.
 */
export async function executeTicketFileWritePlan(fileService: IFileService, plan: ITicketFileWritePlan): Promise<void> {
	for (const item of plan.items) {
		try {
			for (const e of item.externalized) {
				const uri = ticketFieldCurrentValueUri(plan.configDir, e.fieldKey);
				if (await readRaw(fileService, uri) !== e.value) {
					await fileService.writeFile(uri, VSBuffer.fromString(e.value));
				}
			}
		} catch (err) {
			console.warn('[TicketFieldFiles] Failed to write a field value file, keeping the values inline:', err);
			item.finalContent = item.newResolved;
			item.externalized.length = 0;
		}
	}
	for (const item of plan.items) {
		await fileService.writeFile(item.uri, VSBuffer.fromString(item.finalContent));
	}

	// Remove current value files the written files referenced before and nothing references now.
	const referenced = new Set(plan.otherKeys);
	const previous = new Set<string>();
	for (const item of plan.items) {
		if (!item.source) {
			continue;
		}
		collectTicketFieldReferences(item.source, item.finalContent).forEach(r => referenced.add(r.ref.fieldKey));
		if (item.oldRaw !== undefined) {
			collectTicketFieldReferences(item.source, item.oldRaw).forEach(r => previous.add(r.ref.fieldKey));
		}
	}
	for (const key of previous) {
		if (referenced.has(key)) {
			continue;
		}
		try {
			const uri = ticketFieldCurrentValueUri(plan.configDir, key);
			if (await fileService.exists(uri)) {
				await fileService.del(uri);
			}
		} catch (err) {
			console.warn('[TicketFieldFiles] Failed to remove an unreferenced field value file:', err);
		}
	}
}

/** Makes sure the newest version of every externalized value is that value (links current value and history). */
export async function ensureExternalizedVersions(fileService: IFileService, plan: ITicketFileWritePlan, at: Date): Promise<void> {
	for (const item of plan.items) {
		for (const e of item.externalized) {
			await storeTicketFieldVersion(fileService, plan.configDir, { id: e.fieldId, label: e.label, key: e.fieldKey }, e.value, at, true);
		}
	}
}
