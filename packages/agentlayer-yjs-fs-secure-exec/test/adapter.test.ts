import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { YjsFsSecureExecAdapter } from '../src/adapter'

describe('YjsFsSecureExecAdapter', () => {
	test('readFile and readTextFile return content from YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/hello.txt', 'hello')
		fs.createBinaryFile('/data.bin', new Uint8Array([1, 2, 3]))
		const adapter = new YjsFsSecureExecAdapter(fs)

		expect(await adapter.readTextFile('/hello.txt')).toBe('hello')
		expect(Array.from(await adapter.readFile('/data.bin'))).toEqual([1, 2, 3])
	})

	test('writeFile creates and overwrites text and binary files', async () => {
		const fs = new YjsFilesystem()
		const adapter = new YjsFsSecureExecAdapter(fs)

		await adapter.writeFile('/note.txt', 'first')
		await adapter.writeFile('/note.txt', 'second')
		await adapter.writeFile('/blob.bin', new Uint8Array([4, 5]))

		expect(fs.readFile('/note.txt')).toBe('second')
		expect(Array.from(fs.readBinaryFile('/blob.bin'))).toEqual([4, 5])
	})

	test('readDir and readDirWithTypes list entries', async () => {
		const fs = new YjsFilesystem()
		fs.mkdir('/src')
		fs.createFile('/src/index.ts', 'export {}')
		const adapter = new YjsFsSecureExecAdapter(fs)

		expect(await adapter.readDir('/src')).toEqual(['index.ts'])
		expect(await adapter.readDirWithTypes('/src')).toEqual([{ name: 'index.ts', isDirectory: false }])
	})

	test('mkdir supports recursive creation', async () => {
		const fs = new YjsFilesystem()
		const adapter = new YjsFsSecureExecAdapter(fs)

		await adapter.mkdir('/a/b/c', { recursive: true })

		expect(fs.stat('/a/b/c').isDirectory).toBe(true)
	})

	test('exists and stat return path metadata', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/file.txt', 'hello')
		const adapter = new YjsFsSecureExecAdapter(fs)

		const stat = await adapter.stat('/file.txt')

		expect(await adapter.exists('/file.txt')).toBe(true)
		expect(await adapter.exists('/missing.txt')).toBe(false)
		expect(stat.isDirectory).toBe(false)
		expect(stat.size).toBe(5)
	})

	test('removeFile, removeDir, and rename update YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/old.txt', 'content')
		fs.mkdir('/dir')
		fs.createFile('/delete.txt', 'bye')
		const adapter = new YjsFsSecureExecAdapter(fs)

		await adapter.rename('/old.txt', '/new.txt')
		await adapter.removeFile('/delete.txt')
		await adapter.removeDir('/dir')

		expect(fs.readFile('/new.txt')).toBe('content')
		expect(fs.exists('/delete.txt')).toBe(false)
		expect(fs.exists('/dir')).toBe(false)
	})

	test('truncate shrinks text and binary files', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/text.txt', 'abcdef')
		fs.createBinaryFile('/bin.dat', new Uint8Array([1, 2, 3, 4]))
		const adapter = new YjsFsSecureExecAdapter(fs)

		await adapter.truncate('/text.txt', 3)
		await adapter.truncate('/bin.dat', 2)

		expect(fs.readFile('/text.txt')).toBe('abc')
		expect(Array.from(fs.readBinaryFile('/bin.dat'))).toEqual([1, 2])
	})

	test('operation tracking records filesystem operations', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/file.txt', 'hello')
		const adapter = new YjsFsSecureExecAdapter(fs)

		await adapter.readTextFile('/file.txt')
		await adapter.writeFile('/out.txt', 'world')
		await adapter.readDir('/')
		await adapter.rename('/out.txt', '/renamed.txt')

		expect(adapter.consumeOperations()).toEqual([
			{ type: 'read', path: '/file.txt', pathType: 'file' },
			{ type: 'write', path: '/out.txt', pathType: 'file' },
			{ type: 'list', path: '/', pathType: 'directory' },
			{ type: 'rename', path: '/out.txt', toPath: '/renamed.txt', pathType: 'file' },
		])
		expect(adapter.consumeOperations()).toEqual([])
	})
})
