import type { EditOutput } from '@humanlayer/agentlayer-core/interfaces'
import { MultiEditTool } from '@humanlayer/agentlayer-core/interfaces'
import { expandPath } from '../utils/expand-path'
import { createEditTool } from './edit'
import DESCRIPTION from './multiedit.txt'

export interface MultiEditToolOptions {
	cwd?: string
}

export function createMultiEditTool(opts: MultiEditToolOptions = {}) {
	const { cwd } = opts
	const editTool = createEditTool({ cwd })

	return MultiEditTool.define(
		async (input, ctx) => {
			const filePath = expandPath(input.file_path, cwd)

			for (const [i, edit] of input.edits.entries()) {
				const result = await editTool.execute(
					{
						file_path: filePath,
						old_string: edit.old_string,
						new_string: edit.new_string,
						replace_all: edit.replace_all,
					},
					ctx,
				)

				// Check if edit failed to find a match
				if (result && typeof result === 'object' && 'matchCount' in result) {
					const editResult = result as EditOutput
					if (editResult.matchCount === 0) {
						throw new Error(
							`Edit ${i + 1} failed: could not find old_string in ${input.file_path}. Make sure it matches the file content exactly.`,
						)
					}
				}
			}

			return `Applied ${input.edits.length} edit(s) to ${input.file_path}`
		},
		{ description: DESCRIPTION },
	)
}
