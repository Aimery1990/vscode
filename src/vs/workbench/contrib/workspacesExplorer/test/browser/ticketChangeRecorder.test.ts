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
import { readTicketFieldVersion, writeTicketFile, writeTicketFiles } from '../../browser/ticketChangeRecorder.js';
import { TicketWorklogStorage } from '../../browser/ticketWorklogStorage.js';

const TICKET_MD = '# T-1\n\n## Overview\n\n- **Workspace ID**: WS-0000\n- **Ticket ID**: WS-0001\n\n### Self Defined Data (If any)\n- **Self Defined Data Value**:\n  - **Notes**: hello\n\n- **Status**: Todo\n- **Priority**: Medium\n';
const README_MD = '# T-1\n\n- **Title**: First\n- **Description**: None\n- **Parent Path**: .\n';

suite('ticketChangeRecorder', () => {
	const disposables = new DisposableStore();
	let fileService: FileService;
	const ticket = URI.from({ scheme: Schemas.inMemory, path: '/ws/WS-0001' });
	const agents = URI.joinPath(ticket, '.agents');
	const ticketMd = URI.joinPath(agents, 'ticket.md');
	const readmeMd = URI.joinPath(agents, 'README.md');

	setup(async () => {
		ticketChangeCoalescer.clear();
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.inMemory, disposables.add(new InMemoryFileSystemProvider())));
		await fileService.writeFile(ticketMd, VSBuffer.fromString(TICKET_MD));
		await fileService.writeFile(readmeMd, VSBuffer.fromString(README_MD));
	});
	teardown(() => {
		ticketChangeCoalescer.clear();
		disposables.clear();
	});
	ensureNoDisposablesAreLeakedInTestSuite();

	async function logFiles(): Promise<string[]> {
		const dir = URI.joinPath(agents, 'Worklogs');
		if (!await fileService.exists(dir)) {
			return [];
		}
		return ((await fileService.resolve(dir)).children || []).map(c => c.name).sort();
	}

	async function readLog(name: string): Promise<string> {
		return (await fileService.readFile(URI.joinPath(agents, 'Worklogs', name))).value.toString();
	}

	test('records a field change with actor, front matter and JSON records', async () => {
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('- **Status**: Todo', '- **Status**: Done'), 'User');
		const files = await logFiles();
		assert.strictEqual(files.length, 1);
		const log = await readLog(files[0]);
		assert.ok(log.includes('update_by: User'));
		assert.ok(log.includes('entry_kind: field_changes'));
		assert.ok(log.includes('- **Status**: `Todo` → `Done`'));
		const records = parseTicketChangeRecords(log);
		assert.deepStrictEqual(records.map(r => [r.field, r.old, r.new, r.actor, r.kind]), [['status', 'Todo', 'Done', 'User', 'inline']]);
		const worklogMd = (await fileService.readFile(URI.joinPath(agents, 'worklog.md'))).value.toString();
		assert.ok(worklogMd.includes(`[${files[0]}]`));
		assert.ok(worklogMd.includes('- **Summary**: Status: Todo → Done'));
	});

	test('no entry for unchanged values, untracked lines or new files', async () => {
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('- **Priority**: Medium', '- **Priority**:   Medium  ') + '\n- **Last Updated By**: AI Agent\n', 'AI Agent');
		await writeTicketFile(fileService, URI.joinPath(agents, 'instruction.md'), '- **Ticket Prompt**: new\n', 'User');
		assert.deepStrictEqual(await logFiles(), []);
	});

	test('consecutive saves of the same actor coalesce into one entry; another entry or actor starts a new one', async () => {
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('Todo', 'Doing'), 'User');
		await writeTicketFiles(fileService, [
			{ uri: ticketMd, content: TICKET_MD.replace('Todo', 'Done') },
			{ uri: readmeMd, content: README_MD.replace('First', 'Second') }
		], 'User');
		let files = await logFiles();
		assert.strictEqual(files.length, 1);
		let records = parseTicketChangeRecords(await readLog(files[0]));
		assert.deepStrictEqual(records.map(r => [r.field, r.old, r.new]).sort(), [['status', 'Todo', 'Done'], ['title', 'First', 'Second']]);

		// reverting the title drops it from the entry
		await writeTicketFile(fileService, readmeMd, README_MD, 'User');
		records = parseTicketChangeRecords(await readLog(files[0]));
		assert.deepStrictEqual(records.map(r => r.field), ['status']);

		// a narrative entry ends the coalescing
		await new TicketWorklogStorage(fileService).saveWorklog(agents, { user_request: 'x', update_summary: 'narrative', update_by: 'AI Agent' }, { customDate: new Date(Date.now() + 2000) });
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('Medium', 'High'), 'User');
		files = await logFiles();
		assert.strictEqual(files.length, 3);

		// another actor starts a new entry
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('Medium', 'Low'), { kind: 'Workflow', name: 'Daily' });
		files = await logFiles();
		assert.strictEqual(files.length, 4);
		const wf = files.map(async f => readLog(f));
		const logs = await Promise.all(wf);
		const workflowLog = logs.find(l => l.includes('update_by: Workflow'))!;
		assert.ok(workflowLog.includes('actor_name: Daily'));
		assert.deepStrictEqual(parseTicketChangeRecords(workflowLog).map(r => [r.field, r.old, r.new, r.actorName]), [['priority', 'High', 'Low', 'Daily']]);
	});

	test('a change set fully reverted within the window removes the entry', async () => {
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('Todo', 'Done'), 'User');
		assert.strictEqual((await logFiles()).length, 1);
		await writeTicketFile(fileService, ticketMd, TICKET_MD, 'User');
		assert.deepStrictEqual(await logFiles(), []);
		const worklogMd = (await fileService.readFile(URI.joinPath(agents, 'worklog.md'))).value.toString();
		assert.ok(!worklogMd.includes('Log File'));
	});

	test('large values are stored as gzip field versions and can be read back', async () => {
		const big = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
		await writeTicketFile(fileService, readmeMd, README_MD.replace('- **Description**: None', `- **Description**: ${big}`), 'AI Agent');
		const records = parseTicketChangeRecords(await readLog((await logFiles())[0]));
		assert.strictEqual(records.length, 1);
		const r = records[0];
		assert.strictEqual(r.kind, 'blob');
		assert.strictEqual(r.oldPath, undefined);
		assert.match(r.newHash!, /^[0-9a-f]{64}$/);
		assert.match(r.newPath!, /^\.agents\/fields\/description\.versions\/\d{8}-\d{6}_[0-9a-f]{12}\.txt\.gz$/);
		assert.ok(r.newPath!.includes(r.newHash!.slice(0, 12)));
		assert.strictEqual(await readTicketFieldVersion(fileService, ticket, r.newPath!), big);

		// same content again (another actor, so a new entry): the version is reused, not written twice
		await writeTicketFile(fileService, readmeMd, README_MD, 'User');
		await writeTicketFile(fileService, readmeMd, README_MD.replace('- **Description**: None', `- **Description**: ${big}`), 'AI Agent');
		const versions = ((await fileService.resolve(URI.joinPath(agents, 'fields', 'description.versions'))).children || []).map(c => c.name);
		assert.strictEqual(versions.length, 1);
		assert.strictEqual(await readTicketFieldVersion(fileService, ticket, '.agents/fields/../ticket.md'), undefined);
	});
});
