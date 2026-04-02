import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { EditTool } from '../interfaces/edit'
import DESCRIPTION from './edit.txt'

export function createStreamFsEditTool(fs: StreamFilesystem) {
	return EditTool.define(
		async (input) => {
			const content = await fs.readTextFile(input.filePath)

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

			await fs.writeFile(input.filePath, updated)
			return { content: updated, matchCount }
		},
		{ description: DESCRIPTION },
	)
}
