import { describe, expect, test } from 'bun:test'
import {
	ApplyPatchTool,
	applyPatchInput,
	EditTool,
	editInput,
	GlobTool,
	type GrepMatch,
	GrepTool,
	globInput,
	grepInput,
	type ListEntry,
	ListTool,
	listInput,
	MultiEditTool,
	multiEditInput,
	ReadMultimodalTool,
	ReadTool,
	readInput,
	WebFetchTool,
	WriteTool,
	writeInput,
} from '../src/interfaces'
import { makeToolContext } from './mocks'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Serialize raw tool output using the tool's serialize fn or default logic. */
function serializeRaw<TInput, TOutput>(
	tool: { serialize?: (raw: TOutput, input: TInput) => any },
	raw: TOutput,
	input: TInput,
): any {
	if (tool.serialize) return tool.serialize(raw, input)
	return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

// ─── Interface .define() identity checks ──────────────────────────────────────

describe('All interfaces produce valid tools via .define()', () => {
	test('ReadTool.define() returns a tool named "read"', () => {
		const tool = ReadTool.define(async () => 'ok')
		expect(tool.name).toBe('read')
	})

	test('ReadMultimodalTool.define() returns a tool named "read"', () => {
		const tool = ReadMultimodalTool.define(async () => ({ type: 'text', content: 'ok' }))
		expect(ReadMultimodalTool.name).toBe('read')
		expect(tool.name).toBe('read')
	})

	test('EditTool.define() returns a tool named "edit"', () => {
		const tool = EditTool.define(async () => ({ content: '', matchCount: 1 }))
		expect(tool.name).toBe('edit')
	})

	test('WriteTool.define() returns a tool named "write"', () => {
		const tool = WriteTool.define(async () => 'ok')
		expect(tool.name).toBe('write')
	})

	test('MultiEditTool.define() returns a tool named "multiedit"', () => {
		const tool = MultiEditTool.define(async () => 'ok')
		expect(tool.name).toBe('multiedit')
	})

	test('GlobTool.define() returns a tool named "glob"', () => {
		const tool = GlobTool.define(async () => [])
		expect(tool.name).toBe('glob')
	})

	test('GrepTool.define() returns a tool named "grep"', () => {
		const tool = GrepTool.define(async () => [])
		expect(tool.name).toBe('grep')
	})

	test('ListTool.define() returns a tool named "list"', () => {
		const tool = ListTool.define(async () => [])
		expect(tool.name).toBe('list')
	})

	test('ApplyPatchTool.define() returns a tool named "apply_patch"', () => {
		const tool = ApplyPatchTool.define(async () => 'ok')
		expect(tool.name).toBe('apply_patch')
	})
})

// ─── Zod schema validation ────────────────────────────────────────────────────

describe('Zod schemas — valid / invalid inputs', () => {
	test('readInput parses defaults for multimodal read', () => {
		const result = readInput.safeParse({ file_path: 'x.png' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.limit).toBe(2000)
		}
	})

	// ── editInput ──
	test('editInput requires file_path, old_string, new_string', () => {
		expect(editInput.safeParse({}).success).toBe(false)
		expect(editInput.safeParse({ file_path: '/f' }).success).toBe(false)
		expect(editInput.safeParse({ file_path: '/f', old_string: 'a' }).success).toBe(false)
	})

	test('editInput parses valid input with defaults', () => {
		const result = editInput.safeParse({ file_path: '/f', old_string: 'a', new_string: 'b' })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.replace_all).toBe(false)
		}
	})

	test('editInput accepts replace_all=true', () => {
		const result = editInput.safeParse({
			file_path: '/f',
			old_string: 'a',
			new_string: 'b',
			replace_all: true,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.replace_all).toBe(true)
		}
	})

	// ── writeInput ──
	test('writeInput requires file_path and content', () => {
		expect(writeInput.safeParse({}).success).toBe(false)
		expect(writeInput.safeParse({ file_path: '/f' }).success).toBe(false)
	})

	test('writeInput parses valid input', () => {
		const result = writeInput.safeParse({ file_path: '/f', content: 'hello' })
		expect(result.success).toBe(true)
	})

	test('writeInput accepts empty content (for creating empty files)', () => {
		const result = writeInput.safeParse({ file_path: '/f', content: '' })
		expect(result.success).toBe(true)
	})

	// ── multiEditInput ──
	test('multiEditInput requires at least one edit', () => {
		expect(multiEditInput.safeParse({ file_path: '/f', edits: [] }).success).toBe(false)
	})

	test('multiEditInput parses valid input with multiple edits', () => {
		const result = multiEditInput.safeParse({
			file_path: '/f',
			edits: [
				{ old_string: 'a', new_string: 'b' },
				{ old_string: 'c', new_string: 'd', replace_all: true },
			],
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.edits).toHaveLength(2)
			expect(result.data.edits[0]!.replace_all).toBe(false) // default
			expect(result.data.edits[1]!.replace_all).toBe(true)
		}
	})

	// ── globInput ──
	test('globInput requires pattern', () => {
		expect(globInput.safeParse({}).success).toBe(false)
	})

	test('globInput accepts optional path', () => {
		const result = globInput.safeParse({ pattern: '**/*.ts', path: '/src' })
		expect(result.success).toBe(true)
	})

	// ── grepInput ──
	test('grepInput requires pattern', () => {
		expect(grepInput.safeParse({}).success).toBe(false)
	})

	test('grepInput accepts optional path and include', () => {
		const result = grepInput.safeParse({ pattern: 'foo.*bar', path: '/src', include: '*.ts' })
		expect(result.success).toBe(true)
	})

	// ── listInput ──
	test('listInput accepts empty input (all optional)', () => {
		expect(listInput.safeParse({}).success).toBe(true)
	})

	test('listInput accepts path and ignore arrays', () => {
		const result = listInput.safeParse({
			path: '/src',
			ignore: ['node_modules', '.git'],
		})
		expect(result.success).toBe(true)
	})

	// ── applyPatchInput ──
	test('applyPatchInput requires patch_text', () => {
		expect(applyPatchInput.safeParse({}).success).toBe(false)
	})

	test('applyPatchInput parses valid input', () => {
		const result = applyPatchInput.safeParse({
			patch_text: '*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch',
		})
		expect(result.success).toBe(true)
	})
})

