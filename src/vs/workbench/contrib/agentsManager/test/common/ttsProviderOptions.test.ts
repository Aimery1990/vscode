/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { QWEN_TTS_US_REGION_ERROR } from '../../common/qwenTts.js';
import { reconcileTtsSelection, ttsAllowsCustomModelId, ttsFormatsFor, ttsModelsFor, ttsVoicesFor } from '../../common/ttsProviderOptions.js';

const SG = { id: 'sg', providerId: 'aliyun', customUrl: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', cachedModels: ['qwen-plus', 'qwen3-max', 'qwen3-tts-flash', 'qwen3-tts-flash-realtime', 'qwen3-tts-flash-2025-11-27', 'deepseek-v3'] };
const US = { id: 'us', providerId: 'aliyun', customUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', cachedModels: ['qwen-plus', 'qwen3-tts-flash'] };
const GEM = { id: 'g', providerId: 'gemini', cachedModels: ['models/gemini-2.5-flash', 'models/gemini-2.5-flash-preview-tts', 'gemini-3-flash-tts', 'gemini-2.0-flash'] };
const OAI = { id: 'o', providerId: 'openai', cachedModels: ['gpt-4o', 'tts-1', 'tts-1-hd-1106', 'gpt-4o-mini-tts-2025-03-20', 'whisper-1'] };

suite('TTS options per credential (CI-29)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('models: only the TTS models of the credential provider', () => {
		assert.deepStrictEqual(ttsModelsFor('aliyun', SG).map(m => m.id), ['qwen3-tts-flash', 'qwen3-tts-flash-2025-11-27']);
		assert.deepStrictEqual(ttsModelsFor('aliyun', US), [], 'the US region has no TTS');
		assert.deepStrictEqual(ttsModelsFor('gemini', GEM).map(m => m.id), ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3-flash-tts']);
		assert.deepStrictEqual(ttsModelsFor('openai', OAI).map(m => m.id), ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'tts-1-hd-1106', 'gpt-4o-mini-tts-2025-03-20']);
		assert.ok(ttsModelsFor('gemini').every(m => /tts$/.test(m.id)));
		assert.ok(ttsAllowsCustomModelId('custom-openai') && !ttsAllowsCustomModelId('aliyun') && !ttsAllowsCustomModelId('gemini'));
	});

	test('voices and formats per provider', () => {
		assert.ok(ttsVoicesFor('aliyun').includes('Cherry') && !ttsVoicesFor('aliyun').includes('Kore'));
		assert.ok(ttsVoicesFor('gemini').includes('Kore') && !ttsVoicesFor('gemini').includes('Cherry'));
		assert.strictEqual(ttsVoicesFor('openai')[0], 'alloy');
		assert.deepStrictEqual(ttsFormatsFor('aliyun').map(f => f.value), ['wav']);
		assert.deepStrictEqual(ttsFormatsFor('gemini').map(f => f.value), ['wav']);
		assert.deepStrictEqual(ttsFormatsFor('openai').map(f => f.value), ['mp3', 'wav', 'opus', 'aac']);
	});

	test('reconcile: the stored Aliyun + Gemini model + Kore + MP3 card is corrected', () => {
		const r = reconcileTtsSelection('aliyun', SG, { model: 'gemini-2.5-flash-preview-tts', voice: 'Kore', format: 'mp3' });
		assert.deepStrictEqual({ model: r.model, voice: r.voice, format: r.format, changed: r.changed, unavailable: r.unavailable }, { model: 'qwen3-tts-flash', voice: 'Cherry', format: 'wav', changed: ['model', 'voice', 'format'], unavailable: undefined });
	});

	test('reconcile: a fitting selection is kept (voice case normalized)', () => {
		const r = reconcileTtsSelection('aliyun', SG, { model: 'qwen3-tts-flash-2025-11-27', voice: 'ethan', format: 'wav' });
		assert.deepStrictEqual([r.model, r.voice, r.format, r.changed.length], ['qwen3-tts-flash-2025-11-27', 'Ethan', 'wav', 0]);
		const o = reconcileTtsSelection('openai', OAI, { model: 'tts-1-hd', voice: 'nova', format: 'opus' });
		assert.deepStrictEqual(o.changed, []);
	});

	test('reconcile: switching to Gemini / OpenAI resets what does not fit', () => {
		const g = reconcileTtsSelection('gemini', GEM, { model: 'qwen3-tts-flash', voice: 'Cherry', format: 'wav' });
		assert.deepStrictEqual([g.model, g.voice, g.format, g.changed], ['gemini-2.5-flash-preview-tts', 'Kore', 'wav', ['model', 'voice']]);
		const o = reconcileTtsSelection('openai', OAI, { model: 'gemini-2.5-flash-preview-tts', voice: 'Kore', format: 'wav' });
		assert.deepStrictEqual([o.model, o.voice, o.format, o.changed], ['tts-1', 'alloy', 'wav', ['model', 'voice']]);
		const c = reconcileTtsSelection('custom-openai', undefined, { model: 'my-local-tts', voice: 'alloy', format: 'mp3' });
		assert.deepStrictEqual([c.model, c.changed], ['my-local-tts', []], 'a custom endpoint keeps a custom model id');
	});

	test('reconcile: the US Aliyun credential is flagged with the region message, never a Gemini model', () => {
		const r = reconcileTtsSelection('aliyun', US, { model: 'gemini-2.5-flash-preview-tts', voice: 'Kore', format: 'mp3' });
		assert.strictEqual(r.unavailable, QWEN_TTS_US_REGION_ERROR);
		assert.strictEqual(r.model, 'qwen3-tts-flash');
	});
});
