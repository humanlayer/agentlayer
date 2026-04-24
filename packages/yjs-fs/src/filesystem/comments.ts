import * as Y from 'yjs'
import {
	createAbsolutePositionFromRelativePosition,
	createRelativePositionFromTypeIndex,
	decodeRelativePosition,
	encodeRelativePosition,
} from 'yjs'
import type { CommentAnchor, CommentReply, FileComment } from './types'

type YCommentRecordValue = string | number | boolean | Y.Array<number> | Y.Array<Y.Map<string | number>>
type YCommentRecord = Y.Map<YCommentRecordValue>
type YCommentReplyRecord = Y.Map<string | number>
type FileRecord = Y.Map<unknown>

const CONTENT_KEY = 'content'
const COMMENTS_KEY = 'comments'
const ANCHOR_START_KEY = 'anchorStart'
const ANCHOR_END_KEY = 'anchorEnd'
const REPLIES_KEY = 'replies'

/** Ensures a file record has the shared comments array used by comment APIs. */
export function initializeComments(record: FileRecord): void {
	if (!(record.get(COMMENTS_KEY) instanceof Y.Array)) {
		record.set(COMMENTS_KEY, new Y.Array<YCommentRecord>())
	}
}

/**
 * Adds a top-level comment anchored to the file's `Y.Text`.
 *
 * Anchors are stored as encoded Yjs relative positions so the comment can track
 * collaborative edits instead of being tied to raw absolute offsets.
 */
export function addCommentRecord(record: FileRecord, anchor: CommentAnchor, body: string, author: string): string {
	const ytext = requireText(record)
	const comments = requireComments(record)
	const id = crypto.randomUUID()
	const createdAt = Date.now()

	const start = createRelativePositionFromTypeIndex(ytext, anchor.index)
	const end = createRelativePositionFromTypeIndex(ytext, anchor.index + anchor.length)
	const commentRecord = new Y.Map<YCommentRecordValue>()
	const anchorStart = new Y.Array<number>()
	const anchorEnd = new Y.Array<number>()
	anchorStart.insert(0, Array.from(encodeRelativePosition(start)))
	anchorEnd.insert(0, Array.from(encodeRelativePosition(end)))
	commentRecord.set('id', id)
	commentRecord.set('author', author)
	commentRecord.set('body', body)
	commentRecord.set('createdAt', createdAt)
	commentRecord.set(ANCHOR_START_KEY, anchorStart)
	commentRecord.set(ANCHOR_END_KEY, anchorEnd)
	commentRecord.set(REPLIES_KEY, new Y.Array<YCommentReplyRecord>())
	commentRecord.set('resolved', false)

	const doc = ytext.doc
	doc?.transact(() => {
		comments.push([commentRecord])
	})

	if (!doc) {
		comments.push([commentRecord])
	}

	return id
}

/** Resolves all stored comments in a file record against the current text. */
export function getCommentRecords(record: FileRecord): FileComment[] {
	const comments = requireComments(record)
	const result: FileComment[] = []
	const ytext = requireText(record)
	const doc = ytext.doc
	if (!doc) {
		return []
	}

	for (let index = 0; index < comments.length; index += 1) {
		const commentRecord = comments.get(index)
		if (!(commentRecord instanceof Y.Map)) {
			continue
		}

		const comment = readCommentRecord(doc, commentRecord)
		if (comment) {
			result.push(comment)
		}
	}

	return result.sort((left, right) => left.createdAt - right.createdAt)
}

/** Adds a reply under an existing top-level comment. */
export function replyToCommentRecord(record: FileRecord, commentId: string, body: string, author: string): string {
	const commentRecord = requireCommentRecord(record, commentId)
	let replies = commentRecord.get(REPLIES_KEY)

	if (!(replies instanceof Y.Array)) {
		replies = new Y.Array<YCommentReplyRecord>()
		commentRecord.set(REPLIES_KEY, replies)
	}

	const repliesArray = replies as Y.Array<YCommentReplyRecord>

	const replyId = crypto.randomUUID()
	const reply = new Y.Map<string | number>()
	reply.set('id', replyId)
	reply.set('parentId', commentId)
	reply.set('author', author)
	reply.set('body', body)
	reply.set('createdAt', Date.now())

	repliesArray.push([reply])
	return replyId
}

/** Toggles a comment's resolved state and records resolver metadata when needed. */
export function resolveCommentRecord(record: FileRecord, commentId: string, author: string): void {
	const commentRecord = requireCommentRecord(record, commentId)
	const resolved = commentRecord.get('resolved') === true

	if (resolved) {
		commentRecord.set('resolved', false)
		commentRecord.delete('resolvedAt')
		commentRecord.delete('resolvedBy')
		return
	}

	commentRecord.set('resolved', true)
	commentRecord.set('resolvedAt', Date.now())
	commentRecord.set('resolvedBy', author)
}

