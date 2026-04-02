import type { Bash } from 'just-bash'
import { truncateOutput } from '../../util/truncate'
import { BashTool } from '../interfaces/bash'
import DESCRIPTION from '../server/bash.txt'

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
