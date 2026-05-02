import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatLineHash } from '@humanlayer/agentlayer-core/utils'
import { createHashlineEditTool } from '../src/tools/hashline-edit'
import { makeToolContext } from './mocks'

type HashlineToolResult = Awaited<ReturnType<ReturnType<typeof createHashlineEditTool>['execute']>>
function assertHashlineResult(
	result: HashlineToolResult,
): asserts result is Extract<HashlineToolResult, { content: string }> {
	if (!('content' in result)) throw new Error('expected hashline edit result')
}

async function withTempFile(content: string, fn: (filePath: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), 'hashline-edit-tool-test-'))
	try {
		const filePath = join(dir, 'test.ts')
		await writeFile(filePath, content)
		await fn(filePath)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe('createHashlineEditTool', () => {
	test('replaces a single anchored line', async () => {
		await withTempFile('}\nconst x = 1\n', async (filePath) => {
			const anchor = formatLineHash(2, 'const x = 1')
			const result = await createHashlineEditTool().execute(
				{ path: filePath, edits: [{ loc: { range: { pos: anchor, end: anchor } }, content: ['const x = 2'] }] },
				makeToolContext(),
			)
			assertHashlineResult(result)
			expect(result.editCount).toBe(1)
			expect(await readFile(filePath, 'utf8')).toBe('}\nconst x = 2\n')
		})
	})

	test('replaces inclusive ranges and deletes ranges', async () => {
		await withTempFile('a\nb\nc\nd', async (filePath) => {
			const tool = createHashlineEditTool()
			await tool.execute(
				{
					path: filePath,
					edits: [
						{
							loc: { range: { pos: formatLineHash(2, 'b'), end: formatLineHash(3, 'c') } },
							content: ['B', 'C'],
						},
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\nB\nC\nd')
			await tool.execute(
				{
					path: filePath,
					edits: [
						{ loc: { range: { pos: formatLineHash(2, 'B'), end: formatLineHash(3, 'C') } }, content: null },
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\nd')
		})
	})

	test('appends and prepends file content', async () => {
		await withTempFile('middle', async (filePath) => {
			await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{ loc: 'append', content: ['end'] },
						{ loc: 'prepend', content: ['start'] },
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('start\nmiddle\nend')
		})
	})

	test('appends and prepends at anchors', async () => {
		await withTempFile('a\nb', async (filePath) => {
			await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{ loc: { append: formatLineHash(1, 'a') }, content: ['after a'] },
						{ loc: { prepend: formatLineHash(2, 'b') }, content: ['before b'] },
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\nafter a\nbefore b\nb')
		})
	})

	test('stale anchor rejects and leaves file unchanged', async () => {
		await withTempFile('alpha\nbeta\ngamma', async (filePath) => {
			const before = await readFile(filePath, 'utf8')
			await expect(
				createHashlineEditTool().execute(
					{
						path: filePath,
						edits: [
							{
								loc: {
									range: {
										pos: `2${formatLineHash(2, 'other').slice(1)}`,
										end: `2${formatLineHash(2, 'other').slice(1)}`,
									},
								},
								content: ['BETA'],
							},
						],
					},
					makeToolContext(),
				),
			).rejects.toThrow('Edit rejected')
			expect(await readFile(filePath, 'utf8')).toBe(before)
		})
	})

	test('auto-rebases shifted anchors and warns', async () => {
		await withTempFile('inserted\ntarget\nend', async (filePath) => {
			const staleAnchor = `1${formatLineHash(2, 'target').replace(/^\d+/, '')}`
			const result = await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [{ loc: { range: { pos: staleAnchor, end: staleAnchor } }, content: ['updated'] }],
				},
				makeToolContext(),
			)
			assertHashlineResult(result)
			expect(result.warnings?.join('\n')).toContain('Auto-rebased anchor')
			expect(await readFile(filePath, 'utf8')).toBe('inserted\nupdated\nend')
		})
	})

	test('ambiguous rebase rejects and leaves file unchanged', async () => {
		await withTempFile('same\nother\nsame', async (filePath) => {
			const hash = formatLineHash(1, 'same').replace(/^\d+/, '')
			const before = await readFile(filePath, 'utf8')
			await expect(
				createHashlineEditTool().execute(
					{
						path: filePath,
						edits: [{ loc: { range: { pos: `2${hash}`, end: `2${hash}` } }, content: ['updated'] }],
					},
					makeToolContext(),
				),
			).rejects.toThrow('Edit rejected')
			expect(await readFile(filePath, 'utf8')).toBe(before)
		})
	})

	test('invalid hash-only anchor errors with full-anchor guidance', async () => {
		await withTempFile('a', async (filePath) => {
			await expect(
				createHashlineEditTool().execute(
					{ path: filePath, edits: [{ loc: { append: 'sr' }, content: ['b'] }] },
					makeToolContext(),
				),
			).rejects.toThrow('full anchor')
		})
	})

	test('strips pasted hashline-prefixed content before writing', async () => {
		await withTempFile('old', async (filePath) => {
			await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{
							loc: { range: { pos: formatLineHash(1, 'old'), end: formatLineHash(1, 'old') } },
							content: ['1st|new'],
						},
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('new')
		})
	})

	test('boundary duplication warning appears', async () => {
		await withTempFile('a\nb\nb', async (filePath) => {
			const result = await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{
							loc: { range: { pos: formatLineHash(1, 'a'), end: formatLineHash(1, 'a') } },
							content: ['b'],
						},
					],
				},
				makeToolContext(),
			)
			assertHashlineResult(result)
			expect(result.warnings?.join('\n')).toContain('Possible boundary duplication')
		})
	})

	test('duplicate identical edits are de-duped', async () => {
		await withTempFile('a', async (filePath) => {
			const anchor = formatLineHash(1, 'a')
			await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{ loc: { append: anchor }, content: ['b'] },
						{ loc: { append: anchor }, content: ['b'] },
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\nb')
		})
	})

	test('empty insert content defaults to blank line', async () => {
		await withTempFile('a', async (filePath) => {
			await createHashlineEditTool().execute(
				{ path: filePath, edits: [{ loc: { append: formatLineHash(1, 'a') }, content: null }] },
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\n')
		})
	})

	test('missing file with only top-level append/prepend creates file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hashline-edit-tool-test-'))
		try {
			const filePath = join(dir, 'new.ts')
			await createHashlineEditTool().execute(
				{
					path: filePath,
					edits: [
						{ loc: 'append', content: ['b'] },
						{ loc: 'prepend', content: ['a'] },
					],
				},
				makeToolContext(),
			)
			expect(await readFile(filePath, 'utf8')).toBe('a\nb')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test('missing file with anchored loc throws and does not create file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hashline-edit-tool-test-'))
		try {
			const filePath = join(dir, 'new.ts')
			await expect(
				createHashlineEditTool().execute(
					{ path: filePath, edits: [{ loc: { append: '1st' }, content: ['x'] }] },
					makeToolContext(),
				),
			).rejects.toThrow(`File not found: ${filePath}`)
			await expect(readFile(filePath, 'utf8')).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
