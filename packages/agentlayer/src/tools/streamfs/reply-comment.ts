import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { type Comment, commentStateSchema } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import type { CommentsContext } from './comments-context'
import DESCRIPTION from './reply-comment.txt'

const input = z.object({
	commentId: z.string().describe('The ID of the comment to reply to'),
	comment: z.string().describe('The reply text'),
})

export function createStreamFsReplyCommentTool(fs: StreamFilesystem, comments: CommentsContext) {
	return defineTool({
		name: 'reply_comment',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			const allComments = comments.readComments()
			const parent = allComments.find((c) => c.id === input.commentId)

			if (!parent) {
				throw new Error(`Comment ${input.commentId} not found`)
			}

			if (parent.isDeleted) {
				throw new Error(`Comment ${input.commentId} has been deleted`)
			}

			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
			const now = new Date().toISOString()

			const reply: Comment = {
				id,
				filePath: parent.filePath,
				highlightedText: parent.highlightedText,
				highlightedTextLineNumber: parent.highlightedTextLineNumber,
				contentText: input.comment,
				replyToCommentId: parent.replyToCommentId ?? parent.id,
				createdBy: `agent`,
				createdAt: now,
				isResolved: false,
				isDeleted: false,
			}

			const event = commentStateSchema.comments.insert({ key: id, value: reply })
			await comments.stream.append(JSON.stringify(event))

			return JSON.stringify({
				id,
				replyTo: input.commentId,
				comment: input.comment,
			})
		},
	})
}
