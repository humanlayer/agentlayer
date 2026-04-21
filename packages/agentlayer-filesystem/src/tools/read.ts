import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import { isBinaryFile } from '@humanlayer/agentlayer-core/utils'
import { expandPath } from '../utils/expand-path'
import DESCRIPTION from './read.txt'

export interface ReadToolOptions {
	cwd?: string
}

export function createReadTool(opts: ReadToolOptions = {}) {
	const { cwd } = opts

	return ReadTool.define(
		async (input) => {
			const filePath = expandPath(input.file_path, cwd)
			const file = Bun.file(filePath)
			const size = file.size
			if (await isBinaryFile(filePath, size)) {
				throw new Error(`Cannot read binary file: ${filePath}`)
			}
			return await file.text()
		},
		{ description: DESCRIPTION },
	)
}
