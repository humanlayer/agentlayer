import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { ReadTool } from '../interfaces/read'
import DESCRIPTION from './read.txt'

export function createYStreamFsReadTool(fs: YjsStreamFS) {
	return ReadTool.define(
		async (input) => {
			return fs.readFile(input.filePath)
		},
		{ description: DESCRIPTION },
	)
}
