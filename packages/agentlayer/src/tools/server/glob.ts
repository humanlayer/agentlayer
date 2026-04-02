import { GlobTool } from '../interfaces/glob'
import DESCRIPTION from './glob.txt'

const MAX_RESULTS = 100

export function createGlobTool(opts?: { cwd?: string; disallowSymlinks?: boolean }) {
	return GlobTool.define(
		async (input) => {
			const cwd = input.path ?? opts?.cwd ?? process.cwd()
			const glob = new Bun.Glob(input.pattern)

			const withMtime: Array<{ path: string; mtime: number }> = []
			for await (const path of glob.scan({
				cwd,
				absolute: true,
				onlyFiles: true,
				followSymlinks: !(opts?.disallowSymlinks ?? false),
			})) {
				try {
					const stat = await Bun.file(path).stat()
					withMtime.push({ path, mtime: stat.mtime.getTime() })
				} catch {
					withMtime.push({ path, mtime: 0 })
				}
			}

			// Sort by mtime descending (most recently modified first)
			withMtime.sort((a, b) => b.mtime - a.mtime)

			return withMtime.slice(0, MAX_RESULTS).map((f) => f.path)
		},
		{ description: DESCRIPTION },
	)
}
