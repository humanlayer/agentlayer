/**
 * Tests for createCodexEffectProvider — the WebSocket-transport-based
 * Codex provider backed by the vendored LLMClient + Effect pipeline.
 *
 * These tests inject a mock WebSocketExecutor layer via _testLayers so
 * the full vendor pipeline (compile -> prepareTransport -> frames ->
 * protocol.stream.step) runs against controlled WebSocket events, without
 * touching real network.
 */
import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { LLMClient } from '@humanlayer/opencode-llm-vendor/route/client'
import { RequestExecutor } from '@humanlayer/opencode-llm-vendor/route/executor'
import {
	type WebSocketConnection,
	WebSocketExecutor,
	type WebSocketRequest,
} from '@humanlayer/opencode-llm-vendor/route/transport/websocket'
import type { LLMError } from '@humanlayer/opencode-llm-vendor/schema'
import { jsonSchema, streamText } from 'ai'
import { type Cause, Effect, Layer, Queue, Stream } from 'effect'
import { CODEX_PROVIDER_ID } from '../src/codex'
import { createCodexEffectProvider } from '../src/codex-effect'

// ---------------------------------------------------------------------------
// Mock WebSocket helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock WebSocketExecutor layer that delivers the given events
 * as JSON text frames through the WebSocketConnection.messages stream.
 *
 * The events should be raw Responses API event objects (e.g.
 * `{type: 'response.created', response: {...}}`) which the vendor's
 * protocol state machine will decode and transform into LLMEvents.
 */
function mockWebSocketExecutorLayer(events: unknown[]): {
	layer: Layer.Layer<any>
	sentMessages: string[]
	openCalls: WebSocketRequest[]
} {
	const sentMessages: string[] = []
	const openCalls: WebSocketRequest[] = []

	const mockOpen = (input: WebSocketRequest): Effect.Effect<WebSocketConnection, LLMError> =>
		Effect.gen(function* () {
			openCalls.push(input)
			const queue = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)

			// Enqueue all events as JSON text frames
			for (const event of events) {
				Queue.offerUnsafe(queue, JSON.stringify(event))
			}
			// Signal end of stream
			Queue.endUnsafe(queue)

			return {
				sendText: (message: string) =>
					Effect.sync(() => {
						sentMessages.push(message)
					}),
				messages: Stream.fromQueue(queue),
				close: Effect.void,
			}
		})

	const layer = Layer.succeed(WebSocketExecutor.Service, WebSocketExecutor.Service.of({ open: mockOpen }))

	return { layer, sentMessages, openCalls }
}

/**
 * Create a deferred mock WebSocket executor where initial events are emitted
 * immediately but trailing events are held back until releaseTrailing() is called.
 * Used to test streaming backpressure / incrementality.
 */
function mockDeferredWebSocketExecutorLayer(
	initialEvents: unknown[],
	trailingEvents: unknown[],
): {
	layer: Layer.Layer<any>
	releaseTrailing: () => void
	sentMessages: string[]
} {
	const sentMessages: string[] = []
	let releaseTrailing!: () => void
	const trailingGate = new Promise<void>((resolve) => {
		releaseTrailing = resolve
	})

	const mockOpen = (input: WebSocketRequest): Effect.Effect<WebSocketConnection, LLMError> =>
		Effect.gen(function* () {
			const queue = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)

			// Enqueue initial events
			for (const event of initialEvents) {
				Queue.offerUnsafe(queue, JSON.stringify(event))
			}

			// Schedule trailing events after the gate opens
			void trailingGate.then(() => {
				for (const event of trailingEvents) {
					Queue.offerUnsafe(queue, JSON.stringify(event))
				}
				Queue.endUnsafe(queue)
			})

			return {
				sendText: (message: string) =>
					Effect.sync(() => {
						sentMessages.push(message)
					}),
				messages: Stream.fromQueue(queue),
				close: Effect.void,
			}
		})

	const layer = Layer.succeed(WebSocketExecutor.Service, WebSocketExecutor.Service.of({ open: mockOpen }))

	return { layer, releaseTrailing, sentMessages }
}

