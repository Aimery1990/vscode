/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Alibaba Cloud Model Studio (DashScope) Qwen text-to-speech (CI-29).
// Native API (not the OpenAI-compatible one), on the same host as the credential's base URL:
//   POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
//   POST https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
//   (workspace hosts serve the native /api/v1 paths as well as /compatible-mode/v1)
//   { model, input: { text, voice, language_type } } -> output.audio.url (a WAV link, valid 24 h).
// TTS exists only in Singapore (International) and China (Beijing); the US (Virginia) region has none.
// Requests take at most 600 characters, so longer text is split at sentence boundaries and the WAV parts are joined.
// The HTTP layer is injected so the logic is testable without the network.

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { ALIYUN_PROVIDER_ID, getDefaultBaseUrl } from './agentsManager.js';

export const QWEN_TTS_PROVIDER_LABEL = 'Alibaba Cloud Model Studio (Qwen)';
export const QWEN_TTS_DEFAULT_MODEL = 'qwen3-tts-flash';
export const QWEN_TTS_DEFAULT_VOICE = 'Cherry';
export const QWEN_TTS_DEFAULT_LANGUAGE = 'Auto';
/** Characters per request accepted by qwen3-tts-flash. */
export const QWEN_TTS_MAX_CHARS = 600;

/** Models documented for the Singapore (International) region on the native multimodal-generation endpoint. */
export const QWEN_TTS_MODELS: ReadonlyArray<{ readonly id: string; readonly badge: string }> = [
	{ id: 'qwen3-tts-flash', badge: 'Qwen3 TTS' }
];

/** System voices of qwen3-tts-flash (the exact `voice` values). */
export const QWEN_TTS_VOICES: readonly string[] = [
	'Cherry', 'Serena', 'Ethan', 'Chelsie', 'Momo', 'Vivian', 'Moon', 'Maia', 'Kai', 'Nofish', 'Bella', 'Jennifer', 'Ryan',
	'Katerina', 'Aiden', 'Eldric Sage', 'Mia', 'Mochi', 'Bellona', 'Vincent', 'Bunny', 'Neil', 'Elias', 'Arthur', 'Nini',
	'Seren', 'Pip', 'Stella', 'Bodega', 'Sonrisa', 'Alek', 'Dolce', 'Sohee', 'Ono Anna', 'Lenn', 'Emilien', 'Andre',
	'Radio Gol', 'Jada', 'Dylan', 'Li', 'Marcus', 'Roy', 'Peter', 'Sunny', 'Eric', 'Rocky', 'Kiki'
];

/** Allowed `language_type` values (Auto = detected from the text). */
export const QWEN_TTS_LANGUAGES: readonly string[] = [
	'Auto', 'Chinese', 'English', 'German', 'Italian', 'Portuguese', 'Spanish', 'Japanese', 'Korean', 'French', 'Russian'
];

export const QWEN_TTS_US_REGION_ERROR = 'Alibaba Cloud Model Studio has no text-to-speech in the US (Virginia) region. Use a Singapore (International) credential.';

const TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const INTL_ORIGIN = 'https://dashscope-intl.aliyuncs.com';

export interface IQwenTtsHttpRequest {
	readonly method: 'GET' | 'POST';
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
}

export interface IQwenTtsHttpResponse {
	readonly status: number;
	text(): Promise<string>;
	bytes(): Promise<Uint8Array>;
}

export type QwenTtsHttp = (request: IQwenTtsHttpRequest) => Promise<IQwenTtsHttpResponse>;

/** True for a US (Virginia) Model Studio host: dashscope-us.aliyuncs.com or a us-east-1 workspace host. */
export function isUsRegionModelStudioHost(host: string): boolean {
	const h = host.toLowerCase();
	return /(^|\.)dashscope-us\./.test(h) || /(^|\.)us-east-1\.maas\.aliyuncs\.com$/.test(h);
}

/**
 * The TTS endpoint for a credential's region URL (its base URL, e.g. https://<host>/compatible-mode/v1):
 * the native path on the same scheme and host. No URL: Singapore. US hosts: an error, since that region has no TTS.
 */
export function resolveQwenTtsEndpoint(regionUrl?: string): { readonly url: string; readonly error?: undefined } | { readonly url?: undefined; readonly error: string } {
	const raw = (regionUrl || '').trim();
	if (!raw) {
		return { url: INTL_ORIGIN + TTS_PATH };
	}
	let origin: string;
	let host: string;
	try {
		const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
		origin = u.origin;
		host = u.hostname.toLowerCase();
	} catch {
		return { url: INTL_ORIGIN + TTS_PATH };
	}
	if (isUsRegionModelStudioHost(host)) {
		return { error: QWEN_TTS_US_REGION_ERROR };
	}
	return { url: origin + TTS_PATH };
}

