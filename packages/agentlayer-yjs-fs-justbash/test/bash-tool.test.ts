import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { makeToolContext } from '../../agentlayer-yjs-fs/test/mocks'
import { createYjsFsBashTool, type YjsFsBashToolResult } from '../src/tools/bash'

function bashResult(output: unknown): YjsFsBashToolResult {
	return output as YjsFsBashToolResult
}

describe('createYjsFsBashTool', () => {
	test('echo hello returns output', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'echo hello', timeout: 120000 }, makeToolContext())

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(bashResult(output).output).toContain('hello')
	})

	test('cat reads from YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/file.txt', 'from yjs')
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'cat /file.txt', timeout: 120000 }, makeToolContext())

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(bashResult(output).output).toContain('from yjs')
	})

	test('shell redirection writes to YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute(
			{ command: 'echo content > /created.txt', timeout: 120000 },
			makeToolContext(),
		)

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(fs.readFile('/created.txt')).toBe('content\n')
		expect(bashResult(output).operations).toContainEqual(
			expect.objectContaining({ type: 'write', path: '/created.txt' }),
		)
	})

	test('touch creates a file in YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'touch /newfile.txt', timeout: 120000 }, makeToolContext())

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(fs.exists('/newfile.txt')).toBe(true)
	})

	test('compound filesystem commands run without defense-in-depth violations', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/existing.txt', 'existing')
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute(
			{ command: 'touch /newfile.txt && echo hello > /hello.txt && ls / && cat /hello.txt', timeout: 120000 },
			makeToolContext(),
		)

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(bashResult(output).output).toContain('existing.txt')
		expect(bashResult(output).output).toContain('newfile.txt')
		expect(bashResult(output).output).toContain('hello')
		expect(bashResult(output).output).not.toContain('globalThis.setTimeout')
		expect(fs.readFile('/hello.txt')).toBe('hello\n')
	})

	test('ls lists YjsFilesystem root', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/root.txt', 'content')
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'ls /', timeout: 120000 }, makeToolContext())

		expect(bashResult(output).output).toContain('Exit code: 0')
		expect(bashResult(output).output).toContain('root.txt')
	})

	test('non-zero command returns exit code', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'cat /missing.txt', timeout: 120000 }, makeToolContext())

		expect(bashResult(output).output).toContain('Exit code:')
		expect(bashResult(output).output).not.toContain('Exit code: 0')
	})
})
