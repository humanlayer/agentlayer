import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import { READ_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'

export function createYjsFsReadTool(fs: YjsFilesystem) {
	return ReadTool.define(
		async (input) => {
			return fs.readFile(input.file_path)
		},
		{ description: READ_DESCRIPTION },
	)
}
