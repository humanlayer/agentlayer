import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool, executeToolCall } from '../src'

const abortSignal = new AbortController().signal

describe('executeToolCall', () => {
	test('preserves raw and serialized multimodal output', async () => {
		const output = {
			type: 'content' as const,
			value: [{ type: 'image-data' as const, data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
		}
		const tool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string() }),
			output: z.any(),
			execute: async () => output,
		})

		const result = await executeToolCall(
			{ toolCallId: 'call-1', toolName: 'read', input: { file_path: 'image.png' } },
			{ tools: { read: tool }, messages: [], signal: abortSignal },
		)

		expect(result.rawOutput).toBe(output)
		expect(result.output).toBe(output)
		expect(result.message).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output,
				},
			],
		})
	})

	test('preserves string serialization behavior', async () => {
		const tool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string() }),
			output: z.string(),
			execute: async () => 'raw text',
			serialize: () => 'serialized text',
		})

		const result = await executeToolCall(
			{ toolCallId: 'call-1', toolName: 'read', input: { file_path: 'file.txt' } },
			{ tools: { read: tool }, messages: [], signal: abortSignal },
		)

		expect(result.rawOutput).toBe('raw text')
		expect(result.output).toBe('serialized text')
		expect(result.message).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output: { type: 'text', value: 'serialized text' },
				},
			],
		})
	})

	test('keeps execution errors text-only', async () => {
		const tool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string() }),
			output: z.string(),
			execute: async () => {
				throw new Error('nope')
			},
		})

		const result = await executeToolCall(
			{ toolCallId: 'call-1', toolName: 'read', input: { file_path: 'file.txt' } },
			{ tools: { read: tool }, messages: [], signal: abortSignal },
		)

		expect(result.isError).toBe(true)
		expect(typeof result.output === 'string' && result.output.startsWith('Tool execution failed:')).toBe(true)
		expect(result.message).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output: { type: 'text', value: 'Tool execution failed: nope' },
					isError: true,
				},
			],
		} as any)
	})
})
