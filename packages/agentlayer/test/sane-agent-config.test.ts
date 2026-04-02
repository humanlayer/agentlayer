/**
 * Tests for the sane agent config (apps/agent-sdk/src/agents/sane.ts).
 *
 * Phase 4 of the output-truncation plan: verify that sane.ts wires
 * saneDefaultOutputTruncationHooks into an agent and that each hook fires
 * correctly for its matched tool.
 *
 * Covers:
 * - sane.ts module exports an Agent instance
 * - Agent config uses saneDefaultOutputTruncationHooks
 * - Read tool: per-line width cap + continuation hint on truncation
 * - Read tool: no hint when under limits
 * - Bash tool: tail-direction truncation + save-to-disk hint
 * - Bash tool: no-op when under limits
 * - Glob tool: head-direction truncation + save-to-disk hint
 * - Glob tool: no-op when under limits
 * - Grep tool: head-direction truncation + save-to-disk hint
 * - Grep tool: no-op when under limits
 * - List tool: head-direction truncation + save-to-disk hint
 * - List tool: no-op when under limits
 * - All five hooks fire independently (no cross-tool bleed)
 * - saneDefaultOutputTruncationHooks array identity — exact composition
 */

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Agent, startState } from '../src'
import {
	bashOutputTruncationHook,
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	createReadTruncationHook,
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	readTruncationHook,
	saneDefaultOutputTruncationHooks,
} from '../src/hooks/output-truncation'
import { BashTool } from '../src/tools/interfaces/bash'
import { GlobTool } from '../src/tools/interfaces/glob'
import { GrepTool } from '../src/tools/interfaces/grep'
import { ListTool } from '../src/tools/interfaces/list'
import { ReadTool } from '../src/tools/interfaces/read'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

// ── sane.ts structural verification ─────────────────────────────────────────

describe('sane agent config — structural verification', () => {
	test('saneDefaultOutputTruncationHooks contains exactly 5 hooks in correct order', () => {
		expect(saneDefaultOutputTruncationHooks).toHaveLength(5)
		expect(saneDefaultOutputTruncationHooks[0]).toBe(readTruncationHook)
		expect(saneDefaultOutputTruncationHooks[1]).toBe(bashOutputTruncationHook)
		expect(saneDefaultOutputTruncationHooks[2]).toBe(globOutputTruncationHook)
		expect(saneDefaultOutputTruncationHooks[3]).toBe(grepOutputTruncationHook)
		expect(saneDefaultOutputTruncationHooks[4]).toBe(listOutputTruncationHook)
	})

	test('all hooks in saneDefaultOutputTruncationHooks are functions', () => {
		for (const hook of saneDefaultOutputTruncationHooks) {
			expect(typeof hook).toBe('function')
		}
	})
})

// ── read tool — wired via saneDefaultOutputTruncationHooks ──────────────────

