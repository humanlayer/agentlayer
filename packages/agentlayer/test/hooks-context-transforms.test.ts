/**
 * Tests for built-in pre-request hooks: stripThinkingTokens, deduplicateReads, truncateOldBashResults
 *
 * Unit tests exercise each hook directly via runPreRequestHooks.
 * Integration tests run the full Agent loop to verify hooks compose with the agent correctly.
 */

import { describe, expect, test } from 'bun:test'
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { runPreRequestHooks } from '../src/core/hooks'
import { deduplicateReads, stripThinkingTokens, truncateOldBashResults } from '../src/hooks/context-transforms'
import { assistantText, assistantWithToolCall, userMessage } from './mocks'

// ── Shared helpers ────────────────────────────────────────────────────────────

const MOCK_USAGE: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

/**
 * A mock model that captures the prompt (messages) sent on each call.
 * Useful for verifying what the model "sees" after pre-request hooks.
 */
function capturingModel(
	responses: Array<Pick<LanguageModelV3GenerateResult, 'content'>>,
	onCall?: (options: LanguageModelV3CallOptions) => void,
): LanguageModelV3 {
	let index = 0
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			onCall?.(options)
			if (index >= responses.length) {
				throw new Error(`capturingModel: no more responses`)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c: LanguageModelV3Content) => c.type === 'tool-call')
			return {
				content: response.content,
				finishReason: {
					unified: hasToolCalls ? 'tool-calls' : 'stop',
					raw: hasToolCalls ? 'tool_use' : 'stop',
				},
				usage: MOCK_USAGE,
				warnings: [],
			}
		},
		async doStream() {
			throw new Error('capturingModel: streaming not supported')
		},
	}
}

/** Helper to build an assistant message with string content. */
function assistantMessage(content: string): ModelMessage {
	return { role: 'assistant' as const, content }
}

/** Helper to build an assistant message with an array of text parts. */
function assistantMessageParts(parts: Array<{ type: 'text'; text: string }>): ModelMessage {
	return { role: 'assistant' as const, content: parts } as ModelMessage
}

/** Helper to build an assistant message with mixed text and reasoning parts. */
function assistantWithReasoning(
	parts: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string }>,
): ModelMessage {
	return { role: 'assistant' as const, content: parts } as ModelMessage
}

/**
 * Helper to build an assistant message with a tool call.
 * Uses `input` field per the AI SDK ToolCallPart interface.
 */
function assistantToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): ModelMessage {
	return {
		role: 'assistant' as const,
		content: [
			{
				type: 'tool-call' as const,
				toolCallId,
				toolName,
				input,
			},
		],
	} as ModelMessage
}

/** Helper to build a tool result message. */
function toolResult(toolCallId: string, toolName: string, result: string): ModelMessage {
	return {
		role: 'tool' as const,
		content: [
			{
				type: 'tool-result' as const,
				toolCallId,
				toolName,
				output: { type: 'text' as const, value: result },
			},
		],
	} as ModelMessage
}

/** Helper to extract text content from a message, handling both string and array forms. */
function getTextContent(msg: ModelMessage): string {
	if (typeof msg.content === 'string') return msg.content
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((p: any) => p.type === 'text')
			.map((p: any) => p.text)
			.join('')
	}
	return ''
}

/** Helper to extract tool result output value from a tool message. */
function getToolResultOutput(msg: ModelMessage): string {
	if (msg.role !== 'tool' || !Array.isArray(msg.content)) return ''
	const part = msg.content[0] as any
	if (!part || part.type !== 'tool-result') return ''
	return typeof part.output === 'string' ? part.output : (part.output?.value ?? '')
}

// ═══════════════════════════════════════════════════════════════════════════════
// stripThinkingTokens
// ═══════════════════════════════════════════════════════════════════════════════

