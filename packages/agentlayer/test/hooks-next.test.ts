/**
 * Tests for preToolUse hooks — ctx.next() and input mutation
 *
 * Validates that:
 * - ctx.next(mutatedInput) passes mutated input to tool execution
 * - ctx.next() without args passes original input unchanged
 * - mutated input threads through multiple next() hooks
 * - updateContextWindow option patches the assistant message tool-call input
 * - notifyModel option injects a system notification into the tool result
 * - by default (no options), the assistant message is NOT patched
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PreToolUseHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

describe('preToolUse — ctx.next(mutatedInput)', () => {
	test('passes mutated input to tool execution', async () => {
		let receivedInput: Record<string, unknown> | null = null

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => {
				receivedInput = input
				return input.text
			},
		})

		const mutateHook: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'mutated text' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original text' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		// Tool should have received the mutated input
		expect(receivedInput).toBeDefined()
		expect((receivedInput as any)?.text).toBe('mutated text')
	})

	test('ctx.next() without args passes original input unchanged', async () => {
		let receivedInput: Record<string, unknown> | null = null

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => {
				receivedInput = input
				return input.text
			},
		})

		const passthroughHook: PreToolUseHook = (ctx) => ctx.next()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [passthroughHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect((receivedInput as any)?.text).toBe('original')
	})

	test('by default, mutated input does NOT patch the assistant message', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		// No options → defaults to updateContextWindow: false
		const mutateHook: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'mutated' })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// The assistant message should still show the original input
		const assistantMsg = result.state.messages.find(
			(m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
		)
		const toolCallPart = (assistantMsg!.content as any[]).find((p: any) => p.type === 'tool-call')
		// Input is a JSON string from the mock model — it should NOT have been patched
		const inputValue = typeof toolCallPart.input === 'string' ? JSON.parse(toolCallPart.input) : toolCallPart.input
		expect(inputValue.text).toBe('original')

		// But the tool result reflects the mutated execution
		const toolMsg = result.state.messages.find((m) => m.role === 'tool')
		const toolResult = (toolMsg!.content as any[])[0]
		expect(toolResult.output.value).toBe('mutated')
	})

	test('updateContextWindow: true patches the assistant message tool-call input', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string(), count: z.number() }),
			output: z.string(),
			execute: async (input) => `${input.text} x${input.count}`,
		})

		const mutateHook: PreToolUseHook = (ctx) =>
			ctx.next({ ...ctx.input, text: 'replaced', count: 99 }, { updateContextWindow: true })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original', count: 1 }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Find the assistant message containing the tool-call
		const assistantMsg = result.state.messages.find(
			(m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
		)
		expect(assistantMsg).toBeDefined()

		const toolCallPart = (assistantMsg!.content as any[]).find((p: any) => p.type === 'tool-call')
		// The tool-call input in the conversation should reflect the mutated values
		expect(toolCallPart.input).toEqual({ text: 'replaced', count: 99 })

		// The tool result should also reflect execution with the mutated input
		const toolMsg = result.state.messages.find((m) => m.role === 'tool')
		const toolResult = (toolMsg!.content as any[])[0]
		expect(toolResult.output.value).toBe('replaced x99')
	})

	test('notifyModel: true injects system notification into tool result', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const mutateHook: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'mutated' }, { notifyModel: true })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const toolMsg = result.state.messages.find((m) => m.role === 'tool')
		const toolResult = (toolMsg!.content as any[])[0]
		expect(toolResult.output.value).toContain('<system_information>')
		expect(toolResult.output.value).toContain('were modified by a PreToolUse Hook')
		expect(toolResult.output.value).toContain('mutated')
	})

	test('both updateContextWindow and notifyModel can be set together', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const mutateHook: PreToolUseHook = (ctx) =>
			ctx.next({ ...ctx.input, text: 'replaced' }, { updateContextWindow: true, notifyModel: true })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Assistant message should be patched
		const assistantMsg = result.state.messages.find(
			(m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
		)
		const toolCallPart = (assistantMsg!.content as any[]).find((p: any) => p.type === 'tool-call')
		expect(toolCallPart.input).toEqual({ text: 'replaced' })

		// Tool result should have notification
		const toolMsg = result.state.messages.find((m) => m.role === 'tool')
		const toolResult = (toolMsg!.content as any[])[0]
		expect(toolResult.output.value).toContain('<system_information>')
		expect(toolResult.output.value).toContain('replaced')
	})

	test('options aggregate across hook chain — if any hook sets a flag, it stays set', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		// First hook sets notifyModel, second sets updateContextWindow
		const hook1: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'step1' }, { notifyModel: true })
		const hook2: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'step2' }, { updateContextWindow: true })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [hook1, hook2] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// updateContextWindow was set by hook2, so the assistant message should be patched
		const assistantMsg = result.state.messages.find(
			(m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call'),
		)
		const toolCallPart = (assistantMsg!.content as any[]).find((p: any) => p.type === 'tool-call')
		expect(toolCallPart.input).toEqual({ text: 'step2' })

		// notifyModel was set by hook1, so the tool result should have the notification
		const toolMsg = result.state.messages.find((m) => m.role === 'tool')
		const toolResult = (toolMsg!.content as any[])[0]
		expect(toolResult.output.value).toContain('<system_information>')
	})

	test('mutated input threads through multiple next() hooks', async () => {
		let receivedInput: Record<string, unknown> | null = null

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => {
				receivedInput = input
				return input.text
			},
		})

		const hook1: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: 'step1' })
		const hook2: PreToolUseHook = (ctx) => ctx.next({ ...ctx.input, text: `${(ctx.input as any).text}-step2` })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'original' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [hook1, hook2] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect((receivedInput as any)?.text).toBe('step1-step2')
	})
})
