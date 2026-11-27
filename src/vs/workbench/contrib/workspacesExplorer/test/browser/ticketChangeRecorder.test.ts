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
import { ITicketRestoreLifecycle, resolveRestoreStatus } from '../../common/ticketRestore.js';

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
		await writeTicketFile(fileService, readmeMd, README_MD.replace('First', 'Second'), 'User');
		await writeTicketFiles(fileService, [
			{ uri: ticketMd, content: TICKET_MD.replace('hello', 'world') },
			{ uri: readmeMd, content: README_MD.replace('First', 'Third') }
		], 'User');
		let files = await logFiles();
		assert.strictEqual(files.length, 1);
		let records = parseTicketChangeRecords(await readLog(files[0]));
		assert.deepStrictEqual(records.map(r => [r.field, r.old, r.new]).sort(), [['custom:Notes', 'hello', 'world'], ['title', 'First', 'Third']]);

		// reverting the notes drops them from the entry
		await writeTicketFile(fileService, ticketMd, TICKET_MD, 'User');
		records = parseTicketChangeRecords(await readLog(files[0]));
		assert.deepStrictEqual(records.map(r => r.field), ['title']);

		// a narrative entry ends the coalescing
		await new TicketWorklogStorage(fileService).saveWorklog(agents, { user_request: 'x', update_summary: 'narrative', update_by: 'AI Agent' }, { customDate: new Date(Date.now() + 2000) });
		await writeTicketFile(fileService, readmeMd, README_MD.replace('First', 'Fourth'), 'User');
		files = await logFiles();
		assert.strictEqual(files.length, 3);

		// another actor starts a new entry
		await writeTicketFile(fileService, ticketMd, TICKET_MD.replace('Medium', 'Low'), { kind: 'Workflow', name: 'Daily' });
		files = await logFiles();
		assert.strictEqual(files.length, 4);
		const logs = await Promise.all(files.map(async f => readLog(f)));
		const workflowLog = logs.find(l => l.includes('update_by: Workflow'))!;
		assert.ok(workflowLog.includes('actor_name: Daily'));
		assert.deepStrictEqual(parseTicketChangeRecords(workflowLog).map(r => [r.field, r.old, r.new, r.actorName]), [['priority', 'Medium', 'Low', 'Daily']]);
	});

	test('Status / Priority changes are never coalesced, so restore finds the status before removal (UI-19)', async () => {
		const withStatus = (status: string) => TICKET_MD.replace('- **Status**: Todo', `- **Status**: ${status}`);
		await writeTicketFile(fileService, ticketMd, withStatus('In Progress'), 'User');
		await writeTicketFile(fileService, ticketMd, withStatus('Removed'), 'User');
		let files = await logFiles();
		assert.strictEqual(files.length, 2);
		const all = async () => (await Promise.all((await logFiles()).map(async f => parseTicketChangeRecords(await readLog(f))))).flat();
		assert.deepStrictEqual((await all()).map(r => [r.old, r.new]).sort(), [['In Progress', 'Removed'], ['Todo', 'In Progress']]);

		const lifecycle: ITicketRestoreLifecycle = {
			options: [{ status: 'Todo', category: 'Todo' }, { status: 'In Progress', category: 'In Progress' }, { status: 'Done', category: 'Done' }, { status: 'Removed', category: 'Removed' }],
			isRemoved: s => s.toLowerCase() === 'removed',
			fallbackInitialStatus: 'Todo'
		};
		const decision = resolveRestoreStatus(await all(), lifecycle);
		assert.strictEqual(decision.status, 'In Progress');
		assert.strictEqual(decision.source, 'history');

		// a status round trip keeps both entries; a later title edit does not merge into a status entry
		await writeTicketFile(fileService, ticketMd, withStatus('In Progress'), 'User');
		await writeTicketFiles(fileService, [
			{ uri: ticketMd, content: withStatus('Removed').replace('hello', 'world') },
			{ uri: readmeMd, content: README_MD.replace('First', 'Second') }
		], 'User');
		await writeTicketFile(fileService, readmeMd, README_MD.replace('First', 'Third'), 'User');
		files = await logFiles();
		assert.strictEqual(files.length, 5);
		const statusChanges = (await all()).filter(r => r.field === 'status').map(r => `${r.old}->${r.new}`).sort();
		assert.deepStrictEqual(statusChanges, ['In Progress->Removed', 'In Progress->Removed', 'Removed->In Progress', 'Todo->In Progress']);
		assert.strictEqual(resolveRestoreStatus(await all(), lifecycle).status, 'In Progress');
	});

	test('a change set fully reverted within the window removes the entry', async () => {
		await writeTicketFile(fileService, readmeMd, README_MD.replace('First', 'Second'), 'User');
		assert.strictEqual((await logFiles()).length, 1);
		await writeTicketFile(fileService, readmeMd, README_MD, 'User');
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
