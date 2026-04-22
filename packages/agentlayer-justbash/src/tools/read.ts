import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import { READ_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

export function createJustBashReadTool(bash: Bash) {
	return ReadTool.define(
		async (input) => {
			const result = await bash.exec(`cat "${input.file_path}"`)
			if (result.exitCode !== 0) {
				throw new Error(`File not found: ${input.file_path}`)
			}
			return result.stdout
		},
		{ description: READ_DESCRIPTION },
	)
}
