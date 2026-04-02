import type { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import type { Tool } from '../../core/define-tool'
import { createYStreamFsCreateCommentTool } from './create-comment'
import { createYStreamFsCreateFileTool } from './create-file'
import { createYStreamFsDeleteFileTool } from './delete-file'
import { createYStreamFsEditTool } from './edit'
import { createYStreamFsGlobTool } from './glob'
import { createYStreamFsGrepTool } from './grep'
import { createYStreamFsListTool } from './list'
import { createYStreamFsListCommentsTool } from './list-comments'
import { createYStreamFsReadTool } from './read'
import { createYStreamFsUpdateCommentTool } from './update-comment'

export {
	createYStreamFsCreateCommentTool,
	createYStreamFsCreateFileTool,
	createYStreamFsDeleteFileTool,
	createYStreamFsEditTool,
	createYStreamFsGlobTool,
	createYStreamFsGrepTool,
	createYStreamFsListTool,
	createYStreamFsListCommentsTool,
	createYStreamFsReadTool,
	createYStreamFsUpdateCommentTool,
}

/** Create all 10 StreamFS-backed tools as a Record for Agent registration */
export function createYStreamFsTools(fs: YjsStreamFS): Record<string, Tool<any, any>> {
	return {
		create_file: createYStreamFsCreateFileTool(fs),
		read: createYStreamFsReadTool(fs),
		edit: createYStreamFsEditTool(fs),
		delete_file: createYStreamFsDeleteFileTool(fs),
		glob: createYStreamFsGlobTool(fs),
		grep: createYStreamFsGrepTool(fs),
		list: createYStreamFsListTool(fs),
		list_comments: createYStreamFsListCommentsTool(fs),
		create_comment: createYStreamFsCreateCommentTool(fs),
		update_comment: createYStreamFsUpdateCommentTool(fs),
	}
}
