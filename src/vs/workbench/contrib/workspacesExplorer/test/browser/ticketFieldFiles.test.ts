/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { parseTicketChangeRecords, ticketChangeCoalescer } from '../../common/ticketChangeLog.js';
import { LONG_TEXT_MIN_BYTES, parseTicketFieldReference, parseTicketFieldVersionFileName } from '../../common/ticketFieldStore.js';
import { readTicketFieldVersion, writeTicketFile } from '../../browser/ticketChangeRecorder.js';
import { readTicketFileResolved, sha256Hex } from '../../browser/ticketFieldFiles.js';
import { externalizeLongTicketFields } from '../../browser/ticketFieldMigration.js';

const LONG_A = 'A'.repeat(LONG_TEXT_MIN_BYTES + 100);
const LONG_B = 'B'.repeat(LONG_TEXT_MIN_BYTES + 200);

function ticketMd(rawCode: string): string {
	return `# T-1\n\n## Overview\n\n- **Workspace ID**: WS-0000\n- **Ticket ID**: WS-0001\n\n### Self Defined Data (If any)\n- **Self Defined Data Value**:\n  - **Raw Code**: ${rawCode}\n  - **Notes**: hello\n\n- **Status**: Todo\n- **Priority**: Medium\n`;
}

suite('ticketFieldFiles (CI-51)', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	const ticket = URI.from({ scheme: Schemas.inMemory, path: '/ws/WS-0001' });
	const agents = URI.joinPath(ticket, '.agents');
	const ticketUri = URI.joinPath(agents, 'ticket.md');
	const readmeUri = URI.joinPath(agents, 'README.md');
	const rawCodeUri = URI.joinPath(agents, 'fields', 'raw_code.txt');

	setup(async () => {
		ticketChangeCoalescer.clear();
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(ticketUri, VSBuffer.fromString(ticketMd('short')));
		await fileService.writeFile(readmeUri, VSBuffer.fromString('# T-1\n\n- **Title**: First\n- **Description**: None\n'));
	});
	teardown(() => {
		ticketChangeCoalescer.clear();
		disposables.clear();
	});
	ensureNoDisposablesAreLeakedInTestSuite();

	const raw = async (uri: URI) => (await fileService.readFile(uri)).value.toString();
	const names = async (dir: URI) => await fileService.exists(dir) ? ((await fileService.resolve(dir)).children || []).map(c => c.name).sort() : [];
	const records = async () => {
		const out = [];
		for (const n of await names(URI.joinPath(agents, 'Worklogs'))) {
			out.push(...parseTicketChangeRecords(await raw(URI.joinPath(agents, 'Worklogs', n))));
		}
		return out;
	};

	test('a long value is split into fields/<key>.txt and resolved on read', async () => {
		await writeTicketFile(fileService, ticketUri, ticketMd(LONG_A), 'User');
		const stored = await raw(ticketUri);
		assert.ok(!stored.includes(LONG_A));
		const ref = parseTicketFieldReference(stored.match(/- \*\*Raw Code\*\*: (.*)/)![1]);
		assert.deepStrictEqual(ref, { path: '.agents/fields/raw_code.txt', fieldKey: 'raw_code', sha256: await sha256Hex(LONG_A), chars: LONG_A.length });
		assert.strictEqual(await raw(rawCodeUri), LONG_A);
		assert.strictEqual(await readTicketFileResolved(fileService, ticketUri), ticketMd(LONG_A));
		// non-ticket files and short values are untouched
		assert.ok(stored.includes('  - **Notes**: hello'));
		// the change log compares resolved values (no reference strings) and the newest version equals the current file
		const recs = await records();
		assert.strictEqual(recs.length, 1);
		assert.strictEqual(recs[0].field, 'custom:Raw Code');
		assert.ok(!JSON.stringify(recs[0]).includes('@file('));
		assert.strictEqual(recs[0].newHash, ref!.sha256);
		assert.strictEqual(await readTicketFieldVersion(fileService, ticket, recs[0].newPath!), LONG_A);
		const versions = (await names(URI.joinPath(agents, 'fields', 'raw_code.versions'))).map(n => parseTicketFieldVersionFileName(n)!);
		const newest = versions.map(v => v.stamp).sort().pop();
		assert.ok(versions.some(v => v.stamp === newest && v.hashPrefix === ref!.sha256.slice(0, 12)));
	});

	test('raw read-modify-write keeps the reference; changing the value rewrites the file; logging diffs resolved values', async () => {
		await writeTicketFile(fileService, ticketUri, ticketMd(LONG_A), 'User');
		// a writer that does not resolve (e.g. a status change on the raw text)
		await writeTicketFile(fileService, ticketUri, (await raw(ticketUri)).replace('Todo', 'Done'), 'User');
		assert.strictEqual(await raw(rawCodeUri), LONG_A);
		assert.ok((await raw(ticketUri)).includes('- **Status**: Done'));
		// a writer that writes the resolved long value
		await writeTicketFile(fileService, ticketUri, (await readTicketFileResolved(fileService, ticketUri)).replace(LONG_A, LONG_B), 'AI Agent');
		assert.strictEqual(await raw(rawCodeUri), LONG_B);
		const recs = await records();
		assert.deepStrictEqual(recs.map(r => r.field), ['custom:Raw Code', 'status', 'custom:Raw Code']);
		assert.strictEqual(recs[2].kind, 'diff');
		assert.strictEqual(await readTicketFieldVersion(fileService, ticket, recs[2].oldPath!), LONG_A);
		assert.strictEqual(await readTicketFieldVersion(fileService, ticket, recs[2].newPath!), LONG_B);
	});

	test('a value that becomes short is inlined again; the current file is removed, versions kept', async () => {
		await writeTicketFile(fileService, ticketUri, ticketMd(LONG_A), 'User');
		await writeTicketFile(fileService, ticketUri, ticketMd('tiny'), 'User');
		assert.strictEqual(await raw(ticketUri), ticketMd('tiny'));
		assert.strictEqual(await fileService.exists(rawCodeUri), false);
		assert.ok((await names(URI.joinPath(agents, 'fields', 'raw_code.versions'))).length >= 1);
	});

	test('a missing field file leaves the reference readable and intact', async () => {
		await writeTicketFile(fileService, ticketUri, ticketMd(LONG_A), 'User');
		const stored = await raw(ticketUri);
		await fileService.del(rawCodeUri);
		assert.strictEqual(await readTicketFileResolved(fileService, ticketUri), stored);
		await writeTicketFile(fileService, ticketUri, stored.replace('Todo', 'Doing'), 'User');
		assert.strictEqual(await raw(ticketUri), stored.replace('Todo', 'Doing'));
	});

	test('README description and instruction prompt are externalized; title never', async () => {
		const desc = '描述'.repeat(1000);
		await writeTicketFile(fileService, readmeUri, `# T-1\n\n- **Title**: ${'T'.repeat(5000)}\n- **Description**: ${desc}\n`, 'User');
		const stored = await raw(readmeUri);
		assert.ok(stored.includes(`- **Title**: ${'T'.repeat(5000)}`));
		assert.ok(stored.includes('- **Description**: @file(.agents/fields/description.txt) sha256:'));
		assert.strictEqual(await raw(URI.joinPath(agents, 'fields', 'description.txt')), desc);
		const instr = URI.joinPath(agents, 'instruction.md');
		await writeTicketFile(fileService, instr, `# I\n\n- **Ticket Prompt**: ${LONG_B}\n`, 'User');
		assert.ok((await raw(instr)).includes('- **Ticket Prompt**: @file(.agents/fields/ticket_prompt.txt)'));
		assert.strictEqual(await readTicketFileResolved(fileService, instr), `# I\n\n- **Ticket Prompt**: ${LONG_B}\n`);
	});

	test('explicit migration: dry run reports, run externalizes without change entries', async () => {
		await fileService.writeFile(ticketUri, VSBuffer.fromString(ticketMd(LONG_A)));
		const plain = URI.from({ scheme: Schemas.inMemory, path: '/ws/plain/README.md' });
		await fileService.writeFile(plain, VSBuffer.fromString(`- **Description**: ${LONG_A}\n`));
		const root = URI.from({ scheme: Schemas.inMemory, path: '/ws' });
		const dry = await externalizeLongTicketFields(fileService, root, { dryRun: true });
		assert.deepStrictEqual(dry.files.map(f => [f.uri.path, f.fields.map(x => x.fieldId)]), [['/ws/WS-0001/.agents/ticket.md', ['custom:Raw Code']]]);
		assert.strictEqual(await raw(ticketUri), ticketMd(LONG_A));
		const run = await externalizeLongTicketFields(fileService, root, { dryRun: false });
		assert.strictEqual(run.fieldCount, 1);
		assert.strictEqual(await raw(rawCodeUri), LONG_A);
		assert.strictEqual(await readTicketFileResolved(fileService, ticketUri), ticketMd(LONG_A));
		assert.deepStrictEqual(await records(), []);
		assert.strictEqual(await raw(plain), `- **Description**: ${LONG_A}\n`);
		assert.strictEqual((await externalizeLongTicketFields(fileService, root, { dryRun: true })).files.length, 0);
	});
});
