import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsGrepTool } from '../src/tools'
import { makeToolContext } from './mocks'

function createFs() {
	const fs = new YjsFilesystem()
	fs.mkdir('/src')
	fs.mkdir('/docs')
	fs.createFile('/src/index.ts', 'const apple = 1\nconst banana = 2\nAPPLE pie')
	fs.createFile('/src/util.js', 'function appleSauce() {}')
	fs.createFile('/docs/readme.md', 'banana docs')
	fs.createBinaryFile('/src/image.bin', new Uint8Array([1, 2, 3]))
	return fs
}

describe('createYjsFsGrepTool', () => {
	test('finds matches with string pattern', async () => {
		const tool = createYjsFsGrepTool(createFs())

		const raw = await tool.execute({ pattern: 'apple' }, makeToolContext())

		expect(raw).toContainEqual({ file: '/src/index.ts', line: 1, content: 'const apple = 1' })
		expect(raw).toContainEqual({ file: '/src/util.js', line: 1, content: 'function appleSauce() {}' })
	})

	test('finds matches with regex pattern', async () => {
		const tool = createYjsFsGrepTool(createFs())

		const raw = await tool.execute({ pattern: 'banana|docs' }, makeToolContext())

		expect(raw).toContainEqual({ file: '/src/index.ts', line: 2, content: 'const banana = 2' })
		expect(raw).toContainEqual({ file: '/docs/readme.md', line: 1, content: 'banana docs' })
	})

	test('respects include glob filter', async () => {
		const tool = createYjsFsGrepTool(createFs())

		const raw = await tool.execute({ pattern: 'apple', include: '**/*.ts' }, makeToolContext())

		expect(raw).toEqual([{ file: '/src/index.ts', line: 1, content: 'const apple = 1' }])
	})

	test('handles case-insensitive search with regex flags', async () => {
		const tool = createYjsFsGrepTool(createFs())

		const raw = await tool.execute({ pattern: '(?i)apple' }, makeToolContext())

		expect(raw).toContainEqual({ file: '/src/index.ts', line: 3, content: 'APPLE pie' })
	})

	test('returns empty array when no matches', async () => {
		const tool = createYjsFsGrepTool(createFs())

		const raw = await tool.execute({ pattern: 'missing' }, makeToolContext())

		expect(raw).toEqual([])
	})
})
