import type * as Y from 'yjs'
import {
	addCommentRecord,
	getCommentRecords,
	initializeComments,
	replyToCommentRecord,
	resolveCommentRecord,
} from '../comments'
import type { CommentAnchor, FileComment } from '../types'

export class CommentStore {
	initialize(doc: Y.Doc): void {
		initializeComments(doc)
	}

	add(doc: Y.Doc, anchor: CommentAnchor, body: string, author: string): string {
		return addCommentRecord(doc, anchor, body, author)
	}

	list(doc: Y.Doc): FileComment[] {
		return getCommentRecords(doc)
	}

	reply(doc: Y.Doc, commentId: string, body: string, author: string): string {
		return replyToCommentRecord(doc, commentId, body, author)
	}

	resolve(doc: Y.Doc, commentId: string, author: string): void {
		resolveCommentRecord(doc, commentId, author)
	}
}
