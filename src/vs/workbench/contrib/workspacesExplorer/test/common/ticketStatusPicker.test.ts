/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanonicalStatusCategory } from '../../common/workspacesExplorer.js';
import { STATUS_CATEGORY_COLORS } from '../../common/workspaceLifecycle.js';
import { buildPriorityOptions, findStatusOption, findTemplateForType, getPriorityColor, groupStatusOptions, hasStatusOption, IWorkspaceLifecycleLike, NEUTRAL_PRIORITY_COLOR, normalizePriority, resolveEffectiveStatusOptions, setTicketPriorityLine } from '../../common/ticketStatusPicker.js';

function workspaceLifecycle(mapping: { [status: string]: CanonicalStatusCategory }): IWorkspaceLifecycleLike {
	return {
		statuses: Object.keys(mapping),
		getCategory: (status?: string) => (status && Object.entries(mapping).find(([k]) => k.toLowerCase() === status.toLowerCase())?.[1]) || 'Todo'
	};
}

suite('ticketStatusPicker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ws = workspaceLifecycle({ 'Backlog': 'Todo', 'In Dev': 'In Progress', 'In Test': 'In Progress', 'Released': 'Done', 'On Hold': 'Blocked', 'Dropped': 'Removed' });

	test('workspace lifecycle is used when the template defines no statuses', () => {
		for (const tpl of [undefined, []]) {
			const res = resolveEffectiveStatusOptions(tpl, ws);
			assert.strictEqual(res.source, 'workspace');
			assert.deepStrictEqual(res.options.map(o => `${o.status}:${o.category}`), ['Backlog:Todo', 'In Dev:In Progress', 'In Test:In Progress', 'Released:Done', 'On Hold:Blocked', 'Dropped:Removed']);
		}
	});

	test('template statuses win, with their own category (else the workspace category)', () => {
		const res = resolveEffectiveStatusOptions([
			{ id: 'draft', label: 'Draft', category: 'Todo' },
			{ id: 'review', label: 'Review', category: 'in progress' },
			{ id: 'released', label: '', category: 'bogus' },
			{ id: '', label: '' },
			{ id: 'dup', label: 'draft', category: 'Done' }
		], ws);
		assert.strictEqual(res.source, 'template');
		assert.deepStrictEqual(res.options, [
			{ status: 'Draft', category: 'Todo' },
			{ status: 'Review', category: 'In Progress' },
			{ status: 'released', category: 'Done' }
		]);
	});

	test('grouping follows the canonical category order and drops empty groups', () => {
		const opts = resolveEffectiveStatusOptions(undefined, workspaceLifecycle({ 'Gone': 'Removed', 'Done': 'Done', 'Doing': 'In Progress', 'New': 'Todo' })).options;
		const groups = groupStatusOptions(opts, 'doing');
		assert.deepStrictEqual(groups.map(g => g.category), ['Todo', 'In Progress', 'Done', 'Removed']);
		assert.strictEqual(groups[1].color, STATUS_CATEGORY_COLORS['In Progress'].text);
		const current = groups.flatMap(g => g.items).filter(i => i.isCurrent);
		assert.deepStrictEqual(current.map(i => i.status), ['Doing']);
		assert.strictEqual(current[0].isOutsideLifecycle, false);
	});

	test('a current status outside the lifecycle is still shown as checked', () => {
		const opts = resolveEffectiveStatusOptions(undefined, ws).options;
		const groups = groupStatusOptions(opts, 'Legacy', 'Blocked');
		const blocked = groups.find(g => g.category === 'Blocked')!;
		assert.deepStrictEqual(blocked.items.map(i => [i.status, i.isCurrent, i.isOutsideLifecycle]), [['On Hold', false, false], ['Legacy', true, true]]);
		assert.strictEqual(groupStatusOptions(opts, undefined).flatMap(g => g.items).some(i => i.isCurrent), false);
		assert.strictEqual(groupStatusOptions(opts, '  ').flatMap(g => g.items).length, opts.length);
	});

	test('status lookup is case-insensitive and returns the lifecycle spelling', () => {
		const opts = resolveEffectiveStatusOptions(undefined, ws).options;
		assert.strictEqual(hasStatusOption(opts, 'in dev'), true);
		assert.strictEqual(hasStatusOption(opts, 'Todo'), false);
		assert.strictEqual(findStatusOption(opts, 'RELEASED')?.status, 'Released');
	});

	test('template lookup by type id or name', () => {
		const tpls = [{ id: 'bug_report', name: 'Bug Report' }, { id: 'task', name: 'Task' }];
		assert.strictEqual(findTemplateForType(tpls, 'bug-report')?.id, 'bug_report');
		assert.strictEqual(findTemplateForType(tpls, 'Bug Report')?.id, 'bug_report');
		assert.strictEqual(findTemplateForType(tpls, 'TASK')?.id, 'task');
		assert.strictEqual(findTemplateForType(tpls, 'story'), undefined);
		assert.strictEqual(findTemplateForType([{ id: 'folder' }], 'folder'), undefined);
		assert.strictEqual(findTemplateForType(tpls, undefined), undefined);
	});

	test('priority levels', () => {
		assert.strictEqual(normalizePriority('very high'), 'Very High');
		assert.strictEqual(normalizePriority(' LOW '), 'Low');
		assert.strictEqual(normalizePriority('Urgent'), undefined);
		assert.strictEqual(getPriorityColor('high'), '#fb923c');
		assert.strictEqual(getPriorityColor(undefined), '#38bdf8');
		assert.strictEqual(getPriorityColor('Urgent'), NEUTRAL_PRIORITY_COLOR);

		assert.deepStrictEqual(buildPriorityOptions('medium').map(p => [p.level, p.isCurrent]), [['Very High', false], ['High', false], ['Medium', true], ['Low', false], ['Very Low', false]]);
		const custom = buildPriorityOptions('Urgent');
		assert.strictEqual(custom.length, 6);
		assert.deepStrictEqual([custom[5].level, custom[5].isCurrent, custom[5].isOutsideLevels], ['Urgent', true, true]);
		assert.strictEqual(buildPriorityOptions('None').length, 5);
		assert.strictEqual(buildPriorityOptions(undefined).some(p => p.isCurrent), false);
	});

	test('setTicketPriorityLine replaces the top-level line only', () => {
		const text = '## Overview\n- **Status**: Todo\n- **Priority**: Medium\n### Self Defined Data\n  - **Priority**: keep\n';
		assert.strictEqual(setTicketPriorityLine(text, 'High'), '## Overview\n- **Status**: Todo\n- **Priority**: High\n### Self Defined Data\n  - **Priority**: keep\n');
	});

	test('setTicketPriorityLine adds a missing line after Status, else at the end; keeps CRLF', () => {
		assert.strictEqual(setTicketPriorityLine('- **Status**: Todo\r\n- **Labels**: None\r\n', 'Low'), '- **Status**: Todo\r\n- **Priority**: Low\r\n- **Labels**: None\r\n');
		assert.strictEqual(setTicketPriorityLine('# T\n- **Title**: x\n\n', 'Very Low'), '# T\n- **Title**: x\n- **Priority**: Very Low\n');
	});
});
