import { describe, expect, test } from 'bun:test'
import { AlreadyExistsError, NotBinaryFileError, NotTextFileError, YjsFilesystem } from '@humanlayer/yjs-fs'

describe('YjsFilesystem binary files', () => {
	test('creates, reads, writes, renames, and deletes binary files', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/assets')

		const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const entryId = filesystem.createBinaryFile('/assets/logo.png', pngHeader)
		const initialStat = filesystem.stat('/assets/logo.png')

		expect(initialStat.entryId).toBe(entryId)
		expect(initialStat.contentId).toBeDefined()
		expect(initialStat.size).toBe(8)
		expect(initialStat.encoding).toBe('binary')
		expect(filesystem.readBinaryFile('/assets/logo.png')).toEqual(pngHeader)

		const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		filesystem.writeBinaryFile('/assets/logo.png', jpegHeader)
		expect(filesystem.readBinaryFile('/assets/logo.png')).toEqual(jpegHeader)
		expect(filesystem.stat('/assets/logo.png').size).toBe(4)

		filesystem.rename('/assets/logo.png', '/assets/header.jpg')
		expect(filesystem.exists('/assets/logo.png')).toBe(false)
		expect(filesystem.exists('/assets/header.jpg')).toBe(true)

		const renamedStat = filesystem.stat('/assets/header.jpg')
		expect(renamedStat.entryId).toBe(entryId)
		expect(renamedStat.contentId).toBe(initialStat.contentId)
		expect(renamedStat.encoding).toBe('binary')
		expect(filesystem.readBinaryFile('/assets/header.jpg')).toEqual(jpegHeader)

		filesystem.unlink('/assets/header.jpg')
		expect(filesystem.exists('/assets/header.jpg')).toBe(false)
	})

	test('rejects duplicate binary file creation', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/assets')
		filesystem.createBinaryFile('/assets/image.png', new Uint8Array([1, 2, 3]))

		expect(() => filesystem.createBinaryFile('/assets/image.png', new Uint8Array([4, 5, 6]))).toThrow(
			AlreadyExistsError,
		)
	})

	test('prevents text operations on binary files', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/assets')
		filesystem.createBinaryFile('/assets/data.bin', new Uint8Array([1, 2, 3]))

		expect(() => filesystem.readFile('/assets/data.bin')).toThrow(NotTextFileError)
		expect(() => filesystem.writeFile('/assets/data.bin', 'text')).toThrow(NotTextFileError)
		expect(() => filesystem.editFile('/assets/data.bin', 'a', 'b')).toThrow(NotTextFileError)
	})

	test('prevents binary operations on text files', () => {
		const filesystem = new YjsFilesystem()
		filesystem.mkdir('/docs')
		filesystem.createFile('/docs/readme.txt', 'hello')

		expect(() => filesystem.readBinaryFile('/docs/readme.txt')).toThrow(NotBinaryFileError)
		expect(() => filesystem.writeBinaryFile('/docs/readme.txt', new Uint8Array([1, 2, 3]))).toThrow(
			NotBinaryFileError,
		)
	})

	test('handles empty binary files', () => {
		const filesystem = new YjsFilesystem()
		filesystem.createBinaryFile('/empty.bin')

		expect(filesystem.readBinaryFile('/empty.bin')).toEqual(new Uint8Array(0))
		expect(filesystem.stat('/empty.bin').size).toBe(0)
	})

	test('handles large binary files', () => {
		const filesystem = new YjsFilesystem()
		const largeData = new Uint8Array(50000)
		for (let index = 0; index < largeData.length; index++) {
			largeData[index] = index % 256
		}

		filesystem.createBinaryFile('/large.bin', largeData)
		expect(filesystem.readBinaryFile('/large.bin')).toEqual(largeData)
		expect(filesystem.stat('/large.bin').size).toBe(50000)
	})
})
