import { EditTool } from '@humanlayer/agentlayer-core/interfaces'
import { EDIT_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { Bash } from 'just-bash'

export function createEditTool(bash: Bash) {
	return EditTool.define(
		async (input) => {
			// Read the file content
			const catResult = await bash.exec(`cat "${input.file_path}"`)
			if (catResult.exitCode !== 0) {
				throw new Error(`File ${input.file_path} not found`)
			}

			const content = catResult.stdout

			if (!content.includes(input.old_string)) {
				return { content, matchCount: 0 }
			}

			let updated: string
			let matchCount: number

			if (input.replace_all) {
				let count = 0
				let pos = 0
				while (true) {
					const idx = content.indexOf(input.old_string, pos)
					if (idx === -1) break
					count++
					pos = idx + input.old_string.length
				}
				updated = content.split(input.old_string).join(input.new_string)
				matchCount = count
			} else {
				// Single replacement — check for multiple matches
				const firstIdx = content.indexOf(input.old_string)
				const lastIdx = content.lastIndexOf(input.old_string)
				if (firstIdx !== lastIdx) {
					throw new Error(
						'Found multiple matches for old_string. Provide more surrounding context to make the match unique.',
					)
				}
				updated = content.replace(input.old_string, input.new_string)
				matchCount = 1
			}

			// Write the updated content back using a heredoc
			const DELIM = 'EDITEOF_8f3a2b1c'
			const writeResult = await bash.exec(`cat > "${input.file_path}" <<'${DELIM}'\n${updated}\n${DELIM}`)
			if (writeResult.exitCode !== 0) {
				throw new Error(`Failed to write file ${input.file_path}: ${writeResult.stderr}`)
			}

			return { content: updated, matchCount }
		},
		{ description: EDIT_DESCRIPTION },
	)
}
