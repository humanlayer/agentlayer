import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { buildProviderOptions } from '../src/agent'
import {
	captureResponseUsage,
	createCustomCodexResponsesModel,
	readCodexResponsesOverride,
	resolveModel,
	type CodexResponsesOverride,
} from '../src/providers'

const TEST_KEY = 'phase-one-test-key'
const overrideEnvironmentNames = [
	'CODELAYER_CODEX_BASE_URL',
	'CODELAYER_CODEX_API_KEY',
	'CODELAYER_CODEX_API_KEY_HEADER',
	'CODELAYER_CODEX_MODEL',
] as const
const originalOverrideEnvironment = Object.fromEntries(
	overrideEnvironmentNames.map((name) => [name, process.env[name]]),
) as Record<(typeof overrideEnvironmentNames)[number], string | undefined>

afterEach(() => {
	mock.restore()
	for (const name of overrideEnvironmentNames) {
		const value = originalOverrideEnvironment[name]
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
})

function override(values: Partial<CodexResponsesOverride> = {}): CodexResponsesOverride {
	return {
		baseURL: 'https://example.test/openai/v1',
		endpointURL: 'https://example.test/openai/v1/responses',
		apiKey: TEST_KEY,
		...values,
	}
}

async function captureGenerateRequest(options: {
	override?: Partial<CodexResponsesOverride>
	selectedModelId?: string
	abortSignal?: AbortSignal
} = {}) {
	const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
	const fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ input, init })
		return new Response(JSON.stringify({ error: { message: 'captured request' } }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		})
	})
	const model = createCustomCodexResponsesModel({
		override: override(options.override),
		selectedModelId: options.selectedModelId ?? 'gpt-5.6-sol',
		fetch,
	}) as LanguageModelV3

	try {
		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
			abortSignal: options.abortSignal,
		})
	} catch {
		// The fake endpoint returns 400 after the request has been captured.
	}

	expect(requests).toHaveLength(1)
	return { model, request: requests[0]! }
}

