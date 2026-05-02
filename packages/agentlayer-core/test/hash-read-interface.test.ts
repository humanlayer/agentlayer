import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '../src/define-tool'
import { HashReadTool, hashReadInput } from '../src/interfaces/hash-read'

const ctx = {} as ToolContext

describe('HashReadTool interface', () => {
	test('accepts classic read input fields', () => {
		expect(hashReadInput.safeParse({ file_path: 'a.ts' }).success).toBe(true)
		expect(hashReadInput.parse({ file_path: 'a.ts' }).limit).toBe(2000)
	})

	test('serializes lines as hashline anchors', () => {
		const serialized = HashReadTool.serialize?.('}\nconst x = 1', { file_path: 'a.ts', limit: 2000 }, ctx)

		expect(serialized).toContain('1st|}')
		expect(serialized).toContain('|const x = 1')
		expect(serialized).not.toContain('->')
		expect(serialized).not.toContain('→')
	})

	test('uses offset and limit for continuation markers', () => {
		const serialized = HashReadTool.serialize?.('a\nb\nc', { file_path: 'a.ts', offset: 2, limit: 1 }, ctx)

		expect(serialized).toContain('2')
		expect(serialized).toContain('|b')
		expect(serialized).toContain('Showing lines 2-2 of 3')
		expect(serialized).toContain('offset=3')
	})
})
