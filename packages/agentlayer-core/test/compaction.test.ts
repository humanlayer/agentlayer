import { describe, expect, test } from 'bun:test'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { Agent, type AgentEvent, COMPACTION_SYSTEM_PROMPT, startState, toolCall, toolResult } from '../src'
import { ModelProvider } from '../src/models'
import { createForkState } from '../src/tools/subagent-fork'
import { assistantText, mockModel, userMessage } from './mocks'

const usage = {
	inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 },
	outputTokens: { total: 30, text: 25, reasoning: 5 },
}

type ScriptedResponse = { text: string; usage?: typeof usage } | { error: Error }

function scriptedModel(script: ScriptedResponse[], calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
	let index = 0
	return new MockLanguageModelV3({
		provider: 'mock',
		modelId: 'scripted',
		supportedUrls: {},
		doStream: async (options): Promise<LanguageModelV3StreamResult> => {
			calls.push(options)
			const response = script[index++]
			if (!response) throw new Error(`No scripted response for call ${index}`)
			const chunks: LanguageModelV3StreamPart[] =
				'error' in response
					? [
							{ type: 'stream-start', warnings: [] },
							{ type: 'error', error: response.error },
							{ type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage },
						]
					: [
							{ type: 'stream-start', warnings: [] },
							{ type: 'text-start', id: `text-${index}` },
							{ type: 'text-delta', id: `text-${index}`, delta: response.text },
							{ type: 'text-end', id: `text-${index}` },
							{
								type: 'finish',
								finishReason: { unified: 'stop', raw: 'stop' },
								usage: response.usage ?? usage,
							},
						]
			return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }
		},
	})
}

function callContains(call: LanguageModelV3CallOptions, text: string): boolean {
	return JSON.stringify(call.prompt).includes(text)
}

function spySummaryModel(calls: LanguageModelV3CallOptions[]): LanguageModelV3 {
	return new MockLanguageModelV3({
		provider: 'mock',
		modelId: 'summary-model',
		supportedUrls: {},
		doStream: async (options) => {
			calls.push(options)
			const chunks: LanguageModelV3StreamPart[] = [
				{ type: 'stream-start', warnings: [] },
				{ type: 'text-start', id: 'summary' },
				{ type: 'text-delta', id: 'summary', delta: '## Goal\nShip compaction.' },
				{ type: 'text-end', id: 'summary' },
				{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
			]
			return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }
		},
	})
}

