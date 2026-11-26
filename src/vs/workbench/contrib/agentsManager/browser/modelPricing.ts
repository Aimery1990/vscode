/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ESTIMATED model prices, taken from public third-party catalogs (OpenRouter's model list, then LiteLLM's price
 * table). Providers' own model-list APIs do not expose prices, so these figures are approximations for comparing
 * models — not official pricing. Cached for a day in application storage.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';

export interface IModelPriceEstimate {
	/** USD per 1M input tokens. */
	readonly input: number;
	/** USD per 1M output tokens. */
	readonly output: number;
	readonly contextLength?: number;
	readonly source: 'OpenRouter' | 'LiteLLM';
	/** The catalog entry the price was taken from (may be a base model when `id` is a dated / regional variant). */
	readonly matchedId: string;
}

export interface IModelPriceCatalog {
	readonly fetchedAt: number;
	readonly prices: Readonly<Record<string, Omit<IModelPriceEstimate, 'matchedId'>>>;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_KEY = 'workbench.agentsManager.modelPriceEstimates';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** LiteLLM entries from these hosts are the providers' own list prices (others are cloud resellers / regional). */
const LITELLM_PREFIXES = new Set(['', 'dashscope', 'gemini', 'moonshot', 'deepseek', 'zai', 'xai', 'mistral']);

let memoryCache: IModelPriceCatalog | undefined;
let inflight: Promise<IModelPriceCatalog | undefined> | undefined;

/** Returns the cached catalog, refreshing it when older than a day. Never throws; undefined if nothing is available. */
export function getModelPriceCatalog(requestService: IRequestService, storageService: IStorageService, forceRefresh = false): Promise<IModelPriceCatalog | undefined> {
	if (!memoryCache) {
		try {
			const raw = storageService.get(CACHE_KEY, StorageScope.APPLICATION);
			memoryCache = raw ? JSON.parse(raw) as IModelPriceCatalog : undefined;
		} catch {
			memoryCache = undefined;
		}
	}
	if (!forceRefresh && memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
		return Promise.resolve(memoryCache);
	}
	if (!inflight) {
		inflight = fetchCatalog(requestService).then(fresh => {
			if (fresh) {
				memoryCache = fresh;
				storageService.store(CACHE_KEY, JSON.stringify(fresh), StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			return memoryCache;
		}).finally(() => inflight = undefined);
	}
	return inflight;
}

async function fetchCatalog(requestService: IRequestService): Promise<IModelPriceCatalog | undefined> {
	const prices: Record<string, Omit<IModelPriceEstimate, 'matchedId'>> = {};

	// 1. OpenRouter (preferred): ids look like "qwen/qwen3.7-flash"; prices are USD per token as strings
	try {
		const res = await requestService.request({ type: 'GET', url: OPENROUTER_MODELS_URL, timeout: 15000, callSite: 'modelPricing.openrouter' }, CancellationToken.None);
		const data = await asJson<{ data?: { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[] }>(res);
		for (const m of data?.data ?? []) {
			if (m.id.includes(':')) {
				continue; // ":batch" / ":free" variants
			}
			const input = Number(m.pricing?.prompt);
			const output = Number(m.pricing?.completion);
			if (!isFinite(input) || !isFinite(output) || input < 0 || output < 0) {
				continue;
			}
			const key = normalize(m.id.split('/').pop()!);
			if (!prices[key]) {
				prices[key] = { input: input * 1e6, output: output * 1e6, contextLength: m.context_length, source: 'OpenRouter' };
			}
		}
	} catch (err) {
		console.warn('[ModelPricing] OpenRouter catalog unavailable:', err);
	}

	// 2. LiteLLM (fills gaps): keys like "gpt-5-mini", "dashscope/qwen-flash", "gemini/gemini-3.8-flash"
	try {
		const res = await requestService.request({ type: 'GET', url: LITELLM_PRICES_URL, timeout: 20000, callSite: 'modelPricing.litellm' }, CancellationToken.None);
		const data = await asJson<Record<string, { input_cost_per_token?: number; output_cost_per_token?: number; max_input_tokens?: number; mode?: string }>>(res);
		for (const [fullKey, v] of Object.entries(data ?? {})) {
			const slash = fullKey.lastIndexOf('/');
			const prefix = slash === -1 ? '' : fullKey.slice(0, slash);
			if (!LITELLM_PREFIXES.has(prefix) || typeof v?.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') {
				continue;
			}
			const key = normalize(fullKey.slice(slash + 1));
			if (!prices[key]) {
				prices[key] = { input: v.input_cost_per_token * 1e6, output: v.output_cost_per_token * 1e6, contextLength: v.max_input_tokens, source: 'LiteLLM' };
			}
		}
	} catch (err) {
		console.warn('[ModelPricing] LiteLLM catalog unavailable:', err);
	}

	return Object.keys(prices).length > 0 ? { fetchedAt: Date.now(), prices } : undefined;
}

function normalize(id: string): string {
	return id.trim().toLowerCase();
}

/** Candidate catalog ids for a provider model id, most specific first (dated / regional / "latest" variants fall back to the base model). */
function candidateIds(modelId: string): string[] {
	const out: string[] = [];
	const push = (s: string) => { if (s && !out.includes(s)) { out.push(s); } };
	let id = normalize(modelId.split('/').pop() || modelId);
	push(id);
	for (let i = 0; i < 3; i++) {
		const next = id
			.replace(/-(us|intl|cn|global)$/, '')
			.replace(/-latest$/, '')
			.replace(/-\d{4}-\d{2}-\d{2}$/, '')
			.replace(/-\d{8}$/, '')
			.replace(/-\d{4}$/, '');
		if (next === id) {
			break;
		}
		id = next;
		push(id);
	}
	return out;
}

/** Estimated price for a model id, or undefined if no catalog lists it. */
export function lookupModelPrice(catalog: IModelPriceCatalog | undefined, modelId: string): IModelPriceEstimate | undefined {
	if (!catalog) {
		return undefined;
	}
	for (const candidate of candidateIds(modelId)) {
		const hit = catalog.prices[candidate];
		if (hit) {
			return { ...hit, matchedId: candidate };
		}
	}
	return undefined;
}

/** "$0.03", "$1.25", "$0.0035" — compact USD for per-1M prices. */
export function formatPerMillion(usd: number): string {
	if (usd === 0) {
		return '$0';
	}
	return `$${usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3).replace(/0$/, '') : usd.toPrecision(2)}`;
}

/** "128K", "1M" */
export function formatContextLength(tokens: number | undefined): string {
	if (!tokens) {
		return '—';
	}
	return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}