describe('stripThinkingTokens', () => {
	/** Helper to check if any content part has type 'reasoning'. */
	function hasReasoningParts(msg: ModelMessage): boolean {
		if (!Array.isArray(msg.content)) return false
		return msg.content.some((p: any) => p.type === 'reasoning')
	}

	describe('unit tests (via runPreRequestHooks)', () => {
		test('strips structured reasoning parts from assistant array content', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hello' },
				assistantWithReasoning([
					{ type: 'reasoning', text: 'internal reasoning about the task' },
					{ type: 'text', text: 'I will help you.' },
				]),
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			expect(result.transformed).toBe(true)
			expect(result.persist).toBe(false)
			expect(getTextContent(result.messages[1]!)).toBe('I will help you.')
			expect(hasReasoningParts(result.messages[1]!)).toBe(false)
			// User message should be unchanged
			expect(result.messages[0]).toEqual({ role: 'user', content: 'hello' })
		})

		test('strips multiple reasoning parts from a single message', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantWithReasoning([
					{ type: 'reasoning', text: 'thought 1' },
					{ type: 'text', text: 'Step 1.' },
					{ type: 'reasoning', text: 'thought 2' },
					{ type: 'text', text: 'Step 2.' },
				]),
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			expect(result.transformed).toBe(true)
			const assistantMsg = result.messages[1]!
			expect(hasReasoningParts(assistantMsg)).toBe(false)
			const parts = assistantMsg.content as any[]
			expect(parts).toHaveLength(2)
			expect(parts[0].text).toBe('Step 1.')
			expect(parts[1].text).toBe('Step 2.')
		})

		test('returns next() when no reasoning parts present (no unnecessary transform)', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hello' },
				assistantMessage('I will help you with that.'),
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			expect(result.transformed).toBe(false)
			expect(result.messages).toEqual(messages)
		})

		test('returns next() for array content with only text parts', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hello' },
				assistantMessageParts([
					{ type: 'text', text: 'Part 1.' },
					{ type: 'text', text: 'Part 2.' },
				]),
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			expect(result.transformed).toBe(false)
		})

		test('strips reasoning parts while preserving text and tool-call parts', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hello' },
				{
					role: 'assistant' as const,
					content: [
						{ type: 'reasoning', text: 'let me think...' },
						{ type: 'text', text: 'I will read the file.' },
						{ type: 'tool-call', toolCallId: 'tc1', toolName: 'read', input: { filePath: '/foo.ts' } },
					],
				} as ModelMessage,
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			expect(result.transformed).toBe(true)
			const parts = result.messages[1]!.content as any[]
			expect(parts).toHaveLength(2)
			expect(parts[0].type).toBe('text')
			expect(parts[1].type).toBe('tool-call')
		})

		test('works with textPatterns fallback for raw XML in text', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hi' },
				assistantMessage('<scratchpad>notes here</scratchpad>Final response.'),
			]

			const result = await runPreRequestHooks(
				[stripThinkingTokens({ textPatterns: [/<scratchpad>[\s\S]*?<\/scratchpad>/g] })],
				{ messages },
			)

			expect(result.transformed).toBe(true)
			expect(getTextContent(result.messages[1]!)).toBe('Final response.')
		})

		test('textPatterns strips from text parts in array content', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hello' },
				assistantMessageParts([
					{ type: 'text', text: '<thinking>reasoning</thinking>Part 1.' },
					{ type: 'text', text: 'Part 2.' },
				]),
			]

			const result = await runPreRequestHooks(
				[stripThinkingTokens({ textPatterns: [/<thinking>[\s\S]*?<\/thinking>/gi] })],
				{ messages },
			)

			expect(result.transformed).toBe(true)
			const assistantMsg = result.messages[1]!
			expect(Array.isArray(assistantMsg.content)).toBe(true)
			const parts = assistantMsg.content as any[]
			expect(parts[0].text).toBe('Part 1.')
			expect(parts[1].text).toBe('Part 2.')
		})

		test('combines structured reasoning removal with textPatterns', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				{
					role: 'assistant' as const,
					content: [
						{ type: 'reasoning', text: 'structured reasoning here' },
						{ type: 'text', text: '<scratchpad>extra notes</scratchpad>The answer.' },
					],
				} as ModelMessage,
			]

			const result = await runPreRequestHooks(
				[stripThinkingTokens({ textPatterns: [/<scratchpad>[\s\S]*?<\/scratchpad>/g] })],
				{ messages },
			)

			expect(result.transformed).toBe(true)
			const parts = result.messages[1]!.content as any[]
			expect(parts).toHaveLength(1)
			expect(parts[0].type).toBe('text')
			expect(parts[0].text).toBe('The answer.')
		})

		test('does not touch string content without textPatterns configured', async () => {
			// String content with XML-like tags should pass through when no textPatterns set
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'hi' },
				assistantMessage('<thinking>this is plain text</thinking>Result.'),
			]

			const result = await runPreRequestHooks([stripThinkingTokens()], { messages })

			// No structured reasoning parts to strip, and no textPatterns configured
			expect(result.transformed).toBe(false)
		})
	})

	describe('integration test (via Agent)', () => {
		test('reasoning parts are stripped from what the model sees on subsequent turns', async () => {
			const capturedMessages: ModelMessage[][] = []

			const echoTool = defineTool({
				name: 'echo',
				description: 'Echoes input',
				input: z.object({ text: z.string() }),
				output: z.string(),
				execute: async (input) => input.text,
			})

			const model = capturingModel(
				[assistantWithToolCall('echo', { text: 'hello' }), assistantText('Done.')],
				(options) => {
					capturedMessages.push([...(options.prompt as ModelMessage[])])
				},
			)

			const agent = new Agent({
				model,
				tools: { echo: echoTool },
				hooks: { preRequest: [stripThinkingTokens()] },
			})

			const result = await agent.run({ state: startState([userMessage('go')]) }).result

			expect(result.finishReason).toBe('complete')
			expect(capturedMessages.length).toBe(2)

			// Verify hook ran without error and no reasoning parts leak through
			const secondCallMsgs = capturedMessages[1]!
			const assistantMsgs = secondCallMsgs.filter((m) => m.role === 'assistant')
			for (const msg of assistantMsgs) {
				expect(hasReasoningParts(msg)).toBe(false)
			}
		})

		test('reasoning parts in prior state are stripped before model sees them', async () => {
			let firstCallMessages: ModelMessage[] = []

			const echoTool = defineTool({
				name: 'echo',
				description: 'Echoes input',
				input: z.object({ text: z.string() }),
				output: z.string(),
				execute: async (input) => input.text,
			})

			const model = capturingModel([assistantText('Got it.')], (options) => {
				firstCallMessages = options.prompt as ModelMessage[]
			})

			const agent = new Agent({
				model,
				tools: { echo: echoTool },
				hooks: { preRequest: [stripThinkingTokens()] },
			})

			// Simulate prior context with structured reasoning parts already in the state
			const priorState: ModelMessage[] = [
				userMessage('What is 2+2?'),
				assistantWithReasoning([
					{ type: 'reasoning', text: 'I need to add 2 and 2' },
					{ type: 'text', text: 'The answer is 4.' },
				]),
				userMessage('Thanks! What is 3+3?'),
			]

			const result = await agent.run({ state: startState(priorState) }).result

			expect(result.finishReason).toBe('complete')

			// The model should see the assistant message WITHOUT reasoning parts
			const assistantMsg = firstCallMessages.find(
				(m) => m.role === 'assistant' && getTextContent(m).includes('answer is 4'),
			)
			expect(assistantMsg).toBeDefined()
			expect(hasReasoningParts(assistantMsg!)).toBe(false)
			expect(getTextContent(assistantMsg!)).toBe('The answer is 4.')

			// But the actual state should retain the original reasoning parts (no persist)
			const stateAssistant = result.state.messages.find(
				(m) => m.role === 'assistant' && getTextContent(m).includes('answer is 4'),
			)
			expect(stateAssistant).toBeDefined()
			expect(hasReasoningParts(stateAssistant!)).toBe(true)
		})
	})
})

