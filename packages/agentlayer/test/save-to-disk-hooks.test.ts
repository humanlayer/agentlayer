/**
 * Tests for save-to-disk output truncation hooks:
 * - saveFullOutput utility
 * - createBashOutputTruncationHook
 * - createGlobOutputTruncationHook
 * - createGrepOutputTruncationHook
 * - createListOutputTruncationHook
 * - saneDefaultOutputTruncationHooks composition
 *
 * Integration tests use the same pattern as output-truncation.test.ts:
 * wire hooks into an Agent with a mock model, run, then assert on tool result output.
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
	globOutputTruncationHook,
	grepOutputTruncationHook,
	listOutputTruncationHook,
	readTruncationHook,
	saneDefaultOutputTruncationHooks,
	saveFullOutput,
} from '../src/hooks/output-truncation'
import { BashTool } from '../src/tools/interfaces/bash'
import { GlobTool } from '../src/tools/interfaces/glob'
import { GrepTool } from '../src/tools/interfaces/grep'
import { ListTool } from '../src/tools/interfaces/list'
import { assistantText, assistantWithToolCall, getToolResults, mockModel, outputValue, userMessage } from './mocks'

// ── saveFullOutput ────────────────────────────────────────────────────────────

describe('saveFullOutput', () => {
	test('writes content to a file and returns the file path', async () => {
		const content = 'hello\nworld\nfoo bar'
		const filePath = await saveFullOutput(content)
		expect(typeof filePath).toBe('string')
		expect(filePath.length).toBeGreaterThan(0)
		const readBack = await readFile(filePath, 'utf8')
		expect(readBack).toBe(content)
	})

	test('returns a path within the OS temp directory', async () => {
		const { tmpdir } = await import('node:os')
		const filePath = await saveFullOutput('test content')
		expect(filePath.startsWith(tmpdir())).toBe(true)
	})

	test('each call returns a unique file path', async () => {
		const path1 = await saveFullOutput('content a')
		const path2 = await saveFullOutput('content b')
		expect(path1).not.toBe(path2)
	})

	test('preserves exact byte content including multi-line and unicode', async () => {
		const content = 'line 1\nline 2\n日本語\n\nlast line'
		const filePath = await saveFullOutput(content)
		const readBack = await readFile(filePath, 'utf8')
		expect(readBack).toBe(content)
	})

	test('handles empty string', async () => {
		const filePath = await saveFullOutput('')
		const readBack = await readFile(filePath, 'utf8')
		expect(readBack).toBe('')
	})
})

// ── createBashOutputTruncationHook — no-op when under limit ──────────────────

describe('createBashOutputTruncationHook — no-op when under limit', () => {
	test('passes output through unchanged when under all limits', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 1000, maxBytes: 100_000 })

		const bashTool = BashTool.define(async () => 'Exit code: 0\nhello\nworld')

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('Exit code: 0\nhello\nworld')
		expect(value).not.toContain('Full output saved to')
	})
})

// ── createBashOutputTruncationHook — truncation + save-to-disk ────────────────

describe('createBashOutputTruncationHook — truncation with save-to-disk', () => {
	test('truncates output and appends save-to-disk hint', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const bashTool = BashTool.define(async () => manyLines)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 20', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		expect(value).not.toContain('Use offset=')
	})

	test('bash hook defaults to tail direction — keeps last N lines', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const bashTool = BashTool.define(async () => lines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 10', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Tail direction: should keep lines 8, 9, 10
		expect(value).toContain('line 8')
		expect(value).toContain('line 9')
		expect(value).toContain('line 10')
		// Should NOT contain early lines
		expect(value).not.toContain('line 1\n')
		expect(value).not.toContain('line 2\n')
	})

	test('full output is saved to disk and contains all original lines', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const fullOutput = lines.join('\n')
		const bashTool = BashTool.define(async () => fullOutput)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 10', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		// Extract temp file path from hint
		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		expect(savedContent).toBe(fullOutput)
		// Saved file has all 10 lines; truncated output only has 3
		expect(savedContent.split('\n')).toHaveLength(10)
	})

	test('custom hint function receives toolName and outputPath', async () => {
		let receivedToolName = ''
		let receivedOutputPath = ''

		const hook = createBashOutputTruncationHook({
			maxLines: 2,
			maxBytes: 100_000,
			hint: ({ toolName, outputPath }) => {
				receivedToolName = toolName
				receivedOutputPath = outputPath
				return `CUSTOM: ${toolName} saved to ${outputPath}`
			},
		})

		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`)
		const bashTool = BashTool.define(async () => lines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		expect(receivedToolName).toBe('bash')
		expect(receivedOutputPath).toBeTruthy()
		expect(value).toContain('CUSTOM: bash saved to')
	})

	test('hook does not fire for non-bash tools', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		// Use a glob tool — hook should not fire
		const globTool = GlobTool.define(async () => ['file1.ts', 'file2.ts'])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Hook should not have fired — raw serialized output, no save-to-disk hint
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('file1.ts')
	})
})

// ── createGlobOutputTruncationHook — no-op when under limit ──────────────────

describe('createGlobOutputTruncationHook — no-op when under limit', () => {
	test('passes output through unchanged when under all limits', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 1000, maxBytes: 100_000 })

		const globTool = GlobTool.define(async () => ['src/index.ts', 'src/core/agent.ts'])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src/index.ts')
		expect(value).toContain('src/core/agent.ts')
		expect(value).not.toContain('Full output saved to')
	})
})

// ── createGlobOutputTruncationHook — truncation + save-to-disk ───────────────

describe('createGlobOutputTruncationHook — truncation with save-to-disk', () => {
	test('truncates and appends save-to-disk hint', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => manyFiles)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('glob hook defaults to head direction — keeps first N lines', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const files = Array.from({ length: 10 }, (_, i) => `src/file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => files)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: should keep first 3 files
		expect(value).toContain('src/file1.ts')
		expect(value).toContain('src/file2.ts')
		expect(value).toContain('src/file3.ts')
		// Should NOT contain later files
		expect(value).not.toContain('src/file10.ts')
	})

	test('full output saved to disk contains all original files', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const files = Array.from({ length: 10 }, (_, i) => `src/file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => files)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedPath = match![1]!

		const savedContent = await readFile(savedPath, 'utf8')
		// All 10 files should be in saved content
		for (let i = 1; i <= 10; i++) {
			expect(savedContent).toContain(`src/file${i}.ts`)
		}
	})

	test('empty glob result is not truncated', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const globTool = GlobTool.define(async () => [])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('No files matched the pattern.')
		expect(value).not.toContain('Full output saved to')
	})

	test('hook does not fire for non-glob tools', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const bashTool = BashTool.define(async () => 'Exit code: 0\nhello world')

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo hello', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('Exit code: 0')
	})
})

// ── createGrepOutputTruncationHook — no-op when under limit ──────────────────

describe('createGrepOutputTruncationHook — no-op when under limit', () => {
	test('passes output through unchanged when under all limits', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 1000, maxBytes: 100_000 })

		const grepTool = GrepTool.define(async () => [
			{ file: 'src/index.ts', line: 1, content: 'import foo' },
			{ file: 'src/index.ts', line: 5, content: 'import bar' },
		])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'import' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src/index.ts')
		expect(value).toContain('import foo')
		expect(value).toContain('import bar')
		expect(value).not.toContain('Full output saved to')
	})
})

// ── createGrepOutputTruncationHook — truncation + save-to-disk ───────────────

describe('createGrepOutputTruncationHook — truncation with save-to-disk', () => {
	test('truncates and appends save-to-disk hint', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		// Create many matches that will produce many serialized lines
		const matches = Array.from({ length: 20 }, (_, i) => ({
			file: `src/file${i + 1}.ts`,
			line: i + 1,
			content: `match content ${i + 1}`,
		}))
		const grepTool = GrepTool.define(async () => matches)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'match' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('grep hook defaults to head direction — keeps first N lines', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const matches = Array.from({ length: 10 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: 1,
			content: `content ${i + 1}`,
		}))
		const grepTool = GrepTool.define(async () => matches)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'content' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: first file entry should appear
		expect(value).toContain('file1.ts')
		// Later files should not appear
		expect(value).not.toContain('file10.ts')
	})

	test('full output saved to disk contains all matches', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const matches = Array.from({ length: 10 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: i + 1,
			content: `unique-content-${i + 1}`,
		}))
		const grepTool = GrepTool.define(async () => matches)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'unique' }), assistantText('Done.')]),
			tools: { grep: grepTool },
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

	test('empty grep result is not truncated', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const grepTool = GrepTool.define(async () => [])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'nonexistent' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('No matches found.')
		expect(value).not.toContain('Full output saved to')
	})

	test('hook does not fire for non-grep tools', async () => {
		const hook = createGrepOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const globTool = GlobTool.define(async () => ['a.ts', 'b.ts'])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('a.ts')
	})
})

// ── createListOutputTruncationHook — no-op when under limit ──────────────────

describe('createListOutputTruncationHook — no-op when under limit', () => {
	test('passes output through unchanged when under all limits', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 1000, maxBytes: 100_000 })

		const listTool = ListTool.define(async () => [
			{ name: 'src', type: 'directory' as const },
			{ name: 'package.json', type: 'file' as const },
		])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('src')
		expect(value).toContain('package.json')
		expect(value).not.toContain('Full output saved to')
	})
})

// ── createListOutputTruncationHook — truncation + save-to-disk ───────────────

describe('createListOutputTruncationHook — truncation with save-to-disk', () => {
	test('truncates and appends save-to-disk hint', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 20 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('list hook defaults to head direction — keeps first N lines', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: first entries should be kept
		expect(value).toContain('file1.ts')
		expect(value).toContain('file2.ts')
		expect(value).toContain('file3.ts')
		// Later entries should not appear
		expect(value).not.toContain('file10.ts')
	})

	test('full output saved to disk contains all entries', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
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
			expect(savedContent).toContain(`file${i}.ts`)
		}
	})

	test('empty list result is not truncated', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 3, maxBytes: 100_000 })

		const listTool = ListTool.define(async () => [])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/empty/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe('Directory is empty.')
		expect(value).not.toContain('Full output saved to')
	})

	test('custom hint function receives toolName and outputPath', async () => {
		let receivedToolName = ''

		const hook = createListOutputTruncationHook({
			maxLines: 2,
			maxBytes: 100_000,
			hint: ({ toolName, outputPath }) => {
				receivedToolName = toolName
				return `LIST TRUNCATED: see ${outputPath}`
			},
		})

		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '/some/dir' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)

		expect(receivedToolName).toBe('list')
		expect(value).toContain('LIST TRUNCATED: see')
	})

	test('hook does not fire for non-list tools', async () => {
		const hook = createListOutputTruncationHook({ maxLines: 1, maxBytes: 1 })

		const grepTool = GrepTool.define(async () => [{ file: 'a.ts', line: 1, content: 'hello' }])

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'hello' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('a.ts')
	})
})

// ── byte-limit truncation ─────────────────────────────────────────────────────

describe('save-to-disk hooks — byte-limit truncation', () => {
	test('bash hook truncates when byte limit is hit', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 10_000, maxBytes: 100 })

		// Each line is ~10 chars; 20 lines = ~200 bytes — over the 100-byte limit
		const lines = Array.from({ length: 20 }, (_, i) => `line_${i + 1}_padding`)
		const bashTool = BashTool.define(async () => lines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// The truncated content should be shorter than the full content
		const _hint = value.split('\n\n').pop()!
		const content = value.slice(0, value.indexOf('\n\n('))
		expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(100 + 50) // some slack for the last line
	})

	test('glob hook truncates when byte limit is hit', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 10_000, maxBytes: 50 })

		const files = Array.from({ length: 10 }, (_, i) => `very/long/path/to/file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => files)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})
})

// ── tail vs head direction override ──────────────────────────────────────────

describe('save-to-disk hooks — direction override', () => {
	test('bash hook can be overridden to use head direction', async () => {
		const hook = createBashOutputTruncationHook({ maxLines: 3, maxBytes: 100_000, direction: 'head' })

		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const bashTool = BashTool.define(async () => lines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'seq 10', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Head direction: should keep first 3 lines
		expect(value).toContain('line 1')
		expect(value).toContain('line 2')
		expect(value).toContain('line 3')
		expect(value).not.toContain('line 10')
	})

	test('glob hook can be overridden to use tail direction', async () => {
		const hook = createGlobOutputTruncationHook({ maxLines: 3, maxBytes: 100_000, direction: 'tail' })

		const files = Array.from({ length: 10 }, (_, i) => `file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => files)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		// Tail direction: last 3 files kept
		expect(value).toContain('file8.ts')
		expect(value).toContain('file9.ts')
		expect(value).toContain('file10.ts')
		expect(value).not.toContain('file1.ts')
	})
})

// ── saneDefaultOutputTruncationHooks composition ─────────────────────────────

describe('saneDefaultOutputTruncationHooks', () => {
	test('array contains exactly 5 hooks', () => {
		expect(saneDefaultOutputTruncationHooks).toHaveLength(5)
	})

	test('all five hooks are functions', () => {
		for (const hook of saneDefaultOutputTruncationHooks) {
			expect(typeof hook).toBe('function')
		}
	})

	test('includes the pre-composed readTruncationHook instance', () => {
		expect(saneDefaultOutputTruncationHooks[0]).toBe(readTruncationHook)
	})

	test('includes the pre-composed bashOutputTruncationHook instance', () => {
		expect(saneDefaultOutputTruncationHooks[1]).toBe(bashOutputTruncationHook)
	})

	test('includes the pre-composed globOutputTruncationHook instance', () => {
		expect(saneDefaultOutputTruncationHooks[2]).toBe(globOutputTruncationHook)
	})

	test('includes the pre-composed grepOutputTruncationHook instance', () => {
		expect(saneDefaultOutputTruncationHooks[3]).toBe(grepOutputTruncationHook)
	})

	test('includes the pre-composed listOutputTruncationHook instance', () => {
		expect(saneDefaultOutputTruncationHooks[4]).toBe(listOutputTruncationHook)
	})

	test('wired into an agent, bash tool is truncated and saved to disk', async () => {
		// Use very tight limits to trigger truncation
		const tightHooks = [
			readTruncationHook,
			createBashOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 }),
			createGlobOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 }),
			createGrepOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 }),
			createListOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 }),
		]

		const lines = Array.from({ length: 10 }, (_, i) => `output line ${i + 1}`)
		const bashTool = BashTool.define(async () => lines.join('\n'))

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: tightHooks },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
	})

	test('wired into an agent, each tool type is handled by its own hook', async () => {
		// Two hooks with tight limits — one per tool
		const tightBash = createBashOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })
		const tightGlob = createGlobOutputTruncationHook({ maxLines: 2, maxBytes: 100_000 })

		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`)
		const bashTool = BashTool.define(async () => lines.join('\n'))
		const globTool = GlobTool.define(async () => Array.from({ length: 5 }, (_, i) => `file${i + 1}.ts`))

		// First run with bash
		const bashAgent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'echo', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [tightBash, tightGlob] },
		})

		const bashResult = await bashAgent.run({ state: startState([userMessage('go')]) }).result
		const [bashToolResult] = getToolResults(bashResult.state.messages)
		expect(outputValue(bashToolResult!)).toContain('Full output saved to')

		// Second run with glob
		const globAgent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [tightBash, tightGlob] },
		})

		const globResult = await globAgent.run({ state: startState([userMessage('go')]) }).result
		const [globToolResult] = getToolResults(globResult.state.messages)
		expect(outputValue(globToolResult!)).toContain('Full output saved to')
	})
})

// ── glob serialize — inline truncation removed ───────────────────────────────

describe('GlobTool.serialize — no inline truncation', () => {
	test('serialize returns all files without truncation for large result sets', () => {
		// Import the tool interface directly to test serialize in isolation
		const { GlobTool: GT } = require('../src/tools/interfaces/glob')
		const manyFiles = Array.from({ length: 200 }, (_, i) => `file${i + 1}.ts`)
		const serialized: string = GT.serialize(manyFiles, {})
		// All 200 files should appear — no [Truncated:] message
		expect(serialized).not.toContain('[Truncated:')
		expect(serialized.split('\n')).toHaveLength(200)
		expect(serialized).toContain('file200.ts')
	})

	test('serialize returns "No files matched" for empty array', () => {
		const { GlobTool: GT } = require('../src/tools/interfaces/glob')
		expect(GT.serialize([], {})).toBe('No files matched the pattern.')
	})
})

// ── grep serialize — inline truncation removed ───────────────────────────────

describe('GrepTool.serialize — no inline truncation', () => {
	test('serialize returns all matches without truncation for large result sets', () => {
		const { GrepTool: GT } = require('../src/tools/interfaces/grep')
		const manyMatches = Array.from({ length: 200 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: 1,
			content: `match ${i + 1}`,
		}))
		const serialized: string = GT.serialize(manyMatches, {})
		expect(serialized).not.toContain('[Truncated:')
		expect(serialized).toContain('file200.ts')
		expect(serialized).toContain('match 200')
	})

	test('serialize returns "No matches found." for empty array', () => {
		const { GrepTool: GT } = require('../src/tools/interfaces/grep')
		expect(GT.serialize([], {})).toBe('No matches found.')
	})
})

// ── Boundary tests — default limits (2000 lines / 50 KB) ────────────────────
// These verify that output at or just below the default thresholds passes
// through UNCHANGED, and output just above triggers truncation + save-to-disk.

describe('bash hook — default line limit boundary (2000 lines)', () => {
	test('exactly 2000 lines passes through unchanged, no temp file', async () => {
		const hook = createBashOutputTruncationHook()
		const lines = Array.from({ length: 2000 }, (_, i) => `L${i + 1}`)
		const fullOutput = lines.join('\n')
		const bashTool = BashTool.define(async () => fullOutput)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cmd', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe(fullOutput)
		expect(value).not.toContain('Full output saved to')
		expect(value).not.toContain('truncated')
	})

	test('2001 lines triggers truncation and save-to-disk', async () => {
		const hook = createBashOutputTruncationHook()
		const lines = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`)
		const fullOutput = lines.join('\n')
		const bashTool = BashTool.define(async () => fullOutput)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cmd', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// Tail direction: should keep last 2000 lines (L2-L2001), drop L1
		expect(value).toContain('L2001')
		expect(value).not.toContain('\nL1\n')
	})
})

describe('bash hook — default byte limit boundary (50 KB)', () => {
	test('output just under 50 KB passes through unchanged', async () => {
		const hook = createBashOutputTruncationHook()
		// Create output that's under 50KB: ~100 lines of 400 chars = ~40KB
		const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}:${'x'.repeat(400)}`)
		const fullOutput = lines.join('\n')
		// Sanity check: output is under 50KB
		expect(Buffer.byteLength(fullOutput, 'utf8')).toBeLessThan(50 * 1024)

		const bashTool = BashTool.define(async () => fullOutput)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cmd', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe(fullOutput)
		expect(value).not.toContain('Full output saved to')
	})

	test('output over 50 KB triggers truncation even with few lines', async () => {
		const hook = createBashOutputTruncationHook()
		// 20 lines of 3000 chars each = ~60KB, well under 2000 line limit but over 50KB byte limit
		const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}:${'x'.repeat(3000)}`)
		const fullOutput = lines.join('\n')
		// Sanity check: output exceeds 50KB
		expect(Buffer.byteLength(fullOutput, 'utf8')).toBeGreaterThan(50 * 1024)

		const bashTool = BashTool.define(async () => fullOutput)

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('bash', { command: 'cmd', timeout: 5000 }),
				assistantText('Done.'),
			]),
			tools: { bash: bashTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// Should have fewer than 20 lines in truncated output
		const contentBeforeHint = value.split('\n\n(Output truncated')[0] ?? ''
		const keptLineCount = contentBeforeHint.split('\n').length
		expect(keptLineCount).toBeLessThan(20)
	})
})

describe('glob hook — default line limit boundary (2000 lines)', () => {
	test('exactly 2000 results passes through unchanged', async () => {
		const hook = createGlobOutputTruncationHook()
		const lines = Array.from({ length: 2000 }, (_, i) => `file${i + 1}.ts`)
		const fullOutput = lines.join('\n')
		const globTool = GlobTool.define(async () => lines)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toBe(fullOutput)
		expect(value).not.toContain('Full output saved to')
	})

	test('2001 results triggers truncation and save-to-disk', async () => {
		const hook = createGlobOutputTruncationHook()
		const lines = Array.from({ length: 2001 }, (_, i) => `file${i + 1}.ts`)
		const globTool = GlobTool.define(async () => lines)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('glob', { pattern: '**/*.ts' }), assistantText('Done.')]),
			tools: { glob: globTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// Head direction: keeps first 2000, drops file2001.ts
		expect(value).toContain('file1.ts')
		expect(value).toContain('file2000.ts')
		expect(value).not.toContain('file2001.ts')
	})
})

