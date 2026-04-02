import { describe, expect, test } from 'bun:test'
import { applyUpdateChunks, parsePatch, stripHeredoc, validateHunks } from '../src/util/patch-parser'

// ─── stripHeredoc ─────────────────────────────────────────────────────────────

describe('stripHeredoc', () => {
	test('strips cat <<EOF...EOF wrapper', () => {
		const patch = `cat <<'EOF'\n*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch\nEOF`
		const stripped = stripHeredoc(patch)
		expect(stripped).toContain('*** Begin Patch')
		expect(stripped).not.toContain("cat <<'EOF'")
	})

	test('strips <<EOF...EOF wrapper without cat', () => {
		const patch = `<<'EOF'\n*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch\nEOF`
		const stripped = stripHeredoc(patch)
		expect(stripped).toContain('*** Begin Patch')
		expect(stripped).not.toContain("<<'EOF'")
	})

	test('strips bare <<EOF without quotes', () => {
		const patch = `<<EOF\n*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch\nEOF`
		const stripped = stripHeredoc(patch)
		expect(stripped).toContain('*** Begin Patch')
		expect(stripped).not.toContain('<<EOF')
	})

	test('returns text unchanged when no heredoc wrapper', () => {
		const patch = '*** Begin Patch\n*** Add File: foo.ts\n+hello\n*** End Patch'
		expect(stripHeredoc(patch)).toBe(patch)
	})
})

// ─── parsePatch ───────────────────────────────────────────────────────────────

describe('parsePatch', () => {
	test('throws on missing Begin Patch marker', () => {
		expect(() => parsePatch('*** End Patch')).toThrow('Invalid patch format')
	})

	test('throws on missing End Patch marker', () => {
		expect(() => parsePatch('*** Begin Patch')).toThrow('Invalid patch format')
	})

	test('throws when End Patch appears before Begin Patch', () => {
		expect(() => parsePatch('*** End Patch\n*** Begin Patch')).toThrow('Invalid patch format')
	})

	test('parses Add File operation with + prefix stripping', () => {
		const patch = [
			'*** Begin Patch',
			'*** Add File: src/hello.ts',
			'+export const greet = () => "hello"',
			'+export const bye = () => "bye"',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('add')
		expect(ops[0]!.filePath).toBe('src/hello.ts')
		expect(ops[0]!.addContent).toBe('export const greet = () => "hello"\nexport const bye = () => "bye"')
	})

	test('parses Delete File operation', () => {
		const patch = ['*** Begin Patch', '*** Delete File: old.ts', '*** End Patch'].join('\n')

		const ops = parsePatch(patch)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('delete')
		expect(ops[0]!.filePath).toBe('old.ts')
	})

	test('parses Update File operation with oldLines/newLines model', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: index.ts',
			'@@',
			' const x = 1',
			'-const y = 2',
			'+const y = 99',
			' const z = 3',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('update')
		expect(ops[0]!.filePath).toBe('index.ts')
		expect(ops[0]!.chunks).toHaveLength(1)

		const chunk = ops[0]!.chunks[0]!
		expect(chunk.oldLines).toEqual(['const x = 1', 'const y = 2', 'const z = 3'])
		expect(chunk.newLines).toEqual(['const x = 1', 'const y = 99', 'const z = 3'])
	})

	test('parses multi-hunk Update File operation', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: file.ts',
			'@@',
			' line 1',
			'-old line 2',
			'+new line 2',
			'@@',
			' line 10',
			'-old line 11',
			'+new line 11',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops[0]!.chunks).toHaveLength(2)
	})

	test('captures change_context from @@ header', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: file.ts',
			'@@ fn b',
			'-x=10',
			'+x=11',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops[0]!.chunks[0]!.changeContext).toBe('fn b')
	})

	test('parses Move File operation (Update with Move to)', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: old/path.ts',
			'*** Move to: new/path.ts',
			'@@',
			' unchanged line',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('move')
		expect(ops[0]!.filePath).toBe('old/path.ts')
		expect(ops[0]!.targetPath).toBe('new/path.ts')
	})

	test('parses multi-operation patch', () => {
		const patch = [
			'*** Begin Patch',
			'*** Add File: new.ts',
			'+export const x = 1',
			'*** Delete File: old.ts',
			'*** Update File: kept.ts',
			'@@',
			' line a',
			'-line b',
			'+line B',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops).toHaveLength(3)
		expect(ops[0]!.type).toBe('add')
		expect(ops[1]!.type).toBe('delete')
		expect(ops[2]!.type).toBe('update')
	})

	test('recognises *** End of File anchor in a chunk', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: file.ts',
			'@@',
			' last context line',
			'+appended line',
			'*** End of File',
			'*** End Patch',
		].join('\n')

		const ops = parsePatch(patch)
		expect(ops[0]!.chunks[0]!.endOfFile).toBe(true)
	})

	test('parses heredoc-wrapped patch (cat <<EOF)', () => {
		const inner = ['*** Begin Patch', '*** Add File: greet.ts', '+export const hi = "hi"', '*** End Patch'].join(
			'\n',
		)
		const wrapped = `cat <<'EOF'\n${inner}\nEOF`

		const ops = parsePatch(wrapped)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('add')
	})

	test('parses heredoc-wrapped patch (bare <<EOF without cat)', () => {
		const inner = ['*** Begin Patch', '*** Add File: greet.ts', '+export const hi = "hi"', '*** End Patch'].join(
			'\n',
		)
		const wrapped = `<<'EOF'\n${inner}\nEOF`

		const ops = parsePatch(wrapped)
		expect(ops).toHaveLength(1)
		expect(ops[0]!.type).toBe('add')
		expect(ops[0]!.addContent).toBe('export const hi = "hi"')
	})
})

