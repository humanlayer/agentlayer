import type { GrepMatch } from '@humanlayer/agentlayer-core/interfaces'
import { GrepTool } from '@humanlayer/agentlayer-core/interfaces'
import { GREP_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { flattenTree, matchGlob } from '../utils/tree'

const MAX_MATCHES = 100

export function createYjsFsGrepTool(fs: YjsFilesystem) {
	return GrepTool.define(
		async (input) => {
			const searchPath = input.path ?? '/'
			const stat = fs.stat(searchPath)
			const files = stat.isFile ? [stat.path] : flattenTree(fs.tree(searchPath), { filesOnly: true })
			const caseInsensitive = input.pattern.startsWith('(?i)')
			const regex = new RegExp(
				caseInsensitive ? input.pattern.slice(4) : input.pattern,
				caseInsensitive ? 'i' : undefined,
			)
			const matches: GrepMatch[] = []

			for (const filePath of files.sort()) {
				if (input.include && !matchGlob(filePath, input.include)) continue

				let content: string
				try {
					content = fs.readFile(filePath)
				} catch {
					continue
				}

				const lines = content.split('\n')
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i] ?? ''
					regex.lastIndex = 0
					if (regex.test(line)) {
						matches.push({ file: filePath, line: i + 1, content: line })
						if (matches.length >= MAX_MATCHES) return matches
					}
				}
			}

			return matches
		},
		{ description: GREP_DESCRIPTION },
	)
}
