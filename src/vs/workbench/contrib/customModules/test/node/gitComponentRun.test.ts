/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GIT_NON_INTERACTIVE_ENV, runGitCommand } from '../../../../../platform/git/node/gitCommandRunner.js';
import { IGitRunResult } from '../../../entityPersistence/common/entityPersistence.js';
import { GitExecutor, IGitComponentConfig, buildGitPlan, runGitPlan } from '../../common/gitComponent.js';

/**
 * Runs real git (CI-24) in a throw-away repository under the OS temp folder, through the same argv builder and
 * executor the app uses. The user's git configuration is isolated (HOME, global / system config).
 */
suite('git component (real git, temp repository)', function () {
	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let repo: string;
	let exec: GitExecutor;

	setup(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), 'anyagent-git-test-'));
		repo = join(root, 'repo');
		fs.mkdirSync(repo);
		const env = {
			HOME: root,
			XDG_CONFIG_HOME: root,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
			GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
		};
		fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
		exec = (args, cwd, timeoutMs) => runGitCommand(args, { cwd, timeoutMs, env });
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function run(config: IGitComponentConfig): Promise<IGitRunResult> {
		const built = buildGitPlan({ gitRepoPath: repo, ...config }, { resolve: t => t.replace('{name}', 'feature one'), baseDir: root });
		assert.ok(built.ok, built.ok ? '' : built.error);
		return runGitPlan(built.plan, exec);
	}

	test('init, status, add, commit, log, branch, checkout -b', async () => {
		const init = await run({ gitCommand: 'custom', gitCustomArgs: 'init -b main' });
		assert.strictEqual(init.exitCode, 0, init.stderr);

		fs.writeFileSync(join(repo, 'a file.txt'), 'hello\n');
		const status = await run({ gitCommand: 'status' });
		assert.ok(status.ok, status.stderr);
		assert.match(status.stdout, /a file\.txt/);
		assert.strictEqual(status.branch, 'main');

		const add = await run({ gitCommand: 'add', gitPaths: '"a file.txt"' });
		assert.ok(add.ok, add.stderr);

		const commit = await run({ gitCommand: 'commit', gitMessage: 'First "commit" & $(echo not-a-shell)' });
		assert.ok(commit.ok, commit.stderr);
		assert.match(commit.commit, /^[0-9a-f]{7,}$/);

		// CI-63: commit never stages, even for an old card with gitAddAll; staging is its own add card (-A)
		fs.writeFileSync(join(repo, 'b.txt'), 'b\n');
		const commitOld = await run({ gitCommand: 'commit', gitMessage: 'Second', gitAddAll: true });
		assert.strictEqual(commitOld.ok, false, 'b.txt is not staged, so git commit has nothing to commit');
		assert.strictEqual(commitOld.command, 'git commit -m Second');
		const addAll = await run({ gitCommand: 'add', gitAll: true });
		assert.ok(addAll.ok, addAll.stderr);
		assert.strictEqual(addAll.command, 'git add -A');
		const commitAll = await run({ gitCommand: 'commit', gitMessage: 'Second' });
		assert.ok(commitAll.ok, commitAll.stderr);
		assert.strictEqual(commitAll.command, 'git commit -m Second');

		const log = await run({ gitCommand: 'log', gitLogCount: 5 });
		assert.ok(log.ok, log.stderr);
		const lines = log.stdout.trim().split('\n');
		assert.strictEqual(lines.length, 2);
		assert.match(lines[1], /First "commit" & \$\(echo not-a-shell\)/);

		const branch = await run({ gitCommand: 'branch', gitBranch: 'topic' });
		assert.ok(branch.ok, branch.stderr);
		const list = await run({ gitCommand: 'branch' });
		assert.match(list.stdout, /topic/);

		const checkout = await run({ gitCommand: 'checkout', gitBranch: 'feature/x', gitCreateBranch: true });
		assert.ok(checkout.ok, checkout.stderr);
		assert.strictEqual(checkout.branch, 'feature/x');

		const diff = await run({ gitCommand: 'diff', gitDiffTarget: 'main --stat' });
		assert.ok(diff.ok, diff.stderr);
	});

	test('failures: non-zero exit, missing directory, empty custom command', async () => {
		const notRepo = await run({ gitCommand: 'status' });
		assert.strictEqual(notRepo.ok, false);
		assert.notStrictEqual(notRepo.exitCode, 0);
		assert.match(notRepo.stderr, /not a git repository/i);

		const missing = await runGitPlan({ command: 'status', args: ['status'], cwd: join(root, 'nope'), repoPath: join(root, 'nope') }, exec);
		assert.strictEqual(missing.ok, false);
		assert.strictEqual(missing.exitCode, -1);
		assert.match(missing.error ?? '', /does not exist/);

		assert.ok(!buildGitPlan({ gitRepoPath: repo, gitCommand: 'custom', gitCustomArgs: '' }, { resolve: t => t }).ok);
	});

	test('never prompts: an unreachable https remote fails instead of waiting', async () => {
		await run({ gitCommand: 'custom', gitCustomArgs: 'init -b main' });
		const res = await runGitCommand(['ls-remote', 'https://127.0.0.1:9/none.git'], { cwd: repo, timeoutMs: 20_000 });
		assert.notStrictEqual(res.exitCode, 0);
		assert.strictEqual(res.timedOut, false);
	});

	test('never prompts: an inherited GIT_ASKPASS / SSH_ASKPASS / core.askPass is not used (CI-65)', async () => {
		assert.strictEqual(GIT_NON_INTERACTIVE_ENV.GIT_ASKPASS, '');
		await run({ gitCommand: 'custom', gitCustomArgs: 'init -b main' });
		// A remote that asks for a user name and password
		const http = await import('http');
		const server = http.createServer((_req, res) => {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
			res.end();
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as { port: number }).port;
		// An askpass program that would wait for a person (like an editor's password dialog)
		const marker = join(root, 'askpass-called');
		const askpass = join(root, 'askpass.sh');
		fs.writeFileSync(askpass, `#!/bin/sh\necho called >> '${marker}'\nsleep 30\necho secret\n`, { mode: 0o755 });
		await runGitCommand(['config', 'core.askPass', askpass], { cwd: repo });
		const saved = { GIT_ASKPASS: process.env['GIT_ASKPASS'], SSH_ASKPASS: process.env['SSH_ASKPASS'] };
		process.env['GIT_ASKPASS'] = askpass;
		process.env['SSH_ASKPASS'] = askpass;
		try {
			const res = await runGitCommand(['ls-remote', `http://127.0.0.1:${port}/x.git`], { cwd: repo, timeoutMs: 20_000 });
			assert.notStrictEqual(res.exitCode, 0);
			assert.strictEqual(res.timedOut, false);
			assert.match(res.stderr, /terminal prompts disabled|could not read Username/i);
			assert.ok(res.durationMs < 10_000, `took ${res.durationMs} ms`);
			assert.strictEqual(fs.existsSync(marker), false, 'the askpass program was started');
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
