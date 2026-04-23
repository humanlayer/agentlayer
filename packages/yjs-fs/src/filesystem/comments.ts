import * as Y from 'yjs'
import {
	createAbsolutePositionFromRelativePosition,
	createRelativePositionFromTypeIndex,
	decodeRelativePosition,
	encodeRelativePosition,
} from 'yjs'
import type { CommentAnchor, CommentReply, FileComment } from './types'

type YCommentRecordValue = string | number | boolean | Y.Array<Y.Map<string | number>>
type YCommentRecord = Y.Map<YCommentRecordValue>
type YCommentReplyRecord = Y.Map<string | number>
type FileRecord = Y.Map<unknown>

const CONTENT_KEY = 'content'
const COMMENTS_KEY = 'comments'
const ANCHOR_START_KEY = 'anchorStart'
const ANCHOR_END_KEY = 'anchorEnd'
const REPLIES_KEY = 'replies'

export function initializeComments(record: FileRecord): void {
	if (!(record.get(COMMENTS_KEY) instanceof Y.Array)) {
		record.set(COMMENTS_KEY, new Y.Array<YCommentRecord>())
	}
}

export function addCommentRecord(record: FileRecord, anchor: CommentAnchor, body: string, author: string): string {
	const ytext = requireText(record)
	const comments = requireComments(record)
	const id = crypto.randomUUID()
	const createdAt = Date.now()

	const start = createRelativePositionFromTypeIndex(ytext, anchor.index)
	const end = createRelativePositionFromTypeIndex(ytext, anchor.index + anchor.length)
	const commentRecord = new Y.Map<YCommentRecordValue>()
	commentRecord.set('id', id)
	commentRecord.set('author', author)
	commentRecord.set('body', body)
	commentRecord.set('createdAt', createdAt)
	commentRecord.set(ANCHOR_START_KEY, base64FromUint8Array(encodeRelativePosition(start)))
	commentRecord.set(ANCHOR_END_KEY, base64FromUint8Array(encodeRelativePosition(end)))
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

export function replyToCommentRecord(record: FileRecord, commentId: string, body: string, author: string): string {
	const commentRecord = requireCommentRecord(record, commentId)
	let replies = commentRecord.get(REPLIES_KEY)

	if (!(replies instanceof Y.Array)) {
		replies = new Y.Array<YCommentReplyRecord>()
		commentRecord.set(REPLIES_KEY, replies)
	}

	const replyId = crypto.randomUUID()
	const reply = new Y.Map<string | number>()
	reply.set('id', replyId)
	reply.set('parentId', commentId)
	reply.set('author', author)
	reply.set('body', body)
	reply.set('createdAt', Date.now())

	replies.push([reply])
	return replyId
}

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

function readCommentRecord(doc: Y.Doc, commentRecord: YCommentRecord): FileComment | undefined {
	try {
		const startBytes = uint8ArrayFromBase64(requireStringField(commentRecord, ANCHOR_START_KEY))
		const endBytes = uint8ArrayFromBase64(requireStringField(commentRecord, ANCHOR_END_KEY))
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

function requireText(record: FileRecord): Y.Text {
	const text = record.get(CONTENT_KEY)
	if (!(text instanceof Y.Text)) {
		throw new Error('Missing file content text')
	}

	return text
}

function requireComments(record: FileRecord): Y.Array<YCommentRecord> {
	const comments = record.get(COMMENTS_KEY)
	if (!(comments instanceof Y.Array)) {
		throw new Error('Missing comments array')
	}

	return comments as Y.Array<YCommentRecord>
}

function requireStringField<T>(record: Y.Map<T>, key: string): string {
	const value = record.get(key)
	if (typeof value !== 'string') {
		throw new Error(`Expected string field: ${key}`)
	}
	return value
}

function requireNumberField<T>(record: Y.Map<T>, key: string): number {
	const value = record.get(key)
	if (typeof value !== 'number') {
		throw new Error(`Expected number field: ${key}`)
	}
	return value
}

function readOptionalStringField<T>(record: Y.Map<T>, key: string): string | undefined {
	const value = record.get(key)
	return typeof value === 'string' ? value : undefined
}

function readOptionalNumberField<T>(record: Y.Map<T>, key: string): number | undefined {
	const value = record.get(key)
	return typeof value === 'number' ? value : undefined
}

function base64FromUint8Array(value: Uint8Array): string {
	return Buffer.from(value).toString('base64')
}

function uint8ArrayFromBase64(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, 'base64'))
}