// ═══════════════════════════════════════════════════════════════════════════════
// deduplicateReads
// ═══════════════════════════════════════════════════════════════════════════════

describe('deduplicateReads', () => {
	describe('unit tests (via runPreRequestHooks)', () => {
		test('replaces earlier read results when same file is read later', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'read the file' },
				// First read of /foo.ts
				assistantToolCall('tc1', 'read', { filePath: '/foo.ts' }),
				toolResult('tc1', 'read', '1\u2192 const x = 1\n2\u2192 const y = 2'),
				// Some other interaction
				assistantMessage('I see the file.'),
				{ role: 'user', content: 'read it again' },
				// Second read of /foo.ts
				assistantToolCall('tc2', 'read', { filePath: '/foo.ts' }),
				toolResult('tc2', 'read', '1\u2192 const x = 100\n2\u2192 const y = 200'),
			]

			const result = await runPreRequestHooks([deduplicateReads()], { messages })

			expect(result.transformed).toBe(true)
			expect(result.persist).toBe(false)

			// First read result (tc1) should be replaced with a placeholder
			const firstToolResult = result.messages[2]!
			const firstOutput = getToolResultOutput(firstToolResult)
			expect(firstOutput).toContain('was read again later')
			expect(firstOutput).toContain('/foo.ts')

			// Second read result (tc2) should be intact
			const secondToolResult = result.messages[6]!
			const secondOutput = getToolResultOutput(secondToolResult)
			expect(secondOutput).toContain('const x = 100')
		})

		test('keeps the most recent read result intact', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'read', { filePath: '/bar.ts' }),
				toolResult('tc1', 'read', 'old content'),
				assistantToolCall('tc2', 'read', { filePath: '/bar.ts' }),
				toolResult('tc2', 'read', 'new content'),
			]

			const result = await runPreRequestHooks([deduplicateReads()], { messages })

			expect(result.transformed).toBe(true)
			// Most recent read (tc2) should be preserved exactly
			const latestToolResult = result.messages[4]!
			expect(getToolResultOutput(latestToolResult)).toBe('new content')
		})

		test('handles multiple files — only deduplicates per-file', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				// Read /a.ts
				assistantToolCall('tc1', 'read', { filePath: '/a.ts' }),
				toolResult('tc1', 'read', 'content of a'),
				// Read /b.ts
				assistantToolCall('tc2', 'read', { filePath: '/b.ts' }),
				toolResult('tc2', 'read', 'content of b'),
				// Read /a.ts again
				assistantToolCall('tc3', 'read', { filePath: '/a.ts' }),
				toolResult('tc3', 'read', 'updated content of a'),
			]

			const result = await runPreRequestHooks([deduplicateReads()], { messages })

			expect(result.transformed).toBe(true)

			// /a.ts first read (tc1) should be replaced
			expect(getToolResultOutput(result.messages[2]!)).toContain('was read again later')

			// /b.ts read (tc2) should be unchanged — only one read of /b.ts
			expect(getToolResultOutput(result.messages[4]!)).toBe('content of b')

			// /a.ts second read (tc3) should be intact
			expect(getToolResultOutput(result.messages[6]!)).toBe('updated content of a')
		})

		test('returns next() when no duplicate reads exist', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'read', { filePath: '/a.ts' }),
				toolResult('tc1', 'read', 'content a'),
				assistantToolCall('tc2', 'read', { filePath: '/b.ts' }),
				toolResult('tc2', 'read', 'content b'),
			]

			const result = await runPreRequestHooks([deduplicateReads()], { messages })

			expect(result.transformed).toBe(false)
		})

		test('works with persist option', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'read', { filePath: '/foo.ts' }),
				toolResult('tc1', 'read', 'old'),
				assistantToolCall('tc2', 'read', { filePath: '/foo.ts' }),
				toolResult('tc2', 'read', 'new'),
			]

			const result = await runPreRequestHooks([deduplicateReads({ persist: true })], { messages })

			expect(result.transformed).toBe(true)
			expect(result.persist).toBe(true)
		})
	})

	describe('integration test (via Agent)', () => {
		test('deduplication works end-to-end in the agent loop', async () => {
			let lastCallMessages: ModelMessage[] = []
			let callCount = 0

			const readTool = defineTool({
				name: 'read',
				description: 'Read a file',
				input: z.object({ filePath: z.string() }),
				output: z.string(),
				execute: async (input) => `contents of ${input.filePath}`,
			})

			const model = capturingModel(
				[
					// Turn 1: read /foo.ts
					assistantWithToolCall('read', { filePath: '/foo.ts' }),
					// Turn 2: read /foo.ts again
					assistantWithToolCall('read', { filePath: '/foo.ts' }),
					// Turn 3: done
					assistantText('All done.'),
				],
				(options) => {
					callCount++
					lastCallMessages = options.prompt as ModelMessage[]
				},
			)

			const agent = new Agent({
				model,
				tools: { read: readTool },
				hooks: { preRequest: [deduplicateReads()] },
			})

			const result = await agent.run({ state: startState([userMessage('read the file twice')]) }).result

			expect(result.finishReason).toBe('complete')

			// On the 3rd call (final assistant text), the model should see
			// the first read result replaced and the second read result intact
			expect(callCount).toBe(3)
			const toolMsgs = lastCallMessages.filter((m) => m.role === 'tool')
			expect(toolMsgs.length).toBeGreaterThanOrEqual(2)

			// First tool result should be deduplicated
			const firstToolOutput = getToolResultOutput(toolMsgs[0]!)
			expect(firstToolOutput).toContain('was read again later')

			// Second tool result should be intact
			const secondToolOutput = getToolResultOutput(toolMsgs[1]!)
			expect(secondToolOutput).toContain('contents of /foo.ts')
		})
	})
})

