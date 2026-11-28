/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICustomField } from '../../../entityPersistence/common/entityPersistence.js';
import { applyOutputVariableName, countOutputVariableReferences, defaultOutputVariableName, findOutputVariableReferences, formatOutputVariableReference, getOutputSubFields, getOutputVariableHoverEntries, getOutputVariableInfo, hasOutputVariable, replaceOutputVariableInText, replaceOutputVariableReferences, validateOutputVariableName } from '../../common/outputVariable.js';

function components(): ICustomField[] {
	return [
		{ id: 'title', label: 'Title', type: 'text', required: true },
		{ id: 'git_1', label: 'Git 1', type: 'git' },
		{ id: 'git_2', label: 'Git 2', type: 'git', outputVariableName: 'repo_log', outputVariableManual: true },
		{ id: 'py_1', label: 'Python 1', type: 'python', pythonCode: 'out = TICKET_CONTEXT["git_1"]\nprint(git_1.upper())\nOUTPUT = {"s": TICKET_CONTEXT.get(\'git_1\'), "k": "git_1"}\n' },
		{ id: 'prompt_1', label: 'Prompt 1', type: 'prompt', defaultUserPrompt: 'Summarize {git_1} and {git_1.stdout}; ignore {git_10} and {{git_1}}' },
		{ id: 'inputs', label: 'Inputs', type: 'parameters' },
		{ id: 'out', label: 'Output', type: 'output' }
	];
}

