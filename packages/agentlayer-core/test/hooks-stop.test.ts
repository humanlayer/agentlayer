/**
 * Tests for preToolUse hooks — ctx.stop()
 *
 * Validates that:
 * - ctx.stop() from hook stops the loop (same semantics as tool ctx.stop())
 * - ctx.stop({ include: false }) does not append tool result
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PreToolUseHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

describe('preToolUse — ctx.stop()', () => {
	test('stops the loop (same semantics as tool ctx.stop())', async () => {
		let toolExecuted = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => {
				toolExecuted = true
				return input.text
			},
		})

		const stopHook: PreToolUseHook = (ctx) => ctx.stop({ reason: 'hook requested stop' })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hello' }),
				assistantText('Should not be reached'),
			]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [stopHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(toolExecuted).toBe(false)
		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition?.name).toBe('ctx.stop')
		expect(result.stopCondition?.message).toBe('hook requested stop')
	})

	test('ctx.stop({ include: false }) from hook does not append tool result', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const stopHook: PreToolUseHook = (ctx) => ctx.stop({ include: false, reason: 'hook stop no include' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' })]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [stopHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		// No tool result should be in messages
		const toolResultMsg = result.state.messages.find((m) => m.role === 'tool')
		expect(toolResultMsg).toBeUndefined()
		// The stopped tool should appear in pendingToolCalls
		expect(result.state.pendingToolCalls).toBeDefined()
		expect(result.state.pendingToolCalls!.length).toBeGreaterThan(0)
		expect(result.state.pendingToolCalls![0]!.type).toBe('stopped')
	})
})
