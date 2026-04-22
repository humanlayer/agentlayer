import { describe, expect, test } from 'bun:test'
import { YjsFilesystem } from '@humanlayer/yjs-fs'

describe('editFile EditResult', () => {
	test('returns correct position for single-line edit', () => {
		const fs = new YjsFilesystem()
		fs.createFile('/f.ts', 'hello world')

		const result = fs.editFile('/f.ts', 'world', 'universe')

		expect(result.path).toBe('/f.ts')
		expect(result.editIndex).toBe(6)
		expect(result.editLine).toBe(1)
		expect(result.affectedLines).toEqual({ start: 1, end: 1 })
	})

	test('returns correct position for multi-line edit', () => {
		const fs = new YjsFilesystem()
		fs.createFile('/f.ts', 'line1\nline2\nline3')

		const result = fs.editFile('/f.ts', 'line2', 'newA\nnewB\nnewC')

		expect(result.editLine).toBe(2)
		expect(result.affectedLines).toEqual({ start: 2, end: 4 })
	})
})
