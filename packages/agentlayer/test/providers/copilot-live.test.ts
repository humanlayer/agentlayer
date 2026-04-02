/**
 * Live integration tests for copilotProvider().
 *
 * Requires a valid GitHub Copilot auth token — run:
 *   bun run apps/agent-sdk/src/bin/cli.ts auth copilot
 *
 * Then run:
 *   cd apps/agent-sdk && bun test test/providers/copilot-live.test.ts
 *
 * Supported models from https://docs.github.com/en/copilot/reference/ai-models/supported-models
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { generateText } from 'ai'
import { createAuthStore, DEFAULT_AUTH_PATH } from '../../src/providers/auth'
import { copilotProvider } from '../../src/providers/copilot'

// Read credentials from the real store but never modify it
const realStore = createAuthStore(DEFAULT_AUTH_PATH)

let hasCredentials = false
beforeAll(async () => {
	const auth = await realStore.readAuth('github-copilot')
	hasCredentials = !!auth && auth.type === 'oauth'
	if (!hasCredentials) {
		console.warn(
			'Skipping copilot-live tests: no credentials. Run `bun run apps/agent-sdk/src/bin/cli.ts auth copilot` first.',
		)
	}
})

// Supported models as documented at:
// https://docs.github.com/en/copilot/reference/ai-models/supported-models
const SUPPORTED_MODELS = {
	openai: [
		'gpt-4.1',
		'gpt-5-mini',
		'gpt-5.1',
		'gpt-5.1-codex',
		'gpt-5.1-codex-max',
		'gpt-5.1-codex-mini',
		'gpt-5.2',
		'gpt-5.2-codex',
		'gpt-5.3-codex',
		'gpt-5.4',
		'gpt-5.4-mini',
	],
	anthropic: [
		'claude-haiku-4.5',
		'claude-opus-4.5',
		'claude-opus-4.6',
		'claude-sonnet-4',
		'claude-sonnet-4.5',
		'claude-sonnet-4.6',
	],
	google: ['gemini-2.5-pro', 'gemini-3-flash', 'gemini-3.1-pro'],
	xai: ['grok-code-fast-1'],
} as const

// Models to actually test — pick a fast/cheap one from each provider
const MODELS_TO_TEST = ['gpt-4.1', 'claude-sonnet-4', 'gemini-2.5-pro'] as const

describe('copilotProvider — live integration', () => {
	// Use real store read-only for auth lookups
	const provider = copilotProvider({ authStore: realStore })

	test('provider is callable and returns models', () => {
		if (!hasCredentials) return
		const model = provider('gpt-4.1')
		expect(model).toBeDefined()
		expect(model.modelId).toBe('gpt-4.1')
		expect(model.provider).toContain('github-copilot')
	})

	test('all documented models can be instantiated', () => {
		if (!hasCredentials) return
		const allModels = [
			...SUPPORTED_MODELS.openai,
			...SUPPORTED_MODELS.anthropic,
			...SUPPORTED_MODELS.google,
			...SUPPORTED_MODELS.xai,
		]
		for (const modelId of allModels) {
			const model = provider(modelId)
			expect(model.modelId).toBe(modelId)
		}
	})

	for (const modelId of MODELS_TO_TEST) {
		test(
			`generateText with ${modelId}`,
			async () => {
				if (!hasCredentials) return

				const result = await generateText({
					model: provider(modelId),
					prompt: 'Respond with exactly: hello',
					maxOutputTokens: 256,
				})

				expect(result.text).toBeDefined()
				expect(result.text.length).toBeGreaterThan(0)
				expect(result.text.toLowerCase()).toContain('hello')
			},
			{ timeout: 30_000 },
		)
	}
})
