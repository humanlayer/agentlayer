import { isBinaryFile } from '../../util/binary'
import { expandPath } from '../../util/expand-path'
import { ReadTool } from '../interfaces/read'
import DESCRIPTION from './read.txt'

export function createReadTool() {
	return ReadTool.define(
		async (input) => {
			const filePath = expandPath(input.filePath)
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
