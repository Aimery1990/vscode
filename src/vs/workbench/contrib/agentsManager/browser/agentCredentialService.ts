/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { streamToBuffer, decodeBase64 } from '../../../../base/common/buffer.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { ALIYUN_PROVIDER_ID, getDefaultBaseUrl, IAgentCredential, IAgentCredentialService, IAgentModelReference, setGlobalDefaultModel } from '../common/agentsManager.js';
import { IRequestService, asJson, asText } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';

export class AgentCredentialService extends Disposable implements IAgentCredentialService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCredentials = this._register(new Emitter<void>());
	readonly onDidChangeCredentials: Event<void> = this._onDidChangeCredentials.event;

	private readonly _onDidChangeDefaultModel = this._register(new Emitter<void>());
	readonly onDidChangeDefaultModel: Event<void> = this._onDidChangeDefaultModel.event;

	private _credentials: IAgentCredential[] = [];
	private _defaultModel: IAgentModelReference | undefined;
	private activeUserEmail: string = '';
	private readonly initializationPromise: Promise<void>;
	private readonly requestService: IRequestService;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService
	) {
		super();

		this.requestService = new RequestChannelClient(this.mainProcessService.getChannel('request'));

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, undefined, this._store)(e => {
			if (e.key === this.credentialsStorageKey) {
				this._loadCredentials();
				this._loadDefaultModel();
				this._onDidChangeCredentials.fire();
			} else if (e.key === this.defaultModelStorageKey) {
				this._loadDefaultModel();
			}
		}));

		this._register(this.authenticationService.onDidChangeSessions(async () => {
			await this.updateActiveUser();
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async () => {
			await this.updateActiveUser();
		}));

		this.initializationPromise = this.updateActiveUser();
	}

	private async updateActiveUser(): Promise<void> {
		try {
			const providers = ['google', 'github', 'microsoft', 'apple', ...this.authenticationService.declaredProviders.map(p => p.id)];
			const uniqueProviders = Array.from(new Set(providers));

			const sessionPromises = uniqueProviders.map(async providerId => {
				let timeoutId: any;
				try {
					const sessionsPromise = this.authenticationService.getSessions(providerId, undefined, undefined, true);
					const timeoutPromise = new Promise<readonly any[]>(resolve => {
						timeoutId = setTimeout(() => resolve([]), 5000);
					});
					const sessions = await Promise.race([sessionsPromise, timeoutPromise]);
					clearTimeout(timeoutId);
					if (sessions && sessions.length > 0) {
						return { providerId, session: sessions[0] };
					}
				} catch {
					clearTimeout(timeoutId);
				}
				return null;
			});

			const results = await Promise.all(sessionPromises);
			const activeResult = results.find(r => r !== null && r !== undefined);
			let newUserIdentifier = '';

			if (activeResult) {
				const label = activeResult.session.account.label || activeResult.session.account.email || '';
				const match = label.match(/\(([^)]+)\)/);
				newUserIdentifier = (match ? match[1] : label).trim().toLowerCase();
			}

			if (newUserIdentifier !== this.activeUserEmail) {
				this.activeUserEmail = newUserIdentifier;
				this._loadCredentials();
				this._loadDefaultModel();
				this._onDidChangeCredentials.fire();
			}
		} catch (err) {
			console.error('Failed to update active user in AgentCredentialService:', err);
		}
	}

	private get defaultModelStorageKey(): string {
		return `workbench.agentsManager.defaultModel:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private _loadDefaultModel(): void {
		let ref: IAgentModelReference | undefined;
		try {
			const parsed = JSON.parse(this.storageService.get(this.defaultModelStorageKey, StorageScope.PROFILE) || 'null');
			if (parsed && typeof parsed.providerId === 'string' && typeof parsed.modelId === 'string') {
				ref = { providerId: parsed.providerId, modelId: parsed.modelId, credentialId: typeof parsed.credentialId === 'string' ? parsed.credentialId : undefined };
			}
		} catch {
			ref = undefined;
		}
		this._applyDefaultModel(ref);
	}

	/** Publishes the stored Default Model, ignoring it while its credential is missing or disabled. */
	private _applyDefaultModel(stored: IAgentModelReference | undefined): void {
		const usable = stored && this._credentials.some(c => c.isEnabled !== false && (stored.credentialId ? c.id === stored.credentialId : c.providerId === stored.providerId))
			? stored : undefined;
		const changed = JSON.stringify(usable) !== JSON.stringify(this._defaultModel);
		this._defaultModel = usable;
		setGlobalDefaultModel(usable);
		if (changed) {
			this._onDidChangeDefaultModel.fire();
		}
	}

	getDefaultModel(): IAgentModelReference | undefined {
		return this._defaultModel;
	}

	setDefaultModel(ref: IAgentModelReference | undefined): void {
		if (ref) {
			this.storageService.store(this.defaultModelStorageKey, JSON.stringify(ref), StorageScope.PROFILE, StorageTarget.USER);
		} else {
			this.storageService.remove(this.defaultModelStorageKey, StorageScope.PROFILE);
		}
		this._applyDefaultModel(ref);
	}

	private get credentialsStorageKey(): string {
		return `workbench.agentsManager.credentials:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private _loadCredentials(): void {
		let raw = this.storageService.get(this.credentialsStorageKey, StorageScope.PROFILE);
		if (!raw && this.activeUserEmail) {
			const legacyKey = `workbench.agentsManager.credentials:google:Aimery Wei (${this.activeUserEmail})`;
			let legacyRaw = this.storageService.get(legacyKey, StorageScope.PROFILE);
			if (!legacyRaw) {
				const allKeys = this.storageService.keys(StorageScope.PROFILE, StorageTarget.USER);
				const matchedKey = allKeys.find(k => k.startsWith('workbench.agentsManager.credentials:') && k.includes(this.activeUserEmail));
				if (matchedKey) {
					legacyRaw = this.storageService.get(matchedKey, StorageScope.PROFILE);
				}
			}
			if (legacyRaw) {
				raw = legacyRaw;
				this.storageService.store(this.credentialsStorageKey, raw, StorageScope.PROFILE, StorageTarget.USER);
			}
		}
		if (raw) {
			try {
				this._credentials = JSON.parse(raw) as IAgentCredential[];
				return;
			} catch (e) {
				console.error('Failed to parse stored credentials', e);
			}
		}
		this._credentials = [];
	}

	private _saveCredentials(): void {
		this.storageService.store(
			this.credentialsStorageKey,
			JSON.stringify(this._credentials),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
		this._loadDefaultModel();
	}

	async getCredentials(): Promise<IAgentCredential[]> {
		await this.initializationPromise;
		return [...this._credentials];
	}

	async addCredential(name: string, providerId: string, apiKey: string, customUrl?: string): Promise<IAgentCredential> {
		await this.initializationPromise;
		const id = generateUuid();
		const credential: IAgentCredential = {
			id,
			name,
			providerId,
			customUrl,
			isEnabled: true,
			connectionStatus: 'unverified',
			createdAt: Date.now()
		};

		this._credentials.push(credential);
		this._saveCredentials();

		// Save the secret API Key securely in SecretStorage
		const secretKey = `credential:${this.activeUserEmail || 'unauthenticated'}:${id}`;
		await this.secretStorageService.set(secretKey, apiKey);

		// Immediately trigger background refresh to test connection & cache models
		this.refreshCredential(id).catch(err => {
			console.error(`Failed to auto-refresh new credential:`, err);
		});

		this._onDidChangeCredentials.fire();
		return credential;
	}

	async updateCredential(credential: IAgentCredential): Promise<void> {
		await this.initializationPromise;
		const index = this._credentials.findIndex(c => c.id === credential.id);
		if (index !== -1) {
			this._credentials[index] = credential;
			this._saveCredentials();
			this._onDidChangeCredentials.fire();
		}
	}

	async removeCredential(id: string): Promise<void> {
		await this.initializationPromise;
		const index = this._credentials.findIndex(c => c.id === id);
		if (index !== -1) {
			this._credentials.splice(index, 1);
			this._saveCredentials();

			// Delete the secret securely
			const secretKey = `credential:${this.activeUserEmail || 'unauthenticated'}:${id}`;
			await this.secretStorageService.delete(secretKey);

			this._onDidChangeCredentials.fire();
		}
	}

	async getCredential(id: string): Promise<IAgentCredential | undefined> {
		await this.initializationPromise;
		return this._credentials.find(c => c.id === id);
	}

	async getApiKey(id: string): Promise<string | undefined> {
		await this.initializationPromise;
		const secretKey = `credential:${this.activeUserEmail || 'unauthenticated'}:${id}`;
		let key = await this.secretStorageService.get(secretKey);
		if (!key && this.activeUserEmail) {
			const legacySecretKey = `credential:google:Aimery Wei (${this.activeUserEmail}):${id}`;
			key = await this.secretStorageService.get(legacySecretKey);
			if (key) {
				await this.secretStorageService.set(secretKey, key);
			}
		}
		return key;
	}

	async fetchModels(providerId: string, apiKey: string, customUrl?: string): Promise<string[]> {
		if (!apiKey) {
			return [];
		}

		let actualProvider = providerId;
		let customUrlVal = customUrl || '';
		if (providerId.startsWith('custom-openai:')) {
			actualProvider = 'custom-openai';
			customUrlVal = providerId.substring('custom-openai:'.length).trim();
		}
		if (actualProvider === ALIYUN_PROVIDER_ID) {
			// Alibaba Cloud Model Studio is OpenAI-compatible; only the default (region) endpoint differs
			actualProvider = 'custom-openai';
			customUrlVal = customUrlVal || getDefaultBaseUrl(ALIYUN_PROVIDER_ID);
		}

		try {
			if (actualProvider === 'gemini') {
				const response = await this.requestService.request({
					type: 'GET',
					url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
					timeout: 12000,
					callSite: 'agentCredentialService.fetchModels'
				}, CancellationToken.None);

				if (response.res.statusCode !== 200) {
					throw new Error(`HTTP Error ${response.res.statusCode}`);
				}

				const data = await asJson<any>(response);
				if (data && Array.isArray(data.models)) {
					return data.models
						.filter((m: any) => m.name && m.name.startsWith('models/'))
						.map((m: any) => m.name.replace(/^models\//, ''));
				}
			} else if (actualProvider === 'openai') {
				const response = await this.requestService.request({
					type: 'GET',
					url: 'https://api.openai.com/v1/models',
					headers: { 'Authorization': `Bearer ${apiKey}` },
					timeout: 12000,
					callSite: 'agentCredentialService.fetchModels'
				}, CancellationToken.None);

				if (response.res.statusCode !== 200) {
					throw new Error(`HTTP Error ${response.res.statusCode}`);
				}

				const data = await asJson<any>(response);
				if (data && Array.isArray(data.data)) {
					return data.data.map((m: any) => m.id);
				}
			} else if (actualProvider === 'custom-openai') {
				const baseEndpoint = customUrlVal || 'http://localhost:11434/v1';
				const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '');
				const response = await this.requestService.request({
					type: 'GET',
					url: `${cleanBase}/models`,
					headers: { 'Authorization': `Bearer ${apiKey}` },
					timeout: 12000,
					callSite: 'agentCredentialService.fetchModels'
				}, CancellationToken.None);

				if (response.res.statusCode !== 200) {
					throw new Error(`HTTP Error ${response.res.statusCode}`);
				}

				const data = await asJson<any>(response);
				if (data && Array.isArray(data.data)) {
					return data.data.map((m: any) => m.id);
				} else if (data && Array.isArray(data.models)) {
					return data.models.map((m: any) => m.name || m.model || m.id);
				}
			} else if (actualProvider === 'anthropic') {
				const response = await this.requestService.request({
					type: 'GET',
					url: 'https://api.anthropic.com/v1/models',
					headers: {
						'x-api-key': apiKey,
						'anthropic-version': '2023-06-01'
					},
					timeout: 12000,
					callSite: 'agentCredentialService.fetchModels'
				}, CancellationToken.None);

				if (response.res.statusCode !== 200) {
					throw new Error(`HTTP Error ${response.res.statusCode}`);
				}

				const data = await asJson<any>(response);
				if (data && Array.isArray(data.data)) {
					return data.data.map((m: any) => m.id);
				}
			}
		} catch (e: any) {
			console.error(`Failed to fetch models for provider ${providerId}:`, e);
			throw e;
		}
		return [];
	}

	async refreshCredential(id: string): Promise<void> {
		await this.initializationPromise;
		const cred = this._credentials.find(c => c.id === id);
		if (!cred) {
			return;
		}

		const apiKey = await this.getApiKey(id);
		if (!apiKey) {
			const index = this._credentials.findIndex(c => c.id === id);
			if (index !== -1) {
				this._credentials[index] = {
					...cred,
					connectionStatus: 'error',
					connectionMessage: 'Missing API Key in system keychain.',
					lastVerifiedAt: Date.now()
				};
				this._saveCredentials();
				this._onDidChangeCredentials.fire();
			}
			return;
		}

		let testModel = '';
		if (cred.providerId === 'gemini') {
			testModel = 'gemini-1.5-flash';
		} else if (cred.providerId === 'openai') {
			testModel = 'gpt-4o-mini';
		} else if (cred.providerId === 'anthropic') {
			testModel = 'claude-3-5-haiku-20241022';
		} else if (cred.providerId === ALIYUN_PROVIDER_ID) {
			testModel = 'qwen-flash';
		} else {
			testModel = 'default-model';
		}

		let models: string[] = [];
		let fetchSuccess = false;
		let fetchErrorMsg = '';
		try {
			models = await this.fetchModels(cred.providerId, apiKey, cred.customUrl);
			fetchSuccess = models.length > 0;
		} catch (err: any) {
			fetchErrorMsg = err.message || String(err);
		}

		let connectionStatus: 'connected' | 'error' = 'error';
		let connectionMessage = '';

		if (fetchSuccess) {
			connectionStatus = 'connected';
			connectionMessage = 'Connected successfully (retrieved model list).';
		} else {
			// Fallback to testConnection
			const testRes = await this.testConnection(cred.providerId, apiKey, testModel, cred.customUrl);
			if (testRes.success) {
				connectionStatus = 'connected';
				connectionMessage = testRes.message;
			} else {
				connectionStatus = 'error';
				connectionMessage = `Model list fetch failed (${fetchErrorMsg || 'No models returned'}). Connection test failed: ${testRes.message}`;
			}
		}

		const updatedCred: IAgentCredential = {
			...cred,
			lastVerifiedAt: Date.now(),
			connectionStatus,
			connectionMessage,
			cachedModels: models.length > 0 ? models : (cred.cachedModels || [])
		};

		const index = this._credentials.findIndex(c => c.id === id);
		if (index !== -1) {
			this._credentials[index] = updatedCred;
			this._saveCredentials();
			this._onDidChangeCredentials.fire();
		}
	}

	async testConnection(providerId: string, apiKey: string, modelId: string, customUrl?: string): Promise<{ success: boolean; message: string }> {
		if (!apiKey) {
			return { success: false, message: 'API key is empty.' };
		}

		let actualProvider = providerId;
		let customUrlVal = customUrl || '';
		if (providerId.startsWith('custom-openai:')) {
			actualProvider = 'custom-openai';
			customUrlVal = providerId.substring('custom-openai:'.length).trim();
		}
		if (actualProvider === ALIYUN_PROVIDER_ID) {
			// Alibaba Cloud Model Studio is OpenAI-compatible; only the default (region) endpoint differs
			actualProvider = 'custom-openai';
			customUrlVal = customUrlVal || getDefaultBaseUrl(ALIYUN_PROVIDER_ID);
		}

		const sanitizedModel = (modelId || '').replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-').trim();

		if (actualProvider === 'gemini') {
			const cleanModel = sanitizedModel || 'gemini-1.5-flash';
			const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
			const body = JSON.stringify({
				contents: [{
					parts: [{ text: 'Hello! Respond with "Gemini Connection Test Successful" if you receive this.' }]
				}]
			});
			const headers = { 'Content-Type': 'application/json' };
			return this._executeRequest(endpoint, headers, body);
		} else if (actualProvider === 'anthropic') {
			const cleanModel = sanitizedModel || 'claude-3-5-sonnet-20241022';
			const endpoint = 'https://api.anthropic.com/v1/messages';
			const headers = {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'dangerously-allow-html-and-other-things': 'true'
			};
			const body = JSON.stringify({
				model: cleanModel,
				max_tokens: 30,
				messages: [{ role: 'user', content: 'Hello! Respond with "Anthropic Connection Test Successful" if you receive this.' }]
			});
			return this._executeRequest(endpoint, headers, body);
		} else if (actualProvider === 'openai' || actualProvider === 'custom-openai') {
			const cleanModel = sanitizedModel || 'gpt-4o-mini';
			const baseEndpoint = actualProvider === 'openai' ? 'https://api.openai.com/v1' : (customUrlVal || 'http://localhost:11434/v1');
			const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/completions\/?$/, '').replace(/\/responses\/?$/, '').replace(/\/$/, '');

			const headers = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			};

			// Attempt 1: Chat completions
			const lowerModel = cleanModel.toLowerCase();
			const isReasoningOrNewerModel = /gpt-[5-9]/.test(lowerModel) || /^o[1-9]/.test(lowerModel) || lowerModel.startsWith('codex') || lowerModel.includes('-sol') || lowerModel.includes('-luna');
			let attemptUrl = `${cleanBase}/chat/completions`;
			let attemptData: any = {
				model: cleanModel,
				messages: [{ role: 'user', content: 'Hello! Respond with "Connection Test Successful" if you receive this.' }],
				...(isReasoningOrNewerModel ? { max_completion_tokens: 512 } : { max_tokens: 30 })
			};

			let res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
			if (res.success) {
				return res;
			}

			// Analyse the error to do smart fallback
			let errText = res.message || '';
			if (errText.includes('max_tokens') || errText.includes('max_completion_tokens')) {
				// Fallback 1a: Swap between max_tokens and max_completion_tokens
				if (attemptData.max_tokens !== undefined) {
					delete attemptData.max_tokens;
					attemptData.max_completion_tokens = 512;
				} else {
					delete attemptData.max_completion_tokens;
					attemptData.max_tokens = 64;
				}
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
				if (res.success) return res;
				errText = res.message || '';
			}
			if (errText.includes('REASONING_TOKEN_LIMIT_EXCEEDED')) {
				delete attemptData.max_completion_tokens;
				delete attemptData.max_tokens;
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
				if (res.success) return res;
				errText = res.message || '';
			}
			if (errText.includes('reasoning_effort')) {
				attemptData.reasoning_effort = 'none';
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
				if (res.success) return res;
				errText = res.message || '';
			}
			if (errText.includes('v1/responses') || errText.includes('responses endpoint') || isReasoningOrNewerModel) {
				// Fallback 2: Model requires v1/responses endpoint
				attemptUrl = `${cleanBase}/responses`;
				const responseData = {
					model: cleanModel,
					input: 'Hello! Respond with "Connection Test Successful" if you receive this.'
				};
				const respRes = await this._executeRequest(attemptUrl, headers, JSON.stringify(responseData));
				if (respRes.success) return respRes;
				if (errText.includes('v1/responses') || errText.includes('responses endpoint')) {
					res = respRes;
				}
			}
			if (!res.success && (errText.includes('v1/completions') || errText.includes('not a chat model') || errText.includes('v1/chat/completions endpoint'))) {
				// Fallback 3: Model requires completions endpoint
				attemptUrl = `${cleanBase}/completions`;
				const completionData = {
					model: cleanModel,
					prompt: 'Hello! Respond with "Connection Test Successful" if you receive this.',
					max_tokens: 30
				};
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(completionData));
				if (res.success) return res;
			}

			return res;
		}

		return { success: false, message: `Unsupported provider: ${providerId}` };
	}

	private async _executeRequest(url: string, headers: Record<string, string>, body: string, timeoutMs: number = 300000): Promise<{ success: boolean; message: string }> {
		try {
			const response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: body,
				timeout: timeoutMs,
				callSite: 'agentCredentialService.executePrompt'
			}, CancellationToken.None);

			if (response.res.statusCode !== 200) {
				const errorText = await asText(response) || '';
				let parsedError = errorText;
				try {
					const json = JSON.parse(errorText);
					parsedError = json.error?.message || json.message || errorText;
				} catch {
					// ignore
				}

				// Gemini-specific listModels diagnostics fallback
				if (url.includes('generativelanguage.googleapis.com') && (response.res.statusCode === 404 || response.res.statusCode === 400)) {
					const apiKeyMatch = url.match(/key=([^&]+)/);
					const apiKey = apiKeyMatch ? apiKeyMatch[1] : '';
					if (apiKey) {
						try {
							const listRes = await this.requestService.request({
								type: 'GET',
								url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
								timeout: 12000,
								callSite: 'agentCredentialService.testConnection'
							}, CancellationToken.None);
							if (listRes.res.statusCode === 200) {
								const listData = await asJson<any>(listRes);
								if (listData && Array.isArray(listData.models)) {
									const names = listData.models
										.filter((m: any) => m.name && m.name.startsWith('models/'))
										.map((m: any) => m.name.replace(/^models\//, ''));
									return {
										success: false,
										message: `HTTP Error ${response.res.statusCode}: ${parsedError || ''}\n\nAvailable models for this key: ${names.join(', ')}`
									};
								}
							}
						} catch (listErr) {
							console.error('Failed to list models in connection test fallback:', listErr);
						}
					}
				}

				return {
					success: false,
					message: `HTTP Error ${response.res.statusCode}: ${parsedError || ''}`
				};
			}

			const data = await asJson<any>(response);
			let responseMessage = '';

			if (url.includes('/chat/completions')) {
				const firstChoice = data.choices?.[0];
				const msgContent = firstChoice?.message?.content;
				if (typeof msgContent === 'string' && msgContent.trim().length > 0) {
					responseMessage = msgContent;
				} else if (Array.isArray(msgContent)) {
					const parts = msgContent
						.map((p: any) => (typeof p === 'string' ? p : (p?.text || p?.content || '')))
						.filter((s: string) => Boolean(s));
					responseMessage = parts.join('\n');
				}

				if (!responseMessage.trim()) {
					if (firstChoice?.message?.refusal) {
						return {
							success: false,
							message: `Model Refusal: ${firstChoice.message.refusal}`
						};
					}
					const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;
					if (firstChoice?.finish_reason === 'length' || reasoningTokens > 0) {
						return {
							success: false,
							message: `REASONING_TOKEN_LIMIT_EXCEEDED: Model '${data.model || 'reasoning-model'}' exhausted all ${data.usage?.completion_tokens || reasoningTokens} completion tokens on internal thinking (reasoning_tokens: ${reasoningTokens}) before generating visible text output.`
						};
					}
					responseMessage = JSON.stringify(data);
				}
			} else if (url.includes('/completions')) {
				responseMessage = data.choices?.[0]?.text || JSON.stringify(data);
			} else if (url.includes('/responses')) {
				if (typeof data.output_text === 'string' && data.output_text.trim()) {
					responseMessage = data.output_text;
				} else if (Array.isArray(data.output)) {
					const texts: string[] = [];
					for (const o of data.output) {
						if (o.type === 'message' && Array.isArray(o.content)) {
							for (const c of o.content) {
								if (typeof c.text === 'string' && c.text) {
									texts.push(c.text);
								}
							}
						} else if (typeof o.text === 'string' && o.text) {
							texts.push(o.text);
						}
					}
					responseMessage = texts.length > 0 ? texts.join('\n') : '';
				}
				if (!responseMessage.trim()) {
					if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
						return {
							success: false,
							message: `REASONING_TOKEN_LIMIT_EXCEEDED: Model '${data.model || 'reasoning-model'}' reached max_output_tokens during internal reasoning before generating visible output.`
						};
					}
					responseMessage = JSON.stringify(data);
				}
			} else if (url.includes('generativelanguage.googleapis.com')) {
				const parts = data.candidates?.[0]?.content?.parts;
				if (Array.isArray(parts)) {
					const textParts = parts
						.filter((p: any) => typeof p?.text === 'string' && !p?.thought)
						.map((p: any) => p.text);
					responseMessage = textParts.length > 0 ? textParts.join('') : (parts[0]?.text || JSON.stringify(data));
				} else {
					responseMessage = JSON.stringify(data);
				}
			} else if (url.includes('api.anthropic.com')) {
				if (Array.isArray(data.content)) {
					const textBlocks = data.content
						.filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
						.map((b: any) => b.text);
					responseMessage = textBlocks.length > 0 ? textBlocks.join('\n') : (data.content?.[0]?.text || JSON.stringify(data));
				} else {
					responseMessage = JSON.stringify(data);
				}
			} else {
				responseMessage = JSON.stringify(data);
			}

			return {
				success: true,
				message: responseMessage.trim()
			};
		} catch (err: any) {
			return {
				success: false,
				message: `Network Error: ${err.message || err}`
			};
		}
	}

	async executePrompt(modelId: string, prompt: string, systemPrompt?: string, targetProviderId?: string): Promise<{ success: boolean; text?: string; error?: string }> {
		await this.initializationPromise;
		if (!modelId?.trim() && this._defaultModel && (!targetProviderId || targetProviderId === this._defaultModel.providerId)) {
			// Nothing chosen: use the user's Default Model (and its provider unless the caller pinned one)
			modelId = this._defaultModel.modelId;
			targetProviderId = targetProviderId || this._defaultModel.providerId;
		}
		let sanitizedModel = (modelId || 'gemini-2.5-flash').replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-').trim();

		let providerId = targetProviderId || 'gemini';
		if (!targetProviderId) {
			const lowerM = sanitizedModel.toLowerCase();
			if (lowerM.startsWith('gpt') || /^o[1-9]/.test(lowerM) || lowerM.startsWith('chatgpt') || lowerM.startsWith('codex') || lowerM.startsWith('omni-') || lowerM.startsWith('text-embedding') || lowerM.startsWith('computer-use')) {
				providerId = 'openai';
			} else if (lowerM.startsWith('claude')) {
				providerId = 'anthropic';
			} else if (lowerM.startsWith('deepseek') || lowerM.startsWith('qwen') || lowerM.startsWith('llama')) {
				providerId = 'custom-openai';
			}
		}

		const enabledCreds = this._credentials.filter(c => c.isEnabled !== false);
		let cred: IAgentCredential | undefined;
		if (!targetProviderId) {
			// Provider not given: prefer a key that actually lists this model, then the Default Model's key for its own model
			const lowerModel = sanitizedModel.toLowerCase();
			cred = enabledCreds.find(c => c.cachedModels?.some(m => m.toLowerCase() === lowerModel));
			if (!cred && this._defaultModel && this._defaultModel.modelId.toLowerCase() === lowerModel) {
				cred = enabledCreds.find(c => this._defaultModel!.credentialId ? c.id === this._defaultModel!.credentialId : c.providerId === this._defaultModel!.providerId);
			}
			if (cred) {
				providerId = cred.providerId;
			}
		}
		if (!cred && targetProviderId && this._defaultModel?.credentialId && this._defaultModel.providerId === targetProviderId) {
			cred = enabledCreds.find(c => c.id === this._defaultModel!.credentialId);
		}
		cred ??= enabledCreds.find(c => c.providerId === providerId);
		if (!cred && targetProviderId) {
			cred = this._credentials.find(c => c.id === targetProviderId || c.name.toLowerCase() === targetProviderId.toLowerCase());
		}
		if (!cred) {
			// Last resort: the Default Model's key (not simply the first key in the list)
			cred = (this._defaultModel && enabledCreds.find(c => this._defaultModel!.credentialId ? c.id === this._defaultModel!.credentialId : c.providerId === this._defaultModel!.providerId))
				?? enabledCreds[0];
		}

		if (!cred) {
			return {
				success: false,
				error: `No configured AI credential found for provider '${providerId}'. Please add an API Key in AI Agent Settings / Credentials.`
			};
		}

		const apiKey = await this.getApiKey(cred.id);
		if (!apiKey) {
			return {
				success: false,
				error: `API key not found for credential '${cred.name}'. Please re-enter the API key in Settings.`
			};
		}

		try {
			if (cred.providerId === 'gemini') {
				const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${sanitizedModel}:generateContent?key=${apiKey}`;
				const contents: any[] = [{ parts: [{ text: prompt }] }];
				const payload: any = { contents };
				if (systemPrompt) {
					payload.system_instruction = { parts: [{ text: systemPrompt }] };
				}
				const headers = { 'Content-Type': 'application/json' };
				const res = await this._executeRequest(endpoint, headers, JSON.stringify(payload));
				return res.success ? { success: true, text: res.message } : { success: false, error: res.message };
			} else if (cred.providerId === 'anthropic') {
				const endpoint = 'https://api.anthropic.com/v1/messages';
				const payload: any = {
					model: sanitizedModel,
					max_tokens: 8192,
					messages: [{ role: 'user', content: prompt }]
				};
				if (systemPrompt) {
					payload.system = systemPrompt;
				}
				const headers = {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'dangerously-allow-html-and-other-things': 'true'
				};
				let res = await this._executeRequest(endpoint, headers, JSON.stringify(payload));
				if (!res.success && (res.message || '').includes('max_tokens')) {
					payload.max_tokens = 4096;
					res = await this._executeRequest(endpoint, headers, JSON.stringify(payload));
				}
				return res.success ? { success: true, text: res.message } : { success: false, error: res.message };
			} else {
				const baseEndpoint = cred.providerId === 'openai' ? 'https://api.openai.com/v1' : (cred.customUrl || getDefaultBaseUrl(cred.providerId));
				const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/completions\/?$/, '').replace(/\/responses\/?$/, '').replace(/\/$/, '');
				const headers = {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				};

				const runOpenAiPrompt = async (activeModel: string): Promise<{ success: boolean; message: string }> => {
					const lowerModel = activeModel.toLowerCase();
					const isReasoningOrNewer = /gpt-[5-9]/.test(lowerModel) || /^o[1-9]/.test(lowerModel) || lowerModel.startsWith('codex') || lowerModel.includes('-sol') || lowerModel.includes('-luna');
					const messages: any[] = [];
					if (systemPrompt) {
						messages.push({ role: isReasoningOrNewer ? 'developer' : 'system', content: systemPrompt });
					}
					messages.push({ role: 'user', content: prompt });

					// Do not artificially cap max_completion_tokens at 4096, because reasoning models (e.g. gpt-6.1-sol, gpt-5.x, o1/o3/o4)
					// count internal reasoning_tokens against max_completion_tokens and would exhaust 4096 tokens before writing visible output.
					const payload: any = {
						model: activeModel,
						messages
					};

					let res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
					if (res.success) {
						return res;
					}

					let errText = res.message || '';

					// 0. If reasoning model exhausted default server completion token cap on internal reasoning, retry with high max_completion_tokens + low/none reasoning_effort
					if (errText.includes('REASONING_TOKEN_LIMIT_EXCEEDED')) {
						payload.max_completion_tokens = 32768;
						payload.reasoning_effort = 'low';
						res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
						if (res.success) return res;
						errText = res.message || '';
						if (errText.includes('reasoning_effort') || errText.includes('REASONING_TOKEN_LIMIT_EXCEEDED')) {
							payload.reasoning_effort = 'none';
							res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
							if (res.success) return res;
							errText = res.message || '';
						}
						if (errText.includes('max_completion_tokens') || errText.includes('max_tokens')) {
							payload.max_completion_tokens = 16384;
							res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
							if (res.success) return res;
							errText = res.message || '';
						}
					}

					// 1. Handle explicit max_tokens / max_completion_tokens requirement from custom OpenAI-compatible servers
					if (errText.includes('max_tokens') || errText.includes('max_completion_tokens')) {
						if (errText.includes('max_completion_tokens') && !errText.includes('Unsupported parameter: \'max_completion_tokens\'')) {
							delete payload.max_tokens;
							payload.max_completion_tokens = 16384;
						} else {
							delete payload.max_completion_tokens;
							payload.max_tokens = 4096;
						}
						res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
						if (res.success) return res;
						errText = res.message || '';
					}

					// 2. Handle system/developer role restriction (e.g. o1-mini / o1-preview)
					if (systemPrompt && (errText.includes("'system'") || errText.includes("'developer'") || errText.includes('role') || errText.includes('messages[0]'))) {
						payload.messages = [{ role: 'user', content: `${systemPrompt}\n\n${prompt}` }];
						res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
						if (res.success) return res;
						errText = res.message || '';
					}

					// 3. Handle reasoning_effort restriction
					if (errText.includes('reasoning_effort')) {
						payload.reasoning_effort = 'none';
						res = await this._executeRequest(`${cleanBase}/chat/completions`, headers, JSON.stringify(payload));
						if (res.success) return res;
						errText = res.message || '';
					}

					// 4. Fallback to /v1/responses endpoint for newer OpenAI models (e.g. gpt-6.x, gpt-5-pro, o1-pro, codex, search-api)
					if (errText.includes('v1/responses') || errText.includes('responses endpoint') || errText.includes('REASONING_TOKEN_LIMIT_EXCEEDED') || isReasoningOrNewer) {
						const responsesPayload: any = {
							model: activeModel,
							input: prompt
						};
						if (systemPrompt) {
							responsesPayload.instructions = systemPrompt;
						}
						const respRes = await this._executeRequest(`${cleanBase}/responses`, headers, JSON.stringify(responsesPayload));
						if (respRes.success) return respRes;
						if (errText.includes('v1/responses') || errText.includes('responses endpoint')) {
							res = respRes;
							errText = res.message || '';
						}
					}

					// 5. Fallback to /v1/completions for legacy completion models
					if (!res.success && (errText.includes('v1/completions') || errText.includes('not a chat model') || errText.includes('v1/chat/completions endpoint'))) {
						const completionPayload = {
							model: activeModel,
							prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
							max_tokens: 4096
						};
						const compRes = await this._executeRequest(`${cleanBase}/completions`, headers, JSON.stringify(completionPayload));
						if (compRes.success) return compRes;
					}

					return res;
				};

				let res = await runOpenAiPrompt(sanitizedModel);
				// Automatic migration fallback if an old ticket still references retired 'o1-mini' or 'o1-preview'
				if (!res.success && (sanitizedModel === 'o1-mini' || sanitizedModel === 'o1-preview') && (res.message || '').includes('404')) {
					const fallbackModel = (Array.isArray(cred.cachedModels) && cred.cachedModels.includes('gpt-4o'))
						? 'gpt-4o'
						: 'gpt-4o-mini';
					res = await runOpenAiPrompt(fallbackModel);
				}

				return res.success ? { success: true, text: res.message } : { success: false, error: res.message };
			}
		} catch (err: any) {
			return { success: false, error: `Prompt execution failed: ${err.message || String(err)}` };
		}
	}

	async synthesizeSpeech(options: {
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
	}> {
		await this.initializationPromise;
		const inputText = (options.text || '').trim();
		if (!inputText) {
			return { success: false, error: 'Text input is empty. Please enter text to convert to speech.' };
		}

		const sanitizedModel = (options.modelId || 'tts-1').replace(/[\u2013\u2014\u2015\u2212\uFF0D]/g, '-').trim();
		const requestedFormat = (options.format || 'mp3').toLowerCase() as 'mp3' | 'wav' | 'opus' | 'aac';
		const voice = (options.voice || '').trim();

		// 1. Resolve credential
		let cred: IAgentCredential | undefined;
		if (options.credentialId) {
			cred = this._credentials.find(c => c.id === options.credentialId);
		}
		if (!cred && options.providerId) {
			cred = this._credentials.find(c => (c.id === options.providerId || c.providerId === options.providerId || c.name.toLowerCase() === options.providerId!.toLowerCase()) && c.isEnabled !== false);
		}
		if (!cred) {
			let inferredProvider = 'openai';
			if (sanitizedModel.toLowerCase().includes('gemini')) {
				inferredProvider = 'gemini';
			} else if (sanitizedModel.toLowerCase().startsWith('tts-') || sanitizedModel.toLowerCase().includes('gpt')) {
				inferredProvider = 'openai';
			}
			cred = this._credentials.find(c => c.providerId === inferredProvider && c.isEnabled !== false);
		}
		if (!cred) {
			cred = this._credentials.find(c => c.isEnabled !== false);
		}

		if (!cred) {
			return {
				success: false,
				error: 'No configured AI credential found. Please configure an API Key in Agent Central / Models.'
			};
		}

		const apiKey = await this.getApiKey(cred.id);
		if (!apiKey) {
			return {
				success: false,
				error: `API key not found for credential '${cred.name}'. Please re-enter the API key in Settings.`
			};
		}

		const mimeMap: Record<string, string> = {
			mp3: 'audio/mpeg',
			wav: 'audio/wav',
			opus: 'audio/opus',
			aac: 'audio/aac'
		};

		try {
			if (cred.providerId === 'gemini') {
				const geminiVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Leda', 'Orus'];
				const selectedGeminiVoice = geminiVoices.find(v => v.toLowerCase() === voice.toLowerCase()) || 'Kore';

				// Candidate models to try in order (selected model first if it's a TTS/2.0/2.5 model, then dedicated Gemini TTS models)
				const candidateModels: string[] = [];
				if (sanitizedModel && sanitizedModel.toLowerCase().includes('gemini')) {
					candidateModels.push(sanitizedModel.replace(/^models\//, ''));
				}
				for (const fallbackModel of ['gemini-2.5-flash-preview-tts', 'gemini-2.0-flash', 'gemini-2.0-flash-exp']) {
					if (!candidateModels.includes(fallbackModel)) {
						candidateModels.push(fallbackModel);
					}
				}

				let lastError = '';
				for (const candidateModel of candidateModels) {
					const isDedicatedTtsModel = candidateModel.toLowerCase().includes('-tts');
					const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${candidateModel}:generateContent?key=${apiKey}`;
					const promptText = isDedicatedTtsModel
						? inputText
						: `Please read the following text aloud verbatim without adding any extra commentary:\n\n${inputText}`;

					const payload = {
						contents: [{ parts: [{ text: promptText }] }],
						generationConfig: {
							responseModalities: ['AUDIO'],
							speechConfig: {
								voiceConfig: {
									prebuiltVoiceConfig: {
										voiceName: selectedGeminiVoice
									}
								}
							}
						}
					};

					const response = await this.requestService.request({
						type: 'POST',
						url: endpoint,
						headers: { 'Content-Type': 'application/json' },
						data: JSON.stringify(payload),
						timeout: 60000,
						callSite: 'agentCredentialService.synthesizeSpeech.gemini'
					}, CancellationToken.None);

					if (response.res.statusCode === 200) {
						const data = await asJson<any>(response);
						const parts = data?.candidates?.[0]?.content?.parts || [];
						const audioPart = parts.find((p: any) => p.inlineData && p.inlineData.data);
						if (audioPart && audioPart.inlineData?.data) {
							const rawMime: string = audioPart.inlineData.mimeType || 'audio/pcm';
							const rawBytes = decodeBase64(audioPart.inlineData.data).buffer;
							// If Gemini returns raw L16 PCM bytes, wrap with a 44-byte WAV header so <audio> plays natively
							if (rawMime.toLowerCase().includes('l16') || rawMime.toLowerCase().includes('pcm')) {
								const rateMatch = rawMime.match(/rate=(\d+)/i);
								const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
								const wavBytes = this._wrapPcmInWavHeader(rawBytes, sampleRate, 1, 16);
								return {
									success: true,
									audioBuffer: wavBytes,
									mimeType: 'audio/wav',
									format: requestedFormat
								};
							}
							return {
								success: true,
								audioBuffer: rawBytes,
								mimeType: rawMime || mimeMap[requestedFormat] || 'audio/mpeg',
								format: requestedFormat
							};
						}
						lastError = 'Model response did not contain audio inlineData.';
					} else {
						const errText = await asText(response) || '';
						try {
							const parsed = JSON.parse(errText);
							lastError = parsed.error?.message || errText;
						} catch {
							lastError = errText || `HTTP ${response.res.statusCode}`;
						}
					}
				}

				return {
					success: false,
					error: `Gemini TTS synthesis failed: ${lastError || 'Unable to generate audio.'}`
				};
			} else if (cred.providerId === 'openai' || cred.providerId === 'custom-openai') {
				const baseEndpoint = cred.providerId === 'openai' ? 'https://api.openai.com/v1' : (cred.customUrl || getDefaultBaseUrl(cred.providerId));
				const cleanBase = baseEndpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/completions\/?$/, '').replace(/\/audio\/speech\/?$/, '').replace(/\/$/, '');
				const speechUrl = `${cleanBase}/audio/speech`;

				const openaiVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'];
				const selectedVoice = openaiVoices.find(v => v.toLowerCase() === voice.toLowerCase()) || (cred.providerId === 'custom-openai' && voice ? voice : 'alloy');

				// Try the user's selected model first; if it's a chat model (like gpt-4o) that fails on /audio/speech, fallback to tts-1
				const candidateModels: string[] = [];
				if (sanitizedModel) {
					candidateModels.push(sanitizedModel);
				}
				for (const fb of ['tts-1', 'gpt-4o-mini-tts', 'tts-1-hd']) {
					if (!candidateModels.includes(fb)) {
						candidateModels.push(fb);
					}
				}

				let lastError = '';
				for (const candidateModel of candidateModels) {
					const payload = {
						model: candidateModel,
						input: inputText,
						voice: selectedVoice,
						response_format: requestedFormat
					};

					const response = await this.requestService.request({
						type: 'POST',
						url: speechUrl,
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${apiKey}`
						},
						data: JSON.stringify(payload),
						timeout: 60000,
						callSite: 'agentCredentialService.synthesizeSpeech.openai'
					}, CancellationToken.None);

					if (response.res.statusCode === 200) {
						const vsBuffer = await streamToBuffer(response.stream);
						if (vsBuffer.byteLength > 0) {
							return {
								success: true,
								audioBuffer: vsBuffer.buffer,
								mimeType: mimeMap[requestedFormat] || 'audio/mpeg',
								format: requestedFormat
							};
						}
						lastError = 'Received empty audio stream from server.';
					} else {
						const errText = await asText(response) || '';
						try {
							const parsed = JSON.parse(errText);
							lastError = parsed.error?.message || errText;
						} catch {
							lastError = errText || `HTTP ${response.res.statusCode}`;
						}
					}
				}

				return {
					success: false,
					error: `TTS synthesis failed: ${lastError}`
				};
			} else {
				return {
					success: false,
					error: `Provider '${cred.providerId}' does not natively support TTS audio synthesis. Please select an OpenAI, Google Gemini, or Custom OpenAI credential.`
				};
			}
		} catch (err: any) {
			return {
				success: false,
				error: `Speech synthesis failed: ${err.message || String(err)}`
			};
		}
	}

	private _wrapPcmInWavHeader(pcmBytes: Uint8Array, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Uint8Array {
		const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
		const blockAlign = numChannels * (bitsPerSample / 8);
		const dataSize = pcmBytes.byteLength;
		const buffer = new ArrayBuffer(44 + dataSize);
		const view = new DataView(buffer);

		const writeString = (offset: number, str: string) => {
			for (let i = 0; i < str.length; i++) {
				view.setUint8(offset + i, str.charCodeAt(i));
			}
		};

		writeString(0, 'RIFF');
		view.setUint32(4, 36 + dataSize, true);
		writeString(8, 'WAVE');
		writeString(12, 'fmt ');
		view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
		view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
		view.setUint16(22, numChannels, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, byteRate, true);
		view.setUint16(32, blockAlign, true);
		view.setUint16(34, bitsPerSample, true);
		writeString(36, 'data');
		view.setUint32(40, dataSize, true);

		const wavBytes = new Uint8Array(buffer);
		wavBytes.set(pcmBytes, 44);
		return wavBytes;
	}
}
