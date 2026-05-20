import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBinaryFile } from '../src/utils/binary'
import { detectFileType } from '../src/utils/file-type'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'file-type-test-'))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function fileSize(path: string): Promise<number> {
	return (await stat(path)).size
}

describe('detectFileType', () => {
	test('detects text files and preserves legacy binary result', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'hello.txt')
			await writeFile(path, 'hello world\n')

			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'text' })
			expect(await isBinaryFile(path, await fileSize(path))).toBe(false)
		})
	})

	test('detects empty files as text', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'empty.txt')
			await writeFile(path, new Uint8Array())

			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'text' })
			expect(await isBinaryFile(path, await fileSize(path))).toBe(false)
		})
	})

	test('detects PNG files', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'image.png')
			await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'image', mediaType: 'image/png' })
		})
	})

	test('detects JPEG files', async () => {
		await withTempDir(async (dir) => {
			const jpgPath = join(dir, 'photo.jpg')
			const jpegPath = join(dir, 'photo.jpeg')
			await writeFile(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]))
			await writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))

			expect(await detectFileType(jpgPath, await fileSize(jpgPath))).toEqual({
				type: 'image',
				mediaType: 'image/jpeg',
			})
			expect(await detectFileType(jpegPath, await fileSize(jpegPath))).toEqual({
				type: 'image',
				mediaType: 'image/jpeg',
			})
		})
	})

	test('detects GIF files', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'animation.gif')
			await writeFile(path, Buffer.from('GIF89a'))
			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'image', mediaType: 'image/gif' })
		})
	})

	test('detects WEBP files', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'image.webp')
			await writeFile(path, Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'image', mediaType: 'image/webp' })
		})
	})

	test('detects PDF files', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'document.pdf')
			await writeFile(path, Buffer.from('%PDF-1.7\n'))
			expect(await detectFileType(path, await fileSize(path))).toEqual({
				type: 'pdf',
				mediaType: 'application/pdf',
			})
		})
	})

	test('detects unsupported binary files and preserves legacy binary result', async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, 'archive.zip')
			await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))

			expect(await detectFileType(path, await fileSize(path))).toEqual({ type: 'unsupported-binary' })
			expect(await isBinaryFile(path, await fileSize(path))).toBe(true)
		})
	})
})
