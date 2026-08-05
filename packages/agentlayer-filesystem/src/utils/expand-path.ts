import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Expand a file path: resolve `~` to home directory, then resolve relative
 * paths against `cwd` (defaults to `process.cwd()`).
 */
export function expandPath(p: string, cwd?: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) p = resolve(homedir(), p.slice(2))
	return resolve(cwd ?? process.cwd(), p)
}
