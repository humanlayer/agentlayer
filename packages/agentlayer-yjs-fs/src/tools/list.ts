import type { ListEntry } from '@humanlayer/agentlayer-core/interfaces'
import { ListTool } from '@humanlayer/agentlayer-core/interfaces'
import { LIST_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { matchGlob } from '../utils/tree'

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.cache', 'coverage'])

function shouldIgnore(name: string, path: string, ignore: Set<string>): boolean {
	if (ignore.has(name) || ignore.has(`${name}/`)) return true
	for (const pattern of ignore) {
		if (matchGlob(path, pattern) || matchGlob(name, pattern)) return true
	}
	return false
}

export function createYjsFsListTool(fs: YjsFilesystem) {
	return ListTool.define(
		async (input) => {
			const dirPath = input.path ?? '/'
			const ignore = new Set(DEFAULT_IGNORE)
			for (const pattern of input.ignore ?? []) {
				ignore.add(pattern)
			}

			const entries: ListEntry[] = []
			for (const entry of fs.list(dirPath)) {
				if (shouldIgnore(entry.name, entry.path, ignore)) continue
				entries.push({ name: entry.path, type: entry.type })
			}

			return entries.sort((a, b) => a.name.localeCompare(b.name))
		},
		{ description: LIST_DESCRIPTION },
	)
}
