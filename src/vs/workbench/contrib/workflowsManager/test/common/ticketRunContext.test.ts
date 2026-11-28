/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ticketRootFieldValue, ticketRunDescription, ticketRunTitle } from '../../common/ticketRunContext.js';

suite('Ticket run title / description (CI-56)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ticket = { title: 'Git 测试：status / commit', description: 'Fixture of ANYAG-0113', ticketName: 'ANYAG-0118' };

	test('{Title} of a whole-ticket run is the ticket title, not its ID', () => {
		assert.strictEqual(ticketRunTitle({}, {}, ticket), 'Git 测试：status / commit');
	});

	test('an input override or a stored title value still wins', () => {
		assert.strictEqual(ticketRunTitle({ title: 'From RUN_TICKETS' }, {}, ticket), 'From RUN_TICKETS');
		assert.strictEqual(ticketRunTitle({}, { title: 'Stored' }, ticket), 'Stored');
	});

	test('the ticket ID is only the fallback for a ticket without a title', () => {
		assert.strictEqual(ticketRunTitle({}, {}, { ticketName: 'ANYAG-0118' }), 'ANYAG-0118');
		assert.strictEqual(ticketRunTitle({}, {}, { title: '', ticketName: 'ANYAG-0118' }), 'ANYAG-0118');
		assert.strictEqual(ticketRunTitle({}, {}, {}), '');
	});

	test('{Description} of a whole-ticket run is the ticket description', () => {
		assert.strictEqual(ticketRunDescription({}, {}, ticket, ''), 'Fixture of ANYAG-0113');
		assert.strictEqual(ticketRunDescription({ description: 'Override' }, {}, ticket), 'Override');
		assert.strictEqual(ticketRunDescription({}, {}, { ticketName: 'X-1' }, 'Default text'), 'Default text');
	});

	test('single-card run (CI-63): the root Title / Description fields resolve like a whole-ticket run', () => {
		// The ticket page builds {variables} from its fields: an empty Title field must not hide the ticket title
		assert.strictEqual(ticketRootFieldValue('title', {}, ticket), 'Git 测试：status / commit');
		assert.strictEqual(ticketRootFieldValue('description', {}, ticket, ''), 'Fixture of ANYAG-0113');
		assert.strictEqual(`First ${ticketRootFieldValue('title', {}, ticket)}`, 'First Git 测试：status / commit');
		assert.strictEqual(ticketRootFieldValue('title', { title: 'Stored' }, ticket), 'Stored');
		assert.strictEqual(ticketRootFieldValue('title', {}, { ticketName: 'ANYAG-0118' }), 'ANYAG-0118');
		assert.strictEqual(ticketRootFieldValue('description', {}, { ticketName: 'X-1' }, 'Default text'), 'Default text');
		assert.strictEqual(ticketRootFieldValue('commit_step', {}, ticket), undefined);
		assert.strictEqual(ticketRootFieldValue(undefined, {}, ticket), undefined);
	});
});
