import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { TodoWriteTool } from '../src/tools/interfaces/todo-write'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	getToolResults,
	mockModel,
	outputValue,
	userMessage,
} from './mocks'

// ─── defineTool: stateful tool type safety ──────────────────────────────────

describe('defineTool with stateKey and stateSchema', () => {
	test('creates a tool with stateKey and stateSchema markers', () => {
		const tool = defineTool({
			name: 'counter',
			description: 'A counter',
			input: z.object({ increment: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.increment)
				return `Counter is now ${current + input.increment}`
			},
		})

		expect(tool.name).toBe('counter')
		expect(tool.stateKey).toBe('counter')
		expect(tool.stateSchema).toBeDefined()
	})

	test('stateless tools have no stateKey or stateSchema', () => {
		const tool = defineTool({
			name: 'echo',
			description: 'Echo',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		expect(tool.stateKey).toBeUndefined()
		expect(tool.stateSchema).toBeUndefined()
	})
})

// ─── executeToolCall: state accessors ───────────────────────────────────────

describe('tool state in agent loop', () => {
	test('stateful tool can write state and it appears on result.state', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Increment a counter',
			input: z.object({ increment: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.increment)
				return `Counter: ${current + input.increment}`
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('counter', { increment: 5 }), assistantText('Done')]),
			tools: { counter: counterTool },
		})

		const result = await agent.run({ state: startState([userMessage('increment by 5')]) }).result
		expect(result.finishReason).toBe('complete')
		expect(result.state.toolState).toEqual({ counter: 5 })
	})

	test('stateful tool can read initial state from startState', async () => {
		let readValue: number | undefined

		const counterTool = defineTool({
			name: 'counter',
			description: 'Read counter',
			input: z.object({ increment: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				readValue = ctx.getToolState()
				const newValue = (readValue ?? 0) + input.increment
				ctx.updateToolState(() => newValue)
				return `Counter: ${newValue}`
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('counter', { increment: 3 }), assistantText('Done')]),
			tools: { counter: counterTool },
		})

		const result = await agent.run({
			state: startState([userMessage('go')], { counter: 10 }),
		}).result

		expect(readValue).toBe(10)
		expect(result.state.toolState).toEqual({ counter: 13 })
	})

	test('stateful tool state accumulates across multiple calls in same run', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Increment counter',
			input: z.object({ increment: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.increment)
				return `Counter: ${current + input.increment}`
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('counter', { increment: 1 }),
				assistantWithToolCall('counter', { increment: 2 }),
				assistantText('Done'),
			]),
			tools: { counter: counterTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.toolState).toEqual({ counter: 3 })
	})

	test('stateless tools do not produce toolState', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echo',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done')]),
			tools: { echo: echoTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.toolState).toBeUndefined()
	})

	test('multiple stateful tools maintain independent state', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Counter',
			input: z.object({ n: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.n)
				return `${current + input.n}`
			},
		})

		const accumulatorTool = defineTool({
			name: 'accumulator',
			description: 'Accumulator',
			input: z.object({ value: z.string() }),
			stateKey: 'accumulator',
			stateSchema: z.array(z.string()),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? []
				ctx.updateToolState(() => [...current, input.value])
				return `Accumulated: ${[...current, input.value].join(', ')}`
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('counter', { n: 5 }),
				assistantWithToolCall('accumulator', { value: 'a' }),
				assistantText('Done'),
			]),
			tools: { counter: counterTool, accumulator: accumulatorTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.toolState).toEqual({
			counter: 5,
			accumulator: ['a'],
		})
	})

	test('tool state survives across runs (resumability)', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Counter',
			input: z.object({ n: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.n)
				return `${current + input.n}`
			},
		})

		// Run 1
		const agent1 = new Agent({
			model: mockModel([assistantWithToolCall('counter', { n: 10 }), assistantText('Pausing')]),
			tools: { counter: counterTool },
		})

		const result1 = await agent1.run({ state: startState([userMessage('start')]) }).result
		expect(result1.state.toolState).toEqual({ counter: 10 })

		// Run 2 — resume with previous state
		const agent2 = new Agent({
			model: mockModel([assistantWithToolCall('counter', { n: 7 }), assistantText('Done')]),
			tools: { counter: counterTool },
		})

		const state2 = startState([...result1.state.messages, userMessage('continue')], result1.state.toolState)
		const result2 = await agent2.run({ state: state2 }).result
		expect(result2.state.toolState).toEqual({ counter: 17 })
	})

	test('tool state round-trips through JSON serialization', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Counter',
			input: z.object({ n: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.n)
				return `${current + input.n}`
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('counter', { n: 42 }), assistantText('Done')]),
			tools: { counter: counterTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		// Round-trip through JSON
		const serialized = JSON.stringify(result.state)
		const deserialized = JSON.parse(serialized)

		expect(deserialized.toolState).toEqual({ counter: 42 })
	})

	test('getToolState returns undefined when no state has been set', async () => {
		let readValue: number | undefined = 999 // sentinel

		const counterTool = defineTool({
			name: 'counter',
			description: 'Counter',
			input: z.object({}),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (_input, ctx) => {
				readValue = ctx.getToolState()
				return 'checked'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('counter', {}), assistantText('Done')]),
			tools: { counter: counterTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(readValue).toBeUndefined()
	})

	test('parallel stateful tool calls each get their own state updates merged', async () => {
		const counterTool = defineTool({
			name: 'counter',
			description: 'Counter',
			input: z.object({ n: z.number() }),
			stateKey: 'counter',
			stateSchema: z.number(),
			execute: async (input, ctx) => {
				const current = ctx.getToolState() ?? 0
				ctx.updateToolState(() => current + input.n)
				return `${current + input.n}`
			},
		})

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echo',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([
				// Parallel: counter + echo
				assistantWithToolCalls(
					{ toolName: 'counter', input: { n: 5 } },
					{ toolName: 'echo', input: { text: 'hi' } },
				),
				assistantText('Done'),
			]),
			tools: { counter: counterTool, echo: echoTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.state.toolState).toEqual({ counter: 5 })
	})
})

