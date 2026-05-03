import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsGlobTool } from '../src/tools'
import { makeToolContext } from './mocks'

function createFs() {
	const fs = new YjsFilesystem()
	fs.mkdir('/src')
	fs.mkdir('/src/nested')
	fs.mkdir('/node_modules')
	fs.createFile('/src/index.ts', 'export const x = 1')
	fs.createFile('/src/nested/util.ts', 'export const y = 2')
	fs.createFile('/src/readme.md', '# docs')
	fs.createFile('/node_modules/pkg.ts', 'ignored')
	return fs
}

describe('createYjsFsGlobTool', () => {
	test('matches files with star pattern', async () => {
		const tool = createYjsFsGlobTool(createFs())

		const raw = await tool.execute({ pattern: 'src/*.ts' }, makeToolContext())

		expect(raw).toEqual(['/src/index.ts'])
	})

	test('matches nested files with globstar pattern', async () => {
		const tool = createYjsFsGlobTool(createFs())

		const raw = await tool.execute({ pattern: '**/*.ts' }, makeToolContext())

		expect(raw).toEqual(['/node_modules/pkg.ts', '/src/index.ts', '/src/nested/util.ts'])
	})

	test('returns empty array when no matches', async () => {
		const tool = createYjsFsGlobTool(createFs())

		const raw = await tool.execute({ pattern: '**/*.go' }, makeToolContext())

		expect(raw).toEqual([])
	})

	test('handles negation patterns', async () => {
		const tool = createYjsFsGlobTool(createFs())

		const raw = await tool.execute({ pattern: '!node_modules/**' }, makeToolContext())

		expect(raw).toEqual(['/src/index.ts', '/src/nested/util.ts', '/src/readme.md'])
	})

	test('searches within input path and returns sorted results', async () => {
		const tool = createYjsFsGlobTool(createFs())

		const raw = await tool.execute({ pattern: '**/*', path: '/src' }, makeToolContext())

		expect(raw).toEqual(['/src/index.ts', '/src/nested/util.ts', '/src/readme.md'])
	})
})
