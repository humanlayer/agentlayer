import { defineTool } from '@humanlayer/agentlayer-core'
import { bashInput } from '@humanlayer/agentlayer-core/interfaces'
import { BASH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { truncateOutput } from '@humanlayer/agentlayer-core/utils'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { Bash, type BashOptions } from 'just-bash'
import { z } from 'zod'
import { YjsFsBashAdapter, type YjsFsBashOperation } from '../adapter'

export interface CreateYjsFsBashToolOptions {
	cwd?: string
	bashOptions?: Omit<BashOptions, 'fs' | 'cwd'>
}

export interface YjsFsBashToolResult {
	output: string
	operations: YjsFsBashOperation[]
}

export const yjsFsBashOutput = z.object({
	output: z.string(),
	operations: z.array(
		z.object({
			type: z.enum(['read', 'write', 'append', 'list', 'mkdir', 'delete', 'copy', 'move']),
			path: z.string(),
			toPath: z.string().optional(),
			pathType: z.enum(['file', 'directory', 'unknown']).optional(),
		}),
	),
})

export function createYjsFsBashTool(fs: YjsFilesystem, opts: CreateYjsFsBashToolOptions = {}) {
	const adapter = new YjsFsBashAdapter(fs)
	const bash = new Bash({
		defenseInDepth: false,
		...(opts.bashOptions ?? {}),
		fs: adapter,
		cwd: opts.cwd ?? '/',
	})

	return defineTool({
		name: 'bash',
		description: BASH_DESCRIPTION,
		input: bashInput,
		output: yjsFsBashOutput,
		serialize: (raw: YjsFsBashToolResult) => raw.output,
		execute: async (input) => {
			adapter.consumeOperations()
			const result = await bash.exec(input.command, {
				...(input.workdir ? { cwd: input.workdir } : {}),
			})
			let output = result.stdout
			if (result.stderr) {
				output += `\nSTDERR: ${result.stderr}`
			}
			return {
				output: truncateOutput(`Exit code: ${result.exitCode}\n${output}`),
				operations: adapter.consumeOperations(),
			}
		},
	})
}
