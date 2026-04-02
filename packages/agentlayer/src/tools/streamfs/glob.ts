import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { GlobTool } from '../interfaces/glob'
import DESCRIPTION from './glob.txt'

/**
 * Minimal glob matching — supports *, **, and ? wildcards.
 * Converts a glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
	let re = ''
	let i = 0
	while (i < pattern.length) {
		const ch = pattern[i]
		if (ch === '*' && pattern[i + 1] === '*') {
			// ** matches any number of path segments
			re += '.*'
			i += 2
			if (pattern[i] === '/') i++ // skip trailing /
		} else if (ch === '*') {
			// * matches anything except /
			re += '[^/]*'
			i++
		} else if (ch === '?') {
			re += '[^/]'
			i++
		} else if (ch === '.') {
			re += '\\.'
			i++
		} else {
			re += ch
			i++
		}
	}
	return new RegExp(`^${re}$`)
}

export function createStreamFsGlobTool(fs: StreamFilesystem) {
	return GlobTool.define(
		async (input) => {
			const rootPath = input.path ?? '/'
			const regex = globToRegex(input.pattern)
			const matches: string[] = []

			function walk(dirPath: string): void {
				const children = fs.list(dirPath)
				for (const child of children) {
					const childPath = dirPath === '/' ? `/${child.name}` : `${dirPath}/${child.name}`
					if (child.type === 'file' && regex.test(childPath)) {
						matches.push(childPath)
					}
					if (child.type === 'directory') {
						if (regex.test(childPath)) {
							matches.push(childPath)
						}
						walk(childPath)
					}
				}
			}

			walk(rootPath)
			matches.sort()
			return matches
		},
		{ description: DESCRIPTION },
	)
}
