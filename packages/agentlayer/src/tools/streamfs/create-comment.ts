import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { type Comment, commentStateSchema } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import type { CommentsContext } from './comments-context'
import DESCRIPTION from './create-comment.txt'

const input = z.object({
	filePath: z.string().describe('The path to the file to comment on (e.g., "/src/main.ts")'),
	line: z.number().int().describe('The 1-based line number to comment on'),
	highlightedText: z
		.string()
		.optional()
		.describe(
			'The exact text to anchor the comment to. If omitted, the full content of the specified line is used.',
		),
	comment: z.string().describe('The comment text'),
})

export function createStreamFsCreateCommentTool(fs: StreamFilesystem, comments: CommentsContext) {
	return defineTool({
		name: 'create_comment',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			const content = await fs.readTextFile(input.filePath)
			const lines = content.split(`\n`)

			if (input.line < 1 || input.line > lines.length) {
				throw new Error(`Line ${input.line} is out of range (file has ${lines.length} lines)`)
			}

			const highlightedText = input.highlightedText ?? lines[input.line - 1] ?? ``
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
			const now = new Date().toISOString()

			const comment: Comment = {
				id,
				filePath: input.filePath,
				highlightedText,
				highlightedTextLineNumber: input.line,
				contentText: input.comment,
				replyToCommentId: null,
				createdBy: `agent`,
				createdAt: now,
				isResolved: false,
				isDeleted: false,
			}

			const event = commentStateSchema.comments.insert({ key: id, value: comment })
			await comments.stream.append(JSON.stringify(event))

			return JSON.stringify({
				id,
				path: input.filePath,
				line: input.line,
				highlighted_text: highlightedText,
				comment: input.comment,
			})
		},
	})
}