describe('Agent.compact()', () => {
	test('atomically replaces a prefix, emits inference and metadata, and accounts for usage', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const providerFactoryCalls: Array<{ runId: string; promptCacheKey?: string }> = []
		const agent = new Agent({
			model: spySummaryModel(calls),
			tools: {},
			promptCacheKey: 'normal-cache-scope',
			providerOptions: (context) => {
				providerFactoryCalls.push(context)
				return { openai: { promptCacheKey: context.promptCacheKey, reasoningEffort: 'high' } }
			},
			autoCompact: { keepRecentTokens: 6 },
			contextWindowLimit: 200_000,
		})
		const input = {
			...startState([
				userMessage('old user'),
				{ role: 'assistant' as const, content: 'old assistant' },
				userMessage('new user'),
				{ role: 'assistant' as const, content: 'new assistant' },
			]),
			contextWindowTokens: 150_000,
		}
		const originalJson = JSON.stringify(input)
		const run = agent.compact({ state: input, additionalInstructions: 'Focus on unresolved blockers.' })
		const events: AgentEvent[] = []
		for await (const event of run) events.push(event)
		const result = await run.result

		expect(result.error).toBeUndefined()
		expect(result.finishReason).toBe('complete')
		expect(JSON.stringify(input)).toBe(originalJson)
		expect(result.state).not.toBe(input)
		expect(result.state.contextWindowTokens).toBeUndefined()
		expect(result.state.messages).toEqual([
			{ role: 'user', content: '<conversation-summary>\n## Goal\nShip compaction.\n</conversation-summary>' },
			input.messages[2]!,
			input.messages[3]!,
		])
		expect(result.state.compaction).toMatchObject({
			version: 1,
			summary: '## Goal\nShip compaction.',
			trigger: 'manual',
			replacedMessageCount: 2,
			retainedMessageCount: 2,
			totalReplacedMessageCount: 2,
			priorContextWindowTokens: 150_000,
		})

		expect(calls).toHaveLength(1)
		expect(calls[0]!.tools).toBeUndefined()
		expect(calls[0]!.toolChoice).toBeUndefined()
		expect(calls[0]!.maxOutputTokens).toBe(13_107)
		expect(calls[0]!.prompt[0] as { role: string; content: string }).toEqual({
			role: 'system',
			content: COMPACTION_SYSTEM_PROMPT,
		})
		expect(calls[0]!.providerOptions).toEqual({
			openai: { promptCacheKey: 'normal-cache-scope', reasoningEffort: 'high' },
		})
		expect(providerFactoryCalls).toHaveLength(1)
		expect(providerFactoryCalls[0]!.promptCacheKey).toBe('normal-cache-scope')

		expect(result.newMessages).toHaveLength(2)
		expect(result.newMessages[0]).toMatchObject({ role: 'user' })
		expect(String(result.newMessages[0]!.content)).toContain('Additional user guidance')
		expect(result.newMessages[1]).toMatchObject({
			role: 'assistant',
			content: [{ type: 'text', text: '## Goal\nShip compaction.' }],
		})
		expect(events.map((event) => event.type)).toEqual(['message', 'message', 'compaction'])
		const event = events[2]
		expect(event).toMatchObject({
			type: 'compaction',
			trigger: 'manual',
			priorContextWindowTokens: 150_000,
			replacedMessageCount: 2,
			retainedMessageCount: 2,
			summaryUsage: { model: 'mock/summary-model', usage: { inputTokens: 120, outputTokens: 30 } },
		})
		expect(result.tokenUsage.totals).toMatchObject({ inputTokens: 120, outputTokens: 30, reasoningTokens: 5 })
	})

	test('uses checkpoint metadata for an incremental summary and preserves unrelated state', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const agent = new Agent({
			model: scriptedModel([{ text: 'first summary' }, { text: 'updated summary' }], calls),
			tools: {},
			autoCompact: {
				keepRecentTokens: 2,
				compactionPrompt: 'Initial override template.',
				compactionUpdatePrompt: 'Incremental override template.',
			},
		})
		const first = await agent.compact({
			state: {
				messages: [
					userMessage('a'),
					{ role: 'assistant', content: 'ok' },
					userMessage('b'),
					{ role: 'assistant', content: 'ok' },
				],
				toolState: { durable: true },
			},
		}).result
		const continued = {
			...first.state,
			messages: [...first.state.messages, userMessage('c'), { role: 'assistant' as const, content: 'ok' }],
		}
		const second = await agent.compact({ state: continued }).result

		expect(second.finishReason).toBe('complete')
		expect(callContains(calls[0]!, 'Initial override template.')).toBe(true)
		expect(callContains(calls[0]!, 'Incremental override template.')).toBe(false)
		expect(callContains(calls[1]!, 'Incremental override template.')).toBe(true)
		expect(callContains(calls[1]!, 'Initial override template.')).toBe(false)
		expect(String(second.newMessages[0]!.content)).toContain(
			'<previous-summary>\nfirst summary\n</previous-summary>',
		)
		expect(second.state.compaction?.summary).toBe('updated summary')
		expect(second.state.compaction?.totalReplacedMessageCount).toBeGreaterThan(
			first.state.compaction!.totalReplacedMessageCount,
		)
		expect(second.state.toolState).toEqual({ durable: true })
	})

	test('clones checkpoint metadata only when fork projection retains its canonical summary', () => {
		const state = {
			messages: [
				userMessage('<conversation-summary>\nsummary\n</conversation-summary>'),
				userMessage('recent work'),
			],
			compaction: {
				version: 1 as const,
				summary: 'summary',
				trigger: 'manual' as const,
				replacedMessageCount: 4,
				retainedMessageCount: 1,
				totalReplacedMessageCount: 4,
			},
		}

		const fullFork = createForkState(state, 'all', 'missing-invocation', 'delegated task')
		expect(fullFork.compaction).toEqual(state.compaction)
		expect(fullFork.compaction).not.toBe(state.compaction)

		const emptyFork = createForkState(state, 'none', 'missing-invocation', 'delegated task')
		expect(emptyFork.compaction).toBeUndefined()
	})

	test('leaves the exact input state untouched on empty summary and provider failure', async () => {
		const state = startState([
			userMessage('old'),
			{ role: 'assistant', content: 'old answer' },
			userMessage('new'),
			{ role: 'assistant', content: 'new answer' },
		])
		const emptyAgent = new Agent({
			model: mockModel([assistantText('   ')]),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		})
		const empty = await emptyAgent.compact({ state }).result
		expect(empty.finishReason).toBe('error')
		expect(empty.error?.message).toContain('empty summary')
		expect(empty.state).toBe(state)
		expect(empty.newMessages).toEqual([])
		expect(empty.tokenUsage.totals).toMatchObject({ inputTokens: 0, outputTokens: 0 })

		const failingModel = new MockLanguageModelV3({
			provider: 'mock',
			modelId: 'failing',
			supportedUrls: {},
			doStream: async () => ({
				stream: simulateReadableStream<LanguageModelV3StreamPart>({
					chunks: [
						{ type: 'stream-start', warnings: [] },
						{ type: 'error', error: new Error('provider unavailable') },
						{ type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage },
					],
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}),
		})
		const failed = await new Agent({
			model: failingModel,
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		}).compact({
			state,
		}).result
		expect(failed.finishReason).toBe('error')
		expect(failed.error?.message).toContain('provider unavailable')
		expect(failed.state).toBe(state)
		expect(failed.newMessages).toEqual([])
	})

	test('accounts summarizer usage when empty output or a later compaction hook fails', async () => {
		const input = {
			...startState([
				userMessage('old'),
				{ role: 'assistant' as const, content: 'old answer' },
				userMessage('recent'),
			]),
			toolState: { durable: true },
			contextWindowTokens: 90,
		}
		const inputJson = JSON.stringify(input)
		const empty = await new Agent({
			model: mockModel([assistantText('   ', { usage })]),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		}).compact({ state: input }).result
		expect(empty.finishReason).toBe('error')
		expect(empty.tokenUsage.totals).toMatchObject({ inputTokens: 120, outputTokens: 30 })
		expect(empty.state).toBe(input)
		expect(JSON.stringify(input)).toBe(inputJson)

		const hookFailure = await new Agent({
			model: mockModel([assistantText('valid summary', { usage })]),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
			hooks: {
				compaction: [
					() => {
						throw new Error('compaction hook failed')
					},
				],
			},
		}).compact({ state: input }).result
		expect(hookFailure.finishReason).toBe('error')
		expect(hookFailure.error?.message).toContain('compaction hook failed')
		expect(hookFailure.tokenUsage.totals).toMatchObject({ inputTokens: 120, outputTokens: 30 })
		expect(hookFailure.state).toBe(input)
		expect(JSON.stringify(input)).toBe(inputJson)
	})

	test('summarizes history and an oversized turn prefix into one atomic checkpoint', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const hookInputs: Array<{ replaced: number; retained: number }> = []
		const input = {
			...startState([
				userMessage('older completed request'),
				{ role: 'assistant' as const, content: 'older completed answer' },
				userMessage('oversized current request'),
				{ role: 'assistant' as const, content: 'early progress' },
				toolCall({ toolCallId: 'large-call', toolName: 'read', input: { path: 'large.ts' } }),
				toolResult({ toolCallId: 'large-call', toolName: 'read', output: 'x'.repeat(400) }),
				{ role: 'assistant' as const, content: 'ok' },
			]),
			toolState: { durable: true },
		}
		const originalJson = JSON.stringify(input)
		const modelProvider = new ModelProvider()
		modelProvider.getModelLimits = () => ({ context: 200_000, output: 10_000 })
		const result = await new Agent({
			model: scriptedModel([{ text: 'history summary' }, { text: 'turn prefix summary' }], calls),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
			modelProvider,
			hooks: {
				compaction: [
					(ctx) => {
						hookInputs.push({
							replaced: ctx.replacedMessages.length,
							retained: ctx.retainedMessages.length,
						})
						return { ...ctx.toolState, reset: true }
					},
				],
			},
		}).compact({ state: input, additionalInstructions: 'Focus on the main history.' }).result

		expect(result.finishReason).toBe('complete')
		expect(JSON.stringify(input)).toBe(originalJson)
		expect(calls).toHaveLength(2)
		expect(calls[0]!.maxOutputTokens).toBe(10_000)
		expect(calls[1]!.maxOutputTokens).toBe(8_192)
		expect(callContains(calls[0]!, 'Focus on the main history.')).toBe(true)
		expect(callContains(calls[1]!, 'Focus on the main history.')).toBe(false)
		expect(callContains(calls[1]!, 'PREFIX of a turn that was too large')).toBe(true)
		expect(result.state.messages).toEqual([
			userMessage(
				'<conversation-summary>\nhistory summary\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix summary\n</conversation-summary>',
			),
			input.messages[6]!,
		])
		expect(result.newMessages).toHaveLength(4)
		expect(result.tokenUsage.totals).toMatchObject({ inputTokens: 240, outputTokens: 60 })
		expect(result.state.compaction).toMatchObject({ replacedMessageCount: 6, retainedMessageCount: 1 })
		expect(hookInputs).toEqual([{ replaced: 6, retained: 1 }])
		expect(result.state.toolState).toEqual({ durable: true, reset: true })
	})

	test('keeps split-turn state atomic when the second summary is empty while accounting for both calls', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const input = startState([
			userMessage('older completed request'),
			{ role: 'assistant', content: 'older completed answer' },
			userMessage('oversized current request'),
			{ role: 'assistant', content: 'x'.repeat(400) },
			{ role: 'assistant', content: 'ok' },
		])
		const result = await new Agent({
			model: scriptedModel([{ text: 'history summary' }, { text: '   ' }], calls),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		}).compact({ state: input }).result

		expect(result.finishReason).toBe('error')
		expect(result.state).toBe(input)
		expect(result.newMessages).toEqual([])
		expect(result.tokenUsage.totals).toMatchObject({ inputTokens: 240, outputTokens: 60 })
		expect(calls).toHaveLength(2)
	})

	test('uses the same configured recent-tail target for programmatic and command compaction', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const agent = new Agent({
			model: scriptedModel(
				[{ text: 'programmatic summary' }, { text: 'command summary' }, { text: 'normal answer' }],
				calls,
			),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		})
		const messages = [
			userMessage('old'),
			{ role: 'assistant' as const, content: 'old answer' },
			userMessage('b'),
			{ role: 'assistant' as const, content: 'ok' },
		]
		const explicit = await agent.compact({ state: startState(messages) }).result
		const command = await agent.run({ state: startState([...messages, userMessage('/compact focus')]) }).result

		expect(explicit.finishReason).toBe('complete')
		expect(command.finishReason).toBe('complete')
		expect(explicit.state.compaction?.retainedMessageCount).toBe(command.state.compaction?.retainedMessageCount)
		expect(explicit.state.messages.slice(1)).toEqual(command.state.messages.slice(1, -1))
		expect(callContains(calls[1]!, 'focus')).toBe(true)
	})
})

