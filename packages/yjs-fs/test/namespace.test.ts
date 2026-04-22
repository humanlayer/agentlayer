import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, EntryNotFoundError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem namespace', () => {
	test('normalizes relative paths, repeated slashes, and trailing slashes for namespace operations', () => {
		const filesystem = new YjsFilesystem()
		const workspaceId = filesystem.mkdir('workspace')
		const docsId = filesystem.mkdir('//workspace//docs//')

		expect(filesystem.exists('workspace')).toBe(true)
		expect(filesystem.exists('/workspace/')).toBe(true)
		expect(filesystem.exists('workspace/docs')).toBe(true)
		expect(filesystem.lookup('workspace')).toMatchObject({ entryId: workspaceId, path: '/workspace' })
		expect(filesystem.lookup('workspace/docs/')).toMatchObject({ entryId: docsId, path: '/workspace/docs' })
		expect(filesystem.stat('workspace/docs/').path).toBe('/workspace/docs')
		expect(filesystem.list('workspace').map((entry) => entry.path)).toEqual(['/workspace/docs'])
	})

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
})
