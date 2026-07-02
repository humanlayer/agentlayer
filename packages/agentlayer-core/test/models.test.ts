import { describe, expect, test } from 'bun:test'
import { type ModelKey, ModelProvider, PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT } from '../src/models'

describe('ModelProvider.getModelLimits', () => {
	const provider = new ModelProvider()

	test.each(['codex/gpt-5.5', 'codex-sse-vendor/gpt-5.5', 'codex.responses/gpt-5.5'] satisfies ModelKey[])(
		'%s resolves to the private Codex API context window',
		(modelKey) => {
			const limits = provider.getModelLimits(modelKey)

			expect(limits?.context).toBe(PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT)
			expect(limits?.output).toBe(128_000)
		},
	)

	test('openai/gpt-5.5 keeps the public OpenAI API context window', () => {
		const limits = provider.getModelLimits('openai/gpt-5.5')

		expect(limits?.context).toBe(1_050_000)
		expect(limits?.output).toBe(128_000)
	})

	test('anthropic/claude-sonnet-5 exposes 1M context and 128k output metadata', () => {
		const info = provider.getModelInfo('anthropic/claude-sonnet-5')
		const limits = provider.getModelLimits('anthropic/claude-sonnet-5')
		const pricing = provider.getModelPricing('anthropic/claude-sonnet-5')

		expect(info?.reasoning).toBe(true)
		expect(info?.tool_call).toBe(true)
		expect(info?.temperature).toBe(false)
		expect(info?.modalities?.input).toEqual(['text', 'image', 'pdf'])
		expect(info?.modalities?.output).toEqual(['text'])
		expect(limits).toEqual({ context: 1_000_000, output: 128_000 })
		expect(pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
	})
})
