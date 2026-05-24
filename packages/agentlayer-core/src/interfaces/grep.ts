import z from 'zod'
import { defineToolInterface } from '../define-tool'

export const grepInput = z.object({
	pattern: z.string().describe('Regex pattern to search for'),
	path: z.string().optional().describe('File or directory to search in (defaults to cwd)'),
	include: z.string().optional().describe("Glob filter for files (e.g. '*.ts')"),
})

export type GrepInput = z.infer<typeof grepInput>

export interface GrepMatch {
	file: string
	line: number
	content: string
}

export const GrepMatchSchema = z.object({
	file: z.string(),
	line: z.number(),
	content: z.string(),
})

export const GrepTool = defineToolInterface<GrepInput, GrepMatch[]>({
	name: 'grep',
	description: 'Search file contents by regex pattern',
	input: grepInput,
	output: z.array(GrepMatchSchema),
	serialize: (matches: GrepMatch[]) => {
		if (matches.length === 0) {
			return 'No matches found.'
		}
		// Group by file
		const grouped = new Map<string, GrepMatch[]>()
		for (const m of matches) {
			const existing = grouped.get(m.file) ?? []
			existing.push(m)
			grouped.set(m.file, existing)
		}

		const lines: string[] = []
		for (const [file, fileMatches] of grouped) {
			lines.push(file)
			for (const m of fileMatches) {
				lines.push(`  ${m.line}: ${m.content}`)
			}
		}
		return lines.join('\n')
	},
})
