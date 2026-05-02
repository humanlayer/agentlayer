import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsEditTool, createYjsFsReadTool, createYjsFsWriteTool } from '../src/tools'
import { createSyncedYjsFilesystems, makeToolContext } from './mocks'

describe('createYjsFsWriteTool', () => {
	test('creates new file when path does not exist', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsWriteTool(fs)

		const result = await tool.execute({ file_path: '/test.ts', content: 'const x = 1' }, makeToolContext())

		expect(result).toBe('Successfully wrote to /test.ts')
		expect(fs.readFile('/test.ts')).toBe('const x = 1')
	})

	test('overwrites existing file content', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/test.ts', 'old')
		const tool = createYjsFsWriteTool(fs)

		await tool.execute({ file_path: '/test.ts', content: 'new' }, makeToolContext())

		expect(fs.readFile('/test.ts')).toBe('new')
	})

	test('creates parent directories if needed', async () => {
		const fs = new YjsFilesystem()
		const tool = createYjsFsWriteTool(fs)

		await tool.execute({ file_path: '/src/components/button.ts', content: 'export {}' }, makeToolContext())

		expect(fs.stat('/src').isDirectory).toBe(true)
		expect(fs.stat('/src/components').isDirectory).toBe(true)
		expect(fs.readFile('/src/components/button.ts')).toBe('export {}')
	})

	test('syncs write and edit operations through Yjs document updates', async () => {
		const { fsA, fsB, syncBothWays } = createSyncedYjsFilesystems()
		const writeA = createYjsFsWriteTool(fsA)
		const readB = createYjsFsReadTool(fsB)
		const editB = createYjsFsEditTool(fsB)
		const writeB = createYjsFsWriteTool(fsB)

		await writeA.execute({ file_path: '/src/app.ts', content: 'const value = 1\n' }, makeToolContext())
		syncBothWays()

		expect(await readB.execute({ file_path: '/src/app.ts', limit: 2000 }, makeToolContext())).toBe(
			'const value = 1\n',
		)
		expect(fsB.getYText('/src/app.ts').toString()).toBe('const value = 1\n')

		await editB.execute(
			{ file_path: '/src/app.ts', old_string: 'value = 1', new_string: 'value = 2', replace_all: false },
			makeToolContext(),
		)
		syncBothWays()

		expect(fsA.getYText('/src/app.ts').toString()).toBe('const value = 2\n')

		await writeB.execute({ file_path: '/src/app.ts', content: 'export const value = 3\n' }, makeToolContext())
		syncBothWays()

		expect(fsA.readFile('/src/app.ts')).toBe('export const value = 3\n')
		expect(fsA.getYText('/src/app.ts').toString()).toBe('export const value = 3\n')
		expect(fsB.getYText('/src/app.ts').toString()).toBe('export const value = 3\n')
	})
})
