import { open } from 'node:fs/promises'
import { isBinaryFile } from './binary'

export type DetectedFileType =
	| { type: 'text' }
	| { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
	| { type: 'pdf'; mediaType: 'application/pdf' }
	| { type: 'unsupported-binary' }

const IMAGE_EXTENSIONS = new Map<string, DetectedFileType>([
	['.png', { type: 'image', mediaType: 'image/png' }],
	['.jpg', { type: 'image', mediaType: 'image/jpeg' }],
	['.jpeg', { type: 'image', mediaType: 'image/jpeg' }],
	['.gif', { type: 'image', mediaType: 'image/gif' }],
	['.webp', { type: 'image', mediaType: 'image/webp' }],
])

const PDF_TYPE: DetectedFileType = { type: 'pdf', mediaType: 'application/pdf' }

function detectFromExtension(filepath: string): DetectedFileType | undefined {
	const lastDot = filepath.lastIndexOf('.')
	if (lastDot === -1) return undefined

	const ext = filepath.slice(lastDot).toLowerCase()
	if (ext === '.pdf') return PDF_TYPE
	return IMAGE_EXTENSIONS.get(ext)
}

function detectFromMagicBytes(sample: Uint8Array): DetectedFileType | undefined {
	if (
		sample.length >= 8 &&
		sample[0] === 0x89 &&
		sample[1] === 0x50 &&
		sample[2] === 0x4e &&
		sample[3] === 0x47 &&
		sample[4] === 0x0d &&
		sample[5] === 0x0a &&
		sample[6] === 0x1a &&
		sample[7] === 0x0a
	) {
		return { type: 'image', mediaType: 'image/png' }
	}

	if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
		return { type: 'image', mediaType: 'image/jpeg' }
	}

	if (
		sample.length >= 6 &&
		sample[0] === 0x47 &&
		sample[1] === 0x49 &&
		sample[2] === 0x46 &&
		sample[3] === 0x38 &&
		(sample[4] === 0x37 || sample[4] === 0x39) &&
		sample[5] === 0x61
	) {
		return { type: 'image', mediaType: 'image/gif' }
	}

	if (
		sample.length >= 12 &&
		sample[0] === 0x52 &&
		sample[1] === 0x49 &&
		sample[2] === 0x46 &&
		sample[3] === 0x46 &&
		sample[8] === 0x57 &&
		sample[9] === 0x45 &&
		sample[10] === 0x42 &&
		sample[11] === 0x50
	) {
		return { type: 'image', mediaType: 'image/webp' }
	}

	if (
		sample.length >= 5 &&
		sample[0] === 0x25 &&
		sample[1] === 0x50 &&
		sample[2] === 0x44 &&
		sample[3] === 0x46 &&
		sample[4] === 0x2d
	) {
		return PDF_TYPE
	}
}

async function readSample(filepath: string, fileSize: number): Promise<Uint8Array> {
	if (fileSize === 0) return new Uint8Array()

	const sampleSize = Math.min(16, fileSize)
	const fileHandle = await open(filepath, 'r')
	try {
		const buffer = new Uint8Array(sampleSize)
		const { bytesRead } = await fileHandle.read(buffer, 0, sampleSize, 0)
		return buffer.subarray(0, bytesRead)
	} finally {
		await fileHandle.close()
	}
}

export async function detectFileType(filepath: string, fileSize: number): Promise<DetectedFileType> {
	const sample = await readSample(filepath, fileSize)
	const magicType = detectFromMagicBytes(sample)
	if (magicType) return magicType

	const extensionType = detectFromExtension(filepath)
	if (extensionType) return extensionType

	if (await isBinaryFile(filepath, fileSize)) {
		return { type: 'unsupported-binary' }
	}

	return { type: 'text' }
}