// ═══════════════════════════════════════════════════════════════════════════════
// truncateOldBashResults
// ═══════════════════════════════════════════════════════════════════════════════

describe('truncateOldBashResults', () => {
	/** Generate a multi-line bash output string with N lines. */
	function bashOutput(lineCount: number): string {
		return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n')
	}

	describe('unit tests (via runPreRequestHooks)', () => {
		test('keeps last N bash results in full (default 3)', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				// 4 bash results — first one should be truncated, last 3 kept
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(20)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(20)),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', bashOutput(20)),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', bashOutput(20)),
			]

			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			expect(result.transformed).toBe(true)

			// tc1 should be truncated
			const tc1Output = getToolResultOutput(result.messages[2]!)
			expect(tc1Output).toContain('truncated')
			expect(tc1Output).not.toContain('line 20')

			// tc2, tc3, tc4 should be kept in full
			expect(getToolResultOutput(result.messages[4]!)).toBe(bashOutput(20))
			expect(getToolResultOutput(result.messages[6]!)).toBe(bashOutput(20))
			expect(getToolResultOutput(result.messages[8]!)).toBe(bashOutput(20))
		})

		test('truncates earlier bash results to summaryLines (default 5)', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(50)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(10)),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', bashOutput(10)),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', bashOutput(10)),
			]

			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			const truncated = getToolResultOutput(result.messages[2]!)
			const lines = truncated.split('\n')
			// Should have 5 summary lines + 1 truncation hint line = 6 lines
			expect(lines).toHaveLength(6)
			expect(lines[0]).toBe('line 1')
			expect(lines[4]).toBe('line 5')
		})

		test('truncated results include line count hint', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(100)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', 'ok'),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', 'ok'),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', 'ok'),
			]

			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			const truncated = getToolResultOutput(result.messages[2]!)
			// Format: [... N total lines — truncated]
			expect(truncated).toContain('100 total lines')
			expect(truncated).toContain('truncated')
		})

		test('non-bash tool results are not affected', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				// A read result that should not be touched
				assistantToolCall('tc0', 'read', { filePath: '/foo.ts' }),
				toolResult('tc0', 'read', bashOutput(100)),
				// 4 bash results
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(50)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', 'ok'),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', 'ok'),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', 'ok'),
			]

			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			// The read result should be completely unchanged
			const readOutput = getToolResultOutput(result.messages[2]!)
			expect(readOutput).toBe(bashOutput(100))

			// The first bash result should be truncated
			const bashTruncated = getToolResultOutput(result.messages[4]!)
			expect(bashTruncated).toContain('truncated')
		})

		test('returns next() when fewer than N bash results exist (nothing to truncate)', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(50)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(50)),
			]

			// Default keep=3, we only have 2 bash results
			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			expect(result.transformed).toBe(false)
		})

		test('respects custom keep and summaryLines options', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(30)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(30)),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', bashOutput(30)),
			]

			// keep=1 means only the last 1 is kept, summaryLines=2 means 2 lines kept
			const result = await runPreRequestHooks([truncateOldBashResults({ keep: 1, summaryLines: 2 })], {
				messages,
			})

			expect(result.transformed).toBe(true)

			// tc1 and tc2 should be truncated
			const tc1Output = getToolResultOutput(result.messages[2]!)
			const tc1Lines = tc1Output.split('\n')
			expect(tc1Lines).toHaveLength(3) // 2 summary lines + 1 hint
			expect(tc1Lines[0]).toBe('line 1')
			expect(tc1Lines[1]).toBe('line 2')
			expect(tc1Lines[2]).toContain('truncated')

			const tc2Output = getToolResultOutput(result.messages[4]!)
			expect(tc2Output).toContain('truncated')

			// tc3 should be kept in full
			expect(getToolResultOutput(result.messages[6]!)).toBe(bashOutput(30))
		})

		test('works with persist option', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', bashOutput(20)),
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(20)),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', bashOutput(20)),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', bashOutput(20)),
			]

			const result = await runPreRequestHooks([truncateOldBashResults({ persist: true })], { messages })

			expect(result.transformed).toBe(true)
			expect(result.persist).toBe(true)
		})

		test('does not truncate results that are already short', async () => {
			const messages: ModelMessage[] = [
				{ role: 'user', content: 'go' },
				assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
				toolResult('tc1', 'bash', 'ok'), // Only 1 line, less than summaryLines
				assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
				toolResult('tc2', 'bash', bashOutput(20)),
				assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
				toolResult('tc3', 'bash', bashOutput(20)),
				assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
				toolResult('tc4', 'bash', bashOutput(20)),
			]

			const result = await runPreRequestHooks([truncateOldBashResults()], { messages })

			expect(result.transformed).toBe(true)
			// tc1 is old but has only 1 line — it should not get a truncation hint
			// because totalLines (1) <= summaryLines (5)
			const tc1Output = getToolResultOutput(result.messages[2]!)
			expect(tc1Output).toBe('ok')
		})
	})

	describe('integration test (via Agent)', () => {
		test('truncation works end-to-end in the agent loop', async () => {
			let lastCallMessages: ModelMessage[] = []
			let callCount = 0

			const bashTool = defineTool({
				name: 'bash',
				description: 'Run a command',
				input: z.object({ command: z.string() }),
				output: z.string(),
				execute: async () => bashOutput(30),
			})

			const model = capturingModel(
				[
					assistantWithToolCall('bash', { command: 'cmd1' }),
					assistantWithToolCall('bash', { command: 'cmd2' }),
					assistantWithToolCall('bash', { command: 'cmd3' }),
					assistantWithToolCall('bash', { command: 'cmd4' }),
					assistantText('All done.'),
				],
				(options) => {
					callCount++
					lastCallMessages = options.prompt as ModelMessage[]
				},
			)

			const agent = new Agent({
				model,
				tools: { bash: bashTool },
				hooks: { preRequest: [truncateOldBashResults({ keep: 2 })] },
			})

			const result = await agent.run({ state: startState([userMessage('run 4 commands')]) }).result

			expect(result.finishReason).toBe('complete')

			// On the final call (call 5), the model should see:
			// - tc1 and tc2 bash results truncated (only last 2 kept)
			// - tc3 and tc4 bash results in full
			expect(callCount).toBe(5)
			const toolMsgs = lastCallMessages.filter((m) => m.role === 'tool')
			expect(toolMsgs.length).toBe(4)

			// First two should be truncated
			const firstOutput = getToolResultOutput(toolMsgs[0]!)
			expect(firstOutput).toContain('truncated')
			expect(firstOutput).not.toContain('line 30')

			const secondOutput = getToolResultOutput(toolMsgs[1]!)
			expect(secondOutput).toContain('truncated')

			// Last two should be in full
			const thirdOutput = getToolResultOutput(toolMsgs[2]!)
			expect(thirdOutput).toBe(bashOutput(30))

			const fourthOutput = getToolResultOutput(toolMsgs[3]!)
			expect(fourthOutput).toBe(bashOutput(30))
		})
	})
})

