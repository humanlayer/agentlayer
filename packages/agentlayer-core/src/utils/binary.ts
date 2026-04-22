import { open } from 'node:fs/promises'

const BINARY_EXTENSIONS = new Set([
	'.zip',
	'.tar',
	'.gz',
	'.exe',
	'.dll',
	'.so',
	'.class',
	'.jar',
	'.war',
	'.7z',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.ppt',
	'.pptx',
	'.odt',
	'.ods',
	'.odp',
	'.bin',
	'.dat',
	'.obj',
	'.o',
	'.a',
	'.lib',
	'.wasm',
	'.pyc',
	'.pyo',
])

/**
 * Two-stage binary file detection following OpenCode's pattern.
 *
 * Stage 1: Extension allowlist - known binary extensions are rejected immediately.
 * Stage 2: Byte-level heuristic - read first 4096 bytes, any null byte -> binary,
 *          >30% non-printable bytes -> binary.
 */
export async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
	const lastDot = filepath.lastIndexOf('.')
	if (lastDot !== -1) {
		const ext = filepath.slice(lastDot).toLowerCase()
		if (BINARY_EXTENSIONS.has(ext)) {
			return true
		}
	}

	if (fileSize === 0) {
		return false
	}

	const sampleSize = Math.min(4096, fileSize)
	const fileHandle = await open(filepath, 'r')
	try {
		const buffer = new Uint8Array(sampleSize)
		const { bytesRead } = await fileHandle.read(buffer, 0, sampleSize, 0)
		const sample = buffer.subarray(0, bytesRead)
		if (sample.length === 0) {
			return false
		}

		let nonPrintable = 0
		for (const byte of sample) {
			if (byte === 0) {
				return true
			}
			if ((byte < 0x09 || (byte > 0x0d && byte < 0x20)) && byte !== 0x1b) {
				nonPrintable++
			}
		}

		return nonPrintable / sample.length > 0.3
	} finally {
		await fileHandle.close()
	}
}
