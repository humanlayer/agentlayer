import { BashTool } from '@humanlayer/agentlayer-core/interfaces'
import { BASH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { runProcess } from '../utils/process'

export function createBashTool(opts?: { cwd?: string }) {
	return BashTool.define(
		async (input, ctx) => {
			const cwd = input.workdir ?? opts?.cwd
			const { stdout, stderr, exitCode, timedOut, aborted } = await runProcess('bash', ['-c', input.command], {
				cwd,
				timeoutMs: input.timeout,
				signal: ctx.signal,
			})

			let output = stdout
			if (stderr) {
				output += `\nSTDERR: ${stderr}`
			}
			if (timedOut) {
				output += `\n\n<system-reminder>Command timed out after ${input.timeout}ms</system-reminder>`
			}
			if (aborted) {
				output += '\n\n<system-reminder>Command aborted by user interrupt</system-reminder>'
			}

			return `Exit code: ${exitCode}\n${output}`
		},
		{ description: BASH_DESCRIPTION },
	)
}
