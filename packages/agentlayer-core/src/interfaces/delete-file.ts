import * as z from 'zod'
import { defineToolInterface } from '../define-tool'

export const deleteFileInput = z.object({
	file_path: z.string().describe('Path of the file to delete'),
})

export type DeleteFileInput = z.infer<typeof deleteFileInput>

export const DeleteFileTool = defineToolInterface<DeleteFileInput, string>({
	name: 'delete_file',
	description: 'Delete a file',
	input: deleteFileInput,
	serialize: (raw: string) => raw,
})
