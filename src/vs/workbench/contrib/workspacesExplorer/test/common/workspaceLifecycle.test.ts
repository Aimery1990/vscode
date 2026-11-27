/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildStatusMigration, categoryMapFromLifecycle, createDefaultCategoryMap, lifecycleFromCategoryMap, migrateStatus, planStatusMigration, readTicketLabels, readTicketStatus, readTopLevelMetadata, recordStatusRename, setTicketLabelsLine, setTicketStatusLine, upsertWorkspaceMetadata, validateCategoryMap } from '../../common/workspaceLifecycle.js';

const WORKSPACE_TICKET = [
	'# WS',
	'',
	'## Overview',
	'',
	'- **Workspace ID**: WS-0000',
	'',
	'### Profile Data',
	'- **Created By**: User',
	'- **Ticket Statuses**: Todo, In Progress, Done, Blocked, Removed',
	'- **Status Mapping**: {"Todo":"Todo","In Progress":"In Progress","Done":"Done","Blocked":"Blocked","Removed":"Removed"}',
	'- **Removed Status**: Removed',
	'- **Last Updated At**: 2026-11-27 12:16',
	'',
	'### Self Defined Data (If any)',
	'- **Self Defined Data Structure**: .agents/entity_type/workspace.yaml',
	'- **Self Defined Data Value**:',
	'  - **Ticket Statuses**: Todo, In Progress, Done, Blocked, Removed',
	'  - **Status Mapping**: {"Todo":"Todo","In Progress":"In Progress","Done":"Done","Blocked":"Blocked","Removed":"Removed"}',
	'  - **Removed Status**: Removed',
	'',
	'- **Current AI Agent**: None',
	'- **Status**: Todo',
	'- **Priority**: Medium',
	''
].join('\n');

