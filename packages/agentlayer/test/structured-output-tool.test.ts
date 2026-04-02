import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, defineTool, startState, structuredOutputCalled, toolCalled } from '../src'
import {
	createStructuredOutputTool,
	extractStructuredOutput,
	StructuredOutputTool,
	structuredOutput,
	structuredOutputInput,
} from '../src/tools/interfaces'
import {
	assistantText,
	assistantWithToolCall,
	assistantWithToolCalls,
	makeToolContext,
	mockModel,
	userMessage,
} from './mocks'

// ─── Schema validation ───────────────────────────────────────────────────────

describe('structuredOutputInput schema', () => {
	test('accepts valid data object', () => {
		const result = structuredOutputInput.safeParse({ data: { answer: 42 } })
		expect(result.success).toBe(true)
	})

	test('accepts empty object as data', () => {
		const result = structuredOutputInput.safeParse({ data: {} })
		expect(result.success).toBe(true)
	})

	test('accepts nested objects', () => {
		const result = structuredOutputInput.safeParse({
			data: { user: { name: 'Alice', scores: [1, 2, 3] } },
		})
		expect(result.success).toBe(true)
	})

	test('rejects missing data field', () => {
		const result = structuredOutputInput.safeParse({})
		expect(result.success).toBe(false)
	})
})

// ─── StructuredOutputTool (generic) ──────────────────────────────────────────

describe('StructuredOutputTool (generic)', () => {
	test('has correct name', () => {
		expect(StructuredOutputTool.name).toBe('structured_output')
	})

	test('has a description', () => {
		expect(StructuredOutputTool.description.length).toBeGreaterThan(0)
	})

	test('execute returns JSON string of data', async () => {
		const result = await StructuredOutputTool.execute({ data: { answer: 42 } }, makeToolContext())
		expect(result).toBe('{"answer":42}')
	})

	test('execute handles nested data', async () => {
		const result = await StructuredOutputTool.execute(
			{ data: { user: { name: 'Alice' }, tags: ['a', 'b'] } },
			makeToolContext(),
		)
		expect(JSON.parse(result as string)).toEqual({ user: { name: 'Alice' }, tags: ['a', 'b'] })
	})
})

// ─── createStructuredOutputTool (typed) ──────────────────────────────────────

describe('createStructuredOutputTool', () => {
	test('creates a tool named "structured_output"', () => {
		const tool = createStructuredOutputTool(z.object({ answer: z.number() }))
		expect(tool.name).toBe('structured_output')
	})

	test('description includes JSON Schema from zod schema via z.toJSONSchema', () => {
		const tool = createStructuredOutputTool(
			z.object({
				name: z.string(),
				age: z.number(),
			}),
		)
		expect(tool.description).toContain('JSON Schema')
		expect(tool.description).toContain('"name"')
		expect(tool.description).toContain('"age"')
		expect(tool.description).toContain('"string"')
		expect(tool.description).toContain('"number"')
	})

	test('execute returns JSON string of data', async () => {
		const tool = createStructuredOutputTool(z.object({ answer: z.number() }))
		const result = await tool.execute({ data: { answer: 42 } }, makeToolContext())
		expect(result).toBe('{"answer":42}')
	})

	test('execute handles complex schemas', async () => {
		const schema = z.object({
			company: z.object({
				name: z.string(),
				founded: z.number(),
			}),
			products: z.array(z.string()),
		})
		const tool = createStructuredOutputTool(schema)
		const data = { company: { name: 'Acme', founded: 2020 }, products: ['Widget'] }
		const result = await tool.execute({ data }, makeToolContext())
		expect(JSON.parse(result as string)).toEqual(data)
	})

	test('description includes required fields from schema', () => {
		const tool = createStructuredOutputTool(
			z.object({
				required_field: z.string(),
				optional_field: z.string().optional(),
			}),
		)
		expect(tool.description).toContain('"required_field"')
		expect(tool.description).toContain('"optional_field"')
	})
})

// ─── extractStructuredOutput ─────────────────────────────────────────────────

describe('extractStructuredOutput', () => {
	test('extracts data from assistant message with structured_output tool-call', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'structured_output',
						input: JSON.stringify({ data: { answer: 42 } }),
					},
				],
			},
		]
		expect(extractStructuredOutput(messages)).toEqual({ answer: 42 })
	})

	test('extracts data when input is already an object', () => {
		const messages: ModelMessage[] = [
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'structured_output',
						input: { data: { x: 1 } },
					},
				],
			},
		]
		expect(extractStructuredOutput(messages)).toEqual({ x: 1 })
	})

	test('returns undefined when no structured_output tool-call exists', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi there' },
		]
		expect(extractStructuredOutput(messages)).toBeUndefined()
	})

	test('returns undefined for empty messages', () => {
		expect(extractStructuredOutput([])).toBeUndefined()
	})

	test('returns the most recent structured_output call when multiple exist', () => {
		const messages: ModelMessage[] = [
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call-1',
						toolName: 'structured_output',
						input: { data: { v: 'old' } },
					},
				],
			},
			{ role: 'user', content: 'try again' },
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call-2',
						toolName: 'structured_output',
						input: { data: { v: 'new' } },
					},
				],
			},
		]
		expect(extractStructuredOutput(messages)).toEqual({ v: 'new' })
	})

	test('ignores non-structured_output tool-calls', () => {
		const messages: ModelMessage[] = [
			{
				role: 'assistant',
				content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', input: { command: 'ls' } }],
			},
		]
		expect(extractStructuredOutput(messages)).toBeUndefined()
	})
})

