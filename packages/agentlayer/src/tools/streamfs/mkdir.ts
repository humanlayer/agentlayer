import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import DESCRIPTION from './mkdir.txt'

const input = z.object({
	path: z.string().describe('Path for the new directory (e.g., "/src/components")'),
})

export function createStreamFsMkdirTool(fs: StreamFilesystem) {
	return defineTool({
		name: 'mkdir',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			await fs.mkdir(input.path)
			return `Created directory ${input.path}`
		},
	})
}
