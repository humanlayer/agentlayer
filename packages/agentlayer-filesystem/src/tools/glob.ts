import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, matchesGlob, relative } from 'node:path'
import { GlobTool } from '@humanlayer/agentlayer-core/interfaces'
import { GLOB_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'

const MAX_RESULTS = 100

async function walkMatchingFiles(
	dir: string,
	root: string,
	pattern: string,
	followSymlinks: boolean,
	visited: Set<string> = new Set(),
): Promise<string[]> {
	const realDir = await realpath(dir).catch(() => dir)
	if (visited.has(realDir)) {
		return []
	}
	visited.add(realDir)

	const entries = await readdir(dir, { withFileTypes: true })
	const files: string[] = []

	for (const entry of entries) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await walkMatchingFiles(fullPath, root, pattern, followSymlinks, visited)))
			continue
		}

		if (entry.isSymbolicLink()) {
			if (!followSymlinks) {
				continue
			}

			try {
				const target = await stat(fullPath)
				if (target.isDirectory()) {
					files.push(...(await walkMatchingFiles(fullPath, root, pattern, followSymlinks, visited)))
					continue
				}
				if (!target.isFile()) {
					continue
				}
			} catch {
				continue
			}
		} else if (!entry.isFile()) {
			continue
		}

		const relativePath = relative(root, fullPath)
		if (matchesGlob(relativePath, pattern)) {
			files.push(fullPath)
		}
	}

	return files
}

export function createGlobTool(opts?: { cwd?: string; disallowSymlinks?: boolean }) {
	return GlobTool.define(
		async (input) => {
			const cwd = input.path ?? opts?.cwd ?? process.cwd()
			const rootStat = await stat(cwd).catch(() => undefined)
			if (!rootStat) {
				return []
			}

			if (rootStat.isFile()) {
				return matchesGlob(basename(cwd), input.pattern) ? [cwd] : []
			}

			const matches = await walkMatchingFiles(
				cwd,
				cwd,
				input.pattern,
				!(opts?.disallowSymlinks ?? false),
			)

			const withMtime: Array<{ path: string; mtime: number }> = []
			for (const path of matches) {
				try {
					const fileStat = await stat(path)
					withMtime.push({ path, mtime: fileStat.mtime.getTime() })
				} catch {
					withMtime.push({ path, mtime: 0 })
				}
			}

			withMtime.sort((a, b) => b.mtime - a.mtime)
			return withMtime.slice(0, MAX_RESULTS).map((f) => f.path)
		},
		{ description: GLOB_DESCRIPTION },
	)
}
