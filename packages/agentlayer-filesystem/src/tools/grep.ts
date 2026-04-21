import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GrepMatch } from '@humanlayer/agentlayer-core/interfaces'
import { GrepTool } from '@humanlayer/agentlayer-core/interfaces'
import { rgPath } from 'ripgrep'
import DESCRIPTION from './grep.txt'

const MAX_MATCHES = 100

/**
 * Walk a directory recursively and collect all file paths.
 * Symlinked files are always included. Symlinked directories are entered
 * unless disallowSymlinks is true. A visited-realpath set prevents infinite
 * loops from circular directory symlinks.
 */
async function walkFiles(dir: string, disallowSymlinks: boolean, visited: Set<string> = new Set()): Promise<string[]> {
	// Resolve the real path of this directory to detect cycles
	const real = await realpath(dir).catch(() => dir)
	if (visited.has(real)) return []
	visited.add(real)

	const entries = await readdir(dir, { withFileTypes: true })
	const files: string[] = []

	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(full, disallowSymlinks, visited)))
		} else if (entry.isSymbolicLink()) {
			if (!disallowSymlinks) {
				try {
					const s = await stat(full) // stat() follows the link
					if (s.isDirectory()) {
						files.push(...(await walkFiles(full, disallowSymlinks, visited)))
					} else if (s.isFile()) {
						files.push(full)
					}
				} catch {
					// Broken symlink — skip silently
				}
			}
		} else if (entry.isFile()) {
			files.push(full)
		}
	}
	return files
}

/**
 * Fallback grep using node:fs walk + JS regex (used when `rg` is unavailable).
 */
export async function fsGrepFallback(
	pattern: string,
	searchPath: string,
	disallowSymlinks: boolean,
	include?: string,
): Promise<GrepMatch[]> {
	const regex = new RegExp(pattern)
	let files: string[]

	const s = await stat(searchPath)
	if (s.isFile()) {
		files = [searchPath]
	} else {
		files = await walkFiles(searchPath, disallowSymlinks)
	}

	// Apply include glob filter if provided (simple suffix match)
	if (include) {
		const ext = include.replace(/^\*/, '')
		files = files.filter((f) => f.endsWith(ext))
	}

	const matches: GrepMatch[] = []
	for (const file of files) {
		let text: string
		try {
			text = await readFile(file, 'utf-8')
		} catch {
			continue
		}
		const lines = text.split('\n')
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i] ?? ''
			if (regex.test(lineText)) {
				matches.push({ file, line: i + 1, content: lineText })
				if (matches.length >= MAX_MATCHES) return matches
			}
		}
	}
	return matches
}

export function createGrepTool(opts?: { cwd?: string; disallowSymlinks?: boolean }) {
	return GrepTool.define(
		async (input) => {
			const searchPath = input.path ?? opts?.cwd ?? process.cwd()
			const disallowSymlinks = opts?.disallowSymlinks ?? false

			const args = ['-nH', '--hidden', '--regexp', input.pattern]
			if (!disallowSymlinks) {
				args.push('--follow')
			}
			if (input.include) {
				args.push('--glob', input.include)
			}
			args.push(searchPath)

			let proc: ReturnType<typeof Bun.spawn>
			try {
				proc = Bun.spawn([rgPath, ...args], {
					stdout: 'pipe',
					stderr: 'pipe',
				})
			} catch (err: unknown) {
				// rg not available — fall back to fs walk + regex
				const e = err as NodeJS.ErrnoException
				if (e.code === 'ENOENT') {
					return fsGrepFallback(input.pattern, searchPath, disallowSymlinks, input.include)
				}
				throw err
			}

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout as ReadableStream).text(),
				new Response(proc.stderr as ReadableStream).text(),
			])
			const exitCode = await proc.exited

			// Exit code 1 means no matches — return empty array
			if (exitCode === 1) {
				return []
			}

			// Non-zero (not 0 or 1) with stderr → try fallback or throw
			if (exitCode !== 0) {
				if (
					stderr.includes('command not found') ||
					stderr.includes('No such file') ||
					stderr.includes('Capabilities insufficient') || // WASM sandbox limitation
					stderr.includes('same-file is not supported') // WASM --follow limitation
				) {
					return fsGrepFallback(input.pattern, searchPath, disallowSymlinks, input.include)
				}
				throw new Error(`rg failed with exit code ${exitCode}: ${stderr}`)
			}

			// Parse `file:line:content` output lines
			const matches: GrepMatch[] = []
			for (const line of stdout.split('\n')) {
				if (!line) continue
				// rg -H outputs: filepath:linenum:content
				const colonIdx = line.indexOf(':')
				if (colonIdx === -1) continue
				const afterFile = line.indexOf(':', colonIdx + 1)
				if (afterFile === -1) continue

				const file = line.slice(0, colonIdx)
				const lineNum = Number.parseInt(line.slice(colonIdx + 1, afterFile), 10)
				const content = line.slice(afterFile + 1)

				if (!Number.isNaN(lineNum)) {
					matches.push({ file, line: lineNum, content })
				}
			}

			// Sort by mtime descending then truncate
			const withMtime: Array<{ match: GrepMatch; mtime: number }> = await Promise.all(
				matches.map(async (m) => {
					try {
						const s = await stat(m.file)
						return { match: m, mtime: s.mtimeMs }
					} catch {
						return { match: m, mtime: 0 }
					}
				}),
			)
			withMtime.sort((a, b) => b.mtime - a.mtime)

			return withMtime.slice(0, MAX_MATCHES).map((x) => x.match)
		},
		{ description: DESCRIPTION },
	)
}
