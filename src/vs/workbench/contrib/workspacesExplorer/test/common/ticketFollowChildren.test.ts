/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOutcomeRecord, IPropagationStep, propagateDependencies, resultValueFor, setFollowDependenciesLine } from '../../common/ticketDependencies.js';
import {
	buildFollowersIndex, canFollow, childOutcome, evaluateFollowedTickets, explicitDependencyOutcome, followersAfterTicketChange, IFollowedState, readFollowChildren,
	setFollowChildrenLine
} from '../../common/ticketFollowChildren.js';

const TICKET = [
	'# ANYAG-0138',
	'- **Ticket ID**: ANYAG-0138',
	'- **Status**: In Progress',
	'### Link',
	'- **Link To**: None',
	'- **Linked By**: None',
	''
].join('\n');

const pass = (id: string): IFollowedState => ({ id, outcome: 'success' });
const fail = (id: string): IFollowedState => ({ id, outcome: 'failed' });
const open = (id: string): IFollowedState => ({ id, outcome: 'unfinished' });
const run = (status: 'success' | 'failed'): IOutcomeRecord => ({ status, at: 1, source: 'run' });

suite('ticketFollowChildren (CI-62)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Follow Children switch: default On, written next to Update Status From Dependencies', () => {
		assert.strictEqual(readFollowChildren(TICKET), true);
		const off = setFollowChildrenLine(TICKET, false);
		assert.strictEqual(readFollowChildren(off), false);
		assert.ok(off.includes('- **Linked By**: None\n- **Follow Children**: Off\n'));
		assert.strictEqual(readFollowChildren(setFollowChildrenLine(off, true)), true);
		const withDeps = setFollowChildrenLine(setFollowDependenciesLine(TICKET, true), false);
		assert.ok(withDeps.includes('- **Update Status From Dependencies**: On\n- **Follow Children**: Off'));
	});

	test('child outcome: test case by Result, others by status category, Removed ignored', () => {
		assert.strictEqual(childOutcome({ resultValue: 'Pass', statusCategory: 'Done' }), 'success');
		assert.strictEqual(childOutcome({ resultValue: 'Fail', statusCategory: 'Done' }), 'failed');
		assert.strictEqual(childOutcome({ resultValue: 'Not Run', statusCategory: 'Done' }), 'unfinished');
		assert.strictEqual(childOutcome({ resultValue: 'Blocked', statusCategory: 'Todo' }), 'unfinished');
		assert.strictEqual(childOutcome({ resultValue: '', statusCategory: 'Done' }), 'unfinished');
		assert.strictEqual(childOutcome({ statusCategory: 'Done' }), 'success');
		assert.strictEqual(childOutcome({ statusCategory: 'Blocked' }), 'failed');
		assert.strictEqual(childOutcome({ statusCategory: 'Done', failing: true }), 'failed');
		assert.strictEqual(childOutcome({ statusCategory: 'In Progress' }), 'unfinished');
		assert.strictEqual(childOutcome({ statusCategory: 'Todo' }), 'unfinished');
		assert.strictEqual(childOutcome({ statusCategory: 'Removed', resultValue: 'Fail' }), 'ignored');
	});

	test('explicit dependency: test-case Result first, else the run outcome (CI-59)', () => {
		assert.strictEqual(explicitDependencyOutcome(undefined, 'Pass'), 'success');
		assert.strictEqual(explicitDependencyOutcome(run('success'), 'Fail'), 'failed');
		assert.strictEqual(explicitDependencyOutcome(run('failed'), 'Not Run'), 'failed');
		assert.strictEqual(explicitDependencyOutcome(run('success')), 'success');
		assert.strictEqual(explicitDependencyOutcome(undefined), 'unfinished');
	});

	test('all children pass → success with a readable summary', () => {
		const e = evaluateFollowedTickets([pass('ANYAG-0162'), pass('ANYAG-0163')], []);
		assert.strictEqual(e.result, 'success');
		assert.strictEqual(e.summary, 'All 2 children passed (ANYAG-0162, ANYAG-0163)');
		assert.strictEqual(resultValueFor(e), 'Pass');
		assert.strictEqual(evaluateFollowedTickets([pass('A-1')], []).summary, 'Child A-1 passed');
	});

	test('one child fails → failed (the other passed or unfinished)', () => {
		const e = evaluateFollowedTickets([pass('A-1'), fail('A-2')], []);
		assert.strictEqual(e.result, 'failed');
		assert.strictEqual(e.summary, 'Child A-2 failed');
		assert.strictEqual(resultValueFor(e), 'Fail');
		assert.strictEqual(evaluateFollowedTickets([open('A-1'), fail('A-2')], []).result, 'failed');
	});

	test('unfinished children → no change; mostly unfinished children never fail the parent', () => {
		const e = evaluateFollowedTickets([pass('A-1'), open('A-2')], []);
		assert.strictEqual(e.result, 'pending');
		assert.strictEqual(e.summary, 'A-2 unfinished');
		const guarded = evaluateFollowedTickets([fail('A-1'), open('A-2'), open('A-3'), pass('A-4'), open('A-5')], []);
		assert.strictEqual(guarded.result, 'pending');
		assert.ok(guarded.summary.includes('3 of 5 children are unfinished'), guarded.summary);
		// a failed explicit dependency still counts (CI-59)
		assert.strictEqual(evaluateFollowedTickets([open('A-1'), open('A-2')], [fail('B-1')]).result, 'failed');
	});

	test('nothing counted (Removed children filtered out, switches off) → none', () => {
		assert.strictEqual(evaluateFollowedTickets([], []).result, 'none');
	});

	test('children mixed with Depends On', () => {
		const ok = evaluateFollowedTickets([pass('A-1')], [pass('B-1')]);
		assert.strictEqual(ok.result, 'success');
		assert.strictEqual(ok.summary, 'All 2 passed (children A-1; Depends On B-1)');
		assert.strictEqual(evaluateFollowedTickets([pass('A-1')], [open('B-1')]).result, 'pending');
		const bad = evaluateFollowedTickets([fail('A-1')], [fail('B-1')]);
		assert.strictEqual(bad.result, 'failed');
		assert.strictEqual(bad.summary, 'Child A-1 failed; Depends On B-1: last run failed');
	});

	test('guards: workspace root tickets and Removed tickets never follow; test-case parents get a Result', () => {
		assert.strictEqual(canFollow('workspace', 'In Progress'), false);
		assert.strictEqual(canFollow('task', 'Removed'), false);
		assert.strictEqual(canFollow('test-case', 'In Progress'), true);
		assert.strictEqual(resultValueFor(evaluateFollowedTickets([fail('A-1')], [])), 'Fail');
	});

	test('followers after a change: the parent; explicit dependents only when a Result changed', () => {
		const parentOf = new Map([['A-2', 'A-1']]);
		const dependents = new Map([['A-2', ['B-1']]]);
		assert.deepStrictEqual(followersAfterTicketChange('A-2', parentOf, dependents, false), ['A-1']);
		assert.deepStrictEqual(followersAfterTicketChange('A-2', parentOf, dependents, true), ['A-1', 'B-1']);
		assert.deepStrictEqual(followersAfterTicketChange('X-1', parentOf, dependents, false), []);
	});

	test('chains: a child change propagates to the parent, then the grandparent', async () => {
		const parentOf = new Map([['TC-1', 'P-1'], ['P-1', 'G-1']]);
		const followers = buildFollowersIndex(new Map(), parentOf);
		const visited: IPropagationStep[] = [];
		await propagateDependencies('TC-1', followers, async step => { visited.push(step); return true; }, 8, followersAfterTicketChange('TC-1', parentOf, new Map(), false));
		assert.deepStrictEqual(visited.map(s => `${s.ticketId}<${s.triggerId}@${s.depth}`), ['P-1<TC-1@1', 'G-1<P-1@2']);
		// an unchanged parent stops the chain
		const stopped: string[] = [];
		await propagateDependencies('TC-1', followers, async step => { stopped.push(step.ticketId); return false; }, 8, ['P-1']);
		assert.deepStrictEqual(stopped, ['P-1']);
	});

	test('cycles: a parent depending on its own child ends', async () => {
		const parentOf = new Map([['C-1', 'P-1']]);
		const followers = buildFollowersIndex(new Map([['P-1', ['C-1']]]), parentOf);
		const visited: string[] = [];
		await propagateDependencies('C-1', followers, async step => { visited.push(step.ticketId); return true; }, 8, ['P-1']);
		assert.deepStrictEqual(visited, ['P-1']);
		const deep = new Map<string, string>();
		for (let i = 0; i < 20; i++) {
			deep.set(`T-${i}`, `T-${i + 1}`);
		}
		const levels: number[] = [];
		await propagateDependencies('T-0', buildFollowersIndex(new Map(), deep), async step => { levels.push(step.depth); return true; }, 8);
		assert.strictEqual(Math.max(...levels), 8);
	});
});
