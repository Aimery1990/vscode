/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWorkspacePinned, orderByPins, parseWorkspacePins, pinWorkspace, serializeWorkspacePins, unpinWorkspace } from '../../common/workspacePins.js';

suite('workspacePins', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const self = (s: string) => s;

	test('no pins keeps the original order', () => {
		assert.deepStrictEqual(orderByPins(['a', 'b', 'c'], [], self), ['a', 'b', 'c']);
	});

	test('pinned items come first in pin-time order, unpinned keep their order', () => {
		let pins = pinWorkspace([], 'c', 100);
		pins = pinWorkspace(pins, 'a', 200);
		assert.deepStrictEqual(orderByPins(['a', 'b', 'c', 'd'], pins, self), ['c', 'a', 'b', 'd']);
	});

	test('pinning twice keeps the original pin time', () => {
		let pins = pinWorkspace([], 'a', 100);
		pins = pinWorkspace(pins, 'b', 200);
		pins = pinWorkspace(pins, 'a', 300);
		assert.deepStrictEqual(pins, [{ id: 'a', pinnedAt: 100 }, { id: 'b', pinnedAt: 200 }]);
	});

	test('unpin returns the item to its normal position', () => {
		let pins = pinWorkspace([], 'c', 100);
		assert.deepStrictEqual(orderByPins(['a', 'b', 'c'], pins, self), ['c', 'a', 'b']);
		pins = unpinWorkspace(pins, 'c');
		assert.strictEqual(isWorkspacePinned(pins, 'c'), false);
		assert.deepStrictEqual(orderByPins(['a', 'b', 'c'], pins, self), ['a', 'b', 'c']);
	});

	test('stale pins are ignored', () => {
		const pins = [{ id: 'gone', pinnedAt: 1 }, { id: 'b', pinnedAt: 2 }];
		assert.deepStrictEqual(orderByPins(['a', 'b'], pins, self), ['b', 'a']);
	});

	test('works on filtered subsets and objects', () => {
		const items = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
		const pins = [{ id: 'z', pinnedAt: 5 }];
		assert.deepStrictEqual(orderByPins(items.slice(0, 2), pins, i => i.id).map(i => i.id), ['x', 'y']);
		assert.deepStrictEqual(orderByPins(items, pins, i => i.id).map(i => i.id), ['z', 'x', 'y']);
		assert.deepStrictEqual(items.map(i => i.id), ['x', 'y', 'z']);
	});

	test('serialize/parse round trip and tolerance of bad data', () => {
		const pins = [{ id: 'b', pinnedAt: 20 }, { id: 'a', pinnedAt: 10 }];
		assert.deepStrictEqual(parseWorkspacePins(serializeWorkspacePins(pins)), [{ id: 'a', pinnedAt: 10 }, { id: 'b', pinnedAt: 20 }]);
		assert.deepStrictEqual(parseWorkspacePins(undefined), []);
		assert.deepStrictEqual(parseWorkspacePins(''), []);
		assert.deepStrictEqual(parseWorkspacePins('not json'), []);
		assert.deepStrictEqual(parseWorkspacePins('{"id":"a"}'), []);
		assert.deepStrictEqual(
			parseWorkspacePins(JSON.stringify([null, 3, { id: 'a' }, { id: '', pinnedAt: 1 }, { id: 'c', pinnedAt: 'x' }, { id: 'd', pinnedAt: 7 }, { id: 'd', pinnedAt: 4 }])),
			[{ id: 'd', pinnedAt: 4 }]
		);
	});
});
