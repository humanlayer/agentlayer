import type { Bash } from 'just-bash'
import { ReadTool } from '../interfaces/read'
import DESCRIPTION from '../server/read.txt'

export function createJustBashReadTool(bash: Bash) {
	return ReadTool.define(
		async (input) => {
			const result = await bash.exec(`cat "${input.filePath}"`)
			if (result.exitCode !== 0) {
				throw new Error(`File not found: ${input.filePath}`)
			}
			return result.stdout
		},
		{ description: DESCRIPTION },
	)
}
