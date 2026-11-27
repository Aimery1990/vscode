/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import {
	ANYAGENT_GLOBAL_DATA_PATH_KEY,
	ANYAGENT_GLOBAL_ENTITY_COMPONENT_PATH_KEY,
	expandHomePath,
	getAnyAgentGlobalFolders,
	getRetiredGlobalWorkspaceCode,
	isAcceptableGlobalPath,
	isFolderPermissionError,
	resolveAnyAgentGlobalPaths,
	toFolderAccessError,
	validateGlobalPathInput
} from '../../common/anyagentGlobalPaths.js';

suite('AnyAgent global paths (CI-26)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const home = '/home/tester';

	test('expandHomePath expands ~ with the given home only', () => {
		assert.strictEqual(expandHomePath('~', home), home);
		assert.strictEqual(expandHomePath('~/', home + '/'), home + '/');
		assert.strictEqual(expandHomePath('~/.anyagent', home), '/home/tester/.anyagent');
		assert.strictEqual(expandHomePath('~/.anyagent', home + '/'), '/home/tester/.anyagent');
		assert.strictEqual(expandHomePath('  /data/aa  ', home), '/data/aa');
		assert.strictEqual(expandHomePath('~other/x', home), '~other/x');
	});

	test('defaults: global folder is ~/.anyagent and everything else is a subfolder of it', () => {
		const paths = resolveAnyAgentGlobalPaths({}, home);
		assert.deepStrictEqual(paths, {
			root: '/home/tester/.anyagent',
			entityType: '/home/tester/.anyagent/entity_type',
			entityComponent: '/home/tester/.anyagent/entity_component',
			workflowHistory: '/home/tester/.anyagent/workflow_history',
			workflows: '/home/tester/.anyagent/workflows'
		});
	});

	test('a custom global folder moves the subfolders that are not overridden', () => {
		const paths = resolveAnyAgentGlobalPaths({ globalDataPath: '/data/aa/', entityTypePath: '~/templates' }, home);
		assert.strictEqual(paths.root, '/data/aa');
		assert.strictEqual(paths.entityType, '/home/tester/templates');
		assert.strictEqual(paths.entityComponent, '/data/aa/entity_component');
		assert.strictEqual(paths.workflowHistory, '/data/aa/workflow_history');
		assert.strictEqual(paths.workflows, '/data/aa/workflows');
	});

	test('empty or relative values fall back to the defaults', () => {
		const paths = resolveAnyAgentGlobalPaths({ globalDataPath: '  ', entityTypePath: 'relative/dir', entityComponentPath: '' }, home);
		assert.strictEqual(paths.root, '/home/tester/.anyagent');
		assert.strictEqual(paths.entityType, '/home/tester/.anyagent/entity_type');
		assert.strictEqual(paths.entityComponent, '/home/tester/.anyagent/entity_component');
	});

	test('path validation accepts absolute and ~ paths only', () => {
		assert.ok(isAcceptableGlobalPath('/x'));
		assert.ok(isAcceptableGlobalPath('~'));
		assert.ok(isAcceptableGlobalPath('~/x'));
		assert.ok(isAcceptableGlobalPath('C:\\Users\\x'));
		assert.ok(!isAcceptableGlobalPath('x/y'));
		assert.ok(!isAcceptableGlobalPath(''));
		assert.strictEqual(validateGlobalPathInput(''), undefined);
		assert.strictEqual(validateGlobalPathInput('~/.anyagent'), undefined);
		assert.ok(validateGlobalPathInput('anyagent')?.includes('not an absolute path'));
	});

	test('getAnyAgentGlobalFolders reads the profile settings', () => {
		const values = new Map<string, string>([
			[ANYAGENT_GLOBAL_DATA_PATH_KEY, '~/aa'],
			[ANYAGENT_GLOBAL_ENTITY_COMPONENT_PATH_KEY, '/c'],
		]);
		const scopes: StorageScope[] = [];
		const storage = {
			get: (key: string, scope: StorageScope, fallback?: string): string | undefined => {
				scopes.push(scope);
				return values.get(key) ?? fallback;
			}
		} as Parameters<typeof getAnyAgentGlobalFolders>[0];
		const folders = getAnyAgentGlobalFolders(storage, URI.file(home));
		assert.strictEqual(folders.root.fsPath, URI.file('/home/tester/aa').fsPath);
		assert.strictEqual(folders.entityType.fsPath, URI.file('/home/tester/aa/entity_type').fsPath);
		assert.strictEqual(folders.entityComponent.fsPath, URI.file('/c').fsPath);
		assert.strictEqual(folders.workflowHistory.fsPath, URI.file('/home/tester/aa/workflow_history').fsPath);
		assert.ok(scopes.every(s => s === StorageScope.PROFILE));
	});

	test('retired global workspace codes are recognised', () => {
		assert.strictEqual(getRetiredGlobalWorkspaceCode('GFLOW-0000'), 'GFLOW');
		assert.strictEqual(getRetiredGlobalWorkspaceCode('/gflow-0004'), 'GFLOW');
		assert.strictEqual(getRetiredGlobalWorkspaceCode('gagent'), 'GAGENT');
		assert.strictEqual(getRetiredGlobalWorkspaceCode('GLOBAL-0012'), 'GLOBAL');
		assert.strictEqual(getRetiredGlobalWorkspaceCode('GFLOW-0001/GFLOW-0002'), 'GFLOW');
		assert.strictEqual(getRetiredGlobalWorkspaceCode('FNDJ1-0001'), undefined);
		assert.strictEqual(getRetiredGlobalWorkspaceCode('GFLOWER-0001'), undefined);
		assert.strictEqual(getRetiredGlobalWorkspaceCode('globaljobs'), undefined);
		assert.strictEqual(getRetiredGlobalWorkspaceCode(undefined), undefined);
	});

	test('permission errors become a clear "not accessible" error', () => {
		const providerErr = FileSystemProviderError.create('EACCES: permission denied, mkdir', FileSystemProviderErrorCode.NoPermissions);
		assert.ok(isFolderPermissionError(providerErr));
		assert.ok(isFolderPermissionError(new Error('EPERM: operation not permitted, mkdir \'/x\'')));
		assert.ok(!isFolderPermissionError(new Error('ENOSPC: no space left')));
		assert.ok(!isFolderPermissionError('EPERM'));

		const converted = toFolderAccessError(providerErr, URI.file('/Users/someone/Documents/x'));
		assert.ok(converted instanceof Error && converted.message.includes('is not accessible') && converted.message.includes('macOS privacy permission'));
		const other = new Error('boom');
		assert.strictEqual(toFolderAccessError(other, URI.file('/x')), other);
	});
});