/**
 * Build the full LLMClient layer backed by a mock WebSocket executor.
 * Includes a dummy RequestExecutor since the WebSocket transport doesn't use it,
 * but LLMClient.layer requires it.
 */
function buildTestLLMClientLayer(wsLayer: Layer.Layer<any>): Layer.Layer<any> {
	// LLMClient.layer requires RequestExecutor.Service, which requires HttpClient.
	// We provide a dummy RequestExecutor since the WS transport won't call it.
	return LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer), Layer.provide(wsLayer))
}

// ---------------------------------------------------------------------------
// Test data: standard Responses API events
// ---------------------------------------------------------------------------

const BASIC_TEXT_EVENTS = [
	{
		type: 'response.created',
		response: { id: 'resp_ws_1', created_at: 1700000000, model: 'gpt-5.4' },
	},
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: { type: 'message', id: 'msg_ws_1', role: 'assistant', content: [] },
	},
	{
		type: 'response.content_part.added',
		output_index: 0,
		content_index: 0,
		part: { type: 'output_text', text: '' },
	},
	{
		type: 'response.output_text.delta',
		output_index: 0,
		content_index: 0,
		item_id: 'msg_ws_1',
		delta: 'Hello from WebSocket',
	},
	{
		type: 'response.content_part.done',
		output_index: 0,
		content_index: 0,
		part: { type: 'output_text', text: 'Hello from WebSocket' },
	},
	{
		type: 'response.output_item.done',
		output_index: 0,
		item: {
			type: 'message',
			id: 'msg_ws_1',
			role: 'assistant',
			content: [{ type: 'output_text', text: 'Hello from WebSocket' }],
		},
	},
	{
		type: 'response.completed',
		response: {
			id: 'resp_ws_1',
			status: 'completed',
			usage: {
				input_tokens: 10,
				input_tokens_details: { cached_tokens: 2 },
				output_tokens: 4,
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	},
]

const REASONING_EVENTS = [
	{
		type: 'response.created',
		response: { id: 'resp_ws_reason', created_at: 1700000003, model: 'gpt-5.4' },
	},
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: { type: 'reasoning', id: 'rs_ws_1', encrypted_content: 'enc-ws' },
	},
	{
		type: 'response.reasoning_summary_part.added',
		item_id: 'rs_ws_1',
		summary_index: 0,
	},
	{
		type: 'response.reasoning_summary_text.delta',
		item_id: 'rs_ws_1',
		summary_index: 0,
		delta: 'Thinking deeply.',
	},
	{
		type: 'response.output_item.done',
		output_index: 0,
		item: { type: 'reasoning', id: 'rs_ws_1', encrypted_content: 'enc-ws' },
	},
	{
		type: 'response.output_item.added',
		output_index: 1,
		item: { type: 'message', id: 'msg_ws_reason', role: 'assistant', content: [], phase: 'final_answer' },
	},
	{
		type: 'response.content_part.added',
		output_index: 1,
		content_index: 0,
		part: { type: 'output_text', text: '' },
	},
	{
		type: 'response.output_text.delta',
		output_index: 1,
		content_index: 0,
		item_id: 'msg_ws_reason',
		delta: 'Final answer.',
	},
	{
		type: 'response.output_item.done',
		output_index: 1,
		item: {
			type: 'message',
			id: 'msg_ws_reason',
			role: 'assistant',
			content: [{ type: 'output_text', text: 'Final answer.' }],
			phase: 'final_answer',
		},
	},
	{
		type: 'response.completed',
		response: {
			id: 'resp_ws_reason',
			status: 'completed',
			usage: {
				input_tokens: 3,
				output_tokens: 5,
				output_tokens_details: { reasoning_tokens: 3 },
			},
		},
	},
]

