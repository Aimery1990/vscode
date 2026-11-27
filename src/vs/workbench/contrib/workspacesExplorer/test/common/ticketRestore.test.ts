/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITicketChangeRecord, parseTicketChangeRecords, renderTicketChangeEntry } from '../../common/ticketChangeLog.js';
import { describeRestoreDecision, findLatestRemoval, initialStatusOf, ITicketRestoreLifecycle, resolveRestoreStatus, statusChangeRecordsNewestFirst } from '../../common/ticketRestore.js';
import { IStatusOption } from '../../common/ticketStatusPicker.js';

function rec(old: string, next: string, at: string, field = 'status'): ITicketChangeRecord {
	return { field, label: field === 'status' ? 'Status' : field, source: 'ticket.md', actor: 'User', at, kind: 'inline', old, new: next };
}

const OPTIONS: IStatusOption[] = [
	{ status: 'Backlog', category: 'Todo' },
	{ status: 'In Dev', category: 'In Progress' },
	{ status: 'Released', category: 'Done' },
	{ status: 'On Hold', category: 'Blocked' },
	{ status: 'Dropped', category: 'Removed' },
	{ status: 'Archived', category: 'Removed' }
];
const REMOVED = new Set(['dropped', 'archived', 'removed']);
const LIFECYCLE: ITicketRestoreLifecycle = { options: OPTIONS, isRemoved: s => REMOVED.has(s.trim().toLowerCase()), fallbackInitialStatus: 'Todo' };

suite('ticketRestore (UI-19)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('restores the status before the latest removal', () => {
		const records = [
			rec('Backlog', 'In Dev', '2026-11-20T10:00:00Z'),
			rec('In Dev', 'Dropped', '2026-11-21T10:00:00Z'),
			rec('Dropped', 'Backlog', '2026-11-22T10:00:00Z'),
			rec('Backlog', 'On Hold', '2026-11-23T10:00:00Z'),
			rec('On Hold', 'Dropped', '2026-11-24T10:00:00Z'),
			rec('High', 'Low', '2026-11-25T10:00:00Z', 'priority')
		];
		// input order does not matter
		const decision = resolveRestoreStatus([...records].reverse(), LIFECYCLE);
		assert.deepStrictEqual(decision, { status: 'On Hold', source: 'history', previousStatus: 'On Hold', removedAt: '2026-11-24T10:00:00Z' });
		assert.strictEqual(describeRestoreDecision(decision), 'Restored to On Hold');
		assert.strictEqual(describeRestoreDecision(decision, 'Fix login'), `Restored 'Fix login' to On Hold`);
	});

	test('uses the lifecycle spelling of the previous status', () => {
		assert.strictEqual(resolveRestoreStatus([rec('in dev', 'dropped', '2026-11-21T10:00:00Z')], LIFECYCLE).status, 'In Dev');
	});

	test('a coalesced entry keeps the first old value', () => {
		// Backlog -> In Dev -> Dropped saved within the coalescing window is one record Backlog -> Dropped
		const text = renderTicketChangeEntry([rec('Backlog', 'Dropped', '2026-11-21T10:04:00Z')], { kind: 'User' }, '2026-11-21 10:00:00 -05:00').markdown;
		const decision = resolveRestoreStatus(parseTicketChangeRecords(text), LIFECYCLE);
		assert.strictEqual(decision.status, 'Backlog');
		assert.strictEqual(decision.source, 'history');
	});

	test('removed -> removed changes are skipped in favour of an older removal from an active status', () => {
		const records = [
			rec('In Dev', 'Dropped', '2026-11-21T10:00:00Z'),
			rec('Dropped', 'Archived', '2026-11-22T10:00:00Z')
		];
		assert.deepStrictEqual(findLatestRemoval(records, LIFECYCLE.isRemoved), { previousStatus: 'In Dev', removedStatus: 'Dropped', at: '2026-11-21T10:00:00Z' });
		assert.strictEqual(resolveRestoreStatus(records, LIFECYCLE).status, 'In Dev');
	});

	test('falls back to the initial status when no removal is recorded', () => {
		for (const records of [[], [rec('Backlog', 'In Dev', '2026-11-21T10:00:00Z')], [rec('', 'Dropped', '2026-11-21T10:00:00Z')]]) {
			const decision = resolveRestoreStatus(records, LIFECYCLE);
			assert.deepStrictEqual(decision, { status: 'Backlog', source: 'initial', fallbackReason: 'no_record' });
			assert.strictEqual(describeRestoreDecision(decision), 'Restored to Backlog (no previous status found)');
		}
	});

	test('falls back when the previous status is a removed status', () => {
		const decision = resolveRestoreStatus([rec('Archived', 'Dropped', '2026-11-21T10:00:00Z')], LIFECYCLE);
		assert.deepStrictEqual(decision, { status: 'Backlog', source: 'initial', fallbackReason: 'removed_status', previousStatus: 'Archived', removedAt: '2026-11-21T10:00:00Z' });
		assert.match(describeRestoreDecision(decision), /is a removed status/);
	});

	test('falls back when the previous status is no longer in the lifecycle', () => {
		const decision = resolveRestoreStatus([rec('In Review', 'Dropped', '2026-11-21T10:00:00Z')], LIFECYCLE);
		assert.deepStrictEqual(decision, { status: 'Backlog', source: 'initial', fallbackReason: 'not_in_lifecycle', previousStatus: 'In Review', removedAt: '2026-11-21T10:00:00Z' });
		assert.strictEqual(describeRestoreDecision(decision), `Restored to Backlog (previous status 'In Review' is no longer in the lifecycle)`);
	});

	test('records without a valid time keep their order after the dated ones', () => {
		const sorted = statusChangeRecordsNewestFirst([
			rec('A', 'B', 'bogus'),
			rec('B', 'C', '2026-11-21T10:00:00Z'),
			rec('C', 'D', '2026-11-22T10:00:00Z'),
			{ ...rec('x', 'y', '2026-11-23T10:00:00Z'), old: undefined }
		]);
		assert.deepStrictEqual(sorted.map(r => r.new), ['D', 'C', 'B']);
	});

	test('initial status: first Todo, else first non-removed, else the fallback', () => {
		assert.strictEqual(initialStatusOf(OPTIONS, 'Todo'), 'Backlog');
		assert.strictEqual(initialStatusOf([{ status: 'Doing', category: 'In Progress' }, { status: 'Gone', category: 'Removed' }], 'Todo'), 'Doing');
		assert.strictEqual(initialStatusOf([{ status: 'Gone', category: 'Removed' }], 'Todo'), 'Todo');
		assert.strictEqual(initialStatusOf([], 'Open'), 'Open');
	});
});
