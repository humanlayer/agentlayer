import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashTool } from '../src/tools/bash'
import { makeToolContext } from './mocks'

const TEST_TIMEOUT_MS = 10_000
const ABORT_REMINDER = '<system-reminder>Command aborted by user interrupt</system-reminder>'
const TIMEOUT_REMINDER = '<system-reminder>Command timed out after 200ms</system-reminder>'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'agentlayer-bash-'))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = TEST_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)),
	])
}

function hangingNodeCommand(message = 'started'): string {
	return `node -e "console.log('${message}'); setInterval(() => {}, 1000)"`
}

describe('bash tool interrupts and timeouts', () => {
	test('timeout kills command and preserves partial output', async () => {
		await withTempDir(async (dir) => {
			const bash = createBashTool({ cwd: dir })

			const output = await withTimeout(
				bash.execute({ command: hangingNodeCommand('before-timeout'), timeout: 200 }, makeToolContext()),
			)

			expect(output).toContain('before-timeout')
			expect(output).toContain(TIMEOUT_REMINDER)
		})
	})

	test('abort kills command and preserves partial output', async () => {
		await withTempDir(async (dir) => {
			const bash = createBashTool({ cwd: dir })
			const controller = new AbortController()
			const promise = bash.execute(
				{ command: hangingNodeCommand('before-abort'), timeout: 120_000 },
				makeToolContext({ signal: controller.signal }),
			)

			setTimeout(() => controller.abort(), 200)
			const output = await withTimeout(promise)

			expect(output).toContain('before-abort')
			expect(output).toContain(ABORT_REMINDER)
		})
	})
})
