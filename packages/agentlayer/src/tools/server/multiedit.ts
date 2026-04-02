import { expandPath } from '../../util/expand-path'
import type { EditOutput } from '../interfaces/edit'
import { MultiEditTool } from '../interfaces/multiedit'
import { createEditTool } from './edit'
import DESCRIPTION from './multiedit.txt'

export function createMultiEditTool() {
	const editTool = createEditTool()

	return MultiEditTool.define(
		async (input, ctx) => {
			const filePath = expandPath(input.filePath)

			for (const [i, edit] of input.edits.entries()) {
				const result = await editTool.execute(
					{
						filePath,
						oldString: edit.oldString,
						newString: edit.newString,
						replaceAll: edit.replaceAll,
					},
					ctx,
				)

				// Check if edit failed to find a match
				if (result && typeof result === 'object' && 'matchCount' in result) {
					const editResult = result as EditOutput
					if (editResult.matchCount === 0) {
						throw new Error(
							`Edit ${i + 1} failed: could not find oldString in ${input.filePath}. Make sure it matches the file content exactly.`,
						)
					}
				}
			}

			return `Applied ${input.edits.length} edit(s) to ${input.filePath}`
		},
		{ description: DESCRIPTION },
	)
}
