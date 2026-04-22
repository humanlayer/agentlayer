import type { GrepMatch } from '@humanlayer/agentlayer-core/interfaces'
import { GrepTool } from '@humanlayer/agentlayer-core/interfaces'
import { GREP_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

const MAX_MATCHES = 100

export function createGrepTool(bash: Bash) {
	return GrepTool.define(
		async (input) => {
			const searchPath = input.path ?? '.'
			let cmd = `rg -nH --hidden --no-messages --regexp "${input.pattern}"`
			if (input.include) {
				cmd += ` --glob "${input.include}"`
			}
			cmd += ` "${searchPath}"`

			const result = await bash.exec(cmd)

			// Exit code 1 = no matches
			if (result.exitCode === 1) {
				return []
			}

			if (result.exitCode !== 0) {
				throw new Error(`grep failed with exit code ${result.exitCode}: ${result.stderr}`)
			}

			// Parse `file:line:content` output lines
			const matches: GrepMatch[] = []
			for (const line of result.stdout.split('\n')) {
				if (!line) continue
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

				if (matches.length >= MAX_MATCHES) break
			}

			return matches
		},
		{ description: GREP_DESCRIPTION },
	)
}