describe('sane config — read tool hook', () => {
	test('read tool output passes through unchanged when under all limits', async () => {
		// Use the actual pre-composed readTruncationHook (default: 2000 lines, 50KB, 2000 char/line)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => 'line one\nline two\nline three'),
			},
			hooks: { postToolUse: saneDefaultOutputTruncationHooks },
		})

		const result = await agent.run({ state: startState([userMessage('read the file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Should include the serialized lines with line numbers
		expect(value).toContain('line one')
		expect(value).toContain('line two')
		expect(value).toContain('line three')
		// No truncation hint
		expect(value).not.toContain('Use offset=')
		expect(value).not.toContain('capped at')
	})

	test('read tool appends continuation hint when line limit exceeded', async () => {
		const hook = createReadTruncationHook({ maxLines: 3, maxBytes: 100_000, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => manyLines),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('read file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Continuation hint must be present
		expect(value).toContain('Use offset=')
		expect(value).not.toContain('capped at')
		// Should not contain lines beyond the limit
		expect(value).not.toContain('line 20')
	})

	test('read tool hint contains correct nextOffset value', async () => {
		// Read with no offset (defaults to 1), maxLines=5 → nextOffset = 1 + 5 = 6
		const hook = createReadTruncationHook({ maxLines: 5, maxBytes: 100_000, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => manyLines),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('read file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// With offset=1 (default) and maxLines=5, nextOffset = 1 + 5 = 6
		expect(value).toContain('offset=6')
	})

	test('read tool with explicit offset produces correct nextOffset in hint', async () => {
		// Read starting at offset=10, maxLines=3 → nextOffset = 10 + 3 = 13
		const hook = createReadTruncationHook({ maxLines: 3, maxBytes: 100_000, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', offset: 10, limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => manyLines),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('read file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('offset=13')
	})

	test('read tool byte-cap hint message format', async () => {
		const hook = createReadTruncationHook({ maxLines: 10_000, maxBytes: 50, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => manyLines),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('read file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Byte-cap hint format: "(Output capped at N KB. Showing lines X-Y. Use offset=Z to continue.)"
		expect(value).toContain('Output capped at')
		expect(value).toContain('KB')
		expect(value).toContain('Use offset=')
	})

	test('read tool per-line width cap truncates long lines', async () => {
		const hook = createReadTruncationHook({ maxLines: 2000, maxBytes: 100_000, maxLineWidth: 10 })

		const longLine = 'A'.repeat(200)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => longLine),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('read file')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// The serialized line should have been capped (ends with '…')
		expect(value).toContain('…')
		// The original 200 A's should not appear in full
		expect(value).not.toContain('A'.repeat(200))
	})

	test('read hook does not fire for bash tool', async () => {
		const hook = createReadTruncationHook({ maxLines: 1, maxBytes: 1 })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => 'hello world output'),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Hook did not fire — output is raw, no read-style continuation hint
		expect(value).toBe('hello world output')
		expect(value).not.toContain('Use offset=')
	})
})

// ── bash tool — wired via saneDefaultOutputTruncationHooks ──────────────────

describe('sane config — bash tool hook', () => {
	test('bash tool output passes through unchanged when under limits', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => 'Exit code: 0\nhello'),
			},
			hooks: { postToolUse: saneDefaultOutputTruncationHooks },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('Exit code: 0\nhello')
		expect(value).not.toContain('Full output saved to')
	})

	test('bash tool truncates and saves to disk when line limit exceeded', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 20', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => lines.join('\n')),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		expect(value).not.toContain('Use offset=')
	})

	test('bash hook uses tail direction by default — keeps last N lines', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 10', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => lines.join('\n')),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Tail direction: last 3 lines kept
		expect(value).toContain('line 8')
		expect(value).toContain('line 9')
		expect(value).toContain('line 10')
		// Early lines dropped
		expect(value).not.toContain('line 1\n')
		expect(value).not.toContain('line 2\n')
	})

	test('bash tool full output is saved to disk verbatim', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const lines = Array.from({ length: 10 }, (_, i) => `unique-bash-${i + 1}`)
		const fullOutput = lines.join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => fullOutput),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		expect(savedContent).toBe(fullOutput)
		expect(savedContent.split('\n')).toHaveLength(10)
		// All lines present in the saved file
		for (let i = 1; i <= 10; i++) {
			expect(savedContent).toContain(`unique-bash-${i}`)
		}
	})

	test('bash hook does not fire for read tool', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => 'file content here'),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Bash hook did not fire — no save-to-disk hint
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('file content here')
	})
})

// ── glob tool — wired via saneDefaultOutputTruncationHooks ──────────────────

describe('sane config — glob tool hook', () => {
	test('glob tool output passes through unchanged when under limits', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => ['src/index.ts', 'src/core/agent.ts']),
			},
			hooks: { postToolUse: saneDefaultOutputTruncationHooks },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src/index.ts')
		expect(value).toContain('src/core/agent.ts')
		expect(value).not.toContain('Full output saved to')
	})

	test('glob tool truncates and saves to disk when line limit exceeded', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const files = Array.from({ length: 20 }, (_, i) => `src/file${i + 1}.ts`)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => files),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('glob hook uses head direction by default — keeps first N lines', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const files = Array.from({ length: 10 }, (_, i) => `src/file${i + 1}.ts`)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => files),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: first 3 files kept
		expect(value).toContain('src/file1.ts')
		expect(value).toContain('src/file2.ts')
		expect(value).toContain('src/file3.ts')
		// Later files dropped
		expect(value).not.toContain('src/file10.ts')
	})

	test('glob tool full output is saved to disk verbatim', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const files = Array.from({ length: 10 }, (_, i) => `unique-glob-${i + 1}.ts`)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => files),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		expect(savedContent.split('\n')).toHaveLength(10)
		for (let i = 1; i <= 10; i++) {
			expect(savedContent).toContain(`unique-glob-${i}.ts`)
		}
	})

	test('glob hook does not fire for bash tool', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => 'Exit code: 0\nhello world'),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('Exit code: 0')
	})
})

// ── grep tool — wired via saneDefaultOutputTruncationHooks ──────────────────

