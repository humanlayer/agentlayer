import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { ListCommentsTool } from '../interfaces/comment'

export function createYStreamFsListCommentsTool(fs: YjsStreamFS) {
	return ListCommentsTool.define(
		async (input) => {
			return fs.getComments(input.filePath)
		},
		{
			description:
				'List all inline comments on a file, including their IDs, author, body, text anchor position, and any replies',
		},
	)
}
