import z from 'zod'
import { defineToolInterface } from '../define-tool'

export const editInput = z.object({
	file_path: z.string().describe('Path to the file to edit'),
	old_string: z.string().describe('The exact string to find and replace'),
	new_string: z.string().describe('The replacement string'),
	replace_all: z.boolean().optional().describe('Replace all occurrences').default(false),
})

export type EditInput = z.infer<typeof editInput>

/** Normalize common escape character confusions from LLMs */
export function normalizeEscapes(s: string): string {
	return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

export const EditOutputSchema = z.object({
	content: z.string(),
	matchCount: z.number(),
	/** Optional position metadata from the underlying file operation. Passed through to postToolUse hooks as rawOutput. */
	editResult: z.unknown().optional(),
})

export type EditOutput = z.infer<typeof EditOutputSchema>

export const EditTool = defineToolInterface<EditInput, EditOutput>({
	name: 'edit',
	description: 'Edit a file by replacing an exact string match',
	input: editInput,
	output: EditOutputSchema,
	serialize: (raw: EditOutput, input: EditInput) => {
		if (raw.matchCount === 0) {
			return `Error: Could not find a match for the provided old_string in ${input.file_path}. Make sure your old_string matches the file content exactly. Use the read tool to verify.`
		}
		return `Successfully edited ${input.file_path}`
	},
})
