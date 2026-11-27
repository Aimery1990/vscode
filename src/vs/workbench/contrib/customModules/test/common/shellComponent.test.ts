/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IShellRunResult } from '../../../entityPersistence/common/entityPersistence.js';
import { validateComponentConfig } from '../../common/componentConfigSchema.js';
import { getComponentSpec } from '../../common/componentRegistry.js';
import {
	IShellComponentConfig, SHELL_OUTPUT_FIELDS, SHELL_STORED_OUTPUT_MAX_BYTES, buildShellPlan, buildShellTicketValue, computeShellConfirmationHash,
	effectiveShellConfig, getShellConfirmationKey, isShellConfigConfirmed, isShellTicketValue, normalizeShellTicketValue, parseShellEnv,
	publishShellOutputs, runShellPlan, shellMainOutput, shellTicketValueOutputText, substituteShellVariables, toStoredShellResult
} from '../../common/shellComponent.js';

const VARS: Record<string, string> = { name: 'World', evil: 'x"; rm -rf ~; echo "', folder: '/tmp/my dir', 'Build Step.exitCode': '0', dir: '/work/repo' };
/** Resolver like the runtime's: unknown references stay as written. */
const resolve = (text: string) => text.replace(/\{\{?([^{}]+)\}?\}/g, (m, k: string) => VARS[k.trim()] ?? m);
const resolveRef = (ref: string) => {
	const value = resolve(ref);
	return value === ref ? undefined : value;
};
const opts = { resolve, baseDir: '/ws', homeDir: '/home/u' };

function plan(config: IShellComponentConfig) {
	const res = buildShellPlan(config, opts);
	assert.ok(res.ok, res.ok ? '' : res.error);
	return res.plan;
}

function planError(config: IShellComponentConfig): string {
	const res = buildShellPlan(config, opts);
	assert.ok(!res.ok, 'expected an error');
	return res.error;
}

function result(partial: Partial<IShellRunResult> = {}): IShellRunResult {
	return { ok: true, exitCode: 0, stdout: 'out\n', stderr: '', command: 'echo out', shell: 'sh', cwd: '/ws', durationMs: 5, ...partial };
}

