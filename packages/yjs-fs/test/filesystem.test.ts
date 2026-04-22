import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, DirectoryNotEmptyError, EntryNotFoundError, YjsFilesystem } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('YjsFilesystem namespace operations', () => {
	test('creates directories and resolves lookups with stable entry ids', () => {
		const filesystem = new YjsFilesystem()
		const projectsId = filesystem.mkdir('/projects')
		const notesId = filesystem.mkdir('/projects/notes')

		expect(filesystem.exists('/projects')).toBe(true)
		expect(filesystem.exists('/projects/notes')).toBe(true)
		expect(filesystem.exists('/projects/missing')).toBe(false)

		expect(filesystem.lookup('/projects')).toMatchObject({
			entryId: projectsId,
			path: '/projects',
			entry: {
				id: projectsId,
				name: 'projects',
				type: 'directory',
			},
		})

		expect(filesystem.lookup('/projects/notes')).toMatchObject({
			entryId: notesId,
			path: '/projects/notes',
			entry: {
				id: notesId,
				name: 'notes',
				parentId: projectsId,
				type: 'directory',
			},
		})
	})

	test('lists root and nested directories in sorted order', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.mkdir('/workspace/zeta')
		filesystem.mkdir('/workspace/alpha')
		filesystem.mkdir('/workspace/empty')

		expect(filesystem.list('/').map((entry) => entry.name)).toEqual(['workspace'])
		expect(filesystem.list('/workspace').map((entry) => entry.name)).toEqual(['alpha', 'empty', 'zeta'])
		expect(filesystem.list('/workspace').map((entry) => entry.path)).toEqual([
			'/workspace/alpha',
			'/workspace/empty',
			'/workspace/zeta',
		])
	})

	test('keeps explicit empty directories addressable', () => {
		const filesystem = new YjsFilesystem()
		const emptyId = filesystem.mkdir('scratch')

		expect(filesystem.list('/scratch')).toEqual([])
		expect(filesystem.lookup('/scratch')).toMatchObject({
			entryId: emptyId,
			path: '/scratch',
			entry: {
				id: emptyId,
				name: 'scratch',
				type: 'directory',
			},
		})
	})

	test('returns directory stats and rejects duplicate or missing paths', () => {
		const filesystem = new YjsFilesystem()
		const sandboxId = filesystem.mkdir('/sandbox')
		const stat = filesystem.stat('/sandbox')

		expect(stat).toMatchObject({
			entryId: sandboxId,
			name: 'sandbox',
			path: '/sandbox',
			type: 'directory',
			isDirectory: true,
			isFile: false,
		})

		expect(() => filesystem.mkdir('/sandbox')).toThrow(AlreadyExistsError)
		expect(() => filesystem.stat('/missing')).toThrow(EntryNotFoundError)
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

	test('renames directories and updates nested paths without recreating children', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/projects')
		filesystem.mkdir('/projects/specs')
		const fileEntryId = filesystem.createFile('/projects/specs/plan.md', 'draft')
		const initialStat = filesystem.stat('/projects/specs/plan.md')

		filesystem.rename('/projects/specs', '/projects/architecture')

		expect(filesystem.exists('/projects/specs')).toBe(false)
		expect(filesystem.exists('/projects/architecture')).toBe(true)
		expect(filesystem.exists('/projects/architecture/plan.md')).toBe(true)

		const renamedStat = filesystem.stat('/projects/architecture/plan.md')
		expect(renamedStat.entryId).toBe(fileEntryId)
		expect(renamedStat.contentId).toBe(initialStat.contentId)
		expect(filesystem.readFile('/projects/architecture/plan.md')).toBe('draft')
	})

	test('rejects deleting non-empty directories', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/notes.txt', 'hello')

		expect(() => filesystem.unlink('/workspace')).toThrow(DirectoryNotEmptyError)
	})

	test('rejects invalid file operations and destructive root mutations', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello')

		expect(() => filesystem.readFile('/workspace')).toThrow('Path is not a file: /workspace')
		expect(() => filesystem.writeFile('/workspace', 'x')).toThrow('Path is not a file: /workspace')
		expect(() => filesystem.editFile('/workspace', 'a', 'b')).toThrow('Path is not a file: /workspace')
		expect(() => filesystem.editFile('/workspace/note.txt', 'missing', 'x')).toThrow('No match found')
		expect(() => filesystem.createFile('/workspace/note.txt', 'duplicate')).toThrow(AlreadyExistsError)
		expect(() => filesystem.rename('/', '/renamed-root')).toThrow('Cannot rename the root directory')
		expect(() => filesystem.unlink('/')).toThrow('Cannot delete the root directory')
	})

	test('rejects conflicting renames and moving a directory into its own descendant', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.mkdir('/workspace/docs')
		filesystem.mkdir('/workspace/docs/nested')
		filesystem.createFile('/workspace/existing.txt', 'keep me')

		expect(() => filesystem.rename('/workspace/docs', '/workspace/existing.txt')).toThrow(AlreadyExistsError)
		expect(() => filesystem.rename('/workspace/docs', '/workspace/docs/nested/docs')).toThrow(
			'cannot move an entry into its own descendant',
		)
	})

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
})

function syncDoc(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source))

	const sourceContentDocs = source.getMap<Y.Doc>('contentDocs')
	const targetContentDocs = target.getMap<Y.Doc>('contentDocs')

	for (const [guid, sourceSubdoc] of sourceContentDocs.entries()) {
		const targetSubdoc = targetContentDocs.get(guid)
		if (!targetSubdoc) {
			continue
		}

		Y.applyUpdate(targetSubdoc, Y.encodeStateAsUpdate(sourceSubdoc))
	}
}
