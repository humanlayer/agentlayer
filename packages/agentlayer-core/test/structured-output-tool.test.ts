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
} from '../src/tools'
import { assistantText, assistantWithToolCall, makeToolContext, mockModel, userMessage } from './mocks'

describe('structuredOutputInput schema', () => {
	test('accepts valid data object', () => {
		const result = structuredOutputInput.safeParse({ data: { answer: 42 } })
		expect(result.success).toBe(true)
	})

	test('rejects missing data field', () => {
		const result = structuredOutputInput.safeParse({})
		expect(result.success).toBe(false)
	})
})

describe('StructuredOutputTool', () => {
	test('has the expected name', () => {
		expect(StructuredOutputTool.name).toBe('structured_output')
	})

	test('serializes generic data to JSON', async () => {
		const result = await StructuredOutputTool.execute({ data: { answer: 42 } }, makeToolContext())
		expect(result).toBe('{"answer":42}')
	})
})

describe('createStructuredOutputTool', () => {
	test('creates a structured_output tool', () => {
		const tool = createStructuredOutputTool(z.object({ answer: z.number() }))
		expect(tool.name).toBe('structured_output')
	})

	test('serializes typed data to JSON', async () => {
		const tool = createStructuredOutputTool(z.object({ answer: z.number() }))
		const result = await tool.execute({ data: { answer: 42 } }, makeToolContext())
		expect(result).toBe('{"answer":42}')
	})
})

describe('extractStructuredOutput', () => {
	test('extracts data from a structured_output tool call', () => {
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

	test('returns the most recent structured output', () => {
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
			{ role: 'user', content: 'again' },
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

	test('returns undefined when there is no structured output call', () => {
		expect(extractStructuredOutput([{ role: 'assistant', content: 'hello' }])).toBeUndefined()
	})
})

describe('structuredOutput()', () => {
	test('returns a tool and parse function', () => {
		const { tool, parse } = structuredOutput(z.object({ answer: z.number() }))
		expect(tool.name).toBe('structured_output')
		expect(typeof parse).toBe('function')
	})

	test('parse extracts and validates a RunResult payload', async () => {
		const schema = z.object({ answer: z.number(), note: z.string() })
		const { tool, parse } = structuredOutput(schema)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { answer: 42, note: 'done' } })]),
			tools: { structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(parse(result)).toEqual({ answer: 42, note: 'done' })
	})

	test('parse returns undefined when no structured output tool call was made', async () => {
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

	test('parse throws when the payload does not match the schema', async () => {
		const schema = z.object({ answer: z.number() })
		const { tool, parse } = structuredOutput(schema)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('structured_output', { data: { answer: 'wrong type' } })]),
			tools: { structured_output: tool },
			stopWhen: structuredOutputCalled(),
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(() => parse(result)).toThrow()
	})
})

describe('structuredOutputCalled', () => {
	test('matches toolCalled("structured_output") semantics', () => {
		const soCondition = structuredOutputCalled()
		const tcCondition = toolCalled('structured_output')
		expect(soCondition.name).toBe(tcCondition.name)
		expect(soCondition.timing).toBe(tcCondition.timing)
	})

	test('stops before tool execution', async () => {
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
		expect(result.stopCondition?.name).toBe('toolCalled:structured_output')
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
})