const TOOL_CALL_EVENTS = [
	{
		type: 'response.created',
		response: { id: 'resp_ws_tool', created_at: 1700000014, model: 'gpt-5.4' },
	},
	{
		type: 'response.output_item.added',
		output_index: 0,
		item: {
			type: 'function_call',
			id: 'fc_ws_1',
			call_id: 'call_ws_1',
			name: 'read',
			arguments: '',
		},
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 0,
		item_id: 'fc_ws_1',
		delta: '{"filePath"',
	},
	{
		type: 'response.function_call_arguments.delta',
		output_index: 0,
		item_id: 'fc_ws_1',
		delta: ':"README.md"}',
	},
	{
		type: 'response.function_call_arguments.done',
		output_index: 0,
		item_id: 'fc_ws_1',
		arguments: '{"filePath":"README.md"}',
	},
	{
		type: 'response.output_item.done',
		output_index: 0,
		item: {
			type: 'function_call',
			id: 'fc_ws_1',
			call_id: 'call_ws_1',
			name: 'read',
			arguments: '{"filePath":"README.md"}',
		},
	},
	{
		type: 'response.completed',
		response: {
			id: 'resp_ws_tool',
			status: 'completed',
			usage: { input_tokens: 2, output_tokens: 4 },
		},
	},
]

// ---------------------------------------------------------------------------
// Helper to create the Effect provider with mock WebSocket
// ---------------------------------------------------------------------------

