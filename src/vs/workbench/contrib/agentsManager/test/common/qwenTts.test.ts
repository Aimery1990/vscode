/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	aliyunCredentialBaseUrl, concatWavFiles, IQwenTtsHttpRequest, IQwenTtsHttpResponse, mapQwenTtsError, parseWav, pickQwenTtsCredential, QWEN_TTS_US_REGION_ERROR, QwenTtsHttp,
	qwenTtsCredentialError, resolveQwenTtsEndpoint, splitTextForQwenTts, synthesizeQwenSpeech, wrapPcmInWav
} from '../../common/qwenTts.js';

const KEY = 'sk-test-SECRET-0123456789';
const INTL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

function pcm(len: number, fill: number): Uint8Array {
	return new Uint8Array(len).fill(fill);
}

function response(status: number, body: string | Uint8Array): IQwenTtsHttpResponse {
	return {
		status,
		text: async () => typeof body === 'string' ? body : new TextDecoder().decode(body),
		bytes: async () => typeof body === 'string' ? new TextEncoder().encode(body) : body
	};
}

/** A mocked fetch: POSTs answer with an audio URL, GETs of that URL return a WAV with distinct sample bytes. */
function mockHttp(opts: { postStatus?: number; postBody?: string } = {}): { http: QwenTtsHttp; calls: IQwenTtsHttpRequest[] } {
	const calls: IQwenTtsHttpRequest[] = [];
	let n = 0;
	const http: QwenTtsHttp = async req => {
		calls.push(req);
		if (req.method === 'POST') {
			n++;
			if (opts.postStatus !== undefined) {
				return response(opts.postStatus, opts.postBody ?? '');
			}
			return response(200, JSON.stringify({ status_code: 200, request_id: 'r', code: '', message: '', output: { audio: { url: `https://dashscope-result-sgp.oss.example/audio_${n}.wav?Expires=1`, data: '', expires_at: 1 } }, usage: { characters: 5 } }));
		}
		const m = /audio_(\d+)\.wav/.exec(req.url);
		return response(200, wrapPcmInWav(pcm(4, Number(m?.[1] ?? 0)), 24000, 1, 16));
	};
	return { http, calls };
}

