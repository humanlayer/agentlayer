import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrepTool, grepInput } from '@humanlayer/agentlayer-core/interfaces'
import { createGrepTool, fsGrepFallback } from '../src/tools'
import { makeToolContext } from './mocks'

// ─── GrepTool interface ───────────────────────────────────────────────────────

describe('GrepTool interface', () => {
	test('has correct name', () => {
		expect(GrepTool.name).toBe('grep')
	})

	test('define() returns a tool with name "grep"', () => {
		const tool = GrepTool.define(async () => [])
		expect(tool.name).toBe('grep')
	})

	test('grepInput schema requires pattern', () => {
		const result = grepInput.safeParse({})
		expect(result.success).toBe(false)
	})

	test('grepInput schema parses valid input', () => {
		const result = grepInput.safeParse({ pattern: 'foo' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.pattern).toBe('foo')
			expect(result.data.path).toBeUndefined()
			expect(result.data.include).toBeUndefined()
		}
	})

	test('grepInput schema accepts optional path and include', () => {
		const result = grepInput.safeParse({ pattern: 'foo', path: '/some/dir', include: '*.ts' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.path).toBe('/some/dir')
			expect(result.data.include).toBe('*.ts')
		}
	})
})

// ─── GrepTool serialize ───────────────────────────────────────────────────────

describe('GrepTool serialize — no matches', () => {
	test('returns "No matches found." when empty', async () => {
		const tool = GrepTool.define(async () => [])
		const input = { pattern: 'foo' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toBe('No matches found.')
	})
})

describe('GrepTool serialize — with matches', () => {
	test('groups matches by file', async () => {
		const matches = [
			{ file: '/a/foo.ts', line: 1, content: 'const foo = 1' },
			{ file: '/a/foo.ts', line: 5, content: 'export { foo }' },
			{ file: '/b/bar.ts', line: 3, content: 'import { foo }' },
		]
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'foo' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toContain('/a/foo.ts')
		expect(output).toContain('/b/bar.ts')
		expect(output).toContain('const foo = 1')
	})

	test('serialize returns all matches without inline truncation', async () => {
		// Inline truncation was removed — truncation is now handled by postToolUse hooks.
		const matches = Array.from({ length: 120 }, (_, i) => ({
			file: `/file${i}.ts`,
			line: 1,
			content: `match ${i}`,
		}))
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'match' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).not.toContain('[Truncated:')
		expect(output).toContain('/file119.ts')
		expect(output).toContain('match 119')
	})
})

// ─── createGrepTool ─────────────────────────────────────────────────────

