import { BashTool } from '@humanlayer/agentlayer-core/interfaces'
import { truncateOutput } from '@humanlayer/agentlayer-core/utils'
import type { Bash } from 'just-bash'
import DESCRIPTION from './bash.txt'

export function createJustBashTool(bash: Bash) {
	return BashTool.define(
		async (input) => {
			const result = await bash.exec(input.command, {
				...(input.workdir ? { cwd: input.workdir } : {}),
			})
			let output = result.stdout
			if (result.stderr) {
				output += `\nSTDERR: ${result.stderr}`
			}
			return truncateOutput(`Exit code: ${result.exitCode}\n${output}`)
		},
		{ description: DESCRIPTION },
	)
}
