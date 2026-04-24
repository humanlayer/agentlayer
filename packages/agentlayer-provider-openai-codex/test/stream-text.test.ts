import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { streamText } from 'ai'
import { createCodexProvider } from '../src'

describe.skipIf(
	!process.env.OPENAI_CODEX_ACCESS_TOKEN ||
		!process.env.OPENAI_CODEX_REFRESH_TOKEN ||
		!process.env.OPENAI_CODEX_ACCOUNT_ID,
)('StreamText should work', async () => {
	const authStore = createMemoryAuthStore({
		codex: {
			kind: 'oauth',
			accessToken: process.env.OPENAI_CODEX_ACCESS_TOKEN!,
			refreshToken: process.env.OPENAI_CODEX_REFRESH_TOKEN,
			expiresAt: Date.now() + 60 * 60 * 1000,
			accountId: process.env.OPENAI_CODEX_ACCOUNT_ID,
		},
		// or:
		// codex: { kind: 'api', apiKey: process.env.OPENAI_API_KEY! },
	})

	const codex = createCodexProvider({
		authStore,
		version: '0.0.0-dev',
		sessionId: 'local-test-session',
	})

	test(
		'Basic Streaming',
		async () => {
			const result = streamText({
				model: codex.languageModel('gpt-5.4'),
				providerOptions: {
					openai: {
						reasoningEffort: 'high',
						reasoningSummary: 'auto',
						include: ['reasoning.encrypted_content'],
					},
				},
				system: 'Think hard before answering',
				prompt: 'Think hard about `this` in an arrow function inside a class in JS and tell me what this will refer to.',
			})

			for await (const chunk of result.fullStream) {
				process.stdout.write(JSON.stringify(chunk) + '\n')
			}

			expect((await result.reasoning).at(0)!.text).toBeString()

			console.log('\n\nreasoning\n----\n')
			console.log(await result.reasoning)
			console.log('\n\ntext\n----\n')
			console.log(await result.text)
		},
		{ timeout: 20_000 },
	)
})
