import { describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplyPatchTool } from '../src/tools/server/apply-patch'
import { makeToolContext } from './mocks'

// ─── createApplyPatchTool ───────────────────────────────────────────────

describe('createApplyPatchTool', () => {
	test('tool has name "apply_patch"', () => {
		const tool = createApplyPatchTool()
		expect(tool.name).toBe('apply_patch')
	})

	test('throws when patchText is empty', async () => {
		const tool = createApplyPatchTool()
		await expect(tool.execute({ patchText: '' }, makeToolContext())).rejects.toThrow('patchText is required')
	})

	test('throws when patchText is whitespace only', async () => {
		const tool = createApplyPatchTool()
		await expect(tool.execute({ patchText: '   \n  ' }, makeToolContext())).rejects.toThrow('patchText is required')
	})

	test('throws on invalid patch format (missing markers)', async () => {
		const tool = createApplyPatchTool()
		await expect(tool.execute({ patchText: 'this is not a patch' }, makeToolContext())).rejects.toThrow(
			'apply_patch verification failed',
		)
	})

	// ── Add File ──────────────────────────────────────────────────────────────

	test('Add File: creates a new file with given content (+ prefix stripped)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'new-file.ts')
			const patch = [
				'*** Begin Patch',
				`*** Add File: ${filePath}`,
				'+export const greeting = "hello"',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			const result = await tool.execute({ patchText: patch }, makeToolContext())

			expect(result).toContain('Added')
			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('export const greeting = "hello"\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Add File: creates parent directories automatically', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'nested', 'deep', 'file.ts')
			const patch = ['*** Begin Patch', `*** Add File: ${filePath}`, '+const x = 1', '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('const x = 1\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Add File: overwrites an existing file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'existing.ts')
			await writeFile(filePath, 'old content\n')

			const patch = ['*** Begin Patch', `*** Add File: ${filePath}`, '+new content', '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toContain('new content')
			expect(content).not.toContain('old content')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Add File: multi-line content with + prefix', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'multi.ts')
			const patch = [
				'*** Begin Patch',
				`*** Add File: ${filePath}`,
				'+import { foo } from "bar"',
				'+',
				'+export function hello() {',
				'+  return "world"',
				'+}',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('import { foo } from "bar"\n\nexport function hello() {\n  return "world"\n}\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	// ── Update File ───────────────────────────────────────────────────────────

	test('Update File: modifies existing file content via hunks', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'index.ts')
			await writeFile(filePath, 'const x = 1\nconst y = 2\nconst z = 3\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				' const x = 1',
				'-const y = 2',
				'+const y = 99',
				' const z = 3',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			const result = await tool.execute({ patchText: patch }, makeToolContext())

			expect(result).toContain('Updated')
			const content = await readFile(filePath, 'utf-8')
			expect(content).toContain('const y = 99')
			expect(content).not.toContain('const y = 2')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: applies multi-hunk patch', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.ts')
			await writeFile(filePath, 'a\nb\nc\nd\ne\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				' a',
				'-b',
				'+B',
				'@@',
				' d',
				'-e',
				'+E',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toContain('B')
			expect(content).toContain('E')
			expect(content).not.toContain('\nb\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: throws when target file does not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'nonexistent.ts')
			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				' context line',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: throws when context lines do not match (verification failure)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.ts')
			await writeFile(filePath, 'completely different content\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				' context that does not exist',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)

			// Original file should be unchanged (no partial apply)
			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('completely different content\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: disambiguates with @@ change context', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.txt')
			await writeFile(filePath, 'fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@ fn b',
				'-x=10',
				'+x=11',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: EOF anchor matches from end of file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.txt')
			await writeFile(filePath, 'start\nmarker\nmiddle\nmarker\nend\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				'-marker',
				'-end',
				'+marker-changed',
				'+end',
				'*** End of File',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('start\nmarker\nmiddle\nmarker-changed\nend\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	// ── Delete File ───────────────────────────────────────────────────────────

	test('Delete File: removes an existing file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'to-delete.ts')
			await writeFile(filePath, 'delete me\n')

			const patch = ['*** Begin Patch', `*** Delete File: ${filePath}`, '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			const result = await tool.execute({ patchText: patch }, makeToolContext())

			expect(result).toContain('Deleted')
			await expect(access(filePath)).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Delete File: throws when file does not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'ghost.ts')
			const patch = ['*** Begin Patch', `*** Delete File: ${filePath}`, '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	// ── Move File ─────────────────────────────────────────────────────────────

	test('Move File: moves file to new path', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const srcPath = join(dir, 'old.ts')
			const dstPath = join(dir, 'new.ts')
			await writeFile(srcPath, 'const value = 42\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${srcPath}`,
				`*** Move to: ${dstPath}`,
				'@@',
				' const value = 42',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			const result = await tool.execute({ patchText: patch }, makeToolContext())

			expect(result).toContain('Moved')
			// Old file should be gone
			await expect(access(srcPath)).rejects.toThrow()
			// New file should exist with original content
			const content = await readFile(dstPath, 'utf-8')
			expect(content).toContain('const value = 42')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Move File: creates parent directories for destination', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const srcPath = join(dir, 'old.ts')
			const dstPath = join(dir, 'nested', 'new.ts')
			await writeFile(srcPath, 'const x = 1\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${srcPath}`,
				`*** Move to: ${dstPath}`,
				'@@',
				' const x = 1',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			await expect(access(srcPath)).rejects.toThrow()
			const content = await readFile(dstPath, 'utf-8')
			expect(content).toContain('const x = 1')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	// ── Multi-operation patch ─────────────────────────────────────────────────

	test('Multi-operation: add + update + delete applied atomically', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const toUpdatePath = join(dir, 'update-me.ts')
			const toDeletePath = join(dir, 'delete-me.ts')
			const toAddPath = join(dir, 'add-me.ts')

			await writeFile(toUpdatePath, 'const x = 1\nconst y = 2\n')
			await writeFile(toDeletePath, 'delete me\n')

			const patch = [
				'*** Begin Patch',
				`*** Add File: ${toAddPath}`,
				'+export const added = true',
				`*** Update File: ${toUpdatePath}`,
				'@@',
				' const x = 1',
				'-const y = 2',
				'+const y = 99',
				`*** Delete File: ${toDeletePath}`,
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			const result = await tool.execute({ patchText: patch }, makeToolContext())

			expect(result).toContain('Added')
			expect(result).toContain('Updated')
			expect(result).toContain('Deleted')

			// Verify each operation
			const addedContent = await readFile(toAddPath, 'utf-8')
			expect(addedContent).toContain('added')

			const updatedContent = await readFile(toUpdatePath, 'utf-8')
			expect(updatedContent).toContain('const y = 99')

			await expect(access(toDeletePath)).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Atomicity: verification failure prevents any writes', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const goodFile = join(dir, 'good.ts')
			const badFile = join(dir, 'bad.ts')
			await writeFile(goodFile, 'good content\n')
			await writeFile(badFile, 'bad content\n')

			// First op would succeed, second op fails validation
			const patch = [
				'*** Begin Patch',
				`*** Update File: ${goodFile}`,
				'@@',
				' good content',
				'-good content',
				'+new content',
				`*** Update File: ${badFile}`,
				'@@',
				' context that does not exist in bad file',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)

			// good.ts should be unchanged because validation ran before writes
			const content = await readFile(goodFile, 'utf-8')
			expect(content).toBe('good content\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: insert-only chunk (no remove lines)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.ts')
			await writeFile(filePath, 'line 1\nline 2\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				' line 1',
				'+inserted line',
				' line 2',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toContain('inserted line')
			expect(content).toContain('line 1')
			expect(content).toContain('line 2')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: trailing newline preserved', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.ts')
			await writeFile(filePath, 'const x = 1\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				'-const x = 1',
				'+const x = 42',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('const x = 42\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: heredoc-wrapped patch (bare <<EOF)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.ts')
			await writeFile(filePath, 'const x = 1\n')

			const inner = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@',
				'-const x = 1',
				'+const x = 42',
				'*** End Patch',
			].join('\n')
			const patch = `<<'EOF'\n${inner}\nEOF`

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('const x = 42\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	// ── Tests ported from opencode ──────────────────────────────────────────

	test('rejects valid-but-empty patch (no operations)', async () => {
		const tool = createApplyPatchTool()
		await expect(tool.execute({ patchText: '*** Begin Patch\n*** End Patch' }, makeToolContext())).rejects.toThrow(
			'patch rejected: empty patch',
		)
	})

	test('rejects unknown hunk header type', async () => {
		const tool = createApplyPatchTool()
		await expect(
			tool.execute({ patchText: '*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch' }, makeToolContext()),
		).rejects.toThrow('patch rejected: empty patch')
	})

	test('Add File: written content includes trailing newline', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'newfile.txt')
			const patch = ['*** Begin Patch', `*** Add File: ${filePath}`, '+new content', '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('new content\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Add File: overwrites existing file with trailing newline', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'duplicate.txt')
			await writeFile(filePath, 'old content\n')

			const patch = ['*** Begin Patch', `*** Add File: ${filePath}`, '+new content', '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('new content\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Move File: overwrites existing destination', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const srcPath = join(dir, 'source.txt')
			const dstPath = join(dir, 'dest.txt')
			await writeFile(srcPath, 'from\n')
			await writeFile(dstPath, 'existing dest content\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${srcPath}`,
				`*** Move to: ${dstPath}`,
				'@@',
				'-from',
				'+new',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await tool.execute({ patchText: patch }, makeToolContext())

			await expect(access(srcPath)).rejects.toThrow()
			const content = await readFile(dstPath, 'utf-8')
			expect(content).toBe('new\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Delete File: rejects when target is a directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const dirPath = join(dir, 'subdir')
			await mkdir(dirPath)

			const patch = ['*** Begin Patch', `*** Delete File: ${dirPath}`, '*** End Patch'].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Atomicity: add-then-failing-update leaves add file unwritten', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const addPath = join(dir, 'new-file.txt')
			const updatePath = join(dir, 'existing.txt')
			await writeFile(updatePath, 'some content\n')

			// Add would succeed, but update fails validation — nothing should be written
			const patch = [
				'*** Begin Patch',
				`*** Add File: ${addPath}`,
				'+brand new file',
				`*** Update File: ${updatePath}`,
				'@@',
				' context that does not exist',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)

			// The add file should NOT have been created
			await expect(access(addPath)).rejects.toThrow()
			// The existing file should be unchanged
			const content = await readFile(updatePath, 'utf-8')
			expect(content).toBe('some content\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})

	test('Update File: change_context not found throws', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'))
		try {
			const filePath = join(dir, 'file.txt')
			await writeFile(filePath, 'fn a\nx=10\ny=2\n')

			const patch = [
				'*** Begin Patch',
				`*** Update File: ${filePath}`,
				'@@ fn nonexistent',
				'-x=10',
				'+x=11',
				'*** End Patch',
			].join('\n')

			const tool = createApplyPatchTool()
			await expect(tool.execute({ patchText: patch }, makeToolContext())).rejects.toThrow(
				'apply_patch verification failed',
			)

			// File should be unchanged
			const content = await readFile(filePath, 'utf-8')
			expect(content).toBe('fn a\nx=10\ny=2\n')
		} finally {
			await rm(dir, { recursive: true })
		}
	})
})
