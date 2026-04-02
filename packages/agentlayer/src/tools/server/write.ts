import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandPath } from '../../util/expand-path'
import { WriteTool } from '../interfaces/write'
import DESCRIPTION from './write.txt'

export function createWriteTool() {
	return WriteTool.define(
		async (input) => {
			const filePath = expandPath(input.filePath)
			await mkdir(dirname(filePath), { recursive: true })
			await Bun.write(filePath, input.content)
			return `Successfully wrote to ${input.filePath}`
		},
		{ description: DESCRIPTION },
	)
}
