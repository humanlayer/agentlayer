import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const writeInput = z.object({
	filePath: z.string().describe('Path to the file to write'),
	content: z.string().describe('The content to write to the file'),
})

export type WriteInput = z.infer<typeof writeInput>

export const WriteTool = defineToolInterface({
	name: 'write',
	description: 'Write content to a file, creating it if it does not exist',
	input: writeInput,
})