export interface IQwenTtsCredentialLike {
	readonly id: string;
	readonly providerId: string;
	readonly customUrl?: string;
	readonly isEnabled?: boolean;
}

/** The base URL an Alibaba Cloud credential really uses (no customUrl: the provider default, US (Virginia)). */
export function aliyunCredentialBaseUrl(cred: IQwenTtsCredentialLike): string {
	return (cred.customUrl || '').trim() || getDefaultBaseUrl(ALIYUN_PROVIDER_ID);
}

/** Why an Alibaba Cloud credential cannot do TTS (its region), or undefined when it can / it is not Alibaba Cloud. */
export function qwenTtsCredentialError(cred: IQwenTtsCredentialLike | undefined): string | undefined {
	if (!cred || cred.providerId !== ALIYUN_PROVIDER_ID) {
		return undefined;
	}
	return resolveQwenTtsEndpoint(aliyunCredentialBaseUrl(cred)).error;
}

/** The first enabled Alibaba Cloud credential whose region has TTS (e.g. Singapore), else undefined. */
export function pickQwenTtsCredential<T extends IQwenTtsCredentialLike>(creds: readonly T[]): T | undefined {
	return creds.find(c => c.providerId === ALIYUN_PROVIDER_ID && c.isEnabled !== false && qwenTtsCredentialError(c) === undefined);
}

// \u3002 \uFF01 \uFF1F \uFF1B \u2026: full-width . ! ? ; and the ellipsis
const SENTENCE_END = new Set(['\u3002', '\uFF01', '\uFF1F', '!', '?', '\uFF1B', ';', '\u2026', '\n']);
// \uFF0C \u3001 \uFF1A: full-width comma, enumeration comma, colon
const SOFT_BREAK = new Set(['\uFF0C', ',', '\u3001', '\uFF1A', ':', ' ', '\t']);

/** Splits text into pieces of at most `max` characters, at sentence boundaries where possible (then commas / spaces). */
export function splitTextForQwenTts(text: string, max: number = QWEN_TTS_MAX_CHARS): string[] {
	const source = (text || '').trim();
	if (!source) {
		return [];
	}
	if (source.length <= max) {
		return [source];
	}
	// 1. sentences (the terminator stays with its sentence; "." ends a sentence only before whitespace or the end)
	const sentences: string[] = [];
	let cur = '';
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		cur += ch;
		const next = source[i + 1];
		const isEnd = SENTENCE_END.has(ch) || (ch === '.' && (next === undefined || /\s/.test(next)));
		if (isEnd && (next === undefined || !SENTENCE_END.has(next))) {
			sentences.push(cur);
			cur = '';
		}
	}
	if (cur) {
		sentences.push(cur);
	}
	// 2. a sentence longer than max: cut at the last soft break before max, else hard cut
	const pieces: string[] = [];
	for (const s of sentences) {
		let rest = s;
		while (rest.length > max) {
			let cut = -1;
			for (let j = max; j > max / 2; j--) {
				if (SOFT_BREAK.has(rest[j - 1])) {
					cut = j;
					break;
				}
			}
			if (cut < 0) {
				cut = max;
				// never split a surrogate pair
				const code = rest.charCodeAt(cut - 1);
				if (code >= 0xD800 && code <= 0xDBFF) {
					cut--;
				}
			}
			pieces.push(rest.slice(0, cut));
			rest = rest.slice(cut);
		}
		if (rest) {
			pieces.push(rest);
		}
	}
	// 3. pack pieces greedily into chunks
	const chunks: string[] = [];
	let chunk = '';
	for (const p of pieces) {
		if (chunk && chunk.length + p.length > max) {
			chunks.push(chunk);
			chunk = '';
		}
		chunk += p;
	}
	if (chunk) {
		chunks.push(chunk);
	}
	return chunks.map(c => c.trim()).filter(c => c.length > 0);
}

export interface IWavFormat {
	readonly audioFormat: number;
	readonly numChannels: number;
	readonly sampleRate: number;
	readonly bitsPerSample: number;
}

