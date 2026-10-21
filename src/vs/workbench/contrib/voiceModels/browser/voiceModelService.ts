/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IRequestService, asJson, asText } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IAgentCredentialService } from '../../agentsManager/common/agentsManager.js';
import { IVoiceModel, IVoiceModelService, ITranscribeResult } from '../common/voiceModel.js';

const STORAGE_KEY_MODELS = 'workbench.voiceModels.models';
const STORAGE_KEY_ACTIVE_ID = 'workbench.voiceModels.activeId';

const DEFAULT_MODELS: IVoiceModel[] = [
	{
		id: 'gemini-1.5-flash-voice',
		name: 'Google Gemini 1.5 Flash (Audio STT)',
		provider: 'gemini',
		modelId: 'gemini-1.5-flash',
		isBuiltIn: true,
		isDefault: true,
		createdAt: 1718000000000,
		connectionStatus: 'unverified'
	},
	{
		id: 'gemini-2.0-flash-voice',
		name: 'Google Gemini 2.0 Flash (Audio STT)',
		provider: 'gemini',
		modelId: 'gemini-2.0-flash',
		isBuiltIn: true,
		isDefault: false,
		createdAt: 1718000000001,
		connectionStatus: 'unverified'
	},
	{
		id: 'openai-whisper-1-voice',
		name: 'OpenAI Whisper (whisper-1)',
		provider: 'openai',
		modelId: 'whisper-1',
		isBuiltIn: true,
		isDefault: false,
		createdAt: 1718000000002,
		connectionStatus: 'unverified'
	}
];

