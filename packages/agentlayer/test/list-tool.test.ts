import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListTool, listInput } from '../src/tools/interfaces/list'
import { createListTool } from '../src/tools/server/list'
import { makeToolContext } from './mocks'

// ─── ListTool interface ───────────────────────────────────────────────────────

describe('ListTool interface', () => {
	test('has correct name', () => {
		expect(ListTool.name).toBe('list')
	})

	test('has non-empty description', () => {
		expect(ListTool.description.length).toBeGreaterThan(0)
	})

	test('define() returns a tool with name "list"', () => {
		const tool = ListTool.define(async () => [])
		expect(tool.name).toBe('list')
	})

	test('listInput schema allows no fields (all optional)', () => {
		const result = listInput.safeParse({})
		expect(result.success).toBe(true)
	})

	test('listInput schema accepts path and ignore', () => {
		const result = listInput.safeParse({ path: '/some/dir', ignore: ['dist'] })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.path).toBe('/some/dir')
			expect(result.data.ignore).toEqual(['dist'])
		}
	})
})

// ─── ListTool serialize ───────────────────────────────────────────────────────

describe('ListTool serialize — empty directory', () => {
	test('returns "Directory is empty." when no entries', async () => {
		const tool = ListTool.define(async () => [])
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toBe('Directory is empty.')
	})
})

describe('ListTool serialize — with entries', () => {
	test('shows directory indicator for directories', async () => {
		const entries = [
			{ name: 'src', type: 'directory' as const },
			{ name: 'index.ts', type: 'file' as const },
		]
		const tool = ListTool.define(async () => entries)
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = tool.serialize!(raw as any, input)
		expect(output).toContain('src')
		expect(output).toContain('index.ts')
	})
})

// ─── createListTool ─────────────────────────────────────────────────────

describe('createListTool', () => {
	test('returns files and directories in a flat listing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			await writeFile(join(dir, 'file.ts'), 'const x = 1')
			await mkdir(join(dir, 'subdir'))

			const listTool = createListTool({ cwd: dir })
			const result = await listTool.execute({}, makeToolContext())

			const entries = result as Array<{ name: string; type: string }>
			expect(entries.some((e) => e.name.endsWith('file.ts') && e.type === 'file')).toBe(true)
			expect(entries.some((e) => e.name.endsWith('subdir') && e.type === 'directory')).toBe(true)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('excludes node_modules by default', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			await mkdir(join(dir, 'node_modules'))
			await writeFile(join(dir, 'index.ts'), 'const x = 1')

			const listTool = createListTool({ cwd: dir })
			const result = await listTool.execute({}, makeToolContext())

			const entries = result as Array<{ name: string; type: string }>
			expect(entries.some((e) => e.name.includes('node_modules'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('excludes .git by default', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			await mkdir(join(dir, '.git'))
			await writeFile(join(dir, 'index.ts'), 'const x = 1')

			const listTool = createListTool({ cwd: dir })
			const result = await listTool.execute({}, makeToolContext())

			const entries = result as Array<{ name: string; type: string }>
			expect(entries.some((e) => e.name.includes('.git'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('respects user-supplied ignore patterns', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			await mkdir(join(dir, 'custom-ignore'))
			await writeFile(join(dir, 'file.ts'), 'const x = 1')

			const listTool = createListTool({ cwd: dir })
			const result = await listTool.execute({ ignore: ['custom-ignore'] }, makeToolContext())

			const entries = result as Array<{ name: string; type: string }>
			expect(entries.some((e) => e.name.includes('custom-ignore'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('respects input.path over opts.cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			const subdir = join(dir, 'inner')
			await mkdir(subdir)
			await writeFile(join(dir, 'root.ts'), 'const root = 1')
			await writeFile(join(subdir, 'inner.ts'), 'const inner = 1')

			const listTool = createListTool({ cwd: dir })
			const result = await listTool.execute({ path: subdir }, makeToolContext())

			const entries = result as Array<{ name: string; type: string }>
			expect(entries.some((e) => e.name.endsWith('inner.ts'))).toBe(true)
			expect(entries.some((e) => e.name.endsWith('root.ts'))).toBe(false)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns empty array for an empty directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-tool-test-'))
		try {
			const emptyDir = join(dir, 'empty')
			await mkdir(emptyDir)

			const listTool = createListTool()
			const result = await listTool.execute({ path: emptyDir }, makeToolContext())

			expect(result).toEqual([])
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('tool has name "list"', () => {
		const listTool = createListTool()
		expect(listTool.name).toBe('list')
	})
})

// ─── createListTool — symlink behavior ───────────────────────────────────────
// list always calls stat() on symlinks to resolve the target type — there is
// no traversal and therefore no cycle risk, so no opt-out is provided.

describe('createListTool — symlink behavior', () => {
	test('symlink to a file is included with type "file"', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-symlink-test-'))
		try {
			const realFile = join(dir, 'actual.ts')
			await writeFile(realFile, 'const x = 1')
			await symlink(realFile, join(dir, 'linked.ts'))

			const tool = createListTool({ cwd: dir })
			const result = (await tool.execute({}, makeToolContext())) as Array<{ name: string; type: string }>

			const entry = result.find((e) => e.name.endsWith('linked.ts'))
			expect(entry).toBeDefined()
			expect(entry!.type).toBe('file')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('symlink to a directory is reported as type "directory"', async () => {
		// stat() follows the link so the target type is resolved correctly.
		const dir = await mkdtemp(join(tmpdir(), 'list-symlink-test-'))
		try {
			const realSubdir = join(dir, 'real-subdir')
			await mkdir(realSubdir)
			await symlink(realSubdir, join(dir, 'linked-subdir'))

			const tool = createListTool({ cwd: dir })
			const result = (await tool.execute({}, makeToolContext())) as Array<{ name: string; type: string }>

			const entry = result.find((e) => e.name.endsWith('linked-subdir'))
			expect(entry).toBeDefined()
			expect(entry!.type).toBe('directory')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('real directory alongside its symlink is still listed as type "directory"', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'list-symlink-test-'))
		try {
			const realSubdir = join(dir, 'real-subdir')
			await mkdir(realSubdir)
			await symlink(realSubdir, join(dir, 'linked-subdir'))

			const tool = createListTool({ cwd: dir })
			const result = (await tool.execute({}, makeToolContext())) as Array<{ name: string; type: string }>

			const realEntry = result.find((e) => e.name.endsWith('real-subdir'))
			expect(realEntry).toBeDefined()
			expect(realEntry!.type).toBe('directory')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('dangling symlink (broken target) is included and reported as type "file"', async () => {
		// stat() throws for a dangling symlink; the implementation catches and
		// surfaces it as type 'file' so the entry is not silently dropped.
		const dir = await mkdtemp(join(tmpdir(), 'list-symlink-test-'))
		try {
			await symlink(join(dir, 'does-not-exist'), join(dir, 'dangling'))

			const tool = createListTool({ cwd: dir })
			const result = (await tool.execute({}, makeToolContext())) as Array<{ name: string; type: string }>

			const entry = result.find((e) => e.name.endsWith('dangling'))
			expect(entry).toBeDefined()
			expect(entry!.type).toBe('file')
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
