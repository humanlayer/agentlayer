import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { Bash } from 'just-bash'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { createJustBashTool } from '../src/tools/just-bash/index'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

/** Extract messages from events, filtering to message events only. */
function collectMessages(events: AgentEvent[]): ModelMessage[] {
	return events.filter((e): e is AgentEvent & { type: 'message' } => e.type === 'message').map((e) => e.message)
}

describe('streaming', () => {
	test('streaming yields events in order', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bash', { command: 'echo hello' }), assistantText('Done.')]),
			tools: { bash: createJustBashTool(bash) },
		})

		const run = agent.run({ state: startState([userMessage('do stuff')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}
		const result = await run.result
		expect(collectMessages(events)).toEqual(result.newMessages)
	})

	test('batch usage still works without iteration', async () => {
		const agent = new Agent({
			model: mockModel([assistantText('Hello!')]),
			tools: {},
		})

		const result = await agent.run({ state: startState([userMessage('hi')]) }).result
		expect(result.newMessages).toHaveLength(1)
		expect(result.finishReason).toBe('complete')
	})

	test('can await result after partial iteration', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo 1' }),
				assistantWithToolCall('bash', { command: 'echo 2' }),
				assistantText('Done.'),
			]),
			tools: { bash: createJustBashTool(bash) },
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		const iter = run[Symbol.asyncIterator]()
		const first = await iter.next()
		expect(first.done).toBe(false)
		expect(first.value.type).toBe('message')

		const result = await run.result
		expect(result.newMessages.length).toBeGreaterThan(1)
	})

	test('multiple iterators share the same event buffer', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo 1' }),
				assistantWithToolCall('bash', { command: 'echo 2' }),
				assistantText('All done.'),
			]),
			tools: { bash: createJustBashTool(bash) },
		})

		const run = agent.run({ state: startState([userMessage('go')]) })

		// Consume all from first iterator
		const firstIterator: AgentEvent[] = []
		for await (const event of run) {
			firstIterator.push(event)
		}

		// A second iterator over the same run should replay buffered events
		const secondIterator: AgentEvent[] = []
		for await (const event of run) {
			secondIterator.push(event)
		}

		expect(collectMessages(firstIterator)).toEqual(collectMessages(secondIterator))
	})

	test('streaming with stop condition still yields messages', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const deployTool = defineTool({
			name: 'deploy',
			description: 'Deploy to production',
			input: z.object({}),
			execute: async () => 'Deployed.',
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo preparing' }),
				assistantWithToolCall('deploy', {}),
			]),
			tools: { bash: createJustBashTool(bash), deploy: deployTool },
			stopWhen: {
				name: 'toolCompleted:deploy',
				check: (steps) => {
					if (steps.length === 0) return false
					const last = steps[steps.length - 1]!
					return last.toolResults.some((tr) => tr.toolName === 'deploy' && !tr.isError)
				},
			},
		})

		const run = agent.run({ state: startState([userMessage('deploy')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		const streamed = collectMessages(events)
		expect(result.finishReason).toBe('stopCondition')
		expect(streamed).toEqual(result.newMessages)
		expect(streamed.length).toBeGreaterThan(0)
	})

	test('running getter is true at start and false after completion', async () => {
		const agent = new Agent({
			model: mockModel([assistantText('Hello!')]),
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		// running is true immediately after run() returns
		expect(run.running).toBe(true)

		await run.result
		// running is false after the loop finishes
		expect(run.running).toBe(false)
	})

	test('every yielded message event has type message with a valid message', async () => {
		const bash = new Bash({ cwd: '/tmp' })
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bash', { command: 'echo hi' }), assistantText('Done.')]),
			tools: { bash: createJustBashTool(bash) },
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		for await (const event of run) {
			if (event.type === 'message') {
				expect(event.message).toBeDefined()
				expect(event.message.role).toBeDefined()
				// agentId and parentToolCallId are undefined for root agent events
				expect(event.agentId).toBeUndefined()
				expect(event.parentToolCallId).toBeUndefined()
			}
		}
	})

	test('concurrent runs on the same Agent are independent', async () => {
		// Each run needs its own model since mockModel has shared mutable state
		const agent1 = new Agent({
			model: mockModel([assistantText('Hello from 1!')]),
			tools: {},
		})
		const agent2 = new Agent({
			model: mockModel([assistantText('Hello from 2!')]),
			tools: {},
		})

		const run1 = agent1.run({ state: startState([userMessage('first')]) })
		const run2 = agent2.run({ state: startState([userMessage('second')]) })

		const result1 = await run1.result
		const result2 = await run2.result

		expect(run1.running).toBe(false)
		expect(run2.running).toBe(false)
		expect(result1.finishReason).toBe('complete')
		expect(result2.finishReason).toBe('complete')
		expect(result1.newMessages).toHaveLength(1)
		expect(result2.newMessages).toHaveLength(1)
	})

	test('error in loop resolves with finishReason error', async () => {
		const brokenModel = {
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

		const agent = new Agent({
			model: brokenModel,
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('hi')]) })

		// Iterating should NOT throw — it just ends
		const collected: AgentEvent[] = []
		for await (const event of run) {
			collected.push(event)
		}
		expect(collected).toHaveLength(0)

		// Result should resolve (not reject) with finishReason 'error'
		const result = await run.result
		expect(result.finishReason).toBe('error')
		expect(result.error).toBeDefined()
		expect(result.error!.message).toBe('model exploded')
	})
})
