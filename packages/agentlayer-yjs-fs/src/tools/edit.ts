import { EditTool, normalizeEscapes } from '@humanlayer/agentlayer-core/interfaces'
import { EDIT_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { EditResult, YjsFilesystem } from '@humanlayer/yjs-fs'

function countMatches(content: string, needle: string): number {
	let count = 0
	let position = 0
	while (true) {
		const index = content.indexOf(needle, position)
		if (index === -1) return count
		count++
		position = index + needle.length
	}
}

function lineForIndex(content: string, index: number): number {
	return content.slice(0, index).split('\n').length
}

function editResultForReplacement(path: string, content: string, index: number, newText: string): EditResult {
	const editLine = lineForIndex(content, index)
	return {
		path,
		editIndex: index,
		editLine,
		affectedLines: {
			start: editLine,
			end: editLine + newText.split('\n').length - 1,
		},
	}
}

export function createYjsFsEditTool(fs: YjsFilesystem) {
	return EditTool.define(
		async (input) => {
			const oldString = normalizeEscapes(input.old_string)
			const newString = normalizeEscapes(input.new_string)
			const content = fs.readFile(input.file_path)
			const matchCount = countMatches(content, oldString)

			if (matchCount === 0) {
				return { content, matchCount }
			}

			if (input.replace_all) {
				const firstIndex = content.indexOf(oldString)
				const updated = content.split(oldString).join(newString)
				fs.writeFile(input.file_path, updated)
				return {
					content: updated,
					matchCount,
					editResult: editResultForReplacement(input.file_path, content, firstIndex, newString),
				}
			}

			const editResult = fs.editFile(input.file_path, oldString, newString)
			return { content: fs.readFile(input.file_path), matchCount: 1, editResult }
		},
		{ description: EDIT_DESCRIPTION },
	)
}
