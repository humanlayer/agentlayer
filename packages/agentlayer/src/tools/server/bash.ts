import { BashTool } from '../interfaces/bash'
import DESCRIPTION from './bash.txt'

export function createBashTool(opts?: { cwd?: string }) {
	return BashTool.define(
		async (input) => {
			const cwd = input.workdir ?? opts?.cwd
			const proc = Bun.spawn(['bash', '-c', input.command], {
				cwd,
				stdout: 'pipe',
				stderr: 'pipe',
			})

			let timedOut = false
			const timer = setTimeout(() => {
				timedOut = true
				proc.kill()
			}, input.timeout)

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			])
			const exitCode = await proc.exited
			clearTimeout(timer)

			let output = stdout
			if (stderr) {
				output += `\nSTDERR: ${stderr}`
			}
			if (timedOut) {
				output += `\n\nCommand timed out after ${input.timeout}ms`
			}

			return `Exit code: ${exitCode}\n${output}`
		},
		{ description: DESCRIPTION },
	)
}