function errorMessage(run: () => unknown): string {
	try {
		run()
		throw new Error('Expected function to throw')
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

function responsesPayload(id: string, cacheRead: number, cacheWrite: number) {
	return {
		id,
		object: 'response',
		created_at: 1,
		model: 'wire-model',
		status: 'completed',
		output: [],
		parallel_tool_calls: true,
		tool_choice: 'auto',
		tools: [],
		usage: {
			input_tokens: 100,
			input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
			output_tokens: 10,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 110,
		},
	}
}

function sseResponse(payload: ReturnType<typeof responsesPayload>, delayMs = 0): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			if (delayMs > 0) await Bun.sleep(delayMs)
			controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`))
			controller.enqueue(encoder.encode('data: [DONE]\n\n'))
			controller.close()
		},
	})
	return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function cacheUsageEvent(cacheWrite: unknown): string {
	return JSON.stringify({
		type: 'response.completed',
		response: { usage: { input_tokens_details: { cache_write_tokens: cacheWrite } } },
	})
}

function chunkedSseResponse(bytes: Uint8Array, chunkSizes: number[], init?: ResponseInit): Response {
	let offset = 0
	return new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			for (const size of chunkSizes) {
				controller.enqueue(bytes.slice(offset, offset + size))
				offset += size
			}
			if (offset < bytes.length) controller.enqueue(bytes.slice(offset))
			controller.close()
		},
	}), {
		...init,
		headers: { 'content-type': 'text/event-stream', ...init?.headers },
	})
}

describe('captureResponseUsage SSE parsing', () => {
	test.each(['\n', '\r\n', '\r'] as const)('accepts %j lines split across byte chunks', async (newline) => {
		const source = new TextEncoder().encode(`data: ${cacheUsageEvent(23)}${newline}${newline}`)
		const usage = {}
		const response = await captureResponseUsage(
			chunkedSseResponse(source, Array.from({ length: source.length }, () => 1)),
			usage,
		)

		expect(new Uint8Array(await response.arrayBuffer())).toEqual(source)
		expect(usage).toEqual({ cacheWriteTokens: 23 })
	})

	test('joins multiline data and accepts blank lines with mixed endings', async () => {
		const event = cacheUsageEvent(31)
		const split = event.indexOf('"response"')
		const source = new TextEncoder().encode(`data: ${event.slice(0, split)}\r\ndata: ${event.slice(split)}\r\n\r`)
		const usage = {}
		const response = await captureResponseUsage(chunkedSseResponse(source, [7, split + 1, 1, 1]), usage)

		await response.arrayBuffer()
		expect(usage).toEqual({ cacheWriteTokens: 31 })
	})

	test('ignores malformed cache write counts', async () => {
		const source = new TextEncoder().encode(`data: ${cacheUsageEvent('many')}\n\n`)
		const usage = {}
		const response = await captureResponseUsage(chunkedSseResponse(source, [source.length - 1, 1]), usage)

		await response.arrayBuffer()
		expect(usage).toEqual({})
	})

	test('captures a final event without a blank line', async () => {
		const source = new TextEncoder().encode(`data: ${cacheUsageEvent(47)}`)
		const usage = {}
		const response = await captureResponseUsage(chunkedSseResponse(source, [2, source.length - 3]), usage)

		await response.arrayBuffer()
		expect(usage).toEqual({ cacheWriteTokens: 47 })
	})

	test('preserves response bytes, status, status text, and headers', async () => {
		const source = new TextEncoder().encode(`: keep this exactly\r\ndata: ${cacheUsageEvent(5)}\r\n\r\n`)
		const usage = {}
		const response = await captureResponseUsage(chunkedSseResponse(source, [1, 2, 3, 5, 8], {
			status: 206,
			statusText: 'Partial Content',
			headers: { 'x-request-id': 'request-123' },
		}), usage)

		expect(response.status).toBe(206)
		expect(response.statusText).toBe('Partial Content')
		expect(response.headers.get('x-request-id')).toBe('request-123')
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(source)
	})
})

describe('readCodexResponsesOverride', () => {
	test('returns no override only when all override settings are absent', () => {
		expect(readCodexResponsesOverride({})).toBeUndefined()
	})

	test('rejects optional settings without the required pair', () => {
		for (const env of [
			{ CODELAYER_CODEX_MODEL: 'wire-model' },
			{ CODELAYER_CODEX_API_KEY_HEADER: 'api-key' },
		]) {
			const message = errorMessage(() => readCodexResponsesOverride(env))
			expect(message).toContain('CODELAYER_CODEX_BASE_URL')
		}
	})

	test('rejects either partial setup and names only the missing setting', () => {
		const missingKey = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1?secret=url-secret',
			}),
		)
		expect(missingKey).toContain('CODELAYER_CODEX_API_KEY')
		expect(missingKey).not.toContain('url-secret')

		const missingURL = errorMessage(() =>
			readCodexResponsesOverride({ CODELAYER_CODEX_API_KEY: TEST_KEY }),
		)
		expect(missingURL).toContain('CODELAYER_CODEX_BASE_URL')
		expect(missingURL).not.toContain(TEST_KEY)
	})

	test('normalizes API bases, full endpoints, and trailing slashes', () => {
		for (const baseURL of [
			'https://example.test/openai/v1',
			'https://example.test/openai/v1/',
			'https://example.test/openai/v1/responses',
			'https://example.test/openai/v1/responses/',
		]) {
			const result = readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: baseURL,
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			})

			expect(result?.baseURL).toBe('https://example.test/openai/v1')
			expect(result?.endpointURL).toBe('https://example.test/openai/v1/responses')
		}
	})

	test('allows HTTP on loopback hosts', () => {
		for (const baseURL of [
			'http://localhost:8000/v1',
			'http://api.localhost:8000/v1',
			'http://127.20.30.40:8000/v1',
			'http://[::1]:8000/v1',
		]) {
			expect(
				readCodexResponsesOverride({
					CODELAYER_CODEX_BASE_URL: baseURL,
					CODELAYER_CODEX_API_KEY: TEST_KEY,
				}),
			).toBeDefined()
		}
	})

	test('rejects remote HTTP without including the URL or key', () => {
		const message = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'http://example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)

		expect(message).toContain('CODELAYER_CODEX_BASE_URL')
		expect(message).not.toContain('example.test')
		expect(message).not.toContain('url-query-secret')
		expect(message).not.toContain(TEST_KEY)
	})

	test('rejects URL credentials without including auth values or query text', () => {
		const message = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL:
					'https://url-user:url-password@example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)

		expect(message).toContain('CODELAYER_CODEX_BASE_URL')
		for (const secret of ['url-user', 'url-password', 'url-query-secret', TEST_KEY]) {
			expect(message).not.toContain(secret)
		}
	})

	test('rejects query strings and invalid header names without exposing values', () => {
		const queryMessage = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1?token=url-query-secret',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
			}),
		)
		expect(queryMessage).toContain('CODELAYER_CODEX_BASE_URL')
		expect(queryMessage).not.toContain('url-query-secret')
		expect(queryMessage).not.toContain(TEST_KEY)

		const headerMessage = errorMessage(() =>
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
				CODELAYER_CODEX_API_KEY_HEADER: 'invalid header',
			}),
		)
		expect(headerMessage).toContain('CODELAYER_CODEX_API_KEY_HEADER')
		expect(headerMessage).not.toContain(TEST_KEY)
	})

	test('keeps custom header and wire model values', () => {
		expect(
			readCodexResponsesOverride({
				CODELAYER_CODEX_BASE_URL: 'https://example.test/openai/v1',
				CODELAYER_CODEX_API_KEY: TEST_KEY,
				CODELAYER_CODEX_API_KEY_HEADER: 'api-key',
				CODELAYER_CODEX_MODEL: 'azure-coding-deployment',
			}),
		).toMatchObject({
			apiKeyHeader: 'api-key',
			wireModelId: 'azure-coding-deployment',
		})
	})

})

describe('createCustomCodexResponsesModel', () => {
	test('uses dynamic Bedrock auth, the wire model, and retries auth failure once', async () => {
		const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
		const tokens = ['expired-bedrock-token', 'fresh-bedrock-token']
		let invalidations = 0
		const model = createCustomCodexResponsesModel({
			override: {
				baseURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
				endpointURL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses',
				wireModelId: 'openai.gpt-5.6-sol',
				auth: {
					type: 'bedrock',
					auth: {
						async getToken() { return tokens.shift()! },
						invalidate() { invalidations++ },
					},
				},
			},
			selectedModelId: 'gpt-5.6-sol',
			fetch: mock(async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init)
				requests.push({
					headers: request.headers,
					body: JSON.parse(await request.text()),
				})
				return requests.length === 1
					? new Response('', { status: 401 })
					: new Response(JSON.stringify({ error: { message: 'captured' } }), {
						status: 400,
						headers: { 'content-type': 'application/json' },
					})
			}),
		}) as LanguageModelV3

		await expect(model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
		})).rejects.toThrow()
		expect(requests).toHaveLength(2)
		expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
			'Bearer expired-bedrock-token',
			'Bearer fresh-bedrock-token',
		])
		expect(requests[1]!.body.model).toBe('openai.gpt-5.6-sol')
		expect(invalidations).toBe(1)
	})

	test('uses bearer auth and the selected model by default', async () => {
		const { model, request } = await captureGenerateRequest()
		const headers = new Headers(request.init?.headers)
		const body = JSON.parse(request.init?.body as string)

		expect(request.input.toString()).toBe('https://example.test/openai/v1/responses')
		expect(headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`)
		expect(headers.has('api-key')).toBe(false)
		expect(body.model).toBe('gpt-5.6-sol')
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
	})

	test('sends a custom raw key header without an authorization header', async () => {
		const { request } = await captureGenerateRequest({ override: { apiKeyHeader: 'api-key' } })
		const headers = new Headers(request.init?.headers)

		expect(headers.get('api-key')).toBe(TEST_KEY)
		expect(headers.has('authorization')).toBe(false)
		expect([...headers.values()].filter((value) => value.includes(TEST_KEY))).toEqual([TEST_KEY])
	})

	test('preserves fetch input and request fields while replacing auth', async () => {
		const controller = new AbortController()
		const { request } = await captureGenerateRequest({
			override: { apiKeyHeader: 'x-api-key' },
			abortSignal: controller.signal,
		})

		expect(request.input.toString()).toBe('https://example.test/openai/v1/responses')
		expect(request.init?.method).toBe('POST')
		expect(request.init?.body).toBeString()
		expect(request.init?.signal).toBe(controller.signal)
	})

	test('sends the wire model while exposing the selected model identity', async () => {
		const { model, request } = await captureGenerateRequest({
			override: { wireModelId: 'azure-coding-deployment' },
			selectedModelId: 'gpt-5.6-sol',
		})
		const body = JSON.parse(request.init?.body as string)

		expect(body.model).toBe('azure-coding-deployment')
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
		expect(model.doGenerate).toBeFunction()
		expect(model.doStream).toBeFunction()
	})

	test('delegates doGenerate and doStream through the wrapped language model', () => {
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6-sol',
			fetch: mock(async () => new Response()),
		}) as LanguageModelV3

		expect(model.specificationVersion).toBe('v3')
		expect(model.supportedUrls).toBeDefined()
	})

	test('restores cache writes and uncached input from non-streaming JSON', async () => {
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6',
			fetch: mock(async () => new Response(JSON.stringify(responsesPayload('json', 30, 20)), {
				headers: { 'content-type': 'application/json' },
			})),
		}) as LanguageModelV3

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
		})

		expect(result.usage.inputTokens).toEqual({ total: 100, noCache: 50, cacheRead: 30, cacheWrite: 20 })
	})

	test('keeps overlapping stream cache usage scoped to its request', async () => {
		let request = 0
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6',
			fetch: mock(async () => {
				request++
				return request === 1
					? sseResponse(responsesPayload('slow', 11, 17), 30)
					: sseResponse(responsesPayload('fast', 23, 29))
			}),
		}) as LanguageModelV3
		const run = async () => {
			const result = await model.doStream({
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
			})
			let usage
			for await (const part of result.stream) if (part.type === 'finish') usage = part.usage.inputTokens
			return usage
		}

		const [slow, fast] = await Promise.all([run(), run()])
		expect(slow).toEqual({ total: 100, noCache: 72, cacheRead: 11, cacheWrite: 17 })
		expect(fast).toEqual({ total: 100, noCache: 48, cacheRead: 23, cacheWrite: 29 })
	})

	test('reports request failures through diagnostics without exposing the API key or response body', async () => {
		const records: Array<{ event: string; metadata: Record<string, unknown> }> = []
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6-sol',
			diagnostics: {
				annotations: { sessionId: 'test-session' },
				onEvent: (record) => records.push(record),
			},
			fetch: mock(async () => new Response(JSON.stringify({ error: TEST_KEY, secret: 'response-secret' }), {
				status: 500,
				headers: { 'content-type': 'application/json' },
			})),
		}) as LanguageModelV3

		await expect(model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
		})).rejects.toThrow()

		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			event: 'codex.provider.custom_responses.failed',
			metadata: {
				operation: 'generate',
				provider: 'custom-openai-responses',
				statusCode: 500,
			},
		})
		const serialized = JSON.stringify(records)
		expect(serialized).not.toContain(TEST_KEY)
		expect(serialized).not.toContain('response-secret')
	})

	test('does not let a diagnostics sink failure replace the provider error', async () => {
		const model = createCustomCodexResponsesModel({
			override: override(),
			selectedModelId: 'gpt-5.6-sol',
			diagnostics: {
				annotations: {},
				onEvent: () => {
					throw new Error('sink failed')
				},
			},
			fetch: mock(async () => new Response('upstream failed', { status: 502 })),
		}) as LanguageModelV3

		await expect(model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
		})).rejects.not.toThrow('sink failed')
	})
})