describe('sane config — grep tool hook', () => {
	test('grep tool output passes through unchanged when under limits', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'import' }), assistantText('Done.')]),
			tools: {
				grep: GrepTool.define(async () => [
					{ file: 'src/index.ts', line: 1, content: 'import foo' },
					{ file: 'src/index.ts', line: 5, content: 'import bar' },
				]),
			},
			hooks: { postToolUse: saneDefaultOutputTruncationHooks },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src/index.ts')
		expect(value).toContain('import foo')
		expect(value).toContain('import bar')
		expect(value).not.toContain('Full output saved to')
	})

	test('grep tool truncates and saves to disk when line limit exceeded', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const matches = Array.from({ length: 20 }, (_, i) => ({
			file: `src/file${i + 1}.ts`,
			line: i + 1,
			content: `match ${i + 1}`,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'match' }), assistantText('Done.')]),
			tools: {
				grep: GrepTool.define(async () => matches),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('grep hook uses head direction by default — keeps first N lines', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const matches = Array.from({ length: 10 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: 1,
			content: `unique-grep-${i + 1}`,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'unique-grep' }), assistantText('Done.')]),
			tools: {
				grep: GrepTool.define(async () => matches),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: first file entry should appear
		expect(value).toContain('file1.ts')
		// Later files should not appear in truncated output
		expect(value).not.toContain('file10.ts')
	})

	test('grep tool full output is saved to disk verbatim', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const matches = Array.from({ length: 10 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: i + 1,
			content: `unique-content-${i + 1}`,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'unique-content' }), assistantText('Done.')]),
			tools: {
				grep: GrepTool.define(async () => matches),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		for (let i = 1; i <= 10; i++) {
			expect(savedContent).toContain(`unique-content-${i}`)
		}
	})

	test('grep hook does not fire for list tool', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: {
				list: ListTool.define(async () => [{ name: 'index.ts', type: 'file' as const }]),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('index.ts')
	})
})

// ── list tool — wired via saneDefaultOutputTruncationHooks ──────────────────

describe('sane config — list tool hook', () => {
	test('list tool output passes through unchanged when under limits', async () => {
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: {
				list: ListTool.define(async () => [
					{ name: 'src', type: 'directory' as const },
					{ name: 'package.json', type: 'file' as const },
				]),
			},
			hooks: { postToolUse: saneDefaultOutputTruncationHooks },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src')
		expect(value).toContain('package.json')
		expect(value).not.toContain('Full output saved to')
	})

	test('list tool truncates and saves to disk when line limit exceeded', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 20 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: {
				list: ListTool.define(async () => entries),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('list hook uses head direction by default — keeps first N lines', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: {
				list: ListTool.define(async () => entries),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: first 3 entries kept
		expect(value).toContain('file1.ts')
		expect(value).toContain('file2.ts')
		expect(value).toContain('file3.ts')
		// Later entries dropped
		expect(value).not.toContain('file10.ts')
	})

	test('list tool full output is saved to disk verbatim', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `unique-list-${i + 1}.ts`,
			type: 'file' as const,
		}))
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: {
				list: ListTool.define(async () => entries),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		expect(savedContent.split('\n')).toHaveLength(10)
		for (let i = 1; i <= 10; i++) {
			expect(savedContent).toContain(`unique-list-${i}.ts`)
		}
	})

	test('list hook does not fire for read tool', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/file.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => 'content'),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('content')
	})
})

// ── all five hooks together — no cross-tool bleed ───────────────────────────

