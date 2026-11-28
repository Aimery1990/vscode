/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { CanonicalStatusCategory } from '../../../workspacesExplorer/common/workspacesExplorer.js';
import {
	buildRunStatusOptionGroups, decideStatusAfterRun, defaultBlockedStatus, defaultDoneStatus, describeRunStatusSetting, hasStatusChangeSince,
	effectiveRunStatusSetting, inheritRunStatusLabel, parseRunStatusSetting, parseTicketRunStatusOverride, readTicketRunStatusOverride, resolveRunStatusName,
	RUN_STATUS_DONT_CHANGE, RUN_STATUS_INHERIT, runStatusSelectValue, setTicketRunStatusOverrideLine
} from '../../common/runCompletionStatus.js';

function lifecycle(map: Record<string, CanonicalStatusCategory>) {
	return {
		statuses: Object.keys(map),
		getCategory: (s?: string): CanonicalStatusCategory => {
			const key = Object.keys(map).find(k => k.toLowerCase() === (s ?? '').toLowerCase());
			return key ? map[key] : 'Todo';
		}
	};
}

const standard = lifecycle({ 'Todo': 'Todo', 'In Progress': 'In Progress', 'To be verified': 'In Progress', 'Done': 'Done', 'Blocked': 'Blocked', 'Removed': 'Removed' });
const custom = lifecycle({ 'Backlog': 'Todo', 'Doing': 'In Progress', 'Shipped': 'Done', 'Closed': 'Done', 'On Hold': 'Blocked', 'Dropped': 'Removed' });

