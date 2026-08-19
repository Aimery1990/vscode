/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Any Agent / Google Deepmind. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IAgentCredential, IAgentCredentialService } from '../common/agentsManager.js';
import { IRequestService, asJson, asText } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';

export class AgentCredentialService extends Disposable implements IAgentCredentialService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCredentials = this._register(new Emitter<void>());
	readonly onDidChangeCredentials: Event<void> = this._onDidChangeCredentials.event;

	private _credentials: IAgentCredential[] = [];
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
				this._onDidChangeCredentials.fire();
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
					const sessionsPromise = this.authenticationService.getSessions(providerId);
					const timeoutPromise = new Promise<readonly any[]>(resolve => {
						timeoutId = setTimeout(() => resolve([]), 1000);
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
				newUserIdentifier = `${activeResult.providerId}:${activeResult.session.account.label}`;
			}

			if (newUserIdentifier !== this.activeUserEmail) {
				this.activeUserEmail = newUserIdentifier;
				this._loadCredentials();
				this._onDidChangeCredentials.fire();
			}
		} catch (err) {
			console.error('Failed to update active user in AgentCredentialService:', err);
		}
	}

	private get credentialsStorageKey(): string {
		return `workbench.agentsManager.credentials:${this.activeUserEmail || 'unauthenticated'}`;
	}

	private _loadCredentials(): void {
		const raw = this.storageService.get(this.credentialsStorageKey, StorageScope.PROFILE);
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
		return await this.secretStorageService.get(secretKey);
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

			// Attempt 1: Chat completions with max_tokens
			let attemptUrl = `${cleanBase}/chat/completions`;
			let attemptData: any = {
				model: cleanModel,
				messages: [{ role: 'user', content: 'Hello! Respond with "Connection Test Successful" if you receive this.' }],
				max_tokens: 30
			};

			let res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
			if (res.success) {
				return res;
			}

			// Analyse the error to do smart fallback
			const errText = res.message || '';
			if (errText.includes('max_tokens') && errText.includes('max_completion_tokens')) {
				// Fallback 1a: Reasoning model uses max_completion_tokens instead of max_tokens
				delete attemptData.max_tokens;
				attemptData.max_completion_tokens = 30;
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
				if (res.success) return res;
			} else if (errText.includes('v1/responses') || errText.includes('responses endpoint')) {
				// Fallback 2: Model requires v1/responses endpoint
				attemptUrl = `${cleanBase}/responses`;
				const responseData = {
					model: cleanModel,
					input: 'Hello! Respond with "Connection Test Successful" if you receive this.'
				};
				res = await this._executeRequest(attemptUrl, headers, JSON.stringify(responseData));
				if (res.success) return res;
			} else if (errText.includes('v1/completions') || errText.includes('not a chat model') || errText.includes('v1/chat/completions endpoint')) {
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

			// If the model name itself suggests completion or reasoning/newer API, do proactive fallbacks
			if (!res.success) {
				const lowerModel = cleanModel.toLowerCase();
				if (lowerModel.includes('gpt-5') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3')) {
					// Proactive reasoning model check
					attemptUrl = `${cleanBase}/chat/completions`;
					delete attemptData.max_tokens;
					attemptData.max_completion_tokens = 30;
					res = await this._executeRequest(attemptUrl, headers, JSON.stringify(attemptData));
					if (res.success) return res;
				}
			}

			return res;
		}

		return { success: false, message: `Unsupported provider: ${providerId}` };
	}

	private async _executeRequest(url: string, headers: Record<string, string>, body: string): Promise<{ success: boolean; message: string }> {
		try {
			const response = await this.requestService.request({
				type: 'POST',
				url,
				headers,
				data: body,
				timeout: 12000,
				callSite: 'agentCredentialService.testConnection'
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
				responseMessage = data.choices?.[0]?.message?.content || JSON.stringify(data);
			} else if (url.includes('/completions')) {
				responseMessage = data.choices?.[0]?.text || JSON.stringify(data);
			} else if (url.includes('/responses')) {
				if (Array.isArray(data.output)) {
					const msgObj = data.output.find((o: any) => o.type === 'message' && o.content);
					const textObj = msgObj?.content?.find((c: any) => c.text);
					responseMessage = textObj?.text || JSON.stringify(data);
				} else {
					responseMessage = JSON.stringify(data);
				}
			} else if (url.includes('generativelanguage.googleapis.com')) {
				responseMessage = data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
			} else if (url.includes('api.anthropic.com')) {
				responseMessage = data.content?.[0]?.text || JSON.stringify(data);
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
}
