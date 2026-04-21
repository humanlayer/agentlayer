import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import type { Bash } from 'just-bash'
import DESCRIPTION from './read.txt'

export function createJustBashReadTool(bash: Bash) {
	return ReadTool.define(
		async (input) => {
			const result = await bash.exec(`cat "${input.file_path}"`)
			if (result.exitCode !== 0) {
				throw new Error(`File not found: ${input.file_path}`)
			}
			return result.stdout
		},
		{ description: DESCRIPTION },
	)
}