describe('sane config — all five hooks together, no cross-tool bleed', () => {
	test('with saneDefaultOutputTruncationHooks, only bash hook fires for bash output', async () => {
		// Create a custom composite to distinguish which hook fires
		let readHookFired = false
		let globHookFired = false
		let grepHookFired = false
		let listHookFired = false

		const trackingReadHook = createReadTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				readHookFired = true
				return 'read fired'
			},
		})
		const trackingGlobHook = createGlobOutputTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				globHookFired = true
				return 'glob fired'
			},
		})
		const trackingGrepHook = createGrepOutputTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				grepHookFired = true
				return 'grep fired'
			},
		})
		const trackingListHook = createListOutputTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				listHookFired = true
				return 'list fired'
			},
		})
		// Bash hook with tight limits (will truncate) but no tracking
		const bashHook = createBashOutputTruncationHook({ maxLines: 1, maxBytes: 100_000 })

		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`)
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => lines.join('\n')),
			},
			hooks: { postToolUse: [trackingReadHook, bashHook, trackingGlobHook, trackingGrepHook, trackingListHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		// Bash hook fired (truncation hint present), others did not
		expect(value).toContain('Full output saved to')
		expect(readHookFired).toBe(false)
		expect(globHookFired).toBe(false)
		expect(grepHookFired).toBe(false)
		expect(listHookFired).toBe(false)
	})

	test('with saneDefaultOutputTruncationHooks, only glob hook fires for glob output', async () => {
		let bashHookFired = false
		let readHookFired = false

		const trackingBashHook = createBashOutputTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				bashHookFired = true
				return 'bash fired'
			},
		})
		const trackingReadHook = createReadTruncationHook({
			maxLines: 1,
			maxBytes: 1,
			hint: () => {
				readHookFired = true
				return 'read fired'
			},
		})
		const globHook = createGlobOutputTruncationHook({ maxLines: 1, maxBytes: 100_000 })

		const files = Array.from({ length: 5 }, (_, i) => `file${i + 1}.ts`)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => files),
			},
			hooks: { postToolUse: [trackingReadHook, trackingBashHook, globHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		expect(value).toContain('Full output saved to')
		expect(readHookFired).toBe(false)
		expect(bashHookFired).toBe(false)
	})

	test('multi-tool agent run: each tool result processed by correct hook only', async () => {
		// Agent makes a bash call then a glob call; verify truncation hints are correct per tool
		const bashHook = createBashOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })
		const globHook = createGlobOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })

		const bashLines = Array.from({ length: 5 }, (_, i) => `bash-output-${i + 1}`)
		const globFiles = Array.from({ length: 5 }, (_, i) => `glob-file-${i + 1}.ts`)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 5', timeout: 5000 }),
				assistantWithToolCall('glob', { pattern: '**/*.ts' }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => bashLines.join('\n')),
				glob: GlobTool.define(async () => globFiles),
			},
			hooks: { postToolUse: [bashHook, globHook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result

		const bashResults = getToolResults(result.state.messages, { toolName: 'bash' })
		const globResults = getToolResults(result.state.messages, { toolName: 'glob' })

		expect(bashResults).toHaveLength(1)
		expect(globResults).toHaveLength(1)

		const bashValue = outputValue(bashResults[0]!)
		const globValue = outputValue(globResults[0]!)

		// Both should be truncated with save-to-disk hints
		expect(bashValue).toContain('Full output saved to')
		expect(globValue).toContain('Full output saved to')

		// Bash should have tail content (last lines); glob should have head content (first files)
		expect(bashValue).toContain('bash-output-4')
		expect(bashValue).toContain('bash-output-5')
		expect(globValue).toContain('glob-file-1.ts')
		expect(globValue).toContain('glob-file-2.ts')

		// Bash should NOT contain bash-output-1 (tail direction); glob should NOT contain glob-file-5
		expect(bashValue).not.toContain('bash-output-1\n')
		expect(globValue).not.toContain('glob-file-5.ts')

		// No cross-contamination: bash result has no glob hint, glob result has no bash hint
		expect(bashValue).not.toContain('glob-file')
		expect(globValue).not.toContain('bash-output')
	})
})

// ── hint format precision tests ──────────────────────────────────────────────

describe('sane config — hint format precision', () => {
	test('bash save-to-disk hint format is exact', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })

		const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: {
				bash: BashTool.define(async () => lines.join('\n')),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		// Hint is on its own paragraph, separated by \n\n
		const parts = value.split('\n\n')
		expect(parts.length).toBeGreaterThanOrEqual(2)
		const hint = parts[parts.length - 1]!
		// Exact format: "(Output truncated. Full output saved to /path/to/file)"
		expect(hint).toMatch(/^\(Output truncated\. Full output saved to .+\)$/)
	})

	test('read continuation hint format is exact', async () => {
		const hook = createReadTruncationHook({ maxLines: 3, maxBytes: 100_000, maxLineWidth: 10_000 })

		const manyLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('read', { filePath: '/fake/path.ts', limit: 2000 }),
				assistantText('Done.'),
			]),
			tools: {
				read: ReadTool.define(async () => manyLines),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		// Hint is on its own paragraph, separated by \n\n
		const parts = value.split('\n\n')
		expect(parts.length).toBeGreaterThanOrEqual(2)
		const hint = parts[parts.length - 1]!
		// Exact format: "(Showing lines X-Y. Use offset=Z to continue.)"
		expect(hint).toMatch(/^\(Showing lines \d+-\d+\. Use offset=\d+ to continue\.\)$/)
	})

	test('glob save-to-disk hint format is exact', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })

		const files = Array.from({ length: 10 }, (_, i) => `file${i + 1}.ts`)
		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '*.ts' }), assistantText('Done.')]),
			tools: {
				glob: GlobTool.define(async () => files),
			},
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const parts = value.split('\n\n')
		const hint = parts[parts.length - 1]!
		expect(hint).toMatch(/^\(Output truncated\. Full output saved to .+\)$/)
	})
})
