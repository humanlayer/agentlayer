import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { GrepTool } from '../interfaces/grep'
import DESCRIPTION from './grep.txt'

export function createYStreamFsGrepTool(fs: YjsStreamFS) {
	return GrepTool.define(
		async (input) => {
			return fs.grep(input.pattern, {
				include: input.include,
			})
		},
		{ description: DESCRIPTION },
	)
}