/** Finds the shared Yjs record for one comment id in a file record. */
function requireCommentRecord(record: FileRecord, commentId: string): YCommentRecord {
	const comments = requireComments(record)

	for (let index = 0; index < comments.length; index += 1) {
		const commentRecord = comments.get(index)
		if (!(commentRecord instanceof Y.Map)) {
			continue
		}

		if (commentRecord.get('id') === commentId) {
			return commentRecord
		}
	}

	throw new Error(`Comment not found: ${commentId}`)
}

/** Decodes one shared comment record into the public `FileComment` shape. */
function readCommentRecord(doc: Y.Doc, commentRecord: YCommentRecord): FileComment | undefined {
	try {
		const startBytes = uint8ArrayFromYArray(requireByteArrayField(commentRecord, ANCHOR_START_KEY))
		const endBytes = uint8ArrayFromYArray(requireByteArrayField(commentRecord, ANCHOR_END_KEY))
		const startPosition = createAbsolutePositionFromRelativePosition(decodeRelativePosition(startBytes), doc)
		const endPosition = createAbsolutePositionFromRelativePosition(decodeRelativePosition(endBytes), doc)

		if (!startPosition || !endPosition) {
			return undefined
		}

		return {
			id: requireStringField(commentRecord, 'id'),
			author: requireStringField(commentRecord, 'author'),
			body: requireStringField(commentRecord, 'body'),
			createdAt: requireNumberField(commentRecord, 'createdAt'),
			anchorIndex: startPosition.index,
			anchorLength: Math.max(0, endPosition.index - startPosition.index),
			replies: readReplies(commentRecord, requireStringField(commentRecord, 'id')),
			resolved: commentRecord.get('resolved') === true,
			resolvedAt: readOptionalNumberField(commentRecord, 'resolvedAt'),
			resolvedBy: readOptionalStringField(commentRecord, 'resolvedBy'),
		}
	} catch {
		return undefined
	}
}

/** Reads and sorts reply records attached to one top-level comment. */
function readReplies(commentRecord: YCommentRecord, parentId: string): CommentReply[] {
	const replies = commentRecord.get(REPLIES_KEY)
	if (!(replies instanceof Y.Array)) {
		return []
	}

	const result: CommentReply[] = []
	for (let index = 0; index < replies.length; index += 1) {
		const replyRecord = replies.get(index)
		if (!(replyRecord instanceof Y.Map)) {
			continue
		}

		try {
			result.push({
				id: requireStringField(replyRecord, 'id'),
				parentId: readOptionalStringField(replyRecord, 'parentId') ?? parentId,
				author: requireStringField(replyRecord, 'author'),
				body: requireStringField(replyRecord, 'body'),
				createdAt: requireNumberField(replyRecord, 'createdAt'),
			})
		} catch {}
	}

	return result.sort((left, right) => left.createdAt - right.createdAt)
}

/** Returns the text payload comments anchor against. */
function requireText(record: FileRecord): Y.Text {
	const text = record.get(CONTENT_KEY)
	if (!(text instanceof Y.Text)) {
		throw new Error('Missing file content text')
	}

	return text
}

/** Returns the shared comments array stored on a file record. */
function requireComments(record: FileRecord): Y.Array<YCommentRecord> {
	const comments = record.get(COMMENTS_KEY)
	if (!(comments instanceof Y.Array)) {
		throw new Error('Missing comments array')
	}

	return comments as Y.Array<YCommentRecord>
}

/** Reads a required string field from a shared comment record. */
function requireStringField<T>(record: Y.Map<T>, key: string): string {
	const value = record.get(key)
	if (typeof value !== 'string') {
		throw new Error(`Expected string field: ${key}`)
	}
	return value
}

/** Reads a required numeric field from a shared comment record. */
function requireNumberField<T>(record: Y.Map<T>, key: string): number {
	const value = record.get(key)
	if (typeof value !== 'number') {
		throw new Error(`Expected number field: ${key}`)
	}
	return value
}

/** Reads an optional string field from a shared record. */
function readOptionalStringField<T>(record: Y.Map<T>, key: string): string | undefined {
	const value = record.get(key)
	return typeof value === 'string' ? value : undefined
}

/** Reads an optional numeric field from a shared record. */
function readOptionalNumberField<T>(record: Y.Map<T>, key: string): number | undefined {
	const value = record.get(key)
	return typeof value === 'number' ? value : undefined
}

/** Reads a required byte-array field from a shared comment record. */
function requireByteArrayField<T>(record: Y.Map<T>, key: string): Y.Array<number> {
	const value = record.get(key)
	if (!(value instanceof Y.Array)) {
		throw new Error(`Expected byte array field: ${key}`)
	}
	return value as Y.Array<number>
}

/** Materializes a shared byte array into a `Uint8Array` for Yjs decoders. */
function uint8ArrayFromYArray(value: Y.Array<number>): Uint8Array {
	return new Uint8Array(value.toArray())
}
