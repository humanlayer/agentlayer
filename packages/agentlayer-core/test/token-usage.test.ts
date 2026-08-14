import { describe, expect, test } from 'bun:test'
import { extractUsage, getModelKey, TokenUsageAccumulator } from '../src/token-usage'

describe('TokenUsageAccumulator', () => {
	test('empty accumulator returns zero totals', () => {
		const acc = new TokenUsageAccumulator()
		const snapshot = acc.snapshot()
		expect(snapshot.totals.inputTokens).toBe(0)
		expect(snapshot.totals.outputTokens).toBe(0)
		expect(snapshot.totals.estimatedCostUsd).toBeUndefined()
		expect(Object.keys(snapshot.byModel)).toHaveLength(0)
	})

	test('single model accumulation', () => {
		const acc = new TokenUsageAccumulator()
		acc.add('anthropic/claude-sonnet', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200,
			cacheWriteTokens: 100,
			reasoningTokens: 0,
		})
		acc.add('anthropic/claude-sonnet', {
			inputTokens: 2000,
			outputTokens: 800,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 50,
		})
		const snapshot = acc.snapshot()
		expect(snapshot.byModel['anthropic/claude-sonnet']!.inputTokens).toBe(3000)
		expect(snapshot.byModel['anthropic/claude-sonnet']!.outputTokens).toBe(1300)
		expect(snapshot.byModel['anthropic/claude-sonnet']!.cacheReadTokens).toBe(200)
		expect(snapshot.byModel['anthropic/claude-sonnet']!.reasoningTokens).toBe(50)
		expect(snapshot.totals.inputTokens).toBe(3000)
		expect(snapshot.totals.outputTokens).toBe(1300)
	})

	test('multiple model accumulation', () => {
		const acc = new TokenUsageAccumulator()
		acc.add('anthropic/claude-sonnet', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		})
		acc.add('anthropic/claude-haiku', {
			inputTokens: 400,
			outputTokens: 150,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		})
		const snapshot = acc.snapshot()
		expect(Object.keys(snapshot.byModel)).toHaveLength(2)
		expect(snapshot.totals.inputTokens).toBe(1400)
		expect(snapshot.totals.outputTokens).toBe(650)
	})

	test('cost estimation with pricing lookup', () => {
		const pricing = {
			'anthropic/claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		}
		const acc = new TokenUsageAccumulator((key) => pricing[key as keyof typeof pricing])
		acc.add('anthropic/claude-sonnet', {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 500_000,
			cacheWriteTokens: 50_000,
			reasoningTokens: 0,
		})
		const snapshot = acc.snapshot()
		// Inclusive input splits into 450k uncached, 500k read, and 50k write tokens.
		expect(snapshot.byModel['anthropic/claude-sonnet']!.estimatedCostUsd).toBeCloseTo(3.1875)
		expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(3.1875)
	})

	test.each([
		['read-only', 1_000_000, 400_000, 0, 2.92],
		['write-only', 1_000_000, 0, 400_000, 4.3],
		['mixed', 1_000_000, 300_000, 200_000, 3.34],
	] as const)(
		'uses catalog rates for %s cache input',
		(_name, inputTokens, cacheReadTokens, cacheWriteTokens, cost) => {
			const acc = new TokenUsageAccumulator(() => ({ input: 3, output: 10, cacheRead: 0.3, cacheWrite: 3.75 }))
			acc.add('provider/model', {
				inputTokens,
				outputTokens: 100_000,
				cacheReadTokens,
				cacheWriteTokens,
				reasoningTokens: 0,
			})
			expect(acc.snapshot().byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(cost)
		},
	)

	test('falls back to the input rate when the catalog omits cache rates', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 2, output: 8 }))
		acc.add('provider/model', {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 300_000,
			cacheWriteTokens: 200_000,
			reasoningTokens: 0,
		})
		expect(acc.snapshot().byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(2.8)
	})

	test('clamps uncached input when provider cache counts exceed total input', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 3, output: 10, cacheRead: 0.3, cacheWrite: 3.75 }))
		acc.add('provider/model', {
			inputTokens: 100_000,
			outputTokens: 0,
			cacheReadTokens: 80_000,
			cacheWriteTokens: 70_000,
			reasoningTokens: 0,
		})
		const pricedCacheReadTokens = 80_000
		const pricedCacheWriteTokens = 20_000
		const pricedUncachedTokens = 0
		expect(pricedCacheReadTokens + pricedCacheWriteTokens + pricedUncachedTokens).toBe(100_000)
		expect(acc.snapshot().byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(0.099)
	})

	test('prefers the provider-reported uncached figure and reconciles the cache counters around it', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 10, output: 0, cacheRead: 1, cacheWrite: 12.5 }))
		// A breakdown that does NOT perfectly telescope (total − read = 200k, but
		// the provider says 250k uncached — e.g. cache-block rounding). The
		// provider's uncached figure wins, and cacheRead is capped to the
		// remainder so the priced categories PARTITION the 1M prompt — billing
		// 1.05M category-tokens for a 1M prompt would overcharge.
		acc.add('provider/model', {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 800_000,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 250_000,
		})
		// reported: 250k × $10/M + min(800k, 750k) × $1/M = 3.25. Derived would be 2.80.
		expect(acc.snapshot().byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(3.25)
	})

	test('clamps a pathological provider uncached figure to the prompt total', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 10, output: 0, cacheRead: 1 }))
		// A cumulative/garbage noCache far above the prompt: cap at inputTokens
		// so it cannot bill more prompt than existed.
		acc.add('provider/model', {
			inputTokens: 100_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 5_000_000,
		})
		expect(acc.snapshot().byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(1.0)
	})

	test('one call without noCacheInputTokens poisons the model sum to undefined and costing falls back', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 10, output: 0, cacheRead: 1 }))
		acc.add('provider/model', {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 800_000,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 200_000,
		})
		acc.add('provider/model', {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 800_000,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			// no noCacheInputTokens — a partial sum would misrepresent the run
		})
		const snapshot = acc.snapshot()
		expect(snapshot.byModel['provider/model']!.noCacheInputTokens).toBeUndefined()
		expect(snapshot.totals.noCacheInputTokens).toBeUndefined()
		// Derived: (2M − 1.6M) × $10/M + 1.6M × $1/M = 5.60
		expect(snapshot.byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(5.6)
	})

	test('sums noCacheInputTokens across calls and models when every call reports it', () => {
		const acc = new TokenUsageAccumulator()
		acc.add('provider/a', {
			inputTokens: 1000,
			outputTokens: 0,
			cacheReadTokens: 700,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 300,
		})
		acc.add('provider/a', {
			inputTokens: 500,
			outputTokens: 0,
			cacheReadTokens: 400,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 100,
		})
		acc.add('provider/b', {
			inputTokens: 200,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 200,
		})
		const snapshot = acc.snapshot()
		expect(snapshot.byModel['provider/a']!.noCacheInputTokens).toBe(400)
		expect(snapshot.byModel['provider/b']!.noCacheInputTokens).toBe(200)
		expect(snapshot.totals.noCacheInputTokens).toBe(600)
	})

	test('falls back to derivation when noCache is reported without any cache counters', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 10, output: 0, cacheRead: 1 }))
		// noCache 250k on a 1M prompt with NO cache counters: trusting it would
		// price the 750k cached remainder at $0. Derivation bills the full input
		// (matching pre-noCache behavior); the published figure is poisoned.
		acc.add('provider/model', {
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 250_000,
		})
		const snapshot = acc.snapshot()
		expect(snapshot.byModel['provider/model']!.estimatedCostUsd).toBeCloseTo(10.0)
		expect(snapshot.byModel['provider/model']!.noCacheInputTokens).toBeUndefined()
	})

	test('publishes the reconciled noCache figure, never the raw pathological report', () => {
		const acc = new TokenUsageAccumulator(() => ({ input: 10, output: 0, cacheRead: 1 }))
		acc.add('provider/model', {
			inputTokens: 100_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			noCacheInputTokens: 5_000_000,
		})
		const snapshot = acc.snapshot()
		// Billed from the clamped figure, and the EXPORTED figure matches it —
		// a consumer deriving cached = input - noCache must never go negative.
		expect(snapshot.byModel['provider/model']!.noCacheInputTokens).toBe(100_000)
		expect(snapshot.totals.noCacheInputTokens).toBe(100_000)
	})

	test('unknown model has undefined cost', () => {
		const acc = new TokenUsageAccumulator(() => undefined)
		acc.add('unknown/model', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		})
		const snapshot = acc.snapshot()
		expect(snapshot.byModel['unknown/model']!.estimatedCostUsd).toBeUndefined()
		expect(snapshot.totals.estimatedCostUsd).toBeUndefined()
	})
})

