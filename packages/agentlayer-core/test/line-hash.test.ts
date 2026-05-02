import { describe, expect, test } from 'bun:test'
import { computeLineHash, formatHashLine, formatHashLines, HASHLINE_BIGRAMS, xxHash32 } from '../src/utils/line-hash'

describe('line-hash utilities', () => {
	test('contains the exact 647-entry bigram table', () => {
		expect(HASHLINE_BIGRAMS).toHaveLength(647)
		expect(HASHLINE_BIGRAMS[0]).toBe('aa')
		expect(HASHLINE_BIGRAMS[469] as string).toBe('sr')
		expect(HASHLINE_BIGRAMS.at(-1)).toBe('zz')
	})

	test('uses ordinal suffixes for structural lines', () => {
		expect(computeLineHash(1, '')).toBe('st')
		expect(computeLineHash(2, '   {')).toBe('nd')
		expect(computeLineHash(3, '}')).toBe('rd')
		expect(computeLineHash(4, '\t}')).toBe('th')
		expect(computeLineHash(11, '}')).toBe('th')
		expect(computeLineHash(12, '}')).toBe('th')
		expect(computeLineHash(13, '}')).toBe('th')
	})

	test('ignores CR and trailing whitespace for hashes', () => {
		expect(computeLineHash(5, 'const x = 1')).toBe(computeLineHash(5, 'const x = 1\r   '))
	})

	test('uses an isomorphic xxHash32 implementation', () => {
		expect(xxHash32('const x = 1')).toBe(Bun.hash.xxHash32('const x = 1'))
		expect(xxHash32('!@#', 9)).toBe(Bun.hash.xxHash32('!@#', 9))
	})

	test('formats canonical hashline output', () => {
		expect(formatHashLine(1, '}')).toBe('1st|}')
		expect(formatHashLines('}\n')).toBe('1st|}\n2nd|')
	})
})
