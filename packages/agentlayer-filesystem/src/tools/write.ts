import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { WriteTool } from '@humanlayer/agentlayer-core/interfaces'
import { WRITE_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { expandPath } from '../utils/expand-path'

export interface WriteToolOptions {
	cwd?: string
}

export function createWriteTool(opts: WriteToolOptions = {}) {
	const { cwd } = opts

	return WriteTool.define(
		async (input) => {
			const filePath = expandPath(input.file_path, cwd)
			await mkdir(dirname(filePath), { recursive: true })
			await Bun.write(filePath, input.content)
			return `Successfully wrote to ${input.file_path}`
		},
		{ description: WRITE_DESCRIPTION },
	)
}
