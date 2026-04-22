import { describe, expect, test } from 'bun:test'
import { EntryNotFoundError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem comments', () => {
	test('adds comments, replies, and resolution state to files', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')

		const commentId = filesystem.addComment('/workspace/note.txt', { index: 0, length: 5 }, 'Nice opener', 'alice')
		const replyId = filesystem.replyToComment('/workspace/note.txt', commentId, 'Agreed', 'bob')

		let comments = filesystem.getComments('/workspace/note.txt')
		expect(comments).toHaveLength(1)
		expect(comments[0]).toMatchObject({
			id: commentId,
			author: 'alice',
			body: 'Nice opener',
			anchorIndex: 0,
			anchorLength: 5,
			resolved: false,
			replies: [
				{
					id: replyId,
					parentId: commentId,
					author: 'bob',
					body: 'Agreed',
				},
			],
		})

		filesystem.resolveComment('/workspace/note.txt', commentId, 'carol')
		comments = filesystem.getComments('/workspace/note.txt')
		expect(comments[0]).toMatchObject({
			resolved: true,
			resolvedBy: 'carol',
		})
		expect(comments[0]?.resolvedAt).toBeGreaterThan(0)

		filesystem.resolveComment('/workspace/note.txt', commentId, 'alice')
		comments = filesystem.getComments('/workspace/note.txt')
		expect(comments[0]).toMatchObject({
			resolved: false,
			resolvedBy: undefined,
			resolvedAt: undefined,
		})
	})

	test('keeps comment anchors aligned through local edits', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')
		filesystem.addComment('/workspace/note.txt', { index: 6, length: 5 }, 'Review target', 'alice')

		filesystem.editFile('/workspace/note.txt', 'hello', 'greetings hello')
		let comments = filesystem.getComments('/workspace/note.txt')
		expect(comments).toHaveLength(1)
		expect(comments[0]?.anchorIndex).toBeGreaterThan(6)
		expect(comments[0]?.anchorLength).toBe(5)

		filesystem.writeFile('/workspace/note.txt', 'hello beautiful world')
		filesystem.addComment('/workspace/note.txt', { index: 0, length: 5 }, 'Keep hello', 'bob')
		filesystem.editFile('/workspace/note.txt', ' beautiful', '')
		comments = filesystem.getComments('/workspace/note.txt')

		expect(comments).toEqual(
			expect.arrayContaining([expect.objectContaining({ body: 'Keep hello', anchorIndex: 0, anchorLength: 5 })]),
		)
	})

	test('throws for missing files or comments', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/workspace')
		filesystem.createFile('/workspace/note.txt', 'hello world')

		expect(() => filesystem.addComment('/workspace/missing.txt', { index: 0, length: 1 }, 'x', 'alice')).toThrow(
			EntryNotFoundError,
		)
		expect(() => filesystem.getComments('/workspace/missing.txt')).toThrow(EntryNotFoundError)
		expect(() => filesystem.replyToComment('/workspace/note.txt', 'missing', 'x', 'alice')).toThrow(
			'Comment not found',
		)
		expect(() => filesystem.resolveComment('/workspace/note.txt', 'missing', 'alice')).toThrow('Comment not found')
	})
})
