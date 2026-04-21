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
		// input: 1M * 3/1M = 3.0, output: 100k * 15/1M = 1.5, cacheRead: 500k * 0.3/1M = 0.15, cacheWrite: 50k * 3.75/1M = 0.1875
		expect(snapshot.byModel['anthropic/claude-sonnet']!.estimatedCostUsd).toBeCloseTo(4.8375)
		expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(4.8375)
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
