/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// TTS options per credential (CI-29): which models, voices and audio formats the selected credential's provider can
// really produce, and how a stored card / node selection is corrected when it does not fit (e.g. Alibaba Cloud with a
// Gemini model and the Kore voice). Used by the ticket card, the template designer and the workflow node editor.

import { ALIYUN_PROVIDER_ID } from './agentsManager.js';
import { QWEN_TTS_DEFAULT_MODEL, QWEN_TTS_MODELS, QWEN_TTS_VOICES, qwenTtsCredentialError } from './qwenTts.js';

export interface ITtsModelOption {
	readonly id: string;
	readonly badge: string;
}

export interface ITtsFormatOption {
	readonly value: string;
	readonly label: string;
}

/** The credential fields that decide the TTS options. */
export interface ITtsCredentialLike {
	readonly id: string;
	readonly providerId: string;
	readonly cachedModels?: readonly string[];
	readonly customUrl?: string;
	readonly isEnabled?: boolean;
}

const GEMINI_MODELS: readonly ITtsModelOption[] = [
	{ id: 'gemini-2.5-flash-preview-tts', badge: 'TTS Voice' },
	{ id: 'gemini-2.5-pro-preview-tts', badge: 'TTS HD' }
];
const OPENAI_MODELS: readonly ITtsModelOption[] = [
	{ id: 'tts-1', badge: 'TTS Standard' },
	{ id: 'tts-1-hd', badge: 'TTS HD' },
	{ id: 'gpt-4o-mini-tts', badge: 'GPT-4o TTS' }
];
const CUSTOM_OPENAI_MODELS: readonly ITtsModelOption[] = [
	{ id: 'tts-1', badge: 'TTS' },
	{ id: 'gpt-4o-mini-tts', badge: 'TTS' }
];

const GEMINI_VOICES: readonly string[] = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Zephyr', 'Leda', 'Orus'];
const OPENAI_VOICES: readonly string[] = ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'coral', 'sage', 'ash', 'ballad', 'verse'];
const CUSTOM_OPENAI_VOICES: readonly string[] = ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'Kore', 'Puck'];

const WAV_ONLY: readonly ITtsFormatOption[] = [{ value: 'wav', label: 'WAV (only format returned)' }];
const OPENAI_FORMATS: readonly ITtsFormatOption[] = [
	{ value: 'mp3', label: 'MP3 (Default)' },
	{ value: 'wav', label: 'WAV' },
	{ value: 'opus', label: 'OPUS' },
	{ value: 'aac', label: 'AAC' }
];

/** Which cached model ids of a provider are TTS models this app can call. */
const CACHED_TTS_MODEL: Record<string, RegExp> = {
	// qwen3-tts-flash and its dated snapshots; the -realtime models need a WebSocket API and are left out
	[ALIYUN_PROVIDER_ID]: /^qwen3-tts-flash(-\d{4}-\d{2}-\d{2})?$/i,
	gemini: /^gemini[\w.-]*-tts$/i,
	openai: /^(tts-1(-hd)?(-\d+)?|gpt-4o-mini-tts[\w.-]*)$/i,
	'custom-openai': /tts/i
};

function providerKey(providerId: string | undefined): string {
	return providerId === ALIYUN_PROVIDER_ID || providerId === 'openai' || providerId === 'custom-openai' ? providerId : 'gemini';
}

/**
 * The TTS models offered for a provider / credential: the documented ones plus the TTS models among the credential's
 * cached models. An Alibaba Cloud credential of a region without TTS (US (Virginia)) has none.
 */
export function ttsModelsFor(providerId: string | undefined, cred?: ITtsCredentialLike): ITtsModelOption[] {
	const key = providerKey(providerId);
	if (key === ALIYUN_PROVIDER_ID && qwenTtsCredentialError(cred) !== undefined) {
		return [];
	}
	const base = key === ALIYUN_PROVIDER_ID ? QWEN_TTS_MODELS : key === 'openai' ? OPENAI_MODELS : key === 'custom-openai' ? CUSTOM_OPENAI_MODELS : GEMINI_MODELS;
	const out: ITtsModelOption[] = [...base];
	const re = CACHED_TTS_MODEL[key];
	for (const raw of cred?.cachedModels || []) {
		const id = String(raw).replace(/^models\//, '').trim();
		if (id && re.test(id) && !out.some(m => m.id === id)) {
			out.push({ id, badge: 'TTS' });
		}
	}
	return out;
}

export function ttsVoicesFor(providerId: string | undefined): readonly string[] {
	const key = providerKey(providerId);
	return key === ALIYUN_PROVIDER_ID ? QWEN_TTS_VOICES : key === 'openai' ? OPENAI_VOICES : key === 'custom-openai' ? CUSTOM_OPENAI_VOICES : GEMINI_VOICES;
}

/** Formats the provider returns: Qwen and Gemini give WAV only (no conversion), OpenAI(-compatible) MP3/WAV/OPUS/AAC. */
export function ttsFormatsFor(providerId: string | undefined): readonly ITtsFormatOption[] {
	const key = providerKey(providerId);
	return key === 'openai' || key === 'custom-openai' ? OPENAI_FORMATS : WAV_ONLY;
}

/** A custom OpenAI endpoint may serve any model id; other providers take only their listed models. */
export function ttsAllowsCustomModelId(providerId: string | undefined): boolean {
	return providerId === 'custom-openai';
}

export interface ITtsSelection {
	readonly model?: string;
	readonly voice?: string;
	readonly format?: string;
}

export interface IReconciledTtsSelection {
	readonly model: string;
	readonly voice: string;
	readonly format: string;
	/** What had to be reset to the provider's first valid option. */
	readonly changed: ReadonlyArray<'model' | 'voice' | 'format'>;
	/** Set when the credential cannot do TTS at all (e.g. the Alibaba Cloud US (Virginia) region). */
	readonly unavailable?: string;
}

/** Keeps what fits the provider / credential and resets the rest to its first valid option. */
export function reconcileTtsSelection(providerId: string | undefined, cred: ITtsCredentialLike | undefined, sel: ITtsSelection): IReconciledTtsSelection {
	const changed: Array<'model' | 'voice' | 'format'> = [];
	const unavailable = providerKey(providerId) === ALIYUN_PROVIDER_ID ? qwenTtsCredentialError(cred) : undefined;

	const models = ttsModelsFor(providerId, cred);
	let model = (sel.model || '').trim();
	const modelOk = models.some(m => m.id === model) || (ttsAllowsCustomModelId(providerId) && !!model);
	if (!modelOk) {
		const next = models[0]?.id || (providerKey(providerId) === ALIYUN_PROVIDER_ID ? QWEN_TTS_DEFAULT_MODEL : model);
		if (next !== model) {
			model = next;
			changed.push('model');
		}
	}

	const voices = ttsVoicesFor(providerId);
	let voice = (sel.voice || '').trim();
	const matchedVoice = voices.find(v => v.toLowerCase() === voice.toLowerCase());
	if (matchedVoice) {
		voice = matchedVoice;
	} else {
		voice = voices[0];
		changed.push('voice');
	}

	const formats = ttsFormatsFor(providerId);
	let format = (sel.format || '').trim().toLowerCase();
	if (!formats.some(f => f.value === format)) {
		format = formats[0].value;
		changed.push('format');
	}

	return { model, voice, format, changed, unavailable };
}
