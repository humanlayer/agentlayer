import { describe, expect, test } from 'bun:test'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai/test'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, defineTool, maxSteps, startState, type ToolProgressData, toolCompleted } from '../src'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

const MOCK_USAGE: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

/** Create a model that captures its doGenerate options for inspection */
function capturingModel(
	responses: Array<Pick<LanguageModelV3GenerateResult, 'content'>>,
	onCall?: (options: LanguageModelV3CallOptions) => void,
): LanguageModelV3 {
	let index = 0
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			onCall?.(options)
			if (index >= responses.length) {
				throw new Error(`capturingModel: no more responses`)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c) => c.type === 'tool-call')
			return {
				content: response.content,
				finishReason: {
					unified: hasToolCalls ? 'tool-calls' : 'stop',
					raw: hasToolCalls ? 'tool_use' : 'stop',
				},
				usage: MOCK_USAGE,
				warnings: [],
			}
		},
		async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
			onCall?.(options)
			if (index >= responses.length) {
				throw new Error(`capturingModel: no more responses`)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c) => c.type === 'tool-call')
			const contentChunks: LanguageModelV3StreamPart[] = []
			for (const part of response.content) {
				if (part.type === 'text') {
					const id = crypto.randomUUID()
					contentChunks.push(
						{ type: 'text-start', id },
						{ type: 'text-delta', id, delta: part.text },
						{ type: 'text-end', id },
					)
					continue
				}

				if (
					part.type === 'tool-call' ||
					part.type === 'tool-result' ||
					part.type === 'source' ||
					part.type === 'file'
				) {
					contentChunks.push(part)
				}
			}
			const chunks: LanguageModelV3StreamPart[] = [
				{ type: 'stream-start', warnings: [] },
				...contentChunks,
				{
					type: 'finish',
					finishReason: {
						unified: hasToolCalls ? 'tool-calls' : 'stop',
						raw: hasToolCalls ? 'tool_use' : 'stop',
					},
					usage: MOCK_USAGE,
				},
			]
			return {
				stream: simulateReadableStream<LanguageModelV3StreamPart>({
					chunks,
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}
		},
	}
}

// ─── updateContextWindow ──────────────────────────────────────────────────────

