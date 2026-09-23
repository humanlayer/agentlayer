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

	test.each(['gpt-6-sol', 'gpt-6-luna'] as const)(
		'codex/%s uses the effective Codex window while retaining public output metadata',
		(modelId) => {
			const limits = provider.getModelLimits(`codex/${modelId}`)

			expect(limits?.context).toBe(258_400)
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
			input: 4,
			output: 20,
		})

		// The public Responses API, not the private Codex one, so it keeps the public window.
		expect(provider.getModelLimits(`${CUSTOM_RESPONSES_PROVIDER}/gpt-5.6-sol`)?.context).toBe(1_050_000)
	})

	test('openai/gpt-5.6 keeps the public OpenAI API context window and pricing', () => {
		const limits = provider.getModelLimits('openai/gpt-5.6-sol')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
		expect(provider.getModelPricing('openai/gpt-5.6-sol')).toMatchObject({ input: 4, output: 20 })
		expect(provider.getModelPricing('openai/gpt-5.6-terra')).toMatchObject({ input: 2, output: 12 })
		expect(provider.getModelPricing('openai/gpt-5.6-luna')).toMatchObject({ input: 0.2, output: 1.2 })
	})

	test('openai/gpt-6-astra keeps the public OpenAI API context window and pricing', () => {
		const limits = provider.getModelLimits('openai/gpt-6-astra')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
		expect(provider.getModelPricing('openai/gpt-6-astra')).toMatchObject({ input: 10, output: 50 })
	})

	test.each([
		['gpt-6-sol', 2, 10],
		['gpt-6-luna', 0.1, 0.5],
	] as const)('%s keeps its public OpenAI limits and pricing', (modelId, input, output) => {
		expect(provider.getModelLimits(`openai/${modelId}`)).toMatchObject({
			context: 1_050_000,
			input: 922_000,
			output: 128_000,
		})
		expect(provider.getModelPricing(`openai/${modelId}`)).toMatchObject({ input, output })
	})

	test('claude-opus-5-5 exposes public Anthropic limits and pricing', () => {
		expect(provider.getModelLimits('anthropic/claude-opus-5-5')).toMatchObject({
			context: 1_000_000,
			output: 128_000,
		})
		expect(provider.getModelPricing('anthropic/claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
	})
})
