/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveTicketPageLink, ticketFolderOf } from '../../common/ticketPageLinks.js';

suite('ticketPageLinks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ticket = URI.file('/ws/ANYAG-0001');
	const paths = (href: string, entity = ticket) => {
		const link = resolveTicketPageLink(href, entity);
		return link?.kind === 'file' ? link.candidates.map(c => c.path) : link?.kind;
	};

	test('ticket folder of an entity URI', () => {
		assert.strictEqual(ticketFolderOf(URI.file('/ws/T-1/.agents')).path, '/ws/T-1');
		assert.strictEqual(ticketFolderOf(URI.file('/ws/T-1/.agents/')).path, '/ws/T-1');
		assert.strictEqual(ticketFolderOf(ticket).path, '/ws/ANYAG-0001');
	});

	test('worklog Log File link resolves inside the ticket folder', () => {
		assert.deepStrictEqual(paths('.agents/Worklogs/20261127_run.log'), ['/ws/ANYAG-0001/.agents/Worklogs/20261127_run.log']);
		assert.deepStrictEqual(paths('.agents/Worklogs/x.log', URI.file('/ws/ANYAG-0001/.agents')), ['/ws/ANYAG-0001/.agents/Worklogs/x.log']);
	});

	test('other relative links: ticket folder first, then .agents; query / fragment / encoding handled', () => {
		assert.deepStrictEqual(paths('./attachments/My%20File.pdf#page=2'), ['/ws/ANYAG-0001/attachments/My File.pdf', '/ws/ANYAG-0001/.agents/attachments/My File.pdf']);
		assert.deepStrictEqual(paths('instruction.md'), ['/ws/ANYAG-0001/instruction.md', '/ws/ANYAG-0001/.agents/instruction.md']);
		assert.deepStrictEqual(paths('../ANYAG-0002/README.md?x=1'), ['/ws/ANYAG-0002/README.md', '/ws/ANYAG-0001/ANYAG-0002/README.md']);
	});

	test('absolute and file links', () => {
		assert.deepStrictEqual(paths('/tmp/out.log'), ['/tmp/out.log']);
		assert.deepStrictEqual(paths('file:///tmp/a%20b.txt#L3'), ['/tmp/a b.txt']);
	});

	test('external and empty links', () => {
		assert.strictEqual(paths('https://example.com/a.log'), 'external');
		assert.strictEqual(paths('HTTP://example.com'), 'external');
		assert.strictEqual(paths('mailto:a@b.c'), 'external');
		assert.strictEqual(resolveTicketPageLink('#section', ticket), undefined);
		assert.strictEqual(resolveTicketPageLink('', ticket), undefined);
		assert.strictEqual(resolveTicketPageLink(null, ticket), undefined);
	});
});