suite('runCompletionStatus (CI-58)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseRunStatusSetting: unset / empty / legacy mean the default; Don\'t change; a name', () => {
		assert.deepStrictEqual(parseRunStatusSetting(undefined), { kind: 'default' });
		assert.deepStrictEqual(parseRunStatusSetting(''), { kind: 'default' });
		assert.deepStrictEqual(parseRunStatusSetting('   '), { kind: 'default' });
		assert.deepStrictEqual(parseRunStatusSetting(42), { kind: 'default' });
		assert.deepStrictEqual(parseRunStatusSetting(RUN_STATUS_DONT_CHANGE), { kind: 'dontChange' });
		assert.deepStrictEqual(parseRunStatusSetting(' In Review '), { kind: 'status', status: 'In Review' });
	});

	test('defaults: the first status of the Done / Blocked category of the workspace lifecycle', () => {
		assert.strictEqual(defaultDoneStatus(standard), 'Done');
		assert.strictEqual(defaultDoneStatus(custom), 'Shipped');
		assert.strictEqual(defaultBlockedStatus(custom), 'On Hold');
		// no workspace lifecycle: the template's first Done status, else "Done"
		assert.strictEqual(defaultDoneStatus(undefined, [{ label: 'Open', category: 'Todo' }, { label: 'Finished', category: 'Done' }]), 'Finished');
		assert.strictEqual(defaultDoneStatus(undefined), 'Done');
		assert.strictEqual(defaultBlockedStatus(undefined), 'Blocked');
	});

	test('resolveRunStatusName: template statuses first, then the workspace lifecycle, case-insensitive', () => {
		const tpl = [{ label: 'Verified', category: 'Done' }, { id: 'done', label: 'DONE', category: 'Done' }];
		assert.strictEqual(resolveRunStatusName('done', tpl, standard), 'DONE');
		assert.strictEqual(resolveRunStatusName('blocked', tpl, standard), 'Blocked');
		assert.strictEqual(resolveRunStatusName('verified', tpl, standard), 'Verified');
		assert.strictEqual(resolveRunStatusName('Nope', tpl, standard), undefined);
		assert.strictEqual(resolveRunStatusName('', tpl, standard), undefined);
	});

	test('success: unset setting moves to Done; a chosen status; Don\'t change', () => {
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'success', setting: undefined, currentStatus: 'In Progress', lifecycle: standard }), { action: 'set', status: 'Done', reason: 'default (Done) after a successful run' });
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'success', setting: '', currentStatus: 'Backlog', lifecycle: custom }), { action: 'set', status: 'Shipped', reason: 'default (Done) after a successful run' });
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'success', setting: 'to be verified', currentStatus: 'Todo', lifecycle: standard }), { action: 'set', status: 'To be verified', reason: 'set after a successful run' });
		assert.strictEqual(decideStatusAfterRun({ outcome: 'success', setting: RUN_STATUS_DONT_CHANGE, currentStatus: 'Todo', lifecycle: standard }).action, 'keep');
		assert.strictEqual(decideStatusAfterRun({ outcome: 'success', setting: undefined, currentStatus: 'Done', lifecycle: standard }).action, 'keep');
	});

	test('failure: unset setting moves to Blocked; Don\'t change; its own setting', () => {
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'failed', setting: 'Done', currentStatus: 'In Progress', lifecycle: standard }), { action: 'set', status: 'Blocked', reason: 'default (Blocked) after a failed run' });
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'failed', setting: undefined, failureSetting: '', currentStatus: 'Doing', lifecycle: custom }), { action: 'set', status: 'On Hold', reason: 'default (Blocked) after a failed run' });
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'failed', setting: undefined, failureSetting: 'In Progress', currentStatus: 'Done', lifecycle: standard }), { action: 'set', status: 'In Progress', reason: 'set after a failed run' });
		assert.strictEqual(decideStatusAfterRun({ outcome: 'failed', setting: undefined, failureSetting: RUN_STATUS_DONT_CHANGE, currentStatus: 'Todo', lifecycle: standard }).action, 'keep');
	});

	test('a stopped run never changes the status', () => {
		const d = decideStatusAfterRun({ outcome: 'stopped', setting: 'Done', failureSetting: 'Blocked', currentStatus: 'In Progress', lifecycle: standard });
		assert.deepStrictEqual(d, { action: 'keep', reason: 'the run was stopped' });
	});

	test('a status set explicitly during the run wins', () => {
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'success', setting: undefined, explicitStatus: 'Blocked', currentStatus: 'Todo', lifecycle: standard }), { action: 'keep', reason: 'a step of the run set the status to \'Blocked\'' });
		assert.deepStrictEqual(decideStatusAfterRun({ outcome: 'success', setting: undefined, statusChangedDuringRun: true, currentStatus: 'Blocked', lifecycle: standard }), { action: 'keep', reason: 'the status was set during the run' });
		assert.strictEqual(decideStatusAfterRun({ outcome: 'failed', setting: undefined, statusChangedDuringRun: true, currentStatus: 'Done', lifecycle: standard }).action, 'keep');
	});

	test('never back to Todo; unknown status names are skipped', () => {
		const todo = decideStatusAfterRun({ outcome: 'success', setting: 'Todo', currentStatus: 'In Progress', lifecycle: standard });
		assert.strictEqual(todo.action, 'keep');
		assert.ok(/never moves a ticket back to Todo/.test(todo.reason));
		const unknown = decideStatusAfterRun({ outcome: 'success', setting: 'Approved', currentStatus: 'Todo', lifecycle: standard });
		assert.deepStrictEqual(unknown, { action: 'keep', reason: 'status \'Approved\' is not in the template\'s statuses or the workspace lifecycle' });
		// the default Done of a lifecycle that has none: "Done" is not found, skipped
		assert.strictEqual(decideStatusAfterRun({ outcome: 'success', setting: undefined, currentStatus: 'Open', lifecycle: lifecycle({ 'Open': 'Todo', 'Working': 'In Progress' }) }).action, 'keep');
	});

	test('dropdown: Don\'t change + statuses grouped by category (no Todo), pre-filled with the default', () => {
		const groups = buildRunStatusOptionGroups(custom, [{ label: 'Verified', category: 'Done' }]);
		assert.deepStrictEqual(groups.map(g => [g.category ?? '-', g.options.map(o => o.value).join('|')]), [
			['-', RUN_STATUS_DONT_CHANGE],
			['In Progress', 'Doing'],
			['Done', 'Shipped|Closed|Verified'],
			['Blocked', 'On Hold'],
			['Removed', 'Dropped']
		]);
		const withUnknown = buildRunStatusOptionGroups(standard, undefined, 'Legacy');
		assert.strictEqual(withUnknown[withUnknown.length - 1].options[0].label, 'Legacy (not in lifecycle)');
		assert.strictEqual(runStatusSelectValue(undefined, custom), 'Shipped');
		assert.strictEqual(runStatusSelectValue(undefined, custom, undefined, 'failure'), 'On Hold');
		assert.strictEqual(runStatusSelectValue(RUN_STATUS_DONT_CHANGE, custom), RUN_STATUS_DONT_CHANGE);
		assert.strictEqual(runStatusSelectValue('closed', custom), 'Closed');
		assert.strictEqual(describeRunStatusSetting(undefined, standard), 'Done (default)');
		assert.strictEqual(describeRunStatusSetting(undefined, standard, undefined, 'failure'), 'Blocked (default)');
		assert.strictEqual(describeRunStatusSetting(RUN_STATUS_DONT_CHANGE, standard), 'Don\'t change');
	});

	test('hasStatusChangeSince: status records from the run start on', () => {
		const t0 = Date.parse('2026-11-28T10:00:00.000Z');
		const records = [{ field: 'status', at: '2026-11-28T09:59:59.000Z' }, { field: 'title', at: '2026-11-28T10:00:05.000Z' }];
		assert.strictEqual(hasStatusChangeSince(records, t0), false);
		assert.strictEqual(hasStatusChangeSince([...records, { field: 'status', at: '2026-11-28T10:00:01.000Z' }], t0), true);
	});

	suite('per-ticket settings', () => {
		const TICKET = ['# T-1', '- **Status**: In Progress', '### Link', '- **Link To**: None', '- **Linked By**: None', '- **Follow Children**: On', ''].join('\n');

		test('precedence: the ticket\'s own value, then the template / workflow value, then the default', () => {
			assert.strictEqual(effectiveRunStatusSetting('To be verified', 'Shipped'), 'To be verified');
			assert.strictEqual(effectiveRunStatusSetting(undefined, 'Shipped'), 'Shipped');
			assert.strictEqual(effectiveRunStatusSetting('Default', undefined), undefined);
			assert.strictEqual(effectiveRunStatusSetting('Don\'t change', 'Shipped'), RUN_STATUS_DONT_CHANGE);
			const decide = (own: string | undefined, inherited: unknown) => decideStatusAfterRun({ outcome: 'success', setting: effectiveRunStatusSetting(own, inherited), currentStatus: 'In Progress', lifecycle: standard });
			assert.deepStrictEqual(decide('To be verified', undefined), { action: 'set', status: 'To be verified', reason: 'set after a successful run' });
			assert.deepStrictEqual(decide(undefined, 'Blocked'), { action: 'set', status: 'Blocked', reason: 'set after a successful run' });
			assert.deepStrictEqual(decide(undefined, undefined), { action: 'set', status: 'Done', reason: 'default (Done) after a successful run' });
			assert.strictEqual(decide('Don\'t change', 'Blocked').action, 'keep');
		});

		test('ticket.md lines: read, write next to Follow Children, remove on inherit', () => {
			assert.strictEqual(readTicketRunStatusOverride(TICKET, 'success'), undefined);
			const own = setTicketRunStatusOverrideLine(TICKET, 'success', 'To be verified');
			assert.ok(own.includes('- **Follow Children**: On\n- **Status On Successful Run**: To be verified'), own);
			assert.strictEqual(readTicketRunStatusOverride(own, 'success'), 'To be verified');
			const both = setTicketRunStatusOverrideLine(own, 'failure', RUN_STATUS_DONT_CHANGE);
			assert.ok(both.includes('- **Status On Successful Run**: To be verified\n- **Status On Failed Run**: Don\'t change'), both);
			assert.strictEqual(readTicketRunStatusOverride(both, 'failure'), RUN_STATUS_DONT_CHANGE);
			assert.strictEqual(setTicketRunStatusOverrideLine(setTicketRunStatusOverrideLine(both, 'success', RUN_STATUS_INHERIT), 'failure', undefined), TICKET);
			assert.strictEqual(parseTicketRunStatusOverride('  '), undefined);
			assert.strictEqual(parseTicketRunStatusOverride('Use template default'), undefined);
		});

		test('"Use template default" label shows the effective inherited value', () => {
			assert.strictEqual(inheritRunStatusLabel('template', undefined, standard, undefined, 'success'), 'Use template default (Done)');
			assert.strictEqual(inheritRunStatusLabel('template', undefined, custom, undefined, 'failure'), 'Use template default (On Hold)');
			assert.strictEqual(inheritRunStatusLabel('workflow', RUN_STATUS_DONT_CHANGE, standard, undefined, 'success'), 'Use workflow default (Don\'t change)');
			assert.strictEqual(inheritRunStatusLabel('template', 'To be verified', standard, undefined, 'success'), 'Use template default (To be verified)');
		});
	});
});
