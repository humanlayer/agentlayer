import { readFile, stat } from 'node:fs/promises'
import {
	type ReadMultimodalOutput,
	ReadMultimodalTool,
	type ReadToolModalities,
} from '@humanlayer/agentlayer-core/interfaces'
import { READ_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { detectFileType } from '@humanlayer/agentlayer-core/utils'
import { expandPath } from '../utils/expand-path'

export interface ReadMultimodalToolOptions {
	cwd?: string
	readToolModalities?: ReadToolModalities
}

function hasModality(readToolModalities: ReadToolModalities, modality: 'image' | 'pdf'): boolean {
	return readToolModalities.includes(modality)
}

export function createReadMultimodalTool(opts: ReadMultimodalToolOptions = {}) {
	const { cwd, readToolModalities = ['text'] } = opts

	return ReadMultimodalTool.define(
		async (input): Promise<ReadMultimodalOutput> => {
			const filePath = expandPath(input.file_path, cwd)
			const fileStat = await stat(filePath)
			if (!fileStat.isFile()) {
				throw new Error(`Cannot read non-file path: ${filePath}`)
			}

			const fileType = await detectFileType(filePath, fileStat.size)
			if (fileType.type === 'text') {
				return { type: 'text', content: await readFile(filePath, 'utf8') }
			}

			if (fileType.type === 'image') {
				if (!hasModality(readToolModalities, 'image')) {
					throw new Error(`Cannot read image file because image support is unavailable: ${filePath}`)
				}
				return { type: 'image', content: await readFile(filePath), mediaType: fileType.mediaType }
			}

			if (fileType.type === 'pdf') {
				if (!hasModality(readToolModalities, 'pdf')) {
					throw new Error(`Cannot read PDF file because PDF support is unavailable: ${filePath}`)
				}
				return { type: 'pdf', content: await readFile(filePath), mediaType: fileType.mediaType }
			}

			throw new Error(`Cannot read unsupported binary file type: ${filePath}`)
		},
		{ description: READ_DESCRIPTION },
	)
}
