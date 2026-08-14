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
		// and a NEGATIVE report is treated as absent rather than clamped:
		// clamping garbage to 0 would present "zero uncached tokens" as a
		// provider-vouched fact and bill the whole prompt at $0, where absence
		// correctly falls back to derivation.
		noCacheInputTokens:
			usage.inputTokenDetails?.noCacheTokens !== undefined && usage.inputTokenDetails.noCacheTokens >= 0
				? usage.inputTokenDetails.noCacheTokens
				: undefined,
	}
}

/**
 * Sums two optional counters under the poisoning rule: one missing operand
 * makes the sum `undefined`, because a partial sum presented as a complete one
 * is worse than none. This is a business rule, not a convenience — every place
 * that accumulates `noCacheInputTokens` must use it so the policy cannot
 * diverge between call sites.
 */
export function sumOrPoison(a: number | undefined, b: number | undefined): number | undefined {
	return a !== undefined && b !== undefined ? a + b : undefined
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
			// One silent call poisons the model's sum so costing falls back to
			// derivation instead of billing a partial "uncached" figure as if it
			// covered all calls.
			existing.noCacheInputTokens = sumOrPoison(existing.noCacheInputTokens, usage.noCacheInputTokens)
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
			// inclusive total. The provider figure is TRUSTED only when the rest
			// of the prompt is accounted for: either cache counters exist to
			// price the remainder, or the figure covers the whole prompt. A bare
			// noCache below the total with no cache counters would price the
			// cached remainder at $0, so it falls back to derivation instead.
			// Whichever side wins, the priced categories are reconciled to
			// PARTITION the prompt total: without the cap a non-telescoping
			// breakdown (rounding, cache-block granularity) would bill more
			// prompt tokens than the prompt contained.
			const promptTotal = Math.max(0, usage.inputTokens)
			const hasCacheCounters = Math.max(0, usage.cacheReadTokens) > 0 || Math.max(0, usage.cacheWriteTokens) > 0
			const uncachedInputTokens =
				usage.noCacheInputTokens !== undefined && (hasCacheCounters || usage.noCacheInputTokens >= promptTotal)
					? Math.min(usage.noCacheInputTokens, promptTotal)
					: undefined
			const cacheReadTokens = Math.min(
				Math.max(0, usage.cacheReadTokens),
				promptTotal - (uncachedInputTokens ?? 0),
			)
			const cacheWriteTokens = Math.min(
				Math.max(0, usage.cacheWriteTokens),
				promptTotal - (uncachedInputTokens ?? 0) - cacheReadTokens,
			)
			const pricedUncachedTokens = uncachedInputTokens ?? promptTotal - cacheReadTokens - cacheWriteTokens
			const estimatedCostUsd = pricing
				? (pricedUncachedTokens * pricing.input) / 1_000_000 +
					(usage.outputTokens * pricing.output) / 1_000_000 +
					(cacheReadTokens * (pricing.cacheRead ?? pricing.input)) / 1_000_000 +
					(cacheWriteTokens * (pricing.cacheWrite ?? pricing.input)) / 1_000_000
				: undefined

			// Publish the RECONCILED figure (the one costing used), never the raw
			// report: a raw pathological value in byModel/totals could exceed
			// inputTokens and contradict the billed cost.
			byModel[modelKey] = { ...usage, noCacheInputTokens: uncachedInputTokens, estimatedCostUsd }

			totals.inputTokens += usage.inputTokens
			totals.outputTokens += usage.outputTokens
			totals.cacheReadTokens += usage.cacheReadTokens
			totals.cacheWriteTokens += usage.cacheWriteTokens
			totals.reasoningTokens += usage.reasoningTokens
			totalNoCache = sumOrPoison(totalNoCache, uncachedInputTokens)
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
