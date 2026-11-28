/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildDependentsIndex, evaluateDependencies, IOutcomeRecord, IPropagationStep, latestOutcome, parseDependsOn, parseDerivedOutcome, propagateDependencies,
	readDependsOn, readFollowDependencies, readResultFieldValue, resultValueFor, serializeDerivedOutcome, setDependsOnLine, setFollowDependenciesLine,
	setResultFieldValue, workflowRunOutcome
} from '../../common/ticketDependencies.js';

const ok = (at: number): IOutcomeRecord => ({ status: 'success', at, source: 'run' });
const bad = (at: number): IOutcomeRecord => ({ status: 'failed', at, source: 'run' });

const TICKET = [
	'# ANYAG-0132',
	'- **Ticket ID**: ANYAG-0132',
	'### Self Defined Data (If any)',
	'- **Self Defined Data Value**:',
	'  - **Test Type**: Manual',
	'  - **Result**: Not Run',
	'- **Status**: Todo',
	'### Link',
	'- **Link To**: None',
	'- **Linked By**: None',
	''
].join('\n');

suite('ticketDependencies (CI-59)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Depends On line: parse, read, write next to Linked By', () => {
		assert.deepStrictEqual(parseDependsOn('anyag-0120, ANYAG-0122 ANYAG-0120'), ['ANYAG-0120', 'ANYAG-0122']);
		assert.deepStrictEqual(parseDependsOn('None'), []);
		assert.deepStrictEqual(parseDependsOn(undefined), []);
		assert.deepStrictEqual(readDependsOn(TICKET), []);
		const withDeps = setDependsOnLine(TICKET, ['ANYAG-0120', 'ANYAG-0122']);
		assert.ok(withDeps.includes('- **Linked By**: None\n- **Depends On**: ANYAG-0120, ANYAG-0122\n'));
		assert.deepStrictEqual(readDependsOn(withDeps), ['ANYAG-0120', 'ANYAG-0122']);
		assert.strictEqual(setDependsOnLine(withDeps, []).match(/Depends On/g)?.length, 1);
		assert.deepStrictEqual(readDependsOn(setDependsOnLine(withDeps, [])), []);
		assert.strictEqual(readFollowDependencies(withDeps), true);
		assert.strictEqual(readFollowDependencies(setFollowDependenciesLine(withDeps, false)), false);
		assert.strictEqual(readFollowDependencies(setFollowDependenciesLine(withDeps, true)), true);
		assert.ok(setFollowDependenciesLine(withDeps, false).includes('- **Depends On**: ANYAG-0120, ANYAG-0122\n- **Update Status From Dependencies**: Off\n'));
	});

	test('Result field: read and set (custom value line), untouched when missing', () => {
		assert.strictEqual(readResultFieldValue(TICKET), 'Not Run');
		assert.strictEqual(readResultFieldValue(setResultFieldValue(TICKET, 'Pass')), 'Pass');
		const noResult = TICKET.replace('  - **Result**: Not Run\n', '');
		assert.strictEqual(setResultFieldValue(noResult, 'Pass'), noResult);
	});

	test('evaluate: all pass, one fails, never run, none', () => {
		const all = evaluateDependencies([{ id: 'A', outcome: ok(1) }, { id: 'B', outcome: ok(2) }]);
		assert.strictEqual(all.result, 'success');
		assert.strictEqual(resultValueFor(all), 'Pass');
		const one = evaluateDependencies([{ id: 'A', outcome: ok(1) }, { id: 'B', outcome: bad(2) }]);
		assert.deepStrictEqual(one, { result: 'failed', failedIds: ['B'], summary: 'B: last run failed' });
		assert.strictEqual(resultValueFor(one), 'Fail');
		const never = evaluateDependencies([{ id: 'A', outcome: ok(1) }, { id: 'B', outcome: undefined }]);
		assert.strictEqual(never.result, 'pending');
		assert.strictEqual(resultValueFor(never), undefined);
		// a known failure wins over a dependency that never ran
		assert.strictEqual(evaluateDependencies([{ id: 'A', outcome: undefined }, { id: 'B', outcome: bad(2) }]).result, 'failed');
		assert.strictEqual(evaluateDependencies([]).result, 'none');
	});

	test('latest outcome: a later failure after an earlier success (and the other way round)', () => {
		const t = Date.parse('2026-11-28T10:00:00Z');
		assert.strictEqual(latestOutcome([ok(t), bad(t + 1000)])?.status, 'failed');
		assert.strictEqual(latestOutcome([bad(t), ok(t + 1000)])?.status, 'success');
		// own run vs workflow run vs derived: the newest wins
		const derived = parseDerivedOutcome(serializeDerivedOutcome('failed', new Date(t + 5000), 'ANYAG-0120'));
		assert.deepStrictEqual(derived, { status: 'failed', at: t + 5000, source: 'derived' });
		assert.strictEqual(latestOutcome([ok(t), workflowRunOutcome('completed', t + 2000), derived])?.source, 'derived');
		assert.strictEqual(latestOutcome([undefined, undefined]), undefined);
		assert.strictEqual(workflowRunOutcome('running', t), undefined);
		assert.deepStrictEqual(workflowRunOutcome('failed', t), { status: 'failed', at: t, source: 'workflow' });
		assert.strictEqual(parseDerivedOutcome('{oops'), undefined);
	});

	test('reverse index', () => {
		const idx = buildDependentsIndex(new Map([['C', ['A', 'B']], ['D', ['A']], ['E', ['A', 'A']]]));
		assert.deepStrictEqual(idx.get('A'), ['C', 'D', 'E']);
		assert.deepStrictEqual(idx.get('B'), ['C']);
	});

	test('propagation: chains follow changed outcomes only', async () => {
		// A <- B <- C <- D (B depends on A, ...); E depends on A too
		const idx = buildDependentsIndex(new Map([['B', ['A']], ['C', ['B']], ['D', ['C']], ['E', ['A']]]));
		const visited: IPropagationStep[] = [];
		await propagateDependencies('A', idx, async s => { visited.push(s); return s.ticketId !== 'C'; });
		assert.deepStrictEqual(visited.map(s => `${s.ticketId}<${s.triggerId}@${s.depth}`), ['B<A@1', 'E<A@1', 'C<B@2']);
	});

	test('propagation: cycles end, depth is limited', async () => {
		const cycle = buildDependentsIndex(new Map([['A', ['C']], ['B', ['A']], ['C', ['B']]]));
		const visited: string[] = [];
		await propagateDependencies('A', cycle, async s => { visited.push(s.ticketId); return true; });
		assert.deepStrictEqual(visited, ['B', 'C']);
		const chain = buildDependentsIndex(new Map(Array.from({ length: 20 }, (_, i) => [`T${i + 1}`, [`T${i}`]] as [string, string[]])));
		const deep: number[] = [];
		await propagateDependencies('T0', chain, async s => { deep.push(s.depth); return true; }, 5);
		assert.deepStrictEqual(deep, [1, 2, 3, 4, 5]);
	});
});
