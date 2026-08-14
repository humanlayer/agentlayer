import { describe, expect, test } from 'bun:test'
import { normalizeCodexServiceTier } from '../src/shared/service-tier'

// Salvaged from codex-transform.test.ts when the legacy provider was removed:
// normalizeCodexServiceTier is shared and still backs every live transport.
describe('normalizeCodexServiceTier', () => {
	test('normalizes fast service tier alias to Codex priority service tier', () => {
		expect(normalizeCodexServiceTier('fast')).toBe('priority')
		expect(normalizeCodexServiceTier('priority')).toBe('priority')
		expect(normalizeCodexServiceTier('flex')).toBe('flex')
		expect(normalizeCodexServiceTier(null)).toBeNull()
		expect(normalizeCodexServiceTier(undefined)).toBeUndefined()
	})
})
