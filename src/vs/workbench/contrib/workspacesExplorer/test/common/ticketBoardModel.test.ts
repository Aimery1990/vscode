/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';
import { IWorkspaceLifecycleLike } from '../../common/ticketStatusPicker.js';
import { boardCategoryOffersCreate, buildTicketBoard, classifyBoardTestResult, cleanAgentName, collectBoardLabels, countSubtasks, describeBoardCardMeta, describeBoardPriority, filterBoardCards, groupLifecycleStatuses, isBoardFilterActive, ITicketBoard, OTHER_BOARD_GROUP, parseBoardModeKeys, pluralize, updateBoardModeKeys } from '../../common/ticketBoardModel.js';

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

	test('only Todo columns offer create (UI-25)', () => {
		const multi = lifecycle({ 'Backlog': 'Todo', 'Todo': 'Todo', 'In Progress': 'In Progress', 'Done': 'Done', 'Blocked': 'Blocked', 'Removed': 'Removed' });
		const board = buildTicketBoard([{ id: 'a', status: 'Weird' }, { id: 'b', status: 'Removed' }], multi, { showRemoved: true });
		const offers = board.groups.flatMap(g => g.columns.filter(c => c.canCreate).map(c => c.status));
		assert.deepStrictEqual(offers, ['Backlog', 'Todo']);
		assert.ok(board.groups.filter(g => g.kind !== 'Todo').every(g => g.columns.every(c => !c.canCreate)));

		// hiding empty statuses keeps the flag on the remaining Todo column
		const compact = buildTicketBoard([{ id: 'a', status: 'Todo' }, { id: 'c', status: 'Done' }], multi, { showRemoved: false, showEmptyStatuses: false });
		assert.deepStrictEqual(compact.groups.map(g => `${g.kind}:${g.columns.map(c => `${c.status}=${c.canCreate}`).join(',')}`), ['Todo:Todo=true', 'Done:Done=false']);

		assert.deepStrictEqual(['Todo', 'In Progress', 'Done', 'Blocked', 'Removed', OTHER_BOARD_GROUP].map(k => boardCategoryOffersCreate(k as Parameters<typeof boardCategoryOffersCreate>[0])), [true, false, false, false, false, false]);
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

	test('Show empty statuses off drops empty columns and empty categories', () => {
		const board = buildTicketBoard([{ id: 'a', status: 'To be verified' }, { id: 'b', status: 'Todo' }], ws, { showRemoved: false, showEmptyStatuses: false });
		assert.deepStrictEqual(shape(board), ['Todo[1,flat]: Todo(b)', 'In Progress[1]: To be verified(a)']);
	});

	test('filter by title / ID and by labels', () => {
		const cards = [
			{ ticketId: 'ANYAG-0004', title: 'CI-29 tts', labels: ['Decision'] },
			{ ticketId: 'ANYAG-0130', title: 'Auto test all', labels: ['Dev', 'Verify'] },
			{ ticketId: 'ANYAG-0002', title: 'git component', labels: [] }
		];
		assert.deepStrictEqual(filterBoardCards(cards, {}).length, 3);
		assert.deepStrictEqual(filterBoardCards(cards, { query: '  0130 ' }).map(c => c.ticketId), ['ANYAG-0130']);
		assert.deepStrictEqual(filterBoardCards(cards, { query: 'GIT' }).map(c => c.ticketId), ['ANYAG-0002']);
		assert.deepStrictEqual(filterBoardCards(cards, { labels: ['verify', 'decision'] }).map(c => c.ticketId), ['ANYAG-0004', 'ANYAG-0130']);
		assert.deepStrictEqual(filterBoardCards(cards, { query: 'ci-29', labels: ['Dev'] }), []);
		assert.strictEqual(isBoardFilterActive({ query: ' ', labels: [] }), false);
		assert.strictEqual(isBoardFilterActive({ labels: ['Dev'] }), true);
		assert.deepStrictEqual(collectBoardLabels(cards, ['dev', 'Bug']), ['Decision', 'Dev', 'Verify', 'Bug']);
	});

	test('subtask counts skip removed children', () => {
		assert.deepStrictEqual(countSubtasks([]), { done: 0, total: 0 });
		assert.deepStrictEqual(countSubtasks([
			{ category: 'Done', removed: false },
			{ category: 'Todo', removed: false },
			{ category: 'In Progress', removed: false },
			{ category: 'Done', removed: false },
			{ category: 'Removed', removed: true },
			{ category: undefined, removed: false }
		]), { done: 2, total: 5 });
	});

	test('priority and card footer text', () => {
		assert.deepStrictEqual(describeBoardPriority('High'), { text: 'High priority', tone: 'high' });
		assert.deepStrictEqual(describeBoardPriority('Very High'), { text: 'Very High priority', tone: 'high' });
		assert.deepStrictEqual(describeBoardPriority(undefined), { text: 'Medium priority', tone: 'muted' });
		assert.deepStrictEqual(describeBoardPriority('Low'), { text: 'Low priority', tone: 'muted' });
		const none = { done: 0, total: 0 };
		assert.deepStrictEqual(describeBoardCardMeta({ failure: { reasons: ['x'] }, subtasks: { done: 1, total: 2 } }), { kind: 'runFailed', text: 'Run failed' });
		assert.deepStrictEqual(describeBoardCardMeta({ failure: { reasons: ['x'] }, testResult: 'failed', subtasks: none }), { kind: 'testFailed', text: 'Test failed' });
		assert.deepStrictEqual(describeBoardCardMeta({ testResult: 'passed', subtasks: none }), { kind: 'testPassed', text: 'Test passed' });
		assert.deepStrictEqual(describeBoardCardMeta({ testResult: 'notRun', subtasks: none }), { kind: 'testNotRun', text: 'Not run' });
		assert.deepStrictEqual(describeBoardCardMeta({ subtasks: { done: 2, total: 4 } }), { kind: 'subtasks', text: '2 / 4 subtasks' });
		assert.deepStrictEqual(describeBoardCardMeta({ subtasks: { done: 0, total: 1 } }), { kind: 'subtasks', text: '0 / 1 subtask' });
		assert.deepStrictEqual(describeBoardCardMeta({ subtasks: none }), { kind: 'none', text: '' });
		assert.strictEqual(pluralize(1, 'status', 'statuses'), '1 status');
		assert.strictEqual(pluralize(3, 'status', 'statuses'), '3 statuses');
		assert.strictEqual(cleanAgentName(' None '), undefined);
		assert.strictEqual(cleanAgentName('`Coder`'), 'Coder');
	});
});
