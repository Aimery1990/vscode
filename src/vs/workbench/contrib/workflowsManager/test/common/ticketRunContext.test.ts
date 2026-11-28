/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGitRunResult, IShellRunResult } from '../../../entityPersistence/common/entityPersistence.js';
import { publishGitOutputs } from '../../../customModules/common/gitComponent.js';
import { outputVariableNameOf } from '../../../customModules/common/outputVariable.js';
import { publishResultOutputs, resultOutputNames } from '../../../customModules/common/resultOutputs.js';
import { publishShellOutputs } from '../../../customModules/common/shellComponent.js';
import { publishButtonGroupOutputs } from '../../common/humanDecision.js';
import { IStoredResultField, publishStoredComponentResults, storedComponentResult, ticketRootFieldValue, ticketRunDescription, ticketRunTitle } from '../../common/ticketRunContext.js';

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

suite('Single card run sees the same variables as a whole ticket run (CI-67)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const branchResult: IGitRunResult = { ok: true, exitCode: 0, stdout: '* feature/x\n  main\n', stderr: '', command: 'git branch -a', gitCommand: 'branch', repoPath: '/tmp/git-demo', branch: 'feature/x', commit: '54822f8', durationMs: 14 };
	const branchField: IStoredResultField = { id: 'branch_list', label: 'Branch List', type: 'git' };
	const storedGit = JSON.stringify({ gitLastResult: { ...branchResult, executedAt: '2026-11-28T09:03:39.633Z' } });

	test('canonical rule: label / label_key / aliases = main, <name>_result = dict, <name>.field = each field', () => {
		const ctx: Record<string, unknown> = {};
		publishResultOutputs(ctx, 'Branch List', 'text', { ok: true, exitCode: 0 }, ['branches', undefined, ' ']);
		for (const n of ['Branch List', 'branch_list', 'branches']) {
			assert.strictEqual(ctx[n], 'text');
			assert.deepStrictEqual(ctx[`${n}_result`], { ok: true, exitCode: 0 });
			assert.strictEqual(ctx[`${n}.ok`], true);
			assert.strictEqual(ctx[`${n}.exitCode`], 0);
		}
		assert.deepStrictEqual(resultOutputNames('Branch List', ['branch_list', 'b']), ['Branch List', 'branch_list', 'b']);
	});

	test('a stored git result is published exactly like the git step of a whole run (label = text, _result = dict)', () => {
		const whole: Record<string, unknown> = {};
		publishGitOutputs(whole, 'Branch List', branchResult, [outputVariableNameOf(branchField, 'Branch List')]);
		whole['branch_list'] = whole['Branch List']; // the id (runtime generic step block)
		const single: Record<string, unknown> = { 'Branch List': storedGit };
		assert.deepStrictEqual(publishStoredComponentResults(single, [branchField], { 'Branch List': storedGit }), ['Branch List']);
		assert.deepStrictEqual(single, whole);
		assert.strictEqual(single['Branch List'], '* feature/x\n  main\n');
		assert.strictEqual(typeof single['Branch List'], 'string');
		const dict = single['branch_list_result'] as Record<string, unknown>;
		assert.strictEqual(dict.branch, 'feature/x');
		assert.strictEqual(dict.exitCode, 0);
		assert.strictEqual(dict.ok, true);
		assert.strictEqual(single['Branch List.branch'], 'feature/x');
		assert.strictEqual(single['branch_list.commit'], '54822f8');
	});

	test('the output variable gets the same names (renamed variable, UI-27)', () => {
		const ctx: Record<string, unknown> = {};
		publishStoredComponentResults(ctx, [{ ...branchField, outputVariableName: 'branches' }], { 'Branch List': storedGit });
		assert.strictEqual(ctx['branches'], '* feature/x\n  main\n');
		assert.strictEqual((ctx['branches_result'] as Record<string, unknown>).branch, 'feature/x');
		assert.strictEqual(ctx['branches.exitCode'], 0);
		assert.strictEqual((ctx['branch_list_result'] as Record<string, unknown>).branch, 'feature/x');
	});

	test('a failed git result: main text is stderr, _result.ok false', () => {
		const failed = { ...branchResult, ok: false, exitCode: 128, stdout: '', stderr: 'fatal: nope\n' };
		const ctx: Record<string, unknown> = {};
		publishStoredComponentResults(ctx, [branchField], { 'Branch List': { gitLastResult: failed } });
		assert.strictEqual(ctx['Branch List'], 'fatal: nope\n');
		assert.strictEqual((ctx['branch_list_result'] as Record<string, unknown>).ok, false);
	});

	test('stored value found by id, by a custom lookup, or on the field itself', () => {
		const byId: Record<string, unknown> = {};
		publishStoredComponentResults(byId, [branchField], { branch_list: storedGit });
		assert.strictEqual((byId['branch_list_result'] as Record<string, unknown>).branch, 'feature/x');
		const byLookup: Record<string, unknown> = {};
		publishStoredComponentResults(byLookup, [branchField], {}, () => storedGit);
		assert.strictEqual(byLookup['Branch List'], '* feature/x\n  main\n');
		const onField: Record<string, unknown> = {};
		publishStoredComponentResults(onField, [{ ...branchField, gitLastResult: branchResult }], {});
		assert.strictEqual(onField['branch_list.branch'], 'feature/x');
	});

	test('shell and button_group follow the same rule as their whole-run publishers', () => {
		const shellRes: IShellRunResult = { ok: true, exitCode: 0, stdout: 'hi\n', stderr: '', command: 'echo hi', shell: 'zsh', cwd: '/tmp', durationMs: 5 };
		const shellField: IStoredResultField = { id: 'say_hi', label: 'Say Hi', type: 'shell' };
		const wholeShell: Record<string, unknown> = {};
		publishShellOutputs(wholeShell, 'Say Hi', shellRes, [outputVariableNameOf(shellField, 'Say Hi')]);
		wholeShell['say_hi'] = wholeShell['Say Hi'];
		const singleShell: Record<string, unknown> = {};
		publishStoredComponentResults(singleShell, [shellField], { 'Say Hi': JSON.stringify({ shellLastResult: shellRes }) });
		assert.deepStrictEqual(singleShell, wholeShell);

		const decision = { buttonId: 'approve', label: 'Approve', at: '2026-11-28T00:00:00.000Z', by: 'User' };
		const reviewField: IStoredResultField = { id: 'review', label: 'Review', type: 'button_group' };
		const wholeReview: Record<string, unknown> = {};
		publishButtonGroupOutputs(wholeReview, 'Review', decision, [outputVariableNameOf(reviewField, 'Review')]);
		wholeReview['review'] = wholeReview['Review'];
		const singleReview: Record<string, unknown> = {};
		publishStoredComponentResults(singleReview, [reviewField], { Review: JSON.stringify(decision) });
		assert.deepStrictEqual(singleReview, wholeReview);
		assert.strictEqual(singleReview['Review'], 'Approve');
	});

	test('cards without a stored result and other component types are left alone', () => {
		const ctx: Record<string, unknown> = { 'Branch List': 'keep', 'Notes': 'n' };
		assert.deepStrictEqual(publishStoredComponentResults(ctx, [branchField, { id: 'notes', label: 'Notes', type: 'textarea' }, { id: 'py', label: 'Py', type: 'python' }], { Notes: 'n', Py: '{"code":"x"}' }), []);
		assert.deepStrictEqual(ctx, { 'Branch List': 'keep', 'Notes': 'n' });
		assert.strictEqual(storedComponentResult(branchField, 'not json'), undefined);
		assert.strictEqual(storedComponentResult({ id: 'x', label: 'X', type: 'http_request' }, storedGit), undefined);
		assert.deepStrictEqual(publishStoredComponentResults(ctx, undefined, {}), []);
	});
});
