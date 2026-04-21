import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

// ─── Shared schema ───────────────────────────────────────────────────────────

const CommentReplySchema = z.object({
	id: z.string(),
	parentId: z.string().describe('ID of the top-level comment this is a reply to'),
	author: z.string(),
	body: z.string(),
	createdAt: z.number(),
})

export const CommentSchema = z.object({
	id: z.string(),
	author: z.string(),
	body: z.string(),
	createdAt: z.number(),
	anchorIndex: z.number(),
	anchorLength: z.number(),
	replies: z.array(CommentReplySchema),
	resolved: z.boolean(),
	resolvedAt: z.number().optional(),
	resolvedBy: z.string().optional(),
})

export type CommentOutput = z.infer<typeof CommentSchema>

// ─── list_comments ───────────────────────────────────────────────────────────

export const listCommentsInput = z.object({
	file_path: z.string().describe('Path of the file whose comments to list'),
})

export type ListCommentsInput = z.infer<typeof listCommentsInput>

export const ListCommentsTool = defineToolInterface<ListCommentsInput, CommentOutput[]>({
	name: 'list_comments',
	description:
		'List all inline comments on a file, including their IDs, author, body, text anchor, replies, and resolved status',
	input: listCommentsInput,
	serialize: (raw) => JSON.stringify(raw, null, 2),
})

// ─── create_comment ──────────────────────────────────────────────────────────

export const createCommentInput = z.object({
	file_path: z.string().describe('Path of the file to comment on'),
	selected_text: z
		.string()
		.optional()
		.describe('The exact text to anchor the comment to (required for new top-level comments)'),
	context_before: z
		.string()
		.optional()
		.describe(
			'Text immediately before selected_text in the file — used to disambiguate when selected_text appears multiple times',
		),
	body: z.string().describe('Comment text'),
	author: z.string().describe('Author name or agent ID'),
	parent_id: z
		.string()
		.optional()
		.describe('ID of an existing comment to reply to. When set, this creates a reply instead of a new comment.'),
})

export type CreateCommentInput = z.infer<typeof createCommentInput>

export const CreateCommentTool = defineToolInterface<CreateCommentInput, { id: string }>({
	name: 'create_comment',
	description:
		'Add an inline comment or reply to an existing thread. For new comments, provide selectedText to anchor to. For replies, provide parentId of the comment to reply to. Returns the comment/reply ID.',
	input: createCommentInput,
	serialize: (raw) => raw.id,
})

// ─── update_comment ──────────────────────────────────────────────────────────

export const updateCommentInput = z.object({
	file_path: z.string().describe('Path of the file containing the comment'),
	comment_id: z.string().describe('ID of the comment to update'),
	action: z
		.enum(['resolve', 'delete'])
		.describe("Action to perform: 'resolve' toggles resolved state, 'delete' removes the comment and all replies"),
	author: z.string().optional().describe('Author performing the action (required for resolve)'),
})

export type UpdateCommentInput = z.infer<typeof updateCommentInput>

export const UpdateCommentTool = defineToolInterface<UpdateCommentInput, string>({
	name: 'update_comment',
	description:
		"Update a comment by ID. Use action 'resolve' to toggle resolved/unresolved state, or 'delete' to permanently remove the comment and all its replies.",
	input: updateCommentInput,
	serialize: (raw) => raw,
})
