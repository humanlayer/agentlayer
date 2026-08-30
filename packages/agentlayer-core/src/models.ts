import modelsDotDevJsonFile from '../models.json'
import type { ModelPricing } from './token-usage'

// ── Types for models.dev api.json ────────────────────────────────────────────

interface ModelsDevModel {
	id?: string
	name?: string
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

/**
 * Effective Codex context window, per model.
 *
 * Codex reserves 5% of the raw backend window for system prompt, tool overhead, and output:
 * gpt-5.4/5.5 use 272,000 raw tokens; gpt-5.6 uses 372,000 raw tokens.
 */
export const CODEX_CONTEXT_WINDOWS = {
	'gpt-5.6-sol': 353_400,
	'gpt-5.6-terra': 353_400,
	'gpt-5.6-luna': 353_400,
	'gpt-5.5': 258_400,
	'gpt-5.4': 258_400,
	'gpt-5.4-mini': 258_400,
} as const

export type CodexModel = keyof typeof CODEX_CONTEXT_WINDOWS

/** Unrecognized Codex models predate GPT-5.6's larger window, or are newer than this build. */
export function getCodexContextWindow(modelId: string): number {
	return CODEX_CONTEXT_WINDOWS[modelId as CodexModel] ?? CODEX_CONTEXT_WINDOWS['gpt-5.5']
}

/**
 * Provider name for a user-supplied OpenAI-compatible Responses endpoint (Azure AI
 * Foundry, or OpenAI direct). The models behind it are OpenAI catalog models, so the
 * key must resolve to `openai` here — anything else silently costs nothing, because a
 * pricing miss is reported as `undefined` rather than an error. CodeLayer builds the
 * model with this exact name; import it from there rather than repeating the literal.
 */
export const CUSTOM_RESPONSES_PROVIDER = 'custom-openai-responses'

const PROVIDER_LIMIT_OVERRIDES: Record<string, Partial<ModelLimits>> = {}

function getProviderLimitOverride(modelKey: ModelKey): Partial<ModelLimits> | undefined {
	const [rawProviderKey, modelId] = modelKey.split('/', 2)
	const baseKey = rawProviderKey?.split('.')[0]
	if (!baseKey || !modelId) return undefined

	if (baseKey.startsWith('codex')) return { context: getCodexContextWindow(modelId) }
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
			// Codex providers use custom names but their models are OpenAI models. So is the model
			// behind a custom Responses endpoint: CODELAYER_CODEX_MODEL renames it only on the wire,
			// so modelId here is still the selected OpenAI catalog id.
			const providerKey =
				baseKey.startsWith('codex') || baseKey === CUSTOM_RESPONSES_PROVIDER ? 'openai' : baseKey

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
