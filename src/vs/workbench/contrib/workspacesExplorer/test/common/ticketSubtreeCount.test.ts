/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { countSubtree, describeChildCountPill, isSubtreeNodeVisible, ITicketSubtreeNode, ITicketSubtreeSummary, parseChildCountMode } from '../../common/ticketSubtreeCount.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';

function n(category: CanonicalStatusCategory | undefined, children: ITicketSubtreeNode[] = [], removed = false): ITicketSubtreeNode {
	return { category, removed, children };
}

suite('ticketSubtreeCount', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const none = new Set<CanonicalStatusCategory>();

	test('100 test cases, 20 Done hidden -> 80 visible', () => {
		const children: ITicketSubtreeNode[] = [];
		for (let i = 0; i < 100; i++) {
			children.push(n(i < 20 ? 'Done' : 'Todo'));
		}
		const summary: ITicketSubtreeSummary = { children, truncated: false };
		assert.deepStrictEqual(countSubtree(summary, new Set(['Done']), false), { visible: 80, total: 100, directVisible: 80, directTotal: 100, truncated: false });
		assert.deepStrictEqual(countSubtree(summary, none, false), { visible: 100, total: 100, directVisible: 100, directTotal: 100, truncated: false });
	});

	test('a hidden ticket hides its whole sub-tree; deeper levels are counted', () => {
		const summary: ITicketSubtreeSummary = {
			truncated: false,
			children: [
				n('Todo', [n('Todo', [n('Done'), n('Todo')]), n('Blocked')]), // 1 + (1 + 2) + 1 = 5
				n('Done', [n('Todo'), n('Todo', [n('Todo')])]), // 1 + 3 = 4
				n(undefined) // no status: never hidden
			]
		};
		assert.deepStrictEqual(countSubtree(summary, none, false), { visible: 10, total: 10, directVisible: 3, directTotal: 3, truncated: false });
		// Done hidden: second branch (4) and the nested Done leaf (1) disappear
		assert.deepStrictEqual(countSubtree(summary, new Set(['Done']), false), { visible: 5, total: 10, directVisible: 2, directTotal: 3, truncated: false });
		// Todo hidden: only the status-less ticket and the Done branch root remain visible at top; Done's Todo children hidden
		assert.deepStrictEqual(countSubtree(summary, new Set(['Todo']), false), { visible: 2, total: 10, directVisible: 2, directTotal: 3, truncated: false });
	});

	test('removed tickets follow "show removed items"', () => {
		const summary: ITicketSubtreeSummary = { truncated: true, children: [n('Removed', [n('Todo')], true), n('Todo')] };
		assert.deepStrictEqual(countSubtree(summary, none, false), { visible: 1, total: 1, directVisible: 1, directTotal: 1, truncated: true });
		assert.deepStrictEqual(countSubtree(summary, none, true), { visible: 3, total: 3, directVisible: 2, directTotal: 2, truncated: true });
		assert.strictEqual(isSubtreeNodeVisible(n('Removed', [], true), new Set(), true), true);
		assert.strictEqual(isSubtreeNodeVisible(n('Removed', [], true), new Set(['Removed']), true), false);
	});

	test('mode parsing', () => {
		assert.strictEqual(parseChildCountMode(undefined), 'all');
		assert.strictEqual(parseChildCountMode('bogus'), 'all');
		assert.strictEqual(parseChildCountMode('direct'), 'direct');
		assert.strictEqual(parseChildCountMode('off'), 'off');
	});

	test('pill per mode', () => {
		const counts = { visible: 80, total: 100, directVisible: 10, directTotal: 12, truncated: false };
		assert.deepStrictEqual(describeChildCountPill(counts, 'all'), {
			text: '80',
			tooltip: 'Child tickets (All levels): All levels: 80 visible (100 before filter) · Direct children: 10 visible (12)'
		});
		assert.deepStrictEqual(describeChildCountPill(counts, 'direct'), {
			text: '10',
			tooltip: 'Child tickets (Direct children): Direct children: 10 visible (12) · All levels: 80 visible (100 before filter)'
		});
		assert.strictEqual(describeChildCountPill(counts, 'off'), undefined);
	});

	test('pill: no children -> none; all hidden -> 0; capped -> plus sign', () => {
		assert.strictEqual(describeChildCountPill({ visible: 0, total: 0, directVisible: 0, directTotal: 0, truncated: false }, 'all'), undefined);
		assert.strictEqual(describeChildCountPill({ visible: 0, total: 0, directVisible: 0, directTotal: 0, truncated: false }, 'direct'), undefined);
		assert.strictEqual(describeChildCountPill({ visible: 0, total: 3, directVisible: 0, directTotal: 1, truncated: false }, 'all')?.text, '0');
		const capped = describeChildCountPill({ visible: 5000, total: 5000, directVisible: 40, directTotal: 40, truncated: true }, 'all');
		assert.strictEqual(capped?.text, '5000+');
		assert.ok(capped?.tooltip.endsWith('scan capped, counts are lower bounds'));
		assert.strictEqual(describeChildCountPill({ visible: 5000, total: 5000, directVisible: 40, directTotal: 40, truncated: true }, 'direct')?.text, '40');
	});
});
