import { describe, expect, it, mock } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { CODEX_API_ENDPOINT, CODEX_PROVIDER_ID, createCodexResponsesProvider } from '../src'

describe('createCodexResponsesProvider', () => {
	it('returns a ProviderV3 with languageModel method', () => {
		const authStore = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
		})
		const provider = createCodexResponsesProvider({ authStore })

		expect(provider.specificationVersion).toBe('v3')
		expect(typeof provider.languageModel).toBe('function')
	})

	it('languageModel returns a model from upstream @ai-sdk/openai', () => {
		const authStore = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
		})
		const provider = createCodexResponsesProvider({ authStore })

		const model = provider.languageModel('gpt-5.5')

		expect(model).toBeDefined()
		expect(model.modelId).toBe('gpt-5.5')
	})

	it('languageModel reports a codex-prefixed provider for registry discovery', () => {
		const authStore = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
		})
		const provider = createCodexResponsesProvider({ authStore })

		const model = provider.languageModel('gpt-5.5')

		expect(model.provider).toBe('codex.responses')
	})

	describe('custom fetch wrapper', () => {
		it('rewrites URL to CODEX_API_ENDPOINT for /v1/responses', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			expect(capturedRequests.length).toBeGreaterThan(0)
			expect(capturedRequests[0]!.url).toBe(CODEX_API_ENDPOINT)
		})

		it('sets authorization header with Bearer token for API auth', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'my-api-key' },
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			const headers = new Headers(capturedRequests[0]!.init?.headers)
			expect(headers.get('authorization')).toBe('Bearer my-api-key')
		})

		it('sets ChatGPT-Account-Id header for OAuth auth with accountId', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: {
					kind: 'oauth',
					accessToken: 'oauth-token',
					accountId: 'account-123',
				},
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			const headers = new Headers(capturedRequests[0]!.init?.headers)
			expect(headers.get('ChatGPT-Account-Id')).toBe('account-123')
		})

		it('forces store=false and include defaults in request body', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			const body = JSON.parse(capturedRequests[0]!.init?.body as string)
			expect(body.store).toBe(false)
			expect(body.include).toEqual(['reasoning.encrypted_content'])
		})

		it('strips id fields from input items', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			const body = JSON.parse(capturedRequests[0]!.init?.body as string)
			for (const item of body.input) {
				expect(item.id).toBeUndefined()
			}
		})

		it('applies fastMode as service_tier=priority', async () => {
			const capturedRequests: { url: string; init?: RequestInit }[] = []
			const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
				capturedRequests.push({ url: url.toString(), init })
				return new Response(JSON.stringify({ error: 'test' }), { status: 400 })
			})

			const authStore = createMemoryAuthStore({
				[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-key' },
			})
			const provider = createCodexResponsesProvider({ authStore, fetch: mockFetch, fastMode: true })
			const model = provider.languageModel('gpt-5.5')

			try {
				await model.doGenerate({
					prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				})
			} catch {
				// Expected to fail
			}

			const body = JSON.parse(capturedRequests[0]!.init?.body as string)
			expect(body.service_tier).toBe('priority')
		})
	})
})
