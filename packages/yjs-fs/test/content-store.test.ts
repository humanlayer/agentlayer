import { describe, expect, test } from 'bun:test'
import { ContentStore, EntryNotFoundError } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('ContentStore', () => {
	test('creates, reads, writes, edits, and deletes content docs', () => {
		const store = new ContentStore(new Y.Doc())
		const created = store.create('hello world')

		expect(store.get(created.contentId, '/note.txt')).toBe(created.record)
		expect(store.getText(created.contentId, '/note.txt')).toBe(created.text)
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

	test('rejects missing and ambiguous edits with stable diagnostics', () => {
		const store = new ContentStore(new Y.Doc())
		const created = store.create('alpha beta alpha')

		expect(() => store.edit(created.contentId, '/note.txt', 'missing', 'next')).toThrow(
			'No match found for oldText in /note.txt',
		)
		expect(() => store.edit(created.contentId, '/note.txt', 'alpha', 'next')).toThrow(
			'Found multiple matches for oldText. Provide more surrounding context to make the match unique.',
		)
		expect(() => store.get('missing-content', '/missing.txt')).toThrow(EntryNotFoundError)
	})
})

describe('ContentStore binary', () => {
	test('creates, reads, writes binary content', () => {
		const store = new ContentStore(new Y.Doc())
		const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const created = store.createBinary(imageData)

		expect(store.readBinary(created.contentId, '/image.png')).toEqual(imageData)
		expect(store.sizeBinary(created.contentId, '/image.png')).toBe(8)

		const newData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		store.writeBinary(created.contentId, '/image.png', newData)
		expect(store.readBinary(created.contentId, '/image.png')).toEqual(newData)
		expect(store.sizeBinary(created.contentId, '/image.png')).toBe(4)

		store.delete(created.contentId)
		expect(() => store.readBinary(created.contentId, '/image.png')).toThrow(EntryNotFoundError)
	})

	test('handles empty binary content', () => {
		const store = new ContentStore(new Y.Doc())
		const created = store.createBinary()

		expect(store.readBinary(created.contentId, '/empty.bin')).toEqual(new Uint8Array(0))
		expect(store.sizeBinary(created.contentId, '/empty.bin')).toBe(0)
	})

	test('handles large binary content', () => {
		const store = new ContentStore(new Y.Doc())
		const largeData = new Uint8Array(10000)
		for (let i = 0; i < largeData.length; i++) {
			largeData[i] = i % 256
		}
		const created = store.createBinary(largeData)

		expect(store.readBinary(created.contentId, '/large.bin')).toEqual(largeData)
		expect(store.sizeBinary(created.contentId, '/large.bin')).toBe(10000)
	})
})
