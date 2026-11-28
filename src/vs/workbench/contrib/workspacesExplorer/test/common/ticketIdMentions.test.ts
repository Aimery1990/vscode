/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findTicketIdMentions, isTicketId, splitTicketIdMentions, ticketIdMentionAt, uniqueTicketIds } from '../../common/ticketIdMentions.js';

suite('ticketIdMentions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ids = (text: string, skipCode?: boolean) => findTicketIdMentions(text, { skipCode }).map(m => m.id);

	test('finds IDs of different prefixes with their offsets', () => {
		const text = 'See ANYAG-0115 and FINDJ-3436, DEMOW-0002.';
		assert.deepStrictEqual(findTicketIdMentions(text), [
			{ id: 'ANYAG-0115', start: 4, end: 14 },
			{ id: 'FINDJ-3436', start: 19, end: 29 },
			{ id: 'DEMOW-0002', start: 31, end: 41 },
		]);
	});

	test('Chinese punctuation and full-width brackets around the ID', () => {
		assert.deepStrictEqual(ids('素材在 ANYAG-0115、ANYAG-0116 下面。'), ['ANYAG-0115', 'ANYAG-0116']);
		assert.deepStrictEqual(ids('素材在ANYAG-0115下面。'), ['ANYAG-0115']);
		assert.deepStrictEqual(ids('打开 ANYAG-0120「审核测试：Review」'), ['ANYAG-0120']);
		assert.deepStrictEqual(ids('（ANYAG-0122）和《ANYAG-0123》，ANYAG-0124；ANYAG-0125！'), ['ANYAG-0122', 'ANYAG-0123', 'ANYAG-0124', 'ANYAG-0125']);
	});

	test('boundaries: glued letters, digits, underscores and dashes are not mentions', () => {
		assert.deepStrictEqual(ids('xANYAG-0115 ANYAG-0115x ANYAG-0115_1 my_ANYAG-0115 a-ANYAG-0115 9ANYAG-0115'), []);
		assert.deepStrictEqual(ids('anyag-0115 ANYAG-01 A-0115 ABCDEFGHIJK-0001'), [], 'lower case, too few digits, too short or too long prefix');
		assert.deepStrictEqual(ids('ANYAG-0115.'), ['ANYAG-0115']);
		assert.deepStrictEqual(ids('ANYAG-0001/ANYAG-0003/ANYAG-0132'), ['ANYAG-0001', 'ANYAG-0003', 'ANYAG-0132'], 'parent paths');
		assert.deepStrictEqual(ids('(ANYAG-0115) [ANYAG-0116] "ANYAG-0117" \'ANYAG-0118\''), ['ANYAG-0115', 'ANYAG-0116', 'ANYAG-0117', 'ANYAG-0118']);
		assert.deepStrictEqual(ids('ANYAG-123456 and A1-999'), ['ANYAG-123456', 'A1-999']);
	});

	test('IDs inside URLs are not mentions', () => {
		assert.deepStrictEqual(ids('https://jira.example.com/browse/ANYAG-0115 and ANYAG-0116'), ['ANYAG-0116']);
		assert.deepStrictEqual(ids('见 http://x.cn/ANYAG-0115。ANYAG-0117'), ['ANYAG-0117']);
		assert.deepStrictEqual(ids('www.example.com/ANYAG-0115'), []);
		assert.deepStrictEqual(ids('file:///Users/a/ANYAG-0115/ticket.md'), []);
		assert.deepStrictEqual(ids('[link](https://x.io/ANYAG-0115) ANYAG-0118'), ['ANYAG-0118']);
	});

	test('IDs inside markdown code are not mentions unless code is allowed', () => {
		assert.deepStrictEqual(ids('run `ANYAG-0115` then ANYAG-0116'), ['ANYAG-0116']);
		assert.deepStrictEqual(ids('```\nANYAG-0115\n```\nANYAG-0116'), ['ANYAG-0116']);
		assert.deepStrictEqual(ids('```\nANYAG-0115 unterminated'), []);
		assert.deepStrictEqual(ids('run `ANYAG-0115`', false), ['ANYAG-0115']);
	});

	test('dedupe keeps the order of first appearance', () => {
		assert.deepStrictEqual(uniqueTicketIds(findTicketIdMentions('ANYAG-0120, ANYAG-0122, ANYAG-0120 again, ANYAG-0122')), ['ANYAG-0120', 'ANYAG-0122']);
		assert.deepStrictEqual(uniqueTicketIds([]), []);
	});

	test('mention under the caret (Cmd/Ctrl+click in a text box)', () => {
		const text = '素材在 ANYAG-0115、ANYAG-0116 下面。';
		assert.strictEqual(ticketIdMentionAt(text, 4)?.id, 'ANYAG-0115', 'caret right before');
		assert.strictEqual(ticketIdMentionAt(text, 9)?.id, 'ANYAG-0115', 'caret inside');
		assert.strictEqual(ticketIdMentionAt(text, 14)?.id, 'ANYAG-0115', 'caret right after');
		assert.strictEqual(ticketIdMentionAt(text, 20)?.id, 'ANYAG-0116');
		assert.strictEqual(ticketIdMentionAt(text, 1), undefined);
		assert.strictEqual(ticketIdMentionAt(text, -1), undefined);
		assert.strictEqual(ticketIdMentionAt(text, 999), undefined);
	});

	test('split a text at the accepted (known) mentions only', () => {
		const known = new Set(['ANYAG-0115']);
		assert.deepStrictEqual(splitTicketIdMentions('a ANYAG-0115、ANYAG-9999 b', id => known.has(id)), [
			{ kind: 'text', text: 'a ' },
			{ kind: 'mention', text: 'ANYAG-0115', id: 'ANYAG-0115' },
			{ kind: 'text', text: '、ANYAG-9999 b' },
		]);
		assert.deepStrictEqual(splitTicketIdMentions('ANYAG-0115', id => known.has(id)), [{ kind: 'mention', text: 'ANYAG-0115', id: 'ANYAG-0115' }]);
		assert.strictEqual(splitTicketIdMentions('only ANYAG-9999', id => known.has(id)), undefined, 'unknown IDs stay plain text');
		assert.strictEqual(splitTicketIdMentions('', () => true), undefined);
	});

	test('isTicketId', () => {
		assert.ok(isTicketId('ANYAG-0115'));
		assert.ok(!isTicketId(' ANYAG-0115'));
		assert.ok(!isTicketId('ANYAG-0115x'));
	});
});
