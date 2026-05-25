import type { ModelMessage } from 'ai'
import * as z from 'zod'
import type { RunResult } from '../agent'
import { defineTool } from '../define-tool'
import { STRUCTURED_OUTPUT_DESCRIPTION } from '../prompts'

/**
 * Input for the generic structured output tool.
 * The `data` field holds the structured response as a free-form object.
 */
export const structuredOutputInput = z.object({
	data: z.record(z.string(), z.unknown()).describe('The structured output data matching the required schema'),
})

export type StructuredOutputInput = z.infer<typeof structuredOutputInput>

/**
 * A pre-built StructuredOutput tool that accepts any JSON object.
 *
 * For schema-validated structured output, use `structuredOutput(schema)`
 * or `createStructuredOutputTool(schema)` instead.
 */
export const StructuredOutputTool = defineTool({
	name: 'structured_output',
	description: STRUCTURED_OUTPUT_DESCRIPTION,
	input: structuredOutputInput,
	execute: async (input) => {
		return JSON.stringify(input.data)
	},
})

/**
 * Create a typed StructuredOutput tool validated against a Zod schema.
 *
 * @param schema - A Zod schema describing the expected output shape.
 */
export function createStructuredOutputTool<T extends z.ZodType>(schema: T) {
	const jsonSchema = z.toJSONSchema(schema)

	const description = [
		STRUCTURED_OUTPUT_DESCRIPTION,
		'',
		'The `data` field must conform to the following JSON Schema:',
		'```json',
		JSON.stringify(jsonSchema, null, 2),
		'```',
	].join('\n')

	const inputSchema = z.object({
		data: (schema as z.ZodType).describe('The structured output data matching the required schema'),
	})

	return defineTool({
		name: 'structured_output',
		description,
		input: inputSchema as any,
		execute: async (input: { data: z.infer<T> }) => {
			return JSON.stringify(input.data)
		},
	})
}

/**
 * Extract the raw `data` value from a `structured_output` tool call in a
 * list of messages. Scans backwards to find the most recent call.
 *
 * Returns `undefined` if no `structured_output` tool call is found.
 */
export function extractStructuredOutput(messages: readonly ModelMessage[]): unknown | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
		for (const part of msg.content) {
			if (part.type === 'tool-call' && part.toolName === 'structured_output') {
				const input = typeof part.input === 'string' ? JSON.parse(part.input) : part.input
				return (input as Record<string, unknown>).data
			}
		}
	}
	return undefined
}

/**
 * All-in-one structured output helper.
 *
 * Returns:
 * - `tool` - a `structured_output` tool wired to the given Zod schema
 * - `parse(result)` - extracts and validates the structured data from a `RunResult`
 *
 * `parse` returns the typed data on success, or `undefined` if no
 * `structured_output` tool call was found in the result messages.
 * Throws a `ZodError` if the data is present but fails schema validation.
 */
export function structuredOutput<T extends z.ZodType>(schema: T) {
	const tool = createStructuredOutputTool(schema)

	function parse(result: RunResult): z.infer<T> | undefined {
		const raw = extractStructuredOutput(result.state.messages)
		if (raw === undefined) return undefined
		return schema.parse(raw) as z.infer<T>
	}

	return { tool, parse }
}
