import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ListEntry } from '../interfaces/list'
import { ListTool } from '../interfaces/list'
import DESCRIPTION from './list.txt'

const DEFAULT_IGNORE = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.venv',
	'__pycache__',
	'.cache',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'coverage',
	'.turbo',
	'.yarn',
	'node_modules/',
	'__pycache__/',
	'.git/',
	'dist/',
	'build/',
	'target/',
	'vendor/',
	'bin/',
	'obj/',
	'.idea/',
	'.vscode/',
	'.zig-cache/',
	'zig-out',
	'.coverage',
	'coverage/',
	'vendor/',
	'tmp/',
	'temp/',
	'.cache/',
	'cache/',
	'logs/',
	'.venv/',
	'venv/',
	'env/',
])

export function createListTool(opts?: { cwd?: string }) {
	return ListTool.define(
		async (input) => {
			const dirPath = input.path ?? opts?.cwd ?? process.cwd()

			// Combine default ignore patterns with user-supplied ones
			const ignoreSet = new Set(DEFAULT_IGNORE)
			if (input.ignore) {
				for (const pattern of input.ignore) {
					ignoreSet.add(pattern)
				}
			}

			const entries = await readdir(dirPath, { withFileTypes: true })
			const result: ListEntry[] = []

			for (const entry of entries) {
				// Skip ignored names
				if (ignoreSet.has(entry.name)) continue
				// Skip dotfiles (except the ones explicitly not ignored)
				if (entry.name.startsWith('.') && !entry.isDirectory()) continue

				const fullPath = join(dirPath, entry.name)

				if (entry.isDirectory()) {
					result.push({ name: fullPath, type: 'directory' })
				} else if (entry.isSymbolicLink()) {
					// stat() follows the link — resolve the actual type of the target.
					// Dangling symlinks (stat throws) surface as 'file' so they are not lost.
					try {
						const s = await stat(fullPath)
						result.push({ name: fullPath, type: s.isDirectory() ? 'directory' : 'file' })
					} catch {
						result.push({ name: fullPath, type: 'file' })
					}
				} else if (entry.isFile()) {
					result.push({ name: fullPath, type: 'file' })
				}
			}

			return result
		},
		{ description: DESCRIPTION },
	)
}
