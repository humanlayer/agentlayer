import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore, requireAuth } from '../src'

describe('createMemoryAuthStore', () => {
	test('stores and retrieves oauth auth entries by provider id', async () => {
		const store = createMemoryAuthStore()
		const auth = {
			kind: 'oauth' as const,
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresAt: 1234567890,
			accountId: 'acct_123',
		}

		await store.set('codex', auth)

		expect(await store.get('codex')).toEqual(auth)
	})

	test('stores and retrieves api auth entries by provider id', async () => {
		const store = createMemoryAuthStore({
			copilot: {
				kind: 'api',
				apiKey: 'copilot-api-key',
			},
		})

		expect(await store.get('copilot')).toEqual({
			kind: 'api',
			apiKey: 'copilot-api-key',
		})
	})

	test('returns clones from get and getAll', async () => {
		const store = createMemoryAuthStore({
			codex: {
				kind: 'oauth',
				accessToken: 'initial-token',
			},
		})

		const auth = await store.get('codex')
		if (!auth || auth.kind !== 'oauth') {
			throw new Error('expected oauth auth')
		}
		auth.accessToken = 'mutated-token'

		const allAuth = await store.getAll()
		const codexAuth = allAuth.codex
		if (!codexAuth || codexAuth.kind !== 'oauth') {
			throw new Error('expected oauth auth')
		}
		codexAuth.accessToken = 'mutated-again'

		expect(await store.get('codex')).toEqual({
			kind: 'oauth',
			accessToken: 'initial-token',
		})
	})

	test('deletes provider auth entries', async () => {
		const store = createMemoryAuthStore({
			codex: {
				kind: 'oauth',
				accessToken: 'access-token',
			},
		})

		await store.delete('codex')

		expect(await store.get('codex')).toBeUndefined()
	})
})

describe('requireAuth', () => {
	test('returns auth when present', async () => {
		const store = createMemoryAuthStore({
			copilot: {
				kind: 'api',
				apiKey: 'copilot-api-key',
			},
		})

		await expect(requireAuth(store, 'copilot')).resolves.toEqual({
			kind: 'api',
			apiKey: 'copilot-api-key',
		})
	})

	test('throws when auth is missing', async () => {
		const store = createMemoryAuthStore()

		await expect(requireAuth(store, 'codex')).rejects.toThrow('Missing auth for provider: codex')
	})
})
