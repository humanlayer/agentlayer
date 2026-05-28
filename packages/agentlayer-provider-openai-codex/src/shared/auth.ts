import os from 'node:os'
import type { AuthInfo, AuthStore, OAuthAuthInfo } from '@humanlayer/agentlayer-provider-auth'
import type { CodexFetchLike } from '../oauth'
import { refreshAccessToken } from '../oauth'

export function buildCodexUserAgent(version: string): string {
	return `opencode/${version} (${os.platform()} ${os.release()}; ${os.arch()})`
}

export async function resolveCodexAuth(
	store: AuthStore,
	providerId: string,
	fetchFn: CodexFetchLike,
	now: () => number,
): Promise<AuthInfo> {
	const auth = await store.get(providerId)
	if (!auth) {
		throw new Error(`Missing auth for provider: ${providerId}`)
	}

	if (auth.kind !== 'oauth') {
		return auth
	}

	if (!auth.refreshToken || !isExpired(auth, now())) {
		return auth
	}

	const refreshed = await refreshAccessToken(auth.refreshToken, fetchFn)
	const updated: OAuthAuthInfo = {
		...auth,
		accessToken: refreshed.access_token ?? auth.accessToken,
		refreshToken: refreshed.refresh_token ?? auth.refreshToken,
		idToken: refreshed.id_token ?? auth.idToken,
		expiresAt: now() + (refreshed.expires_in ?? 3600) * 1000,
	}

	await store.set(providerId, updated)
	return updated
}

function isExpired(auth: OAuthAuthInfo, now: number): boolean {
	return auth.expiresAt != null && auth.expiresAt <= now
}