describe('extractUsage', () => {
	test('extracts all fields from LanguageModelUsage', () => {
		const usage = extractUsage({
			inputTokens: 1000,
			outputTokens: 500,
			totalTokens: 1500,
			inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 150, cacheWriteTokens: 50 },
			outputTokenDetails: { textTokens: 450, reasoningTokens: 50 },
		})
		expect(usage.inputTokens).toBe(1000)
		expect(usage.outputTokens).toBe(500)
		expect(usage.cacheReadTokens).toBe(150)
		expect(usage.cacheWriteTokens).toBe(50)
		expect(usage.reasoningTokens).toBe(50)
		expect(usage.noCacheInputTokens).toBe(800)
	})

	test('treats a negative noCacheTokens report as absent, not as zero', () => {
		const usage = extractUsage({
			inputTokens: 1000,
			outputTokens: 500,
			totalTokens: 1500,
			inputTokenDetails: { noCacheTokens: -1, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
		})
		// Clamping garbage to 0 would bill the whole prompt at $0 downstream.
		expect(usage.noCacheInputTokens).toBeUndefined()
	})

	test('keeps noCacheInputTokens undefined when the provider omits it — absence is meaningful', () => {
		const usage = extractUsage({
			inputTokens: 1000,
			outputTokens: 500,
			totalTokens: 1500,
			inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 150, cacheWriteTokens: 50 },
			outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
		})
		expect(usage.noCacheInputTokens).toBeUndefined()
	})

	test('handles undefined detail fields gracefully', () => {
		const usage = extractUsage({
			inputTokens: 1000,
			outputTokens: 500,
			totalTokens: 1500,
			inputTokenDetails: {
				noCacheTokens: undefined,
				cacheReadTokens: undefined,
				cacheWriteTokens: undefined,
			},
			outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
		})
		expect(usage.cacheReadTokens).toBe(0)
		expect(usage.reasoningTokens).toBe(0)
	})
})

describe('getModelKey', () => {
	test('formats model object as provider/modelId', () => {
		expect(getModelKey({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' } as any)).toBe(
			'anthropic/claude-sonnet-4-20250514',
		)
	})

	test('passes strings through', () => {
		expect(getModelKey('custom-model')).toBe('custom-model')
	})
})
