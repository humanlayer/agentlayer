import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const multiEditInput = z.object({
	filePath: z.string().describe('Path to the file'),
	edits: z
		.array(
			z.object({
				oldString: z.string().describe('The exact string to find'),
				newString: z.string().describe('The replacement string'),
				replaceAll: z.boolean().optional().describe('Replace all occurrences').default(false),
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
