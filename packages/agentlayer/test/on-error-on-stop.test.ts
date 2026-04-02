import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { Bash } from 'just-bash'
import { Agent, type AgentError, type AgentEvent, type RunResult, startState } from '../src'
import { createJustBashTool } from '../src/tools/just-bash/index'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

function brokenModel() {
	return {
		specificationVersion: 'v3' as const,
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		async doGenerate(): Promise<never> {
			throw new Error('model exploded')
		},
		async doStream(): Promise<never> {
			throw new Error('streaming not supported')
		},
	}
}

describe('onError / onStop callbacks', () => {
	test('onError is called when an exception occurs', async () => {
		let capturedError: AgentError | undefined
		let capturedResult: RunResult | undefined

		const agent = new Agent({
			model: brokenModel(),
			tools: {},
			onError: (error, result) => {
				capturedError = error
				capturedResult = result
			},
		})

		const result = await agent.run({ state: startState([userMessage('hi')]) }).result

		expect(result.finishReason).toBe('error')
		expect(capturedError).toBeDefined()
		expect(capturedError!.message).toBe('model exploded')
		expect(capturedError!.type).toBe('unexpected_error')
		expect(capturedResult).toBe(result)
	})

	test('onStop is called on every finish reason', async () => {
		const stopReasons: string[] = []

		// 1. Normal completion
		const agent1 = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: {},
			onStop: (result) => {
				stopReasons.push(result.finishReason)
			},
		})
		await agent1.run({ state: startState([userMessage('hi')]) }).result

		// 2. Error
		const agent2 = new Agent({
			model: brokenModel(),
			tools: {},
			onStop: (result) => {
				stopReasons.push(result.finishReason)
			},
		})
		await agent2.run({ state: startState([userMessage('hi')]) }).result

		// 3. maxSteps
		const bash = new Bash({ cwd: '/tmp' })
		const agent3 = new Agent({
			model: mockModel(Array(100).fill(assistantWithToolCall('bash', { command: 'echo hi' }))),
			tools: { bash: createJustBashTool(bash) },
			maxSteps: 1,
			onStop: (result) => {
				stopReasons.push(result.finishReason)
			},
		})
		await agent3.run({ state: startState([userMessage('go')]) }).result

		expect(stopReasons).toEqual(['complete', 'error', 'maxSteps'])
	})

	test('onError fires before onStop on errors', async () => {
		const callOrder: string[] = []

		const agent = new Agent({
			model: brokenModel(),
			tools: {},
			onError: () => {
				callOrder.push('onError')
			},
			onStop: () => {
				callOrder.push('onStop')
			},
		})

		await agent.run({ state: startState([userMessage('hi')]) }).result

		expect(callOrder).toEqual(['onError', 'onStop'])
	})

	test('onError is not called on successful runs', async () => {
		let errorCalled = false

		const agent = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: {},
			onError: () => {
				errorCalled = true
			},
		})

		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.finishReason).toBe('complete')
		expect(errorCalled).toBe(false)
	})

	test('exceptions in onError callback are swallowed', async () => {
		const agent = new Agent({
			model: brokenModel(),
			tools: {},
			onError: () => {
				throw new Error('callback exploded too')
			},
		})

		// Should not throw — callback errors are swallowed
		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.finishReason).toBe('error')
	})

	test('exceptions in onStop callback are swallowed', async () => {
		const agent = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: {},
			onStop: () => {
				throw new Error('stop callback exploded')
			},
		})

		// Should not throw
		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.finishReason).toBe('complete')
	})

	test('async onError callback rejections are swallowed', async () => {
		const agent = new Agent({
			model: brokenModel(),
			tools: {},
			onError: async () => {
				throw new Error('async callback exploded')
			},
		})

		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.finishReason).toBe('error')
	})

	test('error result preserves the original AgentError for known error types', async () => {
		// InvalidMessagesError is an AgentError subclass with type 'invalid_messages_error'
		const agent = new Agent({
			model: mockModel([assistantText('Done.')]),
			tools: {},
		})

		// Feed invalid state: last message is assistant text with no tool calls
		// This triggers InvalidMessagesError
		const run = agent.run({
			state: startState([userMessage('hi'), { role: 'assistant', content: 'some text' } as ModelMessage]),
		})

		const result = await run.result
		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.type).toBe('invalid_messages_error')
	})

	test('result.error wraps non-AgentError exceptions', async () => {
		const agent = new Agent({
			model: brokenModel(),
			tools: {},
		})

		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.type).toBe('unexpected_error')
		expect(result.error!.message).toBe('model exploded')
	})

	test('error mid-run preserves accumulated state and newMessages', async () => {
		// Model succeeds for one step (tool call + result), then explodes on the second generateText call
		let callCount = 0
		const modelThatDiesOnSecondCall = {
			specificationVersion: 'v3' as const,
			provider: 'mock',
			modelId: 'mock-model',
			supportedUrls: {},
			async doGenerate() {
				callCount++
				if (callCount === 1) {
					// First call: return a tool call
					return {
						content: [
							{
								type: 'tool-call' as const,
								toolCallId: 'call-mid-error-1',
								toolName: 'bash',
								input: JSON.stringify({ command: 'echo hello' }),
							},
						],
						finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
						usage: {
							inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 0, text: 0, reasoning: 0 },
						},
						warnings: [],
					}
				}
				throw new Error('model died mid-run')
			},
			async doStream(): Promise<never> {
				throw new Error('streaming not supported')
			},
		}

		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: modelThatDiesOnSecondCall,
			tools: { bash: createJustBashTool(bash) },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.message).toBe('model died mid-run')

		// State should include the original user message + assistant tool call + tool result
		// (3 messages total: user + assistant + tool)
		expect(result.state.messages.length).toBeGreaterThanOrEqual(3)

		// newMessages should have the assistant tool call and tool result from before the error
		expect(result.newMessages.length).toBeGreaterThanOrEqual(2)
	})

	test('streaming iteration completes cleanly on error (no throw)', async () => {
		const agent = new Agent({
			model: brokenModel(),
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('hi')]) })

		// Should NOT throw during iteration
		const collected: AgentEvent[] = []
		for await (const event of run) {
			collected.push(event)
		}

		expect(collected).toHaveLength(0)

		const result = await run.result
		expect(result.finishReason).toBe('error')
	})
})
