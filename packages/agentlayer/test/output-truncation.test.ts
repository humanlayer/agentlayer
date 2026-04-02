/**
 * Unit tests for truncateWithOptions and createReadTruncationHook.
 *
 * Covers:
 * - Under-limit input returns content unchanged with truncated=false
 * - Line-count truncation (head direction)
 * - Byte-count truncation
 * - Per-line width capping
 * - Tail direction
 * - Combined limits (first constraint wins)
 * - createReadTruncationHook: no-op when under limit
 * - createReadTruncationHook: appends line-limit hint
 * - createReadTruncationHook: appends byte-limit hint
 * - createReadTruncationHook: per-line width cap applied
 * - createReadTruncationHook: custom hint factory
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { createReadTruncationHook, truncateWithOptions } from '../src/hooks/output-truncation'
import { ReadTool } from '../src/tools/interfaces/read'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

// ── truncateWithOptions — under-limit ─────────────────────────────────────────

describe('truncateWithOptions — under-limit input', () => {
	test('returns content unchanged when within all limits', () => {
		const input = 'line one\nline two\nline three'
		const result = truncateWithOptions(input)
		expect(result.content).toBe(input)
		expect(result.truncated).toBe(false)
		expect(result.truncatedLines).toBe(0)
		expect(result.truncatedBytes).toBe(0)
		expect(result.hitBytes).toBe(false)
	})

	test('empty string is not truncated', () => {
		const result = truncateWithOptions('')
		expect(result.content).toBe('')
		expect(result.truncated).toBe(false)
	})

	test('single line under maxLineWidth is unchanged', () => {
		const result = truncateWithOptions('hello world', { maxLineWidth: 100 })
		expect(result.content).toBe('hello world')
		expect(result.truncated).toBe(false)
	})
})

// ── truncateWithOptions — line-count truncation ───────────────────────────────

describe('truncateWithOptions — line-count truncation', () => {
	test('truncates to maxLines', () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const input = lines.join('\n')
		const result = truncateWithOptions(input, { maxLines: 5 })
		expect(result.truncated).toBe(true)
		expect(result.truncatedLines).toBe(5)
		expect(result.hitBytes).toBe(false)
		const keptLines = result.content.split('\n')
		expect(keptLines).toHaveLength(5)
		expect(keptLines[0]).toBe('line 1')
		expect(keptLines[4]).toBe('line 5')
	})

	test('does not truncate when line count equals maxLines exactly', () => {
		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`)
		const result = truncateWithOptions(lines.join('\n'), { maxLines: 5 })
		expect(result.truncated).toBe(false)
		expect(result.truncatedLines).toBe(0)
	})

	test('truncatedLines reflects the correct count', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
		const result = truncateWithOptions(lines.join('\n'), { maxLines: 7 })
		expect(result.truncatedLines).toBe(13)
	})
})

// ── truncateWithOptions — byte-count truncation ───────────────────────────────

describe('truncateWithOptions — byte-count truncation', () => {
	test('truncates when content exceeds maxBytes', () => {
		// Each line is "line XX\n" = ~8 bytes; 200 lines = ~1600 bytes
		const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1).padStart(2, '0')}`)
		const input = lines.join('\n')
		const result = truncateWithOptions(input, { maxBytes: 200 })
		expect(result.truncated).toBe(true)
		expect(result.hitBytes).toBe(true)
		expect(result.truncatedBytes).toBeGreaterThan(0)
	})

	test('truncatedBytes is positive when byte cap is hit', () => {
		const bigLine = 'A'.repeat(1000)
		const input = Array.from({ length: 10 }, () => bigLine).join('\n')
		const result = truncateWithOptions(input, { maxBytes: 2000 })
		expect(result.hitBytes).toBe(true)
		expect(result.truncatedBytes).toBeGreaterThan(0)
		expect(result.content.length).toBeLessThan(input.length)
	})
})

// ── truncateWithOptions — per-line width capping ──────────────────────────────

describe('truncateWithOptions — per-line width capping', () => {
	test('caps lines exceeding maxLineWidth', () => {
		const longLine = 'A'.repeat(200)
		const result = truncateWithOptions(longLine, { maxLineWidth: 50 })
		// Content has 1 line, capped to 50 chars + ellipsis character
		const keptLine = result.content
		expect(keptLine.length).toBe(51) // 50 chars + '…'
		expect(keptLine.endsWith('…')).toBe(true)
	})

	test('does not cap lines shorter than maxLineWidth', () => {
		const line = 'short line'
		const result = truncateWithOptions(line, { maxLineWidth: 100 })
		expect(result.content).toBe('short line')
	})

	test('per-line width cap applied before byte/line counting', () => {
		// 5 lines of 1000 chars each; maxLineWidth=10, maxBytes=1000
		// After capping, lines are 11 chars (10 + ellipsis), so 5*12 bytes ≈ 60 — well under 1000
		const longLine = 'X'.repeat(1000)
		const input = Array.from({ length: 5 }, () => longLine).join('\n')
		const result = truncateWithOptions(input, { maxLineWidth: 10, maxBytes: 1000 })
		expect(result.truncated).toBe(false)
		const keptLines = result.content.split('\n')
		expect(keptLines).toHaveLength(5)
		for (const line of keptLines) {
			expect(line.endsWith('…')).toBe(true)
			expect(line.length).toBe(11)
		}
	})
})

// ── truncateWithOptions — tail direction ──────────────────────────────────────

describe('truncateWithOptions — tail direction', () => {
	test('keeps last N lines when direction is tail', () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const result = truncateWithOptions(lines.join('\n'), { maxLines: 3, direction: 'tail' })
		expect(result.truncated).toBe(true)
		const keptLines = result.content.split('\n')
		expect(keptLines).toHaveLength(3)
		expect(keptLines[0]).toBe('line 8')
		expect(keptLines[1]).toBe('line 9')
		expect(keptLines[2]).toBe('line 10')
	})

	test('truncatedLines reflects dropped lines in tail direction', () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const result = truncateWithOptions(lines.join('\n'), { maxLines: 4, direction: 'tail' })
		expect(result.truncatedLines).toBe(6)
	})
})

// ── truncateWithOptions — combined limits ─────────────────────────────────────

describe('truncateWithOptions — combined limits', () => {
	test('byte cap wins over line cap when bytes are exhausted first', () => {
		// Lines of 100 chars each; maxLines=100 (generous), maxBytes=150 (tight)
		const longLine = 'A'.repeat(100)
		const input = Array.from({ length: 10 }, () => longLine).join('\n')
		const result = truncateWithOptions(input, { maxLines: 100, maxBytes: 150 })
		expect(result.hitBytes).toBe(true)
		expect(result.truncated).toBe(true)
	})

	test('line cap wins over byte cap when lines are exhausted first', () => {
		// Short lines; maxLines=3 (tight), maxBytes=100000 (generous)
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const result = truncateWithOptions(lines.join('\n'), { maxLines: 3, maxBytes: 100_000 })
		expect(result.hitBytes).toBe(false)
		expect(result.truncated).toBe(true)
		expect(result.content.split('\n')).toHaveLength(3)
	})
})

// ── createReadTruncationHook — no-op when under limit ────────────────────────

describe('createReadTruncationHook — no-op when under limit', () => {
	test('passes output through unchanged when under all limits', async () => {
		const hook = createReadTruncationHook({ maxLines: 100, maxBytes: 100_000, maxLineWidth: 500 })

		const readTool = ReadTool.define(async () => 'line1\nline2\nline3')

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Should contain the lines from serialize output, no truncation hint
		expect(value).toContain('line1')
		expect(value).not.toContain('Use offset=')
		expect(value).not.toContain('capped at')
	})
})

// ── createReadTruncationHook — line-limit hint ────────────────────────────────

describe('createReadTruncationHook — line-limit truncation hint', () => {
	test('appends line-limit continuation hint when truncated by line count', async () => {
		// maxLines=3 on a file with many lines (serialize outputs numbered lines)
		const hook = createReadTruncationHook({ maxLines: 3, maxBytes: 100_000, maxLineWidth: 10_000 })

		// Build content that will produce many numbered lines after serialize
		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const readTool = ReadTool.define(async () => manyLines)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Use offset=')
		expect(value).not.toContain('capped at')
	})

	test('hint includes correct nextOffset based on input offset', async () => {
		// Read starting at offset=5 with maxLines=3
		const hook = createReadTruncationHook({ maxLines: 3, maxBytes: 100_000, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const readTool = ReadTool.define(async () => manyLines)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', offset: 5, limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// With offset=5, maxLines=3 kept, the next offset should be 5+3 = 8
		expect(value).toContain('offset=8')
	})
})

// ── createReadTruncationHook — byte-limit hint ────────────────────────────────

describe('createReadTruncationHook — byte-limit truncation hint', () => {
	test('appends byte-cap hint when truncated by byte count', async () => {
		// Very tight byte limit
		const hook = createReadTruncationHook({ maxLines: 10_000, maxBytes: 50, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const readTool = ReadTool.define(async () => manyLines)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('capped at')
		expect(value).toContain('Use offset=')
	})
})

// ── createReadTruncationHook — per-line width cap ─────────────────────────────

describe('createReadTruncationHook — per-line width cap', () => {
	test('truncates long lines in output', async () => {
		const hook = createReadTruncationHook({ maxLines: 2000, maxBytes: 100_000, maxLineWidth: 10 })

		const longLine = 'A'.repeat(200)
		const readTool = ReadTool.define(async () => longLine)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// The output should be shorter than a 200-char line + prefix
		// The original line is 200 A's; with maxLineWidth=10 it becomes 10 chars + '…'
		// So the full serialized line "1→AAAAAA..." should be at most 13 chars long
		const lines = value.split('\n')
		const contentLine = lines.find((l) => /^\s*\d+→/.test(l))
		expect(contentLine).toBeDefined()
		// Content line should be capped: "1→" (2 chars in JS, but → is multi-byte UTF) + 10 data chars + '…'
		// Regardless, the line should be much shorter than the original 200+ chars
		expect(contentLine!.length).toBeLessThan(20)
		expect(contentLine!.includes('…')).toBe(true)
	})

	test('does not append a continuation hint when only line-width capping occurs', async () => {
		// Only per-line width cap — no lines dropped, no byte cap hit
		const hook = createReadTruncationHook({ maxLines: 2000, maxBytes: 100_000, maxLineWidth: 10 })

		const longLine = 'A'.repeat(200)
		const readTool = ReadTool.define(async () => longLine)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// No continuation hint since no lines were dropped
		expect(value).not.toContain('Use offset=')
		expect(value).not.toContain('capped at')
	})
})

// ── createReadTruncationHook — custom hint factory ────────────────────────────

describe('createReadTruncationHook — custom hint', () => {
	test('uses custom hint function when provided', async () => {
		const hook = createReadTruncationHook({
			maxLines: 3,
			maxBytes: 100_000,
			maxLineWidth: 10_000,
			hint: ({ truncatedLines }) => `CUSTOM HINT: ${truncatedLines} lines dropped`,
		})

		const manyLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
		const readTool = ReadTool.define(async () => manyLines)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('CUSTOM HINT:')
		expect(value).toContain('lines dropped')
	})
})

// ── createReadTruncationHook — non-read tools pass through ───────────────────

describe('createReadTruncationHook — non-read tools pass through', () => {
	test('hook does not modify non-read tools', async () => {
		let hookFired = false

		const hook = createReadTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				hookFired = true
				return 'should not appear'
			},
		})

		const echoTool = defineTool({
			name: 'echo',
			description: 'Echoes',
			input: z.object({ text: z.string() }),
			output: z.string(),
			execute: async (input) => input.text,
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('echo', { text: 'hello world' }), assistantText('Done.')]),
			tools: { echo: echoTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('hello world')
		expect(hookFired).toBe(false)
	})
})

// ── Read truncation hook — default limit boundary tests ─────────────────────
// Default limits: maxLines=2000, maxBytes=50KB, maxLineWidth=2000

describe('createReadTruncationHook — default line limit boundary', () => {
	test('read output with exactly 2000 serialized lines passes through unchanged', async () => {
		const hook = createReadTruncationHook()

		// ReadTool.serialize adds line numbers + footer, so 2000 raw lines become
		// 2000 numbered lines + 1 blank + 1 footer = 2002 serialized lines.
		// The hook operates on the serialized output, so we need the serialized
		// output to be <= 2000 lines for no-truncation.
		// Use a raw file with ~1997 lines so serialize stays under 2000.
		const rawLines = Array.from({ length: 1997 }, (_, i) => `L${i + 1}`)
		const readTool = ReadTool.define(async () => rawLines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Use offset=')
		expect(value).not.toContain('capped at')
		expect(value).toContain('L1')
		expect(value).toContain('L1997')
	})

	test('read output exceeding 2000 serialized lines triggers continuation hint', async () => {
		const hook = createReadTruncationHook()

		// 2500 raw lines → serialize produces ~2502 lines (numbered + blank + footer)
		const rawLines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`)
		const readTool = ReadTool.define(async () => rawLines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 3000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Use offset=')
		// Should NOT contain the very last lines since they were truncated
		expect(value).not.toContain('L2500')
	})
})

describe('createReadTruncationHook — default byte limit boundary', () => {
	test('output under 50 KB passes through unchanged', async () => {
		const hook = createReadTruncationHook()

		// 100 lines of 300 chars each ≈ 30KB, well under 50KB
		const rawLines = Array.from({ length: 100 }, (_, i) => `L${i + 1}:${'a'.repeat(300)}`)
		const readTool = ReadTool.define(async () => rawLines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Use offset=')
		expect(value).not.toContain('capped at')
		expect(value).toContain('L100')
	})

	test('output over 50 KB triggers byte-cap hint even with few lines', async () => {
		const hook = createReadTruncationHook()

		// 30 lines of 2000 chars each ≈ 60KB after serialization, over 50KB
		const rawLines = Array.from({ length: 30 }, (_, i) => `L${i + 1}:${'b'.repeat(1990)}`)
		const readTool = ReadTool.define(async () => rawLines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('capped at')
		expect(value).toContain('Use offset=')
	})
})

describe('createReadTruncationHook — default line width boundary', () => {
	// maxLineWidth=2000 applies to the SERIALIZED output which includes "N→" prefix.
	// For a single-line file, serialize produces "1→<content>" (2 char prefix).
	// So raw content of 1998 chars → serialized line of 2000 chars → exactly at limit.

	test('serialized line of exactly 2000 chars passes through without ellipsis', async () => {
		const hook = createReadTruncationHook()

		// 1998 raw chars + "1→" prefix = 2000 serialized chars = exactly at limit
		const line = 'x'.repeat(1998)
		const readTool = ReadTool.define(async () => line)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('…')
	})

	test('serialized line of 2001 chars gets width-capped with ellipsis', async () => {
		const hook = createReadTruncationHook()

		// 1999 raw chars + "1→" prefix = 2001 serialized chars → over limit
		const line = 'y'.repeat(1999)
		const readTool = ReadTool.define(async () => line)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: { read: readTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('…')
		const contentLine = value.split('\n').find((l: string) => /^\s*\d+→/.test(l))
		expect(contentLine).toBeDefined()
		// Width-capped to 2000 chars + 1 ellipsis = 2001 total
		expect(contentLine!.length).toBe(2001)
	})
})
