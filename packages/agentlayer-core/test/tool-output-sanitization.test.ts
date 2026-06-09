import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, userMessage } from './mocks'

describe('tool output sanitization', () => {
	test('sanitizes NUL and lone surrogates before tool output is stored in state', async () => {
		const badTool = defineTool({
			name: 'bad_data',
			description: 'Returns invalid text',
			input: z.object({}),
			execute: async () => 'before\0middle\uD800after',
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('bad_data', {}), assistantText('done')]),
			tools: { bad_data: badTool },
		})

		const result = await agent.run({ state: startState([userMessage('call the tool')]) }).result
		const toolResults = getToolResults(result.state.messages, { toolName: 'bad_data' })

		expect(toolResults).toHaveLength(1)
		expect(toolResults[0]!.output.value).toBe('before\uFFFDmiddle\uFFFDafter')
		expect(toolResults[0]!.output.value).not.toContain('\0')
		expect(toolResults[0]!.output.value.isWellFormed()).toBe(true)
	})

	test('sanitizes tool error messages before storing them in state', async () => {
		const failingTool = defineTool({
			name: 'fail_badly',
			description: 'Throws invalid text',
			input: z.object({}),
			execute: async () => {
				throw new Error('bad\0error\uD800')
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('fail_badly', {}), assistantText('done')]),
			tools: { fail_badly: failingTool },
		})

		const result = await agent.run({ state: startState([userMessage('call the tool')]) }).result
		const toolResults = getToolResults(result.state.messages, { toolName: 'fail_badly' })

		expect(toolResults).toHaveLength(1)
		expect(toolResults[0]!.output.value).toContain('bad\uFFFDerror\uFFFD')
		expect(toolResults[0]!.output.value).not.toContain('\0')
		expect(toolResults[0]!.output.value.isWellFormed()).toBe(true)
		expect(toolResults[0]!.isError).toBe(true)
	})
})
