import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { z } from 'zod'
import { defineTool } from '../../core/define-tool'
import DESCRIPTION from './tree.txt'

const input = z.object({
	path: z.string().optional().describe('Root directory to start from (defaults to "/")'),
	depth: z.number().optional().describe('Maximum depth to traverse (unlimited if omitted)'),
})

interface TreeEntry {
	path: string
	type: 'file' | 'directory'
	depth: number
}

export function createStreamFsTreeTool(fs: StreamFilesystem) {
	return defineTool<typeof input._output, string>({
		name: 'tree',
		description: DESCRIPTION,
		input,
		execute: async (input) => {
			const rootPath = input.path ?? '/'
			const maxDepth = input.depth
			const entries: TreeEntry[] = []

			function walk(dirPath: string, currentDepth: number): void {
				const children = fs.list(dirPath)
				for (const child of children) {
					const childPath = dirPath === '/' ? `/${child.name}` : `${dirPath}/${child.name}`
					entries.push({ path: childPath, type: child.type, depth: currentDepth })
					if (child.type === 'directory' && (maxDepth === undefined || currentDepth < maxDepth)) {
						walk(childPath, currentDepth + 1)
					}
				}
			}

			walk(rootPath, 1)

			if (entries.length === 0) {
				return 'Empty filesystem.'
			}

			return entries
				.map((e) => {
					const indent = '  '.repeat(e.depth - 1)
					const prefix = e.type === 'directory' ? '/' : ''
					const name = e.path.split('/').pop()
					return `${indent}${name}${prefix}`
				})
				.join('\n')
		},
	})
}
