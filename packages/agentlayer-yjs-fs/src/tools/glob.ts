import { GlobTool } from '@humanlayer/agentlayer-core/interfaces'
import { GLOB_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { flattenTree, matchGlob } from '../utils/tree'

const MAX_RESULTS = 100

function pathIsWithin(path: string, root: string): boolean {
	const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
	return normalizedRoot === '/' || path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
}

export function createYjsFsGlobTool(fs: YjsFilesystem) {
	return GlobTool.define(
		async (input) => {
			const root = input.path ?? '/'
			const stat = fs.stat(root)
			const paths = stat.isFile ? [stat.path] : flattenTree(fs.tree(root), { filesOnly: true })

			return paths
				.filter((path) => pathIsWithin(path, root))
				.filter((path) => matchGlob(path, input.pattern))
				.sort()
				.slice(0, MAX_RESULTS)
		},
		{ description: GLOB_DESCRIPTION },
	)
}
