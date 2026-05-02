import { readFile, stat } from 'node:fs/promises'
import { HashReadTool } from '@humanlayer/agentlayer-core/interfaces'
import { HASH_READ_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { isBinaryFile } from '@humanlayer/agentlayer-core/utils'
import { expandPath } from '../utils/expand-path'

export interface HashReadToolOptions {
	cwd?: string
}

export function createHashReadTool(opts: HashReadToolOptions = {}) {
	const { cwd } = opts

	return HashReadTool.define(
		async (input) => {
			const filePath = expandPath(input.file_path, cwd)
			const fileStat = await stat(filePath)
			if (!fileStat.isFile()) {
				throw new Error(`Cannot read non-file path: ${filePath}`)
			}
			if (await isBinaryFile(filePath, fileStat.size)) {
				throw new Error(`Cannot read binary file: ${filePath}`)
			}
			return await readFile(filePath, 'utf8')
		},
		{ description: HASH_READ_DESCRIPTION },
	)
}
