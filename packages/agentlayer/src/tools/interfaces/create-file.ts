import { z } from 'zod'
import { defineToolInterface } from '../../core/define-tool'

export const createFileInput = z.object({
	filePath: z.string().describe('Path for the new file'),
	content: z.string().describe('Initial file content'),
})

export type CreateFileInput = z.infer<typeof createFileInput>

export const CreateFileTool = defineToolInterface<CreateFileInput, string>({
	name: 'create_file',
	description: 'Create a new file with the given content',
	input: createFileInput,
	serialize: (raw: string) => raw,
})
