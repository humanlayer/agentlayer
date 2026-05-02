import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'
import { YjsFsBashAdapter } from '../src/adapter'

describe('YjsFsBashAdapter', () => {
	test('readFile returns content from YjsFilesystem', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/hello.txt', 'hello')
		const adapter = new YjsFsBashAdapter(fs)

		expect(await adapter.readFile('/hello.txt')).toBe('hello')
	})

	test('readFileBuffer returns binary content', async () => {
		const fs = new YjsFilesystem()
		fs.createBinaryFile('/data.bin', new Uint8Array([1, 2, 3]))
		const adapter = new YjsFsBashAdapter(fs)

		expect(Array.from(await adapter.readFileBuffer('/data.bin'))).toEqual([1, 2, 3])
	})

	test('writeFile creates and overwrites text files', async () => {
		const fs = new YjsFilesystem()
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.writeFile('/note.txt', 'first')
		expect(fs.readFile('/note.txt')).toBe('first')

		await adapter.writeFile('/note.txt', 'second')
		expect(fs.readFile('/note.txt')).toBe('second')
	})

	test('appendFile appends and creates missing files', async () => {
		const fs = new YjsFilesystem()
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.appendFile('/log.txt', 'one')
		await adapter.appendFile('/log.txt', ' two')

		expect(fs.readFile('/log.txt')).toBe('one two')
	})

	test('exists returns true and false for paths', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/exists.txt', '')
		const adapter = new YjsFsBashAdapter(fs)

		expect(await adapter.exists('/exists.txt')).toBe(true)
		expect(await adapter.exists('/missing.txt')).toBe(false)
	})

	test('stat maps file and directory info', async () => {
		const fs = new YjsFilesystem()
		fs.mkdir('/dir')
		fs.createFile('/dir/file.txt', 'hello')
		const adapter = new YjsFsBashAdapter(fs)

		const fileStat = await adapter.stat('/dir/file.txt')
		const dirStat = await adapter.stat('/dir')

		expect(fileStat.isFile).toBe(true)
		expect(fileStat.isDirectory).toBe(false)
		expect(fileStat.size).toBe(5)
		expect(dirStat.isDirectory).toBe(true)
		expect(dirStat.isFile).toBe(false)
	})

	test('mkdir and readdir create and list directory entries', async () => {
		const fs = new YjsFilesystem()
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.mkdir('/src')
		await adapter.writeFile('/src/index.ts', 'export {}')

		expect(await adapter.readdir('/src')).toEqual(['index.ts'])
		expect(await adapter.readdirWithFileTypes('/src')).toEqual([
			{ name: 'index.ts', isFile: true, isDirectory: false, isSymbolicLink: false },
		])
	})

	test('rm removes file', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/delete.txt', 'bye')
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.rm('/delete.txt')

		expect(fs.exists('/delete.txt')).toBe(false)
	})

	test('mv renames file', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/old.txt', 'content')
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.mv('/old.txt', '/new.txt')

		expect(fs.exists('/old.txt')).toBe(false)
		expect(fs.readFile('/new.txt')).toBe('content')
	})

	test('cp copies text and binary files', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/source.txt', 'content')
		fs.createBinaryFile('/source.bin', new Uint8Array([4, 5, 6]))
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.cp('/source.txt', '/copy.txt')
		await adapter.cp('/source.bin', '/copy.bin')

		expect(fs.readFile('/copy.txt')).toBe('content')
		expect(Array.from(fs.readBinaryFile('/copy.bin'))).toEqual([4, 5, 6])
	})

	test('utimes no-ops for existing paths and errors for missing paths', async () => {
		const fs = new YjsFilesystem()
		fs.createFile('/file.txt', 'content')
		const adapter = new YjsFsBashAdapter(fs)

		await adapter.utimes('/file.txt', new Date(), new Date())

		expect(fs.exists('/file.txt')).toBe(true)
		expect(adapter.utimes('/missing.txt', new Date(), new Date())).rejects.toMatchObject({ code: 'ENOENT' })
	})
})