export class VoiceModelService extends Disposable implements IVoiceModelService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeVoiceModels = this._register(new Emitter<void>());
	readonly onDidChangeVoiceModels: Event<void> = this._onDidChangeVoiceModels.event;

	private readonly _onDidChangeActiveVoiceModel = this._register(new Emitter<IVoiceModel | undefined>());
	readonly onDidChangeActiveVoiceModel: Event<IVoiceModel | undefined> = this._onDidChangeActiveVoiceModel.event;

	private _models: IVoiceModel[] = [];
	private _activeModelId: string = '';
	private readonly requestService: IRequestService;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IAgentCredentialService private readonly agentCredentialService: IAgentCredentialService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService
	) {
		super();

		this.requestService = new RequestChannelClient(this.mainProcessService.getChannel('request'));

		this._loadModels();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === STORAGE_KEY_MODELS || e.key === STORAGE_KEY_ACTIVE_ID) {
				this._loadModels();
				this._onDidChangeVoiceModels.fire();
			}
		}));
	}

	private _loadModels(): void {
		const raw = this.storageService.get(STORAGE_KEY_MODELS, StorageScope.PROFILE);
		let savedModels: IVoiceModel[] = [];
		if (raw) {
			try {
				savedModels = JSON.parse(raw);
			} catch (e) {
				console.error('[VoiceModelService] Failed to parse stored voice models', e);
			}
		}

		if (savedModels.length === 0) {
			this._models = [...DEFAULT_MODELS];
			this._activeModelId = 'gemini-1.5-flash-voice';
			this._saveModels();
		} else {
			// Ensure built-in models exist
			for (const def of DEFAULT_MODELS) {
				if (!savedModels.some(m => m.id === def.id)) {
					savedModels.push({ ...def });
				}
			}
			this._models = savedModels;
			const savedActive = this.storageService.get(STORAGE_KEY_ACTIVE_ID, StorageScope.PROFILE);
			if (savedActive && this._models.some(m => m.id === savedActive)) {
				this._activeModelId = savedActive;
			} else {
				const defActive = this._models.find(m => m.isDefault) || this._models[0];
				this._activeModelId = defActive?.id || 'gemini-1.5-flash-voice';
			}
		}
	}

	private _saveModels(): void {
		this.storageService.store(
			STORAGE_KEY_MODELS,
			JSON.stringify(this._models),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this.storageService.store(
			STORAGE_KEY_ACTIVE_ID,
			this._activeModelId,
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}

	async getVoiceModels(): Promise<IVoiceModel[]> {
		return [...this._models];
	}

	async getActiveVoiceModel(): Promise<IVoiceModel | undefined> {
		let model = this._models.find(m => m.id === this._activeModelId);
		if (!model && this._models.length > 0) {
			model = this._models[0];
			this._activeModelId = model.id;
			this._saveModels();
		}
		return model;
	}

	async setActiveVoiceModel(id: string): Promise<void> {
		const model = this._models.find(m => m.id === id);
		if (!model) {
			throw new Error(`Voice model with id ${id} not found.`);
		}

		this._activeModelId = id;
		this._models = this._models.map(m => ({
			...m,
			isDefault: m.id === id
		}));

		this._saveModels();
		this._onDidChangeActiveVoiceModel.fire(model);
		this._onDidChangeVoiceModels.fire();
	}

	async addVoiceModel(modelData: Omit<IVoiceModel, 'id' | 'createdAt'>): Promise<IVoiceModel> {
		const newModel: IVoiceModel = {
			...modelData,
			id: generateUuid(),
			createdAt: Date.now(),
			connectionStatus: 'unverified'
		};

		if (newModel.isDefault) {
			this._models = this._models.map(m => ({ ...m, isDefault: false }));
			this._activeModelId = newModel.id;
		}

		this._models.push(newModel);
		this._saveModels();
		this._onDidChangeVoiceModels.fire();
		return newModel;
	}

	async updateVoiceModel(model: IVoiceModel): Promise<void> {
		const index = this._models.findIndex(m => m.id === model.id);
		if (index === -1) {
			throw new Error(`Voice model with id ${model.id} not found.`);
		}

		if (model.isDefault) {
			this._models = this._models.map(m => ({
				...m,
				isDefault: m.id === model.id
			}));
			this._activeModelId = model.id;
		}

		this._models[index] = { ...model };
		this._saveModels();
		this._onDidChangeVoiceModels.fire();
	}

	async removeVoiceModel(id: string): Promise<void> {
		const index = this._models.findIndex(m => m.id === id);
		if (index === -1) {
			return;
		}

		this._models.splice(index, 1);
		if (this._activeModelId === id) {
			const nextActive = this._models.find(m => m.isDefault) || this._models[0];
			this._activeModelId = nextActive ? nextActive.id : '';
		}

		this._saveModels();
		this._onDidChangeVoiceModels.fire();
	}

	private async resolveApiKey(model: IVoiceModel): Promise<string | undefined> {
		// 1. Direct API key on the voice model
		if (model.apiKey && model.apiKey.trim()) {
			return model.apiKey.trim();
		}

		// 2. Linked credential from AgentCredentialService
		if (model.credentialId) {
			const credKey = await this.agentCredentialService.getApiKey(model.credentialId);
			if (credKey && credKey.trim()) {
				return credKey.trim();
			}
		}

		// 3. Fallback: match by provider in AgentCredentialService
		const allCreds = await this.agentCredentialService.getCredentials();
		const matchingCred = allCreds.find(c => (c.providerId === model.provider || (model.provider === 'gemini' && c.providerId === 'google')) && c.isEnabled !== false);
		if (matchingCred) {
			const credKey = await this.agentCredentialService.getApiKey(matchingCred.id);
			if (credKey && credKey.trim()) {
				return credKey.trim();
			}
		}

		// 4. Special fallback for Gemini / Google provider
		if (model.provider === 'gemini') {
			const geminiCred = allCreds.find(c => c.providerId === 'gemini' || c.providerId === 'google');
			if (geminiCred) {
				const credKey = await this.agentCredentialService.getApiKey(geminiCred.id);
				if (credKey && credKey.trim()) {
					return credKey.trim();
				}
			}
		}

		// 5. Special fallback for OpenAI provider
		if (model.provider === 'openai') {
			const openaiCred = allCreds.find(c => c.providerId === 'openai');
			if (openaiCred) {
				const credKey = await this.agentCredentialService.getApiKey(openaiCred.id);
				if (credKey && credKey.trim()) {
					return credKey.trim();
				}
			}
		}

		// 6. Check environment variables
		if (typeof process !== 'undefined' && process.env) {
			if (model.provider === 'gemini') {
				const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
				if (envKey && envKey.trim()) {
					return envKey.trim();
				}
			} else if (model.provider === 'openai') {
				const envKey = process.env.OPENAI_API_KEY;
				if (envKey && envKey.trim()) {
					return envKey.trim();
				}
			}
		}

		return undefined;
	}

	async testVoiceModel(model: IVoiceModel): Promise<{ success: boolean; message: string }> {
		const apiKey = await this.resolveApiKey(model);
		if (!apiKey && model.provider !== 'custom') {
			const res = {
				success: false,
				message: `No API key configured for ${model.name}. Click "Configure" to enter an API key or link an existing credential from AI LLM Providers.`
			};
			await this._updateModelStatus(model.id, 'error', res.message);
			return res;
		}

		try {
			if (model.provider === 'gemini') {
				const cleanModel = model.modelId || 'gemini-1.5-flash';
				const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
				const body = JSON.stringify({
					contents: [{
						parts: [{ text: 'Respond with "Voice Model Ready" if you can hear this audio service test.' }]
					}]
				});

				const response = await this.requestService.request({
					type: 'POST',
					url: endpoint,
					headers: { 'Content-Type': 'application/json' },
					data: body,
					timeout: 10000,
					callSite: 'voiceModelService.testVoiceModel'
				}, CancellationToken.None);

				if (response.res.statusCode === 200) {
					const msg = `Successfully connected to Google Gemini (${cleanModel}). Voice transcription is ready.`;
					await this._updateModelStatus(model.id, 'connected', msg);
					return { success: true, message: msg };
				} else {
					const errorText = await asText(response) || '';
					let detail = errorText;
					try {
						const parsed = JSON.parse(errorText);
						detail = parsed.error?.message || detail;
					} catch {}
					const msg = `Google Gemini Error (${response.res.statusCode}): ${detail}`;
					await this._updateModelStatus(model.id, 'error', msg);
					return { success: false, message: msg };
				}
			} else if (model.provider === 'openai') {
				const endpoint = (model.customUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models';
				const response = await this.requestService.request({
					type: 'GET',
					url: endpoint,
					headers: {
						'Authorization': `Bearer ${apiKey}`
					},
					timeout: 10000,
					callSite: 'voiceModelService.testVoiceModel'
				}, CancellationToken.None);

				if (response.res.statusCode === 200) {
					const msg = `Successfully connected to OpenAI Whisper endpoint.`;
					await this._updateModelStatus(model.id, 'connected', msg);
					return { success: true, message: msg };
				} else {
					const errorText = await asText(response) || '';
					const msg = `OpenAI Error (${response.res.statusCode}): ${errorText.slice(0, 200)}`;
					await this._updateModelStatus(model.id, 'error', msg);
					return { success: false, message: msg };
				}
			} else {
				// Custom STT endpoint test
				const endpoint = model.customUrl || 'http://localhost:8000';
				const response = await this.requestService.request({
					type: 'GET',
					url: endpoint,
					headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
					timeout: 5000,
					callSite: 'voiceModelService.testVoiceModel'
				}, CancellationToken.None);

				if (response.res.statusCode && response.res.statusCode < 400) {
					const msg = `Custom STT service responded with HTTP ${response.res.statusCode}.`;
					await this._updateModelStatus(model.id, 'connected', msg);
					return { success: true, message: msg };
				} else {
					const msg = `Custom STT endpoint returned HTTP ${response.res.statusCode}.`;
					await this._updateModelStatus(model.id, 'error', msg);
					return { success: false, message: msg };
				}
			}
		} catch (err: any) {
			const msg = `Connection failed: ${err.message || String(err)}`;
			await this._updateModelStatus(model.id, 'error', msg);
			return { success: false, message: msg };
		}
	}

	private async _updateModelStatus(id: string, status: 'connected' | 'error', message: string): Promise<void> {
		const index = this._models.findIndex(m => m.id === id);
		if (index !== -1) {
			this._models[index] = {
				...this._models[index],
				connectionStatus: status,
				connectionMessage: message,
				lastVerifiedAt: Date.now()
			};
			this._saveModels();
			this._onDidChangeVoiceModels.fire();
		}
	}

	async transcribeAudio(audioBlob: Blob): Promise<ITranscribeResult> {
		const activeModel = await this.getActiveVoiceModel();
		if (!activeModel) {
			return { text: '', error: 'No voice model configured. Please configure a Voice Model in Settings.' };
		}

		const apiKey = await this.resolveApiKey(activeModel);
		if (!apiKey && activeModel.provider !== 'custom') {
			return {
				text: '',
				error: `Missing API Key for voice model "${activeModel.name}". Please link an API credential or configure a key in Settings -> Voice & Audio Models.`
			};
		}

		try {
			if (activeModel.provider === 'gemini') {
				return await this._transcribeWithGemini(audioBlob, activeModel, apiKey || '');
			} else if (activeModel.provider === 'openai') {
				return await this._transcribeWithWhisper(audioBlob, activeModel, apiKey || '');
			} else {
				return await this._transcribeWithCustom(audioBlob, activeModel, apiKey);
			}
		} catch (err: any) {
			console.error('[VoiceModelService] Transcription error:', err);
			return {
				text: '',
				error: err.message || String(err),
				modelUsed: activeModel.name
			};
		}
	}

	private async _transcribeWithGemini(audioBlob: Blob, model: IVoiceModel, apiKey: string): Promise<ITranscribeResult> {
		const arrayBuffer = await audioBlob.arrayBuffer();
		const base64Audio = this._arrayBufferToBase64(arrayBuffer);
		const mimeType = audioBlob.type || 'audio/webm';
		const cleanModel = model.modelId || 'gemini-1.5-flash';

		const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;

		const payload = {
			contents: [
				{
					role: 'user',
					parts: [
						{
							inline_data: {
								mime_type: mimeType,
								data: base64Audio
							}
						},
						{
							text: 'Transcribe this spoken audio verbatim in its original spoken language (e.g. Chinese, English, etc.). Output ONLY the transcribed plain text without any markdown bold/italic, punctuation explanations, timestamps, commentary, or quotes.'
						}
					]
				}
			],
			generationConfig: {
				temperature: 0.0,
				candidateCount: 1
			}
		};

		const response = await this.requestService.request({
			type: 'POST',
			url: endpoint,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify(payload),
			timeout: 30000,
			callSite: 'voiceModelService.transcribeWithGemini'
		}, CancellationToken.None);

		if (response.res.statusCode !== 200) {
			const errorText = await asText(response) || '';
			let errorMsg = `HTTP ${response.res.statusCode}`;
			try {
				const json = JSON.parse(errorText);
				errorMsg = json.error?.message || errorMsg;
			} catch {}
			return {
				text: '',
				error: `Gemini audio transcription failed: ${errorMsg}`,
				modelUsed: model.name
			};
		}

		const data = await asJson<any>(response);
		const candidate = data?.candidates?.[0];
		let transcribed = '';
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text) {
					transcribed += part.text;
				}
			}
		}

		return {
			text: transcribed.trim(),
			modelUsed: model.name
		};
	}

	private async _transcribeWithWhisper(audioBlob: Blob, model: IVoiceModel, apiKey: string): Promise<ITranscribeResult> {
		const endpoint = (model.customUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/audio/transcriptions';

		const formData = new FormData();
		formData.append('file', audioBlob, 'audio.webm');
		formData.append('model', model.modelId || 'whisper-1');
		if (model.language && model.language !== 'auto') {
			formData.append('language', model.language);
		}
		formData.append('response_format', 'json');
		formData.append('temperature', '0');

		const fetchRes = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`
			},
			body: formData
		});

		if (!fetchRes.ok) {
			const errText = await fetchRes.text();
			let msg = `HTTP ${fetchRes.status}`;
			try {
				const j = JSON.parse(errText);
				msg = j.error?.message || msg;
			} catch {}
			return {
				text: '',
				error: `Whisper transcription failed: ${msg}`,
				modelUsed: model.name
			};
		}

		const resultJson = await fetchRes.json();
		return {
			text: (resultJson.text || '').trim(),
			modelUsed: model.name
		};
	}

	private async _transcribeWithCustom(audioBlob: Blob, model: IVoiceModel, apiKey?: string): Promise<ITranscribeResult> {
		const endpoint = model.customUrl || 'http://localhost:8000/v1/audio/transcriptions';

		const formData = new FormData();
		formData.append('file', audioBlob, 'audio.webm');
		formData.append('model', model.modelId || 'whisper-1');

		const headers: Record<string, string> = {};
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		const fetchRes = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: formData
		});

		if (!fetchRes.ok) {
			const errText = await fetchRes.text();
			return {
				text: '',
				error: `Custom STT service error (${fetchRes.status}): ${errText.slice(0, 200)}`,
				modelUsed: model.name
			};
		}

		const resultJson = await fetchRes.json();
		return {
			text: (resultJson.text || resultJson.transcription || '').trim(),
			modelUsed: model.name
		};
	}

	private _arrayBufferToBase64(buffer: ArrayBuffer): string {
		let binary = '';
		const bytes = new Uint8Array(buffer);
		const len = bytes.byteLength;
		const chunkSize = 0x8000;
		for (let i = 0; i < len; i += chunkSize) {
			const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
			binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
		}
		return btoa(binary);
	}
}
