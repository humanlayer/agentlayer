import { z } from 'zod'
import { defineToolInterface } from '../define-tool'
import { formatHashLine } from '../utils/line-hash'

export const hashReadInput = z.object({
	file_path: z.string().describe('Path to the file to read'),
	offset: z.number().optional().describe('Line number to start from (1-indexed)'),
	limit: z.number().optional().describe('Max lines to read').default(2000),
})

export type HashReadInput = z.infer<typeof hashReadInput>

export const HashReadTool = defineToolInterface<HashReadInput, string>({
	name: 'read',
	description: 'Read a file with hashline anchors',
	input: hashReadInput,
	output: z.string(),
	serialize: (raw: string, input: HashReadInput) => {
		const lines = raw.split('\n')
		const offset = input.offset ?? 1
		const limit = input.limit ?? 2000
		const slice = lines.slice(offset - 1, offset - 1 + limit)
		const totalLines = lines.length
		const numbered = slice.map((line, i) => formatHashLine(offset + i, line)).join('\n')

		if (offset - 1 + slice.length < totalLines) {
			return `${numbered}\n\n(Showing lines ${offset}-${offset + slice.length - 1} of ${totalLines}. Use offset=${offset + slice.length} to continue.)`
		}
		return `${numbered}\n\n(End of file - total ${totalLines} lines)`
	},
})
