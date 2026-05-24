import z from 'zod'
import { defineToolInterface } from '../define-tool'

export const createFileInput = z.object({
	file_path: z.string().describe('Path for the new file'),
	content: z.string().describe('Initial file content'),
})

export type CreateFileInput = z.infer<typeof createFileInput>

export const CreateFileTool = defineToolInterface<CreateFileInput, string>({
	name: 'create_file',
	description: 'Create a new file with the given content',
	input: createFileInput,
	serialize: (raw: string) => raw,
})
