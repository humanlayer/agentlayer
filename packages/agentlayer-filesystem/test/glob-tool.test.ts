import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobTool, globInput } from '@humanlayer/agentlayer-core/interfaces'
import { createGlobTool } from '../src/tools'
import { makeToolContext } from './mocks'

// ─── GlobTool interface ───────────────────────────────────────────────────────

describe('GlobTool interface', () => {
	test('has correct name', () => {
		expect(GlobTool.name).toBe('glob')
	})

	test('define() returns a tool with name "glob"', () => {
		const tool = GlobTool.define(async () => [])
		expect(tool.name).toBe('glob')
	})

	test('globInput schema requires pattern', () => {
		const result = globInput.safeParse({})
		expect(result.success).toBe(false)
	})

	test('globInput schema parses valid input', () => {
		const result = globInput.safeParse({ pattern: '**/*.ts' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.pattern).toBe('**/*.ts')
			expect(result.data.path).toBeUndefined()
		}
	})

	test('globInput schema accepts optional path', () => {
		const result = globInput.safeParse({ pattern: '*.ts', path: '/some/dir' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.path).toBe('/some/dir')
		}
	})
})

// ─── GlobTool serialize ───────────────────────────────────────────────────────

describe('GlobTool serialize — no matches', () => {
	test('returns "No files matched" when empty', async () => {
		const tool = GlobTool.define(async () => [])
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as string[], input) as string
		expect(output).toBe('No files matched the pattern.')
	})
})

describe('GlobTool serialize — with matches', () => {
	test('joins file paths with newlines', async () => {
		const files = ['/a/b/c.ts', '/a/b/d.ts']
		const tool = GlobTool.define(async () => files)
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as string[], input) as string
		expect(output).toContain('/a/b/c.ts')
		expect(output).toContain('/a/b/d.ts')
	})

	test('serialize returns all files without inline truncation', async () => {
		// Inline truncation was removed — truncation is now handled by postToolUse hooks.
		const files = Array.from({ length: 120 }, (_, i) => `/dir/file${i}.ts`)
		const tool = GlobTool.define(async () => files)
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as string[], input) as string
		expect(output).not.toContain('[Truncated:')
		expect(output.split('\n')).toHaveLength(120)
		expect(output).toContain('/dir/file119.ts')
	})
})

// ─── createGlobTool ─────────────────────────────────────────────────────

describe('createGlobTool', () => {
	test('returns .ts files matching **/*.ts pattern', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-tool-test-'))
		try {
			await writeFile(join(dir, 'a.ts'), 'const a = 1')
			await writeFile(join(dir, 'b.ts'), 'const b = 2')
			await writeFile(join(dir, 'c.js'), 'const c = 3')

			const globTool = createGlobTool({ cwd: dir })
			const result = await globTool.execute({ pattern: '**/*.ts' }, makeToolContext())

			expect(Array.isArray(result)).toBe(true)
			const paths = result as string[]
			expect(paths.some((p) => p.endsWith('a.ts'))).toBe(true)
			expect(paths.some((p) => p.endsWith('b.ts'))).toBe(true)
			expect(paths.some((p) => p.endsWith('c.js'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns empty array when no files match', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-tool-test-'))
		try {
			await writeFile(join(dir, 'a.ts'), 'const a = 1')

			const globTool = createGlobTool({ cwd: dir })
			const result = await globTool.execute({ pattern: '*.nonexistent' }, makeToolContext())

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('respects input.path over opts.cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-tool-test-'))
		try {
			const subdir = join(dir, 'sub')
			await mkdir(subdir)
			await writeFile(join(dir, 'root.ts'), 'const root = 1')
			await writeFile(join(subdir, 'sub.ts'), 'const sub = 1')

			const globTool = createGlobTool({ cwd: dir })
			// Passing input.path restricts search to subdir
			const result = await globTool.execute({ pattern: '**/*.ts', path: subdir }, makeToolContext())

			const paths = result as string[]
			expect(paths.some((p) => p.endsWith('sub.ts'))).toBe(true)
			expect(paths.some((p) => p.endsWith('root.ts'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('matches nested files with **/*.ts', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-tool-test-'))
		try {
			const subdir = join(dir, 'deep', 'nested')
			await mkdir(subdir, { recursive: true })
			await writeFile(join(subdir, 'deep.ts'), 'const deep = 1')

			const globTool = createGlobTool({ cwd: dir })
			const result = await globTool.execute({ pattern: '**/*.ts' }, makeToolContext())

			const paths = result as string[]
			expect(paths.some((p) => p.endsWith('deep.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('tool has name "glob"', () => {
		const globTool = createGlobTool()
		expect(globTool.name).toBe('glob')
	})
})

// ─── createGlobTool — symlink behavior (default: symlinks allowed) ────────────
// The glob walker follows symlinks by default.

describe('createGlobTool — symlink behavior', () => {
	test('symlink to a file matching the pattern is included in results', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-symlink-test-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const x = 1')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGlobTool({ cwd: dir })
			const result = (await tool.execute({ pattern: '**/*.ts' }, makeToolContext())) as string[]

			expect(result.some((p) => p.endsWith('actual.ts'))).toBe(true)
			expect(result.some((p) => p.endsWith('linked.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('files inside a symlinked directory are returned — symlinked dirs are traversed by default', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-symlink-test-'))
		try {
			// target/ lives outside the search dir; only reachable via the symlink
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'deep.ts'), 'const deep = 1')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const tool = createGlobTool({ cwd: searchDir })
			const result = (await tool.execute({ pattern: '**/*.ts' }, makeToolContext())) as string[]

			expect(result.some((p) => p.endsWith('deep.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('real files are found normally regardless of symlinks present', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-symlink-test-'))
		try {
			const realFile = join(dir, 'real.ts')
			await writeFile(realFile, 'const x = 1')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGlobTool({ cwd: dir })
			const result = (await tool.execute({ pattern: '**/*.ts' }, makeToolContext())) as string[]

			expect(result.some((p) => p.endsWith('real.ts'))).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})

// ─── createGlobTool — disallowSymlinks: true ─────────────────────────────────

describe('createGlobTool — disallowSymlinks: true', () => {
	test('symlink to a file is NOT included when symlinks are disallowed', async () => {
		// With symlink following disabled, symlinks are skipped
		// entirely — neither file symlinks nor directory symlinks are included.
		const dir = await mkdtemp(join(tmpdir(), 'glob-nosymlink-test-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const x = 1')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createGlobTool({ cwd: dir, disallowSymlinks: true })
			const result = (await tool.execute({ pattern: '**/*.ts' }, makeToolContext())) as string[]

			expect(result.some((p) => p.endsWith('actual.ts'))).toBe(true)
			expect(result.some((p) => p.endsWith('linked.ts'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('files inside a symlinked directory are not returned when symlinks are disallowed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'glob-nosymlink-test-'))
		try {
			const targetDir = join(dir, 'target')
			await mkdir(targetDir)
			await writeFile(join(targetDir, 'deep.ts'), 'const deep = 1')

			const searchDir = join(dir, 'search')
			await mkdir(searchDir)
			await symlink(targetDir, join(searchDir, 'linked-subdir'))

			const tool = createGlobTool({ cwd: searchDir, disallowSymlinks: true })
			const result = (await tool.execute({ pattern: '**/*.ts' }, makeToolContext())) as string[]

			expect(result.some((p) => p.endsWith('deep.ts'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
