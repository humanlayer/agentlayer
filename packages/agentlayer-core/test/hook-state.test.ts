import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PostToolUseHook, PreToolUseHook } from '../src'
import { Agent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, assistantWithToolCalls, mockModel, userMessage } from './mocks'

describe('hook state - pre and post contexts', () => {
	test('pre hook can read and write hook state', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const preHook: PreToolUseHook = (ctx) => {
			const seen = ctx.getState<number>('seen') ?? 0
			ctx.updateState('seen', () => seen + 1)
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [preHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')], { seen: 41 }) }).result

		expect(result.state.toolState).toEqual({ seen: 42 })
	})

	test('post hook can read and write hook state', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const postHook: PostToolUseHook = (ctx) => {
			const outputs = ctx.getState<string[]>('outputs') ?? []
			ctx.updateState('outputs', () => [...outputs, ctx.output])
			return ctx.done()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [postHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')], { outputs: ['seed'] }) }).result

		expect(result.state.toolState).toEqual({ outputs: ['seed', 'hello'] })
	})
})

describe('hook state - persistence across calls and runs', () => {
	test('state persists across multiple tool calls in one run', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const preHook: PreToolUseHook = (ctx) => {
			const seen = ctx.getState<number>('seen') ?? 0
			ctx.updateState('seen', () => seen + 1)
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'first' }),
				assistantWithToolCall('echo', { text: 'second' }),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [preHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.toolState).toEqual({ seen: 2 })
	})

	test('state persists across resumed runs via startState(..., toolState)', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const preHook: PreToolUseHook = (ctx) => {
			const seen = ctx.getState<number>('seen') ?? 0
			ctx.updateState('seen', () => seen + 1)
			return ctx.next()
		}

		const agent1 = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'first' }), assistantText('Pause.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [preHook] },
		})

		const result1 = await agent1.run({ state: startState([userMessage('go')]) }).result
		expect(result1.state.toolState).toEqual({ seen: 1 })

		const agent2 = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'second' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [preHook] },
		})

		const resumed = startState([...result1.state.messages, userMessage('continue')], result1.state.toolState)
		const result2 = await agent2.run({ state: resumed }).result
		expect(result2.state.toolState).toEqual({ seen: 2 })
	})

	test('state survives JSON serialization round-trip', async () => {
		const taskTool = defineTool({
			name: 'task',
			description: 'Processes a task label',
			input: z.object({ label: z.string() }),
			output: z.string(),
			execute: async (input) => input.label,
		})

		type SessionState = { count: number; history: string[] }
		const preHook: PreToolUseHook = (ctx) => {
			const session = ctx.getState<SessionState>('session') ?? { count: 0, history: [] }
			const label = (ctx.input as { label: string }).label
			ctx.updateState('session', () => ({
				count: session.count + 1,
				history: [...session.history, label],
			}))
			return ctx.next()
		}

		const agent1 = new Agent({
			model: mockModel([assistantWithToolCall('task', { label: 'first' }), assistantText('Pause.')]),
			tools: { task: taskTool },
			hooks: { preToolUse: [preHook] },
		})

		const result1 = await agent1.run({ state: startState([userMessage('go')]) }).result

		const serialized = JSON.stringify(result1.state)
		const parsed = JSON.parse(serialized) as {
			messages: any[]
			toolState?: Record<string, unknown>
		}

		const agent2 = new Agent({
			model: mockModel([assistantWithToolCall('task', { label: 'second' }), assistantText('Done.')]),
			tools: { task: taskTool },
			hooks: { preToolUse: [preHook] },
		})

		const result2 = await agent2.run({
			state: startState([...parsed.messages, userMessage('continue')] as any, parsed.toolState),
		}).result

		expect(result2.state.toolState).toEqual({
			session: {
				count: 2,
				history: ['first', 'second'],
			},
		})
	})
})

describe('hook state - merge behavior', () => {
	test('hook and tool updates using same key merge with tool update taking precedence', async () => {
		const sharedTool = defineTool({
			name: 'shared',
			description: 'Updates shared state',
			input: z.object({}),
			output: z.string(),
			stateKey: 'shared',
			stateSchema: z.string(),
			execute: async (_input, ctx) => {
				ctx.updateToolState(() => 'from-tool')
				return 'ok'
			},
		})

		const preHook: PreToolUseHook = (ctx) => {
			ctx.updateState('shared', () => 'from-hook')
			return ctx.next()
		}

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('shared', {}), assistantText('Done.')]),
			tools: { shared: sharedTool },
			hooks: { preToolUse: [preHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')], { shared: 'initial' }) }).result

		expect(result.state.toolState).toEqual({ shared: 'from-tool' })
	})

	test('parallel pre-hook updates to the same object key preserve contributions from both tool calls', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ label: z.string() }),
			output: z.string(),
			execute: async (input) => input.label,
		})

		const preHook: PreToolUseHook = (ctx) => {
			const label = (ctx.input as { label: string }).label
			ctx.updateState('seenByLabel', (current) => ({
				...(current ?? {}),
				[label]: true,
			}))
			return ctx.next()
		}

		const result = await new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { label: 'first' } },
					{ toolName: 'echo', input: { label: 'second' } },
				),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool },
			hooks: { preToolUse: [preHook] },
		}).run({ state: startState([userMessage('go')]) }).result

		expect(result.state.toolState).toEqual({
			seenByLabel: {
				first: true,
				second: true,
			},
		})
	})

	test('parallel post-hook updates to the same array key preserve both outputs', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes text',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const postHook: PostToolUseHook = (ctx) => {
			ctx.updateState<string[]>('outputs', (current) => [...(current ?? []), ctx.output])
			return ctx.done()
		}

		const result = await new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'alpha' } },
					{ toolName: 'echo', input: { text: 'bravo' } },
				),
				assistantText('Done.'),
			]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [postHook] },
		}).run({ state: startState([userMessage('go')]) }).result

		expect(result.state.toolState).toEqual({ outputs: ['alpha', 'bravo'] })
	})
})
