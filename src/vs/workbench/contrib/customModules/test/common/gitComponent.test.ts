/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGitRunResult } from '../../../entityPersistence/common/entityPersistence.js';
import { validateComponentConfig } from '../../common/componentConfigSchema.js';
import { getComponentSpec } from '../../common/componentRegistry.js';
import {
	GIT_COMMANDS, GIT_COMMAND_INFO, GIT_LEGACY_ADD_ALL_NOTICE, GIT_OUTPUT_FIELDS, GIT_PARAM_INFO, GIT_STORED_OUTPUT_MAX_BYTES, IGitComponentConfig, IGitStepResult, buildGitPlan, buildGitTicketValue,
	effectiveGitConfig, formatGitCommandLine, gitLegacyAddAllNotice, gitMainOutput, gitTicketValueOutputText, isGitReferenceOnly, isGitTicketValue, normalizeGitTicketValue,
	pickGitConfig, publishGitOutputs, runGitPlan, splitGitArgs, toStoredGitResult
} from '../../common/gitComponent.js';

const VARS: Record<string, string> = { repo: '/work/my repo', msg: 'Fix "quotes" & $HOME `x`', br: 'feature/x', file: 'a file.txt', evil: '--force' };
const resolve = (text: string) => text.replace(/\{([^{}]+)\}/g, (m, k) => VARS[k] ?? m);
const opts = { resolve, baseDir: '/ws', homeDir: '/home/u' };

/** The ONE git invocation (argv after `git`) a config maps to (CI-63: a plan has no second command). */
function argv(config: IGitComponentConfig): readonly string[] {
	const res = buildGitPlan(config, opts);
	assert.ok(res.ok, res.ok ? '' : res.error);
	return res.plan.args;
}

function error(config: IGitComponentConfig): string {
	const res = buildGitPlan(config, opts);
	assert.ok(!res.ok, 'expected an error');
	return res.error;
}

function result(partial: Partial<IGitRunResult>): IGitRunResult {
	return { ok: true, exitCode: 0, stdout: '', stderr: '', command: 'git status', gitCommand: 'status', repoPath: '/r', branch: 'main', commit: 'abc1234', durationMs: 5, ...partial };
}

