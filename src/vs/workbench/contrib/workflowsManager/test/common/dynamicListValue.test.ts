/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildDynamicListContextValue } from '../../common/dynamicListValue.js';

suite('Dynamic List run context value', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const itemFields = [{ id: 'amount', label: 'Amount' }, { id: 'note', label: 'Note' }];

	test('nothing stored or a placeholder gives an empty array', () => {
		for (const raw of [undefined, null, '', '   ', 'None', 'null', 'N/A', '[]']) {
			assert.deepStrictEqual(buildDynamicListContextValue(raw, itemFields), { ok: true, items: [] }, String(raw));
		}
	});

	test('stored JSON text becomes item records keyed by sub-field label, without _index', () => {
		const stored = JSON.stringify([
			{ _index: 1, _title: 'Trip A', Amount: '12', Note: 'taxi' },
			{ _index: 2, Amount: '3.5', Note: '' }
		]);
		assert.deepStrictEqual(buildDynamicListContextValue(stored, itemFields), {
			ok: true,
			items: [
				{ _title: 'Trip A', Amount: '12', Note: 'taxi' },
				{ Amount: '3.5', Note: '' }
			]
		});
	});

	test('an already parsed array is accepted and missing sub-fields are filled with empty text', () => {
		assert.deepStrictEqual(buildDynamicListContextValue([{ _index: 1, Amount: '7' }], itemFields), {
			ok: true,
			items: [{ Amount: '7', Note: '' }]
		});
	});

	test('reusable class items: a value stored under the sub-field id moves to its label, extra keys are kept', () => {
		const stored = '[{"_index":1,"_title":"  ","amount":"9","extra":"x"}]';
		assert.deepStrictEqual(buildDynamicListContextValue(stored, itemFields), {
			ok: true,
			items: [{ Amount: '9', Note: '', extra: 'x' }]
		});
	});

	test('without declared sub-fields the records are kept as stored (minus _index)', () => {
		assert.deepStrictEqual(buildDynamicListContextValue('[{"_index":1,"Name":"Ann"}]'), { ok: true, items: [{ Name: 'Ann' }] });
	});

	test('a single record is wrapped; entries that are not records are kept', () => {
		assert.deepStrictEqual(buildDynamicListContextValue('{"Amount":"1"}', itemFields), { ok: true, items: [{ Amount: '1', Note: '' }] });
		assert.deepStrictEqual(buildDynamicListContextValue(['a', 2], itemFields), { ok: true, items: ['a', 2] });
	});

	test('text that is not a JSON array of items is an error', () => {
		assert.strictEqual(buildDynamicListContextValue('just some text', itemFields).ok, false);
		assert.strictEqual(buildDynamicListContextValue('[{"Amount":', itemFields).ok, false);
		assert.strictEqual(buildDynamicListContextValue(42, itemFields).ok, false);
	});
});
