import { describe, expect, test } from 'bun:test'
import {
	AlreadyExistsError,
	EntryNotFoundError,
	InvalidPathError,
	NotFileError,
	RootMutationError,
	YjsFilesystem,
} from '@humanlayer/yjs-fs'

describe('YjsFilesystem errors', () => {
	test('rejects invalid file operations and destructive root mutations', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello')

		expect(() => filesystem.readFile('/workspace')).toThrow(NotFileError)
		expect(() => filesystem.writeFile('/workspace', 'x')).toThrow(NotFileError)
		expect(() => filesystem.editFile('/workspace', 'a', 'b')).toThrow(NotFileError)
		expect(() => filesystem.editFile('/workspace/note.txt', 'missing', 'x')).toThrow('No match found')
		expect(() => filesystem.rename('/', '/renamed-root')).toThrow(RootMutationError)
		expect(() => filesystem.unlink('/')).toThrow(RootMutationError)
	})

	test('rejects invalid paths and missing entries', () => {
		const filesystem = new YjsFilesystem()

		expect(() => filesystem.mkdir('/a/../b')).toThrow(InvalidPathError)
		expect(() => filesystem.mkdir('/a/./b')).toThrow(InvalidPathError)
		expect(() => filesystem.mkdir('/a/\0/b')).toThrow(InvalidPathError)
		expect(() => filesystem.stat('/missing')).toThrow(EntryNotFoundError)
		expect(() => filesystem.createFile('/missing/file.txt', 'x')).toThrow(EntryNotFoundError)
	})

	test('surfaces typed duplicate errors', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')

		expect(() => filesystem.mkdir('/workspace')).toThrow(AlreadyExistsError)
		filesystem.createFile('/workspace/file.txt', 'x')
		expect(() => filesystem.createFile('/workspace/file.txt', 'x')).toThrow(AlreadyExistsError)
	})
})
