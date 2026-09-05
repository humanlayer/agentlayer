import { describe, expect, test } from 'bun:test'
import { CODEX_CONTEXT_WINDOWS, type ModelKey, ModelProvider } from '../src/models'

describe('ModelProvider.getModelLimits', () => {
	const provider = new ModelProvider()

	test.each(['codex/gpt-5.5', 'codex-sse-vendor/gpt-5.5', 'codex.responses/gpt-5.5'] satisfies ModelKey[])(
		'%s resolves to the private Codex API context window',
		(modelKey) => {
			const limits = provider.getModelLimits(modelKey)

			expect(limits?.context).toBe(CODEX_CONTEXT_WINDOWS['gpt-5.5'])
			expect(limits?.output).toBe(128_000)
		},
	)

	test.each([
		['codex/gpt-5.6-sol', 'gpt-5.6-sol'],
		['codex.responses/gpt-5.6-terra', 'gpt-5.6-terra'],
		['codex-sse-vendor/gpt-5.6-luna', 'gpt-5.6-luna'],
	] satisfies [ModelKey, keyof typeof CODEX_CONTEXT_WINDOWS][])(
		'%s resolves to the expanded Codex window',
		(modelKey, modelId) => {
			const limits = provider.getModelLimits(modelKey)

			expect(limits?.context).toBe(CODEX_CONTEXT_WINDOWS[modelId])
			expect(limits?.output).toBe(128_000)
		},
	)

	test('codex/gpt-6-astra uses the Codex app window instead of the public API window', () => {
		const limits = provider.getModelLimits('codex/gpt-6-astra')

		expect(limits?.context).toBe(258_400)
		expect(limits?.output).toBe(128_000)
	})

	test('openai/gpt-5.5 keeps the public OpenAI API context window', () => {
		const limits = provider.getModelLimits('openai/gpt-5.5')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
	})

	test('openai/gpt-5.6 keeps the public OpenAI API context window and pricing', () => {
		const limits = provider.getModelLimits('openai/gpt-5.6-sol')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
		expect(provider.getModelPricing('openai/gpt-5.6-sol')).toMatchObject({ input: 5, output: 30 })
		expect(provider.getModelPricing('openai/gpt-5.6-terra')).toMatchObject({ input: 2.5, output: 15 })
		expect(provider.getModelPricing('openai/gpt-5.6-luna')).toMatchObject({ input: 1, output: 6 })
	})

	test('openai/gpt-6-astra keeps the public OpenAI API context window and pricing', () => {
		const limits = provider.getModelLimits('openai/gpt-6-astra')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
		expect(provider.getModelPricing('openai/gpt-6-astra')).toMatchObject({ input: 10, output: 50 })
	})
})
