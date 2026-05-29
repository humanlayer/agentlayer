import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Agent, extractLastAssistantText, startState, userMessage } from '@humanlayer/agentlayer-core'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { generateText, jsonSchema, streamText } from 'ai'
import {
	buildCodexHeaders,
	buildCodexUserAgent,
	CODEX_API_ENDPOINT,
	CODEX_PROVIDER,
	CODEX_PROVIDER_ID,
	createCodexLanguageModel,
	createCodexProvider,
} from '../src/legacy'

function encodeSseEvents(events: unknown[], includeDone = true): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}${includeDone ? 'data: [DONE]\n\n' : ''}`
}

function createSseResponse(events: unknown[]): Response {
	return new Response(encodeSseEvents(events), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

const CODEX_REASONING_ONLY_REPRO_PROMPT =
	'can you think about how I coul ddesign a code mode to allow an agent to write and execute y.js code in a sandbox to execute commands to apply edits to a live y.js doc and then outline to me ways that we could approach the problem?'

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'agentlayer-codex-'))
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
	test('createCodexProvider defaults to the disk-backed auth store', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		await fs.writeFile(
			filePath,
			JSON.stringify({
				codex: {
					kind: 'oauth',
					accessToken: 'disk-access',
					accountId: 'acct_disk',
				},
			}),
		)
		const previousAuthPath = process.env.AGENTLAYER_AUTH_PATH
		process.env.AGENTLAYER_AUTH_PATH = filePath
		const calls: Array<{ url: string; init?: RequestInit }> = []

		try {
			const provider = createCodexProvider({
				version: '1.2.3',
				fetch: async (input, init) => {
					calls.push({ url: input instanceof URL ? input.toString() : String(input), init })
					return createSseResponse([
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: { type: 'message', id: 'msg_disk' },
						},
						{ type: 'response.output_text.delta', item_id: 'msg_disk', delta: 'Hello from disk' },
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: { type: 'message', id: 'msg_disk' },
						},
						{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
					])
				},
			})

			const result = await provider.languageModel('gpt-5.4').doGenerate({
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
			})

			expect(calls).toHaveLength(1)
			const headers = new Headers(calls[0]?.init?.headers)
			expect(headers.get('authorization')).toBe('Bearer disk-access')
			expect(headers.get('ChatGPT-Account-Id')).toBe('acct_disk')
			expect(result.content).toEqual([
				{ type: 'text', text: 'Hello from disk', providerMetadata: { openai: { itemId: 'msg_disk' } } },
			])
		} finally {
			if (previousAuthPath === undefined) {
				delete process.env.AGENTLAYER_AUTH_PATH
			} else {
				process.env.AGENTLAYER_AUTH_PATH = previousAuthPath
			}
		}
	})

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
		expect(headers.get('session-id')).toBe('session-abc')
		expect(headers.get('User-Agent')).toBe(buildCodexUserAgent('1.2.3'))
		expect(headers.get('x-extra')).toBe('extra-header')

		expect(result.content).toEqual([
			{
				type: 'text',
				text: 'Hello from Codex',
				providerMetadata: { openai: { itemId: 'msg_1', responseId: 'resp_1' } },
			},
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
			{
				type: 'text',
				text: 'Line 1 and line 2',
				providerMetadata: { openai: { itemId: 'msg_2', responseId: 'resp_2' } },
			},
		])
	})

	test('Agent run persists assistant item ids so follow-up requests replay them', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const requestBodies: Array<Record<string, unknown>> = []
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async (_input, init) => {
				requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
				if (requestBodies.length === 1) {
					return createSseResponse([
						{
							type: 'response.created',
							response: { id: 'resp_first', created_at: 1700000001, model: 'gpt-5.4' },
						},
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: { type: 'message', id: 'msg_first' },
						},
						{ type: 'response.output_text.delta', item_id: 'msg_first', delta: 'First answer' },
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: { type: 'message', id: 'msg_first' },
						},
						{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 2 } } },
					])
				}

				return createSseResponse([
					{
						type: 'response.created',
						response: { id: 'resp_second', created_at: 1700000002, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'message', id: 'msg_second' },
					},
					{ type: 'response.output_text.delta', item_id: 'msg_second', delta: 'Second answer' },
					{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_second' } },
					{ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
				])
			},
		})

		const agent = new Agent({
			model,
			tools: {},
			providerOptions: { openai: { include: ['reasoning.encrypted_content'] } },
		})
		const first = await agent.run({ state: startState([userMessage('Hello')]), stream: false }).result
		const second = await agent.run({
			state: startState([...first.state.messages, userMessage('Follow up')]),
			stream: false,
		}).result

		const assistantMessages = first.state.messages.filter((message) => message.role === 'assistant')
		const persistedAssistant = assistantMessages.at(-1) as
			| { content?: Array<{ providerOptions?: Record<string, unknown> }> }
			| undefined

		expect(requestBodies).toHaveLength(2)
		expect(requestBodies[0]?.previous_response_id).toBeUndefined()
		expect(requestBodies[1]?.previous_response_id).toBeUndefined()
		expect(requestBodies[1]?.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
			{ role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }] },
			{ role: 'user', content: [{ type: 'input_text', text: 'Follow up' }] },
		])
		expect(persistedAssistant?.content?.[0]?.providerOptions).toEqual({
			openai: { itemId: 'msg_first', responseId: 'resp_first' },
		})
		expect(second.state.messages.at(-1)).toMatchObject({
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Second answer', providerOptions: { openai: { responseId: 'resp_second' } } },
			],
		})
	})

	test('Agent continues after reasoning-only response by replaying reasoning input when store is false', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const requestBodies: Array<Record<string, unknown>> = []
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async (_input, init) => {
				requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
				if (requestBodies.length === 1) {
					return createSseResponse([
						{
							type: 'response.created',
							response: { id: 'resp_reason_only', created_at: 1700000010, model: 'gpt-5.4' },
						},
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: { type: 'reasoning', id: 'rs_only', encrypted_content: 'enc-only' },
						},
						{ type: 'response.reasoning_summary_part.added', item_id: 'rs_only', summary_index: 0 },
						{
							type: 'response.reasoning_summary_text.delta',
							item_id: 'rs_only',
							summary_index: 0,
							delta: 'Thought.',
						},
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: { type: 'reasoning', id: 'rs_only', encrypted_content: 'enc-only' },
						},
						{
							type: 'response.completed',
							response: {
								usage: {
									input_tokens: 2,
									output_tokens: 3,
									output_tokens_details: { reasoning_tokens: 3 },
								},
							},
						},
					])
				}

				return createSseResponse([
					{
						type: 'response.created',
						response: { id: 'resp_final', created_at: 1700000011, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'message', id: 'msg_final', phase: 'final_answer' },
					},
					{ type: 'response.output_text.delta', item_id: 'msg_final', delta: 'Final answer.' },
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: { type: 'message', id: 'msg_final', phase: 'final_answer' },
					},
					{ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
				])
			},
		})

		const agent = new Agent({
			model,
			tools: {},
			providerOptions: {
				openai: { store: false, reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] },
			},
		})
		const result = await agent.run({
			state: startState([userMessage(CODEX_REASONING_ONLY_REPRO_PROMPT)]),
			stream: false,
		}).result

		expect(result.finishReason).toBe('complete')
		expect(extractLastAssistantText(result)).toBe('Final answer.')
		expect(requestBodies).toHaveLength(2)
		expect(requestBodies[1]?.input).toEqual([
			{ role: 'user', content: [{ type: 'input_text', text: CODEX_REASONING_ONLY_REPRO_PROMPT }] },
			{
				type: 'reasoning',
				encrypted_content: 'enc-only',
				summary: [{ type: 'summary_text', text: 'Thought.' }],
			},
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
				providerMetadata: { openai: { itemId: 'msg_stream', responseId: 'resp_stream' } },
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
				providerMetadata: { openai: { itemId: 'msg_stream', responseId: 'resp_stream' } },
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
				providerMetadata: { openai: { responseId: 'resp_stream' } },
			},
		})
		expect(await reader.read()).toEqual({ done: true, value: undefined })
		expect(result.response).toEqual({ headers: { 'content-type': 'text/event-stream' } })
	})

	test('streamText fullStream emits Codex function calls and arguments', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () =>
				createSseResponse([
					{
						type: 'response.created',
						response: { id: 'resp_tool', created_at: 1700000014, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
					},
					{
						type: 'response.function_call_arguments.delta',
						output_index: 0,
						item_id: 'fc_1',
						delta: '{"filePath"',
					},
					{
						type: 'response.function_call_arguments.delta',
						output_index: 0,
						item_id: 'fc_1',
						delta: ':"README.md"}',
					},
					{
						type: 'response.function_call_arguments.done',
						output_index: 0,
						item_id: 'fc_1',
						arguments: '{"filePath":"README.md"}',
					},
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: {
							type: 'function_call',
							id: 'fc_1',
							call_id: 'call_1',
							name: 'read',
							arguments: '{"filePath":"README.md"}',
						},
					},
					{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } },
				]),
		})

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

		expect(parts.map((part) => part.type)).toContain('tool-input-start')
		expect(parts.map((part) => part.type)).toContain('tool-input-delta')
		expect(parts.map((part) => part.type)).toContain('tool-call')
		expect(await result.toolCalls).toMatchObject([
			{ type: 'tool-call', toolCallId: 'call_1', toolName: 'read', input: { filePath: 'README.md' } },
		])
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
					{
						type: 'response.created',
						response: { id: 'resp_reason', created_at: 1700000003, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-final' },
					},
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
					{
						type: 'response.reasoning_summary_text.delta',
						item_id: 'rs_1',
						summary_index: 0,
						delta: 'First thought.',
					},
					{ type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 0 },
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 1 },
					{
						type: 'response.reasoning_summary_text.delta',
						item_id: 'rs_1',
						summary_index: 1,
						delta: 'Second thought.',
					},
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-final' },
					},
					{
						type: 'response.output_item.added',
						output_index: 1,
						item: { type: 'message', id: 'msg_3', phase: 'final_answer' },
					},
					{ type: 'response.output_text.delta', item_id: 'msg_3', delta: 'Answer.' },
					{
						type: 'response.output_item.done',
						output_index: 1,
						item: { type: 'message', id: 'msg_3', phase: 'final_answer' },
					},
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
				providerMetadata: {
					openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-final', responseId: 'resp_reason' },
				},
			},
			{
				type: 'reasoning',
				text: 'Second thought.',
				providerMetadata: {
					openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-final', responseId: 'resp_reason' },
				},
			},
		])
		expect(result.reasoningText).toBe('First thought.Second thought.')
		expect(result.text).toBe('Answer.')
		expect(result.providerMetadata).toEqual({ openai: { responseId: 'resp_reason' } })
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
					{
						type: 'response.created',
						response: { id: 'resp_stream_reason', created_at: 1700000004, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_stream', encrypted_content: 'enc-stream' },
					},
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_stream', summary_index: 0 },
					{
						type: 'response.reasoning_summary_text.delta',
						item_id: 'rs_stream',
						summary_index: 0,
						delta: 'Think aloud.',
					},
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_stream', encrypted_content: 'enc-stream' },
					},
					{
						type: 'response.output_item.added',
						output_index: 1,
						item: { type: 'message', id: 'msg_stream_reason', phase: 'commentary' },
					},
					{ type: 'response.output_text.delta', item_id: 'msg_stream_reason', delta: 'Final answer.' },
					{
						type: 'response.output_item.done',
						output_index: 1,
						item: { type: 'message', id: 'msg_stream_reason', phase: 'commentary' },
					},
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

	test('streamText response messages preserve encrypted reasoning metadata for agent state', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const model = createCodexLanguageModel({
			modelId: 'gpt-5.4',
			authStore: store,
			fetch: async () =>
				createSseResponse([
					{
						type: 'response.created',
						response: { id: 'resp_state_reason', created_at: 1700000005, model: 'gpt-5.4' },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_state', encrypted_content: 'enc-state' },
					},
					{ type: 'response.reasoning_summary_part.added', item_id: 'rs_state', summary_index: 0 },
					{
						type: 'response.reasoning_summary_text.delta',
						item_id: 'rs_state',
						summary_index: 0,
						delta: 'Stored thought.',
					},
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: { type: 'reasoning', id: 'rs_state', encrypted_content: 'enc-state' },
					},
					{
						type: 'response.output_item.added',
						output_index: 1,
						item: { type: 'message', id: 'msg_state', phase: 'final_answer' },
					},
					{ type: 'response.output_text.delta', item_id: 'msg_state', delta: 'Saved answer.' },
					{
						type: 'response.output_item.done',
						output_index: 1,
						item: { type: 'message', id: 'msg_state', phase: 'final_answer' },
					},
					{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } },
				]),
		})

		const result = streamText({
			model,
			prompt: 'Persist this.',
			providerOptions: {
				openai: {
					store: false,
					reasoningSummary: 'auto',
					include: ['reasoning.encrypted_content'],
				},
			},
		})

		const response = await result.response
		const providerMetadata = await result.providerMetadata
		expect(response.messages).toHaveLength(1)
		expect(response.messages[0]).toMatchObject({
			role: 'assistant',
			content: [
				{
					type: 'reasoning',
					text: 'Stored thought.',
					providerOptions: {
						openai: {
							itemId: 'rs_state',
							reasoningEncryptedContent: 'enc-state',
							responseId: 'resp_state_reason',
						},
					},
				},
				{
					type: 'text',
					text: 'Saved answer.',
					providerOptions: {
						openai: {
							itemId: 'msg_state',
							phase: 'final_answer',
							responseId: 'resp_state_reason',
						},
					},
				},
			],
		})
		expect(providerMetadata).toEqual({ openai: { responseId: 'resp_state_reason' } })
	})
})
