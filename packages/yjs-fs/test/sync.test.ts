import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'
import { syncBothWays, syncDoc } from './util/sync'

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

	test('syncs binary file content between docs', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/assets')
		const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const entryId = fs1.createBinaryFile('/assets/logo.png', imageData)
		syncDoc(doc1, doc2)
		const initialStat = fs1.stat('/assets/logo.png')

		expect(fs2.exists('/assets')).toBe(true)
		expect(fs2.readBinaryFile('/assets/logo.png')).toEqual(imageData)
		expect(fs2.stat('/assets/logo.png').entryId).toBe(entryId)
		expect(fs2.stat('/assets/logo.png').contentId).toBe(initialStat.contentId)
		expect(fs2.stat('/assets/logo.png').encoding).toBe('binary')

		const newData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
		fs2.writeBinaryFile('/assets/logo.png', newData)
		syncDoc(doc2, doc1)
		expect(fs1.readBinaryFile('/assets/logo.png')).toEqual(newData)

		fs1.rename('/assets/logo.png', '/assets/header.jpg')
		syncDoc(doc1, doc2)

		expect(fs2.exists('/assets/logo.png')).toBe(false)
		expect(fs2.readBinaryFile('/assets/header.jpg')).toEqual(newData)
		expect(fs2.stat('/assets/header.jpg').entryId).toBe(entryId)
		expect(fs2.stat('/assets/header.jpg').contentId).toBe(initialStat.contentId)

		fs2.unlink('/assets/header.jpg')
		syncDoc(doc2, doc1)
		expect(fs1.exists('/assets/header.jpg')).toBe(false)
	})

	test('converges binary content after divergent writes', () => {
		const doc1 = new Y.Doc()
		const doc2 = new Y.Doc()
		const fs1 = new YjsFilesystem({ doc: doc1 })
		const fs2 = new YjsFilesystem({ doc: doc2 })

		fs1.mkdir('/shared')
		fs1.createBinaryFile('/shared/data.bin', new Uint8Array([1, 2, 3]))
		syncDoc(doc1, doc2)

		fs1.writeBinaryFile('/shared/data.bin', new Uint8Array([10, 20, 30]))
		fs2.writeBinaryFile('/shared/data.bin', new Uint8Array([100, 200]))

		syncBothWays(doc1, doc2)

		expect(fs1.readBinaryFile('/shared/data.bin')).toEqual(fs2.readBinaryFile('/shared/data.bin'))
		expect(fs1.stat('/shared/data.bin').contentId).toBe(fs2.stat('/shared/data.bin').contentId)
	})
})
