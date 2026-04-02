/**
 * Tests for preToolUse hooks — ctx.toolResult()
 *
 * Validates that:
 * - ctx.toolResult('cached') skips execution, uses cached value
 * - model sees toolResult output as the tool result
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PreToolUseHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

describe('preToolUse — ctx.toolResult()', () => {
	test('skips tool execution and uses provided output as tool result', async () => {
		let toolExecuted = false

		const expensiveTool = defineTool({
			name: 'expensive',
			description: 'An expensive computation',
			input: z.object({ query: z.string() }),
			output: z.string(),
			execute: async () => {
				toolExecuted = true
				return 'actual result'
			},
		})

		const cacheHook: PreToolUseHook = (ctx) => ctx.toolResult('cached result')

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('expensive', { query: 'test' }), assistantText('Done.')]),
			tools: { expensive: expensiveTool },
			hooks: { preToolUse: [cacheHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Tool should NOT have executed (hook short-circuited)
		expect(toolExecuted).toBe(false)
		expect(result.finishReason).toBe('complete')

		// Should have a tool result with the cached output
		const [toolResultPart] = getToolResults(result.state.messages)
		expect(toolResultPart).toBeDefined()
		expect(outputValue(toolResultPart!)).toBe('cached result')
		// Should NOT be an error
		expect(toolResultPart!.isError).toBeFalsy()
	})

	test('model sees toolResult output as the tool result', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const cacheHook: PreToolUseHook = (ctx) => ctx.toolResult('synthetic output from hook')

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [cacheHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const [toolResultPart] = getToolResults(result.state.messages)
		expect(outputValue(toolResultPart!)).toBe('synthetic output from hook')
	})
})
