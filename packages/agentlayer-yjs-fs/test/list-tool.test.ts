import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { createYjsFsListTool } from '../src/tools'
import { makeToolContext } from './mocks'

function createFs() {
	const fs = new YjsFilesystem()
	fs.mkdir('/src')
	fs.mkdir('/src/nested')
	fs.mkdir('/node_modules')
	fs.createFile('/src/index.ts', 'export const x = 1')
	fs.createFile('/src/readme.md', '# docs')
	fs.createFile('/node_modules/pkg.js', 'ignored')
	return fs
}

describe('createYjsFsListTool', () => {
	test('lists directory contents with file types', async () => {
		const tool = createYjsFsListTool(createFs())

		const raw = await tool.execute({ path: '/src' }, makeToolContext())

		expect(raw).toEqual([
			{ name: '/src/index.ts', type: 'file' },
			{ name: '/src/nested', type: 'directory' },
			{ name: '/src/readme.md', type: 'file' },
		])
	})

	test('applies default ignore patterns', async () => {
		const tool = createYjsFsListTool(createFs())

		const raw = await tool.execute({ path: '/' }, makeToolContext())

		expect(raw).toEqual([{ name: '/src', type: 'directory' }])
	})

	test('applies user ignore patterns', async () => {
		const tool = createYjsFsListTool(createFs())

		const raw = await tool.execute({ path: '/src', ignore: ['*.md'] }, makeToolContext())

		expect(raw).toEqual([
			{ name: '/src/index.ts', type: 'file' },
			{ name: '/src/nested', type: 'directory' },
		])
	})

	test('throws for non-existent directory', async () => {
		const tool = createYjsFsListTool(createFs())

		await expect(tool.execute({ path: '/missing' }, makeToolContext())).rejects.toThrow('Path not found')
	})

	test('handles empty directory', async () => {
		const fs = new YjsFilesystem()
		fs.mkdir('/empty')
		const tool = createYjsFsListTool(fs)

		const raw = await tool.execute({ path: '/empty' }, makeToolContext())

		expect(raw).toEqual([])
	})
})
