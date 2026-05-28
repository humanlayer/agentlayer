import type { AuthStore } from '@humanlayer/agentlayer-provider-auth'
import type { CodexFetchLike } from '../oauth'
import { resolveCodexAuth } from './auth'
import { CODEX_FAST_SERVICE_TIER } from './constants'
import { normalizeCodexServiceTier } from './service-tier'

export function createCodexFetch(options: {
	authStore: AuthStore
	providerId: string
	fetchFn: CodexFetchLike
	now: () => number
	version: string
	userAgent: string
	sessionId?: string
	fastMode?: boolean
}): CodexFetchLike {
	const { authStore, providerId, fetchFn, now, userAgent, sessionId, fastMode } = options

	return async (input, init): Promise<Response> => {
		const auth = await resolveCodexAuth(authStore, providerId, fetchFn, now)

		const headers = new Headers(init?.headers)
		headers.delete('authorization')

		const token = auth.kind === 'api' ? auth.apiKey : auth.accessToken
		headers.set('authorization', `Bearer ${token}`)
		headers.set('originator', 'opencode')
		headers.set('User-Agent', userAgent)

		if (sessionId) {
			headers.set('session_id', sessionId)
		}

		if (auth.kind === 'oauth' && auth.accountId) {
			headers.set('ChatGPT-Account-Id', auth.accountId)
		}

		let body = init?.body
		if (body && init?.method === 'POST') {
			const parsed = JSON.parse(body as string)

			parsed.store = false
			parsed.include = parsed.include ?? ['reasoning.encrypted_content']

			delete parsed.previous_response_id
			delete parsed.max_output_tokens

			if (parsed.service_tier !== undefined) {
				parsed.service_tier = normalizeCodexServiceTier(parsed.service_tier)
			}

			if (fastMode && parsed.service_tier == null) {
				parsed.service_tier = CODEX_FAST_SERVICE_TIER
			}

			body = JSON.stringify(parsed)
		}

		return fetchFn(input, { ...init, headers, body })
	}
}
