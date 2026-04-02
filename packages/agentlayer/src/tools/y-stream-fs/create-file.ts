import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { CreateFileTool } from '../interfaces/create-file'
import DESCRIPTION from './create-file.txt'

export function createYStreamFsCreateFileTool(fs: YjsStreamFS) {
	return CreateFileTool.define(
		async (input) => {
			fs.createFile(input.filePath, input.content)
			return `Created ${input.filePath}`
		},
		{ description: DESCRIPTION },
	)
}
