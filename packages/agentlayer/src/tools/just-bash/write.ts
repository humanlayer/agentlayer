import type { Bash } from 'just-bash'
import { WriteTool } from '../interfaces/write'
import DESCRIPTION from '../server/write.txt'

export function createWriteTool(bash: Bash) {
	return WriteTool.define(
		async (input) => {
			// Ensure parent directory exists
			const dirResult = await bash.exec(`mkdir -p "$(dirname "${input.filePath}")"`)
			if (dirResult.exitCode !== 0) {
				throw new Error(`Failed to create parent directory for ${input.filePath}: ${dirResult.stderr}`)
			}

			// Write content using a heredoc to handle special characters safely
			// We use a unique delimiter to avoid conflicts with content
			const DELIM = 'WRITEOF_8f3a2b1c'
			const writeResult = await bash.exec(`cat > "${input.filePath}" <<'${DELIM}'\n${input.content}\n${DELIM}`)
			if (writeResult.exitCode !== 0) {
				throw new Error(`Failed to write file ${input.filePath}: ${writeResult.stderr}`)
			}

			return `Successfully wrote to ${input.filePath}`
		},
		{ description: DESCRIPTION },
	)
}