suite('shell component (CI-55)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('variable substitution', () => {
		test('unquoted reference becomes one quoted expansion; the value goes to the environment', () => {
			const sub = substituteShellVariables('echo {name} {evil}', resolveRef);
			assert.strictEqual(sub.script, 'echo "${ANYAGENT_VAR_name}" "${ANYAGENT_VAR_evil}"');
			assert.deepStrictEqual(sub.env, { ANYAGENT_VAR_name: 'World', ANYAGENT_VAR_evil: 'x"; rm -rf ~; echo "' });
			assert.ok(!sub.script.includes('rm -rf'), 'the value never appears in the script');
			assert.deepStrictEqual(sub.variables, ['name', 'evil']);
		});

		test('inside double quotes, single quotes, $\'...\' and heredocs', () => {
			assert.strictEqual(substituteShellVariables('echo "Hello {name}!"', resolveRef).script, 'echo "Hello ${ANYAGENT_VAR_name}!"');
			assert.strictEqual(substituteShellVariables('echo \'Hello {name}\'', resolveRef).script, 'echo \'Hello \'"${ANYAGENT_VAR_name}"\'\'');
			assert.strictEqual(substituteShellVariables('echo $\'a\\n{name}\'', resolveRef).script, 'echo $\'a\\n\'"${ANYAGENT_VAR_name}"$\'\'');
			assert.strictEqual(substituteShellVariables('cat <<EOF\nHi {name}\nEOF\necho {name}', resolveRef).script, 'cat <<EOF\nHi ${ANYAGENT_VAR_name}\nEOF\necho "${ANYAGENT_VAR_name}"');
			// quoted heredoc: the shell does not expand, so the text stays as written
			assert.strictEqual(substituteShellVariables('cat <<\'EOF\' > a.py\nprint(f"{name}")\nEOF\necho {name}', resolveRef).script, 'cat <<\'EOF\' > a.py\nprint(f"{name}")\nEOF\necho "${ANYAGENT_VAR_name}"');
			assert.strictEqual(substituteShellVariables('cat <<-END\n\tx {name}\n\tEND\n', resolveRef).script, 'cat <<-END\n\tx ${ANYAGENT_VAR_name}\n\tEND\n');
		});

		test('shell syntax and unknown references are left alone', () => {
			const script = 'echo ${HOME} $((1<<2)) {a,b}\nawk \'{print $1}\' f # {name} in a comment\necho {unknown} {{name}}';
			const sub = substituteShellVariables(script, resolveRef);
			assert.strictEqual(sub.script, 'echo ${HOME} $((1<<2)) {a,b}\nawk \'{print $1}\' f # {name} in a comment\necho {unknown} "${ANYAGENT_VAR_name}"');
			assert.strictEqual(substituteShellVariables('echo \\{name}', resolveRef).script, 'echo \\{name}');
		});

		test('names with spaces / dots get safe environment names; repeated references share one variable', () => {
			const sub = substituteShellVariables('test {Build Step.exitCode} = 0 && echo {name}{name}', resolveRef);
			assert.strictEqual(sub.script, 'test "${ANYAGENT_VAR_Build_Step_exitCode}" = 0 && echo "${ANYAGENT_VAR_name}""${ANYAGENT_VAR_name}"');
			assert.deepStrictEqual(Object.keys(sub.env), ['ANYAGENT_VAR_Build_Step_exitCode', 'ANYAGENT_VAR_name']);
		});
	});

	suite('plan', () => {
		test('cwd: default, ~, relative, absolute, variable', () => {
			assert.strictEqual(plan({ shellScript: 'ls' }).cwd, '/ws');
			assert.strictEqual(plan({ shellScript: 'ls', shellCwd: '~/code' }).cwd, '/home/u/code');
			assert.strictEqual(plan({ shellScript: 'ls', shellCwd: 'sub/dir' }).cwd, '/ws/sub/dir');
			assert.strictEqual(plan({ shellScript: 'ls', shellCwd: '{dir}' }).cwd, '/work/repo');
			assert.match(planError({ shellScript: 'ls', shellCwd: '{missing}' }), /variable \{missing\} has no value/);
		});

		test('shell, timeout and environment', () => {
			const p = plan({ shellScript: 'echo {name}', shellType: 'SH', shellTimeoutSec: '30', shellEnv: 'A=1\n# comment\nexport B="two words"\nTOKEN={name}' });
			assert.strictEqual(p.shell, 'sh');
			assert.strictEqual(p.timeoutMs, 30_000);
			assert.deepStrictEqual(p.env, { A: '1', B: 'two words', TOKEN: 'World', ANYAGENT_VAR_name: 'World' });
			assert.strictEqual(plan({ shellScript: 'x' }).timeoutMs, 120_000);
			assert.match(planError({ shellScript: 'x', shellTimeoutSec: 4000 }), /between 1 and 3600/);
			assert.match(planError({ shellScript: 'x', shellType: 'fish' }), /not supported/);
			assert.match(planError({ shellScript: '  ' }), /Script is empty/);
		});

		test('environment lines: forbidden names, plain-text secrets, reserved prefix', () => {
			assert.deepStrictEqual(parseShellEnv('A=1\nB = 2').entries, [{ key: 'A', value: '1' }, { key: 'B', value: '2' }]);
			for (const line of ['BASH_ENV=/tmp/x', 'LD_PRELOAD=/x.so', 'DYLD_INSERT_LIBRARIES=/x', 'ANYAGENT_VAR_name=x', 'IFS=x', '1A=x', 'NOVALUE']) {
				assert.strictEqual(parseShellEnv(line).errors.length, 1, line);
			}
			assert.match(parseShellEnv('API_TOKEN=abc123').errors[0], /looks like a secret/);
			assert.deepStrictEqual(parseShellEnv('API_TOKEN={API_TOKEN}').errors, []);
			assert.match(planError({ shellScript: 'x', shellEnv: 'PASSWORD=hunter2' }), /Environment: .*secret/);
		});
	});

	suite('validation', () => {
		test('validateComponentConfig checks the script, shell, timeout and environment', () => {
			assert.deepStrictEqual(validateComponentConfig('shell', { shellScript: 'ls', shellType: 'bash', shellTimeoutSec: 60, shellEnv: 'A=1' }), []);
			assert.ok(validateComponentConfig('shell', {}).some(e => e.prop === 'shellScript' && e.code === 'required'));
			assert.ok(validateComponentConfig('shell', { shellScript: 'ls', shellType: 'fish' }).some(e => e.prop === 'shellType'));
			assert.ok(validateComponentConfig('shell', { shellScript: 'ls', shellTimeoutSec: 0 }).some(e => e.prop === 'shellTimeoutSec' && e.code === 'invalidValue'));
			assert.ok(validateComponentConfig('shell', { shellScript: 'ls', shellEnv: 'SECRET_KEY=abc' }).some(e => e.prop === 'shellEnv' && e.code === 'invalidValue'));
			// the confirmation marker and the last result are state: the AI cannot write them
			const ai = validateComponentConfig('shell', { shellScript: 'ls', shellConfirmedHash: 'abc' }, { writableRoles: ['config'] });
			assert.ok(ai.some(e => e.prop === 'shellConfirmedHash' && e.code === 'notWritable'));
		});

		test('registry spec: outputs cover the structured fields', () => {
			const spec = getComponentSpec('shell')!;
			assert.ok(spec);
			for (const field of SHELL_OUTPUT_FIELDS) {
				assert.ok(spec.outputs.some(o => o.name === `{Label.${field}}`), field);
			}
			assert.ok(spec.outputs.some(o => o.name === '{Label}_result'));
			assert.strictEqual(spec.icon.id, 'terminal');
		});
	});

	suite('outputs and stored value', () => {
		test('publish: main text, dotted fields and the _result dict under label and cleaned key', () => {
			const ctx: Record<string, unknown> = {};
			const main = publishShellOutputs(ctx, 'Build Step', result({ stdout: 'built\n' }));
			assert.strictEqual(main, 'built\n');
			assert.strictEqual(ctx['Build Step'], 'built\n');
			assert.strictEqual(ctx['build_step'], 'built\n');
			assert.strictEqual(ctx['Build Step.exitCode'], 0);
			assert.strictEqual(ctx['build_step.cwd'], '/ws');
			assert.deepStrictEqual(Object.keys(ctx['build_step_result'] as object), [...SHELL_OUTPUT_FIELDS]);
			assert.strictEqual(shellMainOutput(result({ ok: false, exitCode: 3, stdout: 'o', stderr: 'bad' })), 'bad');
		});

		test('runShellPlan maps a non-zero exit to a failure', async () => {
			const p = plan({ shellScript: 'exit 3', shellType: 'sh' });
			const res = await runShellPlan(p, async () => ({ exitCode: 3, stdout: '', stderr: 'boom', durationMs: 7 }));
			assert.strictEqual(res.ok, false);
			assert.strictEqual(res.exitCode, 3);
			assert.strictEqual(res.error, 'sh exited with code 3');
			assert.strictEqual(res.cwd, '/ws');
			assert.strictEqual(res.command, 'exit 3');
		});

		test('stored value: output truncated with a note; settings, marker and result round-trip', () => {
			const big = 'x'.repeat(SHELL_STORED_OUTPUT_MAX_BYTES + 100);
			const stored = toStoredShellResult(result({ stdout: big }));
			assert.ok(stored.stdout.length < big.length);
			assert.match(stored.stdout, /truncated/);
			const value = buildShellTicketValue({ shellScript: 'ls', shellConfirmedHash: 'h' }, result());
			assert.ok(isShellTicketValue(value));
			const parsed = normalizeShellTicketValue(JSON.stringify(value));
			assert.strictEqual(parsed?.shellScript, 'ls');
			assert.strictEqual(parsed?.shellConfirmedHash, 'h');
			assert.strictEqual(shellTicketValueOutputText(JSON.stringify(value)), 'out\n');
			assert.strictEqual(normalizeShellTicketValue('plain text'), undefined);
			assert.deepStrictEqual(effectiveShellConfig({ shellScript: 'a', shellCwd: '/t' }, { shellScript: 'b', shellCwd: '' }), { shellScript: 'b', shellCwd: '/t' });
		});
	});

	suite('confirmation marker', () => {
		test('HMAC over shell + cwd + script + env: any change invalidates it; another key cannot produce it', async () => {
			const config: IShellComponentConfig = { shellScript: 'ls -la\n', shellCwd: '/ws', shellType: 'bash', shellEnv: 'A=1', shellTimeoutSec: 10 };
			const marker = await computeShellConfirmationHash('k1', config);
			assert.match(marker, /^[0-9a-f]{64}$/);
			assert.strictEqual(await computeShellConfirmationHash('k1', { ...config }), marker);
			assert.ok(await isShellConfigConfirmed('k1', config, [undefined, marker]));
			assert.ok(await isShellConfigConfirmed('k1', { ...config, shellTimeoutSec: 99 }, [marker]), 'the timeout is not covered');
			assert.ok(await isShellConfigConfirmed('k1', { ...config, shellScript: 'ls -la\r\n' }, [marker]), 'line endings are normalized');
			for (const changed of [{ shellScript: 'ls -la; rm -rf ~\n' }, { shellCwd: '/' }, { shellType: 'zsh' }, { shellEnv: 'A=2' }]) {
				assert.ok(!(await isShellConfigConfirmed('k1', { ...config, ...changed }, [marker])), JSON.stringify(changed));
			}
			assert.ok(!(await isShellConfigConfirmed('k2', config, [marker])), 'a different key does not confirm');
			assert.ok(!(await isShellConfigConfirmed('k1', config, [])));
		});

		test('the local key is created once and kept', () => {
			const storage = store.add(new InMemoryStorageService());
			const key = getShellConfirmationKey(storage);
			assert.match(key, /^[0-9a-f]{64}$/);
			assert.strictEqual(getShellConfirmationKey(storage), key);
		});
	});
});
