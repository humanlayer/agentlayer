import type { Bash } from 'just-bash'
import { EditTool } from '../interfaces/edit'
import DESCRIPTION from '../server/edit.txt'

export function createEditTool(bash: Bash) {
	return EditTool.define(
		async (input) => {
			// Read the file content
			const catResult = await bash.exec(`cat "${input.filePath}"`)
			if (catResult.exitCode !== 0) {
				throw new Error(`File ${input.filePath} not found`)
			}

			const content = catResult.stdout

			if (!content.includes(input.oldString)) {
				return { content, matchCount: 0 }
			}

			let updated: string
			let matchCount: number

			if (input.replaceAll) {
				let count = 0
				let pos = 0
				while (true) {
					const idx = content.indexOf(input.oldString, pos)
					if (idx === -1) break
					count++
					pos = idx + input.oldString.length
				}
				updated = content.split(input.oldString).join(input.newString)
				matchCount = count
			} else {
				// Single replacement — check for multiple matches
				const firstIdx = content.indexOf(input.oldString)
				const lastIdx = content.lastIndexOf(input.oldString)
				if (firstIdx !== lastIdx) {
					throw new Error(
						'Found multiple matches for oldString. Provide more surrounding context to make the match unique.',
					)
				}
				updated = content.replace(input.oldString, input.newString)
				matchCount = 1
			}

			// Write the updated content back using a heredoc
			const DELIM = 'EDITEOF_8f3a2b1c'
			const writeResult = await bash.exec(`cat > "${input.filePath}" <<'${DELIM}'\n${updated}\n${DELIM}`)
			if (writeResult.exitCode !== 0) {
				throw new Error(`Failed to write file ${input.filePath}: ${writeResult.stderr}`)
			}

			return { content: updated, matchCount }
		},
		{ description: DESCRIPTION },
	)
}