describe('ReadMultimodalTool serialize', () => {
	test('text variant serializes like existing read output', async () => {
		const tool = ReadMultimodalTool.define(async () => ({ type: 'text', content: 'a\nb' }))
		const input = { file_path: '/fake/path.txt', limit: 2000 }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)

		expect(output).toContain('1→a')
		expect(output).toContain('2→b')
		expect(output).toContain('(End of file - total 2 lines)')
	})
})

// ─── EditTool — serialize ─────────────────────────────────────────────────────

describe('EditTool serialize — match count handling', () => {
	test('returns success message when matchCount > 0', async () => {
		const tool = EditTool.define(async () => ({ content: 'updated', matchCount: 1 }))
		const input = { file_path: '/test/file.ts', old_string: 'old', new_string: 'new', replace_all: false }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Successfully edited')
		expect(output).toContain('/test/file.ts')
	})

	test('returns success for multiple matches', async () => {
		const tool = EditTool.define(async () => ({ content: 'updated', matchCount: 3 }))
		const input = { file_path: '/test/file.ts', old_string: 'old', new_string: 'new', replace_all: true }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Successfully edited')
	})

	test('returns error message when matchCount is 0', async () => {
		const tool = EditTool.define(async () => ({ content: 'unchanged', matchCount: 0 }))
		const input = { file_path: '/test/file.ts', old_string: 'missing', new_string: 'new', replace_all: false }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Error')
		expect(output).toContain('Could not find a match')
		expect(output).toContain('/test/file.ts')
	})

	test('error message suggests using read tool', async () => {
		const tool = EditTool.define(async () => ({ content: 'unchanged', matchCount: 0 }))
		const input = { file_path: '/test/file.ts', old_string: 'missing', new_string: 'new', replace_all: false }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('read tool')
	})

	test('uses original file_path in error message', async () => {
		const tool = EditTool.define(async () => ({ content: 'unchanged', matchCount: 0 }))
		const input = { file_path: '~/project/file.ts', old_string: 'missing', new_string: 'new', replace_all: false }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('~/project/file.ts')
	})
})

