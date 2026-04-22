import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, CatalogStore, DirectoryNotEmptyError, EntryNotFoundError } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('CatalogStore', () => {
	test('creates directories and file entries with stable lookup state', () => {
		const store = new CatalogStore(new Y.Doc())
		const workspaceId = store.mkdir('/workspace')
		const fileId = store.createFileEntry('/workspace/note.txt', 'content-1', 5)

		expect(store.lookup('/workspace')?.entryId).toBe(workspaceId)
		expect(store.lookup('/workspace/note.txt')?.entryId).toBe(fileId)
		expect(store.list('/workspace')).toEqual([
			{ entryId: fileId, name: 'note.txt', path: '/workspace/note.txt', type: 'file' },
		])
		expect(store.stat('/workspace/note.txt')).toMatchObject({
			entryId: fileId,
			contentId: 'content-1',
			size: 5,
		})
	})

	test('renames entries without changing file identity and updates nested paths', () => {
		const store = new CatalogStore(new Y.Doc())
		store.mkdir('/workspace')
		store.mkdir('/workspace/docs')
		const fileId = store.createFileEntry('/workspace/docs/plan.md', 'content-1', 5)

		store.rename('/workspace/docs', '/workspace/specs')

		expect(store.exists('/workspace/docs')).toBe(false)
		expect(store.exists('/workspace/specs')).toBe(true)
		expect(store.lookup('/workspace/specs/plan.md')?.entryId).toBe(fileId)
		expect(store.stat('/workspace/specs/plan.md').contentId).toBe('content-1')
	})

	test('rejects duplicates and non-empty directory deletion', () => {
		const store = new CatalogStore(new Y.Doc())
		store.mkdir('/workspace')
		store.createFileEntry('/workspace/note.txt', 'content-1', 5)

		expect(() => store.mkdir('/workspace')).toThrow(AlreadyExistsError)
		expect(() => store.delete('/workspace')).toThrow(DirectoryNotEmptyError)
		expect(() => store.requireLookup('/missing')).toThrow(EntryNotFoundError)
	})
})
