/**
 * Tests for preToolUse hooks — ctx.deny()
 *
 * Validates that:
 * - ctx.deny() blocks tool execution, model sees injected denial message, loop continues
 * - deny reason appears in tool result output prefixed with user denial context
 * - deny with no reason uses default message
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ApprovalHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

describe('approval — ctx.deny()', () => {
	test('blocks tool execution, model sees injected denial message, loop continues', async () => {
		let toolExecuted = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => {
				toolExecuted = true
				return input.text
			},
		})

		const denyHook: ApprovalHook = (ctx) => ctx.deny('Denied by hook')

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('I was denied.')]),
			tools: { echo: echoTool },
			hooks: {
				approval: [denyHook],
			},
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Tool should NOT have executed
		expect(toolExecuted).toBe(false)
		// Loop should continue (model got the denial message and responded)
		expect(result.finishReason).toBe('complete')
		// Should have a tool result message with the denial injection
		const [toolResultPart] = getToolResults(result.state.messages, { toolName: 'echo' })
		expect(toolResultPart).toBeDefined()
		// Denial is injected as a non-error tool result so the model sees the user's message
		expect(toolResultPart!.isError).toBeFalsy()
		expect(outputValue(toolResultPart!)).toContain('The user denied this tool call with the following message:')
		expect(outputValue(toolResultPart!)).toContain('Denied by hook')
	})

	test('deny reason appears in tool result output with user denial prefix', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const denyHook: ApprovalHook = (ctx) => ctx.deny('Specific denial reason')

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('OK.')]),
			tools: { echo: echoTool },
			hooks: { approval: [denyHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const [toolResultPart] = getToolResults(result.state.messages)
		expect(toolResultPart).toBeDefined()
		// Output should contain the denial reason with user context prefix
		expect(outputValue(toolResultPart!)).toBe(
			'The user denied this tool call with the following message: Specific denial reason',
		)
	})

	test('deny with no reason uses default message', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const denyHook: ApprovalHook = (ctx) => ctx.deny()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('OK.')]),
			tools: { echo: echoTool },
			hooks: { approval: [denyHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const [toolResultPart] = getToolResults(result.state.messages)
		expect(toolResultPart).toBeDefined()
		expect(outputValue(toolResultPart!)).toBe(
			'The user denied this tool call with the following message: Tool execution denied',
		)
		expect(toolResultPart!.isError).toBeFalsy()
	})
})