// ─── WriteTool — content passthrough ──────────────────────────────────────────

describe('WriteTool content passthrough', () => {
	test('passes content unchanged to executor', async () => {
		let receivedContent = ''
		const tool = WriteTool.define(async (input) => {
			receivedContent = input.content
			return 'ok'
		})

		const multiLineContent = 'line 1\nline 2\nline 3\n'
		await tool.execute({ file_path: '/test/file.ts', content: multiLineContent }, makeToolContext())
		expect(receivedContent).toBe(multiLineContent)
	})

	test('passes empty content to executor', async () => {
		let receivedContent = ''
		const tool = WriteTool.define(async (input) => {
			receivedContent = input.content
			return 'ok'
		})
		await tool.execute({ file_path: '/test/empty.ts', content: '' }, makeToolContext())
		expect(receivedContent).toBe('')
	})

	test('preserves CRLF line endings in content', async () => {
		let receivedContent = ''
		const tool = WriteTool.define(async (input) => {
			receivedContent = input.content
			return 'ok'
		})
		const crlfContent = 'line 1\r\nline 2\r\nline 3'
		await tool.execute({ file_path: '/test/crlf.ts', content: crlfContent }, makeToolContext())
		expect(receivedContent).toBe(crlfContent)
	})
})

// ─── MultiEditTool — passthrough ──────────────────────────────────────────────

describe('MultiEditTool passthrough', () => {
	test('passes edits array to executor unchanged', async () => {
		let receivedEdits: unknown[] = []
		const tool = MultiEditTool.define(async (input) => {
			receivedEdits = input.edits
			return 'ok'
		})
		const edits = [
			{ old_string: 'a', new_string: 'b', replace_all: false },
			{ old_string: 'c', new_string: 'd', replace_all: true },
		]
		await tool.execute({ file_path: '/test/file.ts', edits }, makeToolContext())
		expect(receivedEdits).toEqual(edits)
	})
})

// ─── GlobTool — serialize ─────────────────────────────────────────────────────

