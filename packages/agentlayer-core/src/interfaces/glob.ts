import z from 'zod'
import { defineToolInterface } from '../define-tool'

export const globInput = z.object({
	pattern: z.string().describe("Glob pattern to match files (e.g. '**/*.ts')"),
	path: z.string().optional().describe('Directory to search in (defaults to cwd)'),
})

export type GlobInput = z.infer<typeof globInput>

export const GlobTool = defineToolInterface<GlobInput, string[]>({
	name: 'glob',
	description: 'Find files matching a glob pattern',
	input: globInput,
	output: z.array(z.string()),
	serialize: (files: string[]) => {
		if (files.length === 0) {
			return 'No files matched the pattern.'
		}
		return files.join('\n')
	},
})
