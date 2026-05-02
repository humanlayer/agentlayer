import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '../src/define-tool'
import { HashlineEditTool, hashlineEditInput } from '../src/interfaces/hashline-edit'

const ctx = {} as ToolContext

describe('HashlineEditTool interface', () => {
	test('accepts oh-my-pi loc variants', () => {
		expect(hashlineEditInput.safeParse({ path: 'a.ts', edits: [{ loc: 'append', content: ['x'] }] }).success).toBe(true)
		expect(hashlineEditInput.safeParse({ path: 'a.ts', edits: [{ loc: 'prepend', content: ['x'] }] }).success).toBe(true)
		expect(hashlineEditInput.safeParse({ path: 'a.ts', edits: [{ loc: { append: '9th' }, content: ['x'] }] }).success).toBe(true)
		expect(hashlineEditInput.safeParse({ path: 'a.ts', edits: [{ loc: { prepend: '9th' }, content: ['x'] }] }).success).toBe(true)
		expect(
			hashlineEditInput.safeParse({ path: 'a.ts', edits: [{ loc: { range: { pos: '1st', end: '1st' } }, content: null }] })
				.success,
		).toBe(true)
	})

	test('requires path as primary file field', () => {
		expect(hashlineEditInput.safeParse({ file_path: 'a.ts', edits: [] }).success).toBe(false)
		expect(hashlineEditInput.safeParse({ path: 'a.ts', edits: [] }).success).toBe(true)
	})

	test('serializes edit metadata', () => {
		const serialized = HashlineEditTool.serialize?.(
			{ content: 'changed', editCount: 1, firstChangedLine: 3, warnings: ['rebased'], noopEdits: [{ editIndex: 1, loc: 'append', current: 'x' }] },
			{ path: 'a.ts', edits: [] },
			ctx,
		)

		expect(serialized).toContain('Successfully edited a.ts')
		expect(serialized).toContain('First changed line: 3')
		expect(serialized).toContain('- rebased')
		expect(serialized).toContain('No-op edits: 1')
	})
})
