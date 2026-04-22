import { describe, expect, test } from 'bun:test'
import { CommentStore } from '@humanlayer/yjs-fs'
import * as Y from 'yjs'

describe('CommentStore', () => {
	test('adds replies and resolution state against a content doc', () => {
		const doc = new Y.Doc()
		doc.getText('content').insert(0, 'hello world')
		const store = new CommentStore()
		store.initialize(doc)

		const commentId = store.add(doc, { index: 0, length: 5 }, 'Nice opener', 'alice')
		const replyId = store.reply(doc, commentId, 'Agreed', 'bob')

		let comments = store.list(doc)
		expect(comments[0]).toMatchObject({
			id: commentId,
			author: 'alice',
			body: 'Nice opener',
			replies: [{ id: replyId, parentId: commentId, author: 'bob', body: 'Agreed' }],
			resolved: false,
		})

		store.resolve(doc, commentId, 'carol')
		comments = store.list(doc)
		expect(comments[0]).toMatchObject({ resolved: true, resolvedBy: 'carol' })
	})
})
