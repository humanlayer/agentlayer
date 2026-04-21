/**
 * Tests for postToolUse hooks — ctx.done()
 *
 * Validates that:
 * - ctx.done() accepts the tool result as-is
 * - ctx.done(mutatedResult) replaces the tool output with the mutated string
 * - mutated output threads through multiple done() hooks
 * - postToolUse hooks do NOT run when tool execution errors
 * - postToolUse hooks do NOT run for denied tool calls
 * - postToolUse hooks do NOT run for preToolUse toolResult short-circuits
 * - createPostToolUseHook scopes to matching tools, passes through others
 * - isToolCall works in postToolUse hooks
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PostToolUseHook } from '../src'
import { Agent, createPostToolUseHook, defineTool, isToolCall, startState } from '../src'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	getToolResults,
	mockModel,
	outputValue,
	userMessage,
} from './mocks'

describe('postToolUse — ctx.done()', () => {
	test('accepts tool result unchanged', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const passthroughHook: PostToolUseHook = (ctx) => ctx.done()

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [passthroughHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		const [toolResultPart] = getToolResults(result.state.messages)
		expect(outputValue(toolResultPart!)).toBe('hello')
	})

	test('ctx.done(mutatedResult) replaces tool output', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const mutateHook: PostToolUseHook = (ctx) => ctx.done(`[modified] ${ctx.output}`)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [mutateHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const [toolResultPart] = getToolResults(result.state.messages)
		expect(outputValue(toolResultPart!)).toBe('[modified] hello')
	})

	test('mutated output threads through multiple done() hooks', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const hook1: PostToolUseHook = (ctx) => ctx.done(`[h1:${ctx.output}]`)
		const hook2: PostToolUseHook = (ctx) => ctx.done(`[h2:${ctx.output}]`)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'x' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [hook1, hook2] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const [toolResultPart] = getToolResults(result.state.messages)
		expect(outputValue(toolResultPart!)).toBe('[h2:[h1:x]]')
	})

	test('hook receives rawOutput', async () => {
		let capturedRaw: unknown

		const counterTool = defineTool({
			name: 'counter',
			description: 'Returns a number',
			input: z.object({}),
			output: z.number(),
			execute: async () => 42,
		})

		const captureHook: PostToolUseHook = (ctx) => {
			capturedRaw = ctx.rawOutput
			return ctx.done()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('counter', {}), assistantText('Done.')]),
			tools: { counter: counterTool },
			hooks: { postToolUse: [captureHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedRaw).toBe(42)
	})
})

describe('postToolUse — skip conditions', () => {
	test('does NOT run when tool execution errors', async () => {
		let hookCalled = false

		const errorTool = defineTool({
			name: 'error',
			description: 'Always errors',
			input: z.object({}),
			output: z.string(),
			execute: async () => {
				throw new Error('boom')
			},
		})

		const hook: PostToolUseHook = (ctx) => {
			hookCalled = true
			return ctx.done()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('error', {}), assistantText('Done.')]),
			tools: { error: errorTool },
			hooks: { postToolUse: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(hookCalled).toBe(false)
	})

	test('does NOT run for denied tool calls', async () => {
		let postHookCalled = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hi' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: {
				approval: [(ctx) => ctx.deny('nope')],
				postToolUse: [
					(ctx) => {
						postHookCalled = true
						return ctx.done()
					},
				],
			},
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(postHookCalled).toBe(false)
	})

	test('does NOT run for preToolUse toolResult short-circuits', async () => {
		let postHookCalled = false

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hi' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: {
				preToolUse: [(ctx) => ctx.toolResult('cached')],
				postToolUse: [
					(ctx) => {
						postHookCalled = true
						return ctx.done()
					},
				],
			},
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(postHookCalled).toBe(false)
	})
})

describe('postToolUse — parallel tool calls', () => {
	test('runs independently for each tool in a parallel batch', async () => {
		const outputs: string[] = []

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const tagHook: PostToolUseHook = (ctx) => {
			outputs.push(ctx.output)
			return ctx.done(`[tagged] ${ctx.output}`)
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'a' } },
					{ toolName: 'echo', input: { text: 'b' } },
				),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [tagHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('complete')
		expect(outputs).toContain('a')
		expect(outputs).toContain('b')

		const toolOutputs = getToolResults(result.state.messages).map(outputValue)
		expect(toolOutputs).toContain('[tagged] a')
		expect(toolOutputs).toContain('[tagged] b')
	})
})

describe('createPostToolUseHook — type-safe factory', () => {
	test('scoped hook fires for matching tool only', async () => {
		const hookFiredFor: string[] = []

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const greetTool = defineTool({
			name: 'greet',
			description: 'Greets',
			input: z.object({ name: z.string() }),
			output: z.string(),
			execute: async (input) => `Hello, ${input.name}`,
		})

		const echoOnlyHook = createPostToolUseHook(echoTool, (ctx) => {
			hookFiredFor.push(ctx.toolName)
			return ctx.done(`[echo-hook] ${ctx.output}`)
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hey' } },
					{ toolName: 'greet', input: { name: 'Kyle' } },
				),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool, greet: greetTool },
			hooks: { postToolUse: [echoOnlyHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(hookFiredFor).toEqual(['echo'])

		const toolOutputs = getToolResults(result.state.messages).map(outputValue)
		expect(toolOutputs).toContain('[echo-hook] hey')
		expect(toolOutputs).toContain('Hello, Kyle')
	})

	test('scoped to multiple tools fires for any match', async () => {
		const hookFiredFor: string[] = []

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const greetTool = defineTool({
			name: 'greet',
			description: 'Greets',
			input: z.object({ name: z.string() }),
			output: z.string(),
			execute: async (input) => `Hello, ${input.name}`,
		})

		const otherTool = defineTool({
			name: 'other',
			description: 'Other',
			input: z.object({}),
			output: z.string(),
			execute: async () => 'other-result',
		})

		const multiHook = createPostToolUseHook([echoTool, greetTool] as const, (ctx) => {
			hookFiredFor.push(ctx.toolName)
			return ctx.done()
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls({ toolName: 'echo', input: { text: 'hey' } }, { toolName: 'other', input: {} }),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool, greet: greetTool, other: otherTool },
			hooks: { postToolUse: [multiHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(hookFiredFor).toEqual(['echo'])
	})
})

describe('postToolUse — isToolCall type guard', () => {
	test('narrows input type in a generic postToolUse hook', async () => {
		let capturedText = ''

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const genericHook: PostToolUseHook = (ctx) => {
			if (isToolCall(ctx, echoTool)) {
				capturedText = ctx.input.text
			}
			return ctx.done()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'narrowed' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedText).toBe('narrowed')
	})
})
