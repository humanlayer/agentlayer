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
 * Stage 1: Extension allowlist — known binary extensions are rejected immediately.
 * Stage 2: Byte-level heuristic — read first 4096 bytes, any null byte → binary,
 *          >30% non-printable bytes → binary.
 */
export async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
	// Stage 1: extension check
	const lastDot = filepath.lastIndexOf('.')
	if (lastDot !== -1) {
		const ext = filepath.slice(lastDot).toLowerCase()
		if (BINARY_EXTENSIONS.has(ext)) {
			return true
		}
	}

	// Empty files are not binary
	if (fileSize === 0) {
		return false
	}

	// Stage 2: byte-level heuristic on first 4096 bytes
	const sampleSize = Math.min(4096, fileSize)
	const blob = Bun.file(filepath).slice(0, sampleSize)
	const buffer = new Uint8Array(await blob.arrayBuffer())

	let nonPrintable = 0
	for (const byte of buffer) {
		// Null byte — definitive binary signal
		if (byte === 0) {
			return true
		}
		// Non-printable: outside 0x09–0x0d (tab, newline, CR, etc.) and 0x20–0x7e (printable ASCII)
		if ((byte < 0x09 || (byte > 0x0d && byte < 0x20)) && byte !== 0x1b) {
			nonPrintable++
		}
	}

	// >30% non-printable → binary
	return nonPrintable / buffer.length > 0.3
}
