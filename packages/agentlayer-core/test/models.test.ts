import { describe, expect, test } from 'bun:test'
import { CODEX_CONTEXT_WINDOWS, CUSTOM_RESPONSES_PROVIDER, type ModelKey, ModelProvider } from '../src/models'

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
		'%s resolves to the GPT-5.6 Codex window',
		(modelKey, modelId) => {
			const limits = provider.getModelLimits(modelKey)

			expect(limits?.context).toBe(CODEX_CONTEXT_WINDOWS[modelId])
			expect(limits?.output).toBe(128_000)
		},
	)

	test('openai/gpt-5.5 keeps the public OpenAI API context window', () => {
		const limits = provider.getModelLimits('openai/gpt-5.5')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
	})

	test('a custom Responses endpoint is priced as the OpenAI model it serves', () => {
		// Regression: this key used to miss the catalog entirely, and a pricing miss is
		// reported as `undefined`, so Azure AI Foundry sessions recorded tokens and no
		// dollars at all — silently, and unrecoverably, since cost is frozen at ingest.
		expect(provider.getModelPricing(`${CUSTOM_RESPONSES_PROVIDER}/gpt-5.6-sol`)).toMatchObject({
			input: 5,
			output: 30,
		})

		// The public Responses API, not the private Codex one, so it keeps the public window.
		expect(provider.getModelLimits(`${CUSTOM_RESPONSES_PROVIDER}/gpt-5.6-sol`)?.context).toBe(1_050_000)
	})

	test('openai/gpt-5.6 keeps the public OpenAI API context window and pricing', () => {
		const limits = provider.getModelLimits('openai/gpt-5.6-sol')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
		expect(provider.getModelPricing('openai/gpt-5.6-sol')).toMatchObject({ input: 5, output: 30 })
		expect(provider.getModelPricing('openai/gpt-5.6-terra')).toMatchObject({ input: 2.5, output: 15 })
		expect(provider.getModelPricing('openai/gpt-5.6-luna')).toMatchObject({ input: 1, output: 6 })
	})
})
