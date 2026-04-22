import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadTool, readInput } from '@humanlayer/agentlayer-core/interfaces'
import { createReadTool } from '../src/tools'
import { makeToolContext } from './mocks'

/** Serialize raw tool output using the tool's serialize fn or default logic. */
function serializeRaw<TInput, TOutput>(
	tool: { serialize?: (raw: TOutput, input: TInput) => string },
	raw: TOutput,
	input: TInput,
): string {
	if (tool.serialize) return tool.serialize(raw, input)
	return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

// ─── ReadTool interface ───────────────────────────────────────────────────────

describe('ReadTool interface', () => {
	test('has correct name', () => {
		expect(ReadTool.name).toBe('read')
	})

	test('has non-empty description', () => {
		expect(ReadTool.description.length).toBeGreaterThan(0)
	})

	test('define() returns a tool with the correct name', () => {
		const tool = ReadTool.define(async () => 'content')
		expect(tool.name).toBe('read')
	})

	test('readInput schema requires file_path', () => {
		const result = readInput.safeParse({})
		expect(result.success).toBe(false)
	})

	test('readInput schema parses valid input', () => {
		const result = readInput.safeParse({ file_path: '/some/path.ts' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.file_path).toBe('/some/path.ts')
			expect(result.data.limit).toBe(2000) // default
		}
	})

	test('readInput schema accepts offset and limit', () => {
		const result = readInput.safeParse({ file_path: '/some/path.ts', offset: 10, limit: 50 })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.offset).toBe(10)
			expect(result.data.limit).toBe(50)
		}
	})
})

// ─── serialize — line numbering ───────────────────────────────────────────────

