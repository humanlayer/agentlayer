import { readFile, stat, writeFile } from 'node:fs/promises'
import { EditTool } from '@humanlayer/agentlayer-core/interfaces'
import { EDIT_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { expandPath } from '../utils/expand-path'

export interface EditToolOptions {
	cwd?: string
}

export function createEditTool(opts: EditToolOptions = {}) {
	const { cwd } = opts

	return EditTool.define(
		async (input) => {
			const filePath = expandPath(input.file_path, cwd)

			let fileStat: Awaited<ReturnType<typeof stat>>
			try {
				fileStat = await stat(filePath)
			} catch {
				throw new Error(`File ${input.file_path} not found`)
			}

			if (fileStat.isDirectory()) {
				throw new Error(`Path is a directory, not a file: ${input.file_path}`)
			}

			const content = await readFile(filePath, 'utf8')

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
				const firstIdx = content.indexOf(input.old_string)
				const lastIdx = content.lastIndexOf(input.old_string)
				if (firstIdx !== lastIdx) {
					throw new Error(
						'Found multiple matches for oldString. Provide more surrounding context to make the match unique.',
					)
				}
				updated = content.replace(input.old_string, input.new_string)
				matchCount = 1
			}

			await writeFile(filePath, updated)
			return { content: updated, matchCount }
		},
		{ description: EDIT_DESCRIPTION },
	)
}
