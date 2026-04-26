import { setTimeout as sleep } from 'node:timers/promises'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { AuthStore, OAuthAuthInfo } from '@humanlayer/agentlayer-provider-auth'

interface StoredCopilotOAuthAuthInfo extends OAuthAuthInfo {
	enterpriseUrl?: string
}

export const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
export const COPILOT_PROVIDER_ID = 'github-copilot'
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

export type CopilotFetchLike = FetchFunction

export interface DeviceAuthorizationResponse {
	verification_uri: string
	user_code: string
	device_code: string
	interval: number
}

export interface CopilotDeviceCodeResponse {
	access_token?: string
	error?: string
	interval?: number
	scope?: string
	token_type?: string
}

export interface StartCopilotDeviceOAuthOptions {
	store: AuthStore
	providerId?: string
	enterpriseUrl?: string
	version?: string
	fetch?: CopilotFetchLike
	now?: () => number
}

export interface DeviceAuthorizationResult {
	url: string
	userCode: string
	complete(): Promise<{ kind: 'success'; auth: OAuthAuthInfo } | { kind: 'failed' }>
}

export function normalizeEnterpriseUrl(input: string): string {
	const value = input.trim()
	if (!value) {
		throw new Error('enterpriseUrl is required')
	}

	const parsed = value.includes('://') ? new URL(value) : new URL(`https://${value}`)
	if (!parsed.hostname) {
		throw new Error('enterpriseUrl must include a hostname')
	}
	return parsed.host
}

export function getCopilotApiBaseUrl(enterpriseUrl?: string): string {
	return enterpriseUrl
		? `https://copilot-api.${normalizeEnterpriseUrl(enterpriseUrl)}`
		: 'https://api.githubcopilot.com'
}

export function buildCopilotUserAgent(version: string): string {
	return `opencode/${version}`
}

export function getCopilotOAuthUrls(enterpriseUrl?: string): {
	deviceCodeUrl: string
	accessTokenUrl: string
} {
	const domain = enterpriseUrl ? normalizeEnterpriseUrl(enterpriseUrl) : 'github.com'
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	}
}

export async function writeCopilotOAuthTokens(
	store: AuthStore,
	providerId: string,
	tokens: { access_token: string; scope?: string; token_type?: string },
	enterpriseUrl?: string,
): Promise<OAuthAuthInfo> {
	const auth: StoredCopilotOAuthAuthInfo = {
		kind: 'oauth',
		accessToken: tokens.access_token,
		refreshToken: tokens.access_token,
		expiresAt: 0,
		scope: tokens.scope,
		tokenType: tokens.token_type,
		...(enterpriseUrl ? { enterpriseUrl: normalizeEnterpriseUrl(enterpriseUrl) } : {}),
	}
	await store.set(providerId, auth)
	return auth
}

export async function startDeviceOAuth(options: StartCopilotDeviceOAuthOptions): Promise<DeviceAuthorizationResult> {
	const fetchFn = options.fetch ?? globalThis.fetch
	const providerId = options.providerId ?? COPILOT_PROVIDER_ID
	const urls = getCopilotOAuthUrls(options.enterpriseUrl)
	const userAgent = buildCopilotUserAgent(options.version ?? '0.0.0')
	const response = await fetchFn(urls.deviceCodeUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'User-Agent': userAgent,
		},
		body: JSON.stringify({
			client_id: COPILOT_CLIENT_ID,
			scope: 'read:user',
		}),
	})

	if (!response.ok) {
		throw new Error('Failed to initiate device authorization')
	}

	const deviceData = (await response.json()) as DeviceAuthorizationResponse

	return {
		url: deviceData.verification_uri,
		userCode: deviceData.user_code,
		async complete() {
			while (true) {
				const tokenResponse = await fetchFn(urls.accessTokenUrl, {
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
						'User-Agent': userAgent,
					},
					body: JSON.stringify({
						client_id: COPILOT_CLIENT_ID,
						device_code: deviceData.device_code,
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					}),
				})

				if (!tokenResponse.ok) {
					return { kind: 'failed' }
				}

				const data = (await tokenResponse.json()) as CopilotDeviceCodeResponse
				if (data.access_token) {
					const auth = await writeCopilotOAuthTokens(
						options.store,
						providerId,
						data as { access_token: string; scope?: string; token_type?: string },
						options.enterpriseUrl,
					)
					return { kind: 'success', auth }
				}

				if (data.error === 'authorization_pending') {
					await sleep(deviceData.interval * 1_000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
					continue
				}

				if (data.error === 'slow_down') {
					const serverInterval = data.interval
					const nextInterval =
						typeof serverInterval === 'number' && serverInterval > 0
							? serverInterval
							: deviceData.interval + 5
					await sleep(nextInterval * 1_000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
					continue
				}

				if (data.error) {
					return { kind: 'failed' }
				}

				await sleep(deviceData.interval * 1_000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
			}
		},
	}
}
