import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import { EntryNotFoundError, YjsFilesystem } from '@humanlayer/yjs-fs'
import { snapshotFilesystem } from './support/snapshot'
import { syncBothWays } from './support/sync'

describe('YjsFilesystem sync interleavings', () => {
	test('converges when one replica renames while the other edits', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/shared')
		const entryId = fs1.createFile('/shared/note.txt', 'alpha beta')
		const initialContentId = fs1.stat('/shared/note.txt').contentId
		syncBothWays(doc1, doc2)

		fs1.rename('/shared/note.txt', '/shared/renamed.txt')
		fs2.editFile('/shared/note.txt', 'beta', 'gamma')
		syncBothWays(doc1, doc2)

		expect(fs1.exists('/shared/note.txt')).toBe(false)
		expect(fs2.exists('/shared/note.txt')).toBe(false)
		expect(fs1.readFile('/shared/renamed.txt')).toBe('alpha gamma')
		expect(fs2.readFile('/shared/renamed.txt')).toBe('alpha gamma')
		expect(fs1.stat('/shared/renamed.txt').entryId).toBe(entryId)
		expect(fs2.stat('/shared/renamed.txt').entryId).toBe(entryId)
		expect(fs1.stat('/shared/renamed.txt').contentId).toBe(initialContentId)
		expect(fs2.stat('/shared/renamed.txt').contentId).toBe(initialContentId)
	})

	test('converges to deletion when one replica deletes while the other edits', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/shared')
		fs1.createFile('/shared/note.txt', 'start value')
		syncBothWays(doc1, doc2)

		fs1.unlink('/shared/note.txt')
		fs2.editFile('/shared/note.txt', 'value', 'change')
		syncBothWays(doc1, doc2)

		expect(fs1.exists('/shared/note.txt')).toBe(false)
		expect(fs2.exists('/shared/note.txt')).toBe(false)
		expect(() => fs1.readFile('/shared/note.txt')).toThrow(EntryNotFoundError)
		expect(() => fs2.readFile('/shared/note.txt')).toThrow(EntryNotFoundError)
	})

	test('merges divergent namespace mutations before sync', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/left')
		fs1.createFile('/left/a.txt', 'A')

		fs2.mkdir('/right')
		fs2.createFile('/right/b.txt', 'B')

		syncBothWays(doc1, doc2)

		expect(snapshotFilesystem(fs1)).toEqual(snapshotFilesystem(fs2))
		expect(fs1.readFile('/left/a.txt')).toBe('A')
		expect(fs1.readFile('/right/b.txt')).toBe('B')
	})

	test('stays consistent across repeated sync cycles with both sides mutating', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/workspace')
		fs1.createFile('/workspace/a.txt', 'A')
		syncBothWays(doc1, doc2)

		fs2.mkdir('/workspace/docs')
		fs2.createFile('/workspace/docs/readme.md', 'readme')
		syncBothWays(doc1, doc2)

		fs1.rename('/workspace/a.txt', '/workspace/renamed.txt')
		fs2.editFile('/workspace/docs/readme.md', 'readme', 'guide')
		syncBothWays(doc1, doc2)

		fs1.createFile('/workspace/docs/notes.txt', 'notes')
		fs2.rename('/workspace/docs', '/workspace/reference')
		syncBothWays(doc1, doc2)

		expect(snapshotFilesystem(fs1)).toEqual(snapshotFilesystem(fs2))
		expect(fs1.readFile('/workspace/reference/readme.md')).toBe('guide')
		expect(fs2.readFile('/workspace/reference/notes.txt')).toBe('notes')
	})
})
