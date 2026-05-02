import { BashTool } from '@humanlayer/agentlayer-core/interfaces'
import { BASH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { truncateOutput } from '@humanlayer/agentlayer-core/utils'
import type { YjsFilesystem } from '@humanlayer/yjs-fs'
import { Bash, type BashOptions } from 'just-bash'
import { YjsFsBashAdapter } from '../adapter'

export interface CreateYjsFsBashToolOptions {
	cwd?: string
	bashOptions?: Omit<BashOptions, 'fs' | 'cwd'>
}

export function createYjsFsBashTool(fs: YjsFilesystem, opts: CreateYjsFsBashToolOptions = {}) {
	const adapter = new YjsFsBashAdapter(fs)
	const bash = new Bash({
		defenseInDepth: false,
		...(opts.bashOptions ?? {}),
		fs: adapter,
		cwd: opts.cwd ?? '/',
	})

	return BashTool.define(
		async (input) => {
			const result = await bash.exec(input.command, {
				...(input.workdir ? { cwd: input.workdir } : {}),
			})
			let output = result.stdout
			if (result.stderr) {
				output += `\nSTDERR: ${result.stderr}`
			}
			return truncateOutput(`Exit code: ${result.exitCode}\n${output}`)
		},
		{ description: BASH_DESCRIPTION },
	)
}