suite('gitComponent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('argv per command', () => {
		const repo = { gitRepoPath: '/r' };
		assert.deepStrictEqual(argv({ ...repo }), ['status']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'status' }), ['status']);
		assert.deepStrictEqual(argv({ gitCommand: 'clone', gitRemoteUrl: 'git@github.com:org/repo.git' }), ['clone', '--', 'git@github.com:org/repo.git', '/ws/repo']);
		assert.deepStrictEqual(argv({ gitCommand: 'clone', gitRemoteUrl: 'https://h/x.git', gitCloneDir: '~/code/x', gitBranch: 'dev' }), ['clone', '--branch', 'dev', '--', 'https://h/x.git', '/home/u/code/x']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'checkout', gitBranch: 'dev' }), ['checkout', 'dev']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'checkout', gitBranch: 'dev', gitCreateBranch: true }), ['checkout', '-b', 'dev']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'pull' }), ['pull']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'pull', gitBranch: 'main' }), ['pull', 'origin', 'main']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'pull', gitRemote: 'up', gitBranch: 'main' }), ['pull', 'up', 'main']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'fetch' }), ['fetch']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'fetch', gitRemote: 'origin' }), ['fetch', 'origin']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add' }), ['add', '--', '.']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add', gitPaths: 'src "my dir/x.ts" {file}' }), ['add', '--', 'src', 'my dir/x.ts', 'a file.txt']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'commit', gitMessage: 'Msg' }), ['commit', '-m', 'Msg']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'push' }), ['push']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'push', gitSetUpstream: true }), ['push', '--set-upstream', 'origin', 'HEAD']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'push', gitBranch: 'dev' }), ['push', 'origin', 'dev']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'log' }).slice(0, 3), ['log', '-n', '10']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'log', gitLogCount: '3' }).slice(0, 3), ['log', '-n', '3']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'diff' }), ['diff']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'diff', gitDiffTarget: 'HEAD~1 --stat' }), ['diff', 'HEAD~1', '--stat']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'branch' }), ['branch', '-a']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'branch', gitBranch: 'topic' }), ['branch', 'topic']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'custom', gitCustomArgs: 'git stash list' }), ['stash', 'list']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'custom', gitCustomArgs: 'tag -a v1 -m "Release 1"' }), ['tag', '-a', 'v1', '-m', 'Release 1']);
		// Every command has an info entry and builds with a minimal config
		for (const cmd of GIT_COMMANDS) {
			assert.ok(GIT_COMMAND_INFO[cmd].params.length > 0, cmd);
		}
	});

	test('variables: resolved per argument, never split, never shell-interpreted', () => {
		const res = buildGitPlan({ gitCommand: 'commit', gitRepoPath: '{repo}', gitMessage: '{msg}' }, opts);
		assert.ok(res.ok);
		assert.strictEqual(res.plan.cwd, '/work/my repo');
		assert.deepStrictEqual(res.plan.args, ['commit', '-m', 'Fix "quotes" & $HOME `x`']);
		assert.deepStrictEqual(argv({ gitRepoPath: '/r', gitCommand: 'custom', gitCustomArgs: 'checkout {br}' }), ['checkout', 'feature/x']);
		// Relative paths resolve against the workspace folder; ~ against home
		assert.strictEqual((buildGitPlan({ gitRepoPath: 'sub/repo' }, opts) as { plan: { cwd: string } }).plan.cwd, '/ws/sub/repo');
		assert.strictEqual((buildGitPlan({ gitRepoPath: '~/r' }, opts) as { plan: { cwd: string } }).plan.cwd, '/home/u/r');
	});

	test('invalid configs are refused', () => {
		assert.match(error({ gitCommand: 'status' }), /Repository path is required/);
		assert.match(error({ gitCommand: 'clone' }), /Repository URL is required/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'checkout' }), /Branch is required/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'commit', gitMessage: '  ' }), /Commit message is required/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'custom', gitCustomArgs: '  ' }), /Custom git command is empty/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'custom', gitCustomArgs: 'git' }), /Custom git command is empty/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'custom', gitCustomArgs: 'log "oops' }), /Unterminated double quote/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'checkout', gitBranch: '{evil}' }), /not valid/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'push', gitRemote: '-f' }), /not valid/);
		assert.match(error({ gitRepoPath: '{missing}' }), /variable \{missing\} has no value/);
		assert.match(error({ gitRepoPath: '/r', gitCommand: 'log', gitLogCount: 'many' }), /positive number/);
		assert.match(buildGitPlan({ gitRepoPath: 'rel' }, { resolve }).ok ? '' : (buildGitPlan({ gitRepoPath: 'rel' }, { resolve }) as { error: string }).error, /relative/);
	});

	test('tokenizer and display quoting', () => {
		assert.deepStrictEqual(splitGitArgs(`a  'b c' "d \\"e\\"" f\\ g ''`).args, ['a', 'b c', 'd "e"', 'f g', '']);
		assert.ok(splitGitArgs(`'x`).error);
		assert.strictEqual(formatGitCommandLine(['commit', '-m', `it's done`]), `git commit -m 'it'\\''s done'`);
		assert.strictEqual(formatGitCommandLine(['log', '-n', '10']), 'git log -n 10');
	});

	test('runGitPlan: runs the one command, then only reads branch / commit', async () => {
		const calls: string[] = [];
		const exec = async (args: readonly string[]): Promise<IGitStepResult> => {
			calls.push(args.join(' '));
			if (args[0] === 'commit') {
				return { exitCode: 1, stdout: 'nothing to commit', stderr: '', durationMs: 2 };
			}
			if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
				return { exitCode: 0, stdout: 'main\n', stderr: '', durationMs: 1 };
			}
			if (args[0] === 'rev-parse') {
				return { exitCode: 0, stdout: 'abc1234\n', stderr: '', durationMs: 1 };
			}
			return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
		};
		// An old commit card with gitAddAll: true still runs ONLY git commit (CI-63)
		const built = buildGitPlan({ gitRepoPath: '/r', gitCommand: 'commit', gitMessage: 'm', gitAddAll: true }, opts);
		assert.ok(built.ok);
		const res = await runGitPlan(built.plan, exec);
		assert.deepStrictEqual(calls, ['commit -m m', 'rev-parse --abbrev-ref HEAD', 'rev-parse --short HEAD']);
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.exitCode, 1);
		assert.strictEqual(res.branch, 'main');
		assert.strictEqual(res.commit, 'abc1234');
		assert.strictEqual(res.command, 'git commit -m m');
		assert.strictEqual(gitMainOutput(res), 'nothing to commit');
	});

	test('CI-63: commit never stages; add is its own command (paths or -A)', () => {
		const repo = { gitRepoPath: '/r' };
		// commit: exactly `git commit -m <message>`, with or without the deprecated option
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'commit', gitMessage: 'Msg' }), ['commit', '-m', 'Msg']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'commit', gitMessage: 'Msg', gitAddAll: true }), ['commit', '-m', 'Msg']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'commit', gitMessage: 'Msg', gitAll: true }), ['commit', '-m', 'Msg']);
		assert.ok(!GIT_COMMAND_INFO.commit.params.some(p => p === 'gitAll' || String(p) === 'gitAddAll'), 'commit offers no add option');
		assert.ok(!Object.values(GIT_PARAM_INFO).some(info => /add -A/.test(info.label) && !GIT_COMMAND_INFO.add.params.includes(info.key)), 'no add-all option outside add');
		// add: paths (default .) or all (-A)
		assert.deepStrictEqual(GIT_COMMAND_INFO.add.params, ['gitRepoPath', 'gitPaths', 'gitAll']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add' }), ['add', '--', '.']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add', gitPaths: 'src docs' }), ['add', '--', 'src', 'docs']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add', gitAll: true }), ['add', '-A']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add', gitAll: 'true' as unknown as boolean, gitPaths: 'src' }), ['add', '-A']);
		assert.deepStrictEqual(argv({ ...repo, gitCommand: 'add', gitAll: false, gitPaths: 'src' }), ['add', '--', 'src']);
		// display: one command, never chained
		const shown = (config: IGitComponentConfig) => formatGitCommandLine(argv(config));
		assert.strictEqual(shown({ ...repo, gitCommand: 'commit', gitMessage: 'First Git 测试', gitAddAll: true }), `git commit -m 'First Git 测试'`);
		assert.strictEqual(shown({ ...repo, gitCommand: 'add', gitAll: true }), 'git add -A');
	});

	test('CI-63 audit: every command maps to exactly one native git invocation of the same name', () => {
		const repo = { gitRepoPath: '/r' };
		const maximal: Record<string, IGitComponentConfig> = {
			status: { ...repo },
			clone: { gitRemoteUrl: 'https://h/x.git', gitCloneDir: '/c/x', gitBranch: 'dev' },
			checkout: { ...repo, gitBranch: 'dev', gitCreateBranch: true },
			pull: { ...repo, gitRemote: 'origin', gitBranch: 'main' },
			fetch: { ...repo, gitRemote: 'origin' },
			add: { ...repo, gitAll: true, gitPaths: 'x' },
			commit: { ...repo, gitMessage: 'm', gitAddAll: true, gitAll: true },
			push: { ...repo, gitSetUpstream: true, gitBranch: 'dev' },
			log: { ...repo, gitLogCount: 3 },
			diff: { ...repo, gitDiffTarget: 'HEAD~1' },
			branch: { ...repo, gitBranch: 'topic' },
			custom: { ...repo, gitCustomArgs: 'stash list' }
		};
		for (const cmd of GIT_COMMANDS) {
			const res = buildGitPlan({ gitCommand: cmd, ...maximal[cmd] }, opts);
			assert.ok(res.ok, cmd);
			const args = res.plan.args;
			assert.ok(args.length > 0 && args.every(a => typeof a === 'string'), `${cmd}: a flat argv (one command)`);
			if (cmd !== 'custom') {
				assert.strictEqual(args[0], cmd, `${cmd}: runs git ${cmd}`);
			}
			assert.ok(!args.includes('&&') && !args.includes(';'), `${cmd}: no chaining`);
			assert.ok(!formatGitCommandLine(args).includes(' && '), cmd);
		}
	});

	test('CI-63 migration: old data with gitAddAll parses, keeps the flag and shows a one-time notice', () => {
		// The fixture of ANYAG-0118 as stored before CI-63
		const legacyTemplate = JSON.parse('{"id":"commit_step","label":"Commit Step","type":"git","gitCommand":"commit","gitRepoPath":"/r","gitMessage":"First {Title}","gitAddAll":true}');
		const template = pickGitConfig(legacyTemplate);
		assert.strictEqual(template.gitAddAll, true, 'kept (not silently dropped)');
		assert.strictEqual(gitLegacyAddAllNotice(template), GIT_LEGACY_ADD_ALL_NOTICE);
		assert.match(GIT_LEGACY_ADD_ALL_NOTICE, /used to run git add -A before commit\. Add an 'add' card before it/);
		// A stored ticket value (text) with the old option parses without errors
		const ticketValue = normalizeGitTicketValue('{"gitCommand":"commit","gitAddAll":true,"gitLastResult":{"ok":true,"exitCode":0,"stdout":"","stderr":"","command":"git add -A && git commit -m \'First \'","gitCommand":"commit","repoPath":"/r","branch":"main","commit":"54822f8","durationMs":35}}');
		assert.ok(ticketValue);
		assert.strictEqual(ticketValue.gitAddAll, true);
		assert.strictEqual(ticketValue.gitLastResult?.commit, '54822f8');
		assert.ok(isGitTicketValue({ gitAddAll: true }));
		// The notice applies to commit cards only, and only while the option is true
		assert.strictEqual(gitLegacyAddAllNotice({ gitCommand: 'commit', gitAddAll: 'true' as unknown as boolean }), GIT_LEGACY_ADD_ALL_NOTICE);
		assert.strictEqual(gitLegacyAddAllNotice({ gitCommand: 'commit' }), undefined);
		assert.strictEqual(gitLegacyAddAllNotice({ gitCommand: 'add', gitAddAll: true }), undefined);
		assert.strictEqual(gitLegacyAddAllNotice({ gitCommand: 'commit', gitAddAll: false }), undefined);
		// Dismissing stores false on the ticket, which wins over the template's true (one-time)
		assert.strictEqual(gitLegacyAddAllNotice(effectiveGitConfig(template, { gitAddAll: false })), undefined);
		assert.strictEqual(gitLegacyAddAllNotice(effectiveGitConfig(template, {})), GIT_LEGACY_ADD_ALL_NOTICE);
		// The schema validator accepts the old property (state: kept, not writable by AI)
		assert.deepStrictEqual(validateComponentConfig('git', { gitCommand: 'commit', gitRepoPath: '/r', gitMessage: 'm', gitAddAll: true }).map(e => e.code), []);
		assert.deepStrictEqual(validateComponentConfig('git', { gitAddAll: true, gitCommand: 'commit', gitRepoPath: '/r', gitMessage: 'm' }, { writableRoles: ['config'] }).map(e => `${e.code}:${e.prop}`), ['notWritable:gitAddAll']);
		assert.deepStrictEqual(validateComponentConfig('git', { gitCommand: 'add', gitRepoPath: '/r', gitAll: true }, { writableRoles: ['config'] }), []);
	});

	test('outputs: main text and structured fields', () => {
		const ctx: Record<string, unknown> = {};
		const main = publishGitOutputs(ctx, 'Git Status', result({ stdout: 'clean' }));
		assert.strictEqual(main, 'clean');
		assert.strictEqual(ctx['Git Status'], 'clean');
		assert.strictEqual(ctx['git_status'], 'clean');
		assert.strictEqual(ctx['Git Status.ok'], true);
		assert.strictEqual(ctx['git_status.exitCode'], 0);
		assert.strictEqual(ctx['Git Status.branch'], 'main');
		assert.deepStrictEqual(Object.keys(ctx['git_status_result'] as object), [...GIT_OUTPUT_FIELDS]);
		assert.strictEqual(gitMainOutput(result({ ok: false, exitCode: 128, stdout: 'x', stderr: 'fatal: no' })), 'fatal: no');
		assert.strictEqual(gitMainOutput(result({ ok: false, exitCode: -1, error: 'Directory does not exist' })), 'Directory does not exist');
		// Every structured field is documented in the registry outputs
		const outputs = getComponentSpec('git')!.outputs.map(o => o.name);
		for (const field of GIT_OUTPUT_FIELDS) {
			assert.ok(outputs.includes(`{var.${field}}`), field);
		}
		// Also under the output variable (UI-27), the label-based names stay
		const aliased: Record<string, unknown> = {};
		publishGitOutputs(aliased, 'Git Status', result({ stdout: 'clean' }), ['repo_status', undefined]);
		assert.strictEqual(aliased['repo_status'], 'clean');
		assert.strictEqual(aliased['repo_status.stdout'], 'clean');
		assert.strictEqual(aliased['repo_status.ok'], true);
		assert.deepStrictEqual(Object.keys(aliased['repo_status_result'] as object), [...GIT_OUTPUT_FIELDS]);
		assert.strictEqual(aliased['Git Status.stdout'], 'clean');
		assert.strictEqual(aliased['git_status.ok'], true);
	});

	test('ticket value: ticket settings win, results are truncated when stored', () => {
		assert.deepStrictEqual(effectiveGitConfig({ gitCommand: 'status', gitRepoPath: '/t' }, { gitRepoPath: '/mine' }), { gitCommand: 'status', gitRepoPath: '/mine' });
		assert.ok(isGitReferenceOnly({ gitRemoteUrl: 'x' }));
		assert.ok(!isGitReferenceOnly({ gitRepoPath: '/r' }));
		const big = 'é'.repeat(4000);
		const stored = toStoredGitResult(result({ stdout: big, stderr: 'short' }));
		assert.ok(new TextEncoder().encode(stored.stdout).length < GIT_STORED_OUTPUT_MAX_BYTES + 100);
		assert.match(stored.stdout, /truncated: 8000 bytes in total/);
		assert.strictEqual(stored.stderr, 'short');
		const value = buildGitTicketValue({ gitCommand: 'log', gitRepoPath: '/r' }, result({ stdout: 'abc' }));
		const parsed = normalizeGitTicketValue(JSON.stringify(value));
		assert.strictEqual(parsed?.gitCommand, 'log');
		assert.strictEqual(parsed?.gitLastResult?.stdout, 'abc');
		assert.strictEqual(gitTicketValueOutputText(JSON.stringify(value)), 'abc');
		assert.ok(isGitTicketValue({ gitRepoPath: '/r' }));
		assert.ok(!isGitTicketValue({ url: 'x' }));
		assert.strictEqual(normalizeGitTicketValue('plain text'), undefined);
	});

	test('validator: per-command required settings and invalid values', () => {
		const codes = (config: Record<string, unknown>, checkRequired = true) => validateComponentConfig('git', config, { writableRoles: ['config'], checkRequired, aiWrite: true }).map(e => `${e.code}:${e.prop}`);
		assert.deepStrictEqual(codes({ gitCommand: 'status', gitRepoPath: '{repo}' }), []);
		assert.deepStrictEqual(codes({ gitCommand: 'status' }), ['required:gitRepoPath']);
		assert.deepStrictEqual(codes({ gitCommand: 'clone' }), ['required:gitRemoteUrl']);
		assert.deepStrictEqual(codes({ gitCommand: 'commit', gitRepoPath: '/r' }), ['required:gitMessage']);
		assert.deepStrictEqual(codes({ gitCommand: 'custom', gitRepoPath: '/r' }), ['required:gitCustomArgs']);
		assert.deepStrictEqual(codes({ gitCommand: 'custom', gitRepoPath: '/r' }, false), []);
		assert.deepStrictEqual(codes({ gitCommand: 'rebase', gitRepoPath: '/r' }), ['enum:gitCommand']);
		assert.deepStrictEqual(codes({ gitCommand: 'push', gitRepoPath: '/r', gitRemote: '--force' }), ['invalidValue:gitRemote']);
		assert.deepStrictEqual(codes({ gitCommand: 'log', gitRepoPath: '/r', gitLogCount: 'x' }), ['type:gitLogCount']);
		assert.deepStrictEqual(codes({ gitLastResult: {} }), ['notWritable:gitLastResult']);
		// Pre CI-24 reference-only config stays valid
		assert.deepStrictEqual(codes({ gitRemoteUrl: 'git@h:o/r.git', gitBranch: 'main' }), []);
	});
});
