import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem file CRUD', () => {
	test('normalizes relative file paths for file operations', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('workspace')
		const entryId = filesystem.createFile('workspace/notes.txt', 'hello')

		expect(filesystem.readFile('/workspace/notes.txt')).toBe('hello')
		expect(filesystem.readFile('workspace/notes.txt')).toBe('hello')
		expect(filesystem.stat('workspace/notes.txt').entryId).toBe(entryId)

		filesystem.writeFile('workspace/notes.txt', 'updated')
		expect(filesystem.readFile('/workspace/notes.txt')).toBe('updated')

		filesystem.rename('workspace/notes.txt', 'workspace/renamed.txt')
		expect(filesystem.exists('/workspace/notes.txt')).toBe(false)
		expect(filesystem.readFile('workspace/renamed.txt')).toBe('updated')
	})

	test('creates, reads, writes, edits, renames, and deletes files while preserving content identity', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		const entryId = filesystem.createFile('/workspace/notes.txt', 'hello world')
		const initialStat = filesystem.stat('/workspace/notes.txt')

		expect(initialStat.entryId).toBe(entryId)
		expect(initialStat.contentId).toBeDefined()
		expect(initialStat.size).toBe(11)
		expect(filesystem.readFile('/workspace/notes.txt')).toBe('hello world')

		filesystem.writeFile('/workspace/notes.txt', 'line1\nline2\nline3')
		expect(filesystem.readFile('/workspace/notes.txt')).toBe('line1\nline2\nline3')
		expect(filesystem.stat('/workspace/notes.txt').size).toBe(17)

		const editResult = filesystem.editFile('/workspace/notes.txt', 'line2', 'middle')
		expect(editResult).toEqual({
			path: '/workspace/notes.txt',
			editIndex: 6,
			editLine: 2,
			affectedLines: { start: 2, end: 2 },
		})
		expect(filesystem.readFile('/workspace/notes.txt')).toBe('line1\nmiddle\nline3')

		filesystem.rename('/workspace/notes.txt', '/workspace/renamed.txt')
		expect(filesystem.exists('/workspace/notes.txt')).toBe(false)
		expect(filesystem.exists('/workspace/renamed.txt')).toBe(true)

		const renamedStat = filesystem.stat('/workspace/renamed.txt')
		expect(renamedStat.entryId).toBe(entryId)
		expect(renamedStat.contentId).toBe(initialStat.contentId)
		expect(filesystem.readFile('/workspace/renamed.txt')).toBe('line1\nmiddle\nline3')

		filesystem.unlink('/workspace/renamed.txt')
		expect(filesystem.exists('/workspace/renamed.txt')).toBe(false)
	})

	test('rejects duplicate file creation', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello')

		expect(() => filesystem.createFile('/workspace/note.txt', 'duplicate')).toThrow(AlreadyExistsError)
	})
})
