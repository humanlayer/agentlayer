import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadTool } from '../src/tools/server/read'
import { isBinaryFile } from '../src/util/binary'
import { makeToolContext } from './mocks'

/** Helper: create a tmp dir, run the test, clean up. */
async function withTmpDir(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), 'binary-test-'))
	try {
		await fn(dir)
	} finally {
		await rm(dir, { recursive: true })
	}
}

/** Helper: write bytes and call isBinaryFile. */
async function checkBytes(dir: string, name: string, bytes: Uint8Array): Promise<boolean> {
	const filePath = join(dir, name)
	await writeFile(filePath, Buffer.from(bytes))
	return isBinaryFile(filePath, Bun.file(filePath).size)
}

/** Build a Uint8Array with a precise ratio of non-printable (0x01) to printable (0x41) bytes. */
function buildRatioBytes(total: number, nonPrintableCount: number): Uint8Array {
	const bytes = new Uint8Array(total)
	for (let i = 0; i < nonPrintableCount; i++) bytes[i] = 0x01
	for (let i = nonPrintableCount; i < total; i++) bytes[i] = 0x41 // 'A'
	return bytes
}

// ─── isBinaryFile — extension check ─────────────────────────────────────────

describe('isBinaryFile — extension allowlist', () => {
	test('rejects .zip by extension even when content is pure text', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'archive.zip')
			await writeFile(filePath, 'this is actually text')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(true)
		})
	})

	test('rejects .wasm by extension', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'module.wasm')
			await writeFile(filePath, 'text content')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(true)
		})
	})

	test('rejects .exe by extension', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'program.exe')
			await writeFile(filePath, 'text content')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(true)
		})
	})

	test('extension check is case-insensitive', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'ARCHIVE.ZIP')
			await writeFile(filePath, 'text content')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(true)
		})
	})

	test('allows .ts files (not in allowlist)', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'code.ts')
			await writeFile(filePath, 'const x = 1')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('allows .md files (not in allowlist)', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'readme.md')
			await writeFile(filePath, '# Hello')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})
})

// ─── isBinaryFile — null byte detection ─────────────────────────────────────

describe('isBinaryFile — null byte detection', () => {
	test('single null byte in otherwise text content → binary', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'has-null.txt')
			await writeFile(filePath, Buffer.from('hello\x00world'))
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(true)
		})
	})

	test('null byte at position 0 → binary', async () => {
		await withTmpDir(async (dir) => {
			const bytes = new Uint8Array(10)
			bytes.fill(0x41) // all 'A'
			bytes[0] = 0x00
			expect(await checkBytes(dir, 'null-first.txt', bytes)).toBe(true)
		})
	})

	test('null byte at end of buffer → binary', async () => {
		await withTmpDir(async (dir) => {
			const bytes = new Uint8Array(10)
			bytes.fill(0x41)
			bytes[9] = 0x00
			expect(await checkBytes(dir, 'null-last.txt', bytes)).toBe(true)
		})
	})
})

// ─── isBinaryFile — 30% threshold boundary ──────────────────────────────────

describe('isBinaryFile — 30% non-printable threshold', () => {
	// The condition is `nonPrintable / buffer.length > 0.3` (strictly greater than)
	// so exactly 30% should be allowed, 31% should be rejected.

	test('exactly 30% non-printable (30/100) → allowed (threshold is strictly >)', async () => {
		await withTmpDir(async (dir) => {
			const bytes = buildRatioBytes(100, 30)
			expect(await checkBytes(dir, 'exactly-30.unknown', bytes)).toBe(false)
		})
	})

	test('31% non-printable (31/100) → binary', async () => {
		await withTmpDir(async (dir) => {
			const bytes = buildRatioBytes(100, 31)
			expect(await checkBytes(dir, 'just-over-30.unknown', bytes)).toBe(true)
		})
	})

	test('29% non-printable (29/100) → allowed', async () => {
		await withTmpDir(async (dir) => {
			const bytes = buildRatioBytes(100, 29)
			expect(await checkBytes(dir, 'under-30.unknown', bytes)).toBe(false)
		})
	})

	test('100% non-printable (no null bytes) → binary', async () => {
		await withTmpDir(async (dir) => {
			const bytes = new Uint8Array(100)
			bytes.fill(0x01) // all non-printable, no null
			expect(await checkBytes(dir, 'all-nonprint.unknown', bytes)).toBe(true)
		})
	})

	test('0% non-printable → allowed', async () => {
		await withTmpDir(async (dir) => {
			const bytes = new Uint8Array(100)
			bytes.fill(0x41) // all 'A'
			expect(await checkBytes(dir, 'all-print.unknown', bytes)).toBe(false)
		})
	})
})

// ─── isBinaryFile — specific byte ranges ────────────────────────────────────

