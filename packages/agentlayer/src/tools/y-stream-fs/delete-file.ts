import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { DeleteFileTool } from '../interfaces/delete-file'
import DESCRIPTION from './delete-file.txt'

export function createYStreamFsDeleteFileTool(fs: YjsStreamFS) {
	return DeleteFileTool.define(
		async (input) => {
			fs.deleteFile(input.filePath)
			return `Deleted ${input.filePath}`
		},
		{ description: DESCRIPTION },
	)
}
