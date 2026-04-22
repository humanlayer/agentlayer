import type * as Y from 'yjs'
import {
	addCommentRecord,
	getCommentRecords,
	initializeComments,
	replyToCommentRecord,
	resolveCommentRecord,
} from '../comments'
import type { CommentAnchor, FileComment } from '../types'

type FileRecord = Y.Map<unknown>

export class CommentStore {
	initialize(record: FileRecord): void {
		initializeComments(record)
	}

	add(record: FileRecord, anchor: CommentAnchor, body: string, author: string): string {
		return addCommentRecord(record, anchor, body, author)
	}

	list(record: FileRecord): FileComment[] {
		return getCommentRecords(record)
	}

	reply(record: FileRecord, commentId: string, body: string, author: string): string {
		return replyToCommentRecord(record, commentId, body, author)
	}

	resolve(record: FileRecord, commentId: string, author: string): void {
		resolveCommentRecord(record, commentId, author)
	}
}
