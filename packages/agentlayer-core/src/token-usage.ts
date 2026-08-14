import type { LanguageModel, LanguageModelUsage } from 'ai'
import type { ModelKey } from './models'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelTokenUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens: number
	/**
	 * Provider-reported uncached prompt tokens (AI SDK
	 * `inputTokenDetails.noCacheTokens`), summed across calls. `undefined` when
	 * any accumulated call omitted it — a partial sum would silently
	 * misrepresent the models that did report it. When present, costing uses
	 * this number instead of deriving `inputTokens - cacheRead - cacheWrite`,
	 * so a provider whose breakdown doesn't perfectly telescope (rounding,
	 * cache-block granularity) is billed on its own accounting rather than
	 * ours.
	 */
	noCacheInputTokens?: number
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
	contextWindowLimit?: number
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
		// Unlike the counters above, absence is meaningful here (it decides
		// whether costing can trust the provider's breakdown), so no `?? 0` —
		// but a reported negative is clamped so it can never drag a summed
		// count below zero.
		noCacheInputTokens:
			usage.inputTokenDetails?.noCacheTokens !== undefined
				? Math.max(0, usage.inputTokenDetails.noCacheTokens)
				: undefined,
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

type PricingLookup = (modelKey: ModelKey) => ModelPricing | undefined

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
			// Sums only while EVERY call reported it; one silent call poisons the
			// model's sum to undefined so costing falls back to derivation instead
			// of billing a partial "uncached" figure as if it covered all calls.
			existing.noCacheInputTokens =
				existing.noCacheInputTokens !== undefined && usage.noCacheInputTokens !== undefined
					? existing.noCacheInputTokens + usage.noCacheInputTokens
					: undefined
		} else {
			this.byModel[modelKey] = { ...usage }
		}
	}

	snapshot(): TokenUsage {
		const totals = emptyTotals()
		const byModel: Record<string, ModelTokenUsage> = {}
		// Same poisoning rule as add(): the total is only meaningful when every
		// model reported its own uncached figure.
		let totalNoCache: number | undefined = 0

		for (const [modelKey, usage] of Object.entries(this.byModel)) {
			const pricing = this.pricingLookup?.(modelKey as ModelKey)
			// Prefer the provider's own uncached figure over deriving it — the
			// subtraction is a fallback for providers that only report the
			// inclusive total. Whichever side is reported, the priced categories
			// are reconciled to PARTITION the prompt total: without the cap a
			// non-telescoping breakdown (rounding, cache-block granularity) would
			// bill more prompt tokens than the prompt contained, and a negative
			// counter would push a summed category below zero.
			const uncachedInputTokens =
				usage.noCacheInputTokens !== undefined
					? Math.min(Math.max(0, usage.noCacheInputTokens), Math.max(0, usage.inputTokens))
					: undefined
			const cacheReadTokens = Math.min(
				Math.max(0, usage.cacheReadTokens),
				Math.max(0, usage.inputTokens) - (uncachedInputTokens ?? 0),
			)
			const cacheWriteTokens = Math.min(
				Math.max(0, usage.cacheWriteTokens),
				Math.max(0, usage.inputTokens) - (uncachedInputTokens ?? 0) - cacheReadTokens,
			)
			const pricedUncachedTokens =
				uncachedInputTokens ?? Math.max(0, usage.inputTokens) - cacheReadTokens - cacheWriteTokens
			const estimatedCostUsd = pricing
				? (pricedUncachedTokens * pricing.input) / 1_000_000 +
					(usage.outputTokens * pricing.output) / 1_000_000 +
					(cacheReadTokens * (pricing.cacheRead ?? pricing.input)) / 1_000_000 +
					(cacheWriteTokens * (pricing.cacheWrite ?? pricing.input)) / 1_000_000
				: undefined

			byModel[modelKey] = { ...usage, estimatedCostUsd }

			totals.inputTokens += usage.inputTokens
			totals.outputTokens += usage.outputTokens
			totals.cacheReadTokens += usage.cacheReadTokens
			totals.cacheWriteTokens += usage.cacheWriteTokens
			totals.reasoningTokens += usage.reasoningTokens
			totalNoCache =
				totalNoCache !== undefined && usage.noCacheInputTokens !== undefined
					? totalNoCache + usage.noCacheInputTokens
					: undefined
			if (estimatedCostUsd !== undefined) {
				totals.estimatedCostUsd = (totals.estimatedCostUsd ?? 0) + estimatedCostUsd
			}
		}

		// An empty accumulator has no calls to vouch for; leave it undefined.
		if (Object.keys(this.byModel).length > 0 && totalNoCache !== undefined) {
			totals.noCacheInputTokens = totalNoCache
		}

		return { byModel, totals }
	}
}
