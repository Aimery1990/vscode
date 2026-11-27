/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coerceTicketLabelsInput, getLabelColor, LABEL_COLOR_PALETTE, NEUTRAL_LABEL_COLOR, nextLabelColor, normalizeLabelDefinitions, parseLabelDefinitions, parseTicketLabels, renameTicketLabels, sanitizeLabelName, serializeLabelDefinitions, serializeTicketLabels, toggleTicketLabel } from '../../common/ticketLabels.js';

suite('ticketLabels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('label definitions round trip', () => {
		const defs = [{ name: '待拍板', color: '#F59E0B' }, { name: 'bug', color: '#ef4444' }];
		const raw = serializeLabelDefinitions(defs);
		assert.strictEqual(raw, '[{"name":"待拍板","color":"#f59e0b"},{"name":"bug","color":"#ef4444"}]');
		assert.deepStrictEqual(parseLabelDefinitions(raw), [{ name: '待拍板', color: '#f59e0b' }, { name: 'bug', color: '#ef4444' }]);
	});

	test('label definitions tolerate bad data', () => {
		assert.deepStrictEqual(parseLabelDefinitions(undefined), []);
		assert.deepStrictEqual(parseLabelDefinitions('None'), []);
		assert.deepStrictEqual(parseLabelDefinitions('[not json'), []);
		// duplicates (case-insensitive) dropped, bad colors replaced by a free palette color, names sanitized
		assert.deepStrictEqual(
			parseLabelDefinitions(JSON.stringify([{ name: 'A', color: LABEL_COLOR_PALETTE[0] }, { name: 'a', color: '#000000' }, { name: ' x,y ', color: 'red' }, { color: '#111111' }, null, 'plain'])),
			[{ name: 'A', color: LABEL_COLOR_PALETTE[0] }, { name: 'x y', color: LABEL_COLOR_PALETTE[1] }, { name: 'plain', color: LABEL_COLOR_PALETTE[2] }]
		);
		// hand-written comma list
		assert.deepStrictEqual(parseLabelDefinitions('ui, backend').map(d => d.name), ['ui', 'backend']);
	});

	test('ticket labels parse / serialize', () => {
		assert.deepStrictEqual(parseTicketLabels('a, b ,A，c'), ['a', 'b', 'c']);
		assert.deepStrictEqual(parseTicketLabels('None'), []);
		assert.deepStrictEqual(parseTicketLabels(''), []);
		assert.strictEqual(serializeTicketLabels([]), 'None');
		assert.strictEqual(serializeTicketLabels(['x', ' y ', 'X']), 'x, y');
	});

	test('coerce tool input', () => {
		assert.deepStrictEqual(coerceTicketLabelsInput(['bug', 'Bug', 'ui']), ['bug', 'ui']);
		assert.deepStrictEqual(coerceTicketLabelsInput('bug, ui'), ['bug', 'ui']);
		assert.deepStrictEqual(coerceTicketLabelsInput(undefined), []);
		assert.throws(() => coerceTicketLabelsInput([1, 2]));
		assert.throws(() => coerceTicketLabelsInput({ a: 1 }));
	});

	test('colors, toggling and renames', () => {
		const defs = normalizeLabelDefinitions([{ name: 'bug', color: '#ef4444' }]);
		assert.strictEqual(getLabelColor(defs, 'BUG'), '#ef4444');
		assert.strictEqual(getLabelColor(defs, 'other'), NEUTRAL_LABEL_COLOR);
		assert.strictEqual(nextLabelColor(defs), LABEL_COLOR_PALETTE[1]);
		assert.deepStrictEqual(toggleTicketLabel(['a'], 'b'), ['a', 'b']);
		assert.deepStrictEqual(toggleTicketLabel(['a', 'b'], 'A'), ['b']);
		assert.deepStrictEqual(renameTicketLabels(['a', 'b'], { A: 'z' }), ['z', 'b']);
		assert.strictEqual(renameTicketLabels(['a'], { q: 'z' }), undefined);
		assert.strictEqual(sanitizeLabelName('**x**\ny'), 'x y');
	});
});
