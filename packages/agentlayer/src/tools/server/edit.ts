import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandPath } from '../../util/expand-path'
import { EditTool } from '../interfaces/edit'
import DESCRIPTION from './edit.txt'

export function createEditTool() {
	return EditTool.define(
		async (input) => {
			const filePath = expandPath(input.filePath)

			let file: ReturnType<typeof Bun.file>
			try {
				file = Bun.file(filePath)
			} catch {
				throw new Error(`File ${input.filePath} not found`)
			}

			if (!(await file.exists())) {
				throw new Error(`File ${input.filePath} not found`)
			}

			const stat = await file.stat()
			if (stat.isDirectory()) {
				throw new Error(`Path is a directory, not a file: ${input.filePath}`)
			}

			const content = await file.text()

			if (!content.includes(input.oldString)) {
				return { content, matchCount: 0 }
			}

			let updated: string
			let matchCount: number

			if (input.replaceAll) {
				// Count occurrences
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

			await mkdir(dirname(filePath), { recursive: true })
			await Bun.write(filePath, updated)

			return { content: updated, matchCount }
		},
		{ description: DESCRIPTION },
	)
}