/** Builds a canonical 44-byte-header PCM WAV file. */
export function wrapPcmInWav(pcm: Uint8Array, sampleRate = 24000, numChannels = 1, bitsPerSample = 16, audioFormat = 1): Uint8Array {
	const blockAlign = numChannels * (bitsPerSample / 8);
	const out = new Uint8Array(44 + pcm.byteLength);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) {
			view.setUint8(offset + i, s.charCodeAt(i));
		}
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + pcm.byteLength, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, audioFormat, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	ascii(36, 'data');
	view.setUint32(40, pcm.byteLength, true);
	out.set(pcm, 44);
	return out;
}

/** Reads the format and the sample bytes of a RIFF/WAVE file (walks the chunks; tolerates an unset data size). */
export function parseWav(bytes: Uint8Array): { readonly format: IWavFormat; readonly data: Uint8Array } {
	const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
	if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
		throw new Error('The downloaded audio is not a WAV file.');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let format: IWavFormat | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === 'fmt ') {
			format = {
				audioFormat: view.getUint16(body, true),
				numChannels: view.getUint16(body + 2, true),
				sampleRate: view.getUint32(body + 4, true),
				bitsPerSample: view.getUint16(body + 14, true)
			};
		} else if (id === 'data') {
			if (!format) {
				throw new Error('WAV file has no format chunk before its data.');
			}
			const end = size === 0 || size === 0xFFFFFFFF || body + size > bytes.byteLength ? bytes.byteLength : body + size;
			return { format, data: bytes.subarray(body, end) };
		}
		offset = body + size + (size % 2);
	}
	throw new Error('WAV file has no data chunk.');
}

/** Joins WAV files of the same format into one (one header, the data parts in order). */
export function concatWavFiles(files: readonly Uint8Array[]): Uint8Array {
	if (files.length === 0) {
		throw new Error('No audio to join.');
	}
	if (files.length === 1) {
		return files[0];
	}
	const parsed = files.map(parseWav);
	const f0 = parsed[0].format;
	for (const p of parsed) {
		const f = p.format;
		if (f.audioFormat !== f0.audioFormat || f.numChannels !== f0.numChannels || f.sampleRate !== f0.sampleRate || f.bitsPerSample !== f0.bitsPerSample) {
			throw new Error('The audio parts have different formats and cannot be joined.');
		}
	}
	const total = parsed.reduce((n, p) => n + p.data.byteLength, 0);
	const pcm = new Uint8Array(total);
	let at = 0;
	for (const p of parsed) {
		pcm.set(p.data, at);
		at += p.data.byteLength;
	}
	return wrapPcmInWav(pcm, f0.sampleRate, f0.numChannels, f0.bitsPerSample, f0.audioFormat);
}

/** A readable message for a failed DashScope call (401 key, model not in the region, other). */
export function mapQwenTtsError(status: number, bodyText: string, model: string): string {
	let code = '';
	let message = '';
	try {
		const parsed = JSON.parse(bodyText);
		code = String(parsed?.code ?? parsed?.error?.code ?? '');
		message = String(parsed?.message ?? parsed?.error?.message ?? '');
	} catch {
		message = (bodyText || '').trim().slice(0, 300);
	}
	const all = `${code} ${message}`;
	if (status === 401 || /InvalidApiKey|invalid_api_key|Incorrect API key|Invalid API-key/i.test(all)) {
		return 'Alibaba Cloud Model Studio rejected the API key (HTTP 401). A key works only in the region it was created in: text-to-speech needs a Singapore (International) credential whose key and base URL both belong to that region.';
	}
	if (/Model not exist|ModelNotFound|model_not_found|does not exist|can not be found/i.test(all)) {
		return `Model '${model}' is not available in this Alibaba Cloud region (HTTP ${status}). Qwen text-to-speech is offered only in Singapore (International) and China (Beijing); use a Singapore (International) credential.`;
	}
	return `Alibaba Cloud text-to-speech failed (HTTP ${status})${code ? `: ${code}` : ''}${message ? ` - ${message}` : ''}`;
}

export interface IQwenTtsOptions {
	readonly text: string;
	readonly apiKey: string;
	/** The credential's region URL (customUrl). */
	readonly regionUrl?: string;
	readonly model?: string;
	readonly voice?: string;
	readonly language?: string;
	readonly http: QwenTtsHttp;
	/** Diagnostic log lines; never contain the key. */
	readonly log?: (line: string) => void;
	readonly maxChars?: number;
}

export type IQwenTtsResult =
	| { readonly success: true; readonly audio: Uint8Array; readonly mimeType: 'audio/wav'; readonly format: 'wav'; readonly segments: number }
	| { readonly success: false; readonly error: string };

