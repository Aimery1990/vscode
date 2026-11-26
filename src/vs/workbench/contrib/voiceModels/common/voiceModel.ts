/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ISubtitleSegment } from './subtitles.js';

export type VoiceModelProvider = 'gemini' | 'openai' | 'aliyun' | 'custom';

export interface IVoiceModelOption {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly recommended?: boolean;
}

export interface IVoiceProviderOption {
	readonly id: VoiceModelProvider;
	readonly label: string;
	/** `IAgentCredential.providerId`s whose keys work for this provider. Empty = any credential. */
	readonly credentialProviderIds: readonly string[];
	/** Speech-to-text capable models, recommended first. Empty = the user types a model id. */
	readonly models: readonly IVoiceModelOption[];
}

/** Providers and speech-to-text models offered when registering a voice model. */
export const VOICE_PROVIDER_CATALOG: readonly IVoiceProviderOption[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		credentialProviderIds: ['openai'],
		models: [
			{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', description: 'Fast and low cost. Good for everyday dictation.', recommended: true },
			{ id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', description: 'Most accurate OpenAI speech-to-text, higher cost.' },
			{ id: 'whisper-1', label: 'Whisper', description: 'Classic Whisper model.' }
		]
	},
	{
		id: 'aliyun',
		label: 'Alibaba Cloud Model Studio (Qwen)',
		credentialProviderIds: ['aliyun'],
		models: [
			{ id: 'qwen3-asr-flash-us', label: 'Qwen3 ASR Flash (US region)', description: 'For API keys created in the US (Virginia) region. Strong Chinese + English, low cost.', recommended: true },
			{ id: 'qwen3-asr-flash', label: 'Qwen3 ASR Flash (Singapore / Beijing)', description: 'For API keys created in the International or China region.' }
		]
	},
	{
		id: 'gemini',
		label: 'Google Gemini',
		credentialProviderIds: ['gemini', 'google'],
		models: [
			{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast multimodal model that understands audio.', recommended: true },
			{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', description: 'Cheapest Gemini option.' },
			{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable Gemini, slower and more expensive.' }
		]
	},
	{
		id: 'custom',
		label: 'Custom endpoint (local Whisper / self-hosted)',
		credentialProviderIds: [],
		models: []
	}
];

export function getVoiceProviderOption(provider: string | undefined): IVoiceProviderOption | undefined {
	return VOICE_PROVIDER_CATALOG.find(p => p.id === provider);
}

export interface ISubtitleModelOption extends IVoiceModelOption {
	/** How timestamps are produced, shown to the user when picking a subtitle model. */
	readonly timing: string;
}

/**
 * Models offered for subtitle extraction (CI-45), per provider. Any other model id can be typed in.
 * Timing: "native" = the API returns segment times; "pauses" = local pause detection + text-only ASR
 * (accurate times, needs punctuation for sentence splits); "LLM" = the model writes times itself (approximate).
 */
export const SUBTITLE_MODEL_CATALOG: Readonly<Record<string, readonly ISubtitleModelOption[]>> = {
	openai: [
		{ id: 'whisper-1', label: 'Whisper', description: 'Segment timestamps from the API (verbose_json).', timing: 'native', recommended: true },
		{ id: 'gpt-4o-transcribe-diarize', label: 'GPT-4o Transcribe Diarize', description: 'Segment timestamps with speakers (diarized_json).', timing: 'native' },
		{ id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', description: 'Text only; timing from local pause detection.', timing: 'pauses' },
		{ id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', description: 'Text only; timing from local pause detection.', timing: 'pauses' }
	],
	aliyun: [
		{ id: 'qwen3-asr-flash-us', label: 'Qwen3 ASR Flash (US region)', description: 'Text only; timing from local pause detection. Works with US (Virginia) keys.', timing: 'pauses', recommended: true },
		{ id: 'qwen3-asr-flash', label: 'Qwen3 ASR Flash (Singapore / Beijing)', description: 'Text only; timing from local pause detection.', timing: 'pauses' },
		{ id: 'qwen3.8-omni-flash', label: 'Qwen3.8 Omni Flash', description: 'Audio LLM asked for JSON timestamps (approximate), snapped to pauses.', timing: 'LLM' }
	],
	gemini: [
		{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Audio LLM asked for JSON timestamps (approximate), snapped to pauses.', timing: 'LLM', recommended: true },
		{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', description: 'Cheapest Gemini, JSON timestamps.', timing: 'LLM' },
		{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable Gemini, JSON timestamps.', timing: 'LLM' }
	],
	custom: []
};

/** Options of a timed (subtitle) transcription request. Empty provider = the active voice model. */
export interface ITimedTranscribeOptions {
	readonly provider?: string;
	readonly modelId?: string;
	/** Language hint such as 'en', 'fr' or 'auto'. */
	readonly language?: string;
}

/** The voice model a timed transcription will use. */
export interface IResolvedTimedModel {
	readonly provider: VoiceModelProvider;
	readonly modelId: string;
	readonly name: string;
}

export interface ITimedTranscribeResult {
	/**
	 * Segments relative to the start of the sent clip. For text-only models (strategy 'utterances')
	 * this is one segment spanning the whole clip.
	 */
	readonly segments: ISubtitleSegment[];
	readonly text: string;
	readonly error?: string;
	readonly modelUsed?: string;
}

export interface IVoiceModel {
	readonly id: string;
	readonly name: string;
	readonly provider: VoiceModelProvider;
	readonly modelId: string;
	readonly apiKey?: string;
	readonly credentialId?: string; // Links to IAgentCredential in agentCredentialService
	readonly customUrl?: string; // Custom endpoint for whisper or local STT
	readonly language?: string; // Optional language code (e.g. 'auto', 'zh', 'en')
	readonly isBuiltIn?: boolean;
	readonly isDefault?: boolean;
	readonly createdAt: number;
	readonly lastVerifiedAt?: number;
	readonly connectionStatus?: 'connected' | 'error' | 'unverified';
	readonly connectionMessage?: string;
}

export interface ITranscribeResult {
	readonly text: string;
	readonly error?: string;
	readonly durationSeconds?: number;
	readonly modelUsed?: string;
}

export const IVoiceModelService = createDecorator<IVoiceModelService>('voiceModelService');

export interface IVoiceModelService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeVoiceModels: Event<void>;
	readonly onDidChangeActiveVoiceModel: Event<IVoiceModel | undefined>;

	getVoiceModels(): Promise<IVoiceModel[]>;
	getActiveVoiceModel(): Promise<IVoiceModel | undefined>;
	setActiveVoiceModel(id: string): Promise<void>;
	addVoiceModel(model: Omit<IVoiceModel, 'id' | 'createdAt'>): Promise<IVoiceModel>;
	updateVoiceModel(model: IVoiceModel): Promise<void>;
	removeVoiceModel(id: string): Promise<void>;
	testVoiceModel(model: IVoiceModel): Promise<{ success: boolean; message: string }>;
	transcribeAudio(audioBlob: Blob): Promise<ITranscribeResult>;
	/** Which model {@link transcribeTimed} would use for these options, or undefined when none is configured. */
	resolveTimedTranscriptionModel(options: ITimedTranscribeOptions): Promise<IResolvedTimedModel | undefined>;
	/** Transcribes one audio clip (16 kHz mono WAV) into timed segments, see {@link ITimedTranscribeResult}. */
	transcribeTimed(audio: Blob, clipSeconds: number, options: ITimedTranscribeOptions, token: CancellationToken): Promise<ITimedTranscribeResult>;
}
