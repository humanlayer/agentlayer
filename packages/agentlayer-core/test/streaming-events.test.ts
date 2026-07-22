import { describe, expect, test } from 'bun:test'
import type { LanguageModelV3, LanguageModelV3Reasoning, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCalls, mockResponse, mockStreamingModel, userMessage } from './mocks'

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo input',
	input: z.object({ text: z.string() }),
	execute: async (input) => input.text,
})

const bashTool = defineTool({
	name: 'bash',
	description: 'Run bash',
	input: z.object({ command: z.string() }),
	execute: async () => 'ok',
})

describe('streaming events', () => {
	test('selects one stable effective prompt cache key per Agent', async () => {
		const seenKeys: string[] = []
		let factoryCalls = 0
		const usage = {
			inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 0, text: 0, reasoning: 0 },
		}
		const model = new MockLanguageModelV3({
			provider: 'mock',
			modelId: 'mock-model',
			supportedUrls: {},
			doStream: async (options) => {
				seenKeys.push(
					(options.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey ?? '',
				)
				const chunks: LanguageModelV3StreamPart[] = [
					{ type: 'stream-start', warnings: [] },
					{ type: 'text-start', id: 'text-1' },
					{ type: 'text-delta', id: 'text-1', delta: 'done' },
					{ type: 'text-end', id: 'text-1' },
					{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
				]

				return {
					stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
				}
			},
		})
		const agent = new Agent({
			model,
			tools: { echo: echoTool },
			providerOptions: ({ promptCacheKey }) => {
				factoryCalls++
				return { openai: { promptCacheKey } }
			},
		})

		const first = await agent.run({ state: startState([userMessage('go')]) }).result
		await agent.run({
			state: { ...first.state, messages: [...first.state.messages, userMessage('go again')] },
		}).result

		expect(factoryCalls).toBe(2)
		expect(seenKeys).toHaveLength(2)
		expect(seenKeys[0]).toBeString()
		expect(seenKeys[1]).toBe(seenKeys[0])

		const configured = new Agent({
			model,
			tools: { echo: echoTool },
			promptCacheKey: 'configured-key',
			providerOptions: ({ promptCacheKey }) => ({ openai: { promptCacheKey } }),
		})
		await configured.run({ state: startState([userMessage('configured')]) }).result
		await configured.run({ state: startState([userMessage('override')]), promptCacheKey: 'run-key' }).result

		const other = new Agent({
			model,
			tools: { echo: echoTool },
			providerOptions: ({ promptCacheKey }) => ({ openai: { promptCacheKey } }),
		})
		await other.run({ state: startState([userMessage('other')]) }).result

		expect(seenKeys.slice(2)).toEqual(['configured-key', 'run-key', expect.any(String)])
		expect(seenKeys[4]).not.toBe(seenKeys[0])
	})

	test('passes the same effective prompt cache key to provider options and tools', async () => {
		let providerKey: string | undefined
		let toolKey: string | undefined
		const inspect = defineTool({
			name: 'inspect',
			description: 'Inspect context',
			input: z.object({}),
			execute: async (_input, ctx) => {
				toolKey = ctx.promptCacheKey
				return 'ok'
			},
		})
		const agent = new Agent({
			model: mockStreamingModel([
				assistantWithToolCalls({ toolName: 'inspect', input: {} }),
				assistantText('done'),
			]),
			tools: { inspect },
			promptCacheKey: 'shared-key',
			providerOptions: ({ promptCacheKey }) => {
				providerKey = promptCacheKey
				return {}
			},
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(providerKey).toBe('shared-key')
		expect(toolKey).toBe(providerKey)
	})

	test('stream=true emits root text events in order and preserves final transcript parity', async () => {
		const responses = [assistantWithToolCalls({ toolName: 'echo', input: { text: 'hi' } }), assistantText('Done.')]
		const streamingAgent = new Agent({
			model: mockStreamingModel(responses),
			tools: { echo: echoTool },
		})
		const nonStreamingAgent = new Agent({
			model: mockStreamingModel(responses),
			tools: { echo: echoTool },
		})

		const run = streamingAgent.run({ state: startState([userMessage('go')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const streamingResult = await run.result
		const nonStreamingResult = await nonStreamingAgent.run({
			state: startState([userMessage('go')]),
			stream: false,
		}).result

		const eventTypes = events.map((event) => event.type)
		expect(eventTypes).toEqual([
			'stepStart',
			'toolInputStart',
			'toolInputDelta',
			'toolInputEnd',
			'stepFinish',
			'message',
			'tokenUsage',
			'message',
			'stepStart',
			'textStart',
			'textDelta',
			'textEnd',
			'stepFinish',
			'message',
			'tokenUsage',
		])

		const firstStepStartIndex = eventTypes.indexOf('stepStart')
		const firstStepFinishIndex = eventTypes.indexOf('stepFinish')
		const secondStepStartIndex = eventTypes.lastIndexOf('stepStart')
		const secondStepFinishIndex = eventTypes.lastIndexOf('stepFinish')
		expect(firstStepStartIndex).toBeLessThan(firstStepFinishIndex)
		expect(firstStepFinishIndex).toBeLessThan(eventTypes.indexOf('message'))
		expect(secondStepStartIndex).toBeLessThan(eventTypes.indexOf('textStart'))
		expect(eventTypes.indexOf('textStart')).toBeLessThan(eventTypes.indexOf('textDelta'))
		expect(eventTypes.indexOf('textDelta')).toBeLessThan(eventTypes.indexOf('textEnd'))
		expect(eventTypes.indexOf('textEnd')).toBeLessThan(secondStepFinishIndex)

		const textDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> => event.type === 'textDelta',
		)
		expect(textDelta?.stepIndex).toBe(1)
		expect(textDelta?.text).toBe('Done.')
		expect(streamingResult.state.messages).toEqual(nonStreamingResult.state.messages)
		expect(streamingResult.newMessages).toEqual(nonStreamingResult.newMessages)
		expect(streamingResult.finishReason).toBe(nonStreamingResult.finishReason)
	})

	test('stream=true emits reasoning deltas and only persists the finalized assistant message', async () => {
		const reasoningPart: LanguageModelV3Reasoning = {
			type: 'reasoning',
			text: 'Thinking...',
			providerMetadata: {
				openai: {
					itemId: 'rs_stream_123',
					reasoningEncryptedContent: 'enc_stream_123',
				},
			},
		}
		const agent = new Agent({
			model: mockStreamingModel([mockResponse([reasoningPart]), assistantText('Done thinking.')]),
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('think')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		expect(events.map((event) => event.type)).toEqual([
			'stepStart',
			'reasoningStart',
			'reasoningDelta',
			'reasoningEnd',
			'stepFinish',
			'message',
			'tokenUsage',
			'stepStart',
			'textStart',
			'textDelta',
			'textEnd',
			'stepFinish',
			'message',
			'tokenUsage',
		])

		const reasoningEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: 'reasoningDelta' }> => event.type === 'reasoningDelta',
		)
		expect(reasoningEvents).toHaveLength(1)
		expect(reasoningEvents[0]).toMatchObject({ type: 'reasoningDelta', text: 'Thinking...', stepIndex: 0 })
		expect(events.some((event) => event.type === 'textDelta')).toBe(true)

		const result = await run.result
		expect(result.newMessages).toHaveLength(2)
		expect(result.newMessages[0]).toMatchObject({
			role: 'assistant',
			content: [
				{
					type: 'reasoning',
					text: 'Thinking...',
					providerOptions: {
						openai: {
							itemId: 'rs_stream_123',
							reasoningEncryptedContent: 'enc_stream_123',
						},
					},
				},
			],
		})
		expect(result.newMessages[1]).toMatchObject({
			role: 'assistant',
			content: [{ type: 'text', text: 'Done thinking.' }],
		})
		expect(result.state.messages).toEqual([userMessage('think'), result.newMessages[0]!, result.newMessages[1]!])
	})

	test('stream=true emits tool input start/delta/end events for streamed tool args', async () => {
		const agent = new Agent({
			model: mockStreamingModel([
				mockResponse([
					{
						type: 'tool-call',
						toolCallId: 'call-bash-1',
						toolName: 'bash',
						input: JSON.stringify({ command: 'echo hi' }),
					},
				]),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
		})

		const run = agent.run({ state: startState([userMessage('run bash')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const eventTypes = events.map((event) => event.type)
		expect(eventTypes).toContain('toolInputStart')
		expect(eventTypes).toContain('toolInputDelta')
		expect(eventTypes).toContain('toolInputEnd')

		const toolInputStart = events.find(
			(event): event is Extract<AgentEvent, { type: 'toolInputStart' }> => event.type === 'toolInputStart',
		)
		const toolInputDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'toolInputDelta' }> => event.type === 'toolInputDelta',
		)
		const toolInputEnd = events.find(
			(event): event is Extract<AgentEvent, { type: 'toolInputEnd' }> => event.type === 'toolInputEnd',
		)

		expect(toolInputStart).toMatchObject({ toolName: 'bash', stepIndex: 0 })
		expect(toolInputDelta?.delta).toContain('echo hi')
		expect(toolInputEnd?.id).toBe(toolInputStart?.id)
	})

	test('stream=true surfaces provider error in run result when doStream throws', async () => {
		const failingModel: LanguageModelV3 = new MockLanguageModelV3({
			provider: 'mock',
			modelId: 'mock-failing',
			supportedUrls: {},
			doStream: async () => {
				throw new Error('API rate limit exceeded: 429')
			},
		})

		const agent = new Agent({ model: failingModel, tools: {} })
		const run = agent.run({ state: startState([userMessage('hello')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.message).toContain('API rate limit exceeded: 429')
	})

	test('stream=true surfaces stream error from provider stream that closes without finish', async () => {
		const errorModel: LanguageModelV3 = new MockLanguageModelV3({
			provider: 'mock',
			modelId: 'mock-error-stream',
			supportedUrls: {},
			doStream: async () => ({
				stream: new ReadableStream<LanguageModelV3StreamPart>({
					start(controller) {
						controller.enqueue({ type: 'stream-start', warnings: [] })
						controller.error(new Error('Connection reset by peer'))
					},
				}),
			}),
		})

		const agent = new Agent({ model: errorModel, tools: {} })
		const run = agent.run({ state: startState([userMessage('hello')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.message).toContain('Connection reset by peer')
	})
})
