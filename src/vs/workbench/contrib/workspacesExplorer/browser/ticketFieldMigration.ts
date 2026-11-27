/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ticketFieldSourceOf } from '../common/ticketChangeLog.js';
import { planTicketFieldExternalization } from '../common/ticketFieldReferences.js';
import { writeTicketFile } from './ticketChangeRecorder.js';
import { resolveTicketFileContent } from './ticketFieldFiles.js';

/*
 * One-time explicit migration (CI-51): moves the long inline field values of every ticket of a workspace into
 * `.agents/fields/<key>.txt`. Never run automatically; long values are otherwise externalized lazily on the next save.
 * Rewriting goes through the shared write path (`writeTicketFile`), so values are unchanged and no change entry is
 * recorded.
 */

const TRACKED = ['ticket.md', 'README.md', 'instruction.md'];
const MAX_DEPTH = 12;

export interface ITicketFieldMigrationFile {
	readonly uri: URI;
	readonly fields: readonly { readonly fieldId: string; readonly label: string; readonly chars: number }[];
}

export interface ITicketFieldMigrationSummary {
	readonly ticketFilesScanned: number;
	/** Files with at least one long inline value (to be / that were externalized). */
	readonly files: readonly ITicketFieldMigrationFile[];
	readonly fieldCount: number;
	readonly charCount: number;
	readonly failed: readonly { readonly uri: URI; readonly error: string }[];
}

/** The tracked ticket files (ticket.md / README.md / instruction.md) of every ticket folder below `root` (dot folders skipped). */
export async function collectTicketFiles(fileService: IFileService, root: URI): Promise<URI[]> {
	const result: URI[] = [];
	const visit = async (folder: URI, depth: number): Promise<void> => {
		let children;
		try {
			children = (await fileService.resolve(folder)).children || [];
		} catch {
			return;
		}
		const agents = children.find(c => c.isDirectory && c.name === '.agents');
		let agentsFiles: URI[] = [];
		if (agents) {
			try {
				agentsFiles = ((await fileService.resolve(agents.resource)).children || []).filter(c => !c.isDirectory && TRACKED.includes(c.name)).map(c => c.resource);
			} catch {
				// unreadable .agents folder
			}
		}
		if (agentsFiles.some(u => basename(u) === 'ticket.md')) {
			result.push(...agentsFiles);
		} else if (children.some(c => !c.isDirectory && c.name === 'ticket.md')) {
			// legacy ticket: files in the ticket folder itself (a plain README.md without a ticket.md is never touched)
			result.push(...children.filter(c => !c.isDirectory && TRACKED.includes(c.name)).map(c => c.resource));
		}
		if (depth >= MAX_DEPTH) {
			return;
		}
		for (const c of children) {
			if (c.isDirectory && !c.name.startsWith('.') && !c.name.startsWith('~') && c.name !== 'node_modules') {
				await visit(c.resource, depth + 1);
			}
		}
	};
	await visit(root, 0);
	return result;
}

/**
 * Finds (dry run) or externalizes the long inline values of every ticket file below `root`.
 * `onProgress` receives the number of files handled so far.
 */
export async function externalizeLongTicketFields(fileService: IFileService, root: URI, options: { dryRun: boolean; onProgress?: (done: number, total: number) => void }): Promise<ITicketFieldMigrationSummary> {
	const uris = await collectTicketFiles(fileService, root);
	const files: ITicketFieldMigrationFile[] = [];
	const failed: { uri: URI; error: string }[] = [];
	let fieldCount = 0;
	let charCount = 0;
	for (let i = 0; i < uris.length; i++) {
		const uri = uris[i];
		options.onProgress?.(i, uris.length);
		const source = ticketFieldSourceOf(basename(uri));
		if (!source) {
			continue;
		}
		try {
			const raw = (await fileService.readFile(uri)).value.toString();
			const resolved = await resolveTicketFileContent(fileService, uri, raw);
			// Only values that are still inline count (an already externalized value resolves to its long text but is not inline).
			const inlineLong = planTicketFieldExternalization(source, raw, new Map());
			if (inlineLong.length === 0) {
				continue;
			}
			files.push({ uri, fields: inlineLong.map(e => ({ fieldId: e.fieldId, label: e.label, chars: e.value.length })) });
			fieldCount += inlineLong.length;
			charCount += inlineLong.reduce((n, e) => n + e.value.length, 0);
			if (!options.dryRun) {
				await writeTicketFile(fileService, uri, resolved, 'User');
			}
		} catch (err) {
			failed.push({ uri, error: err instanceof Error ? err.message : String(err) });
		}
	}
	options.onProgress?.(uris.length, uris.length);
	return { ticketFilesScanned: uris.length, files, fieldCount, charCount, failed };
}
