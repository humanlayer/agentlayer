import { createOpenAI } from '@ai-sdk/openai'
import type { AuthStore } from './auth'
import { requireAuth, writeAuth } from './auth'
import { extractAccountId } from './codex-jwt'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const ISSUER = 'https://auth.openai.com'
const OAUTH_DUMMY_KEY = 'humanlayer-agent-sdk-oauth-dummy'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

async function refreshAccessToken(refreshToken: string) {
	const resp = await fetch(`${ISSUER}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	})
	if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`)
	return resp.json() as Promise<{
		access_token: string
		refresh_token: string
		id_token?: string
		expires_in?: number
	}>
}

// Transform the request body to match what the Codex backend expects:
// - Extract developer/system messages from `input` → top-level `instructions`
// - Set `store: false` (required)
// - Set `stream: true` (required)
// - Remove `max_output_tokens` (unsupported)
// - Remove `include` (unsupported)
function transformCodexBody(rawBody: string): string {
	try {
		const body = JSON.parse(rawBody)

		// Extract developer/system message into top-level instructions
		if (Array.isArray(body.input)) {
			const devIdx = body.input.findIndex((m: { role?: string }) => m.role === 'developer' || m.role === 'system')
			if (devIdx !== -1) {
				const dev = body.input[devIdx]
				body.instructions = typeof dev.content === 'string' ? dev.content : ''
				body.input.splice(devIdx, 1)
			}
		}

		// Codex backend requirements
		if (!body.instructions) body.instructions = ''
		body.store = false
		body.stream = true
		delete body.max_output_tokens

		return JSON.stringify(body)
	} catch {
		return rawBody
	}
}

export interface CodexProviderOptions {
	authStore?: AuthStore
}

export function codexProvider(opts?: CodexProviderOptions) {
	const authRequire = opts?.authStore ? opts.authStore.requireAuth : requireAuth
	const authWrite = opts?.authStore ? opts.authStore.writeAuth : writeAuth

	const customFetch: typeof globalThis.fetch = Object.assign(
		async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			let auth = await authRequire('openai', 'npx @humanlayer/agent-sdk auth codex', 'oauth')

			// Lazy token refresh
			if (!auth.access || auth.expires < Date.now()) {
				const tokens = await refreshAccessToken(auth.refresh)
				const newAccountId = extractAccountId(tokens) || auth.accountId
				const newAuth = {
					type: 'oauth' as const,
					refresh: tokens.refresh_token,
					access: tokens.access_token,
					expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					...(newAccountId ? { accountId: newAccountId } : {}),
				}
				await authWrite('openai', newAuth)
				auth = newAuth
			}

			// Auth headers
			const headers = new Headers(init?.headers)
			headers.delete('authorization')
			headers.set('Authorization', `Bearer ${auth.access}`)
			if (auth.accountId) {
				headers.set('ChatGPT-Account-Id', auth.accountId)
			}

			// URL rewrite to Codex endpoint
			const parsed = typeof url === 'string' ? new URL(url) : url instanceof URL ? url : new URL(url.url)
			const isCodexEndpoint =
				parsed.pathname.includes('/v1/responses') || parsed.pathname.includes('/chat/completions')
			const finalUrl = isCodexEndpoint ? CODEX_RESPONSES_URL : parsed.toString()

			// Transform body for Codex backend
			let finalBody = init?.body
			let callerWantsStream = false
			if (isCodexEndpoint && init?.body && typeof init.body === 'string') {
				try {
					const parsed = JSON.parse(init.body)
					callerWantsStream = !!parsed.stream
				} catch {}
				finalBody = transformCodexBody(init.body)
			}

			const res = await globalThis.fetch(finalUrl, { ...init, body: finalBody, headers })

			// If we forced stream:true but the caller didn't want streaming,
			// collect the SSE response and return the final response.completed event as JSON
			if (isCodexEndpoint && !callerWantsStream && res.ok && res.body) {
				const text = await res.text()
				const lines = text.split('\n')
				let finalData = ''
				for (const line of lines) {
					if (line.startsWith('data: ')) {
						finalData = line.slice(6)
					}
				}
				// The last data line with response.completed has the full response
				if (finalData) {
					try {
						const event = JSON.parse(finalData)
						// response.completed wraps the response in .response
						const responseBody = event.response ?? event
						return new Response(JSON.stringify(responseBody), {
							status: res.status,
							headers: { 'content-type': 'application/json' },
						})
					} catch {}
				}
				return new Response(text, { status: res.status, headers: res.headers })
			}

			return res
		},
		{ preconnect: globalThis.fetch.preconnect },
	)

	const openai = createOpenAI({
		apiKey: OAUTH_DUMMY_KEY,
		fetch: customFetch,
	})

	return (modelId: string) => openai.responses(modelId)
}
