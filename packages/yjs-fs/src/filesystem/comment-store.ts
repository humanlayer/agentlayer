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

/**
 * Small adapter around comment helpers that works with raw file records or
 * content ids resolved through `ContentStore`.
 */
export class CommentStore {
	/** Ensures the given file record has comment storage initialized. */
	initialize(record: FileRecord): void {
		initializeComments(record)
	}

	/** Initializes comment storage for a file addressed by content id. */
	initializeForContent(contentStore: ContentStore, contentId: ContentId, pathForErrors: string): void {
		this.initialize(contentStore.get(contentId, pathForErrors))
	}

	/** Adds a top-level comment to a raw file record. */
	add(record: FileRecord, anchor: CommentAnchor, body: string, author: string): string {
		return addCommentRecord(record, anchor, body, author)
	}

	/** Adds a top-level comment to a file addressed by content id. */
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

	/** Lists comments from a raw file record. */
	list(record: FileRecord): FileComment[] {
		return getCommentRecords(record)
	}

	/** Lists comments for a file addressed by content id. */
	listForContent(contentStore: ContentStore, contentId: ContentId, pathForErrors: string): FileComment[] {
		return this.list(contentStore.get(contentId, pathForErrors))
	}

	/** Adds a reply under an existing top-level comment in a raw file record. */
	reply(record: FileRecord, commentId: string, body: string, author: string): string {
		return replyToCommentRecord(record, commentId, body, author)
	}

	/** Adds a reply under an existing comment for a file addressed by content id. */
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

	/** Toggles the resolved state of a comment in a raw file record. */
	resolve(record: FileRecord, commentId: string, author: string): void {
		resolveCommentRecord(record, commentId, author)
	}

	/** Toggles the resolved state of a comment for a file addressed by content id. */
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