describe('custom Codex Responses runtime request', () => {
	test('selects Bedrock custom Responses before ChatGPT transport resolution', async () => {
		const model = await resolveModel('codex', 'gpt-5.6-sol', {
			codexConnection: { type: 'bedrock', region: 'us-east-1' },
			authStore: createMemoryAuthStore(),
		}) as LanguageModelV3
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
	})

	test('reports invalid setup through the host diagnostics sink', async () => {
		process.env.CODELAYER_CODEX_MODEL = 'azure-coding-deployment'
		const records: Array<{ event: string; metadata: Record<string, unknown> }> = []

		await expect(resolveModel('codex', 'gpt-5.6-sol', {
			authStore: createMemoryAuthStore(),
			codexDiagnostics: {
				annotations: { sessionId: 'test-session' },
				onEvent: (record) => records.push(record),
			},
		})).rejects.toThrow('CODELAYER_CODEX_BASE_URL')

		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			event: 'codex.provider.custom_responses.failed',
			metadata: { operation: 'resolve', provider: 'custom-openai-responses' },
		})
	})

	test('resolves and streams with standard options but no fast-mode service tier', async () => {
		process.env.CODELAYER_CODEX_BASE_URL = 'https://example.test/openai/v1/responses/'
		process.env.CODELAYER_CODEX_API_KEY = TEST_KEY
		process.env.CODELAYER_CODEX_API_KEY_HEADER = 'api-key'
		process.env.CODELAYER_CODEX_MODEL = 'azure-coding-deployment'
		const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = []
		spyOn(globalThis, 'fetch').mockImplementation((async (input, init) => {
			requests.push({ input, init })
			return new Response(JSON.stringify({ error: { message: 'captured request' } }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			})
		}) as typeof globalThis.fetch)

		const model = await resolveModel('codex', 'gpt-5.6-sol', {
			authStore: createMemoryAuthStore(),
		}) as LanguageModelV3
		const providerOptions = buildProviderOptions(model, {
			codex: {
				reasoningEffort: 'high',
				reasoningSummary: 'detailed',
				fastMode: true,
				serviceTier: 'priority',
				promptCacheKey: 'session-custom',
			},
		})

		try {
			await model.doStream({
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
				providerOptions,
			})
		} catch {
			// The fake endpoint returns 400 after the streaming request is captured.
		}

		expect(requests).toHaveLength(1)
		const request = requests[0]!
		const headers = new Headers(request.init?.headers)
		const body = JSON.parse(request.init?.body as string)
		expect(request.input.toString()).toBe('https://example.test/openai/v1/responses')
		expect(request.init?.method).toBe('POST')
		expect(headers.get('api-key')).toBe(TEST_KEY)
		expect(headers.has('authorization')).toBe(false)
		expect([...headers.values()].filter((value) => value.includes(TEST_KEY))).toEqual([TEST_KEY])
		expect(model.provider).toBe('custom-openai-responses')
		expect(model.modelId).toBe('gpt-5.6-sol')
		expect(body).toMatchObject({
			model: 'azure-coding-deployment',
			stream: true,
			store: false,
			include: ['reasoning.encrypted_content'],
			prompt_cache_key: 'session-custom',
			reasoning: { effort: 'high', summary: 'detailed' },
		})
		expect(body).not.toHaveProperty('service_tier')
	})
})
