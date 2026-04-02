import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import { ListTool } from '../interfaces/list'
import DESCRIPTION from './list.txt'

export function createYStreamFsListTool(fs: YjsStreamFS) {
	return ListTool.define(
		async (input) => {
			return fs.list(input.path ?? '/')
		},
		{ description: DESCRIPTION },
	)
}
