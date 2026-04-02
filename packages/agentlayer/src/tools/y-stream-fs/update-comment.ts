import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { UpdateCommentTool } from '../interfaces/comment'

export function createYStreamFsUpdateCommentTool(fs: YjsStreamFS) {
	return UpdateCommentTool.define(
		async (input) => {
			if (input.action === 'resolve') {
				if (!input.author) {
					throw new Error('author is required for resolve action')
				}
				fs.resolveComment(input.filePath, input.commentId, input.author)
				return `Toggled resolved state for comment ${input.commentId}`
			}

			// delete
			fs.deleteComment(input.filePath, input.commentId)
			return `Deleted comment ${input.commentId}`
		},
		{
			description:
				"Update a comment: 'resolve' toggles resolved/unresolved state, 'delete' permanently removes it and all replies.",
		},
	)
}
