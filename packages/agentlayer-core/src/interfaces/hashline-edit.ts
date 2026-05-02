import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

export const hashlineAnchor = z.string().describe('Full hashline anchor, e.g. "160sr"')

export const hashlineEditLoc = z.union([
	z.literal('append'),
	z.literal('prepend'),
	z.object({ append: hashlineAnchor }),
	z.object({ prepend: hashlineAnchor }),
	z.object({ range: z.object({ pos: hashlineAnchor, end: hashlineAnchor }) }),
])

export const hashlineEditEntry = z.object({
	loc: hashlineEditLoc.optional(),
	content: z.union([z.array(z.string()), z.null()]).optional(),
})

export const hashlineEditInput = z.object({
	path: z.string().describe('File path for edits'),
	edits: z.array(hashlineEditEntry).describe('Edits to apply'),
})

export type HashlineEditInput = z.infer<typeof hashlineEditInput>

export const HashlineEditOutputSchema = z.object({
	content: z.string(),
	editCount: z.number(),
	firstChangedLine: z.number().optional(),
	warnings: z.array(z.string()).optional(),
	noopEdits: z
		.array(
			z.object({
				editIndex: z.number(),
				loc: z.string(),
				current: z.string(),
			}),
		)
		.optional(),
})

export type HashlineEditOutput = z.infer<typeof HashlineEditOutputSchema>

export const HashlineEditTool = defineToolInterface<HashlineEditInput, HashlineEditOutput>({
	name: 'edit',
	description: 'Edit a file using hashline anchors',
	input: hashlineEditInput,
	output: HashlineEditOutputSchema,
	serialize: (raw: HashlineEditOutput, input: HashlineEditInput) => {
		const parts = [`Successfully edited ${input.path}`]
		if (raw.firstChangedLine !== undefined) parts.push(`First changed line: ${raw.firstChangedLine}`)
		if (raw.warnings?.length) parts.push(`Warnings:\n${raw.warnings.map((warning) => `- ${warning}`).join('\n')}`)
		if (raw.noopEdits?.length) parts.push(`No-op edits: ${raw.noopEdits.length}`)
		return parts.join('\n')
	},
})