describe('grep hook — default line limit boundary (2000 lines)', () => {
	// Grep serialize produces 2 lines per unique file (filename + "  N: content")
	// So 1000 unique files = 2000 serialized lines = exactly at limit

	test('1000 matches (2000 serialized lines) passes through unchanged', async () => {
		const hook = createGrepOutputTruncationHook()
		const matches = Array.from({ length: 1000 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: 1,
			content: `match ${i + 1}`,
		}))
		const grepTool = GrepTool.define(async () => matches)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'test' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('file1.ts')
		expect(value).toContain('file1000.ts')
	})

	test('1001 matches (2002 serialized lines) triggers truncation', async () => {
		const hook = createGrepOutputTruncationHook()
		const matches = Array.from({ length: 1001 }, (_, i) => ({
			file: `file${i + 1}.ts`,
			line: 1,
			content: `match ${i + 1}`,
		}))
		const grepTool = GrepTool.define(async () => matches)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('grep', { pattern: 'test' }), assistantText('Done.')]),
			tools: { grep: grepTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// Head direction: keeps first matches, drops later ones
		expect(value).toContain('file1.ts')
		expect(value).not.toContain('file1001.ts')
	})
})

describe('list hook — default line limit boundary (2000 lines)', () => {
	// ListTool serialize produces 1 line per entry: "  name" or "📁 name"
	// So 2000 entries = 2000 serialized lines = exactly at limit

	test('exactly 2000 entries passes through unchanged', async () => {
		const hook = createListOutputTruncationHook()
		const entries = Array.from({ length: 2000 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '.' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).not.toContain('Full output saved to')
		expect(value).toContain('file1.ts')
		expect(value).toContain('file2000.ts')
	})

	test('2001 entries triggers truncation and save-to-disk', async () => {
		const hook = createListOutputTruncationHook()
		const entries = Array.from({ length: 2001 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '.' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		expect(value).toContain('Full output saved to')
		// Head direction: keeps first 2000, drops file2001.ts
		expect(value).toContain('file1.ts')
		expect(value).toContain('file2000.ts')
		expect(value).not.toContain('file2001.ts')
	})

	test('saved file contains all original entries verbatim', async () => {
		const hook = createListOutputTruncationHook()
		const entries = Array.from({ length: 2001 }, (_, i) => ({
			name: `file${i + 1}.ts`,
			type: 'file' as const,
		}))
		const listTool = ListTool.define(async () => entries)

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('list', { path: '.' }), assistantText('Done.')]),
			tools: { list: listTool },
			hooks: { postToolUse: [hook] },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		const [toolResult] = getToolResults(result.state.messages)
		const value = outputValue(toolResult!)
		const match = value.match(/Full output saved to (.+)\)/)
		expect(match).not.toBeNull()
		const savedContent = await readFile(match![1]!, 'utf8')
		// Saved file should have the full serialized output (all 2001 entries)
		expect(savedContent).toContain('file1.ts')
		expect(savedContent).toContain('file2001.ts')
	})
})
