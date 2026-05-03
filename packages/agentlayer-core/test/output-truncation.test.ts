import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, createReadTruncationHook, defineTool, startState, truncateWithOptions } from '../src'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

describe('truncateWithOptions', () => {
	test('returns unchanged content when under all limits', () => {
		const result = truncateWithOptions('one\ntwo', { maxLines: 5, maxBytes: 100 })

		expect(result.content).toBe('one\ntwo')
		expect(result.truncated).toBe(false)
		expect(result.truncatedLines).toBe(0)
		expect(result.truncatedBytes).toBe(0)
		expect(result.hitBytes).toBe(false)
	})

	test('truncates to maxLines from head by default', () => {
		const result = truncateWithOptions('one\ntwo\nthree', { maxLines: 2, maxBytes: 100 })

		expect(result.content).toBe('one\ntwo')
		expect(result.truncated).toBe(true)
		expect(result.truncatedLines).toBe(1)
		expect(result.hitBytes).toBe(false)
	})

	test('truncates to maxLines from tail when requested', () => {
		const result = truncateWithOptions('one\ntwo\nthree', { maxLines: 2, maxBytes: 100, direction: 'tail' })

		expect(result.content).toBe('two\nthree')
		expect(result.truncated).toBe(true)
		expect(result.truncatedLines).toBe(1)
	})

	test('truncates to maxBytes when byte limit is binding', () => {
		const result = truncateWithOptions('alpha\nbeta\ngamma', { maxLines: 10, maxBytes: 12 })

		expect(result.content).toBe('alpha\nbeta')
		expect(result.truncated).toBe(true)
		expect(result.truncatedLines).toBe(1)
		expect(result.hitBytes).toBe(true)
		expect(result.truncatedBytes).toBeGreaterThan(0)
	})

	test('sets hitBytes true when byte cap prevents keeping any line', () => {
		const result = truncateWithOptions('abcdef', { maxLines: 10, maxBytes: 3 })

		expect(result.content).toBe('')
		expect(result.truncated).toBe(true)
		expect(result.hitBytes).toBe(true)
	})

	test('applies maxLineWidth per line with ellipsis suffix', () => {
		const result = truncateWithOptions('abcdef\nxy', { maxLines: 10, maxBytes: 100, maxLineWidth: 3 })

		expect(result.content).toBe('abc...\nxy')
		expect(result.truncated).toBe(false)
	})

	test('handles empty string input', () => {
		const result = truncateWithOptions('', { maxLines: 10, maxBytes: 100 })

		expect(result.content).toBe('')
		expect(result.truncated).toBe(false)
		expect(result.truncatedLines).toBe(0)
	})

	test('handles single-line input', () => {
		const result = truncateWithOptions('only line', { maxLines: 1, maxBytes: 100 })

		expect(result.content).toBe('only line')
		expect(result.truncated).toBe(false)
	})

	test('handles input with no newlines at max bytes boundary', () => {
		const result = truncateWithOptions('abcde', { maxLines: 10, maxBytes: 6 })

		expect(result.content).toBe('abcde')
		expect(result.truncated).toBe(false)
		expect(result.hitBytes).toBe(false)
	})
})

describe('createReadTruncationHook', () => {
	test('passes through output unchanged when under limits', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string(), offset: z.number().optional() }),
			output: z.string(),
			execute: async () => 'one\ntwo',
		})
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: 'file.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: [createReadTruncationHook({ maxLines: 10, maxBytes: 100, maxLineWidth: 100 })] },
		})

		const result = await agent.run({ state: startState([userMessage('read')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe('one\ntwo')
	})

	test('applies line width capping without adding continuation hint', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string(), offset: z.number().optional() }),
			output: z.string(),
			execute: async () => 'abcdef',
		})
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: 'file.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: [createReadTruncationHook({ maxLines: 10, maxBytes: 100, maxLineWidth: 3 })] },
		})

		const result = await agent.run({ state: startState([userMessage('read')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe('abc...')
	})

	test('appends continuation hint with correct offset value when lines dropped', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string(), offset: z.number().optional() }),
			output: z.string(),
			execute: async () => 'one\ntwo\nthree',
		})
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { file_path: 'file.txt', offset: 10 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [createReadTruncationHook({ maxLines: 2, maxBytes: 100, maxLineWidth: 100 })] },
		})

		const result = await agent.run({ state: startState([userMessage('read')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe('one\ntwo\n\n(Showing lines 10-11. Use offset=12 to continue.)')
	})

	test('appends byte-specific hint when byte cap was binding', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string(), offset: z.number().optional() }),
			output: z.string(),
			execute: async () => 'alpha\nbeta\ngamma',
		})
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: 'file.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: { postToolUse: [createReadTruncationHook({ maxLines: 10, maxBytes: 12, maxLineWidth: 100 })] },
		})

		const result = await agent.run({ state: startState([userMessage('read')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe(
			'alpha\nbeta\n\n(Output capped at 0 KB. Showing lines 1-2. Use offset=3 to continue.)',
		)
	})

	test('uses custom hint function when provided', async () => {
		const readTool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string(), offset: z.number().optional() }),
			output: z.string(),
			execute: async () => 'one\ntwo\nthree',
		})
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('read', { file_path: 'file.txt' }), assistantText('Done.')]),
			tools: { read: readTool },
			hooks: {
				postToolUse: [
					createReadTruncationHook({
						maxLines: 1,
						maxBytes: 100,
						maxLineWidth: 100,
						hint: (ctx) => `custom ${ctx.toolName} ${ctx.nextOffset} ${ctx.truncatedLines}`,
					}),
				],
			},
		})

		const result = await agent.run({ state: startState([userMessage('read')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe('one\n\ncustom read 2 2')
	})

	test('does not mutate non-read tool output', async () => {
		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes input',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'one\ntwo\nthree' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [createReadTruncationHook({ maxLines: 1, maxBytes: 100 })] },
		})

		const result = await agent.run({ state: startState([userMessage('echo')]) }).result
		const [toolResultPart] = getToolResults(result.state.messages)

		expect(outputValue(toolResultPart!)).toBe('one\ntwo\nthree')
	})
})
