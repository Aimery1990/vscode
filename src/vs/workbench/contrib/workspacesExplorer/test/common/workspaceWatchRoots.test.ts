/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeExternalWatchRoots, isEqualOrUnder, MANAGED_WORKSPACE_WATCH_EXCLUDES } from '../../common/workspaceWatchRoots.js';

suite('workspaceWatchRoots (UI-30)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const f = (p: string) => URI.file(p);
	const paths = (uris: URI[]) => uris.map(u => u.path);

	test('isEqualOrUnder', () => {
		assert.ok(isEqualOrUnder(f('/a/b'), f('/a/b')));
		assert.ok(isEqualOrUnder(f('/a/b/c'), f('/a/b')));
		assert.ok(!isEqualOrUnder(f('/a/bc'), f('/a/b')));
		assert.ok(!isEqualOrUnder(f('/a'), f('/a/b')));
	});

	test('roots inside or equal to an opened folder need no watcher', () => {
		const roots = [f('/ws/opened'), f('/ws/opened/inner'), f('/ws/other'), f('/ws/opened-sibling')];
		assert.deepStrictEqual(paths(computeExternalWatchRoots(roots, [f('/ws/opened')])), ['/ws/other', '/ws/opened-sibling']);
	});

	test('no opened folder: every root is watched', () => {
		assert.deepStrictEqual(paths(computeExternalWatchRoots([f('/x'), f('/y')], [])), ['/x', '/y']);
	});

	test('duplicates and nested roots collapse into one watcher', () => {
		const roots = [f('/data/a/child'), f('/data/a'), f('/data/a'), f('/data/b')];
		assert.deepStrictEqual(paths(computeExternalWatchRoots(roots, [f('/elsewhere')])), ['/data/a', '/data/b']);
	});

	test('excludes skip git, node_modules and attachments but never ticket metadata', () => {
		assert.ok(MANAGED_WORKSPACE_WATCH_EXCLUDES.includes('**/.git/**'));
		assert.ok(MANAGED_WORKSPACE_WATCH_EXCLUDES.includes('**/node_modules/**'));
		assert.ok(MANAGED_WORKSPACE_WATCH_EXCLUDES.includes('**/attachments/**'));
		assert.ok(!MANAGED_WORKSPACE_WATCH_EXCLUDES.some(g => g.includes('.agents')));
	});
});
