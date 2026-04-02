import type { CollectionDefinition, StateSchema } from '@durable-streams/state'
import { createStateSchema } from '@durable-streams/state'
import { z } from 'zod'

export const COMMENT_COLLECTION_TYPE: `comment` = `comment`

/**
 * Schema for a single comment entry in the /_comments stream.
 *
 * Text-match anchoring: `highlightedText` is searched in the document on each
 * render to compute the current line number. `highlightedTextLineNumber` is the
 * line number at comment creation time and may drift as text is edited.
 */
export const commentSchema = z.object({
	id: z.string(),
	filePath: z.string(),
	highlightedText: z.string(),
	highlightedTextLineNumber: z.number(),
	contentText: z.string(),
	replyToCommentId: z.string().nullable(),
	createdBy: z.string(),
	createdAt: z.string(),
	isResolved: z.boolean(),
	isDeleted: z.boolean(),
})

export type Comment = z.infer<typeof commentSchema>

type CommentCollections = {
	comments: CollectionDefinition<Comment>
}

export const commentStateSchema: StateSchema<CommentCollections> = createStateSchema({
	comments: {
		schema: commentSchema,
		type: COMMENT_COLLECTION_TYPE,
		primaryKey: `id`,
	},
})
