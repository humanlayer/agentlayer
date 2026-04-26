import { describe, expect, test } from 'bun:test'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import {
	buildAuthorizeUrl,
	buildBrowserOAuthRedirectUri,
	buildCodexUserAgent,
	CODEX_CLIENT_ID,
	CODEX_ISSUER,
	exchangeCodeForTokens,
	generatePKCE,
	refreshAccessToken,
	startDeviceOAuth,
	writeOAuthTokens,
} from '../src/codex-oauth'

function createJwt(payload: Record<string, unknown>): string {
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `header.${encoded}.signature`
}

describe('codex oauth helpers', () => {
	test('generatePKCE returns a verifier and challenge', async () => {
		const pkce = await generatePKCE()
		expect(pkce.verifier.length).toBeGreaterThan(10)
		expect(pkce.challenge.length).toBeGreaterThan(10)
	})

	test('buildAuthorizeUrl preserves opencode-specific oauth params', () => {
		const url = new URL(
			buildAuthorizeUrl(
				'http://localhost:1455/auth/callback',
				{ verifier: 'verifier', challenge: 'challenge' },
				'state-123',
			),
		)
		expect(url.origin).toBe(CODEX_ISSUER)
		expect(url.pathname).toBe('/oauth/authorize')
		expect(url.searchParams.get('client_id')).toBe(CODEX_CLIENT_ID)
		expect(url.searchParams.get('originator')).toBe('opencode')
		expect(url.searchParams.get('code_challenge')).toBe('challenge')
	})

	test('exchangeCodeForTokens posts authorization-code payloads', async () => {
		let body = ''
		const tokens = await exchangeCodeForTokens(
			'code-123',
			'http://localhost/callback',
			{ verifier: 'verifier-123', challenge: 'challenge' },
			async (_input, init) => {
				body = String(init?.body)
				return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 60 })
			},
		)

		expect(body).toContain('grant_type=authorization_code')
		expect(body).toContain('code_verifier=verifier-123')
		expect(tokens.access_token).toBe('access')
	})

	test('refreshAccessToken posts refresh-token payloads', async () => {
		let body = ''
		const tokens = await refreshAccessToken('refresh-123', async (_input, init) => {
			body = String(init?.body)
			return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60 })
		})

		expect(body).toContain('grant_type=refresh_token')
		expect(body).toContain('refresh_token=refresh-123')
		expect(tokens.refresh_token).toBe('refresh-2')
	})

	test('writeOAuthTokens stores oauth auth info in the shared auth store', async () => {
		const store = createMemoryAuthStore()
		const auth = await writeOAuthTokens(
			store,
			'codex',
			{
				access_token: 'access-token',
				refresh_token: 'refresh-token',
				id_token: createJwt({ chatgpt_account_id: 'acct_123' }),
				expires_in: 30,
			},
			() => 1000,
		)

		expect(auth).toEqual({
			kind: 'oauth',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresAt: 31000,
			idToken: createJwt({ chatgpt_account_id: 'acct_123' }),
			accountId: 'acct_123',
		})
		expect(await store.get('codex')).toEqual(auth)
	})

	test('startDeviceOAuth writes successful tokens into the auth store', async () => {
		const store = createMemoryAuthStore()
		const requests: Array<{ url: string; init?: RequestInit }> = []
		const flow = await startDeviceOAuth({
			store,
			version: '4.5.6',
			fetch: async (input, init) => {
				const url = input instanceof URL ? input.toString() : String(input)
				requests.push({ url, init })
				if (url.endsWith('/usercode')) {
					return Response.json({
						device_auth_id: 'device-auth-id',
						user_code: 'USER-CODE',
						interval: '1',
					})
				}
				if (url.endsWith('/deviceauth/token')) {
					return Response.json({ authorization_code: 'auth-code', code_verifier: 'device-verifier' })
				}
				if (url.endsWith('/oauth/token')) {
					const body = String(init?.body)
					expect(body).toContain('redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback')
					return Response.json({
						access_token: 'device-access',
						refresh_token: 'device-refresh',
						id_token: createJwt({ organizations: [{ id: 'org_999' }] }),
						expires_in: 60,
					})
				}
				throw new Error(`Unexpected request: ${url}`)
			},
			now: () => 5000,
		})

		expect(flow.url).toBe(`${CODEX_ISSUER}/codex/device`)
		expect(flow.userCode).toBe('USER-CODE')
		const result = await flow.complete()
		expect(result.kind).toBe('success')
		expect(await store.get('codex')).toEqual({
			kind: 'oauth',
			accessToken: 'device-access',
			refreshToken: 'device-refresh',
			expiresAt: 65000,
			idToken: createJwt({ organizations: [{ id: 'org_999' }] }),
			accountId: 'org_999',
		})
		expect(requests.map((request) => request.url)).toEqual([
			`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
			`${CODEX_ISSUER}/api/accounts/deviceauth/token`,
			`${CODEX_ISSUER}/oauth/token`,
		])
		const expectedUserAgent = buildCodexUserAgent('4.5.6')
		expect(new Headers(requests[0]?.init?.headers).get('User-Agent')).toBe(expectedUserAgent)
		expect(new Headers(requests[1]?.init?.headers).get('User-Agent')).toBe(expectedUserAgent)
	})

	test('browser oauth defaults to the OpenCode localhost callback url', () => {
		const redirectUri = buildBrowserOAuthRedirectUri('localhost', 1455)
		const url = buildAuthorizeUrl(redirectUri, { verifier: 'verifier', challenge: 'challenge' }, 'state-123')

		expect(redirectUri).toBe('http://localhost:1455/auth/callback')
		expect(url).toContain(encodeURIComponent('http://localhost:1455/auth/callback'))
	})
})
