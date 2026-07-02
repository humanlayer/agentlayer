import modelsDotDevJsonFile from '../models.json'
import type { ModelPricing } from './token-usage'

// ── Types for models.dev api.json ────────────────────────────────────────────

interface ModelsDevModel {
	id?: string
	name?: string
	reasoning?: boolean
	tool_call?: boolean
	temperature?: boolean
	modalities?: {
		input?: string[]
		output?: string[]
	}
	cost?: {
		input?: number
		output?: number
		cache_read?: number
		cache_write?: number
	}
	limit?: {
		context?: number
		output?: number
		input?: number
	}
}

interface ModelsDevProvider {
	id?: string
	name?: string
	models?: Record<string, ModelsDevModel>
}

export interface ModelLimits {
	context: number
	output: number
	input?: number
}

export type ModelKey = `${string}/${string}`

export const PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT = 258_400

const PROVIDER_LIMIT_OVERRIDES: Record<string, Partial<ModelLimits>> = {
	codex: { context: PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT },
}

function getProviderLimitOverride(modelKey: ModelKey): Partial<ModelLimits> | undefined {
	const [rawProviderKey] = modelKey.split('/', 2)
	const baseKey = rawProviderKey?.split('.')[0]
	if (!baseKey) return undefined

	if (baseKey.startsWith('codex')) return PROVIDER_LIMIT_OVERRIDES.codex
	return PROVIDER_LIMIT_OVERRIDES[baseKey]
}

export class ModelProvider {
	public static readonly API_URL = 'https://models.dev/api.json'
	private modelsData: Record<string, ModelsDevProvider> | undefined
	private refreshTimer: ReturnType<typeof setInterval> | undefined

	constructor() {
		this.modelsData = modelsDotDevJsonFile as Record<string, ModelsDevProvider>
	}

	public static async fetchFromApi(): Promise<Record<string, ModelsDevProvider> | undefined> {
		try {
			const response = await fetch(ModelProvider.API_URL)
			if (!response.ok) return undefined
			const json = await response.text()
			const data = JSON.parse(json)
			return data
		} catch {
			return undefined
		}
	}

	public async scheduleRefresh() {
		if (this.refreshTimer) return
		this.refreshTimer = setInterval(
			async () => {
				const fresh = await ModelProvider.fetchFromApi()
				if (fresh) this.modelsData = fresh
			},
			60 * 60 * 1000,
		) // hourly
		this.refreshTimer.unref()
	}

	public getModelInfo(modelKey: ModelKey) {
		{
			if (!this.modelsData) return undefined
			const [rawProviderKey, modelId] = modelKey.split('/', 2)
			if (!rawProviderKey || !modelId) return undefined

			// AI SDK provider keys include a suffix (e.g. "anthropic.messages", "openai.chat")
			// but models.dev uses the base provider name (e.g. "anthropic", "openai")
			const baseKey = rawProviderKey.split('.')[0]!
			// Codex providers use custom names but their models are OpenAI models
			const providerKey = baseKey.startsWith('codex') ? 'openai' : baseKey

			const provider = this.modelsData[providerKey]
			if (!provider?.models) return undefined

			// Direct lookup
			if (provider.models[modelId]) return provider.models[modelId]

			// Substring match — e.g. "claude-sonnet-4-20250514" matches key containing that string
			for (const [key, model] of Object.entries(provider.models)) {
				if (key.includes(modelId) || modelId.includes(key)) {
					return model
				}
			}
			return undefined
		}
	}

	public getModelLimits(modelKey: ModelKey): ModelLimits | undefined {
		const entry = this.getModelInfo(modelKey)
		if (!entry?.limit?.context || !entry?.limit?.output) return undefined
		const override = getProviderLimitOverride(modelKey)
		return {
			context: override?.context ?? entry.limit.context,
			output: override?.output ?? entry.limit.output,
			input: override?.input ?? entry.limit.input,
		}
	}

	public getModelPricing(modelKey: ModelKey): ModelPricing | undefined {
		const entry = this.getModelInfo(modelKey)
		if (!entry?.cost) return undefined
		return {
			input: entry.cost.input ?? 0,
			output: entry.cost.output ?? 0,
			cacheRead: entry.cost.cache_read,
			cacheWrite: entry.cost.cache_write,
		}
	}
}
