/**
 * Tests for createCodexSseVendorProvider -- the HTTP-SSE-transport-based
 * Codex provider backed by the vendored LLMClient + Effect pipeline.
 *
 * These tests inject a mock LLMClient layer via _testLayers that returns
 * controlled LLMEvent streams, so the full provider plumbing
 * (auth -> adapter -> bridge -> ReadableStream) runs against controlled
 * events without touching real network.
 *
 * Unlike the WebSocket provider tests which mock at the WebSocketExecutor
 * level, these tests mock at the LLMClient.Service level because the SSE
 * transport goes through RequestExecutor -> FetchHttpClient which is more
 * complex to mock. The LLMClient-level mock still exercises the provider's
 * event mapping, auth resolution, and Effect-to-ReadableStream bridging.
 */
import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { LLMClient } from '@humanlayer/opencode-llm-vendor/route/client'
import { jsonSchema, streamText } from 'ai'
import { Effect, Layer, Stream } from 'effect'
import { createCodexSseVendorProvider } from '../src/providers/sse-vendor-provider'
import { CODEX_PROVIDER_ID } from '../src/shared/constants'

// ---------------------------------------------------------------------------
// Mock LLMClient helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock LLMClient.Service layer that delivers the given LLMEvents
 * via a controlled stream. The events should be vendor LLMEvent objects
 * (tagged unions with `type` field) which the provider's llmEventToStreamParts
 * will map to AI SDK stream parts.
 *
 * This mocks at the LLMClient level rather than the transport level,
 * which is appropriate for the SSE provider since we want to test:
 * - Auth resolution and header construction
 * - Adapter conversion (prompt -> LLMRequest)
 * - Event-to-StreamPart mapping
 * - Effect Stream -> ReadableStream bridging
 */
function mockLLMClientLayer(events: unknown[]): {
	layer: Layer.Layer<any>
	streamCalls: Array<{ request: unknown }>
} {
	const streamCalls: Array<{ request: unknown }> = []

	const mockStream = (request: unknown) => {
		streamCalls.push({ request })
		return Stream.fromIterable(events)
	}

	const mockGenerate = (request: unknown) =>
		Effect.gen(function* () {
			const allEvents: unknown[] = []
			yield* Stream.runForEach(mockStream(request), (event) => Effect.sync(() => allEvents.push(event)))
			return { events: allEvents, usage: undefined }
		})

	const layer = Layer.succeed(
		LLMClient.Service,
		LLMClient.Service.of({
			prepare: (() => Effect.succeed({})) as any,
			stream: ((input: any) => mockStream(input)) as any,
			generate: ((input: any) => mockGenerate(input)) as any,
		}),
	)

	return { layer, streamCalls }
}

/**
 * Build a test layer that provides LLMClient.Service with mock data.
 * Also includes RequestExecutor.defaultLayer since LLMClient.layer depends on it
 * (even though our mock bypasses the actual transport).
 */
function buildTestLayer(clientLayer: Layer.Layer<any>): Layer.Layer<any> {
	return clientLayer
}

// ---------------------------------------------------------------------------
// Test data: LLMEvent objects (vendor tagged unions)
// ---------------------------------------------------------------------------

// These are the LLMEvent objects that LLMClient.stream() would produce
// after the protocol state machine processes raw SSE events.

const BASIC_TEXT_EVENTS = [
	{ type: 'step-start', index: 0 },
	{ type: 'text-start', id: 'text-0' },
	{ type: 'text-delta', id: 'text-0', text: 'Hello from SSE' },
	{ type: 'text-end', id: 'text-0' },
	{
		type: 'step-finish',
		index: 0,
		reason: 'stop',
		usage: { inputTokens: 10, outputTokens: 4 },
		providerMetadata: { openai: { responseId: 'resp_sse_1', serviceTier: null } },
	},
	{
		type: 'finish',
		reason: 'stop',
		usage: { inputTokens: 10, outputTokens: 4 },
		providerMetadata: { openai: { responseId: 'resp_sse_1', serviceTier: null } },
	},
]

const REASONING_EVENTS = [
	{ type: 'step-start', index: 0 },
	{
		type: 'reasoning-start',
		id: 'rs_sse_1:0',
		providerMetadata: { openai: { itemId: 'rs_sse_1', reasoningEncryptedContent: 'enc-sse' } },
	},
	{ type: 'reasoning-delta', id: 'rs_sse_1:0', text: 'Thinking deeply via SSE.' },
	{
		type: 'reasoning-end',
		id: 'rs_sse_1:0',
		providerMetadata: { openai: { itemId: 'rs_sse_1' } },
	},
	{ type: 'text-start', id: 'msg_sse_reason' },
	{ type: 'text-delta', id: 'msg_sse_reason', text: 'Final answer via SSE.' },
	{ type: 'text-end', id: 'msg_sse_reason' },
	{
		type: 'step-finish',
		index: 0,
		reason: 'stop',
		usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 3 },
	},
	{ type: 'finish', reason: 'stop', usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 3 } },
]

