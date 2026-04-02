import { beforeEach, describe, expect, test } from 'bun:test'
import { YjsStreamFS } from '@humanlayer/agentlayer-stream-fs-yjs'
import type { ToolContext } from '../src/core/define-tool'
import { createYStreamFsTools } from '../src/tools/y-stream-fs'

function makeCtx(): ToolContext {
	return {
		getContextWindow: () => [],
		updateContextWindow: () => {},
		getContextWindowTokens: () => 0,
		getContextWindowLimit: () => undefined,
		signal: new AbortController().signal,
		progress: () => {},
		stop: (opts) => ({ type: 'stop', ...opts }),
	}
}

describe('y-stream-fs tools', () => {
	let fs: YjsStreamFS
	let tools: ReturnType<typeof createYStreamFsTools>

	beforeEach(() => {
		fs = new YjsStreamFS()
		tools = createYStreamFsTools(fs)
	})

	test('create_file creates a file', async () => {
		const result = await tools.create_file!.execute({ filePath: '/hello.txt', content: 'world' }, makeCtx())
		expect(result).toBe('Created /hello.txt')
		expect(fs.readFile('/hello.txt')).toBe('world')
	})

	test('read returns file content', async () => {
		fs.createFile('/f.txt', 'hello')
		const result = await tools.read!.execute({ filePath: '/f.txt', limit: 2000 }, makeCtx())
		expect(result).toBe('hello')
	})

	test('edit replaces string and returns matchCount', async () => {
		fs.createFile('/f.ts', 'const x = 1')
		const result = await tools.edit!.execute(
			{ filePath: '/f.ts', oldString: 'const x = 1', newString: 'const x = 2', replaceAll: false },
			makeCtx(),
		)
		expect(result).toMatchObject({ matchCount: 1 })
		expect(fs.readFile('/f.ts')).toBe('const x = 2')
	})

	test('delete_file removes the file', async () => {
		fs.createFile('/f.txt', 'content')
		await tools.delete_file!.execute({ filePath: '/f.txt' }, makeCtx())
		expect(fs.exists('/f.txt')).toBe(false)
	})

	test('glob returns matching paths', async () => {
		fs.createFile('/src/a.ts', 'a')
		fs.createFile('/src/b.js', 'b')
		const result = await tools.glob!.execute({ pattern: '**/*.ts' }, makeCtx())
		expect(result).toEqual(['/src/a.ts'])
	})

	test('grep returns matching lines', async () => {
		fs.createFile('/f.ts', 'const x = 1\nlet y = 2')
		const result = await tools.grep!.execute({ pattern: 'const' }, makeCtx())
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ file: '/f.ts', line: 1 })
	})

	test('list returns directory entries', async () => {
		fs.createFile('/a.txt', 'a')
		fs.createFile('/b.txt', 'b')
		const result = await tools.list!.execute({ path: '/' }, makeCtx())
		expect(result).toContainEqual({ name: 'a.txt', type: 'file' })
		expect(result).toContainEqual({ name: 'b.txt', type: 'file' })
	})

	test('list_comments returns empty array for new file', async () => {
		fs.createFile('/f.ts', 'hello world')
		const result = await tools.list_comments!.execute({ filePath: '/f.ts' }, makeCtx())
		expect(result).toEqual([])
	})

	test('create_comment creates a comment and returns id', async () => {
		fs.createFile('/f.ts', 'hello world')
		const result = await tools.create_comment!.execute(
			{ filePath: '/f.ts', selectedText: 'hello', body: 'Nice greeting', author: 'alice' },
			makeCtx(),
		)
		expect(result).toMatchObject({ id: expect.any(String) })
		const comments = fs.getComments('/f.ts')
		expect(comments).toHaveLength(1)
		expect(comments[0]!.body).toBe('Nice greeting')
	})

	test('create_comment uses contextBefore to disambiguate', async () => {
		fs.createFile('/f.ts', 'foo bar foo baz')
		// Comment on the second "foo" (after "bar ")
		const result = await tools.create_comment!.execute(
			{
				filePath: '/f.ts',
				selectedText: 'foo',
				contextBefore: 'bar ',
				body: 'Second foo',
				author: 'alice',
			},
			makeCtx(),
		)
		expect(result).toMatchObject({ id: expect.any(String) })
		const comments = fs.getComments('/f.ts')
		expect(comments[0]!.anchorIndex).toBe(8) // "foo bar foo baz".indexOf("foo", after "foo bar ")
	})

	test('create_comment with parentId adds a reply', async () => {
		fs.createFile('/f.ts', 'hello world')
		const { id: commentId } = await tools.create_comment!.execute(
			{ filePath: '/f.ts', selectedText: 'hello', body: 'First comment', author: 'alice' },
			makeCtx(),
		)
		const result = await tools.create_comment!.execute(
			{ filePath: '/f.ts', parentId: commentId, body: 'Thanks!', author: 'bob' },
			makeCtx(),
		)
		expect(result).toMatchObject({ id: expect.any(String) })
		const comments = fs.getComments('/f.ts')
		expect(comments[0]!.replies).toHaveLength(1)
		expect(comments[0]!.replies[0]!.body).toBe('Thanks!')
		expect(comments[0]!.replies[0]!.parentId).toBe(commentId)
	})

	test('update_comment with action delete removes a comment', async () => {
		fs.createFile('/f.ts', 'hello world')
		const { id: commentId } = await tools.create_comment!.execute(
			{ filePath: '/f.ts', selectedText: 'hello', body: 'To delete', author: 'alice' },
			makeCtx(),
		)
		await tools.update_comment!.execute({ filePath: '/f.ts', commentId, action: 'delete' }, makeCtx())
		expect(fs.getComments('/f.ts')).toHaveLength(0)
	})

	test('update_comment with action resolve toggles resolved state', async () => {
		fs.createFile('/f.ts', 'hello world')
		const { id: commentId } = await tools.create_comment!.execute(
			{ filePath: '/f.ts', selectedText: 'hello', body: 'Needs fix', author: 'alice' },
			makeCtx(),
		)

		// Resolve
		await tools.update_comment!.execute(
			{ filePath: '/f.ts', commentId, action: 'resolve', author: 'bob' },
			makeCtx(),
		)
		let comments = fs.getComments('/f.ts')
		expect(comments[0]!.resolved).toBe(true)
		expect(comments[0]!.resolvedBy).toBe('bob')

		// Unresolve
		await tools.update_comment!.execute(
			{ filePath: '/f.ts', commentId, action: 'resolve', author: 'alice' },
			makeCtx(),
		)
		comments = fs.getComments('/f.ts')
		expect(comments[0]!.resolved).toBe(false)
	})

	test('createYStreamFsTools returns all 10 tools', () => {
		expect(Object.keys(tools).sort()).toEqual([
			'create_comment',
			'create_file',
			'delete_file',
			'edit',
			'glob',
			'grep',
			'list',
			'list_comments',
			'read',
			'update_comment',
		])
	})
})
