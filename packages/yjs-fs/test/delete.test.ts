import { describe, expect, test } from 'bun:test'
import { DirectoryNotEmptyError, EntryNotFoundError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem delete', () => {
	test('rejects deleting non-empty directories', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/notes.txt', 'hello')

		expect(() => filesystem.unlink('/workspace')).toThrow(DirectoryNotEmptyError)
	})

	test('deletes empty directories', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.mkdir('/workspace/empty')

		filesystem.unlink('/workspace/empty')

		expect(filesystem.exists('/workspace/empty')).toBe(false)
		expect(filesystem.list('/workspace')).toEqual([])
	})

	test('deletes files and removes their content docs', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		const entryId = filesystem.createFile('/workspace/notes.txt', 'hello')
		const contentId = filesystem.stat('/workspace/notes.txt').contentId

		filesystem.unlink('/workspace/notes.txt')

		expect(filesystem.exists('/workspace/notes.txt')).toBe(false)
		expect(() => filesystem.stat('/workspace/notes.txt')).toThrow(EntryNotFoundError)
		expect(() => filesystem.readFile('/workspace/notes.txt')).toThrow(EntryNotFoundError)
		expect(filesystem.lookup('/workspace/notes.txt')).toBeUndefined()
		expect(filesystem.list('/workspace')).toEqual([])
		expect(entryId).toBeDefined()
		expect(contentId).toBeDefined()
	})
})