// ─── structuredOutput() helper ───────────────────────────────────────────────

describe('structuredOutput()', () => {
	test('returns a tool and a parse function', () => {
		const { tool, parse } = structuredOutput(z.object({ answer: z.number() }))
		expect(tool.name).toBe('structured_output')
		expect(typeof parse).toBe('function')
	})

	test('tool is a valid structured_output tool', () => {
		const { tool } = structuredOutput(z.object({ name: z.string() }))
		expect(tool.name).toBe('structured_output')
		expect(tool.description).toContain('JSON Schema')
		expect(tool.description).toContain('"name"')
	})

	test('parse extracts and validates data from a RunResult', async () => {
		const schema = z.object({ answer: z.number(), note: z.string() })
		const { tool, parse } = structuredOutput(schema)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { answer: 42, note: 'done' } })]),
			tools: { structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const data = parse(result)

		expect(data).toBeDefined()
		expect(data!.answer).toBe(42)
		expect(data!.note).toBe('done')
	})

	test('parse returns undefined when no structured_output call exists', async () => {
		const { tool, parse } = structuredOutput(z.object({ x: z.number() }))

		const echoTool = defineTool({
			name: 'echo',
			description: 'echo',
			input: z.object({}),
			execute: async () => 'hi',
		})

		const agent = new Agent({
			model: mockModel([assistantText('no tool call')]),
			tools: { structured_output: tool, echo: echoTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(parse(result)).toBeUndefined()
	})

	test('parse throws ZodError when data does not match schema', async () => {
		const schema = z.object({ answer: z.number() })
		const { tool, parse } = structuredOutput(schema)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { answer: 'not a number' } })]),
			tools: { structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(() => parse(result)).toThrow()
	})

	test('parse works with complex nested schemas', async () => {
		const schema = z.object({
			company: z.object({ name: z.string(), founded: z.number() }),
			tags: z.array(z.string()),
		})
		const { tool, parse } = structuredOutput(schema)

		const data = { company: { name: 'Acme', founded: 2020 }, tags: ['tech', 'ai'] }

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data })]),
			tools: { structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const parsed = parse(result)

		expect(parsed).toEqual(data)
		expect(parsed!.company.name).toBe('Acme')
		expect(parsed!.tags).toEqual(['tech', 'ai'])
	})

	test('parse works after other tools have run first', async () => {
		const schema = z.object({ result: z.string() })
		const { tool, parse } = structuredOutput(schema)

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echo',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hello' }),
				assistantWithToolCall('structured_output', { data: { result: 'hello' } }),
			]),
			tools: { echo: echoTool, structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const parsed = parse(result)

		expect(parsed).toEqual({ result: 'hello' })
	})
})

// ─── structuredOutputCalled stop condition ────────────────────────────────────

describe('structuredOutputCalled', () => {
	test('is equivalent to toolCalled("structured_output")', () => {
		const soCondition = structuredOutputCalled()
		const tcCondition = toolCalled('structured_output')
		expect(soCondition.name).toBe(tcCondition.name)
		expect(soCondition.timing).toBe(tcCondition.timing)
	})

	test('has beforeExecution timing', () => {
		const condition = structuredOutputCalled()
		expect(condition.timing).toBe('beforeExecution')
	})

	test('stops the agent loop before tool execution', async () => {
		let toolWasExecuted = false
		const spyTool = defineTool({
			name: 'structured_output',
			description: 'Structured output',
			input: z.object({ data: z.any() }),
			execute: async () => {
				toolWasExecuted = true
				return 'executed'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { answer: 42 } })]),
			tools: { structured_output: spyTool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCalled:structured_output')
		expect(toolWasExecuted).toBe(false)
	})

	test('does not stop when a different tool is called', async () => {
		const otherTool = defineTool({
			name: 'other',
			description: 'Other tool',
			input: z.object({}),
			execute: async () => 'done',
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('other', {}), assistantText('Done.')]),
			tools: { other: otherTool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.finishReason).toBe('complete')
	})

	test('works in a stopWhen array with other conditions', async () => {
		const { tool } = structuredOutput(z.object({ value: z.number() }))

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { value: 99 } })]),
			tools: { structured_output: tool },
			stopWhen: [structuredOutputCalled(), { name: 'never', check: () => false }],
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCalled:structured_output')
	})

	test('handles structured_output called in parallel with other tools', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echo',
			input: z.object({ text: z.string() }),
			execute: async (input) => input.text,
		})
		const { tool } = structuredOutput(z.object({ answer: z.string() }))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCalls(
					{ toolName: 'echo', input: { text: 'hi' } },
					{ toolName: 'structured_output', input: { data: { answer: 'hello' } } },
				),
			]),
			tools: { echo: echoTool, structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		expect(result.finishReason).toBe('stopCondition')
		expect(result.stopCondition!.name).toBe('toolCalled:structured_output')
	})
})

// ─── Helpers ─────────────────────────────────────────────────────────────────