// ─── TodoWrite tool ─────────────────────────────────────────────────────────

describe('TodoWriteTool', () => {
	test('TodoWriteTool has correct stateKey and stateSchema', () => {
		expect(TodoWriteTool.name).toBe('todo_write')
		expect(TodoWriteTool.stateKey).toBe('todos')
		expect(TodoWriteTool.stateSchema).toBeDefined()
	})

	test('TodoWriteTool persists todos via agent loop', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('todo_write', {
					todos: [
						{ content: 'Task 1', status: 'pending', activeForm: 'Working on Task 1' },
						{ content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
					],
				}),
				assistantText('Done'),
			]),
			tools: { todo_write: TodoWriteTool },
		})

		const result = await agent.run({ state: startState([userMessage('plan tasks')]) }).result
		expect(result.finishReason).toBe('complete')
		expect(result.state.toolState).toEqual({
			todos: [
				{ content: 'Task 1', status: 'pending', activeForm: 'Working on Task 1' },
				{ content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
			],
		})
	})

	test('TodoWriteTool updates replace the entire todo list', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('todo_write', {
					todos: [{ content: 'Task 1', status: 'pending', activeForm: 'Working on Task 1' }],
				}),
				assistantWithToolCall('todo_write', {
					todos: [
						{ content: 'Task 1', status: 'completed', activeForm: 'Working on Task 1' },
						{ content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
					],
				}),
				assistantText('Done'),
			]),
			tools: { todo_write: TodoWriteTool },
		})

		const result = await agent.run({ state: startState([userMessage('plan')]) }).result
		expect(result.state.toolState).toEqual({
			todos: [
				{ content: 'Task 1', status: 'completed', activeForm: 'Working on Task 1' },
				{ content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
			],
		})
	})

	test('TodoWriteTool returns summary string', async () => {
		let toolOutput = ''

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('todo_write', {
					todos: [
						{ content: 'A', status: 'completed', activeForm: 'Doing A' },
						{ content: 'B', status: 'in_progress', activeForm: 'Doing B' },
						{ content: 'C', status: 'pending', activeForm: 'Doing C' },
					],
				}),
				assistantText('Done'),
			]),
			tools: { todo_write: TodoWriteTool },
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		const result = await run.result

		// Find the tool result message
		const todoResults = getToolResults(result.state.messages, { toolName: 'todo_write' })
		if (todoResults.length > 0) {
			toolOutput = outputValue(todoResults[todoResults.length - 1]!)
		}

		expect(toolOutput).toBe(
			'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
		)
	})
})
