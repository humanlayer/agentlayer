import type { StreamFilesystem } from '@humanlayer/agentlayer-stream-fs'
import type { ListEntry } from '../interfaces/list'
import { ListTool } from '../interfaces/list'
import DESCRIPTION from './list.txt'

export function createStreamFsListTool(fs: StreamFilesystem) {
	return ListTool.define(
		async (input) => {
			const dirPath = input.path ?? '/'
			const entries = fs.list(dirPath)

			return entries.map(
				(e): ListEntry => ({
					name: dirPath === '/' ? `/${e.name}` : `${dirPath}/${e.name}`,
					type: e.type === 'directory' ? 'directory' : 'file',
				}),
			)
		},
		{ description: DESCRIPTION },
	)
}
