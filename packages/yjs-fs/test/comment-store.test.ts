import { describe, expect, test } from 'bun:test'
import { CommentStore, ContentStore, EntryNotFoundError } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('CommentStore', () => {
	test('adds replies and resolution state against a content doc', () => {
		const doc = new Y.Doc()
		const files = doc.getMap<Y.Map<unknown>>('files')
		const record = new Y.Map<unknown>()
		files.set('content-1', record)
		const text = new Y.Text()
		record.set('content', text)
		text.insert(0, 'hello world')
		const store = new CommentStore()
		store.initialize(record)

		const commentId = store.add(record, { index: 0, length: 5 }, 'Nice opener', 'alice')
		const replyId = store.reply(record, commentId, 'Agreed', 'bob')

		let comments = store.list(record)
		expect(comments[0]).toMatchObject({
			id: commentId,
			author: 'alice',
			body: 'Nice opener',
			replies: [{ id: replyId, parentId: commentId, author: 'bob', body: 'Agreed' }],
			resolved: false,
		})

		store.resolve(record, commentId, 'carol')
		comments = store.list(record)
		expect(comments[0]).toMatchObject({ resolved: true, resolvedBy: 'carol' })
	})

	test('supports content-store helpers and toggle resolution behavior', () => {
		const content = new ContentStore(new Y.Doc())
		const created = content.create('hello world')
		const store = new CommentStore()
		store.initializeForContent(content, created.contentId, '/note.txt')

		const commentId = store.addForContent(
			content,
			created.contentId,
			'/note.txt',
			{ index: 6, length: 5 },
			'Review target',
			'alice',
		)
		const replyId = store.replyForContent(content, created.contentId, '/note.txt', commentId, 'Looks good', 'bob')
		let comments = store.listForContent(content, created.contentId, '/note.txt')

		expect(comments).toEqual([
			expect.objectContaining({
				id: commentId,
				anchorIndex: 6,
				anchorLength: 5,
				replies: [expect.objectContaining({ id: replyId, parentId: commentId, author: 'bob' })],
				resolved: false,
			}),
		])

		store.resolveForContent(content, created.contentId, '/note.txt', commentId, 'carol')
		store.resolveForContent(content, created.contentId, '/note.txt', commentId, 'carol')
		comments = store.listForContent(content, created.contentId, '/note.txt')
		expect(comments[0]).toMatchObject({ resolved: false, resolvedBy: undefined, resolvedAt: undefined })

		expect(() => store.listForContent(content, 'missing-content', '/missing.txt')).toThrow(EntryNotFoundError)
		expect(() =>
			store.replyForContent(content, created.contentId, '/note.txt', 'missing-comment', 'x', 'alice'),
		).toThrow('Comment not found: missing-comment')
	})
})
