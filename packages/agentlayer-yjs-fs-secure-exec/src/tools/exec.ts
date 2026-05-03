import { defineTool } from '@humanlayer/agentlayer-core'
import { truncateOutput } from '@humanlayer/agentlayer-core/utils'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { z } from 'zod'
import type { YjsFsSecureExecOperation } from '../adapter'
import { type CreateYjsFsRuntimeOptions, createYjsFsRuntime } from '../runtime'

export const secureExecInput = z.object({
	code: z.string().describe('JavaScript or TypeScript code to execute in the secure-exec sandbox'),
	filePath: z.string().describe('Absolute POSIX entry file path for the executed code').default('/entry.mjs'),
})

export const yjsFsSecureExecOutput = z.object({
	output: z.string(),
	operations: z.array(
		z.object({
			type: z.enum(['read', 'write', 'list', 'mkdir', 'delete', 'rename', 'truncate']),
			path: z.string(),
			toPath: z.string().optional(),
			pathType: z.enum(['file', 'directory', 'unknown']).optional(),
		}),
	),
})

export interface YjsFsSecureExecToolResult {
	output: string
	operations: YjsFsSecureExecOperation[]
}

export function createYjsFsSecureExecTool(fs: YjsFilesystem, opts: CreateYjsFsRuntimeOptions = {}) {
	const { runtime, adapter } = createYjsFsRuntime(fs, opts)

	return defineTool({
		name: 'secure_exec',
		description: 'Execute JavaScript or TypeScript in a secure-exec sandbox backed by the Y.js filesystem.',
		input: secureExecInput,
		output: yjsFsSecureExecOutput,
		serialize: (raw: YjsFsSecureExecToolResult) => raw.output,
		execute: async (input) => {
			adapter.consumeOperations()
			const result = await runtime.run(input.code, input.filePath)
			return {
				output: truncateOutput(JSON.stringify(result, null, 2)),
				operations: adapter.consumeOperations(),
			}
		},
	})
}
