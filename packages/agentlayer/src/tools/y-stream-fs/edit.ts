import type { EditResult, YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { EditTool } from '../interfaces/edit'
import DESCRIPTION from './edit.txt'

export function createYStreamFsEditTool(fs: YjsStreamFS) {
	return EditTool.define(
		async (input) => {
			const content = fs.readFile(input.filePath)
			if (!content.includes(input.oldString)) {
				return { content, matchCount: 0 }
			}

			if (input.replaceAll) {
				// Count matches before editing
				let count = 0
				let pos = 0
				while (true) {
					const idx = content.indexOf(input.oldString, pos)
					if (idx === -1) break
					count++
					pos = idx + input.oldString.length
				}
				// Apply all replacements via successive Y.js operations
				// (each pass does a single replacement at the first occurrence)
				for (let i = 0; i < count; i++) {
					// Re-read after each edit since content shifts
					const current = fs.readFile(input.filePath)
					const idx = current.indexOf(input.oldString)
					if (idx === -1) break
					const subdoc = (fs.doc.getMap('files') as any).get(input.filePath)
					const ytext = subdoc.getText('content')
					subdoc.transact(() => {
						ytext.delete(idx, input.oldString.length)
						ytext.insert(idx, input.newString)
					})
				}
				return { content: fs.readFile(input.filePath), matchCount: count }
			}

			const editResult: EditResult = fs.editFile(input.filePath, input.oldString, input.newString)
			return { content: fs.readFile(input.filePath), matchCount: 1, editResult }
		},
		{ description: DESCRIPTION },
	)
}
