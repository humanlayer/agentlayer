import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteTool } from '../src/tools'
import { makeToolContext } from './mocks'

// ─── createWriteTool ────────────────────────────────────────────────────

describe('createWriteTool', () => {
	test('creates a new file with given content', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'new-file.ts')
			const content = 'export const hello = "world"\n'

			const writeTool = createWriteTool()
			const result = await writeTool.execute({ file_path: filePath, content }, makeToolContext())

			expect(result).toContain('Successfully wrote')
			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe(content)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('resolves relative paths against opts.cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const writeTool = createWriteTool({ cwd: dir })
			await writeTool.execute({ file_path: 'relative.ts', content: 'const relative = true\n' }, makeToolContext())

			const written = await readFile(join(dir, 'relative.ts'), 'utf-8')
			expect(written).toBe('const relative = true\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('creates parent directories when they do not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'nested', 'deep', 'file.ts')
			const content = 'const x = 1\n'

			const writeTool = createWriteTool()
			await writeTool.execute({ file_path: filePath, content }, makeToolContext())

			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe(content)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('overwrites existing file with new content', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'existing.ts')
			const originalContent = 'original content\n'
			const newContent = 'new content\n'

			const writeTool = createWriteTool()
			await writeTool.execute({ file_path: filePath, content: originalContent }, makeToolContext())
			await writeTool.execute({ file_path: filePath, content: newContent }, makeToolContext())

			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe(newContent)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('handles empty content (creates zero-byte file)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'empty.ts')

			const writeTool = createWriteTool()
			await writeTool.execute({ file_path: filePath, content: '' }, makeToolContext())

			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe('')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('preserves CRLF line endings', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'crlf.ts')
			const crlfContent = 'line 1\r\nline 2\r\nline 3'

			const writeTool = createWriteTool()
			await writeTool.execute({ file_path: filePath, content: crlfContent }, makeToolContext())

			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe(crlfContent)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('handles JSON content correctly', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'data.json')
			const json = JSON.stringify({ key: 'value', arr: [1, 2, 3] }, null, 2)

			const writeTool = createWriteTool()
			await writeTool.execute({ file_path: filePath, content: json }, makeToolContext())

			const written = await readFile(filePath, 'utf-8')
			expect(JSON.parse(written)).toEqual({ key: 'value', arr: [1, 2, 3] })
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns result containing the filePath', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'write-tool-test-'))
		try {
			const filePath = join(dir, 'file.ts')

			const writeTool = createWriteTool()
			const result = await writeTool.execute({ file_path: filePath, content: 'x' }, makeToolContext())

			expect(typeof result).toBe('string')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('tool has name "write"', () => {
		const writeTool = createWriteTool()
		expect(writeTool.name).toBe('write')
	})
})
