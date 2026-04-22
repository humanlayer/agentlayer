import { BashTool } from '@humanlayer/agentlayer-core/interfaces'
import { BASH_DESCRIPTION } from '@humanlayer/agentlayer-core/prompts'
import { runProcess } from '../utils/process'

export function createBashTool(opts?: { cwd?: string }) {
	return BashTool.define(
		async (input) => {
			const cwd = input.workdir ?? opts?.cwd
			const { stdout, stderr, exitCode, timedOut } = await runProcess('bash', ['-c', input.command], {
				cwd,
				timeoutMs: input.timeout,
			})

			let output = stdout
			if (stderr) {
				output += `\nSTDERR: ${stderr}`
			}
			if (timedOut) {
				output += `\n\nCommand timed out after ${input.timeout}ms`
			}

			return `Exit code: ${exitCode}\n${output}`
		},
		{ description: BASH_DESCRIPTION },
	)
}
