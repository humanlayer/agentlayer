import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

export async function streamToString(stream: Readable | null | undefined): Promise<string> {
	if (!stream) {
		return ''
	}

	stream.setEncoding('utf8')
	let output = ''
	for await (const chunk of stream) {
		output += chunk
	}

	return output
}

export async function runProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithoutStdio & { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
	const { timeoutMs, ...spawnOptions } = options
	const child = spawn(command, args, {
		...spawnOptions,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	let timedOut = false
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
				timedOut = true
				child.kill()
			}, timeoutMs)

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			streamToString(child.stdout),
			streamToString(child.stderr),
			new Promise<number>((resolve, reject) => {
				child.once('error', reject)
				child.once('close', (code) => resolve(code ?? -1))
			}),
		])

		return { stdout, stderr, exitCode, timedOut }
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}
