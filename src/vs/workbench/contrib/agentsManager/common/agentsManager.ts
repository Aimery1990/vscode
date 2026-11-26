/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

export type AgentScopeType = 'workspace' | 'project' | 'job' | 'workflow' | 'none';

export interface IAgentModelReference {
	readonly providerId: string;
	readonly modelId: string;
	readonly credentialId?: string;
}

export interface IAgentItem {
	id: string;
	name: string;
	ticketId?: string;
	title?: string;
	role: string;
	description?: string;
	systemPrompt: string;
	model?: IAgentModelReference;
	avatarIcon: string;
	scopeType: AgentScopeType;
	scopeId: string;
	scopeName: string;
	folderPath?: string;
	status: 'idle' | 'busy' | 'offline';
	createdAt: number;
	updatedAt: number;
}

export interface IAgentCredential {
	readonly id: string;
	readonly name: string;
	readonly providerId: string; // 'gemini' | 'openai' | 'anthropic' | 'aliyun' | 'custom-openai'
	readonly customUrl?: string; // Endpoint URL (custom-openai, aliyun region endpoint)
	readonly isEnabled?: boolean;
	readonly lastVerifiedAt?: number;
	readonly connectionStatus?: 'connected' | 'error' | 'unverified';
	readonly connectionMessage?: string;
	readonly cachedModels?: string[];
	readonly createdAt: number;
}

/** Alibaba Cloud Model Studio (DashScope): OpenAI-compatible API hosting Qwen, DeepSeek, Kimi, GLM, ... */
export const ALIYUN_PROVIDER_ID = 'aliyun';

/** Model Studio endpoints. An API key only works in the region it was created in. */
export const ALIYUN_MODEL_STUDIO_REGIONS: ReadonlyArray<{ readonly label: string; readonly url: string }> = [
	{ label: 'US (Virginia)', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
	{ label: 'International (Singapore)', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
	{ label: 'China (Beijing)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
];

const DEFAULT_CUSTOM_OPENAI_BASE_URL = 'http://localhost:11434/v1';

/** Providers that speak the OpenAI chat-completions protocol against a configurable base URL. */
export function isOpenAICompatibleProvider(providerId: string | undefined): boolean {
	return providerId === 'custom-openai' || providerId === ALIYUN_PROVIDER_ID;
}

/** Base URL to use when a credential of `providerId` has no explicit endpoint. */
export function getDefaultBaseUrl(providerId: string | undefined): string {
	return providerId === ALIYUN_PROVIDER_ID ? ALIYUN_MODEL_STUDIO_REGIONS[0].url : DEFAULT_CUSTOM_OPENAI_BASE_URL;
}

/**
 * The user's global Default Model (Settings → AI LLM Providers). Kept in sync by the credential service so that
 * code without access to the service (UI fallbacks, runtimes) can resolve "the model to use when none is chosen".
 */
let globalDefaultModel: IAgentModelReference | undefined;

export function setGlobalDefaultModel(ref: IAgentModelReference | undefined): void {
	globalDefaultModel = ref;
}

/** The user's Default Model, or undefined if none is set (or its credential was removed / disabled). */
export function getGlobalDefaultModel(): IAgentModelReference | undefined {
	return globalDefaultModel;
}

/**
 * Model id to use when nothing was chosen. If `providerId` is given and differs from the Default Model's provider,
 * the Default Model cannot be used there, so `providerFallback` is returned.
 */
export function resolveDefaultModelId(providerId: string | undefined, providerFallback: string): string {
	const def = globalDefaultModel;
	if (def && (!providerId || providerId === def.providerId)) {
		return def.modelId;
	}
	return providerFallback;
}

/** Provider + model to use when neither was chosen: the Default Model, else `fallback`. */
export function resolveDefaultModel(fallback: { providerId: string; modelId: string }): { providerId: string; modelId: string } {
	return globalDefaultModel ? { providerId: globalDefaultModel.providerId, modelId: globalDefaultModel.modelId } : fallback;
}

/** Heuristic: model ids in provider catalogs that are not general chat / text models (speech, images, embeddings, ...). */
export function isNonChatModelId(modelId: string): boolean {
	return /(^|[-_.])(tts|asr|whisper|transcribe|embedding|embed|image|dall-e|moderation|realtime|audio|rerank|vision-only|paraformer|sambert|cosyvoice|wanx|wan[0-9]|lyria|veo|imagen|music|video|t2i|t2v|ocr)([-_.]|$)/i.test(modelId)
		|| /^(tts-|whisper|dall-e|text-embedding|omni-moderation|sora|gpt-image|computer-use|lyria|veo|imagen|aqa)/i.test(modelId);
}

export const IAgentCredentialService = createDecorator<IAgentCredentialService>('agentCredentialService');

export interface IAgentCredentialService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCredentials: Event<void>;
	/** Fires when the Default Model changes (set by the user, or invalidated because its credential went away). */
	readonly onDidChangeDefaultModel: Event<void>;

	getCredentials(): Promise<IAgentCredential[]>;
	/** The user's Default Model, used wherever a model can be chosen but was not. Undefined if none is set. */
	getDefaultModel(): IAgentModelReference | undefined;
	setDefaultModel(ref: IAgentModelReference | undefined): void;
	addCredential(name: string, providerId: string, apiKey: string, customUrl?: string): Promise<IAgentCredential>;
	updateCredential(credential: IAgentCredential): Promise<void>;
	removeCredential(id: string): Promise<void>;
	getCredential(id: string): Promise<IAgentCredential | undefined>;
	getApiKey(id: string): Promise<string | undefined>;
	testConnection(providerId: string, apiKey: string, modelId: string, customUrl?: string): Promise<{ success: boolean; message: string }>;
	fetchModels(providerId: string, apiKey: string, customUrl?: string): Promise<string[]>;
	refreshCredential(id: string): Promise<void>;
	executePrompt(modelId: string, prompt: string, systemPrompt?: string, targetProviderId?: string): Promise<{ success: boolean; text?: string; error?: string }>;
	synthesizeSpeech(options: {
		text: string;
		modelId?: string;
		credentialId?: string;
		providerId?: string;
		format?: string;
		voice?: string;
	}): Promise<{
		success: boolean;
		audioBuffer?: Uint8Array;
		mimeType?: string;
		format?: string;
		error?: string;
	}>;
}

export const IAgentsManagerService = createDecorator<IAgentsManagerService>('agentsManagerService');

export interface IAgentsManagerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAgents: Event<void>;
	readonly onDidExpandPane: Event<string>;

	notifyPaneExpanded(paneId: string): void;
	getAgents(): Promise<IAgentItem[]>;
	getAgentsByScope(scopeType: AgentScopeType, scopeId?: string): Promise<IAgentItem[]>;
	getAgent(id: string): Promise<IAgentItem | undefined>;
	addAgent(agent: Omit<IAgentItem, 'id' | 'createdAt' | 'updatedAt'>, targetParentUri?: URI): Promise<IAgentItem>;
	updateAgent(agent: IAgentItem): Promise<void>;
	removeAgent(id: string): Promise<void>;
	ensureAgentFolder(id: string): Promise<URI | undefined>;
	assignTaskToAgent(agentId: string, taskTitle: string, taskDescription?: string): Promise<void>;
}
