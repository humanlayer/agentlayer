import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { makeToolContext } from '../../agentlayer-yjs-fs/test/mocks'
import { createYjsFsBashTool } from '../src/tools/bash'

describe('createYjsFsBashTool', () => {
	test('echo hello returns output', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'echo hello', timeout: 120000 }, makeToolContext())

		expect(output).toContain('Exit code: 0')
		expect(output).toContain('hello')
	})

	test('cat reads from YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/file.txt', 'from yjs')
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'cat /file.txt', timeout: 120000 }, makeToolContext())

		expect(output).toContain('Exit code: 0')
		expect(output).toContain('from yjs')
	})

	test('shell redirection writes to YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute(
			{ command: 'echo content > /created.txt', timeout: 120000 },
			makeToolContext(),
		)

		expect(output).toContain('Exit code: 0')
		expect(fs.readFile('/created.txt')).toBe('content\n')
	})

	test('touch creates a file in YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'touch /newfile.txt', timeout: 120000 }, makeToolContext())

		expect(output).toContain('Exit code: 0')
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

		expect(output).toContain('Exit code: 0')
		expect(output).toContain('existing.txt')
		expect(output).toContain('newfile.txt')
		expect(output).toContain('hello')
		expect(output).not.toContain('globalThis.setTimeout')
		expect(fs.readFile('/hello.txt')).toBe('hello\n')
	})

	test('ls lists YjsFilesystem root', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/root.txt', 'content')
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'ls /', timeout: 120000 }, makeToolContext())

		expect(output).toContain('Exit code: 0')
		expect(output).toContain('root.txt')
	})

	test('non-zero command returns exit code', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsBashTool(fs)

		const output = await tool.execute({ command: 'cat /missing.txt', timeout: 120000 }, makeToolContext())

		expect(output).toContain('Exit code:')
		expect(output).not.toContain('Exit code: 0')
	})
})
