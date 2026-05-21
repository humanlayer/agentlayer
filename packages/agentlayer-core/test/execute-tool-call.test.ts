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

	test('tool.serialize is called even when raw output has type field matching ToolResultOutput types', async () => {
		// This test covers the bug where ReadMultimodalTool returns { type: 'text', content: '...' }
		// but the AI SDK expects { type: 'text', value: '...' }. The isToolResultOutput check
		// incorrectly matched because it only validated the type field, not the full structure,
		// causing tool.serialize to be skipped.
		const rawOutput = { type: 'text' as const, content: 'file contents here' }

		const tool = defineTool({
			name: 'read',
			description: 'Read a file',
			input: z.object({ file_path: z.string() }),
			output: z.object({ type: z.literal('text'), content: z.string() }),
			execute: async () => rawOutput,
			serialize: (raw) => {
				// Transform { type: 'text', content: '...' } to the correct AI SDK format
				return { type: 'text' as const, value: raw.content }
			},
		})

		const result = await executeToolCall(
			{ toolCallId: 'call-1', toolName: 'read', input: { file_path: 'file.txt' } },
			{ tools: { read: tool }, messages: [], signal: abortSignal },
		)

		expect(result.rawOutput).toEqual(rawOutput)
		// The serialize function should have been called, transforming content -> value
		expect(result.output).toEqual({ type: 'text', value: 'file contents here' })
		expect(result.message).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output: { type: 'text', value: 'file contents here' },
				},
			],
		})
	})

	test('tool.serialize takes priority over isToolResultOutput for all matching types', async () => {
		// Test with 'json' type to ensure the fix works for all ToolResultOutput type variants
		const rawOutput = { type: 'json' as const, data: { foo: 'bar' } }

		const tool = defineTool({
			name: 'getData',
			description: 'Get JSON data',
			input: z.object({}),
			output: z.object({ type: z.literal('json'), data: z.any() }),
			execute: async () => rawOutput,
			serialize: (raw) => {
				// Transform { type: 'json', data: {...} } to { type: 'json', value: {...} }
				return { type: 'json' as const, value: raw.data }
			},
		})

		const result = await executeToolCall(
			{ toolCallId: 'call-1', toolName: 'getData', input: {} },
			{ tools: { getData: tool }, messages: [], signal: abortSignal },
		)

		expect(result.rawOutput).toEqual(rawOutput)
		// serialize should be called even though raw has type: 'json'
		expect(result.output).toEqual({ type: 'json', value: { foo: 'bar' } })
	})
})
