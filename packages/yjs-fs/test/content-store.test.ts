import { describe, expect, test } from 'bun:test'
import { ContentStore, EntryNotFoundError } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('ContentStore', () => {
	test('creates, reads, writes, edits, and deletes content docs', () => {
		const store = new ContentStore(new Y.Doc())
		const created = store.create('hello world')

		expect(store.read(created.contentId, '/note.txt')).toBe('hello world')
		expect(store.size(created.contentId, '/note.txt')).toBe(11)

		store.write(created.contentId, '/note.txt', 'line1\nline2')
		expect(store.read(created.contentId, '/note.txt')).toBe('line1\nline2')

		const result = store.edit(created.contentId, '/note.txt', 'line2', 'middle')
		expect(result).toEqual({
			path: '/note.txt',
			editIndex: 6,
			editLine: 2,
			affectedLines: { start: 2, end: 2 },
		})
		expect(store.read(created.contentId, '/note.txt')).toBe('line1\nmiddle')

		store.delete(created.contentId)
		expect(() => store.read(created.contentId, '/note.txt')).toThrow(EntryNotFoundError)
	})
})
