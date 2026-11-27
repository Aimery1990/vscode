/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	MASKED_SECRET,
	findPlaintextBrowserCredentials,
	isPlaceholderInUrlHost,
	maskBrowserCredentials,
	maskSecrets,
	normalizeBrowserCredentials,
	pickBrowserCredentials,
	resolveBrowserCredentialUrl
} from '../../common/browserCredentials.js';

/** Minimal stand-in for the runtime interpolation: replaces known `{name}`, leaves unknown ones unchanged. */
function contextInterpolator(context: Record<string, string>): (text: string) => string {
	return text => text.replace(/@?\{\{?([^{}]+)\}?\}/g, (match, key: string) => {
		const v = context[key.trim()];
		return v !== undefined ? v : match;
	});
}

suite('browserCredentials', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('substitutes multiple user-named credentials', () => {
		const res = resolveBrowserCredentialUrl('https://site/api?user={user}&key={my_api_key}&c={credential1}', [
			{ id: 'c1', key: 'user', value: 'alice' },
			{ id: 'c2', key: 'my_api_key', value: 'k123' },
			{ id: 'c3', key: 'credential1', value: 'third' }
		]);
		assert.strictEqual(res.url, 'https://site/api?user=alice&key=k123&c=third');
		assert.strictEqual(res.maskedUrl, 'https://site/api?user=***&key=***&c=***');
		assert.deepStrictEqual(res.usedNames, ['user', 'my_api_key', 'credential1']);
	});

	test('URL-encodes values in path, query and user info, not in the host', () => {
		const creds = [
			{ key: 'password', value: 'p@ss w&rd/?#' },
			{ key: 'host', value: 'example.com:8080' }
		];
		const res = resolveBrowserCredentialUrl('https://{password}@{host}/a/{password}?p={password}#{password}', creds);
		const enc = encodeURIComponent('p@ss w&rd/?#');
		assert.strictEqual(res.url, `https://${enc}@example.com:8080/a/${enc}?p=${enc}#${enc}`);
		assert.strictEqual(res.maskedUrl, 'https://***@***/a/***?p=***#***');
		assert.strictEqual(isPlaceholderInUrlHost('{base}/x?k={key}', 0), true);
		assert.strictEqual(isPlaceholderInUrlHost('{base}/x?k={key}', 10), false);
	});

	test('a credential wins over a context variable with the same name', () => {
		const interpolate = contextInterpolator({ user: 'ctx-user', page: '2' });
		const res = resolveBrowserCredentialUrl('https://site/?u={user}&page={page}', [{ key: 'user', value: 'cred-user' }], interpolate);
		assert.strictEqual(res.url, 'https://site/?u=cred-user&page=2');
		assert.strictEqual(res.maskedUrl, 'https://site/?u=***&page=2');
	});

	test('an unknown name stays as written', () => {
		const res = resolveBrowserCredentialUrl('https://site/?u={user}&x={missing}', [{ key: 'user', value: 'alice' }], contextInterpolator({}));
		assert.strictEqual(res.url, 'https://site/?u=alice&x={missing}');
		assert.strictEqual(res.maskedUrl, 'https://site/?u=***&x={missing}');
		assert.deepStrictEqual(res.usedNames, ['user']);
	});

	test('values may reference context variables', () => {
		const interpolate = contextInterpolator({ API_KEY: 's3cr3t value' });
		const res = resolveBrowserCredentialUrl('https://site/?key={key}', [{ key: 'key', value: '{API_KEY}' }], interpolate);
		assert.strictEqual(res.url, 'https://site/?key=s3cr3t%20value');
		assert.strictEqual(res.maskedUrl, 'https://site/?key=***');
		assert.ok(res.secrets.includes('s3cr3t value'));
		assert.ok(res.secrets.includes('s3cr3t%20value'));
	});

	test('{{name}} and case-insensitive names resolve; empty names are ignored; later rows win', () => {
		const res = resolveBrowserCredentialUrl('https://site/?a={{Token}}&b={TOKEN}', [
			{ key: '  ', value: 'ignored' },
			{ key: 'token', value: 'old' },
			{ key: 'token', value: 'new' }
		]);
		assert.strictEqual(res.url, 'https://site/?a=new&b=new');
		assert.deepStrictEqual(Array.from(normalizeBrowserCredentials([{ key: '', value: 'x' }, null, 'bad', { key: ' a ', value: 1 }]).entries()), [['a', '1']]);
	});

	test('no credentials: the template is only interpolated', () => {
		const res = resolveBrowserCredentialUrl('https://site/{page}', undefined, contextInterpolator({ page: 'home' }));
		assert.strictEqual(res.url, 'https://site/home');
		assert.strictEqual(res.maskedUrl, 'https://site/home');
		assert.deepStrictEqual(res.secrets, []);
	});

	test('maskSecrets hides raw and encoded values in logs and errors', () => {
		const res = resolveBrowserCredentialUrl('https://site/?k={k}', [{ key: 'k', value: 'a b' }]);
		const err = `fetch failed for ${res.url} (raw a b)`;
		assert.strictEqual(maskSecrets(err, res.secrets), `fetch failed for https://site/?k=${MASKED_SECRET} (raw ${MASKED_SECRET})`);
		assert.strictEqual(maskSecrets('nothing', []), 'nothing');
	});

	test('maskBrowserCredentials keeps names only', () => {
		assert.deepStrictEqual(maskBrowserCredentials([{ id: '1', key: 'user', value: 'alice' }, { key: '', value: 'x' }]), [{ key: 'user', value: MASKED_SECRET }]);
	});

	test('findPlaintextBrowserCredentials flags values without a variable reference', () => {
		assert.deepStrictEqual(findPlaintextBrowserCredentials([
			{ key: 'user', value: 'alice' },
			{ key: 'password', value: '{SITE_PASSWORD}' },
			{ key: 'empty', value: '' }
		]), ['user']);
	});

	test('pickBrowserCredentials: a ticket list with named rows wins, otherwise the template list', () => {
		const tpl = [{ key: 'user', value: 'tpl' }];
		const own = [{ key: 'user', value: 'own' }];
		assert.strictEqual(pickBrowserCredentials(own, tpl), own);
		assert.strictEqual(pickBrowserCredentials([], tpl), tpl);
		assert.strictEqual(pickBrowserCredentials([{ key: '', value: 'x' }], tpl), tpl);
		assert.strictEqual(pickBrowserCredentials('bad', tpl), tpl);
		assert.deepStrictEqual(pickBrowserCredentials(undefined, undefined), []);
	});
});
