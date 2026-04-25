import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const SIGKILL_GRACE_MS = 200
const STDIO_CLOSE_GRACE_MS = 100

type ProcessResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean }

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
	options: SpawnOptionsWithoutStdio & { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
	const { timeoutMs, signal, ...spawnOptions } = options
	const child = spawn(command, args, {
		...spawnOptions,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
	})

	let timedOut = false
	let aborted = false
	let terminating = false

	const terminate = (reason: 'timeout' | 'abort') => {
		if (terminating) return
		terminating = true
		if (reason === 'timeout') timedOut = true
		if (reason === 'abort') aborted = true
		void killProcessTree(child)
	}

	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					terminate('timeout')
				}, timeoutMs)

	const onAbort = () => terminate('abort')
	if (signal?.aborted) {
		onAbort()
	} else {
		signal?.addEventListener('abort', onAbort, { once: true })
	}

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			streamToString(child.stdout),
			streamToString(child.stderr),
			waitForProcess(child),
		])

		return { stdout, stderr, exitCode, timedOut, aborted }
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
		signal?.removeEventListener('abort', onAbort)
	}
}

async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
	const pid = child.pid
	if (!pid) return

	if (process.platform === 'win32') {
		await new Promise<void>((resolve) => {
			const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
				stdio: 'ignore',
				windowsHide: true,
			})
			killer.once('exit', () => resolve())
			killer.once('error', () => resolve())
		})
		return
	}

	try {
		process.kill(-pid, 'SIGTERM')
		await delay(SIGKILL_GRACE_MS)
		if (child.exitCode === null && child.signalCode === null) {
			process.kill(-pid, 'SIGKILL')
		}
	} catch {
		try {
			child.kill('SIGTERM')
			await delay(SIGKILL_GRACE_MS)
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL')
			}
		} catch {
			// Process already exited or cannot be killed.
		}
	}
}

function waitForProcess(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		let settled = false
		let postExitTimer: ReturnType<typeof setTimeout> | undefined

		const cleanup = () => {
			if (postExitTimer) clearTimeout(postExitTimer)
			child.removeListener('error', onError)
			child.removeListener('close', onClose)
			child.removeListener('exit', onExit)
		}

		const destroyStreams = () => {
			child.stdout?.destroy()
			child.stderr?.destroy()
		}

		const finish = (code: number | null) => {
			if (settled) return
			settled = true
			cleanup()
			destroyStreams()
			resolve(code ?? -1)
		}

		const onError = (error: Error) => {
			if (settled) return
			settled = true
			cleanup()
			destroyStreams()
			reject(error)
		}

		const onClose = (code: number | null) => finish(code)
		const onExit = (code: number | null) => {
			postExitTimer = setTimeout(() => finish(code), STDIO_CLOSE_GRACE_MS)
		}

		child.once('error', onError)
		child.once('close', onClose)
		child.once('exit', onExit)
	})
}
