/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runShellCommand } from '../../../../../platform/git/node/shellCommandRunner.js';
import { IShellRunResult } from '../../../entityPersistence/common/entityPersistence.js';
import { IShellComponentConfig, ShellExecutor, buildShellPlan, runShellPlan } from '../../common/shellComponent.js';

/**
 * Runs real /bin/sh (CI-55) in a throw-away folder under the OS temp folder, through the same script builder and
 * process runner the app uses (the shared-process service calls runShellCommand's start function).
 */
(process.platform === 'win32' ? suite.skip : suite)('shell component (real /bin/sh, temp folder)', function () {
	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const exec: ShellExecutor = plan => runShellCommand({ shell: plan.shell, script: plan.script, cwd: plan.cwd, env: plan.env, timeoutMs: plan.timeoutMs });

	setup(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), 'anyagent-shell-test-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function run(config: IShellComponentConfig, vars: Record<string, string> = {}): Promise<IShellRunResult> {
		const resolve = (text: string) => text.replace(/\{\{?([^{}]+)\}?\}/g, (m, k: string) => vars[k.trim()] ?? m);
		const built = buildShellPlan({ shellType: 'sh', ...config }, { resolve, baseDir: root, homeDir: root });
		assert.ok(built.ok, built.ok ? '' : built.error);
		return runShellPlan(built.plan, exec);
	}

	test('echo: stdout, exit 0, duration, cwd defaults to the base folder', async () => {
		const res = await run({ shellScript: 'echo hello\npwd' });
		assert.ok(res.ok, res.stderr);
		assert.strictEqual(res.exitCode, 0);
		const [first, cwd] = res.stdout.split('\n');
		assert.strictEqual(first, 'hello');
		assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(root));
		assert.ok(res.durationMs >= 0);
		assert.strictEqual(res.shell, 'sh');
	});

	test('exit 3 fails with stderr captured', async () => {
		const res = await run({ shellScript: 'echo out; echo oops >&2; exit 3' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.exitCode, 3);
		assert.strictEqual(res.stdout, 'out\n');
		assert.strictEqual(res.stderr, 'oops\n');
		assert.strictEqual(res.error, 'sh exited with code 3');
	});

	test('timeout kills the whole process group', async () => {
		const marker = join(root, 'child-survived');
		const started = Date.now();
		// the background child would write the marker after 3 s if it were not killed with the group
		const res = await run({ shellScript: `(sleep 3; touch '${marker}') &\nsleep 30`, shellTimeoutSec: 1 });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.timedOut, true);
		assert.match(res.error ?? '', /timed out after 1s/);
		assert.ok(Date.now() - started < 10_000, 'stopped long before sleep 30 ended');
		await new Promise(r => setTimeout(r, 3500));
		assert.ok(!fs.existsSync(marker), 'the background child was killed too');
	});

	test('working directory: relative to the base folder; a missing folder fails before running', async () => {
		fs.mkdirSync(join(root, 'sub dir'));
		const res = await run({ shellScript: 'pwd', shellCwd: 'sub dir' });
		assert.ok(res.ok, res.stderr);
		assert.strictEqual(fs.realpathSync(res.stdout.trim()), fs.realpathSync(join(root, 'sub dir')));
		const missing = await run({ shellScript: 'pwd', shellCwd: 'nope' });
		assert.strictEqual(missing.ok, false);
		assert.strictEqual(missing.exitCode, -1);
		assert.match(missing.error ?? '', /Directory does not exist/);
	});

	test('environment lines reach the script; stdin is closed', async () => {
		const res = await run({ shellScript: 'echo "$GREETING $WHO"; read line || echo no-stdin', shellEnv: 'GREETING=hi\nWHO={who}' }, { who: 'there' });
		assert.ok(res.ok, res.stderr);
		assert.strictEqual(res.stdout, 'hi there\nno-stdin\n');
	});

	test('variable values cannot inject shell syntax', async () => {
		const canary = join(root, 'canary');
		fs.writeFileSync(canary, 'keep');
		const evil = {
			semi: `x; rm -f '${canary}'; echo injected`,
			subst: `$(rm -f '${canary}')`,
			tick: `\`rm -f '${canary}'\``,
			quote: `"; rm -f '${canary}'; echo "`,
			single: `'; rm -f '${canary}'; echo '`,
			glob: '*'
		};
		const script = [
			'printf "%s\\n" {semi}',
			'printf "%s\\n" "in double: {subst}"',
			'printf "%s\\n" \'in single: {tick}\'',
			'printf "%s\\n" {quote} {single}',
			'printf "%s\\n" {glob}',
			'cat <<EOF',
			'heredoc: {semi}',
			'EOF'
		].join('\n');
		const res = await run({ shellScript: script }, evil);
		assert.ok(res.ok, res.stderr);
		assert.ok(fs.existsSync(canary), 'no injected rm ran');
		assert.strictEqual(res.stdout, [
			evil.semi,
			`in double: ${evil.subst}`,
			`in single: ${evil.tick}`,
			evil.quote,
			evil.single,
			'*',
			`heredoc: ${evil.semi}`,
			''
		].join('\n'));
		assert.ok(!res.command.includes('rm -f'), 'the values are not in the executed script');
	});
});
