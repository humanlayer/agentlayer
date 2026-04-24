import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import { generateText, streamText } from 'ai'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import {
	buildCodexHeaders,
	buildCodexUserAgent,
	CODEX_API_ENDPOINT,
	CODEX_PROVIDER,
	CODEX_PROVIDER_ID,
	createCodexLanguageModel,
	createCodexProvider,
} from '../src/codex'

function encodeSseEvents(events: unknown[], includeDone = true): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}${includeDone ? 'data: [DONE]\n\n' : ''}`
}

function createSseResponse(events: unknown[]): Response {
	return new Response(encodeSseEvents(events), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

function createDeferredSseResponse(initialEvents: unknown[], trailingEvents: unknown[]) {
	const encoder = new TextEncoder()
	let releaseTrailing!: () => void
	const trailingGate = new Promise<void>((resolve) => {
		releaseTrailing = resolve
	})

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(encodeSseEvents(initialEvents, false)))
			void trailingGate.then(() => {
				controller.enqueue(encoder.encode(encodeSseEvents(trailingEvents)))
				controller.close()
			})
		},
	})

	return {
		response: new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		}),
		releaseTrailing,
	}
}

describe('codex provider wrapper', () => {
	test('createCodexProvider creates language models with OpenCode request behavior', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'oauth-access',
				accountId: 'acct_123',
			},
		})
		const calls: Array<{ url: string; init?: RequestInit }> = []
		const provider = createCodexProvider({
			authStore: store,
			version: '1.2.3',
			sessionId: 'session-abc',
			fetch: async (input, init) => {
				calls.push({ url: input instanceof URL ? input.toString() : String(input), init })
				return createSseResponse([
					{ type: 'response.created', response: { id: 'resp_1', created_at: 1700000000, model: 'gpt-5.4' } },
					{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
					{ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello from Codex' },
					{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
					{
						type: 'response.completed',
						response: {
							usage: {
								input_tokens: 10,
								input_tokens_details: { cached_tokens: 2 },
								output_tokens: 4,
								output_tokens_details: { reasoning_tokens: 1 },
							},
						},
					},
				])
			},
		})
		const model = provider.languageModel('gpt-5.4')

		expect(model.specificationVersion).toBe('v3')
		expect(model.provider).toBe(CODEX_PROVIDER)
		expect(model.modelId).toBe('gpt-5.4')

		const result = await model.doGenerate({
			prompt: [
				{ role: 'system', content: 'Be helpful.' },
				{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] },
			],
			headers: {
				authorization: 'Bearer caller-token',
				'x-extra': 'extra-header',
			},
		})

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toBe(CODEX_API_ENDPOINT)
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe('Bearer oauth-access')
		expect(headers.get('ChatGPT-Account-Id')).toBe('acct_123')
		expect(headers.get('originator')).toBe('opencode')
		expect(headers.get('session_id')).toBe('session-abc')
		expect(headers.get('User-Agent')).toBe(buildCodexUserAgent('1.2.3'))
		expect(headers.get('x-extra')).toBe('extra-header')

		expect(result.content).toEqual([
			{ type: 'text', text: 'Hello from Codex', providerMetadata: { openai: { itemId: 'msg_1' } } },
		])
		expect(result.finishReason).toEqual({ unified: 'stop', raw: undefined })
		expect(result.usage).toEqual({
			inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: undefined },
			outputTokens: { total: 4, text: 3, reasoning: 1 },
		})
	})

	test('refreshes expired oauth auth before the request', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'expired-access',
				refreshToken: 'refresh-123',
				expiresAt: 1,
			},
		})
		const seenBodies: string[] = []
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			now: () => 10,
			fetch: async (input, init) => {
				const url = input instanceof URL ? input.toString() : String(input)
				if (url.endsWith('/oauth/token')) {
					seenBodies.push(String(init?.body))
					return Response.json({ access_token: 'fresh-access', refresh_token: 'refresh-456', expires_in: 60 })
				}
				return createSseResponse([
					{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
				])
			},
		})

		await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] })

		expect(seenBodies[0]).toContain('grant_type=refresh_token')
		expect((await store.get(CODEX_PROVIDER_ID))?.kind).toBe('oauth')
		const refreshed = await store.get(CODEX_PROVIDER_ID)
		if (!refreshed || refreshed.kind !== 'oauth') throw new Error('expected oauth auth')
		expect(refreshed.accessToken).toBe('fresh-access')
		expect(refreshed.refreshToken).toBe('refresh-456')
	})

	test('reconstructs non-stream results from the Codex sse stream', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () =>
				createSseResponse([
					{ type: 'response.created', response: { id: 'resp_2', created_at: 1700000001, model: 'gpt-5.4' } },
					{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
					{ type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Line 1' },
					{ type: 'response.output_text.delta', item_id: 'msg_2', delta: ' and line 2' },
					{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
					{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } },
				]),
		})

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Combine lines' }] }],
		})
		expect(result.content).toEqual([
			{ type: 'text', text: 'Line 1 and line 2', providerMetadata: { openai: { itemId: 'msg_2' } } },
		])
	})

	test('streams Codex SSE parts incrementally instead of buffering the full response', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const { response, releaseTrailing } = createDeferredSseResponse(
			[
				{ type: 'response.created', response: { id: 'resp_stream', created_at: 1700000002, model: 'gpt-5.4' } },
				{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_stream' } },
				{ type: 'response.output_text.delta', item_id: 'msg_stream', delta: 'Hello' },
			],
			[
				{ type: 'response.output_text.delta', item_id: 'msg_stream', delta: ' world' },
				{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_stream' } },
				{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 2 } } },
			],
		)
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () => response,
		})

		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
		})
		const reader = result.stream.getReader()

		expect(await reader.read()).toEqual({ done: false, value: { type: 'stream-start', warnings: [] } })
		expect(await reader.read()).toEqual({
			done: false,
			value: {
				type: 'response-metadata',
				id: 'resp_stream',
				timestamp: new Date(1700000002 * 1000),
				modelId: 'gpt-5.4',
			},
		})
		expect(await reader.read()).toEqual({
			done: false,
			value: {
				type: 'text-start',
				id: 'msg_stream',
				providerMetadata: { openai: { itemId: 'msg_stream' } },
			},
		})
		expect(await reader.read()).toEqual({
			done: false,
			value: { type: 'text-delta', id: 'msg_stream', delta: 'Hello' },
		})

		let pendingResolved = false
		const pendingRead = reader.read().then((value) => {
			pendingResolved = true
			return value
		})
		await sleep(20)
		expect(pendingResolved).toBe(false)

		releaseTrailing()

		expect(await pendingRead).toEqual({
			done: false,
			value: { type: 'text-delta', id: 'msg_stream', delta: ' world' },
		})
		expect(await reader.read()).toEqual({
			done: false,
			value: {
				type: 'text-end',
				id: 'msg_stream',
				providerMetadata: { openai: { itemId: 'msg_stream' } },
			},
		})
		expect(await reader.read()).toEqual({
			done: false,
			value: {
				type: 'finish',
				finishReason: { unified: 'stop', raw: undefined },
				usage: {
					inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 2, text: 2, reasoning: undefined },
				},
			},
		})
		expect(await reader.read()).toEqual({ done: true, value: undefined })
		expect(result.response).toEqual({ headers: { 'content-type': 'text/event-stream' } })
	})

	test('buildCodexHeaders strips caller authorization headers', () => {
		const headers = buildCodexHeaders({
			auth: { kind: 'api', apiKey: 'server-key' },
			version: '2.0.0',
			callerHeaders: {
				authorization: 'Bearer caller-key',
				Authorization: 'Bearer other',
				'x-test': 'ok',
			},
		})

		expect(headers.authorization).toBe('Bearer server-key')
		expect(headers['x-test']).toBe('ok')
		expect(headers['user-agent']).toBe(buildCodexUserAgent('2.0.0'))
	})

	test('generateText reconstructs reasoning summaries for non-stream callers', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () =>
				createSseResponse([
					{ type: 'response.created', response: { id: 'resp_reason', created_at: 1700000003, model: 'gpt-5.4' } },
					{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-final' } },
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
					{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'First thought.' },
					{ type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 0 },
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
					{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 1, delta: 'Second thought.' },
					{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-final' } },
					{ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_3', phase: 'final_answer' } },
					{ type: 'response.output_text.delta', item_id: 'msg_3', delta: 'Answer.' },
					{ type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_3', phase: 'final_answer' } },
					{ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 5 } } },
				]),
		})

		const result = await generateText({
			model,
			prompt: 'Think through this.',
			providerOptions: {
				openai: {
					store: false,
					reasoningSummary: 'auto',
					include: ['reasoning.encrypted_content'],
				},
			},
		})

		expect(result.reasoning).toEqual([
			{
				type: 'reasoning',
				text: 'First thought.',
				providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-final' } },
			},
			{
				type: 'reasoning',
				text: 'Second thought.',
				providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-final' } },
			},
		])
		expect(result.reasoningText).toBe('First thought.Second thought.')
		expect(result.text).toBe('Answer.')
	})

	test('streamText fullStream emits reasoning events before final text', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () =>
				createSseResponse([
					{ type: 'response.created', response: { id: 'resp_stream_reason', created_at: 1700000004, model: 'gpt-5.4' } },
					{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_stream', encrypted_content: 'enc-stream' } },
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_stream', summary_index: 0 },
					{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_stream', summary_index: 0, delta: 'Think aloud.' },
					{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_stream', encrypted_content: 'enc-stream' } },
					{ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_stream_reason', phase: 'commentary' } },
					{ type: 'response.output_text.delta', item_id: 'msg_stream_reason', delta: 'Final answer.' },
					{ type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_stream_reason', phase: 'commentary' } },
					{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } },
				]),
		})

		const result = streamText({
			model,
			prompt: 'Explain it.',
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

		expect(parts.map((part) => part.type)).toEqual([
			'start',
			'start-step',
			'reasoning-start',
			'reasoning-delta',
			'reasoning-end',
			'text-start',
			'text-delta',
			'text-end',
			'finish-step',
			'finish',
		])
		const reasoningStart = parts.find((part) => part.type === 'reasoning-start')
		const reasoningDelta = parts.find((part) => part.type === 'reasoning-delta')
		const reasoningEnd = parts.find((part) => part.type === 'reasoning-end')
		const textDelta = parts.find((part) => part.type === 'text-delta')
		const textStartIndex = parts.findIndex((part) => part.type === 'text-start')
		const reasoningEndIndex = parts.findIndex((part) => part.type === 'reasoning-end')

		expect(reasoningStart).toMatchObject({
			type: 'reasoning-start',
			id: 'rs_stream:0',
			providerMetadata: { openai: { itemId: 'rs_stream', reasoningEncryptedContent: 'enc-stream' } },
		})
		expect(reasoningDelta).toMatchObject({
			type: 'reasoning-delta',
			id: 'rs_stream:0',
			text: 'Think aloud.',
		})
		expect(reasoningEnd).toMatchObject({
			type: 'reasoning-end',
			id: 'rs_stream:0',
			providerMetadata: { openai: { itemId: 'rs_stream', reasoningEncryptedContent: 'enc-stream' } },
		})
		expect(textDelta).toMatchObject({ type: 'text-delta', text: 'Final answer.' })
		expect(reasoningEndIndex).toBeLessThan(textStartIndex)
		expect(await result.reasoningText).toBe('Think aloud.')
		expect(await result.text).toBe('Final answer.')
	})
})