suite('workspaceLifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matrix <-> lifecycle round trip keeps the removed status first', () => {
		const map = categoryMapFromLifecycle(
			['Todo', '待拍板', 'In Progress', 'Done', 'Archived', 'Removed'],
			{ 'Todo': 'Todo', '待拍板': 'Todo', 'In Progress': 'In Progress', 'Done': 'Done', 'Archived': 'Removed', 'Removed': 'Removed', 'x': 'Bogus' },
			'Removed'
		);
		assert.deepStrictEqual(map['Todo'], ['Todo', '待拍板']);
		assert.deepStrictEqual(map['Removed'], ['Removed', 'Archived']);
		const config = lifecycleFromCategoryMap(map);
		assert.deepStrictEqual(config.statuses, ['Todo', '待拍板', 'In Progress', 'Done', 'Removed', 'Archived']);
		assert.strictEqual(config.removedStatus, 'Removed');
		assert.strictEqual(config.initialStatus, 'Todo');
		assert.strictEqual(config.mapping['待拍板'], 'Todo');
		// a status with an unknown category lands in Todo
		assert.deepStrictEqual(categoryMapFromLifecycle(['Odd'], { 'Odd': 'Bogus' })['Todo'], ['Odd']);
	});

	test('validation', () => {
		assert.strictEqual(validateCategoryMap(createDefaultCategoryMap()), undefined);
		const noRemoved = createDefaultCategoryMap();
		noRemoved['Removed'] = [];
		assert.ok(validateCategoryMap(noRemoved));
	});

	test('migration plan: renames migrate, removed statuses in use are reported', () => {
		const plan = planStatusMigration(
			['Todo', 'Doing', 'Review', 'Done', 'Removed'],
			['Todo', 'In Progress', 'Done', 'Removed'],
			{ 'Doing': 'In Progress' },
			{ 'todo': 3, 'Doing': 2, 'Review': 1, 'Legacy': 4 }
		);
		assert.deepStrictEqual(plan.renames, { 'Doing': 'In Progress' });
		assert.deepStrictEqual(plan.removedInUse, [{ status: 'Review', count: 1 }]);
		const migration = buildStatusMigration(plan, 'Todo');
		assert.deepStrictEqual(migration, { 'Doing': 'In Progress', 'Review': 'Todo' });
		assert.strictEqual(migrateStatus('doing', migration), 'In Progress');
		assert.strictEqual(migrateStatus('Todo', migration), undefined);
		assert.strictEqual(migrateStatus(undefined, migration), undefined);
		// without a replacement only renames are applied
		assert.deepStrictEqual(buildStatusMigration(plan), { 'Doing': 'In Progress' });
	});

	test('migration plan: unused removals and renamed-then-deleted statuses', () => {
		const plan = planStatusMigration(['A', 'B', 'C'], ['A2'], { 'A': 'A2', 'B': 'B2' }, { 'A': 1, 'B': 2 });
		assert.deepStrictEqual(plan.renames, { 'A': 'A2' });
		assert.deepStrictEqual(plan.removedInUse, [{ status: 'B', count: 2 }]);
	});

	test('rename chains collapse', () => {
		const renames: { [k: string]: string } = {};
		recordStatusRename(renames, 'a', 'b');
		recordStatusRename(renames, 'b', 'c');
		assert.deepStrictEqual(renames, { a: 'c' });
		recordStatusRename(renames, 'c', 'a');
		assert.deepStrictEqual(renames, {});
	});

	test('upsert replaces both places of existing lifecycle lines', () => {
		const out = upsertWorkspaceMetadata(WORKSPACE_TICKET, 'Ticket Statuses', 'Todo, Done, Removed');
		const lines = out.split('\n');
		assert.ok(lines.includes('- **Ticket Statuses**: Todo, Done, Removed'));
		assert.ok(lines.includes('  - **Ticket Statuses**: Todo, Done, Removed'));
		assert.strictEqual(out.split('Todo, In Progress, Done, Blocked, Removed').length, 1);
		assert.strictEqual(lines.length, WORKSPACE_TICKET.split('\n').length);
	});

	test('upsert adds a missing key in both places', () => {
		const out = upsertWorkspaceMetadata(WORKSPACE_TICKET, 'Ticket Labels', '[]');
		const lines = out.split('\n');
		assert.strictEqual(lines[lines.indexOf('- **Removed Status**: Removed') + 1], '- **Ticket Labels**: []');
		assert.strictEqual(lines[lines.indexOf('  - **Removed Status**: Removed') + 1], '  - **Ticket Labels**: []');
		assert.strictEqual(readTopLevelMetadata(out, 'Ticket Labels'), '[]');
		// the ticket's own status is untouched
		assert.strictEqual(readTicketStatus(out), 'Todo');
	});

	test('upsert into a ticket without lifecycle lines and an empty Self Defined Data Value', () => {
		const text = ['### Profile Data', '- **Created By**: User', '- **Last Updated At**: x', '', '### Self Defined Data (If any)', '- **Self Defined Data Structure**: None', '- **Self Defined Data Value**: None', '', '- **Status**: Todo'].join('\n');
		const out = upsertWorkspaceMetadata(text, 'Ticket Labels', '[]').split('\n');
		assert.deepStrictEqual(out, ['### Profile Data', '- **Created By**: User', '- **Ticket Labels**: []', '- **Last Updated At**: x', '', '### Self Defined Data (If any)', '- **Self Defined Data Structure**: None', '- **Self Defined Data Value**:', '  - **Ticket Labels**: []', '', '- **Status**: Todo']);
	});

	test('ticket status and labels lines', () => {
		const ticket = ['- **Self Defined Data Value**:', '  - **Status**: custom', '', '- **Status**: Doing', '- **Priority**: High', '- **Parent Path**: x'].join('\n');
		assert.strictEqual(readTicketStatus(ticket), 'Doing');
		const migrated = setTicketStatusLine(ticket, 'In Progress')!;
		assert.ok(migrated.includes('  - **Status**: custom'));
		assert.ok(migrated.includes('\n- **Status**: In Progress\n'));
		assert.strictEqual(setTicketStatusLine('no status', 'x'), undefined);

		assert.deepStrictEqual(readTicketLabels(ticket), []);
		const withLabels = setTicketLabelsLine(ticket, ['bug', 'ui']);
		assert.deepStrictEqual(withLabels.split('\n').slice(4, 6), ['- **Priority**: High', '- **Labels**: bug, ui']);
		assert.deepStrictEqual(readTicketLabels(withLabels), ['bug', 'ui']);
		const cleared = setTicketLabelsLine(withLabels, []);
		assert.ok(cleared.includes('- **Labels**: None'));
		assert.deepStrictEqual(readTicketLabels(cleared), []);
		// an indented custom field named Labels is not the ticket's labels
		assert.deepStrictEqual(readTicketLabels('  - **Labels**: a'), []);
		// CRLF is preserved
		assert.ok(setTicketLabelsLine('- **Priority**: Low\r\n', ['a']).includes('- **Priority**: Low\r\n- **Labels**: a'));
	});
});