describe('createGrepTool', () => {
	test('finds pattern in a file and returns correct match', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'))
		try {
			const filePath = join(dir, 'example.ts')
			await writeFile(filePath, 'const foo = 1\nconst bar = 2\nconst foo2 = 3\n')

			const grepTool = createGrepTool({ cwd: dir })
			const result = await grepTool.execute({ pattern: 'foo' }, makeToolContext())

			const matches = result as Array<{ file: string; line: number; content: string }>
			expect(matches.length).toBeGreaterThan(0)
			expect(matches.some((m) => m.content.includes('foo'))).toBe(true)
			expect(matches.every((m) => typeof m.line === 'number')).toBe(true)
			expect(matches.every((m) => typeof m.file === 'string')).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns empty array when no matches found', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'))
		try {
			await writeFile(join(dir, 'file.ts'), 'const x = 1\n')

			const grepTool = createGrepTool({ cwd: dir })
			const result = await grepTool.execute({ pattern: 'NOTFOUND_XYZZY' }, makeToolContext())

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('include filter restricts to matching file types', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'))
		try {
			await writeFile(join(dir, 'code.ts'), 'const needle = 1\n')
			await writeFile(join(dir, 'notes.txt'), 'needle is here\n')

			const grepTool = createGrepTool({ cwd: dir })
			const result = await grepTool.execute({ pattern: 'needle', include: '*.ts' }, makeToolContext())

			const matches = result as Array<{ file: string; line: number; content: string }>
			expect(matches.every((m) => m.file.endsWith('.ts'))).toBe(true)
			expect(matches.some((m) => m.file.endsWith('.txt'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns correct line numbers', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'))
		try {
			const filePath = join(dir, 'lines.ts')
			await writeFile(filePath, 'line one\nline two\nTARGET\nline four\n')

			const grepTool = createGrepTool({ cwd: dir })
			const result = await grepTool.execute({ pattern: 'TARGET' }, makeToolContext())

			const matches = result as Array<{ file: string; line: number; content: string }>
			expect(matches.length).toBe(1)
			expect(matches[0]!.line).toBe(3)
			expect(matches[0]!.content).toBe('TARGET')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('searches across multiple files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-tool-test-'))
		try {
			await writeFile(join(dir, 'a.ts'), 'const MARKER = 1\n')
			await writeFile(join(dir, 'b.ts'), 'const MARKER = 2\n')
			await writeFile(join(dir, 'c.ts'), 'const unrelated = 3\n')

			const grepTool = createGrepTool({ cwd: dir })
			const result = await grepTool.execute({ pattern: 'MARKER' }, makeToolContext())

			const matches = result as Array<{ file: string; line: number; content: string }>
			const files = new Set(matches.map((m) => m.file))
			expect(files.size).toBe(2)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('tool has name "grep"', () => {
		const grepTool = createGrepTool()
		expect(grepTool.name).toBe('grep')
	})
})

// ─── createGrepTool — symlink behavior (default: symlinks allowed) ────────────
// rg is invoked with --follow by default, so symlinks are traversed.

describe('createGrepTool — symlink behavior', () => {
	test('symlink to a file in the search directory is searched — rg follows symlinks by default', async () => {
		// rg --follow (default) searches symlinked files during directory traversal.
		// Both the real file and the symlink path contribute matches.
		const dir = await mkdtemp(join(tmpdir(), 'grep-symlink-test-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const SYMLINK_MARKER_FILE = 1\n')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGrepTool({ cwd: dir })
			const result = (await tool.execute({ pattern: 'SYMLINK_MARKER_FILE' }, makeToolContext())) as Array<{
				file: string
				line: number
				content: string
			}>

			const filePaths = result.map((m) => m.file)
			expect(filePaths.some((p) => p.endsWith('actual.ts'))).toBe(true)
			expect(filePaths.some((p) => p.endsWith('linked.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('files inside a symlinked subdirectory are found — rg traverses symlinked dirs by default', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-symlink-test-'))
		try {
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'nested.ts'), 'const SYMLINK_MARKER_DIR = 1\n')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const tool = createGrepTool({ cwd: searchDir })
			const result = (await tool.execute({ pattern: 'SYMLINK_MARKER_DIR' }, makeToolContext())) as Array<{
				file: string
				line: number
				content: string
			}>

			expect(result.length).toBeGreaterThan(0)
			expect(result.some((m) => m.file.endsWith('nested.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('real files are still searched normally alongside symlinks', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-symlink-test-'))
		try {
			const realFile = join(dir, 'real.ts')
			await writeFile(realFile, 'const SYMLINK_MARKER_REAL = 1\n')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGrepTool({ cwd: dir })
			const result = (await tool.execute({ pattern: 'SYMLINK_MARKER_REAL' }, makeToolContext())) as Array<{
				file: string
				line: number
				content: string
			}>

			expect(result.some((m) => m.file.endsWith('real.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})

// ─── createGrepTool — disallowSymlinks: true ─────────────────────────────────

describe('createGrepTool — disallowSymlinks: true', () => {
	test('symlink to a file in the search directory is not searched when symlinks are disallowed', async () => {
		// Without rg --follow, symlinks are skipped during traversal. Only the real
		// file contributes a match, not the symlink path.
		const dir = await mkdtemp(join(tmpdir(), 'grep-nosymlink-test-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const NOSYMLINK_MARKER_FILE = 1\n')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGrepTool({ cwd: dir, disallowSymlinks: true })
			const result = (await tool.execute({ pattern: 'NOSYMLINK_MARKER_FILE' }, makeToolContext())) as Array<{
				file: string
				line: number
				content: string
			}>

			expect(result.length).toBe(1)
			expect(result[0]!.file).toMatch(/actual\.ts$/)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('files inside a symlinked subdirectory are not found when symlinks are disallowed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'grep-nosymlink-test-'))
		try {
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'nested.ts'), 'const NOSYMLINK_MARKER_DIR = 1\n')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const tool = createGrepTool({ cwd: searchDir, disallowSymlinks: true })
			const result = await tool.execute({ pattern: 'NOSYMLINK_MARKER_DIR' }, makeToolContext())

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})

// ─── fsGrepFallback — direct unit tests ─────────────────────────────────────
// These tests verify the fallback grep implementation used when WASM ripgrep
// encounters limitations (symlink issues, sandbox restrictions).

describe('fsGrepFallback', () => {
	test('finds pattern in a single file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, 'const foo = 1\nconst bar = 2\nconst foo2 = 3\n')

			const result = await fsGrepFallback('foo', dir, false)

			expect(result.length).toBe(2)
			expect(result[0]!.file).toBe(join(dir, 'test.ts'))
			expect(result[0]!.line).toBe(1)
			expect(result[0]!.content).toBe('const foo = 1')
			expect(result[1]!.line).toBe(3)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns empty array when no matches found', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			await writeFile(join(dir, 'test.ts'), 'const x = 1\n')

			const result = await fsGrepFallback('NOTFOUND_XYZZY', dir, false)

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('respects include filter', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			await writeFile(join(dir, 'code.ts'), 'const needle = 1\n')
			await writeFile(join(dir, 'notes.txt'), 'needle is here\n')

			const result = await fsGrepFallback('needle', dir, false, '*.ts')

			expect(result.length).toBe(1)
			expect(result[0]!.file).toMatch(/\.ts$/)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('searches recursively in subdirectories', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const subdir = join(dir, 'subdir')
			await mkdir(subdir)
			await writeFile(join(dir, 'root.ts'), 'const MARKER = 1\n')
			await writeFile(join(subdir, 'nested.ts'), 'const MARKER = 2\n')

			const result = await fsGrepFallback('MARKER', dir, false)

			expect(result.length).toBe(2)
			const files = result.map((m: { file: string }) => m.file)
			expect(files.some((f: string) => f.endsWith('root.ts'))).toBe(true)
			expect(files.some((f: string) => f.endsWith('nested.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('follows symlinks when disallowSymlinks is false', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const SYMLINK_FALLBACK_TEST = 1\n')
			await symlink(realFile, join(dir, 'linked.ts'))

			const result = await fsGrepFallback('SYMLINK_FALLBACK_TEST', dir, false)

			const files = result.map((m: { file: string }) => m.file)
			expect(files.some((f: string) => f.endsWith('actual.ts'))).toBe(true)
			expect(files.some((f: string) => f.endsWith('linked.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('skips symlinks when disallowSymlinks is true', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const SYMLINK_SKIP_TEST = 1\n')
			await symlink(realFile, join(dir, 'linked.ts'))

			const result = await fsGrepFallback('SYMLINK_SKIP_TEST', dir, true)

			expect(result.length).toBe(1)
			expect(result[0]!.file).toMatch(/actual\.ts$/)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('follows symlinked directories when disallowSymlinks is false', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'nested.ts'), 'const SYMDIR_FALLBACK_TEST = 1\n')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const result = await fsGrepFallback('SYMDIR_FALLBACK_TEST', searchDir, false)

			expect(result.length).toBeGreaterThan(0)
			expect(result.some((m: { file: string }) => m.file.endsWith('nested.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('skips symlinked directories when disallowSymlinks is true', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'nested.ts'), 'const SYMDIR_SKIP_TEST = 1\n')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const result = await fsGrepFallback('SYMDIR_SKIP_TEST', searchDir, true)

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('can search a single file directly', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			const filePath = join(dir, 'single.ts')
			await writeFile(filePath, 'line one\nTARGET_LINE\nline three\n')

			const result = await fsGrepFallback('TARGET_LINE', filePath, false)

			expect(result.length).toBe(1)
			expect(result[0]!.file).toBe(filePath)
			expect(result[0]!.line).toBe(2)
			expect(result[0]!.content).toBe('TARGET_LINE')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('respects MAX_MATCHES limit (100)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fs-grep-fallback-'))
		try {
			// Create a file with 150 matching lines
			const lines = Array.from({ length: 150 }, (_, i) => `MATCH_LINE_${i}`).join('\n')
			await writeFile(join(dir, 'many-matches.ts'), lines)

			const result = await fsGrepFallback('MATCH_LINE', dir, false)

			expect(result.length).toBe(100) // MAX_MATCHES limit
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
