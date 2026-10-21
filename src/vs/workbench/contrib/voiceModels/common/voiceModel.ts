/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

export type VoiceModelProvider = 'gemini' | 'openai' | 'custom';

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