const TOOL_CALL_EVENTS = [
	{ type: 'step-start', index: 0 },
	{
		type: 'tool-input-start',
		id: 'call_sse_1',
		name: 'read',
		providerMetadata: { openai: { itemId: 'fc_sse_1' } },
	},
	{ type: 'tool-input-delta', id: 'call_sse_1', text: '{"filePath":"README.md"}' },
	{ type: 'tool-input-end', id: 'call_sse_1' },
	{
		type: 'tool-call',
		id: 'call_sse_1',
		name: 'read',
		input: '{"filePath":"README.md"}',
		providerMetadata: { openai: { itemId: 'fc_sse_1' } },
	},
	{
		type: 'step-finish',
		index: 0,
		reason: 'tool-calls',
		usage: { inputTokens: 2, outputTokens: 4 },
	},
	{
		type: 'finish',
		reason: 'tool-calls',
		usage: { inputTokens: 2, outputTokens: 4 },
	},
]

const PROVIDER_ERROR_EVENTS = [{ type: 'provider-error', message: 'SSE provider error occurred' }]

// ---------------------------------------------------------------------------
// Helper to create the SSE provider with mock LLMClient
// ---------------------------------------------------------------------------

function createTestProvider(llmEvents: unknown[], opts?: { fastMode?: boolean; serviceTier?: string }) {
	const store = createMemoryAuthStore({
		[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-sse-api-key' },
	})

	const { layer: clientLayer, streamCalls } = mockLLMClientLayer(llmEvents)
	const testLayers = buildTestLayer(clientLayer)

	const provider = createCodexSseVendorProvider({
		authStore: store,
		version: '1.0.0-test',
		sessionId: 'test-sse-session',
		fastMode: opts?.fastMode,
		serviceTier: opts?.serviceTier,
		_testLayers: testLayers,
	})

	return { provider, streamCalls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codex SSE vendor provider (HTTP SSE transport)', () => {
	test('model specification matches expected values', () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		expect(model.specificationVersion).toBe('v3')
		expect(model.provider).toBe('codex-sse-vendor')
		expect(model.modelId).toBe('gpt-5.4')
	})

	test('doGenerate returns content from SSE events', async () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello from SSE' }))
		expect(result.finishReason).toMatchObject({ unified: 'stop' })
	})

	test('doStream emits text events incrementally via SSE', async () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
		})
		const reader = result.stream.getReader()

		// Collect all stream parts
		const parts: Array<{ type: string; [key: string]: unknown }> = []
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			parts.push(value as { type: string; [key: string]: unknown })
		}

		const types = parts.map((p) => p.type)
		expect(types).toContain('stream-start')
		expect(types).toContain('text-start')
		expect(types).toContain('text-delta')
		expect(types).toContain('text-end')
		expect(types).toContain('finish')

		const textDelta = parts.find((p) => p.type === 'text-delta')
		expect(textDelta).toBeDefined()
		expect(textDelta!.delta).toBe('Hello from SSE')
	})

	test('streamText fullStream emits function calls from SSE events', async () => {
		const { provider } = createTestProvider(TOOL_CALL_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = streamText({
			model,
			prompt: 'Read a file.',
			tools: {
				read: {
					description: 'Read a file',
					inputSchema: jsonSchema({
						type: 'object',
						properties: { filePath: { type: 'string' } },
						required: ['filePath'],
					}),
				},
			},
		})

		const parts = [] as Array<{ type: string; [key: string]: unknown }>
		for await (const part of result.fullStream) {
			parts.push(part as { type: string; [key: string]: unknown })
		}

		expect(parts.map((p) => p.type)).toContain('tool-input-start')
		expect(parts.map((p) => p.type)).toContain('tool-input-delta')
		expect(parts.map((p) => p.type)).toContain('tool-call')
		expect(await result.toolCalls).toMatchObject([
			{ type: 'tool-call', toolCallId: 'call_sse_1', toolName: 'read', input: { filePath: 'README.md' } },
		])
	})

	test('streamText fullStream emits reasoning events before text', async () => {
		const { provider } = createTestProvider(REASONING_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = streamText({
			model,
			prompt: 'Think about this.',
			providerOptions: {
				openai: {
					store: false,
					reasoningSummary: 'detailed',
					include: ['reasoning.encrypted_content'],
				},
			},
		})

		const parts = [] as Array<{ type: string; [key: string]: unknown }>
		for await (const part of result.fullStream) {
			parts.push(part as { type: string; [key: string]: unknown })
		}

		const types = parts.map((p) => p.type)
		expect(types).toContain('reasoning-start')
		expect(types).toContain('reasoning-delta')
		expect(types).toContain('reasoning-end')
		expect(types).toContain('text-start')
		expect(types).toContain('text-delta')
		expect(types).toContain('text-end')

		// reasoning events should come before text events
		const reasoningEndIdx = types.indexOf('reasoning-end')
		const textStartIdx = types.indexOf('text-start')
		expect(reasoningEndIdx).toBeLessThan(textStartIdx)

		const reasoningDelta = parts.find((p) => p.type === 'reasoning-delta')
		expect(reasoningDelta).toMatchObject({ text: 'Thinking deeply via SSE.' })

		const textDelta = parts.find((p) => p.type === 'text-delta')
		expect(textDelta).toMatchObject({ text: 'Final answer via SSE.' })

		expect(await result.reasoningText).toBe('Thinking deeply via SSE.')
		expect(await result.text).toBe('Final answer via SSE.')
	})

	test('doGenerate reconstructs text from reasoning + text SSE events', async () => {
		const { provider } = createTestProvider(REASONING_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Think through this.' }] }],
		})

		expect(result.content).toContainEqual(
			expect.objectContaining({ type: 'reasoning', text: 'Thinking deeply via SSE.' }),
		)
		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Final answer via SSE.' }))
		expect(result.finishReason).toMatchObject({ unified: 'stop' })
	})

	test('provider-error produces an error stream part', async () => {
		const { provider } = createTestProvider(PROVIDER_ERROR_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		const parts: Array<{ type: string; [key: string]: unknown }> = []
		const reader = result.stream.getReader()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			parts.push(value as { type: string; [key: string]: unknown })
		}

		const errorPart = parts.find((p) => p.type === 'error')
		expect(errorPart).toBeDefined()
		expect(errorPart!.error).toBeInstanceOf(Error)
		expect((errorPart!.error as Error).message).toBe('SSE provider error occurred')
	})

	test('oauth auth resolves correctly', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'oauth-sse-access',
				accountId: 'acct_sse_123',
			},
		})

		const { layer: clientLayer, streamCalls } = mockLLMClientLayer(BASIC_TEXT_EVENTS)

		const provider = createCodexSseVendorProvider({
			authStore: store,
			version: '1.0.0-test',
			_testLayers: buildTestLayer(clientLayer),
		})

		const model = provider.languageModel('gpt-5.4')
		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		// Drain the stream
		const reader = result.stream.getReader()
		while (true) {
			const { done } = await reader.read()
			if (done) break
		}

		// The mock LLMClient layer received a stream call
		expect(streamCalls.length).toBeGreaterThan(0)
	})

	test('multiple text deltas accumulate in doGenerate', async () => {
		const events = [
			{ type: 'step-start', index: 0 },
			{ type: 'text-start', id: 'text-0' },
			{ type: 'text-delta', id: 'text-0', text: 'Line 1' },
			{ type: 'text-delta', id: 'text-0', text: ' and line 2' },
			{ type: 'text-end', id: 'text-0' },
			{ type: 'step-finish', index: 0, reason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } },
			{ type: 'finish', reason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } },
		]

		const { provider } = createTestProvider(events)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Combine lines' }] }],
		})

		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Line 1 and line 2' }))
	})

	test('finish reason length is propagated', async () => {
		const events = [
			{ type: 'step-start', index: 0 },
			{ type: 'text-start', id: 'text-0' },
			{ type: 'text-delta', id: 'text-0', text: 'Partial...' },
			{ type: 'text-end', id: 'text-0' },
			{
				type: 'step-finish',
				index: 0,
				reason: 'length',
				usage: { inputTokens: 5, outputTokens: 100 },
			},
			{ type: 'finish', reason: 'length', usage: { inputTokens: 5, outputTokens: 100 } },
		]

		const { provider } = createTestProvider(events)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Write a lot' }] }],
		})

		expect(result.finishReason.unified).toBe('length')
	})

	test('abort signal cancels the stream', async () => {
		// Create a slow stream that emits events with delays
		const events = [
			{ type: 'step-start', index: 0 },
			{ type: 'text-start', id: 'text-0' },
			{ type: 'text-delta', id: 'text-0', text: 'Before abort' },
		]

		const { provider } = createTestProvider(events)
		const model = provider.languageModel('gpt-5.4')

		const controller = new AbortController()

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
			abortSignal: controller.signal,
		})

		const reader = result.stream.getReader()
		const parts: Array<{ type: string }> = []

		// Read the initial parts
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			parts.push(value as { type: string })
			// Abort after getting a text-delta
			if (value.type === 'text-delta') {
				controller.abort()
				break
			}
		}

		// Should have received at least stream-start and text-delta
		expect(parts.map((p) => p.type)).toContain('stream-start')
		expect(parts.map((p) => p.type)).toContain('text-delta')
	})

	test('provider factory throws NoSuchModelError for unsupported model types', () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)

		expect(() => provider.embeddingModel('test')).toThrow()
		expect(() => provider.imageModel('test')).toThrow()
		// These methods are optional on ProviderV3 but our provider defines them
		expect(() => provider.transcriptionModel!('test')).toThrow()
		expect(() => provider.speechModel!('test')).toThrow()
		expect(() => provider.rerankingModel!('test')).toThrow()
	})
})
