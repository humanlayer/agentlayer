import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { CreateCommentTool } from '../interfaces/comment'

export function createYStreamFsCreateCommentTool(fs: YjsStreamFS) {
	return CreateCommentTool.define(
		async (input) => {
			// Reply to existing comment
			if (input.parentId) {
				const id = fs.replyToComment(input.filePath, input.parentId, input.body, input.author)
				return { id }
			}

			// New top-level comment — selectedText is required
			if (!input.selectedText) {
				throw new Error('selectedText is required when creating a new comment (no parentId)')
			}

			const content = fs.readFile(input.filePath)

			let anchorIndex: number
			if (input.contextBefore) {
				const probe = input.contextBefore + input.selectedText
				const probeIdx = content.indexOf(probe)
				if (probeIdx === -1) {
					throw new Error(
						`Could not find "${input.selectedText}" preceded by contextBefore in ${input.filePath}`,
					)
				}
				anchorIndex = probeIdx + input.contextBefore.length
			} else {
				anchorIndex = content.indexOf(input.selectedText)
				if (anchorIndex === -1) {
					throw new Error(`Could not find "${input.selectedText}" in ${input.filePath}`)
				}
			}

			const id = fs.addComment(
				input.filePath,
				{ index: anchorIndex, length: input.selectedText.length },
				input.body,
				input.author,
			)
			return { id }
		},
		{
			description:
				'Add an inline comment or reply to an existing thread. For new comments, provide selectedText to anchor to. For replies, provide parentId. Returns the ID.',
		},
	)
}
