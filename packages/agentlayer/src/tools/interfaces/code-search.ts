import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const codeSearchInput = z.object({
	query: z.string().describe('Code/documentation search query'),
	packageName: z.string().describe('Library or package name to search for'),
	language: z.string().optional().default('typescript').describe('Programming language context'),
})

export type CodeSearchInput = z.infer<typeof codeSearchInput>

export const CodeSearchTool = defineToolInterface<CodeSearchInput>({
	name: 'codesearch',
	description: 'Search code documentation and library references',
	input: codeSearchInput,
})
