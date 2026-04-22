import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'
import { syncBothWays, syncDoc } from './support/sync'

describe('YjsFilesystem sync', () => {
	test('syncs namespace and file content between docs with plain Yjs updates', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/shared')
		const entryId = fs1.createFile('/shared/note.txt', 'hello world')
		syncDoc(doc1, doc2)
		const initialStat = fs1.stat('/shared/note.txt')

		expect(fs2.exists('/shared')).toBe(true)
		expect(fs2.readFile('/shared/note.txt')).toBe('hello world')
		expect(fs2.stat('/shared/note.txt').entryId).toBe(entryId)
		expect(fs2.stat('/shared/note.txt').contentId).toBe(initialStat.contentId)

		fs2.writeFile('/shared/note.txt', 'line1\nline2')
		syncDoc(doc2, doc1)
		expect(fs1.readFile('/shared/note.txt')).toBe('line1\nline2')

		fs1.editFile('/shared/note.txt', 'line2', 'line2 updated')
		syncDoc(doc1, doc2)
		expect(fs2.readFile('/shared/note.txt')).toBe('line1\nline2 updated')

		fs2.rename('/shared/note.txt', '/shared/renamed.txt')
		syncDoc(doc2, doc1)

		expect(fs1.exists('/shared/note.txt')).toBe(false)
		expect(fs1.readFile('/shared/renamed.txt')).toBe('line1\nline2 updated')
		expect(fs1.stat('/shared/renamed.txt').entryId).toBe(entryId)
		expect(fs1.stat('/shared/renamed.txt').contentId).toBe(initialStat.contentId)

		fs1.unlink('/shared/renamed.txt')
		syncDoc(doc1, doc2)
		expect(fs2.exists('/shared/renamed.txt')).toBe(false)
	})

	test('syncs repeated snapshots from one side into a fresh replica', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/workspace')
		fs1.createFile('/workspace/a.txt', 'A')
		syncDoc(doc1, doc2)

		fs1.createFile('/workspace/b.txt', 'B')
		fs1.mkdir('/workspace/nested')
		syncDoc(doc1, doc2)

		expect(fs2.list('/workspace').map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'nested'])
		expect(fs2.readFile('/workspace/a.txt')).toBe('A')
		expect(fs2.readFile('/workspace/b.txt')).toBe('B')
	})

	test('converges after divergent edits once both sides exchange snapshots', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/shared')
		fs1.createFile('/shared/note.txt', 'start')
		syncDoc(doc1, doc2)

		fs1.writeFile('/shared/note.txt', 'from doc1')
		fs2.writeFile('/shared/note.txt', 'from doc2')

		syncBothWays(doc1, doc2)

		expect(fs1.readFile('/shared/note.txt')).toBe(fs2.readFile('/shared/note.txt'))
		expect(fs1.stat('/shared/note.txt').contentId).toBe(fs2.stat('/shared/note.txt').contentId)
		// last-writer semantics are not asserted here; only convergence and identity consistency
	})
})
