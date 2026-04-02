import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditTool } from '../src/tools/server/edit'
import { makeToolContext } from './mocks'

// ─── createEditTool ─────────────────────────────────────────────────────

describe('createEditTool', () => {
	test('replaces a string in a file and returns matchCount=1', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, 'const x = 1\nconst y = 2\nconst z = 3')

			const editTool = createEditTool()
			const result = await editTool.execute(
				{ filePath, oldString: 'const y = 2', newString: 'const y = 99', replaceAll: false },
				makeToolContext(),
			)

			expect(result).toMatchObject({ matchCount: 1 })
			const written = await readFile(filePath, 'utf-8')
			expect(written).toContain('const y = 99')
			expect(written).not.toContain('const y = 2')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('returns matchCount=0 when oldString is not found', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, 'const x = 1\n')

			const editTool = createEditTool()
			const result = await editTool.execute(
				{ filePath, oldString: 'does not exist', newString: 'replacement', replaceAll: false },
				makeToolContext(),
			)

			expect(result).toMatchObject({ matchCount: 0 })
			// File should be unchanged
			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe('const x = 1\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('throws when file does not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'nonexistent.ts')
			const editTool = createEditTool()

			await expect(
				editTool.execute(
					{ filePath, oldString: 'foo', newString: 'bar', replaceAll: false },
					makeToolContext(),
				),
			).rejects.toThrow('not found')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('replaceAll replaces all occurrences and returns correct matchCount', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, 'foo bar foo baz foo')

			const editTool = createEditTool()
			const result = await editTool.execute(
				{ filePath, oldString: 'foo', newString: 'qux', replaceAll: true },
				makeToolContext(),
			)

			expect(result).toMatchObject({ matchCount: 3 })
			const written = await readFile(filePath, 'utf-8')
			expect(written).toBe('qux bar qux baz qux')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('throws when multiple matches exist with replaceAll=false', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, 'foo bar foo')

			const editTool = createEditTool()

			await expect(
				editTool.execute(
					{ filePath, oldString: 'foo', newString: 'qux', replaceAll: false },
					makeToolContext(),
				),
			).rejects.toThrow('Found multiple matches')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('handles multiline oldString and newString', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			const original = 'function hello() {\n  return "world"\n}\n'
			await writeFile(filePath, original)

			const editTool = createEditTool()
			const result = await editTool.execute(
				{
					filePath,
					oldString: '  return "world"',
					newString: '  return "universe"',
					replaceAll: false,
				},
				makeToolContext(),
			)

			expect(result).toMatchObject({ matchCount: 1 })
			const written = await readFile(filePath, 'utf-8')
			expect(written).toContain('return "universe"')
			expect(written).not.toContain('return "world"')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('preserves CRLF line endings after edit', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'edit-tool-test-'))
		try {
			const filePath = join(dir, 'crlf.ts')
			const original = 'line 1\r\nold line\r\nline 3'
			await writeFile(filePath, original)

			const editTool = createEditTool()
			await editTool.execute(
				{ filePath, oldString: 'old line', newString: 'new line', replaceAll: false },
				makeToolContext(),
			)

			const written = await readFile(filePath, 'utf-8')
			expect(written).toContain('new line')
			// CRLF around the replaced line should be preserved
			expect(written).toContain('\r\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('tool has name "edit"', () => {
		const editTool = createEditTool()
		expect(editTool.name).toBe('edit')
	})
})
