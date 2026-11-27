/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyStatusFilter, describeHiddenTickets, describeStatusFilter, parseHiddenCategories, resolveHiddenCategories, serializeHiddenCategories, toggleHiddenCategory } from '../../common/ticketVisibility.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';

suite('ticketVisibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const items: { id: string; cat?: CanonicalStatusCategory }[] = [
		{ id: 'todo', cat: 'Todo' },
		{ id: 'doing', cat: 'In Progress' },
		{ id: 'done', cat: 'Done' },
		{ id: 'blocked', cat: 'Blocked' },
		{ id: 'removed', cat: 'Removed' },
		{ id: 'folder' }
	];
	const set = (...c: CanonicalStatusCategory[]) => new Set<CanonicalStatusCategory>(c);

	test('empty hidden set shows everything', () => {
		const res = applyStatusFilter(items, set(), i => i.cat);
		assert.strictEqual(res.hiddenCount, 0);
		assert.deepStrictEqual(res.visible.map(i => i.id), items.map(i => i.id));
	});

	test('hides only the selected categories, keeps order and non-tickets', () => {
		const res = applyStatusFilter(items, set('Done', 'Removed'), i => i.cat);
		assert.strictEqual(res.hiddenCount, 2);
		assert.deepStrictEqual(res.visible.map(i => i.id), ['todo', 'doing', 'blocked', 'folder']);

		const res2 = applyStatusFilter(items, set('Todo', 'Blocked'), i => i.cat);
		assert.strictEqual(res2.hiddenCount, 2);
		assert.deepStrictEqual(res2.visible.map(i => i.id), ['doing', 'done', 'removed', 'folder']);
	});

	test('all categories hidden leaves only non-tickets', () => {
		const res = applyStatusFilter(items, set('Todo', 'In Progress', 'Done', 'Blocked', 'Removed'), i => i.cat);
		assert.strictEqual(res.hiddenCount, 5);
		assert.deepStrictEqual(res.visible.map(i => i.id), ['folder']);
	});

	test('parse / serialize round trip in canonical order', () => {
		assert.strictEqual(serializeHiddenCategories(set('Removed', 'Todo')), '["Todo","Removed"]');
		assert.deepStrictEqual([...parseHiddenCategories('["Removed","Todo"]')].sort(), ['Removed', 'Todo']);
		assert.deepStrictEqual([...parseHiddenCategories('["Done","bogus",3]')], ['Done']);
		assert.strictEqual(parseHiddenCategories('not json').size, 0);
		assert.strictEqual(parseHiddenCategories('{"a":1}').size, 0);
		assert.strictEqual(parseHiddenCategories(undefined).size, 0);
		assert.strictEqual(serializeHiddenCategories(set()), '[]');
	});

	test('migration from the legacy boolean', () => {
		assert.deepStrictEqual([...resolveHiddenCategories(undefined, true)], ['Done', 'Removed']);
		assert.strictEqual(resolveHiddenCategories(undefined, false).size, 0);
		assert.strictEqual(resolveHiddenCategories(undefined, undefined).size, 0);
		// the new key wins over the legacy one
		assert.deepStrictEqual([...resolveHiddenCategories('["Blocked"]', true)], ['Blocked']);
		assert.strictEqual(resolveHiddenCategories('[]', true).size, 0);
	});

	test('toggle returns a new set', () => {
		const a = set('Done');
		const b = toggleHiddenCategory(a, 'Todo');
		const c = toggleHiddenCategory(b, 'Done');
		assert.deepStrictEqual([...a], ['Done']);
		assert.deepStrictEqual([...b].sort(), ['Done', 'Todo']);
		assert.deepStrictEqual([...c], ['Todo']);
	});

	test('hidden count text and tooltip', () => {
		assert.strictEqual(describeHiddenTickets(0), undefined);
		assert.strictEqual(describeHiddenTickets(1), '1 ticket hidden by status filter');
		assert.strictEqual(describeHiddenTickets(3), '3 tickets hidden by status filter');
		assert.strictEqual(describeStatusFilter(set()), 'Filter by status');
		assert.strictEqual(describeStatusFilter(set('Removed', 'Done')), 'Filter by status (hiding: Done, Removed)');
	});
});
