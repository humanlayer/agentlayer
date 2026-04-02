/**
 * Tests for type-safe hook factories — createPreToolUseHook, isToolCall
 *
 * Validates that:
 * - createPreToolUseHook with a ToolInterface scopes to that tool, typed ctx.input
 * - createPreToolUseHook with a defineTool result scopes to that tool, typed ctx.input
 * - createPreToolUseHook with an array of tools fires for any matching tool
 * - createPreToolUseHook passes through non-matching tools via next()
 * - isToolCall narrows ctx.input within a generic hook
 * - isToolCall works with both Tool and ToolInterface
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
	Agent,
	createApprovalHook,
	createPreToolUseHook,
	defineTool,
	defineToolInterface,
	isToolCall,
	type PreToolUseHook,
	startState,
} from '../src'
import { assistantText, assistantWithToolCall, assistantWithToolCalls, mockModel, userMessage } from './mocks'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EchoInterface = defineToolInterface({
	name: 'echo',
	description: 'Echoes input',
	input: z.object({ text: z.string() }),
	output: z.string(),
})

const echoTool = EchoInterface.define(async (input) => input.text)

const directTool = defineTool({
	name: 'greet',
	description: 'Greets someone',
	input: z.object({ name: z.string(), loud: z.boolean().optional() }),
	output: z.string(),
	execute: async (input) => `Hello, ${input.name}${input.loud ? '!' : '.'}`,
})

const deployTool = defineTool({
	name: 'deploy',
	description: 'Deploys',
	input: z.object({ env: z.string(), force: z.boolean().optional() }),
	output: z.string(),
	execute: async (input) => `Deployed to ${input.env}`,
})

// ── createPreToolUseHook with ToolInterface ───────────────────────────────────

describe('createPreToolUseHook — ToolInterface', () => {
	test('scoped hook fires for matching tool, ctx.input is typed', async () => {
		let capturedText: string = ''

		const hook = createPreToolUseHook(EchoInterface, (ctx) => {
			// ctx.input should be { text: string } — compile-time check
			capturedText = ctx.input.text
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'typed!' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedText).toBe('typed!')
	})

	test('scoped approval hook passes through non-matching tools', async () => {
		let hookCalled = false
		let greetExecuted = false

		const echoOnlyHook = createApprovalHook(EchoInterface, (ctx) => {
			hookCalled = true
			return ctx.deny('blocked')
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'World' }), assistantText('Done.')]),
			tools: {
				echo: echoTool,
				greet: defineTool({
					name: 'greet',
					description: 'Greets',
					input: z.object({ name: z.string() }),
					execute: async (input) => {
						greetExecuted = true
						return `Hello, ${input.name}`
					},
				}),
			},
			hooks: { approval: [echoOnlyHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// Hook should NOT have fired (greet doesn't match echo)
		expect(hookCalled).toBe(false)
		// Greet should have executed normally
		expect(greetExecuted).toBe(true)
	})
})

// ── createPreToolUseHook with defineTool ──────────────────────────────────────

describe('createPreToolUseHook — defineTool result', () => {
	test('scoped hook fires for matching tool, ctx.input is typed', async () => {
		let capturedName: string = ''
		let capturedLoud = false

		const hook = createPreToolUseHook(directTool, (ctx) => {
			// ctx.input should be { name: string, loud?: boolean } — compile-time check
			capturedName = ctx.input.name
			capturedLoud = ctx.input.loud ?? false
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'Kyle', loud: true }), assistantText('Done.')]),
			tools: { greet: directTool },
			hooks: { preToolUse: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedName).toBe('Kyle')
		expect(capturedLoud).toBe(true)
	})

	test('scoped approval hook can deny matching tool calls', async () => {
		let toolExecuted = false

		const denyGreet = createApprovalHook(directTool, (ctx) => {
			return ctx.deny('No greetings allowed')
		})

		const greetWithFlag = defineTool({
			...directTool,
			execute: async (input) => {
				toolExecuted = true
				return `Hello, ${input.name}`
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'Kyle' }), assistantText('OK.')]),
			tools: { greet: greetWithFlag },
			hooks: { approval: [denyGreet] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(toolExecuted).toBe(false)
	})

	test('scoped hook can mutate input with ctx.next(mutatedInput)', async () => {
		let receivedName: string = ''

		const uppercaseHook = createPreToolUseHook(directTool, (ctx) => {
			return ctx.next({ ...ctx.input, name: ctx.input.name.toUpperCase() })
		})

		const greetCapture = defineTool({
			...directTool,
			execute: async (input) => {
				receivedName = input.name
				return `Hello, ${input.name}`
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'kyle' }), assistantText('Done.')]),
			tools: { greet: greetCapture },
			hooks: { preToolUse: [uppercaseHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(receivedName).toBe('KYLE')
	})
})

// ── createPreToolUseHook with interface.define() result ───────────────────────

describe('createPreToolUseHook — interface.define() result', () => {
	test('scoped hook works with tool created via interface.define()', async () => {
		let capturedText: string = ''

		// echoTool was created via EchoInterface.define(...)
		const hook = createPreToolUseHook(echoTool, (ctx) => {
			capturedText = ctx.input.text
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'from define' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedText).toBe('from define')
	})
})

// ── createPreToolUseHook with array of tools ─────────────────────────────────

describe('createPreToolUseHook — array of tools', () => {
	test('fires for any matching tool in the array, passes through others', async () => {
		let echoExecuted = false

		// preToolUse hook scoped to multiple tools — passes through non-matching
		const hook = createPreToolUseHook([directTool, deployTool] as const, (ctx) => {
			// Just pass through — we only care about the scoping behavior
			return ctx.next()
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: {
				echo: defineTool({
					name: 'echo',
					description: 'Echoes',
					input: z.object({ text: z.string() }),
					execute: async (input) => {
						echoExecuted = true
						return input.text
					},
				}),
				greet: directTool,
			},
			hooks: { preToolUse: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// echo should have executed — it's not in the hook's tool list, passes through
		expect(echoExecuted).toBe(true)
	})
})

// ── createApprovalHook with array of tools ────────────────────────────────────

describe('createApprovalHook — array of tools', () => {
	test('fires for any matching tool in the array', async () => {
		const capturedToolNames: string[] = []

		// Mix of defineTool and ToolInterface — both work
		const hook = createApprovalHook([directTool, deployTool] as const, (ctx) => {
			capturedToolNames.push(ctx.toolName)
			return ctx.ask({ message: `Approve ${ctx.toolName}?` })
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'greet', input: { name: 'World' } },
					{ toolName: 'deploy', input: { env: 'prod' } },
				),
			]),
			tools: { greet: directTool, deploy: deployTool },
			hooks: { approval: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('approvalRequired')
		// Both tools should have been caught by the hook
		expect(capturedToolNames).toContain('greet')
		expect(capturedToolNames).toContain('deploy')
	})

	test('passes through tools not in the array', async () => {
		let echoExecuted = false

		const hook = createApprovalHook([directTool, deployTool] as const, (ctx) => {
			return ctx.deny('blocked')
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: {
				echo: defineTool({
					name: 'echo',
					description: 'Echoes',
					input: z.object({ text: z.string() }),
					execute: async (input) => {
						echoExecuted = true
						return input.text
					},
				}),
				greet: directTool,
			},
			hooks: { approval: [hook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		// echo should have executed — it's not in the hook's tool list
		expect(echoExecuted).toBe(true)
	})
})

// ── isToolCall type guard ────────────────────────────────────────────────────

describe('isToolCall — type guard', () => {
	test('returns true for matching tool, narrows ctx.input', async () => {
		let matched = false
		let capturedText: string = ''

		const genericHook: PreToolUseHook = (ctx) => {
			if (isToolCall(ctx, echoTool)) {
				matched = true
				// After narrowing, ctx.input should be { text: string }
				capturedText = ctx.input.text
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'narrowed' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(matched).toBe(true)
		expect(capturedText).toBe('narrowed')
	})

	test('returns false for non-matching tool', async () => {
		let matched = false

		const genericHook: PreToolUseHook = (ctx) => {
			if (isToolCall(ctx, echoTool)) {
				matched = true
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'World' }), assistantText('Done.')]),
			tools: { greet: directTool },
			hooks: { preToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(matched).toBe(false)
	})

	test('works with ToolInterface', async () => {
		let capturedText: string = ''

		const genericHook: PreToolUseHook = (ctx) => {
			if (isToolCall(ctx, EchoInterface)) {
				capturedText = ctx.input.text
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'via interface' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedText).toBe('via interface')
	})

	test('works with defineTool result', async () => {
		let capturedName: string = ''

		const genericHook: PreToolUseHook = (ctx) => {
			if (isToolCall(ctx, directTool)) {
				capturedName = ctx.input.name
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('greet', { name: 'Kyle' }), assistantText('Done.')]),
			tools: { greet: directTool },
			hooks: { preToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(capturedName).toBe('Kyle')
	})

	test('multiple isToolCall checks narrow independently', async () => {
		let echoText: string = ''
		let greetName: string = ''

		const genericHook: PreToolUseHook = (ctx) => {
			if (isToolCall(ctx, echoTool)) {
				echoText = ctx.input.text
			}
			if (isToolCall(ctx, directTool)) {
				greetName = ctx.input.name
			}
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hello' } },
					{ toolName: 'greet', input: { name: 'World' } },
				),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool, greet: directTool },
			hooks: { preToolUse: [genericHook] },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result

		expect(echoText).toBe('hello')
		expect(greetName).toBe('World')
	})
})
