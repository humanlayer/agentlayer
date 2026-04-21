import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

export const listInput = z.object({
	path: z.string().optional().describe('Directory to list (defaults to cwd)'),
	ignore: z.array(z.string()).optional().describe('Additional patterns to ignore'),
})

export type ListInput = z.infer<typeof listInput>

export interface ListEntry {
	name: string
	type: 'file' | 'directory'
}

export const ListEntrySchema = z.object({
	name: z.string(),
	type: z.enum(['file', 'directory']),
})

export const ListTool = defineToolInterface<ListInput, ListEntry[]>({
	name: 'list',
	description: 'List directory contents',
	input: listInput,
	output: z.array(ListEntrySchema),
	serialize: (entries: ListEntry[]) => {
		if (entries.length === 0) {
			return 'Directory is empty.'
		}
		return entries.map((e) => `${e.type === 'directory' ? '📁' : '  '} ${e.name}`).join('\n')
	},
})