suite('Output variable chip (UI-27)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('which components expose an output variable', () => {
		const [title, git1, , py, prompt, inputs, out] = components();
		assert.strictEqual(hasOutputVariable(title), false);
		assert.strictEqual(hasOutputVariable(git1), true);
		assert.strictEqual(hasOutputVariable(py), true);
		assert.strictEqual(hasOutputVariable(prompt), true);
		assert.strictEqual(hasOutputVariable(inputs), false);
		assert.strictEqual(hasOutputVariable(out), false);
		assert.strictEqual(hasOutputVariable({ id: 'd', label: 'Display', type: 'display' }), false);
		for (const type of ['shell', 'http_request', 'ssh', 'table', 'text', 'number', 'sub_workflow'] as const) {
			assert.strictEqual(hasOutputVariable({ id: 'x', label: 'X 1', type }), true, type);
		}
	});

	test('default and typed names', () => {
		const [, git1, git2] = components();
		assert.strictEqual(defaultOutputVariableName(git1), 'git_1');
		assert.deepStrictEqual(getOutputVariableInfo(git1), { name: 'git_1', isAuto: true });
		assert.deepStrictEqual(getOutputVariableInfo(git2), { name: 'repo_log', isAuto: false });
		assert.strictEqual(getOutputVariableInfo(components()[0]), undefined);
		assert.strictEqual(formatOutputVariableReference('git_1'), '{git_1}');
	});

	test('sub-fields and hover entries come from the registry', () => {
		assert.deepStrictEqual(getOutputSubFields('git'), ['ok', 'exitCode', 'stdout', 'stderr', 'command', 'repoPath', 'branch', 'commit']);
		assert.deepStrictEqual(getOutputSubFields('shell'), ['ok', 'exitCode', 'stdout', 'stderr', 'command', 'cwd', 'durationMs']);
		assert.ok(getOutputSubFields('table').includes('rows'));
		assert.deepStrictEqual(getOutputSubFields('python'), []);
		const [, , git2, py] = components();
		const gitRefs = getOutputVariableHoverEntries(git2, 'repo_log').map(e => e.reference);
		assert.ok(gitRefs.includes('{repo_log}'));
		assert.ok(gitRefs.includes('{Git 2.stdout}'));
		assert.ok(gitRefs.includes('{Git 2_result}'));
		const pyEntries = getOutputVariableHoverEntries(py, 'python_1');
		assert.ok(pyEntries.some(e => e.reference === '{python_1}' && e.description.includes('OUTPUT')));
		assert.ok(pyEntries.some(e => e.reference === '{python_1_logs}'));
		const httpRefs = getOutputVariableHoverEntries({ id: 'h', label: 'Api', type: 'http_request' }, 'api').map(e => e.reference);
		assert.ok(httpRefs.includes('{Api_status}'));
		assert.ok(getOutputVariableHoverEntries({ id: 't', label: 'Jobs', type: 'table' }, 'jobs').some(e => e.reference === '{Jobs.rows}'));
	});

	test('name validation and uniqueness', () => {
		const fields = components();
		assert.strictEqual(validateOutputVariableName('repo_status', fields, 'git_1'), undefined);
		assert.ok(validateOutputVariableName('', fields, 'git_1'));
		assert.ok(validateOutputVariableName('1abc', fields, 'git_1'));
		assert.ok(validateOutputVariableName('has space', fields, 'git_1'));
		assert.ok(validateOutputVariableName('a-b', fields, 'git_1'));
		assert.ok(validateOutputVariableName('class', fields, 'git_1'), 'Python keyword');
		assert.match(validateOutputVariableName('REPO_LOG', fields, 'git_1') ?? '', /Git 2/);
		// Its own current name is fine; a generated name of another component counts too
		assert.strictEqual(validateOutputVariableName('repo_log', fields, 'git_2'), undefined);
		assert.ok(validateOutputVariableName('git_1', fields, 'git_2'));
		// Inputs / Output have no variable, so their names do not clash
		assert.strictEqual(validateOutputVariableName('inputs', fields, 'git_1'), undefined);
	});

	test('applyOutputVariableName follows the settings dialog rule', () => {
		const field: ICustomField = { id: 'git_1', label: 'Git 1', type: 'git' };
		applyOutputVariableName(field, 'repo_status');
		assert.strictEqual(field.outputVariableName, 'repo_status');
		assert.strictEqual(field.outputVariableManual, true);
		applyOutputVariableName(field, 'git_1');
		assert.strictEqual(field.outputVariableName, 'git_1');
		assert.strictEqual(field.outputVariableManual, false);
	});

	test('replaceOutputVariableInText covers the reference forms', () => {
		const text = '{git_1} {git_1.stdout} @{git_1} {{git_1}} {git_10} {my_git_1} ["git_1"] [\'git_1\'] .get("git_1")';
		const r = replaceOutputVariableInText(text, 'git_1', 'repo', false);
		assert.strictEqual(r.text, '{repo} {repo.stdout} @{repo} {{repo}} {git_10} {my_git_1} ["repo"] [\'repo\'] .get("repo")');
		assert.strictEqual(r.count, 7);
		const plain = replaceOutputVariableInText('echo git_1 then {git_1}', 'git_1', 'repo', false);
		assert.strictEqual(plain.text, 'echo git_1 then {repo}');
		const py = replaceOutputVariableInText('x = git_1 + git_1.strip()\ny = "git_1"\nz = my.git_1\n', 'git_1', 'repo', true);
		assert.strictEqual(py.text, 'x = repo + repo.strip()\ny = "git_1"\nz = my.git_1\n');
		assert.strictEqual(py.count, 2);
	});

	test('find and replace references in the other components', () => {
		const fields = components();
		const refs = findOutputVariableReferences(fields, 'git_1', 'git_1');
		assert.deepStrictEqual(refs.map(r => [r.fieldLabel, r.path, r.count]), [
			['Python 1', 'pythonCode', 3],
			['Prompt 1', 'defaultUserPrompt', 3]
		]);
		assert.strictEqual(countOutputVariableReferences(refs), 6);
		// Finding does not change anything
		assert.deepStrictEqual(fields, components());

		const changed = replaceOutputVariableReferences(fields, 'git_1', 'git_1', 'repo_status');
		assert.strictEqual(changed, 6);
		assert.strictEqual(fields[3].pythonCode, 'out = TICKET_CONTEXT["repo_status"]\nprint(repo_status.upper())\nOUTPUT = {"s": TICKET_CONTEXT.get(\'repo_status\'), "k": "git_1"}\n');
		assert.strictEqual(fields[4].defaultUserPrompt, 'Summarize {repo_status} and {repo_status.stdout}; ignore {git_10} and {{repo_status}}');
		assert.deepStrictEqual(findOutputVariableReferences(fields, 'git_1', 'git_1'), []);
	});

	test('references in nested settings, skipping run results and the component itself', () => {
		const fields: ICustomField[] = [
			{ id: 'git_1', label: 'Git 1', type: 'git', defaultContent: '{git_1}' },
			{ id: 'sh', label: 'Shell 1', type: 'shell', lastExecutionLog: '{git_1}', pythonOutput: '{git_1}', httpHeaders: [{ key: 'X', value: '{git_1.commit}' }] } as ICustomField
		];
		const refs = findOutputVariableReferences(fields, 'git_1', 'git_1');
		assert.deepStrictEqual(refs.map(r => [r.fieldLabel, r.path]), [['Shell 1', 'httpHeaders.0.value']]);
		assert.strictEqual(replaceOutputVariableReferences(fields, 'git_1', 'git_1', 'g'), 1);
		assert.strictEqual(fields[0].defaultContent, '{git_1}');
		assert.strictEqual((fields[1] as ICustomField & { lastExecutionLog: string }).lastExecutionLog, '{git_1}');
	});
});
