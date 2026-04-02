import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import type { CommentsContext } from './comments-context'
import DESCRIPTION from './read-comments.txt'

const input = z.object({
	filePath: z.string().describe('The path to the file to read comments for (e.g., "/src/main.ts")'),
})

export function createStreamFsReadCommentsTool(fs: StreamFilesystem, comments: CommentsContext) {
	return defineTool({
		name: 'read_comments',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			const allComments = comments.readComments()
			const fileComments = allComments.filter((c) => c.filePath === input.filePath && !c.isDeleted)

			if (fileComments.length === 0) {
				return `No comments on ${input.filePath}`
			}

			const content = await fs.readTextFile(input.filePath)
			const lines = content.split(`\n`)

			const rootComments = fileComments.filter((c) => !c.replyToCommentId)
			const replies = fileComments.filter((c) => c.replyToCommentId)

			const formatted = rootComments
				.map((c) => {
					let anchoredLine = c.highlightedTextLineNumber
					if (c.highlightedText) {
						const idx = content.indexOf(c.highlightedText)
						if (idx !== -1) {
							anchoredLine = content.slice(0, idx).split(`\n`).length
						}
					}

					const contextLines: string[] = []
					const startLine = Math.max(1, anchoredLine - 1)
					const endLine = Math.min(lines.length, anchoredLine + 1)
					for (let i = startLine; i <= endLine; i++) {
						const marker = i === anchoredLine ? `>` : ` `
						contextLines.push(`${marker} ${String(i).padStart(4)} | ${lines[i - 1]}`)
					}

					const threadReplies = replies
						.filter((r) => r.replyToCommentId === c.id)
						.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
						.map((r) => `    [${r.id}] ${r.createdBy}: ${r.contentText}`)

					const replySection = threadReplies.length > 0 ? `\n  Replies:\n${threadReplies.join(`\n`)}` : ``
					const resolvedTag = c.isResolved ? ` [RESOLVED]` : ``

					return `${contextLines.join(`\n`)}\n  [${c.id}] ${c.createdBy}${resolvedTag}: ${c.contentText}${replySection}`
				})
				.join(`\n\n`)

			return `${input.filePath} (${rootComments.length} comments):\n\n${formatted}`
		},
	})
}
