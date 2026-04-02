import type { LanguageModel, LanguageModelUsage } from 'ai'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelTokenUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens: number
	estimatedCostUsd: number | undefined
}

export interface TokenTotals extends ModelTokenUsage {}

export interface TokenUsage {
	byModel: Record<string, ModelTokenUsage>
	totals: TokenTotals
}

export interface TokenUsageEvent {
	model: string
	usage: Omit<ModelTokenUsage, 'estimatedCostUsd'>
	contextWindowTokens: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build the per-model key from a LanguageModel instance. */
export function getModelKey(model: LanguageModel | string): string {
	if (typeof model === 'string') return model
	return `${model.provider}/${model.modelId}`
}

/** Extract usage fields from the AI SDK's LanguageModelUsage into our flat structure. */
export function extractUsage(usage: LanguageModelUsage): Omit<ModelTokenUsage, 'estimatedCostUsd'> {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
		reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
	}
}

function emptyTotals(): TokenTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		estimatedCostUsd: undefined,
	}
}

// ── Accumulator ──────────────────────────────────────────────────────────────

type PricingLookup = (modelKey: string) => ModelPricing | undefined

export interface ModelPricing {
	input: number // USD per million tokens
	output: number
	cacheRead?: number
	cacheWrite?: number
}

export class TokenUsageAccumulator {
	private byModel: Record<string, Omit<ModelTokenUsage, 'estimatedCostUsd'>> = {}
	private pricingLookup: PricingLookup | undefined

	constructor(pricingLookup?: PricingLookup) {
		this.pricingLookup = pricingLookup
	}

	add(modelKey: string, usage: Omit<ModelTokenUsage, 'estimatedCostUsd'>): void {
		const existing = this.byModel[modelKey]
		if (existing) {
			existing.inputTokens += usage.inputTokens
			existing.outputTokens += usage.outputTokens
			existing.cacheReadTokens += usage.cacheReadTokens
			existing.cacheWriteTokens += usage.cacheWriteTokens
			existing.reasoningTokens += usage.reasoningTokens
		} else {
			this.byModel[modelKey] = { ...usage }
		}
	}

	snapshot(): TokenUsage {
		const totals = emptyTotals()
		const byModel: Record<string, ModelTokenUsage> = {}

		for (const [modelKey, usage] of Object.entries(this.byModel)) {
			const pricing = this.pricingLookup?.(modelKey)
			const estimatedCostUsd = pricing
				? (usage.inputTokens * pricing.input) / 1_000_000 +
					(usage.outputTokens * pricing.output) / 1_000_000 +
					(usage.cacheReadTokens * (pricing.cacheRead ?? 0)) / 1_000_000 +
					(usage.cacheWriteTokens * (pricing.cacheWrite ?? 0)) / 1_000_000
				: undefined

			byModel[modelKey] = { ...usage, estimatedCostUsd }

			totals.inputTokens += usage.inputTokens
			totals.outputTokens += usage.outputTokens
			totals.cacheReadTokens += usage.cacheReadTokens
			totals.cacheWriteTokens += usage.cacheWriteTokens
			totals.reasoningTokens += usage.reasoningTokens
			if (estimatedCostUsd !== undefined) {
				totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + estimatedCostUsd
			}
		}

		return { byModel, totals }
	}
}
