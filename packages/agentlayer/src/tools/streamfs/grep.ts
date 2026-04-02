import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import type { GrepMatch } from '../interfaces/grep'
import { GrepTool } from '../interfaces/grep'
import DESCRIPTION from './grep.txt'

/**
 * Minimal glob matching for the include filter (e.g. "*.ts").
 */
function matchesInclude(filePath: string, include: string): boolean {
	if (include.startsWith('*.')) {
		return filePath.endsWith(include.slice(1))
	}
	return filePath.includes(include)
}

export function createStreamFsGrepTool(fs: StreamFilesystem) {
	return GrepTool.define(
		async (input) => {
			const rootPath = input.path ?? '/'
			const regex = new RegExp(input.pattern)
			const matches: GrepMatch[] = []

			// Collect all file paths
			const files: string[] = []
			function walk(dirPath: string): void {
				const children = fs.list(dirPath)
				for (const child of children) {
					const childPath = dirPath === '/' ? `/${child.name}` : `${dirPath}/${child.name}`
					if (child.type === 'file') {
						files.push(childPath)
					} else if (child.type === 'directory') {
						walk(childPath)
					}
				}
			}
			walk(rootPath)

			// Search each file
			for (const filePath of files) {
				if (input.include && !matchesInclude(filePath, input.include)) {
					continue
				}

				let content: string
				try {
					content = await fs.readTextFile(filePath)
				} catch {
					continue // skip binary / unreadable files
				}

				const lines = content.split('\n')
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]!
					if (regex.test(line)) {
						matches.push({
							file: filePath,
							line: i + 1,
							content: line,
						})
					}
				}
			}

			return matches
		},
		{ description: DESCRIPTION },
	)
}
