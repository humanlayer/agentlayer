import { describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import path from 'node:path'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsRuntime } from '../src/runtime'
import { createYjsFsSecureExecTool } from '../src/tools'
import type { YjsFsSecureExecToolResult } from '../src/tools/exec'

describe('createYjsFsRuntime', () => {
	test('executes simple JavaScript', async () => {
		const fs = new YjsFilesystem()
		const { runtime } = createYjsFsRuntime(fs)
		try {
			const result = await runtime.run('export const value = 42', '/entry.mjs')

			expect(result).toMatchObject({ code: 0 })
			expect((result as { exports?: { value?: number } }).exports?.value).toBe(42)
		} finally {
			runtime.dispose()
		}
	})

	test('reads and writes files through YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/input.txt', 'hello')
		const { runtime } = createYjsFsRuntime(fs)
		try {
			const result = await runtime.run(
				`import { readFileSync, writeFileSync } from 'node:fs'
const input = readFileSync('/input.txt', 'utf8')
writeFileSync('/output.txt', input + ' world')
export const output = input`,
				'/entry.mjs',
			)

			expect(result).toMatchObject({ code: 0 })
			expect(fs.readFile('/output.txt')).toBe('hello world')
		} finally {
			runtime.dispose()
		}
	})

	test('allows network access when enabled', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('network-ok')
		})
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		try {
			const address = server.address()
			if (!address || typeof address === 'string') throw new Error('missing loopback address')

			const fs = new YjsFilesystem()
			const { runtime } = createYjsFsRuntime(fs, { enableNetwork: true, loopbackExemptPorts: [address.port] })
			try {
				const result = await runtime.run(
					`const response = await fetch('http://127.0.0.1:${address.port}/')
export const body = await response.text()`,
					'/entry.mjs',
				)

				expect(result).toMatchObject({ code: 0 })
				expect((result as { exports?: { body?: string } }).exports?.body).toBe('network-ok')
			} finally {
				runtime.dispose()
			}
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		}
	})

	test('passes host node_modules overlay options to secure-exec', async () => {
		const fs = new YjsFilesystem()
		const { runtime } = createYjsFsRuntime(fs, { moduleAccessCwd: path.resolve(import.meta.dir, '../../..') })
		try {
			const result = await runtime.run(
				`import { existsSync } from 'node:fs'
export const hasNodeModulesOverlay = existsSync('/root/node_modules')`,
				'/entry.mjs',
			)

			expect(result).toMatchObject({ code: 0 })
			expect((result as { exports?: { hasNodeModulesOverlay?: boolean } }).exports?.hasNodeModulesOverlay).toBe(
				true,
			)
		} finally {
			runtime.dispose()
		}
	})
})

describe('createYjsFsSecureExecTool', () => {
	test('raw output includes tracked operations while serialization returns execution result', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/input.txt', 'hello')
		const tool = createYjsFsSecureExecTool(fs)

		const raw = (await tool.execute(
			{
				code: `import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync('/output.txt', readFileSync('/input.txt', 'utf8'))
export const ok = true`,
				filePath: '/entry.mjs',
			},
			{} as never,
		)) as YjsFsSecureExecToolResult

		expect(fs.readFile('/output.txt')).toBe('hello')
		expect(raw.operations.map((operation) => operation.type)).toContain('read')
		expect(raw.operations.map((operation) => operation.type)).toContain('write')
		expect(tool.serialize?.(raw, { code: '', filePath: '/entry.mjs' })).toContain('"code": 0')
	})
})
