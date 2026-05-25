import * as z from 'zod'
import { defineToolInterface } from '../define-tool'

export const multiEditInput = z.object({
	file_path: z.string().describe('Path to the file'),
	edits: z
		.array(
			z.object({
				old_string: z.string().describe('The exact string to find'),
				new_string: z.string().describe('The replacement string'),
				replace_all: z.boolean().optional().describe('Replace all occurrences').default(false),
			}),
		)
		.min(1)
		.describe('Edits to apply sequentially'),
})

export type MultiEditInput = z.infer<typeof multiEditInput>

export const MultiEditTool = defineToolInterface({
	name: 'multiedit',
	description: 'Apply multiple edits to a single file sequentially',
	input: multiEditInput,
})
