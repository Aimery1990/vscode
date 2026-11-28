/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';
import { IWorkspaceLifecycleLike } from '../../common/ticketStatusPicker.js';
import { buildTicketBoard, classifyBoardTestResult, groupLifecycleStatuses, ITicketBoard, OTHER_BOARD_GROUP, parseBoardModeKeys, updateBoardModeKeys } from '../../common/ticketBoardModel.js';

function lifecycle(mapping: { [status: string]: CanonicalStatusCategory }): IWorkspaceLifecycleLike {
	return {
		statuses: Object.keys(mapping),
		getCategory: (status?: string) => (status && Object.entries(mapping).find(([k]) => k.toLowerCase() === status.toLowerCase())?.[1]) || 'Todo'
	};
}

interface IItem { id: string; status?: string; removed?: boolean }

function shape(board: ITicketBoard<IItem>): string[] {
	return board.groups.map(g => `${g.kind}[${g.weight}${g.showStatusHeaders ? '' : ',flat'}]: ${g.columns.map(c => `${c.status}(${c.cards.map(i => i.id).join(',')})`).join(' ')}`);
}

suite('ticketBoardModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ws = lifecycle({ 'Todo': 'Todo', 'In Progress': 'In Progress', 'To be verified': 'In Progress', 'Done': 'Done', 'Blocked': 'Blocked', 'Removed': 'Removed' });

	test('groups children into category -> status columns in canonical and lifecycle order', () => {
		const items: IItem[] = [
			{ id: 'a', status: 'To be verified' },
			{ id: 'b', status: 'todo' },
			{ id: 'c', status: 'In Progress' },
			{ id: 'd', status: 'Blocked' },
			{ id: 'e', status: 'To Be Verified ' },
			{ id: 'f', status: 'Done' }
		];
		const board = buildTicketBoard(items, ws, { showRemoved: false });
		assert.deepStrictEqual(shape(board), [
			'Todo[1,flat]: Todo(b)',
			'In Progress[2]: In Progress(c) To be verified(a,e)',
			'Done[1,flat]: Done(f)',
			'Blocked[1,flat]: Blocked(d)'
		]);
		assert.deepStrictEqual(board.groups.map(g => g.count), [1, 3, 1, 1]);
		assert.strictEqual(board.hiddenRemovedCount, 0);
	});

	test('a single status with another name keeps its header', () => {
		const board = buildTicketBoard([{ id: 'a', status: 'Backlog' }], lifecycle({ 'Backlog': 'Todo', 'Done': 'Done', 'Removed': 'Removed' }), { showRemoved: false });
		assert.deepStrictEqual(shape(board), ['Todo[1]: Backlog(a)', 'In Progress[1]: ', 'Done[1,flat]: Done()', 'Blocked[1]: ']);
	});

	test('Removed is hidden by default and shown on request', () => {
		const items: IItem[] = [{ id: 'a', status: 'Removed' }, { id: 'b', status: 'Cancelled', removed: true }, { id: 'c', status: 'Todo' }];
		const hidden = buildTicketBoard(items, ws, { showRemoved: false });
		assert.ok(!hidden.groups.some(g => g.kind === 'Removed'));
		assert.strictEqual(hidden.hiddenRemovedCount, 2);
		assert.ok(!hidden.groups.some(g => g.kind === OTHER_BOARD_GROUP));

		const shown = buildTicketBoard(items, ws, { showRemoved: true });
		assert.deepStrictEqual(shape(shown).slice(-2), ['Removed[1,flat]: Removed(a)', 'Other[1,flat]: Other(b)']);
		assert.strictEqual(shown.hiddenRemovedCount, 0);
	});

	test('unknown and missing statuses go to a trailing Other group that is not a drop target', () => {
		const board = buildTicketBoard([{ id: 'a', status: 'Weird' }, { id: 'b' }, { id: 'c', status: 'Done' }], ws, { showRemoved: false });
		const last = board.groups[board.groups.length - 1];
		assert.strictEqual(last.kind, OTHER_BOARD_GROUP);
		assert.deepStrictEqual(last.columns.map(c => c.cards.map(i => i.id)), [['a', 'b']]);
		assert.strictEqual(last.columns[0].droppable, false);
		assert.ok(board.groups.slice(0, -1).every(g => g.columns.every(c => c.droppable)));
		assert.strictEqual(board.total, 3);
	});

	test('no Other group when every status is known', () => {
		const board = buildTicketBoard([{ id: 'a', status: 'Done' }], ws, { showRemoved: false });
		assert.deepStrictEqual(board.groups.map(g => g.kind), ['Todo', 'In Progress', 'Done', 'Blocked']);
	});

	test('lifecycle grouping drops duplicate statuses', () => {
		const map = groupLifecycleStatuses({ statuses: ['Todo', 'todo', ' Doing ', 'Done'], getCategory: s => s?.trim() === 'Doing' ? 'In Progress' : s === 'Done' ? 'Done' : 'Todo' });
		assert.deepStrictEqual(map, { 'Todo': ['Todo'], 'In Progress': ['Doing'], 'Done': ['Done'], 'Blocked': [], 'Removed': [] });
	});

	test('test result classification', () => {
		assert.strictEqual(classifyBoardTestResult('Pass'), 'passed');
		assert.strictEqual(classifyBoardTestResult(' `Failed` '), 'failed');
		assert.strictEqual(classifyBoardTestResult('Not Run'), 'notRun');
		assert.strictEqual(classifyBoardTestResult('Blocked'), 'notRun');
		assert.strictEqual(classifyBoardTestResult(undefined), 'notRun');
	});

	test('remembered Board mode keys', () => {
		assert.deepStrictEqual(parseBoardModeKeys(undefined), []);
		assert.deepStrictEqual(parseBoardModeKeys('{bad'), []);
		assert.deepStrictEqual(parseBoardModeKeys('["a", 1, "b"]'), ['a', 'b']);
		assert.deepStrictEqual(updateBoardModeKeys(['a', 'b'], 'a', 'board'), ['b', 'a']);
		assert.deepStrictEqual(updateBoardModeKeys(['a', 'b'], 'a', 'details'), ['b']);
		assert.deepStrictEqual(updateBoardModeKeys(['a', 'b', 'c'], 'd', 'board', 3), ['b', 'c', 'd']);
	});
});