describe('updateContextWindow', () => {
	test('injects user message after tool result', async () => {
		const injectingTool = defineTool({
			name: 'greet',
			description: 'A tool that injects a follow-up message',
			input: z.object({}),
			execute: async (_input, ctx) => {
				ctx.updateContextWindow((messages) => [
					...messages,
					{ role: 'user', content: 'Follow-up injected by tool' },
				])
				return 'Hello!'
			},
		})

		// The model needs to see the injected message — we capture the second call's messages
		let secondCallMessages: ModelMessage[] = []
		let callCount = 0
		const model = capturingModel([assistantWithToolCall('greet', {}), assistantText('Done.')], (options) => {
			callCount++
			if (callCount === 2) {
				secondCallMessages = options.prompt as ModelMessage[]
			}
		})

		const agent = new Agent({
			model,
			tools: { greet: injectingTool },
		})

		await agent.run({ state: startState([userMessage('hello')]) }).result

		// Find the tool result and injected user message by index
		const toolResultIdx = secondCallMessages.findIndex((m) => m.role === 'tool')
		const injectedIdx = secondCallMessages.findIndex(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes('Follow-up injected by tool'),
		)

		expect(toolResultIdx).toBeGreaterThan(-1)
		expect(injectedIdx).toBeGreaterThan(-1)
		// The injected user message must come AFTER the tool result
		expect(injectedIdx).toBeGreaterThan(toolResultIdx)
		// And it should be the last message in the prompt
		expect(injectedIdx).toBe(secondCallMessages.length - 1)
	})

	test('multiple updateContextWindow calls applied in order', async () => {
		const orderLog: string[] = []

		const multiInjectTool = defineTool({
			name: 'multi',
			description: 'Injects multiple messages',
			input: z.object({}),
			execute: async (_input, ctx) => {
				ctx.updateContextWindow((messages) => {
					orderLog.push('first')
					return [...messages, { role: 'user', content: 'First injection' }]
				})
				ctx.updateContextWindow((messages) => {
					orderLog.push('second')
					return [...messages, { role: 'user', content: 'Second injection' }]
				})
				return 'Done'
			},
		})

		let secondCallMessages: unknown[] = []
		let callCount = 0
		const model = capturingModel([assistantWithToolCall('multi', {}), assistantText('Done.')], (options) => {
			callCount++
			if (callCount === 2) {
				secondCallMessages = options.prompt
			}
		})

		const agent = new Agent({
			model,
			tools: { multi: multiInjectTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// Callbacks applied in order
		expect(orderLog).toEqual(['first', 'second'])

		// Both injections visible to model
		const promptText = JSON.stringify(secondCallMessages)
		expect(promptText).toContain('First injection')
		expect(promptText).toContain('Second injection')
	})
})

// ─── AbortSignal ──────────────────────────────────────────────────────────────

describe('AbortSignal', () => {
	test('signal.aborted is false during normal execution', async () => {
		let signalDuringExecution: AbortSignal | undefined

		const checkSignalTool = defineTool({
			name: 'check',
			description: 'Captures the abort signal',
			input: z.object({}),
			execute: async (_input, ctx) => {
				signalDuringExecution = ctx.signal
				return 'ok'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('check', {}), assistantText('Done.')]),
			tools: { check: checkSignalTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(signalDuringExecution).toBeDefined()
		expect(signalDuringExecution!.aborted).toBe(false)
	})

	test('aborting signal mid-loop stops agent with finishReason: interrupted', async () => {
		const controller = new AbortController()

		const slowTool = defineTool({
			name: 'slow',
			description: 'A tool that aborts mid-execution',
			input: z.object({}),
			execute: async () => {
				controller.abort()
				return 'done'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('slow', {}),
				// The loop should not reach a second model call
				assistantText('Should not be reached.'),
			]),
			tools: { slow: slowTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]), signal: controller.signal }).result

		expect(result.finishReason).toBe('interrupted')
	})

	test('aborted signal at loop start stops with finishReason: interrupted', async () => {
		const controller = new AbortController()
		controller.abort()

		const agent = new Agent({
			model: mockModel([assistantText('Should not be reached.')]),
			tools: {},
		})

		const result = await agent.run({ state: startState([userMessage('go')]), signal: controller.signal }).result

		expect(result.finishReason).toBe('interrupted')
	})

	test('abort signal is propagated to tool ctx.signal', async () => {
		const controller = new AbortController()
		let capturedSignal: AbortSignal | undefined

		const captureTool = defineTool({
			name: 'capture',
			description: 'Captures abort signal from context',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedSignal = ctx.signal
				return 'captured'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('capture', {}), assistantText('Done.')]),
			tools: { capture: captureTool },
		})

		await agent.run({ state: startState([userMessage('go')]), signal: controller.signal }).result

		expect(capturedSignal).toBe(controller.signal)
	})
})

// ─── onToolProgress ───────────────────────────────────────────────────────────

describe('onToolProgress', () => {
	test('ctx.progress calls onToolProgress with toolCallId and toolName', async () => {
		const progressEvents: Array<{ toolCallId: string; toolName: string; data: ToolProgressData }> = []

		const progressTool = defineTool({
			name: 'worker',
			description: 'Reports progress',
			input: z.object({}),
			execute: async (_input, ctx) => {
				ctx.progress({ type: 'status', message: 'starting' })
				ctx.progress({ type: 'output', content: 'some output' })
				return 'done'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('worker', {}), assistantText('Done.')]),
			tools: { worker: progressTool },
			onToolProgress: (toolCallId, toolName, data) => {
				progressEvents.push({ toolCallId, toolName, data })
			},
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(progressEvents).toHaveLength(2)
		expect(progressEvents[0]!.toolName).toBe('worker')
		expect(progressEvents[0]!.toolCallId).toBeTruthy()
		expect(progressEvents[0]!.data).toEqual({ type: 'status', message: 'starting' })
		expect(progressEvents[1]!.data).toEqual({ type: 'output', content: 'some output' })
		// Both events should have the same toolCallId
		expect(progressEvents[0]!.toolCallId).toBe(progressEvents[1]!.toolCallId)
	})

	test('ctx.progress is no-op when onToolProgress not provided', async () => {
		// Should not throw even when progress is called
		const progressTool = defineTool({
			name: 'worker',
			description: 'Reports progress',
			input: z.object({}),
			execute: async (_input, ctx) => {
				ctx.progress({ type: 'status', message: 'ok' })
				return 'done'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('worker', {}), assistantText('Done.')]),
			tools: { worker: progressTool },
			// No onToolProgress
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('complete')
	})
})

// ─── string[] system prompt ───────────────────────────────────────────────────

describe('system as string[]', () => {
	test('string[] is joined with double newlines', async () => {
		let capturedPrompt: unknown[] = []
		const model = capturingModel([assistantText('Done.')], (options) => {
			capturedPrompt = options.prompt
		})

		const agent = new Agent({
			model,
			system: ['Part one.', 'Part two.', 'Part three.'],
			tools: {},
		})

		await agent.run({ state: startState([userMessage('hello')]) }).result

		const promptText = JSON.stringify(capturedPrompt)
		expect(promptText).toContain('Part one.')
		expect(promptText).toContain('Part two.')
		expect(promptText).toContain('Part three.')
		// They should be separated by \n\n
		expect(promptText).toContain('Part one.\\n\\nPart two.\\n\\nPart three.')
	})
})

// ─── Anthropic integration ───────────────────────────────────────────────────

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)('updateContextWindow (anthropic)', () => {
	test('injected user message appears after tool result with real model', async () => {
		const { anthropic } = await import('@ai-sdk/anthropic')

		const doneTool = defineTool({
			name: 'done',
			description: 'Call this when finished.',
			input: z.object({ summary: z.string() }),
			execute: async (input) => `Done: ${input.summary}`,
		})

		const injectingTool = defineTool({
			name: 'get_info',
			description: 'Gets some info and injects a follow-up instruction',
			input: z.object({}),
			execute: async (_input, ctx) => {
				ctx.updateContextWindow((messages) => [
					...messages,
					{
						role: 'user' as const,
						content: 'IMPORTANT: Now call the done tool with summary "injection worked"',
					},
				])
				return 'Info retrieved successfully.'
			},
		})

		const agent = new Agent({
			model: anthropic('claude-haiku-4-5-20251001'),
			system: 'You are a helpful assistant. Follow instructions exactly. Always call get_info first, then follow any new instructions.',
			tools: { get_info: injectingTool, done: doneTool },
			stopWhen: [maxSteps(5), toolCompleted('done')],
		})

		const result = await agent.run({
			state: startState([userMessage('Please call get_info to start.')]),
		}).result

		expect(result.finishReason).toBe('stopCondition')

		// The model should have seen the injected message and called done with the expected summary
		const doneCall = result.newMessages.find(
			(m) =>
				m.role === 'tool' &&
				Array.isArray(m.content) &&
				m.content.some((c) => c.type === 'tool-result' && c.toolName === 'done'),
		)
		expect(doneCall).toBeDefined()

		// Verify the injected user message appears in the conversation
		const injectedMsg = result.newMessages.find(
			(m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('injection worked'),
		)
		expect(injectedMsg).toBeDefined()
	}, 30_000)
})