describe('ReadTool serialize — line numbering', () => {
	test('adds arrow-style line numbers', async () => {
		const tool = ReadTool.define(async () => 'line one\nline two\nline three')
		const input = { file_path: '/fake/path.ts', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('→line one')
		expect(output).toContain('→line two')
		expect(output).toContain('→line three')
	})

	test('line numbers start at 1 by default', async () => {
		const tool = ReadTool.define(async () => 'first\nsecond')
		const input = { file_path: '/fake/path.ts', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toMatch(/^\s*1→first/)
		expect(output).toContain('2→second')
	})

	test('single line file has no leading spaces in line number', async () => {
		const tool = ReadTool.define(async () => 'only line')
		const input = { file_path: '/fake/path.ts', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		// Single line: width is 1, no padding needed
		expect(output).toContain('1→only line')
		expect(output).toContain('(End of file - total 1 lines)')
	})

	test('multi-digit line numbers are right-aligned', async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
		const tool = ReadTool.define(async () => lines)
		const input = { file_path: '/fake/path.ts', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		// Line 1 should be padded to same width as line 10
		expect(output).toContain(' 1→line 1')
		expect(output).toContain('10→line 10')
	})
})

// ─── serialize — offset and limit ────────────────────────────────────────────

describe('ReadTool serialize — offset and limit', () => {
	test('offset skips earlier lines', async () => {
		const tool = ReadTool.define(async () => 'line1\nline2\nline3\nline4\nline5')
		const input = { file_path: '/fake/path.ts', offset: 3, limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).not.toContain('line1')
		expect(output).not.toContain('line2')
		expect(output).toContain('line3')
		expect(output).toContain('line4')
		expect(output).toContain('line5')
	})

	test('offset adjusts line numbers in output', async () => {
		const tool = ReadTool.define(async () => 'a\nb\nc\nd\ne')
		const input = { file_path: '/fake/path.ts', offset: 3, limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		// Line numbers should start at offset
		expect(output).toMatch(/\s*3→c/)
		expect(output).toMatch(/\s*4→d/)
		expect(output).toMatch(/\s*5→e/)
	})

	test('limit caps number of lines returned', async () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
		const tool = ReadTool.define(async () => lines)
		const input = { file_path: '/fake/path.ts', limit: 5 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		// Only first 5 lines and truncation notice
		expect(output).toContain('line 1')
		expect(output).toContain('line 5')
		expect(output).not.toContain('line 6')
	})

	test('shows truncation message when file exceeds limit', async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
		const tool = ReadTool.define(async () => lines)
		const input = { file_path: '/fake/path.ts', limit: 3 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('(Showing lines 1-3 of 10')
		expect(output).toContain('Use offset=4 to continue.')
	})

	test('shows end-of-file message when all lines fit within limit', async () => {
		const tool = ReadTool.define(async () => 'line1\nline2\nline3')
		const input = { file_path: '/fake/path.ts', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('(End of file - total 3 lines)')
		expect(output).not.toContain('Showing lines')
	})

	test('offset + limit combination', async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
		const tool = ReadTool.define(async () => lines)
		const input = { file_path: '/fake/path.ts', offset: 3, limit: 2 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).not.toContain('line 1')
		expect(output).not.toContain('line 2')
		expect(output).toContain('line 3')
		expect(output).toContain('line 4')
		expect(output).not.toContain('line 5')
		// Truncated since 2 lines shown of 10 total
		expect(output).toContain('(Showing lines 3-4 of 10')
	})
})

// ─── ReadTool passes filePath through to executor unchanged ──────────────────

describe('ReadTool file_path passthrough', () => {
	test('passes file_path to executor unchanged', async () => {
		let receivedPath = ''
		const tool = ReadTool.define(async (input) => {
			receivedPath = input.file_path
			return 'content'
		})
		await tool.execute({ file_path: '~/some/file.ts', limit: 2000 }, makeToolContext())
		expect(receivedPath).toBe('~/some/file.ts')
	})
})

// ─── createServerReadTool ─────────────────────────────────────────────────────

describe('createServerReadTool', () => {
	test('reads actual files from disk', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'read-tool-test-'))
		try {
			const filePath = join(dir, 'test-file.ts')
			await writeFile(filePath, 'const x = 1\nconst y = 2\nconst z = 3')

			const readTool = createReadTool()
			const input = { file_path: filePath, limit: 2000 }
			const raw = await readTool.execute(input, makeToolContext())
			const output = serializeRaw(readTool, raw as any, input)

			expect(output).toContain('const x = 1')
			expect(output).toContain('const y = 2')
			expect(output).toContain('const z = 3')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('resolves relative paths against opts.cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'read-tool-test-'))
		try {
			await writeFile(join(dir, 'relative.ts'), 'const relative = true\n')

			const readTool = createReadTool({ cwd: dir })
			const input = { file_path: 'relative.ts', limit: 2000 }
			const raw = await readTool.execute(input, makeToolContext())
			const output = serializeRaw(readTool, raw as any, input)

			expect(output).toContain('const relative = true')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('applies line numbers to actual file content', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'read-tool-test-'))
		try {
			const filePath = join(dir, 'numbered.ts')
			await writeFile(filePath, 'first line\nsecond line\nthird line')

			const readTool = createReadTool()
			const input = { file_path: filePath, limit: 2000 }
			const raw = await readTool.execute(input, makeToolContext())
			const output = serializeRaw(readTool, raw as any, input)

			expect(output).toMatch(/\s*1→first line/)
			expect(output).toMatch(/\s*2→second line/)
			expect(output).toMatch(/\s*3→third line/)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('applies offset to actual file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'read-tool-test-'))
		try {
			const filePath = join(dir, 'offset-test.ts')
			await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5')

			const readTool = createReadTool()
			const input = { file_path: filePath, offset: 3, limit: 2000 }
			const raw = await readTool.execute(input, makeToolContext())
			const output = serializeRaw(readTool, raw as any, input)

			expect(output).not.toContain('line1')
			expect(output).not.toContain('line2')
			expect(output).toContain('line3')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('server read tool has name "read"', () => {
		const readTool = createReadTool()
		expect(readTool.name).toBe('read')
	})
})