// ─── applyUpdateChunks ────────────────────────────────────────────────────────

describe('applyUpdateChunks', () => {
	test('applies a simple single-line replacement', () => {
		const content = 'const x = 1\nconst y = 2\nconst z = 3\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const x = 1', 'const y = 2', 'const z = 3'],
				newLines: ['const x = 1', 'const y = 99', 'const z = 3'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('const y = 99')
		expect(result).not.toContain('const y = 2')
	})

	test('throws when context lines are not found in file', () => {
		const content = 'line 1\nline 2\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['line that does not exist'],
				newLines: ['replacement'],
			},
		]
		expect(() => applyUpdateChunks(content, chunks)).toThrow('Failed to find expected lines')
	})

	test('preserves CRLF line endings', () => {
		const content = 'line 1\r\nold line\r\nline 3\r\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['line 1', 'old line', 'line 3'],
				newLines: ['line 1', 'new line', 'line 3'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('\r\n')
		expect(result).toContain('new line')
	})

	test('handles pure insertion (no old lines)', () => {
		const content = 'existing line\n'
		const chunks = [
			{
				endOfFile: true,
				oldLines: [],
				newLines: ['appended line'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('appended line')
	})

	test('fuzzy-matches context lines with trailing whitespace differences', () => {
		// File has trailing space, patch context does not
		const content = 'const x = 1   \nconst y = 2\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const x = 1', 'const y = 2'],
				newLines: ['const x = 1', 'const y = 99'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('const y = 99')
	})

	test('fuzzy-matches context lines with leading whitespace differences', () => {
		// File has extra leading spaces
		const content = '  const x = 1\nconst y = 2\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const x = 1', 'const y = 2'],
				newLines: ['const x = 1', 'const y = 99'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('const y = 99')
	})

	test('fuzzy-matches unicode punctuation differences', () => {
		// File uses curly quotes, patch uses straight quotes
		const content = 'const msg = \u201Chello\u201D\nconst x = 1\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const msg = "hello"', 'const x = 1'],
				newLines: ['const msg = "hello"', 'const x = 42'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('const x = 42')
	})

	test('applies multiple chunks in order with startIndex tracking', () => {
		const content = 'a\nb\nc\nd\ne\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['a', 'b'],
				newLines: ['a', 'B'],
			},
			{
				endOfFile: false,
				oldLines: ['d', 'e'],
				newLines: ['d', 'E'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toContain('B')
		expect(result).toContain('E')
		expect(result).not.toContain('\nb\n')
		expect(result).not.toContain('\ne\n')
	})

	test('disambiguates chunks with change_context from @@ header', () => {
		// Two sections with same x=10 line, change_context narrows search to fn b
		const content = 'fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n'

		const chunks = [
			{
				endOfFile: false,
				oldLines: ['x=10'],
				newLines: ['x=11'],
				changeContext: 'fn b',
			},
		]
		const result = applyUpdateChunks(content, chunks)
		// Should only change x=10 after fn b, not after fn a
		expect(result).toBe('fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n')
	})

	test('EOF anchor matches from end of file first', () => {
		// File has duplicate "marker" lines — EOF anchor should match the last one
		const content = 'start\nmarker\nmiddle\nmarker\nend\n'

		const chunks = [
			{
				endOfFile: true,
				oldLines: ['marker', 'end'],
				newLines: ['marker-changed', 'end'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		// First marker unchanged, second marker changed
		expect(result).toBe('start\nmarker\nmiddle\nmarker-changed\nend\n')
	})

	test('enforces trailing newline', () => {
		const content = 'const x = 1\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const x = 1'],
				newLines: ['const x = 42'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toBe('const x = 42\n')
		expect(result.endsWith('\n')).toBe(true)
	})

	test('adds trailing newline when original content lacks one', () => {
		const content = 'const x = 1'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['const x = 1'],
				newLines: ['const x = 42'],
			},
		]
		const result = applyUpdateChunks(content, chunks)
		expect(result).toBe('const x = 42\n')
	})

	test('throws when change_context not found in file', () => {
		const content = 'fn a\nx=10\ny=2\n'
		const chunks = [
			{
				endOfFile: false,
				oldLines: ['x=10'],
				newLines: ['x=11'],
				changeContext: 'fn nonexistent',
			},
		]
		expect(() => applyUpdateChunks(content, chunks)).toThrow("Failed to find context 'fn nonexistent'")
	})
})

// ─── validateHunks ───────────────────────────────────────────────────────────

describe('validateHunks', () => {
	test('passes when update context lines exist in file', async () => {
		const fileStore: Record<string, string> = {
			'file.ts': 'const x = 1\nconst y = 2\n',
		}
		const readFile = async (p: string) => {
			if (fileStore[p]) return fileStore[p]
			throw new Error('not found')
		}

		const ops = parsePatch(
			[
				'*** Begin Patch',
				'*** Update File: file.ts',
				'@@',
				' const x = 1',
				'-const y = 2',
				'+const y = 99',
				'*** End Patch',
			].join('\n'),
		)

		await expect(validateHunks(ops, readFile)).resolves.toBeUndefined()
	})

	test('throws when update file does not exist', async () => {
		const readFile = async (_p: string) => {
			throw new Error('not found')
		}

		const ops = parsePatch(
			['*** Begin Patch', '*** Update File: missing.ts', '@@', ' x', '*** End Patch'].join('\n'),
		)

		await expect(validateHunks(ops, readFile)).rejects.toThrow(
			'apply_patch verification failed: Failed to read file to update: missing.ts',
		)
	})

	test('throws when context lines do not match file contents', async () => {
		const fileStore: Record<string, string> = {
			'file.ts': 'completely different content\n',
		}
		const readFile = async (p: string) => {
			if (fileStore[p]) return fileStore[p]
			throw new Error('not found')
		}

		const ops = parsePatch(
			[
				'*** Begin Patch',
				'*** Update File: file.ts',
				'@@',
				' context line that does not exist',
				'-remove line',
				'+add line',
				'*** End Patch',
			].join('\n'),
		)

		await expect(validateHunks(ops, readFile)).rejects.toThrow('apply_patch verification failed')
	})

	test('throws when delete file does not exist', async () => {
		const readFile = async (_p: string) => {
			throw new Error('not found')
		}

		const ops = parsePatch(['*** Begin Patch', '*** Delete File: ghost.ts', '*** End Patch'].join('\n'))

		await expect(validateHunks(ops, readFile)).rejects.toThrow(
			'apply_patch verification failed: Failed to read file to delete: ghost.ts',
		)
	})

	test('skips validation for add operations (file need not exist)', async () => {
		const readFile = async (_p: string) => {
			throw new Error('not found')
		}

		const ops = parsePatch(
			['*** Begin Patch', '*** Add File: brand-new.ts', '+const x = 1', '*** End Patch'].join('\n'),
		)

		// Should not throw even though readFile always throws
		await expect(validateHunks(ops, readFile)).resolves.toBeUndefined()
	})
})
