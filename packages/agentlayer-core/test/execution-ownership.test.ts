import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool, startState, toolCalled, toolCompleted } from '../src'
import { assistantWithToolCall, assistantWithToolCalls, mockModel, mockStreamingModel, userMessage } from './mocks'

/**
 * These tests prove that the agent's own loop controls tool execution,
 * not the AI SDK's streamText. The key assertion is execute call counts:
 *
 * - beforeExecution stop → execute count is 0
 * - afterExecution stop  → execute count is exactly 1
 *
 * If the AI SDK were executing tools internally, the beforeExecution
 * count would be 1 (the SDK would have already called execute before
 * our stop condition could prevent it).
 */

function createSpyTools() {
	let deployCount = 0
	let bashCount = 0

	const deploy = defineTool({
		name: 'deploy',
		description: 'Deploy to production',
		input: z.object({}),
		execute: async () => {
			deployCount++
			return 'Deployed.'
		},
	})

	const bash = defineTool({
		name: 'bash',
		description: 'Run a command',
		input: z.object({ command: z.string() }),
		execute: async (input) => {
			bashCount++
			return `Exit code: 0\n${input.command}`
		},
	})

	return {
		deploy,
		bash,
		getDeployCount: () => deployCount,
		getBashCount: () => bashCount,
	}
}

describe('execution ownership', () => {
	test('toolCalled (beforeExecution) — tool.execute is never called', async () => {
		const { deploy, getDeployCount } = createSpyTools()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('ship it')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(getDeployCount()).toBe(0)
	})

	test('toolCompleted (afterExecution) — tool.execute is called exactly once', async () => {
		const { deploy, getDeployCount } = createSpyTools()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy },
			stopWhen: toolCompleted('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('ship it')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(getDeployCount()).toBe(1)
	})

	test('beforeExecution stops ALL tools from executing, not just the matched one', async () => {
		const { bash, deploy, getBashCount, getDeployCount } = createSpyTools()

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'bash', input: { command: 'echo prep' } },
					{ toolName: 'deploy', input: {} },
				),
			]),
			tools: { bash, deploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(getBashCount()).toBe(0)
		expect(getDeployCount()).toBe(0)
	})

	test('multi-step: tools execute only in steps that complete', async () => {
		const { bash, deploy, getBashCount, getDeployCount } = createSpyTools()

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo step1' }),
				assistantWithToolCall('bash', { command: 'echo step2' }),
				assistantWithToolCall('deploy', {}),
			]),
			tools: { bash, deploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(getBashCount()).toBe(2) // two bash steps completed
		expect(getDeployCount()).toBe(0) // deploy stopped before execution
	})

	test('streamText backend still leaves tool execution to AgentLayer', async () => {
		const { deploy, getDeployCount } = createSpyTools()

		const agent = new Agent({
			model: mockStreamingModel([assistantWithToolCall('deploy', {})]),
			tools: { deploy },
			stopWhen: toolCalled('deploy'),
		})

		const result = await agent.run({ state: startState([userMessage('ship it')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(getDeployCount()).toBe(0)
	})
})