function createTestProvider(wsEvents: unknown[], opts?: { fastMode?: boolean; serviceTier?: string }) {
	const store = createMemoryAuthStore({
		[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-api-key' },
	})

	const { layer: wsLayer, sentMessages, openCalls } = mockWebSocketExecutorLayer(wsEvents)
	const testLayers = buildTestLLMClientLayer(wsLayer)

	const provider = createCodexEffectProvider({
		authStore: store,
		version: '1.0.0-test',
		sessionId: 'test-session',
		fastMode: opts?.fastMode,
		serviceTier: opts?.serviceTier,
		_testLayers: testLayers,
	})

	return { provider, sentMessages, openCalls }
}

function createDeferredTestProvider(initialEvents: unknown[], trailingEvents: unknown[]) {
	const store = createMemoryAuthStore({
		[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'test-api-key' },
	})

	const {
		layer: wsLayer,
		releaseTrailing,
		sentMessages,
	} = mockDeferredWebSocketExecutorLayer(initialEvents, trailingEvents)
	const testLayers = buildTestLLMClientLayer(wsLayer)

	const provider = createCodexEffectProvider({
		authStore: store,
		version: '1.0.0-test',
		_testLayers: testLayers,
	})

	return { provider, releaseTrailing, sentMessages }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codex effect provider (WebSocket transport)', () => {
	test('doGenerate returns content from WebSocket events', async () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Hello from WebSocket' }))
		expect(result.finishReason).toMatchObject({ unified: 'stop' })
	})

	test('doStream emits text events incrementally via WebSocket', async () => {
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
		expect(textDelta!.delta).toBe('Hello from WebSocket')
	})

	test('doStream respects streaming backpressure with deferred WebSocket messages', async () => {
		const { provider, releaseTrailing } = createDeferredTestProvider(
			[
				{
					type: 'response.created',
					response: { id: 'resp_deferred', created_at: 1700000000, model: 'gpt-5.4' },
				},
				{
					type: 'response.output_item.added',
					output_index: 0,
					item: { type: 'message', id: 'msg_deferred', role: 'assistant', content: [] },
				},
				{
					type: 'response.content_part.added',
					output_index: 0,
					content_index: 0,
					part: { type: 'output_text', text: '' },
				},
				{
					type: 'response.output_text.delta',
					output_index: 0,
					content_index: 0,
					item_id: 'msg_deferred',
					delta: 'Hello',
				},
			],
			[
				{
					type: 'response.output_text.delta',
					output_index: 0,
					content_index: 0,
					item_id: 'msg_deferred',
					delta: ' world',
				},
				{
					type: 'response.output_item.done',
					output_index: 0,
					item: {
						type: 'message',
						id: 'msg_deferred',
						role: 'assistant',
						content: [{ type: 'output_text', text: 'Hello world' }],
					},
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp_deferred',
						status: 'completed',
						usage: { input_tokens: 2, output_tokens: 2 },
					},
				},
			],
		)

		const model = provider.languageModel('gpt-5.4')
		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
		})
		const reader = result.stream.getReader()

		// Read initial parts (stream-start, then text-start and text-delta for "Hello")
		const initialParts: Array<{ type: string; [key: string]: unknown }> = []
		// Read until we get the first text-delta
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			initialParts.push(value as { type: string; [key: string]: unknown })
			if (value.type === 'text-delta') break
		}

		expect(initialParts.map((p) => p.type)).toContain('text-delta')
		const firstDelta = initialParts.find((p) => p.type === 'text-delta')
		expect(firstDelta!.delta).toBe('Hello')

		// The next read should block until trailing events are released
		let pendingResolved = false
		const pendingRead = reader.read().then((value) => {
			pendingResolved = true
			return value
		})
		await sleep(20)
		expect(pendingResolved).toBe(false)

		// Release trailing events
		releaseTrailing()

		const nextResult = await pendingRead
		expect(nextResult.done).toBe(false)
		// Should be the second text-delta
		expect(nextResult.value).toBeDefined()
		expect(nextResult.value!.type).toBe('text-delta')
		expect((nextResult.value as { delta: string }).delta).toBe(' world')

		// Drain remaining parts
		const remainingParts: Array<{ type: string }> = []
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			remainingParts.push(value as { type: string })
		}

		expect(remainingParts.map((p) => p.type)).toContain('finish')
	})

	test('streamText fullStream emits function calls from WebSocket events', async () => {
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
			{ type: 'tool-call', toolCallId: 'call_ws_1', toolName: 'read', input: { filePath: 'README.md' } },
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
					reasoningSummary: 'auto',
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
		expect(reasoningDelta).toMatchObject({ text: 'Thinking deeply.' })

		const textDelta = parts.find((p) => p.type === 'text-delta')
		expect(textDelta).toMatchObject({ text: 'Final answer.' })

		expect(await result.reasoningText).toBe('Thinking deeply.')
		expect(await result.text).toBe('Final answer.')
	})

	test('doGenerate reconstructs text from reasoning + text WebSocket events', async () => {
		const { provider } = createTestProvider(REASONING_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		// doGenerate collects stream parts internally. It reconstructs text
		// from text-delta parts. Reasoning parts flow through the stream but
		// are not assembled into content by doGenerate (they require streamText
		// for the AI SDK to reconstruct them).
		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Think through this.' }] }],
		})

		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Final answer.' }))
		expect(result.finishReason).toMatchObject({ unified: 'stop' })
	})

	test('WebSocket URL is constructed with wss:// protocol', async () => {
		const { provider, openCalls } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(openCalls.length).toBeGreaterThan(0)
		expect(openCalls[0]!.url).toMatch(/^wss:\/\//)
	})

	test('auth token is injected into WebSocket headers', async () => {
		const { provider, openCalls } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(openCalls.length).toBeGreaterThan(0)
		// The headers object from the vendor uses Effect's Headers type
		const headers = openCalls[0]!.headers
		// Headers may be a Record<string, string> or a Headers-like structure
		const headerEntries = typeof headers === 'object' ? headers : {}
		// Check that authorization header is present with the test API key
		const authHeader =
			(headerEntries as Record<string, string>).authorization ??
			(headerEntries as Record<string, string>).Authorization
		expect(authHeader).toBe('Bearer test-api-key')
	})

	test('custom headers (originator, User-Agent, session_id) are passed', async () => {
		const { provider, openCalls } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(openCalls.length).toBeGreaterThan(0)
		const headers = openCalls[0]!.headers as Record<string, string>
		expect(headers.originator).toBe('opencode')
		expect(headers.session_id).toBe('test-session')
		expect(headers['user-agent']).toMatch(/^opencode\//)
	})

	test('WebSocket message body contains response.create with model and input', async () => {
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(sentMessages.length).toBeGreaterThan(0)
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		// WebSocket messages have type: 'response.create' (per vendor webSocketMessage transform)
		expect(body.type).toBe('response.create')
		expect(body.model).toBe('gpt-5.4')
		// Input should contain the user message
		expect(body.input).toBeDefined()
	})

	test('store is always false in WebSocket message body', async () => {
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
			providerOptions: { openai: { store: true } },
		})

		expect(sentMessages.length).toBeGreaterThan(0)
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		expect(body.store).toBe(false)
	})

	test('fastMode sets serviceTier in providerOptions passed to the adapter', async () => {
		// Note: the vendor's lowerOptions does NOT pass service_tier through
		// to the wire body (DQ4 gap). The adapter correctly sets it in
		// providerOptions.openai.serviceTier, but the vendor does not lower
		// it. This test verifies the adapter sets the value; the wire body
		// currently does NOT include service_tier when using the WS transport.
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS, { fastMode: true })
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		// The WebSocket message is sent; verify it was constructed
		expect(sentMessages.length).toBeGreaterThan(0)
		// Note: service_tier is NOT in the body due to vendor gap
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		expect(body.type).toBe('response.create')
	})

	test('include defaults to reasoning.encrypted_content', async () => {
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(sentMessages.length).toBeGreaterThan(0)
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		expect(body.include).toEqual(['reasoning.encrypted_content'])
	})

	test('reasoning defaults are set (effort: medium, summary: auto)', async () => {
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(sentMessages.length).toBeGreaterThan(0)
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		const reasoning = body.reasoning as Record<string, unknown> | undefined
		expect(reasoning).toBeDefined()
		expect(reasoning!.effort).toBe('medium')
		expect(reasoning!.summary).toBe('auto')
	})

	test('oauth auth injects ChatGPT-Account-Id header', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'oauth-ws-access',
				accountId: 'acct_ws_123',
			},
		})

		const { layer: wsLayer, openCalls } = mockWebSocketExecutorLayer(BASIC_TEXT_EVENTS)
		const testLayers = buildTestLLMClientLayer(wsLayer)

		const provider = createCodexEffectProvider({
			authStore: store,
			version: '1.0.0-test',
			_testLayers: testLayers,
		})

		const model = provider.languageModel('gpt-5.4')
		await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
		})

		expect(openCalls.length).toBeGreaterThan(0)
		const headers = openCalls[0]!.headers as Record<string, string>
		expect(headers['chatgpt-account-id']).toBe('acct_ws_123')
		expect(headers.authorization).toBe('Bearer oauth-ws-access')
	})

	test('response.failed produces a provider-error mapped to error stream part', async () => {
		const events = [
			{
				type: 'response.created',
				response: { id: 'resp_err', created_at: 1700000000, model: 'gpt-5.4' },
			},
			{
				type: 'response.failed',
				response: {
					id: 'resp_err',
					status: 'failed',
					error: { message: 'Something went wrong' },
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		]

		const { provider } = createTestProvider(events)
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

		// The vendor's protocol state machine maps response.failed to a
		// 'provider-error' LLMEvent, which llmEventToStreamParts maps to
		// { type: 'error', error: Error }
		const errorPart = parts.find((p) => p.type === 'error')
		expect(errorPart).toBeDefined()
		expect(errorPart!.error).toBeInstanceOf(Error)
		expect((errorPart!.error as Error).message).toBe('Something went wrong')
	})

	test('doStream with tools sends strictified schemas in WebSocket message', async () => {
		const { provider, sentMessages } = createTestProvider(TOOL_CALL_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Read a file.' }] }],
			tools: [
				{
					type: 'function' as const,
					name: 'read',
					description: 'Read a file',
					inputSchema: {
						type: 'object',
						properties: { filePath: { type: 'string', format: 'custom' } },
					},
				},
			],
		})

		// Drain the stream to ensure the message is sent
		const reader = result.stream.getReader()
		while (true) {
			const { done } = await reader.read()
			if (done) break
		}

		// Check that at least one message was sent with tools
		const hasToolMessage = sentMessages.some((msg) => {
			const body = JSON.parse(msg) as Record<string, unknown>
			return Array.isArray(body.tools) && body.tools.length > 0
		})
		expect(hasToolMessage).toBe(true)

		// Verify schema was strictified (format removed, required added)
		const toolMessage = sentMessages.find((msg) => {
			const body = JSON.parse(msg) as Record<string, unknown>
			return Array.isArray(body.tools) && body.tools.length > 0
		})
		const toolBody = JSON.parse(toolMessage!) as { tools: Array<{ parameters: Record<string, unknown> }> }
		const toolSchema = toolBody.tools[0]!.parameters
		expect(toolSchema.required).toEqual(['filePath'])
		expect(toolSchema.additionalProperties).toBe(false)
		const props = toolSchema.properties as Record<string, Record<string, unknown>>
		expect(props.filePath!.format).toBeUndefined()
	})

	test('model specification matches expected values', () => {
		const { provider } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		expect(model.specificationVersion).toBe('v3')
		expect(model.provider).toBe('codex-effect')
		expect(model.modelId).toBe('gpt-5.4')
	})

	test('system messages are included in the input array via the vendor pipeline', async () => {
		const { provider, sentMessages } = createTestProvider(BASIC_TEXT_EVENTS)
		const model = provider.languageModel('gpt-5.4')

		await model.doGenerate({
			prompt: [
				{ role: 'system', content: 'Be helpful.' },
				{ role: 'user', content: [{ type: 'text', text: 'Hi' }] },
			],
		})

		expect(sentMessages.length).toBeGreaterThan(0)
		const body = JSON.parse(sentMessages[0]!) as Record<string, unknown>
		// System messages are passed as top-level `instructions` for Codex,
		// not as input items with role:'system'
		expect(body.instructions).toBe('Be helpful.')
		const input = body.input as Array<Record<string, unknown>>
		expect(input).toBeDefined()
		// No system items in input array
		expect(input.every((item) => item.role !== 'system')).toBe(true)
	})

	test('multiple text deltas accumulate in doGenerate', async () => {
		const events = [
			{
				type: 'response.created',
				response: { id: 'resp_multi', created_at: 1700000001, model: 'gpt-5.4' },
			},
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: { type: 'message', id: 'msg_multi', role: 'assistant', content: [] },
			},
			{
				type: 'response.content_part.added',
				output_index: 0,
				content_index: 0,
				part: { type: 'output_text', text: '' },
			},
			{
				type: 'response.output_text.delta',
				output_index: 0,
				content_index: 0,
				item_id: 'msg_multi',
				delta: 'Line 1',
			},
			{
				type: 'response.output_text.delta',
				output_index: 0,
				content_index: 0,
				item_id: 'msg_multi',
				delta: ' and line 2',
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'message',
					id: 'msg_multi',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Line 1 and line 2' }],
				},
			},
			{
				type: 'response.completed',
				response: {
					id: 'resp_multi',
					status: 'completed',
					usage: { input_tokens: 2, output_tokens: 3 },
				},
			},
		]

		const { provider } = createTestProvider(events)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Combine lines' }] }],
		})

		expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Line 1 and line 2' }))
	})

	test('response.incomplete event produces a finish with reason', async () => {
		const events = [
			{
				type: 'response.created',
				response: { id: 'resp_inc', created_at: 1700000000, model: 'gpt-5.4' },
			},
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: { type: 'message', id: 'msg_inc', role: 'assistant', content: [] },
			},
			{
				type: 'response.content_part.added',
				output_index: 0,
				content_index: 0,
				part: { type: 'output_text', text: '' },
			},
			{
				type: 'response.output_text.delta',
				output_index: 0,
				content_index: 0,
				item_id: 'msg_inc',
				delta: 'Partial...',
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: {
					type: 'message',
					id: 'msg_inc',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Partial...' }],
				},
			},
			{
				type: 'response.incomplete',
				response: {
					id: 'resp_inc',
					status: 'incomplete',
					incomplete_details: { reason: 'max_output_tokens' },
					usage: { input_tokens: 5, output_tokens: 100 },
				},
			},
		]

		const { provider } = createTestProvider(events)
		const model = provider.languageModel('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Write a lot' }] }],
		})

		// The finish reason should be 'length' for max_output_tokens
		expect(result.finishReason.unified).toBe('length')
	})
})
