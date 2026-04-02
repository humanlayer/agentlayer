import { beforeAll, describe, expect, test } from 'bun:test'
import { getModelLimits, getModelPricing, initModelsCache } from '../src/models/models-dev'

beforeAll(async () => {
	await initModelsCache()
})

describe('initModelsCache', () => {
	test('loads snapshot data without throwing', async () => {
		// Already called in beforeAll — just verify it's idempotent
		await initModelsCache()
	})
})

describe('getModelPricing', () => {
	test('anthropic/claude-sonnet-4-20250514 — exact key match', () => {
		const pricing = getModelPricing('anthropic/claude-sonnet-4-20250514')
		expect(pricing).toBeDefined()
		expect(pricing!.input).toBe(3)
		expect(pricing!.output).toBe(15)
		expect(pricing!.cacheRead).toBe(0.3)
		expect(pricing!.cacheWrite).toBe(3.75)
	})

	test('openai/gpt-4o — exact key match, different provider', () => {
		const pricing = getModelPricing('openai/gpt-4o')
		expect(pricing).toBeDefined()
		expect(pricing!.input).toBe(2.5)
		expect(pricing!.output).toBe(10)
		expect(pricing!.cacheRead).toBe(1.25)
	})

	test('anthropic/claude-sonnet-4-6 — exact key match', () => {
		const pricing = getModelPricing('anthropic/claude-sonnet-4-6')
		expect(pricing).toBeDefined()
		expect(pricing!.input).toBe(3)
	})

	test('substring match — modelId contains a snapshot key', () => {
		// "gpt-4o-2024-11-20" is a snapshot key; querying with it directly should match
		const pricing = getModelPricing('openai/gpt-4o-2024-11-20')
		expect(pricing).toBeDefined()
		expect(pricing!.input).toBe(2.5)
	})

	test('model with no cost field returns undefined', () => {
		// qiniu-ai/claude-4.5-haiku has limit but no cost
		const pricing = getModelPricing('qiniu-ai/claude-4.5-haiku')
		expect(pricing).toBeUndefined()
	})

	test('unknown model under known provider returns undefined', () => {
		expect(getModelPricing('anthropic/totally-fake-model-9000')).toBeUndefined()
	})

	test('unknown provider returns undefined', () => {
		expect(getModelPricing('fakeprovider/some-model')).toBeUndefined()
	})

	test('key without slash returns undefined', () => {
		expect(getModelPricing('no-slash-here')).toBeUndefined()
	})

	test('empty string returns undefined', () => {
		expect(getModelPricing('')).toBeUndefined()
	})
})

describe('getModelLimits', () => {
	test('anthropic/claude-sonnet-4-20250514 — returns context and output limits', () => {
		const limits = getModelLimits('anthropic/claude-sonnet-4-20250514')
		expect(limits).toBeDefined()
		expect(limits!.context).toBe(200000)
		expect(limits!.output).toBe(64000)
	})

	test('openai/gpt-4o — different provider limits', () => {
		const limits = getModelLimits('openai/gpt-4o')
		expect(limits).toBeDefined()
		expect(limits!.context).toBe(128000)
		expect(limits!.output).toBe(16384)
	})

	test('model with zero context returns undefined (limit incomplete)', () => {
		// Models with context: 0 should return undefined since 0 is falsy in the check
		const limits = getModelLimits('nano-gpt/qwen-image')
		expect(limits).toBeUndefined()
	})

	test('unknown model returns undefined', () => {
		expect(getModelLimits('nonexistent/model-xyz')).toBeUndefined()
	})

	test('unknown provider returns undefined', () => {
		expect(getModelLimits('fakeprovider/some-model')).toBeUndefined()
	})
})
