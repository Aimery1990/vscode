/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeOutlineOverscrollRange, outlineWheelDeltaToPixels, resolveOutlineOverscroll } from '../../common/outlineOverscroll.js';

suite('Workflow Outline overscroll', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 5 rows of 28px with a 3px gap: tops 0, 31, 62, 93, 124; first bottom 28, last top 124, content height 152
	const rows = { firstItemBottom: 28, lastItemTop: 124 };

	test('list that fits: can still be pulled until only the last / first item is visible', () => {
		const range = computeOutlineOverscrollRange({ ...rows, nativeMax: 0, windowTop: 0, windowBottom: 200 });
		assert.deepStrictEqual(range, { min: 28 - 200, max: 124 });
	});

	test('list clipped by the bottom editor group: the hidden rows can be pulled up into the visible part', () => {
		// Only the top 60px of the list are on screen
		const range = computeOutlineOverscrollRange({ ...rows, nativeMax: 0, windowTop: 0, windowBottom: 60 });
		assert.strictEqual(range.max, 124);
		assert.strictEqual(range.min, 28 - 60);
		// At max the window [124, 184] contains only the last row [124, 152]
		const pos = resolveOutlineOverscroll(1000, range, 0);
		assert.deepStrictEqual(pos, { position: 124, scrollTop: 0, extra: 124 });
	});

	test('natively scrolling list: native range first, then the forced range', () => {
		const metrics = { ...rows, nativeMax: 52, windowTop: 0, windowBottom: 100 };
		const range = computeOutlineOverscrollRange(metrics);
		assert.deepStrictEqual(range, { min: -72, max: 124 });
		assert.deepStrictEqual(resolveOutlineOverscroll(40, range, 52), { position: 40, scrollTop: 40, extra: 0 });
		assert.deepStrictEqual(resolveOutlineOverscroll(80, range, 52), { position: 80, scrollTop: 52, extra: 28 });
		assert.deepStrictEqual(resolveOutlineOverscroll(-30, range, 52), { position: -30, scrollTop: 0, extra: -30 });
		assert.deepStrictEqual(resolveOutlineOverscroll(-500, range, 52), { position: -72, scrollTop: 0, extra: -72 });
	});

	test('the default position and the whole native range are always allowed', () => {
		// Window below the content (list entirely hidden above the clip), last item above the window
		const range = computeOutlineOverscrollRange({ firstItemBottom: 28, lastItemTop: 20, nativeMax: 80, windowTop: 400, windowBottom: 380 });
		assert.ok(range.min <= 0);
		assert.strictEqual(range.max, 80);
		assert.deepStrictEqual(resolveOutlineOverscroll(0, range, 80), { position: 0, scrollTop: 0, extra: 0 });
		assert.deepStrictEqual(resolveOutlineOverscroll(80, range, 80), { position: 80, scrollTop: 80, extra: 0 });
	});

	test('window starting below the list top (clipped from above)', () => {
		const range = computeOutlineOverscrollRange({ ...rows, nativeMax: 0, windowTop: 20, windowBottom: 120 });
		assert.deepStrictEqual(range, { min: -92, max: 104 });
	});

	test('a shrunk range re-clamps a stored position (expand / collapse, resize)', () => {
		const range = computeOutlineOverscrollRange({ firstItemBottom: 28, lastItemTop: 31, nativeMax: 0, windowTop: 0, windowBottom: 200 });
		assert.deepStrictEqual(resolveOutlineOverscroll(124, range, 0), { position: 31, scrollTop: 0, extra: 31 });
	});

	test('non-finite input falls back to the default position', () => {
		const range = computeOutlineOverscrollRange({ firstItemBottom: NaN, lastItemTop: NaN, nativeMax: NaN, windowTop: 0, windowBottom: 100 });
		assert.deepStrictEqual(range, { min: 0, max: 0 });
		assert.deepStrictEqual(resolveOutlineOverscroll(NaN, range, NaN), { position: 0, scrollTop: 0, extra: 0 });
	});

	test('wheel delta modes', () => {
		assert.strictEqual(outlineWheelDeltaToPixels(10, 0, 16, 300), 10);
		assert.strictEqual(outlineWheelDeltaToPixels(3, 1, 16, 300), 48);
		assert.strictEqual(outlineWheelDeltaToPixels(-1, 2, 16, 300), -300);
		assert.strictEqual(outlineWheelDeltaToPixels(Infinity, 0, 16, 300), 0);
	});
});
