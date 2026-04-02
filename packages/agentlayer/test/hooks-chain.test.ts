/**
 * Tests for preToolUse hooks — chain ordering, context fields, and no-hooks baseline
 *
 * Validates that:
 * - hooks run in array order — first non-next() short-circuits
 * - all hooks run when all return next()
 * - hookNext factory function also works
 * - ctx.toolName, ctx.input contain correct values
 * - hooks run for all tools (not filtered by tool name)
 * - tools execute normally when no hooks provided
 * - empty preToolUse array behaves like no hooks
 * - getContextWindow() returns a frozen snapshot
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ApprovalHook, PreToolUseHook } from '../src'
import { Agent, defineTool, hookNext, startState } from '../src'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

describe('approval — hook chain ordering', () => {
	test('hooks run in array order — first non-next() short-circuits (deny in approval chain)', async () => {
		const callOrder: string[] = []

		const hook1: ApprovalHook = (ctx) => {
			callOrder.push('hook1')
			return ctx.next()
		}

		const hook2: ApprovalHook = (ctx) => {
			callOrder.push('hook2')
			return ctx.deny('denied by hook2')
		}

		const hook3: ApprovalHook = (ctx) => {
			callOrder.push('hook3')
			return ctx.next()
		}

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { approval: [hook1, hook2, hook3] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(callOrder).toEqual(['hook1', 'hook2'])
		// hook3 should NOT have been called (chain short-circuited at hook2)
	})

	test('all hooks run when all return next()', async () => {
		const callOrder: string[] = []

		const hook1: ApprovalHook = (ctx) => {
			callOrder.push('hook1')
			return ctx.next()
		}

		const hook2: ApprovalHook = (ctx) => {
			callOrder.push('hook2')
			return ctx.next()
		}

		const hook3: ApprovalHook = (ctx) => {
			callOrder.push('hook3')
			return ctx.next()
		}

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

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { approval: [hook1, hook2, hook3] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(callOrder).toEqual(['hook1', 'hook2', 'hook3'])
		expect(toolExecuted).toBe(true)
	})
})

describe('preToolUse — hook chain ordering', () => {
	test('hookNext factory function works in preToolUse chain', async () => {
		let toolExecuted = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async () => {
				toolExecuted = true
				return 'result'
			},
		})

		// Using the standalone factory function instead of ctx.next()
		const passthroughHook: PreToolUseHook = (_ctx) => hookNext()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [passthroughHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(toolExecuted).toBe(true)
	})

	test('preToolUse hooks run in array order — first non-next() short-circuits', async () => {
		const callOrder: string[] = []

		const hook1: PreToolUseHook = (ctx) => {
			callOrder.push('hook1')
			return ctx.next()
		}

		const hook2: PreToolUseHook = (ctx) => {
			callOrder.push('hook2')
			return ctx.toolResult('cached result')
		}

		const hook3: PreToolUseHook = (ctx) => {
			callOrder.push('hook3')
			return ctx.next()
		}

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

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [hook1, hook2, hook3] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(callOrder).toEqual(['hook1', 'hook2'])
		expect(toolExecuted).toBe(false) // toolResult short-circuited execution
	})
})

describe('preToolUse — hook context fields', () => {
	test('ctx.toolName matches the called tool name', async () => {
		let capturedToolName = ''

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const captureHook: PreToolUseHook = (ctx) => {
			capturedToolName = ctx.toolName
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [captureHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedToolName).toBe('echo')
	})

	test('ctx.input contains the tool call input', async () => {
		let capturedInput: Record<string, unknown> | null = null

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string(), count: z.number() }),
			execute: async (input) => input.text,
		})

		const captureHook: PreToolUseHook = (ctx) => {
			capturedInput = ctx.input
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello', count: 42 }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [captureHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedInput).toBeDefined()
		expect((capturedInput as any).text).toBe('hello')
		expect((capturedInput as any).count).toBe(42)
	})

	test('hooks without matching tool are still called (not filtered by tool name)', async () => {
		// Hooks run for ALL tools unless the hook itself filters by toolName
		const callCount = { echo: 0, other: 0 }

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const universalHook: PreToolUseHook = (ctx) => {
			callCount[ctx.toolName as keyof typeof callCount]++
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [universalHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// Hook was called once for echo
		expect(callCount.echo).toBe(1)
	})
})

describe('preToolUse — getContextWindow()', () => {
	test('returns a frozen snapshot of the context window', async () => {
		let capturedContextWindow: ReadonlyArray<unknown> | null = null
		let isFrozen = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const captureHook: PreToolUseHook = (ctx) => {
			capturedContextWindow = ctx.getContextWindow()
			// Check if frozen (Object.isFrozen on the array itself)
			isFrozen = Object.isFrozen(capturedContextWindow)
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [captureHook] },
		})

		const result = await agent.run({
			state: startState([userMessage('initial message')]),
		}).result

		expect(result.finishReason).toBe('complete')
		expect(capturedContextWindow).toBeDefined()
		// Context window should include the initial user message
		expect(capturedContextWindow!.length).toBeGreaterThanOrEqual(1)
		// It should be frozen
		expect(isFrozen).toBe(true)
	})

	test('context window snapshot is independent of live allMessages', async () => {
		let snapshotLength = 0

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const captureHook: PreToolUseHook = (ctx) => {
			snapshotLength = ctx.getContextWindow().length
			return ctx.next()
		}

		const messages = [userMessage('user message')]

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [captureHook] },
		})

		// Start with 1 user message + 1 assistant message with tool call = 2 messages
		await agent.run({ state: startState(messages) }).result

		// The snapshot should have contained user + assistant messages (2 at hook execution time)
		expect(snapshotLength).toBe(2)
	})
})

describe('preToolUse — no hooks configured', () => {
	test('tools execute normally when no hooks provided', async () => {
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

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			// No hooks property
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(toolExecuted).toBe(true)
	})

	test('empty preToolUse array behaves like no hooks', async () => {
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

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [] }, // Empty array
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(toolExecuted).toBe(true)
	})
})
