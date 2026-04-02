import type { Bash } from 'just-bash'
import type { ListEntry } from '../interfaces/list'
import { ListTool } from '../interfaces/list'

export function createListTool(bash: Bash) {
	return ListTool.define(async (input) => {
		const dirPath = input.path ?? '.'

		// Use ls -1F: appends '/' to directories, nothing to files
		const result = await bash.exec(`ls -1F "${dirPath}" 2>/dev/null`)

		if (result.exitCode !== 0) {
			throw new Error(`Failed to list directory ${dirPath}: ${result.stderr}`)
		}

		const ignorePatterns = new Set<string>(['node_modules', '.git', 'dist', 'build', ...(input.ignore ?? [])])

		const entries: ListEntry[] = []
		for (const raw of result.stdout.split('\n')) {
			const line = raw.trim()
			if (!line) continue

			if (line.endsWith('/')) {
				// Directory
				const name = line.slice(0, -1)
				if (ignorePatterns.has(name)) continue
				entries.push({ name, type: 'directory' })
			} else {
				// File (strip any trailing decorator: *, @, |, =, >)
				const name = line.replace(/[*@|=>]$/, '')
				if (ignorePatterns.has(name)) continue
				entries.push({ name, type: 'file' })
			}
		}

		return entries
	})
}
