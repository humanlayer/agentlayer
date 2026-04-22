import { WriteTool } from '@humanlayer/agentlayer-core'
import { WRITE_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

export function createWriteTool(bash: Bash) {
	return WriteTool.define(
		async (input) => {
			// Ensure parent directory exists
			const dirResult = await bash.exec(`mkdir -p "$(dirname "${input.file_path}")"`)
			if (dirResult.exitCode !== 0) {
				throw new Error(`Failed to create parent directory for ${input.file_path}: ${dirResult.stderr}`)
			}

			// Write content using a heredoc to handle special characters safely
			// We use a unique delimiter to avoid conflicts with content
			const DELIM = 'WRITEOF_8f3a2b1c'
			const writeResult = await bash.exec(`cat > "${input.file_path}" <<'${DELIM}'\n${input.content}\n${DELIM}`)
			if (writeResult.exitCode !== 0) {
				throw new Error(`Failed to write file ${input.file_path}: ${writeResult.stderr}`)
			}

			return `Successfully wrote to ${input.file_path}`
		},
		{ description: WRITE_DESCRIPTION },
	)
}
