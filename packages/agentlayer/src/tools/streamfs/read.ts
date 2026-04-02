import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import { ReadTool } from '../interfaces/read'
import DESCRIPTION from './read.txt'

export function createStreamFsReadTool(fs: StreamFilesystem) {
	return ReadTool.define(
		async (input) => {
			return await fs.readTextFile(input.filePath)
		},
		{ description: DESCRIPTION },
	)
}
