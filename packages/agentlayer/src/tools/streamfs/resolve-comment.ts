import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { COMMENT_COLLECTION_TYPE } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import type { CommentsContext } from './comments-context'
import DESCRIPTION from './resolve-comment.txt'

const input = z.object({
	commentId: z.string().describe('The ID of the comment to resolve'),
})

export function createStreamFsResolveCommentTool(fs: StreamFilesystem, comments: CommentsContext) {
	return defineTool({
		name: 'resolve_comment',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			const allComments = comments.readComments()
			const existing = allComments.find((c) => c.id === input.commentId)

			if (!existing) {
				throw new Error(`Comment ${input.commentId} not found`)
			}

			if (existing.isDeleted) {
				throw new Error(`Comment ${input.commentId} has been deleted`)
			}

			if (existing.isResolved) {
				return JSON.stringify({ id: input.commentId, status: 'already_resolved' })
			}

			const updated = { ...existing, isResolved: true }

			const event = {
				type: COMMENT_COLLECTION_TYPE,
				key: input.commentId,
				value: updated,
				old_value: existing,
				headers: { operation: 'update' },
			}
			await comments.stream.append(JSON.stringify(event))

			return JSON.stringify({ id: input.commentId, status: 'resolved' })
		},
	})
}
