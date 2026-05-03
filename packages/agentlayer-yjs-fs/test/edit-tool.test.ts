import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsEditTool } from '../src/tools'
import { makeToolContext } from './mocks'

describe('createYjsFsEditTool', () => {
	test('replaces old_string with new_string and returns edit metadata', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'const x = 1\nconst y = 2')
		const tool = createYjsFsEditTool(fs)

		const result = await tool.execute(
			{ file_path: '/test.ts', old_string: 'const y = 2', new_string: 'const y = 3', replace_all: false },
			makeToolContext(),
		)

		expect('content' in result).toBe(true)
		if (!('content' in result)) throw new Error('unexpected stop result')
		expect(result.content).toBe('const x = 1\nconst y = 3')
		expect(result.matchCount).toBe(1)
		expect(result.editResult).toMatchObject({ editIndex: 12, editLine: 2, affectedLines: { start: 2, end: 2 } })
	})

	test('returns matchCount zero when old_string is not found', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'const x = 1')
		const tool = createYjsFsEditTool(fs)

		const result = await tool.execute(
			{ file_path: '/test.ts', old_string: 'missing', new_string: 'new', replace_all: false },
			makeToolContext(),
		)

		expect(result).toEqual({ content: 'const x = 1', matchCount: 0 })
		expect(fs.readFile('/test.ts')).toBe('const x = 1')
	})

	test('handles replace_all for multiple replacements', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'foo bar foo')
		const tool = createYjsFsEditTool(fs)

		const result = await tool.execute(
			{ file_path: '/test.ts', old_string: 'foo', new_string: 'baz', replace_all: true },
			makeToolContext(),
		)

		expect('content' in result).toBe(true)
		if (!('content' in result)) throw new Error('unexpected stop result')
		expect(result.content).toBe('baz bar baz')
		expect(result.matchCount).toBe(2)
		expect(fs.readFile('/test.ts')).toBe('baz bar baz')
	})

	test('throws error for non-unique old_string when replace_all is false', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'foo bar foo')
		const tool = createYjsFsEditTool(fs)

		await expect(
			tool.execute(
				{ file_path: '/test.ts', old_string: 'foo', new_string: 'baz', replace_all: false },
				makeToolContext(),
			),
		).rejects.toThrow('Found multiple matches')
	})
})
