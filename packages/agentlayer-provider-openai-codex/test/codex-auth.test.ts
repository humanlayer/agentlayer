import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { resolveCodexAuth } from '../src/shared/auth'
import { CODEX_PROVIDER_ID } from '../src/shared/constants'

// Both live transports (sse-vendor and websockets-vendor) resolve auth through
// resolveCodexAuth before every request. The expired-token refresh-and-persist
// path previously had its only coverage in the deleted legacy provider suite;
// these tests pin it directly.
describe('resolveCodexAuth', () => {
	test('refreshes an expired oauth token and persists the update', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'expired-access',
				refreshToken: 'refresh-123',
				expiresAt: 1,
			},
		})
		const seen: string[] = []
		const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(String(init?.body))
			return Response.json({
				access_token: 'fresh-access',
				refresh_token: 'fresh-refresh',
				expires_in: 3600,
			})
		}) as unknown as typeof globalThis.fetch

		const auth = await resolveCodexAuth(store, CODEX_PROVIDER_ID, fetchFn, () => 10_000)

		expect(auth.kind).toBe('oauth')
		expect((auth as { accessToken: string }).accessToken).toBe('fresh-access')
		expect((auth as { expiresAt?: number }).expiresAt).toBe(10_000 + 3600 * 1000)
		expect(seen.length).toBe(1)
		// The refreshed token must be PERSISTED, or the next request refreshes again.
		const stored = await store.get(CODEX_PROVIDER_ID)
		expect((stored as { accessToken: string }).accessToken).toBe('fresh-access')
		expect((stored as { refreshToken: string }).refreshToken).toBe('fresh-refresh')
	})

	test('returns an unexpired oauth token without refreshing', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: {
				kind: 'oauth',
				accessToken: 'still-good',
				refreshToken: 'refresh-123',
				expiresAt: 999_999,
			},
		})
		const fetchFn = (async () => {
			throw new Error('must not refresh')
		}) as unknown as typeof globalThis.fetch

		const auth = await resolveCodexAuth(store, CODEX_PROVIDER_ID, fetchFn, () => 10_000)
		expect((auth as { accessToken: string }).accessToken).toBe('still-good')
	})

	test('passes api-key auth through untouched', async () => {
		const store = createMemoryAuthStore({
			[CODEX_PROVIDER_ID]: { kind: 'api', apiKey: 'api-key-123' },
		})
		const fetchFn = (async () => {
			throw new Error('must not fetch')
		}) as unknown as typeof globalThis.fetch

		const auth = await resolveCodexAuth(store, CODEX_PROVIDER_ID, fetchFn, () => 0)
		expect(auth.kind).toBe('api')
	})
})
