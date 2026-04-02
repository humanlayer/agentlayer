import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { GlobTool } from '../interfaces/glob'
import DESCRIPTION from './glob.txt'

export function createYStreamFsGlobTool(fs: YjsStreamFS) {
	return GlobTool.define(
		async (input) => {
			return fs.glob(input.pattern)
		},
		{ description: DESCRIPTION },
	)
}
