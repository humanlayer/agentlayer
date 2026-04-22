import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem rename', () => {
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

	test('renames files across directories while preserving entry and content identity', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/from')
		filesystem.mkdir('/to')
		const entryId = filesystem.createFile('/from/file.txt', 'payload')
		const before = filesystem.stat('/from/file.txt')

		filesystem.rename('/from/file.txt', '/to/file.txt')

		expect(filesystem.exists('/from/file.txt')).toBe(false)
		expect(filesystem.exists('/to/file.txt')).toBe(true)
		expect(filesystem.stat('/to/file.txt').entryId).toBe(entryId)
		expect(filesystem.stat('/to/file.txt').contentId).toBe(before.contentId)
		expect(filesystem.readFile('/to/file.txt')).toBe('payload')
	})
})
