import { describe, expect, test } from 'bun:test'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import {
	buildCopilotUserAgent,
	COPILOT_CLIENT_ID,
	COPILOT_PROVIDER_ID,
	getCopilotApiBaseUrl,
	getCopilotOAuthUrls,
	normalizeEnterpriseUrl,
	OAUTH_POLLING_SAFETY_MARGIN_MS,
	startCopilotDeviceOAuth,
	writeCopilotOAuthTokens,
} from '../src'

describe('copilot oauth helpers', () => {
	test('normalizes enterprise urls and API base URLs', () => {
		expect(normalizeEnterpriseUrl('https://company.ghe.com/')).toBe('company.ghe.com')
		expect(normalizeEnterpriseUrl('company.ghe.com')).toBe('company.ghe.com')
		expect(getCopilotApiBaseUrl()).toBe('https://api.githubcopilot.com')
		expect(getCopilotApiBaseUrl('company.ghe.com')).toBe('https://copilot-api.company.ghe.com')
		expect(getCopilotOAuthUrls('https://company.ghe.com')).toEqual({
			deviceCodeUrl: 'https://company.ghe.com/login/device/code',
			accessTokenUrl: 'https://company.ghe.com/login/oauth/access_token',
		})
	})

	test('writes oauth auth into the shared auth store', async () => {
		const store = createMemoryAuthStore()
		const auth = await writeCopilotOAuthTokens(
			store,
			COPILOT_PROVIDER_ID,
			{ access_token: 'copilot-token', scope: 'read:user', token_type: 'bearer' },
			'https://company.ghe.com',
		)

		expect(auth).toEqual({
			kind: 'oauth',
			accessToken: 'copilot-token',
			refreshToken: 'copilot-token',
			expiresAt: 0,
			scope: 'read:user',
			tokenType: 'bearer',
			enterpriseUrl: 'company.ghe.com',
		} as typeof auth)
		expect(await store.get(COPILOT_PROVIDER_ID)).toEqual(auth)
	})

	test('starts device oauth and persists the resulting token', async () => {
		const store = createMemoryAuthStore()
		const requests: Array<{ url: string; init?: RequestInit }> = []
		const flow = await startCopilotDeviceOAuth({
			store,
			version: '1.2.3',
			fetch: (async (input, init) => {
				const url = input instanceof URL ? input.toString() : String(input)
				requests.push({ url, init })
				if (url.endsWith('/login/device/code')) {
					return Response.json({
						verification_uri: 'https://github.com/login/device',
						user_code: 'ABCD-EFGH',
						device_code: 'device-code-123',
						interval: 0,
					})
				}
				if (url.endsWith('/login/oauth/access_token')) {
					return Response.json({
						access_token: 'copilot-access-token',
						scope: 'read:user',
						token_type: 'bearer',
					})
				}
				throw new Error(`Unexpected request: ${url}`)
			}) as FetchFunction,
		})

		expect(flow.url).toBe('https://github.com/login/device')
		expect(flow.userCode).toBe('ABCD-EFGH')
		const result = await flow.complete()
		expect(result).toEqual({
			kind: 'success',
			auth: {
				kind: 'oauth',
				accessToken: 'copilot-access-token',
				refreshToken: 'copilot-access-token',
				expiresAt: 0,
				scope: 'read:user',
				tokenType: 'bearer',
			},
		})
		expect(result.kind).toBe('success')
		if (result.kind !== 'success') throw new Error('Expected successful device OAuth result')
		expect(await store.get(COPILOT_PROVIDER_ID)).toEqual(result.auth)
		expect(requests).toHaveLength(2)
		expect(requests[0]?.url).toBe('https://github.com/login/device/code')
		expect(requests[1]?.url).toBe('https://github.com/login/oauth/access_token')
		expect(new Headers(requests[0]?.init?.headers).get('User-Agent')).toBe(buildCopilotUserAgent('1.2.3'))
		expect(new Headers(requests[1]?.init?.headers).get('User-Agent')).toBe(buildCopilotUserAgent('1.2.3'))
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			client_id: COPILOT_CLIENT_ID,
			scope: 'read:user',
		})
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			client_id: COPILOT_CLIENT_ID,
			device_code: 'device-code-123',
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		})
	})

	test('exports the expected polling safety margin constant', () => {
		expect(OAUTH_POLLING_SAFETY_MARGIN_MS).toBe(3_000)
	})
})