/** Picks a known voice (case-insensitive), else the default. */
export function normalizeQwenVoice(voice?: string): string {
	const v = (voice || '').trim().toLowerCase();
	return QWEN_TTS_VOICES.find(x => x.toLowerCase() === v) || QWEN_TTS_DEFAULT_VOICE;
}

/** Picks a known language_type (case-insensitive), else Auto. */
export function normalizeQwenLanguage(language?: string): string {
	const l = (language || '').trim().toLowerCase();
	return QWEN_TTS_LANGUAGES.find(x => x.toLowerCase() === l) || QWEN_TTS_DEFAULT_LANGUAGE;
}

/** A Qwen TTS model id, or the default when the id belongs to another provider (e.g. tts-1 left from OpenAI). */
export function normalizeQwenModel(model?: string): string {
	const m = (model || '').trim();
	return /^qwen.*tts/i.test(m) ? m : QWEN_TTS_DEFAULT_MODEL;
}

/** Synthesizes text with Qwen TTS: one request per chunk, downloads each WAV, joins them. */
export async function synthesizeQwenSpeech(o: IQwenTtsOptions): Promise<IQwenTtsResult> {
	const endpoint = resolveQwenTtsEndpoint(o.regionUrl);
	if (endpoint.error !== undefined) {
		return { success: false, error: endpoint.error };
	}
	const chunks = splitTextForQwenTts(o.text, o.maxChars ?? QWEN_TTS_MAX_CHARS);
	if (chunks.length === 0) {
		return { success: false, error: 'Text input is empty. Please enter text to convert to speech.' };
	}
	const model = normalizeQwenModel(o.model);
	const voice = normalizeQwenVoice(o.voice);
	const language = normalizeQwenLanguage(o.language);
	const parts: Uint8Array[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const body = JSON.stringify({ model, input: { text: chunks[i], voice, language_type: language } });
		o.log?.(`[QwenTTS] POST ${endpoint.url} model=${model} voice=${voice} language=${language} part=${i + 1}/${chunks.length} chars=${chunks[i].length}`);
		const res = await o.http({
			method: 'POST',
			url: endpoint.url,
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${o.apiKey}` },
			body
		});
		const text = await res.text();
		if (res.status !== 200) {
			o.log?.(`[QwenTTS] HTTP ${res.status}`);
			return { success: false, error: mapQwenTtsError(res.status, text, model) };
		}
		let audioUrl = '';
		let audioData = '';
		try {
			const parsed = JSON.parse(text);
			if (parsed?.code) {
				return { success: false, error: mapQwenTtsError(res.status, text, model) };
			}
			audioUrl = String(parsed?.output?.audio?.url || '');
			audioData = String(parsed?.output?.audio?.data || '');
		} catch {
			return { success: false, error: 'Alibaba Cloud text-to-speech returned a response that is not JSON.' };
		}
		if (audioUrl) {
			// The link is a signed OSS URL: fetched right away and without the API key
			const dl = await o.http({ method: 'GET', url: audioUrl });
			if (dl.status !== 200) {
				return { success: false, error: `Downloading the generated audio failed (HTTP ${dl.status}).` };
			}
			const bytes = await dl.bytes();
			if (bytes.byteLength === 0) {
				return { success: false, error: 'The generated audio file is empty.' };
			}
			parts.push(bytes);
		} else if (audioData) {
			const raw = decodeBase64(audioData).buffer;
			parts.push(raw.byteLength >= 12 && String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) === 'RIFF' ? raw : wrapPcmInWav(raw, 24000, 1, 16));
		} else {
			return { success: false, error: 'Alibaba Cloud text-to-speech response has no audio (output.audio.url is missing).' };
		}
	}
	try {
		return { success: true, audio: concatWavFiles(parts), mimeType: 'audio/wav', format: 'wav', segments: parts.length };
	} catch (e) {
		return { success: false, error: (e as Error).message };
	}
}

/** Default TTS model / voice of a provider id (gemini, openai, custom-openai, aliyun). */
export function defaultTtsModelFor(providerId?: string): string {
	return providerId === ALIYUN_PROVIDER_ID ? QWEN_TTS_DEFAULT_MODEL : providerId === 'openai' ? 'tts-1' : 'gemini-2.5-flash-preview-tts';
}

export function defaultTtsVoiceFor(providerId?: string): string {
	return providerId === ALIYUN_PROVIDER_ID ? QWEN_TTS_DEFAULT_VOICE : providerId === 'openai' ? 'alloy' : 'Kore';
}