describe('automatic loop compaction', () => {
	test('compacts over-threshold state before hooks and aggregates summary usage', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const hookViews: Array<{ messages: string; contextWindowTokens: number }> = []
		const agent = new Agent({
			model: scriptedModel([{ text: 'threshold summary' }, { text: 'normal answer' }], calls),
			tools: {},
			contextWindowLimit: 100,
			autoCompact: { thresholdTokens: 10, keepRecentTokens: 2 },
			hooks: {
				preRequest: [
					(ctx) => {
						hookViews.push({
							messages: JSON.stringify(ctx.messages),
							contextWindowTokens: ctx.contextWindowTokens,
						})
						return ctx.next()
					},
				],
			},
		})
		const result = await agent.run({
			state: {
				messages: [
					userMessage('old user'),
					{ role: 'assistant', content: 'old answer' },
					userMessage('recent user'),
					{ role: 'assistant', content: 'recent answer' },
					userMessage('continue'),
				],
				contextWindowTokens: 12,
			},
		}).result

		expect(result.error).toBeUndefined()
		expect(result.finishReason).toBe('complete')
		expect(calls).toHaveLength(2)
		expect(callContains(calls[0]!, 'old user')).toBe(true)
		expect(callContains(calls[1]!, '<conversation-summary>')).toBe(true)
		expect(callContains(calls[1]!, 'old user')).toBe(false)
		expect(hookViews).toHaveLength(1)
		expect(hookViews[0]!.messages).toContain('<conversation-summary>')
		expect(hookViews[0]!.contextWindowTokens).toBe(0)
		expect(result.state.compaction?.trigger).toBe('threshold')
		expect(result.tokenUsage.totals).toMatchObject({ inputTokens: 240, outputTokens: 60 })
	})

	test('does not compact disabled or stale post-checkpoint usage', async () => {
		const disabledCalls: LanguageModelV3CallOptions[] = []
		const disabledState = {
			messages: [userMessage('old'), { role: 'assistant' as const, content: 'answer' }, userMessage('next')],
			contextWindowTokens: 99,
		}
		const disabled = await new Agent({
			model: scriptedModel([{ text: 'normal' }], disabledCalls),
			tools: {},
			autoCompact: { enabled: false },
			contextWindowLimit: 100,
		}).run({ state: disabledState }).result
		expect(disabled.finishReason).toBe('complete')
		expect(disabledCalls).toHaveLength(1)
		expect(disabled.state.compaction).toBeUndefined()

		const staleCalls: LanguageModelV3CallOptions[] = []
		const stale = await new Agent({
			model: scriptedModel([{ text: 'normal' }], staleCalls),
			tools: {},
			autoCompact: { thresholdTokens: 1 },
		}).run({
			state: {
				messages: [
					userMessage('<conversation-summary>\nprior\n</conversation-summary>'),
					userMessage('recent'),
				],
				compaction: {
					version: 1,
					summary: 'prior',
					trigger: 'threshold',
					replacedMessageCount: 2,
					retainedMessageCount: 1,
					totalReplacedMessageCount: 2,
				},
			},
		}).result
		expect(stale.finishReason).toBe('complete')
		expect(staleCalls).toHaveLength(1)
		expect(stale.state.compaction?.summary).toBe('prior')
	})

	test('consumes bare and instructed compact commands without sending them to the normal model', async () => {
		for (const command of ['/compact', '/compact Focus on unresolved blockers.']) {
			const calls: LanguageModelV3CallOptions[] = []
			const result = await new Agent({
				model: scriptedModel([{ text: 'manual summary' }, { text: 'normal answer' }], calls),
				tools: {},
				autoCompact: { keepRecentTokens: 2 },
			}).run({
				state: startState([
					userMessage('old user'),
					{ role: 'assistant', content: 'old answer' },
					userMessage('recent user'),
					userMessage(command),
				]),
			}).result

			expect(result.finishReason).toBe('complete')
			expect(result.state.compaction?.trigger).toBe('manual')
			expect(callContains(calls[1]!, '/compact')).toBe(false)
			expect(JSON.stringify(result.state.messages)).not.toContain('/compact')
			expect(callContains(calls[0]!, 'Focus on unresolved blockers.')).toBe(command.includes('Focus'))
		}
	})

	test('compacts and retries exactly once after context overflow', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const events: AgentEvent[] = []
		const run = new Agent({
			model: scriptedModel(
				[
					{ error: new Error('context_length_exceeded') },
					{ text: 'overflow summary' },
					{ error: new Error('maximum context length exceeded again') },
				],
				calls,
			),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		}).run({
			state: startState([
				userMessage('old'),
				{ role: 'assistant', content: 'old answer' },
				userMessage('recent'),
			]),
			stream: true,
		})
		for await (const event of run) events.push(event)
		const result = await run.result

		expect(result.finishReason).toBe('error')
		expect(result.error?.message).toContain('maximum context length')
		expect(calls).toHaveLength(3)
		expect(events.filter((event) => event.type === 'compaction')).toHaveLength(1)
		expect(result.state.compaction?.trigger).toBe('overflow')
	})

	test('keeps the pre-compaction model state when automatic summarization fails', async () => {
		const calls: LanguageModelV3CallOptions[] = []
		const input = {
			messages: [
				userMessage('old'),
				{ role: 'assistant' as const, content: 'old answer' },
				userMessage('recent'),
			],
			contextWindowTokens: 20,
		}
		const result = await new Agent({
			model: scriptedModel([{ text: '   ' }], calls),
			tools: {},
			autoCompact: { thresholdTokens: 10, keepRecentTokens: 2 },
		}).run({ state: input }).result

		expect(result.finishReason).toBe('error')
		expect(result.state.messages).toEqual(input.messages)
		expect(result.state.contextWindowTokens).toBe(20)
		expect(result.state.compaction).toBeUndefined()
		expect(result.tokenUsage.totals).toMatchObject({ inputTokens: 120, outputTokens: 30 })
	})
})
