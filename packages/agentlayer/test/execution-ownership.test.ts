import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool, startState, toolCalled, toolCompleted } from '../src'
import { assistantWithToolCall, assistantWithToolCalls, mockModel, userMessage } from './mocks'

/**
 * These tests prove that the agent's own loop controls tool execution,
 * not the AI SDK's generateText. The key assertion is execute call counts:
 *
 * - beforeExecution stop → execute count is 0
 * - afterExecution stop  → execute count is exactly 1
 *
 * If the AI SDK were executing tools internally, the beforeExecution
 * count would be 1 (the SDK would have already called execute before
 * our stop condition could prevent it).
 */

let deployCount: number
let bashCount: number

beforeEach(() => {
	deployCount = 0
	bashCount = 0
})

const spyDeploy = defineTool({
	name: 'deploy',
	description: 'Deploy to production',
	input: z.object({}),
	execute: async () => {
		deployCount++
		return 'Deployed.'
	},
})

const spyBash = defineTool({
	name: 'bash',
	description: 'Run a command',
	input: z.object({ command: z.string() }),
	execute: async (input) => {
		bashCount++
		return `Exit code: 0\n${input.command}`
	},
})

describe('execution ownership', () => {
	test('toolCalled (beforeExecution) — tool.execute is never called', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy: spyDeploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('ship it')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(deployCount).toBe(0)
	})

	test('toolCompleted (afterExecution) — tool.execute is called exactly once', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy: spyDeploy },
			stopWhen: toolCompleted('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('ship it')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(deployCount).toBe(1)
	})

	test('beforeExecution stops ALL tools from executing, not just the matched one', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'bash', input: { command: 'echo prep' } },
					{ toolName: 'deploy', input: {} },
				),
			]),
			tools: { bash: spyBash, deploy: spyDeploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(bashCount).toBe(0)
		expect(deployCount).toBe(0)
	})

	test('multi-step: tools execute only in steps that complete', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo step1' }),
				assistantWithToolCall('bash', { command: 'echo step2' }),
				assistantWithToolCall('deploy', {}),
			]),
			tools: { bash: spyBash, deploy: spyDeploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(bashCount).toBe(2) // two bash steps completed
		expect(deployCount).toBe(0) // deploy stopped before execution
	})
})
