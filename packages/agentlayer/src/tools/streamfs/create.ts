import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import DESCRIPTION from './create.txt'

const input = z.object({
	filePath: z.string().describe('Path for the new file (e.g., "/src/main.ts")'),
	content: z.string().describe('Initial content for the file'),
	mimeType: z.string().optional().describe('MIME type (auto-detected from extension if omitted)'),
})

export function createStreamFsCreateTool(fs: StreamFilesystem) {
	return defineTool({
		name: 'create',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			await fs.createFile(input.filePath, input.content, {
				mimeType: input.mimeType,
			})
			return `Created ${input.filePath}`
		},
	})
}
