import { dirname } from 'node:path/posix'
import { WriteTool } from '@humanlayer/agentlayer-core/interfaces'
import { WRITE_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'

function ensureParentDirectories(fs: YjsFilesystem, filePath: string): void {
	const parent = dirname(filePath)
	if (parent === '.' || parent === '/' || fs.exists(parent)) return
	ensureParentDirectories(fs, parent)
	fs.mkdir(parent)
}

export function createYjsFsWriteTool(fs: YjsFilesystem) {
	return WriteTool.define(
		async (input) => {
			ensureParentDirectories(fs, input.file_path)
			if (fs.exists(input.file_path)) {
				fs.writeFile(input.file_path, input.content)
			} else {
				fs.createFile(input.file_path, input.content)
			}
			return `Successfully wrote to ${input.file_path}`
		},
		{ description: WRITE_DESCRIPTION },
	)
}
