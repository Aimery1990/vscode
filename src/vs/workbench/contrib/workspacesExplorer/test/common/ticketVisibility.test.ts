/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyFinishedFilter, describeHiddenTickets, isFinishedCategory } from '../../common/ticketVisibility.js';
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

	test('finished categories', () => {
		assert.deepStrictEqual(['Todo', 'In Progress', 'Done', 'Blocked', 'Removed', undefined].map(c => isFinishedCategory(c as CanonicalStatusCategory | undefined)), [false, false, true, false, true, false]);
	});

	test('filter off shows everything', () => {
		const res = applyFinishedFilter(items, false, i => i.cat);
		assert.strictEqual(res.hiddenCount, 0);
		assert.deepStrictEqual(res.visible.map(i => i.id), items.map(i => i.id));
	});

	test('filter on hides done and removed, keeps order and non-tickets', () => {
		const res = applyFinishedFilter(items, true, i => i.cat);
		assert.strictEqual(res.hiddenCount, 2);
		assert.deepStrictEqual(res.visible.map(i => i.id), ['todo', 'doing', 'blocked', 'folder']);
	});

	test('hidden count text', () => {
		assert.strictEqual(describeHiddenTickets(0), undefined);
		assert.strictEqual(describeHiddenTickets(1), '1 done / removed ticket hidden');
		assert.strictEqual(describeHiddenTickets(3), '3 done / removed tickets hidden');
	});
});
