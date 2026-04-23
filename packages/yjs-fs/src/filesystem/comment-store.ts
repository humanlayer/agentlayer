import type * as Y from 'yjs'
import {
	addCommentRecord,
	getCommentRecords,
	initializeComments,
	replyToCommentRecord,
	resolveCommentRecord,
} from './comments'
import type { ContentStore } from './content-store'
import type { CommentAnchor, ContentId, FileComment } from './types'

type FileRecord = Y.Map<unknown>

export class CommentStore {
	initialize(record: FileRecord): void {
		initializeComments(record)
	}

	initializeForContent(contentStore: ContentStore, contentId: ContentId, pathForErrors: string): void {
		this.initialize(contentStore.get(contentId, pathForErrors))
	}

	add(record: FileRecord, anchor: CommentAnchor, body: string, author: string): string {
		return addCommentRecord(record, anchor, body, author)
	}

	addForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
		anchor: CommentAnchor,
		body: string,
		author: string,
	): string {
		return this.add(contentStore.get(contentId, pathForErrors), anchor, body, author)
	}

	list(record: FileRecord): FileComment[] {
		return getCommentRecords(record)
	}

	listForContent(contentStore: ContentStore, contentId: ContentId, pathForErrors: string): FileComment[] {
		return this.list(contentStore.get(contentId, pathForErrors))
	}

	reply(record: FileRecord, commentId: string, body: string, author: string): string {
		return replyToCommentRecord(record, commentId, body, author)
	}

	replyForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
		commentId: string,
		body: string,
		author: string,
	): string {
		return this.reply(contentStore.get(contentId, pathForErrors), commentId, body, author)
	}

	resolve(record: FileRecord, commentId: string, author: string): void {
		resolveCommentRecord(record, commentId, author)
	}

	resolveForContent(
		contentStore: ContentStore,
		contentId: ContentId,
		pathForErrors: string,
		commentId: string,
		author: string,
	): void {
		this.resolve(contentStore.get(contentId, pathForErrors), commentId, author)
	}
}
