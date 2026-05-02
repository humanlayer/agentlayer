import { describe, expect, test } from 'bun:test'
import { HashlineEditTool, HashReadTool } from '../src/interfaces'
import { computeLineHash, formatHashLine } from '../src/utils'

describe('hashline exports', () => {
	test('exports hashline interfaces and utilities from barrels', () => {
		expect(HashReadTool.name).toBe('read')
		expect(HashlineEditTool.name).toBe('edit')
		expect(formatHashLine(1, '}')).toBe('1st|}')
		expect(computeLineHash(1, '}')).toBe('st')
	})
})
