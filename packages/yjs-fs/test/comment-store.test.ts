import { describe, expect, test } from 'bun:test'
import { CommentStore } from '@humanlayer/yjs-fs'
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
})
