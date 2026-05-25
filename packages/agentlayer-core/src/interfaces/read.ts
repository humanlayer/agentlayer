import * as z from 'zod'
import { defineToolInterface } from '../define-tool'

export const readInput = z.object({
	file_path: z.string().describe('Path to the file to read'),
	offset: z.number().optional().describe('Line number to start from (1-indexed)'),
	limit: z.number().optional().describe('Max lines to read').default(2000),
})

export type ReadInput = z.infer<typeof readInput>

export const ReadTool = defineToolInterface<ReadInput, string>({
	name: 'read',
	description: 'Read a file with line numbers',
	input: readInput,
	output: z.string(),
	serialize: (raw: string, input: ReadInput) => {
		const lines = raw.split('\n')
		const offset = input.offset ?? 1
		const limit = input.limit ?? 2000
		const slice = lines.slice(offset - 1, offset - 1 + limit)
		const totalLines = lines.length

		// Right-aligned line numbers with arrow separator (matching Claude Code style)
		const width = String(offset + slice.length - 1).length
		const numbered = slice
			.map((line, i) => {
				const lineNum = String(offset + i).padStart(width, ' ')
				return `${lineNum}→${line}`
			})
			.join('\n')

		if (slice.length < totalLines) {
			return `${numbered}\n\n(Showing lines ${offset}-${offset + slice.length - 1} of ${totalLines}. Use offset=${offset + slice.length} to continue.)`
		}
		return `${numbered}\n\n(End of file - total ${totalLines} lines)`
	},
})