suite('Qwen TTS (CI-29)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('endpoint: Singapore by default and for intl, US region is a clear error, Beijing allowed', () => {
		assert.strictEqual(resolveQwenTtsEndpoint(undefined).url, INTL);
		assert.strictEqual(resolveQwenTtsEndpoint('').url, INTL);
		assert.strictEqual(resolveQwenTtsEndpoint('https://dashscope-intl.aliyuncs.com/compatible-mode/v1').url, INTL);
		assert.strictEqual(resolveQwenTtsEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1').url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
		const us = resolveQwenTtsEndpoint('https://dashscope-us.aliyuncs.com/compatible-mode/v1');
		assert.strictEqual(us.url, undefined);
		assert.strictEqual(us.error, 'Alibaba Cloud Model Studio has no text-to-speech in the US (Virginia) region. Use a Singapore (International) credential.');
	});

	test('endpoint: workspace hosts keep their own host (Singapore ws-...maas), us-east-1 workspace hosts are US', () => {
		const ws = 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
		assert.strictEqual(resolveQwenTtsEndpoint(ws).url, 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
		assert.strictEqual(resolveQwenTtsEndpoint('ws-abc123.ap-southeast-1.maas.aliyuncs.com').url, 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
		assert.strictEqual(resolveQwenTtsEndpoint('https://ws-abc123.us-east-1.maas.aliyuncs.com/compatible-mode/v1').error, QWEN_TTS_US_REGION_ERROR);
	});

	test('credentials: no customUrl means US (the provider default); the Singapore credential is picked automatically', () => {
		const us = { id: 'u', name: 'Aliyun', providerId: 'aliyun', customUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' };
		const usDefault = { id: 'd', name: 'Aliyun default', providerId: 'aliyun' };
		const sg = { id: 's', name: 'Aliyun Singapore', providerId: 'aliyun', customUrl: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' };
		const sgOff = { ...sg, id: 'x', isEnabled: false };
		const gem = { id: 'g', name: 'Gemini', providerId: 'gemini' };
		assert.strictEqual(aliyunCredentialBaseUrl(usDefault), 'https://dashscope-us.aliyuncs.com/compatible-mode/v1');
		assert.strictEqual(qwenTtsCredentialError(us), QWEN_TTS_US_REGION_ERROR);
		assert.strictEqual(qwenTtsCredentialError(usDefault), QWEN_TTS_US_REGION_ERROR);
		assert.strictEqual(qwenTtsCredentialError(sg), undefined);
		assert.strictEqual(qwenTtsCredentialError(gem), undefined);
		assert.strictEqual(qwenTtsCredentialError(undefined), undefined);
		assert.strictEqual(pickQwenTtsCredential([gem, us, usDefault, sgOff, sg])?.id, 's');
		assert.strictEqual(pickQwenTtsCredential([gem, us]), undefined);
	});

	test('request: endpoint, body, auth header; the key never appears in logs; download without the key', async () => {
		const { http, calls } = mockHttp();
		const logs: string[] = [];
		const r = await synthesizeQwenSpeech({ text: '你好，世界。', apiKey: KEY, regionUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-tts-flash', voice: 'cherry', language: 'chinese', http, log: l => logs.push(l) });
		assert.ok(r.success);
		assert.strictEqual(calls.length, 2);
		const post = calls[0];
		assert.strictEqual(post.method, 'POST');
		assert.strictEqual(post.url, INTL);
		assert.strictEqual(post.headers?.['Authorization'], `Bearer ${KEY}`);
		assert.strictEqual(post.headers?.['Content-Type'], 'application/json');
		assert.deepStrictEqual(JSON.parse(post.body!), { model: 'qwen3-tts-flash', input: { text: '你好，世界。', voice: 'Cherry', language_type: 'Chinese' } });
		assert.strictEqual(calls[1].method, 'GET');
		assert.ok(calls[1].url.startsWith('https://dashscope-result-sgp.oss.example/audio_1.wav'));
		assert.ok(!calls[1].headers || !Object.values(calls[1].headers).some(v => v.includes(KEY)), 'the OSS download must not carry the key');
		assert.ok(logs.length > 0);
		assert.ok(logs.every(l => !l.includes(KEY) && !l.includes('Bearer')), logs.join('\n'));
	});

	test('defaults: unknown voice / language / foreign model fall back to Cherry / Auto / qwen3-tts-flash', async () => {
		const { http, calls } = mockHttp();
		const r = await synthesizeQwenSpeech({ text: 'Hello.', apiKey: KEY, model: 'tts-1', voice: 'alloy', http });
		assert.ok(r.success);
		assert.strictEqual(calls[0].url, INTL, 'no region on the credential: Singapore');
		assert.deepStrictEqual(JSON.parse(calls[0].body!), { model: 'qwen3-tts-flash', input: { text: 'Hello.', voice: 'Cherry', language_type: 'Auto' } });
	});

	test('response: the downloaded WAV is returned as audio/wav', async () => {
		const { http } = mockHttp();
		const r = await synthesizeQwenSpeech({ text: 'Hello.', apiKey: KEY, http });
		assert.ok(r.success);
		if (r.success) {
			assert.strictEqual(r.mimeType, 'audio/wav');
			assert.strictEqual(r.format, 'wav');
			assert.strictEqual(r.segments, 1);
			const w = parseWav(r.audio);
			assert.deepStrictEqual(w.format, { audioFormat: 1, numChannels: 1, sampleRate: 24000, bitsPerSample: 16 });
			assert.deepStrictEqual(Array.from(w.data), [1, 1, 1, 1]);
		}
	});

	test('response: base64 output.audio.data (raw PCM) is wrapped as WAV; missing audio is an error', async () => {
		const b64 = btoa(String.fromCharCode(9, 9, 9, 9));
		const ok = await synthesizeQwenSpeech({ text: 'x', apiKey: KEY, http: async () => response(200, JSON.stringify({ code: '', output: { audio: { url: '', data: b64 } } })) });
		assert.ok(ok.success && Array.from(parseWav(ok.audio).data).join() === '9,9,9,9');
		const none = await synthesizeQwenSpeech({ text: 'x', apiKey: KEY, http: async () => response(200, JSON.stringify({ code: '', output: { audio: { url: '' } } })) });
		assert.ok(!none.success && /no audio/.test(none.error));
		const badDl = await synthesizeQwenSpeech({ text: 'x', apiKey: KEY, http: async req => req.method === 'POST' ? response(200, JSON.stringify({ output: { audio: { url: 'https://x/a.wav' } } })) : response(403, 'expired') });
		assert.ok(!badDl.success && /HTTP 403/.test(badDl.error));
	});

	test('splitting: at sentence ends, every chunk <= 600 characters, nothing lost', () => {
		assert.deepStrictEqual(splitTextForQwenTts('  Short text.  '), ['Short text.']);
		assert.deepStrictEqual(splitTextForQwenTts(''), []);
		const zh = '今天天气很好，我们去公园散步。'.repeat(60); // 900 chars, 15 per sentence
		const zhChunks = splitTextForQwenTts(zh);
		assert.strictEqual(zhChunks.length, 2);
		assert.ok(zhChunks.every(c => c.length <= 600 && c.endsWith('。')));
		assert.strictEqual(zhChunks.join(''), zh);
		const en = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the test.`).join(' ');
		const enChunks = splitTextForQwenTts(en);
		assert.ok(enChunks.length >= 2 && enChunks.every(c => c.length <= 600 && c.endsWith('.')));
		assert.strictEqual(enChunks.join(' '), en);
		// "3.14" is not a sentence end
		assert.ok(!splitTextForQwenTts(`Pi is 3.14 ok. ${'a'.repeat(590)}.`).some(c => c.endsWith('3.')));
		// one sentence longer than the limit: cut at commas / spaces, still <= 600
		const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(', ') + '.';
		const longChunks = splitTextForQwenTts(long);
		assert.ok(longChunks.length >= 2 && longChunks.every(c => c.length <= 600));
		assert.strictEqual(longChunks.join(' ').replace(/\s+/g, ' '), long);
		// no separators at all: hard cut
		assert.deepStrictEqual(splitTextForQwenTts('字'.repeat(1300)).map(c => c.length), [600, 600, 100]);
	});

	test('concatenation: one header, data parts in order, sizes updated; mismatched formats rejected', () => {
		const a = wrapPcmInWav(pcm(6, 1), 24000, 1, 16);
		const b = wrapPcmInWav(pcm(4, 2), 24000, 1, 16);
		const joined = concatWavFiles([a, b]);
		assert.strictEqual(joined.byteLength, 44 + 10);
		const view = new DataView(joined.buffer, joined.byteOffset, joined.byteLength);
		assert.strictEqual(String.fromCharCode(...joined.subarray(0, 4)), 'RIFF');
		assert.strictEqual(view.getUint32(4, true), 36 + 10);
		assert.strictEqual(String.fromCharCode(...joined.subarray(36, 40)), 'data');
		assert.strictEqual(view.getUint32(40, true), 10);
		assert.deepStrictEqual(Array.from(joined.subarray(44)), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
		assert.throws(() => concatWavFiles([a, wrapPcmInWav(pcm(2, 3), 16000, 1, 16)]), /different formats/);
		// a WAV with an extra chunk (LIST) before data and an unset data size still parses
		const extra = new Uint8Array([...a.subarray(0, 36), ...new TextEncoder().encode('LIST'), 2, 0, 0, 0, 0, 0, ...new TextEncoder().encode('data'), 0xFF, 0xFF, 0xFF, 0xFF, 7, 7]);
		assert.deepStrictEqual(Array.from(parseWav(extra).data), [7, 7]);
	});

	test('long text: several requests, the WAV parts joined in order', async () => {
		const { http, calls } = mockHttp();
		const text = '这是一个测试句子，用来检查长文本。'.repeat(80); // 1360 chars
		const r = await synthesizeQwenSpeech({ text, apiKey: KEY, http });
		assert.ok(r.success);
		const posts = calls.filter(c => c.method === 'POST');
		assert.strictEqual(posts.length, 3);
		assert.ok(posts.every(p => JSON.parse(p.body!).input.text.length <= 600));
		assert.strictEqual(posts.map(p => JSON.parse(p.body!).input.text).join(''), text);
		if (r.success) {
			assert.strictEqual(r.segments, 3);
			assert.deepStrictEqual(Array.from(parseWav(r.audio).data), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
		}
	});

	test('US region: clear error and no request at all', async () => {
		const { http, calls } = mockHttp();
		const r = await synthesizeQwenSpeech({ text: 'Hello.', apiKey: KEY, regionUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', http });
		assert.ok(!r.success);
		assert.strictEqual(!r.success && r.error, QWEN_TTS_US_REGION_ERROR);
		assert.strictEqual(calls.length, 0);
	});

	test('errors: 401 and "Model not exist" are mapped to readable messages (no raw 404, no key)', async () => {
		const e401 = await synthesizeQwenSpeech({ text: 'Hello.', apiKey: KEY, http: mockHttp({ postStatus: 401, postBody: JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.', request_id: 'x' }) }).http });
		assert.ok(!e401.success && /rejected the API key \(HTTP 401\)/.test(e401.error) && /Singapore \(International\) credential/.test(e401.error) && !e401.error.includes(KEY));
		const e404 = await synthesizeQwenSpeech({ text: 'Hello.', apiKey: KEY, http: mockHttp({ postStatus: 404, postBody: JSON.stringify({ code: 'ModelNotFound', message: 'Model not exist.' }) }).http });
		assert.ok(!e404.success && /Model 'qwen3-tts-flash' is not available in this Alibaba Cloud region/.test(e404.error) && /Singapore \(International\)/.test(e404.error));
		assert.match(mapQwenTtsError(400, '{"code":"","message":"Model not exist."}', 'qwen3-tts-flash'), /not available in this Alibaba Cloud region/);
		assert.match(mapQwenTtsError(500, '{"code":"InternalError","message":"boom"}', 'm'), /^Alibaba Cloud text-to-speech failed \(HTTP 500\): InternalError - boom$/);
		assert.match(mapQwenTtsError(502, 'Bad Gateway', 'm'), /HTTP 502.*Bad Gateway/);
	});
});
