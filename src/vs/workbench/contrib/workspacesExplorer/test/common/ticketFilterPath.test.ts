/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyStatusFilterWithPaths, classifyStatusFilterNode, countMatchingBelow, countTicketsInBranch, describeFilterPathRow } from '../../common/ticketFilterPath.js';
import { ITicketSubtreeNode } from '../../common/ticketSubtreeCount.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';
import { FINISHED_CATEGORIES } from '../../common/ticketVisibility.js';

function n(label: string, category: CanonicalStatusCategory | undefined, children: ITicketSubtreeNode[] = [], removed = false): ITicketSubtreeNode {
	return { label, category, removed, children };
}

/** "Only Done" in the funnel menu = every other category hidden. */
const ONLY_DONE = new Set<CanonicalStatusCategory>(['Todo', 'In Progress', 'Blocked', 'Removed']);
const ONLY_BLOCKED = new Set<CanonicalStatusCategory>(['Todo', 'In Progress', 'Done', 'Removed']);
const HIDE_FINISHED = new Set<CanonicalStatusCategory>(FINISHED_CATEGORIES);

suite('ticketFilterPath (UI-35)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ANYAG-like shape: a Todo job with Todo tasks whose Done test cases sit two levels down
	const deep = n('ANYAG-0001 Components Issues', 'Todo', [
		n('T-10 Task', 'Todo', [n('TC-11', 'Done'), n('TC-12', 'Done'), n('TC-13', 'Todo')]),
		n('T-20 Task', 'In Progress', [n('TC-21', 'Todo')]),
		n('T-30 Task', 'Done', [n('TC-31', 'Done')])
	]);

	test('a match deep under non-matching ancestors makes them path rows', () => {
		assert.strictEqual(countMatchingBelow(deep, ONLY_DONE, false), 4);
		assert.deepStrictEqual(classifyStatusFilterNode(deep, ONLY_DONE, false), { role: 'path', matchingBelow: 4, hiddenTickets: 0 });
		assert.deepStrictEqual(classifyStatusFilterNode(deep.children[0], ONLY_DONE, false), { role: 'path', matchingBelow: 2, hiddenTickets: 0 });
		assert.deepStrictEqual(classifyStatusFilterNode(deep.children[0].children[0], ONLY_DONE, false), { role: 'match', matchingBelow: 0, hiddenTickets: 0 });
	});

	test('a branch without matches is hidden and counts all its tickets', () => {
		assert.deepStrictEqual(classifyStatusFilterNode(deep.children[1], ONLY_DONE, false), { role: 'hidden', matchingBelow: 0, hiddenTickets: 2 });
		assert.deepStrictEqual(classifyStatusFilterNode(deep, new Set(['Todo', 'In Progress', 'Done', 'Removed', 'Blocked']), false), { role: 'hidden', matchingBelow: 0, hiddenTickets: 9 });
		assert.strictEqual(countTicketsInBranch(deep, false), 9);
	});

	test('a matching ancestor with matching descendants stays a match', () => {
		assert.deepStrictEqual(classifyStatusFilterNode(deep.children[2], ONLY_DONE, false), { role: 'match', matchingBelow: 1, hiddenTickets: 0 });
		// Hide Done & Removed: a Done ancestor with an active ticket below is path context
		const doneParent = n('Done epic', 'Done', [n('Done child', 'Done'), n('Active grandchild holder', 'Done', [n('Todo leaf', 'Todo')])]);
		assert.deepStrictEqual(classifyStatusFilterNode(doneParent, HIDE_FINISHED, false), { role: 'path', matchingBelow: 1, hiddenTickets: 0 });
		assert.deepStrictEqual(classifyStatusFilterNode(doneParent.children[0], HIDE_FINISHED, false), { role: 'hidden', matchingBelow: 0, hiddenTickets: 1 });
		// only Blocked
		assert.deepStrictEqual(classifyStatusFilterNode(n('Job', 'Todo', [n('B', 'Blocked')]), ONLY_BLOCKED, false).role, 'path');
		assert.deepStrictEqual(classifyStatusFilterNode(deep, ONLY_BLOCKED, false).role, 'hidden');
	});

	test('removed tickets follow "show removed items"', () => {
		const removed = n('Gone', 'Removed', [n('Done below removed', 'Done')], true);
		// not shown at all: neither a path nor counted as hidden
		assert.deepStrictEqual(classifyStatusFilterNode(removed, ONLY_DONE, false), { role: 'hidden', matchingBelow: 0, hiddenTickets: 0 });
		assert.strictEqual(countMatchingBelow(n('Job', 'Todo', [removed]), ONLY_DONE, false), 0);
		// show removed items: the removed ticket is a path to its Done child
		assert.deepStrictEqual(classifyStatusFilterNode(removed, ONLY_DONE, true), { role: 'path', matchingBelow: 1, hiddenTickets: 0 });
		// selecting Removed: the removed ticket matches itself
		assert.deepStrictEqual(classifyStatusFilterNode(removed, new Set(['Todo', 'In Progress', 'Done', 'Blocked']), true).role, 'match');
		// Hide Done & Removed with show removed items: hidden branch counts both tickets
		assert.deepStrictEqual(classifyStatusFilterNode(removed, HIDE_FINISHED, true), { role: 'hidden', matchingBelow: 0, hiddenTickets: 2 });
	});

	test('one tree level: visible items, verdicts and the hidden count', () => {
		interface Item { name: string; category?: CanonicalStatusCategory; node?: ITicketSubtreeNode }
		const items: Item[] = [
			{ name: 'folder' }, // plain folder: always shown
			{ name: 'job', category: 'Todo', node: deep },
			{ name: 'busy', category: 'In Progress', node: deep.children[1] },
			{ name: 'unscanned todo', category: 'Todo' }, // no summary node yet: own status decides
			{ name: 'unscanned done', category: 'Done' },
			{ name: 'done', category: 'Done', node: deep.children[2] }
		];
		const result = applyStatusFilterWithPaths(items, ONLY_DONE, false, i => i.category, i => i.node);
		assert.deepStrictEqual(result.visible.map(i => i.name), ['folder', 'job', 'unscanned done', 'done']);
		assert.deepStrictEqual(result.visible.map(i => result.verdicts.get(i)?.role), [undefined, 'path', 'match', 'match']);
		// busy branch (2 tickets) + the unscanned Todo (1)
		assert.strictEqual(result.hiddenCount, 3);
		// the row's own (fresher) status wins over the summary node's
		const fresher = applyStatusFilterWithPaths([{ name: 'x', category: 'Done' as CanonicalStatusCategory, node: deep.children[1] }], ONLY_DONE, false, i => i.category, i => i.node);
		assert.strictEqual(fresher.verdicts.get(fresher.visible[0])?.role, 'match');
		// nothing hidden: everything visible, no verdicts
		const all = applyStatusFilterWithPaths(items, new Set(), false, i => i.category, i => i.node);
		assert.strictEqual(all.visible.length, items.length);
		assert.strictEqual(all.hiddenCount, 0);
		assert.strictEqual(all.verdicts.size, 0);
	});

	test('path row tooltip', () => {
		assert.strictEqual(describeFilterPathRow('Todo', 12), 'Status Todo — shown because 12 tickets below match the filter');
		assert.strictEqual(describeFilterPathRow('Done', 1), 'Status Done — shown because 1 ticket below matches the filter');
	});
});
