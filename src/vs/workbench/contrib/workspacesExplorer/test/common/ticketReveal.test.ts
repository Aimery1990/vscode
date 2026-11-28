/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeTicketRevealPath, describeRevealHiddenByFilter, ticketFolderOf, workspaceFolderOf } from '../../common/ticketReveal.js';

suite('ticketReveal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ws = URI.file('/Users/me/Documents/Dev/Any-Agent-Development');
	const other = URI.file('/Users/me/Documents/Other');

	test('ticket folder: folders stay, ticket files and .agents paths map to their folder', () => {
		const folder = URI.file('/w/ANYAG-0001/ANYAG-0003');
		assert.strictEqual(ticketFolderOf(folder).toString(), folder.toString());
		assert.strictEqual(ticketFolderOf(URI.file('/w/ANYAG-0001/ANYAG-0003/ticket.md')).toString(), folder.toString());
		assert.strictEqual(ticketFolderOf(URI.file('/w/ANYAG-0001/ANYAG-0003/README.md')).toString(), folder.toString());
		assert.strictEqual(ticketFolderOf(URI.file('/w/ANYAG-0001/ANYAG-0003/.agents/ticket.md')).toString(), folder.toString());
		assert.strictEqual(ticketFolderOf(URI.file('/w/ANYAG-0001/ANYAG-0003/.agents')).toString(), folder.toString());
		assert.strictEqual(ticketFolderOf(URI.file('/w/ANYAG-0001/ANYAG-0003/notes.txt')).toString(), URI.file('/w/ANYAG-0001/ANYAG-0003/notes.txt').toString());
	});

	test('workspace folder: a .code-workspace file stands for its folder', () => {
		assert.strictEqual(workspaceFolderOf(URI.file('/w/Dev/Dev.code-workspace')).toString(), URI.file('/w/Dev').toString());
		assert.strictEqual(workspaceFolderOf(ws).toString(), ws.toString());
	});

	test('ancestor path between the workspace and the ticket, top-down', () => {
		const ticket = URI.joinPath(ws, 'ANYAG-0001', 'ANYAG-0003', 'ANYAG-0132');
		const path = computeTicketRevealPath(ticket, [other, ws]);
		assert.ok(path);
		assert.strictEqual(path.workspaceIndex, 1);
		assert.strictEqual(path.ticket.toString(), ticket.toString());
		assert.deepStrictEqual(path.ancestors.map(a => a.toString()), [
			URI.joinPath(ws, 'ANYAG-0001').toString(),
			URI.joinPath(ws, 'ANYAG-0001', 'ANYAG-0003').toString()
		]);
	});

	test('a top-level ticket has no ancestors; a ticket file maps to its folder', () => {
		const path = computeTicketRevealPath(URI.joinPath(ws, 'ANYAG-0001', '.agents', 'ticket.md'), [ws]);
		assert.ok(path);
		assert.strictEqual(path.ticket.toString(), URI.joinPath(ws, 'ANYAG-0001').toString());
		assert.deepStrictEqual(path.ancestors, []);
	});

	test('paths compare without case, like the tree keys', () => {
		const path = computeTicketRevealPath(URI.file('/users/ME/documents/dev/any-agent-development/ANYAG-0001/ANYAG-0003'), [ws]);
		assert.ok(path);
		assert.strictEqual(path.ancestors.length, 1);
	});

	test('the innermost containing workspace wins', () => {
		const inner = URI.joinPath(ws, 'ANYAG-0001');
		const path = computeTicketRevealPath(URI.joinPath(ws, 'ANYAG-0001', 'ANYAG-0003'), [ws, inner]);
		assert.ok(path);
		assert.strictEqual(path.workspaceIndex, 1);
		assert.deepStrictEqual(path.ancestors, []);
	});

	test('a .code-workspace workspace entry contains the tickets of its folder', () => {
		const path = computeTicketRevealPath(URI.file('/w/Dev/ANYAG-0001/ANYAG-0002'), [URI.file('/w/Dev/Dev.code-workspace')]);
		assert.ok(path);
		assert.deepStrictEqual(path.ancestors.map(a => a.toString()), [URI.file('/w/Dev/ANYAG-0001').toString()]);
	});

	test('no workspace contains it, a workspace folder itself, a sibling with a common prefix, another scheme', () => {
		assert.strictEqual(computeTicketRevealPath(URI.file('/elsewhere/ANYAG-0001'), [ws]), undefined);
		assert.strictEqual(computeTicketRevealPath(ws, [ws]), undefined);
		assert.strictEqual(computeTicketRevealPath(URI.file('/Users/me/Documents/Dev/Any-Agent-Development-2/X'), [ws]), undefined);
		assert.strictEqual(computeTicketRevealPath(ws.with({ scheme: 'vscode-remote' }).with({ path: ws.path + '/ANYAG-0001' }), [ws]), undefined);
		assert.strictEqual(computeTicketRevealPath(URI.joinPath(ws, 'A'), []), undefined);
	});

	test('hidden-by-filter hint', () => {
		assert.strictEqual(describeRevealHiddenByFilter('ANYAG-0003'), 'ANYAG-0003 is hidden by the status filter');
	});
});