// ═══════════════════════════════════════════════════════════════════════════════
// Composition — multiple pre-request hooks together
// ═══════════════════════════════════════════════════════════════════════════════

describe('pre-request hook composition', () => {
	test('stripThinkingTokens and truncateOldBashResults compose correctly', async () => {
		function bashOutput(n: number): string {
			return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')
		}

		const messages: ModelMessage[] = [
			{ role: 'user', content: 'go' },
			{
				role: 'assistant' as const,
				content: [
					{ type: 'reasoning', text: 'plan step' },
					{ type: 'text', text: 'Running commands.' },
				],
			} as ModelMessage,
			assistantToolCall('tc1', 'bash', { command: 'cmd1' }),
			toolResult('tc1', 'bash', bashOutput(50)),
			assistantToolCall('tc2', 'bash', { command: 'cmd2' }),
			toolResult('tc2', 'bash', bashOutput(10)),
			assistantToolCall('tc3', 'bash', { command: 'cmd3' }),
			toolResult('tc3', 'bash', bashOutput(10)),
			assistantToolCall('tc4', 'bash', { command: 'cmd4' }),
			toolResult('tc4', 'bash', bashOutput(10)),
		]

		const result = await runPreRequestHooks([stripThinkingTokens(), truncateOldBashResults()], { messages })

		expect(result.transformed).toBe(true)

		// Reasoning parts should be stripped
		expect(getTextContent(result.messages[1]!)).toBe('Running commands.')
		const parts = result.messages[1]!.content as any[]
		expect(parts.every((p: any) => p.type !== 'reasoning')).toBe(true)

		// First bash result should be truncated
		expect(getToolResultOutput(result.messages[3]!)).toContain('truncated')
	})
})
