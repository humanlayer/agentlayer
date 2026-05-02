import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHashReadTool } from '../src/tools/hash-read'
import { makeToolContext } from './mocks'

function serializeRaw<TInput, TOutput>(
	tool: { serialize?: (raw: TOutput, input: TInput) => string },
	raw: TOutput,
	input: TInput,
): string {
	if (tool.serialize) return tool.serialize(raw, input)
	return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

describe('createHashReadTool', () => {
	test('has public read name', () => {
		expect(createHashReadTool().name).toBe('read')
	})

	test('reads with hashline serialization', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hash-read-tool-test-'))
		try {
			const filePath = join(dir, 'test.ts')
			await writeFile(filePath, '}\nconst x = 1')
			const tool = createHashReadTool()
			const raw = await tool.execute({ file_path: filePath, limit: 2000 }, makeToolContext())
			const serialized = serializeRaw(tool, raw, { file_path: filePath, limit: 2000 })
			expect(serialized).toContain('1st|}')
			expect(serialized).toContain('|const x = 1')
			expect(serialized).not.toContain('->')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('resolves relative paths against cwd', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hash-read-tool-test-'))
		try {
			await writeFile(join(dir, 'test.ts'), 'hello')
			const raw = await createHashReadTool({ cwd: dir }).execute(
				{ file_path: 'test.ts', limit: 2000 },
				makeToolContext(),
			)
			expect(raw).toBe('hello')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('rejects binary files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hash-read-tool-test-'))
		try {
			const filePath = join(dir, 'binary.bin')
			await writeFile(filePath, new Uint8Array([0, 1, 2, 3]))
			await expect(
				createHashReadTool().execute({ file_path: filePath, limit: 2000 }, makeToolContext()),
			).rejects.toThrow('Cannot read binary file')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
