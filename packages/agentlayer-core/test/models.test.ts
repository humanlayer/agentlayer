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
})