describe('GlobTool serialize', () => {
	test('empty results return "No files matched" message', async () => {
		const tool = GlobTool.define(async () => [])
		const input = { pattern: '**/*.xyz' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('No files matched the pattern.')
	})

	test('formats file list one per line', async () => {
		const tool = GlobTool.define(async () => ['src/a.ts', 'src/b.ts', 'src/c.ts'])
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('src/a.ts\nsrc/b.ts\nsrc/c.ts')
	})

	test('serialize returns all results without inline truncation', async () => {
		// Inline truncation was removed — truncation is now handled by postToolUse hooks.
		const files = Array.from({ length: 150 }, (_, i) => `file-${i}.ts`)
		const tool = GlobTool.define(async () => files)
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('file-0.ts')
		expect(output).toContain('file-99.ts')
		expect(output).toContain('file-100.ts')
		expect(output).toContain('file-149.ts')
		expect(output).not.toContain('[Truncated')
	})

	test('does not show truncation message for any result count', async () => {
		const files = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`)
		const tool = GlobTool.define(async () => files)
		const input = { pattern: '**/*.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).not.toContain('[Truncated')
	})

	test('single result returns just the filename', async () => {
		const tool = GlobTool.define(async () => ['only-file.ts'])
		const input = { pattern: 'only-file.ts' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('only-file.ts')
	})
})

// ─── GrepTool — serialize ─────────────────────────────────────────────────────

describe('GrepTool serialize', () => {
	test('empty matches return "No matches found" message', async () => {
		const tool = GrepTool.define(async () => [])
		const input = { pattern: 'nonexistent' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('No matches found.')
	})

	test('groups matches by file', async () => {
		const matches: GrepMatch[] = [
			{ file: 'src/a.ts', line: 10, content: 'const foo = 1' },
			{ file: 'src/a.ts', line: 20, content: 'const foo = 2' },
			{ file: 'src/b.ts', line: 5, content: 'let foo = 3' },
		]
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'foo' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)

		// File headers
		expect(output).toContain('src/a.ts')
		expect(output).toContain('src/b.ts')

		// Line numbers with content
		expect(output).toContain('  10: const foo = 1')
		expect(output).toContain('  20: const foo = 2')
		expect(output).toContain('  5: let foo = 3')
	})

	test('preserves file ordering', async () => {
		const matches: GrepMatch[] = [
			{ file: 'z-file.ts', line: 1, content: 'z content' },
			{ file: 'a-file.ts', line: 1, content: 'a content' },
		]
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'content' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)

		const zIndex = output.indexOf('z-file.ts')
		const aIndex = output.indexOf('a-file.ts')
		expect(zIndex).toBeLessThan(aIndex)
	})

	test('serialize returns all matches without inline truncation', async () => {
		// Inline truncation was removed — truncation is now handled by postToolUse hooks.
		const matches: GrepMatch[] = Array.from({ length: 150 }, (_, i) => ({
			file: `file-${i}.ts`,
			line: 1,
			content: `match ${i}`,
		}))
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'match' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)

		expect(output).toContain('file-0.ts')
		expect(output).toContain('file-99.ts')
		expect(output).toContain('file-100.ts')
		expect(output).toContain('file-149.ts')
		expect(output).not.toContain('[Truncated')
	})

	test('single match in single file', async () => {
		const matches: GrepMatch[] = [{ file: 'src/index.ts', line: 42, content: 'export default' }]
		const tool = GrepTool.define(async () => matches)
		const input = { pattern: 'export default' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)

		expect(output).toBe('src/index.ts\n  42: export default')
	})
})

// ─── ListTool — serialize ─────────────────────────────────────────────────────

describe('ListTool serialize', () => {
	test('empty directory returns "Directory is empty" message', async () => {
		const tool = ListTool.define(async () => [])
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('Directory is empty.')
	})

	test('directories get folder icon prefix', async () => {
		const entries: ListEntry[] = [
			{ name: 'src', type: 'directory' },
			{ name: 'package.json', type: 'file' },
		]
		const tool = ListTool.define(async () => entries)
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('📁 src')
	})

	test('files get indented spacing prefix', async () => {
		const entries: ListEntry[] = [{ name: 'readme.md', type: 'file' }]
		const tool = ListTool.define(async () => entries)
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('   readme.md')
	})

	test('mixed entries are formatted correctly', async () => {
		const entries: ListEntry[] = [
			{ name: 'node_modules', type: 'directory' },
			{ name: 'src', type: 'directory' },
			{ name: 'index.ts', type: 'file' },
			{ name: 'tsconfig.json', type: 'file' },
		]
		const tool = ListTool.define(async () => entries)
		const input = {}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		const lines = output.split('\n')
		expect(lines).toHaveLength(4)
		expect(lines[0]).toContain('📁')
		expect(lines[1]).toContain('📁')
		expect(lines[2]).toBe('   index.ts')
		expect(lines[3]).toBe('   tsconfig.json')
	})
})

// ─── ApplyPatchTool — no transforms, passthrough ──────────────────────────────

describe('ApplyPatchTool', () => {
	test('passes patch_text directly to executor', async () => {
		let receivedPatchText = ''
		const tool = ApplyPatchTool.define(async (input) => {
			receivedPatchText = input.patch_text
			return 'Patch applied successfully'
		})
		const patch_text = '*** Begin Patch\n*** Add File: test.txt\n+hello world\n*** End Patch'
		const input = { patch_text }
		const raw = await tool.execute(input, makeToolContext())
		expect(receivedPatchText).toBe(patch_text)
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toBe('Patch applied successfully')
	})

	test('executor error propagates', async () => {
		const tool = ApplyPatchTool.define(async () => {
			throw new Error('apply_patch verification failed: invalid format')
		})
		await expect(tool.execute({ patch_text: 'invalid' }, makeToolContext())).rejects.toThrow(
			'apply_patch verification failed',
		)
	})

	test('multiline patch text is passed correctly', async () => {
		let receivedPatchText = ''
		const multilinePatch = [
			'*** Begin Patch',
			'*** Update File: src/index.ts',
			'@@',
			'-const old = 1',
			'+const new = 2',
			'*** End Patch',
		].join('\n')

		const tool = ApplyPatchTool.define(async (input) => {
			receivedPatchText = input.patch_text
			return 'Success'
		})
		await tool.execute({ patch_text: multilinePatch }, makeToolContext())
		expect(receivedPatchText).toBe(multilinePatch)
		expect(receivedPatchText.split('\n')).toHaveLength(6)
	})

	test('heredoc-wrapped patch text is passed as-is (no unwrapping in interface)', async () => {
		let receivedPatchText = ''
		const heredocPatch = `cat <<'EOF'\n*** Begin Patch\n*** Add File: test.txt\n+content\n*** End Patch\nEOF`

		const tool = ApplyPatchTool.define(async (input) => {
			receivedPatchText = input.patch_text
			return 'ok'
		})
		await tool.execute({ patch_text: heredocPatch }, makeToolContext())
		// Interface does not unwrap heredocs — that's the executor's job
		expect(receivedPatchText).toBe(heredocPatch)
	})
})

// ─── WebFetchTool — passthrough ───────────────────────────────────────────────

describe('WebFetchTool passthrough', () => {
	test('passes url, format, and timeout to executor', async () => {
		let receivedInput: unknown
		const tool = WebFetchTool.define(async (input) => {
			receivedInput = input
			return 'fetched content'
		})
		await tool.execute({ url: 'https://example.com', format: 'html', timeout: 10_000 }, makeToolContext())
		expect(receivedInput).toMatchObject({
			url: 'https://example.com',
			format: 'html',
			timeout: 10_000,
		})
	})

	test('executor result returned as-is (no serialize fn defined)', async () => {
		const tool = WebFetchTool.define(async () => '# Hello\nWorld')
		const raw = await tool.execute(
			{ url: 'https://example.com', format: 'markdown', timeout: 30_000 },
			makeToolContext(),
		)
		expect(raw).toBe('# Hello\nWorld')
	})

	test('executor error propagates', async () => {
		const tool = WebFetchTool.define(async () => {
			throw new Error('URL must start with http:// or https://')
		})
		await expect(
			tool.execute({ url: 'https://bad.example.com', format: 'markdown', timeout: 30_000 }, makeToolContext()),
		).rejects.toThrow('URL must start with http://')
	})
})

// ─── EditTool — simulated end-to-end scenarios ────────────────────────────────

describe('EditTool — simulated executor scenarios', () => {
	test('single match replacement', async () => {
		const tool = EditTool.define(async (input) => {
			const content = 'line1\nold content\nline3'
			const updated = content.replace(input.old_string, input.new_string)
			const matchCount = content !== updated ? 1 : 0
			return { content: updated, matchCount }
		})

		const input = {
			file_path: '/test.ts',
			old_string: 'old content',
			new_string: 'new content',
			replace_all: false,
		}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Successfully edited')
	})

	test('replaceAll with multiple matches', async () => {
		const tool = EditTool.define(async (input) => {
			const content = 'foo bar foo baz foo'
			const regex = new RegExp(input.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
			const matches = content.match(regex)
			const matchCount = matches?.length ?? 0
			const updated = content.replace(regex, input.new_string)
			return { content: updated, matchCount }
		})

		const input = { file_path: '/test.ts', old_string: 'foo', new_string: 'qux', replace_all: true }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Successfully edited')
	})

	test('no match returns error', async () => {
		const tool = EditTool.define(async () => ({ content: 'unchanged', matchCount: 0 }))

		const input = { file_path: '/test.ts', old_string: 'does not exist', new_string: 'new', replace_all: false }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Error')
		expect(output).toContain('Could not find a match')
	})

	test('multiline oldString replacement', async () => {
		const tool = EditTool.define(async (input) => {
			const content = 'function hello() {\n  return "world"\n}'
			const updated = content.replace(input.old_string, input.new_string)
			const matchCount = content !== updated ? 1 : 0
			return { content: updated, matchCount }
		})

		const input = {
			file_path: '/test.ts',
			old_string: '  return "world"',
			new_string: '  return "universe"',
			replace_all: false,
		}
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Successfully edited')
	})

	test('executor throw propagates to caller', async () => {
		const tool = EditTool.define(async () => {
			throw new Error('File not found: /missing.ts')
		})

		await expect(
			tool.execute(
				{ file_path: '/missing.ts', old_string: 'a', new_string: 'b', replace_all: false },
				makeToolContext(),
			),
		).rejects.toThrow('File not found')
	})
})

// ─── WriteTool — simulated executor scenarios ─────────────────────────────────

describe('WriteTool — simulated executor scenarios', () => {
	test('new file creation returns executor output', async () => {
		const tool = WriteTool.define(async (input) => `Created ${input.file_path}`)
		const input = { file_path: '/new-file.ts', content: 'export {}' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('Created')
		expect(output).toContain('/new-file.ts')
	})

	test('overwriting file returns executor output', async () => {
		const tool = WriteTool.define(async (input) => `Wrote ${input.content.length} bytes to ${input.file_path}`)
		const input = { file_path: '/existing.ts', content: 'new content here' }
		const raw = await tool.execute(input, makeToolContext())
		const output = serializeRaw(tool, raw as any, input)
		expect(output).toContain('16 bytes')
	})

	test('JSON content is passed correctly', async () => {
		let receivedContent = ''
		const tool = WriteTool.define(async (input) => {
			receivedContent = input.content
			return 'ok'
		})
		const json = JSON.stringify({ key: 'value', nested: { arr: [1, 2, 3] } }, null, 2)
		await tool.execute({ file_path: '/data.json', content: json }, makeToolContext())
		expect(JSON.parse(receivedContent)).toEqual({ key: 'value', nested: { arr: [1, 2, 3] } })
	})

	test('executor error propagates', async () => {
		const tool = WriteTool.define(async () => {
			throw new Error('Permission denied: /readonly/file.ts')
		})
		await expect(tool.execute({ file_path: '/readonly/file.ts', content: 'x' }, makeToolContext())).rejects.toThrow(
			'Permission denied',
		)
	})
})

// ─── normalizeEscapes utility ─────────────────────────────────────────────────

describe('normalizeEscapes', () => {
	// Import the function directly
	test('converts literal \\n to newlines', async () => {
		const { normalizeEscapes } = await import('../src/interfaces/edit')
		expect(normalizeEscapes('line1\\nline2')).toBe('line1\nline2')
	})

	test('converts literal \\t to tabs', async () => {
		const { normalizeEscapes } = await import('../src/interfaces/edit')
		expect(normalizeEscapes('col1\\tcol2')).toBe('col1\tcol2')
	})

	test('handles mixed escapes', async () => {
		const { normalizeEscapes } = await import('../src/interfaces/edit')
		expect(normalizeEscapes('a\\nb\\tc')).toBe('a\nb\tc')
	})

	test('leaves string without escapes unchanged', async () => {
		const { normalizeEscapes } = await import('../src/interfaces/edit')
		expect(normalizeEscapes('no escapes here')).toBe('no escapes here')
	})

	test('handles multiple consecutive escapes', async () => {
		const { normalizeEscapes } = await import('../src/interfaces/edit')
		expect(normalizeEscapes('\\n\\n\\t')).toBe('\n\n\t')
	})
})

// ─── define() with description override ───────────────────────────────────────

describe('define() with description override', () => {
	test('EditTool.define() accepts custom description', () => {
		const tool = EditTool.define(async () => ({ content: '', matchCount: 0 }), {
			description: 'Custom edit description',
		})
		expect(tool.description).toBe('Custom edit description')
	})

	test('WriteTool.define() uses default description when no override', () => {
		const tool = WriteTool.define(async () => 'ok')
		expect(tool.description).toBe('Write content to a file, creating it if it does not exist')
	})

	test('ApplyPatchTool.define() accepts custom description', () => {
		const tool = ApplyPatchTool.define(async () => 'ok', {
			description: 'Apply Codex patches',
		})
		expect(tool.description).toBe('Apply Codex patches')
	})
})
