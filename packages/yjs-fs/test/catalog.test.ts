import { describe, expect, test } from 'bun:test'
import {
	AlreadyExistsError,
	DirectoryNotEmptyError,
	EntryNotFoundError,
	InvalidPathError,
	NotDirectoryError,
	RootMutationError,
} from '@humanlayer/yjs-fs'
import * as Y from 'yjs'
import {
	createCatalogState,
	createFileInCatalog,
	deleteEntryInCatalog,
	getEntry,
	getPathForEntryId,
	listDirectoryEntries,
	lookupPath,
	mkdirInCatalog,
	normalizePath,
	renameInCatalog,
	updateFileMetadata,
} from '../src/filesystem/catalog'

describe('catalog module', () => {
	test('normalizes absolute paths and rejects unsupported segments', () => {
		expect(normalizePath('workspace/docs')).toBe('/workspace/docs')
		expect(normalizePath('//workspace//docs//')).toBe('/workspace/docs')
		expect(normalizePath('/')).toBe('/')
		expect(() => normalizePath('/workspace/./docs')).toThrow(InvalidPathError)
		expect(() => normalizePath('/workspace/../docs')).toThrow(InvalidPathError)
	})

	test('creates namespace entries and resolves them by path and id', () => {
		const state = createCatalogState(new Y.Doc())
		const workspaceId = mkdirInCatalog(state, '/workspace')
		const docsId = mkdirInCatalog(state, '/workspace/docs')
		const fileId = createFileInCatalog(state, '/workspace/docs/plan.md', 'content-1', 5)

		expect(lookupPath(state, '/workspace')?.entryId).toBe(workspaceId)
		expect(lookupPath(state, '/workspace/docs')?.entryId).toBe(docsId)
		expect(lookupPath(state, '/workspace/docs/plan.md')?.entryId).toBe(fileId)
		expect(getPathForEntryId(state, fileId)).toBe('/workspace/docs/plan.md')
		expect(getEntry(state, fileId)).toMatchObject({
			id: fileId,
			type: 'file',
			contentId: 'content-1',
			size: 5,
		})
		expect(listDirectoryEntries(state, docsId)).toEqual([
			{ entryId: fileId, name: 'plan.md', path: '/workspace/docs/plan.md', type: 'file' },
		])
	})

	test('renames directories recursively without changing file identity', () => {
		const state = createCatalogState(new Y.Doc())
		mkdirInCatalog(state, '/workspace')
		const docsId = mkdirInCatalog(state, '/workspace/docs')
		const fileId = createFileInCatalog(state, '/workspace/docs/plan.md', 'content-1', 5)

		expect(renameInCatalog(state, '/workspace/docs', '/workspace/specs')).toBe(docsId)
		expect(lookupPath(state, '/workspace/docs')).toBeUndefined()
		expect(lookupPath(state, '/workspace/specs')?.entryId).toBe(docsId)
		expect(lookupPath(state, '/workspace/specs/plan.md')?.entryId).toBe(fileId)
		expect(getPathForEntryId(state, fileId)).toBe('/workspace/specs/plan.md')
	})

	test('updates file metadata and enforces deletion constraints', () => {
		const state = createCatalogState(new Y.Doc())
		mkdirInCatalog(state, '/workspace')
		const fileId = createFileInCatalog(state, '/workspace/note.txt', 'content-1', 5)

		updateFileMetadata(state, fileId, 11)
		expect(getEntry(state, fileId)).toMatchObject({ size: 11 })
		expect(() => deleteEntryInCatalog(state, '/workspace')).toThrow(DirectoryNotEmptyError)

		const deleted = deleteEntryInCatalog(state, '/workspace/note.txt')
		expect(deleted).toMatchObject({ type: 'file', contentId: 'content-1' })
		expect(lookupPath(state, '/workspace/note.txt')).toBeUndefined()
	})

	test('rejects duplicates, missing parents, invalid deletes, and bad listings', () => {
		const state = createCatalogState(new Y.Doc())
		mkdirInCatalog(state, '/workspace')
		createFileInCatalog(state, '/workspace/note.txt', 'content-1', 5)

		expect(() => mkdirInCatalog(state, '/workspace')).toThrow(AlreadyExistsError)
		expect(() => createFileInCatalog(state, '/missing/note.txt', 'content-2', 0)).toThrow(EntryNotFoundError)
		expect(() => listDirectoryEntries(state, lookupPath(state, '/workspace/note.txt')!.entryId)).toThrow(
			NotDirectoryError,
		)
		expect(() => deleteEntryInCatalog(state, '/')).toThrow(RootMutationError)
	})
})
