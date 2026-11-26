/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

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
}