describe('isBinaryFile — byte classification', () => {
	// Non-printable bytes: 0x01-0x08, 0x0e-0x1a, 0x1c-0x1f
	// Printable/allowed: 0x09-0x0d (tab, LF, VT, FF, CR), 0x1b (ESC), 0x20-0x7e, 0x80+

	test('tab (0x09) is not counted as non-printable', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'tabs.txt')
			await writeFile(filePath, 'col1\tcol2\tcol3\r\nval1\tval2\tval3\r\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('ESC (0x1b) is not counted as non-printable', async () => {
		await withTmpDir(async (dir) => {
			// ANSI escape sequences are common in terminal output
			const filePath = join(dir, 'ansi.txt')
			await writeFile(filePath, '\x1b[31mred text\x1b[0m\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('bytes 0x01-0x08 are counted as non-printable', async () => {
		await withTmpDir(async (dir) => {
			// 100 bytes: 31 of 0x05 (SOH-BS range), 69 of 'A' → 31% > 30% → binary
			const bytes = buildRatioBytes(100, 31)
			bytes[0] = 0x05 // replace first non-printable with one from 0x01-0x08 range
			expect(await checkBytes(dir, 'low-control.dat', bytes)).toBe(true)
		})
	})

	test('bytes >= 0x80 (high bytes) are NOT counted as non-printable', async () => {
		await withTmpDir(async (dir) => {
			// File of entirely high bytes — these are NOT flagged by the heuristic
			const bytes = new Uint8Array(100)
			bytes.fill(0x80)
			expect(await checkBytes(dir, 'high-bytes.unknown', bytes)).toBe(false)
		})
	})
})

// ─── isBinaryFile — UTF-8 and multi-byte text ───────────────────────────────

describe('isBinaryFile — UTF-8 text is not falsely flagged', () => {
	test('Chinese text (CJK characters) → allowed', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'chinese.txt')
			// 你好世界 = 12 bytes in UTF-8, all in 0x80+ range
			await writeFile(filePath, '你好世界\n这是一个测试文件\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('emoji content → allowed', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'emoji.txt')
			await writeFile(filePath, '🎉🚀💻🔥 emoji everywhere 🌍\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('mixed ASCII and multi-byte UTF-8 → allowed', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'mixed-utf8.txt')
			await writeFile(filePath, 'const greeting = "こんにちは";\nconsole.log(greeting);\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('file that is 100% multi-byte UTF-8 (no ASCII) → allowed', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'pure-cjk.txt')
			// Pure CJK with no ASCII at all — every byte is >= 0x80
			await writeFile(filePath, '漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})
})

// ─── isBinaryFile — edge cases ──────────────────────────────────────────────

describe('isBinaryFile — edge cases', () => {
	test('empty file → not binary', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'empty.txt')
			await writeFile(filePath, '')
			expect(await isBinaryFile(filePath, 0)).toBe(false)
		})
	})

	test('file without extension is checked by content (text)', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'Makefile')
			await writeFile(filePath, 'all:\n\techo hello\n')
			expect(await isBinaryFile(filePath, Bun.file(filePath).size)).toBe(false)
		})
	})

	test('file without extension is checked by content (binary)', async () => {
		await withTmpDir(async (dir) => {
			const bytes = new Uint8Array(100)
			bytes.fill(0x01)
			expect(await checkBytes(dir, 'binary-no-ext', bytes)).toBe(true)
		})
	})

	test('single-byte file with printable byte → not binary', async () => {
		await withTmpDir(async (dir) => {
			expect(await checkBytes(dir, 'one.txt', new Uint8Array([0x41]))).toBe(false)
		})
	})

	test('single-byte file with non-printable byte → not binary (1/1 = 100% but no null)', async () => {
		await withTmpDir(async (dir) => {
			// 1/1 = 1.0 > 0.3, so this IS binary
			expect(await checkBytes(dir, 'one-np.txt', new Uint8Array([0x01]))).toBe(true)
		})
	})
})

// ─── createReadTool — binary rejection integration ──────────────────────────

describe('createReadTool — binary file rejection', () => {
	test('throws "Cannot read binary file: <path>" on binary extension', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'data.zip')
			await writeFile(filePath, 'fake zip content')
			const readTool = createReadTool()
			const err = await readTool.execute({ filePath, limit: 2000 }, makeToolContext()).catch((e: Error) => e)
			expect(err).toBeInstanceOf(Error)
			expect((err as Error).message).toBe(`Cannot read binary file: ${filePath}`)
		})
	})

	test('throws on file with null bytes (content-detected binary)', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'data.unknown')
			await writeFile(filePath, Buffer.from('hello\x00world'))
			const readTool = createReadTool()
			const err = await readTool.execute({ filePath, limit: 2000 }, makeToolContext()).catch((e: Error) => e)
			expect(err).toBeInstanceOf(Error)
			expect((err as Error).message).toBe(`Cannot read binary file: ${filePath}`)
		})
	})

	test('reads text file and returns full content with line numbers', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'code.ts')
			await writeFile(filePath, 'const x = 1\nconst y = 2\n')
			const readTool = createReadTool()
			const result = await readTool.execute({ filePath, limit: 2000 }, makeToolContext())
			// Should be the raw text (serialize is separate)
			expect(result).toBe('const x = 1\nconst y = 2\n')
		})
	})

	test('reads UTF-8 text file without false positive', async () => {
		await withTmpDir(async (dir) => {
			const filePath = join(dir, 'i18n.ts')
			await writeFile(filePath, 'const msg = "你好世界 🌍";\n')
			const readTool = createReadTool()
			const result = await readTool.execute({ filePath, limit: 2000 }, makeToolContext())
			expect(result).toBe('const msg = "你好世界 🌍";\n')
		})
	})
})
