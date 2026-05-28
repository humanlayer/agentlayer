import { createOpenAI } from '@ai-sdk/openai'
import { NoSuchModelError, type ProviderV3 } from '@ai-sdk/provider'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { buildCodexUserAgent } from '../../shared/auth'
import { CODEX_API_ENDPOINT, CODEX_DEFAULT_VERSION, DEFAULT_CHUNK_TIMEOUT_MS } from '../../shared/constants'
import { createCodexFetch } from '../../shared/fetch'
import { wrapSSE } from '../../shared/sse'
import type { CodexProviderOptions } from '../../shared/types'
import type { CodexFetchLike } from '../../oauth'
import { normalizeCodexServiceTier } from '../../shared/service-tier'
import { CODEX_FAST_SERVICE_TIER } from '../../shared/constants'
import { resolveCodexAuth } from '../../shared/auth'

export interface CodexResponsesProviderOptions extends CodexProviderOptions {
	/**
	 * Timeout in milliseconds between streamed SSE chunks. If no chunk arrives
	 * within this window, the request is aborted. Set to 0 or false to disable.
	 * @default 120000 (2 minutes)
	 */
	chunkTimeout?: number | false
}

/**
 * Creates a thin Codex provider that delegates SSE parsing to upstream
 * `@ai-sdk/openai.responses()`. Only auth, headers, URL rewriting, and
 * request body cleanup are handled here.
 */
export function createCodexResponsesProvider(options: CodexResponsesProviderOptions = {}): ProviderV3 {
	const authStore = options.authStore ?? createFileAuthStore()
	const providerId = options.providerId ?? 'codex'
	const version = options.version ?? CODEX_DEFAULT_VERSION
	const fetchFn: CodexFetchLike = options.fetch ?? globalThis.fetch
	const now = options.now ?? Date.now
	const chunkTimeout = options.chunkTimeout === false ? 0 : (options.chunkTimeout ?? DEFAULT_CHUNK_TIMEOUT_MS)

	const codexFetch: CodexFetchLike = async (input, init): Promise<Response> => {
		const auth = await resolveCodexAuth(authStore, providerId, fetchFn, now)

		const headers = new Headers(init?.headers)

		// Strip any dummy authorization header that @ai-sdk/openai may have added
		headers.delete('authorization')

		// Set real Codex auth
		const token = auth.kind === 'api' ? auth.apiKey : auth.accessToken
		headers.set('authorization', `Bearer ${token}`)
		headers.set('originator', 'opencode')
		headers.set('User-Agent', buildCodexUserAgent(version))

		if (options.sessionId) {
			headers.set('session_id', options.sessionId)
		}

		if (auth.kind === 'oauth' && auth.accountId) {
			headers.set('ChatGPT-Account-Id', auth.accountId)
		}

		// Transform request body for Codex requirements
		let body = init?.body
		if (body && init?.method === 'POST') {
			const parsed = JSON.parse(body as string)

			// Force Codex defaults
			parsed.store = false
			parsed.include = parsed.include ?? ['reasoning.encrypted_content']

			// Remove fields Codex rejects
			delete parsed.previous_response_id
			delete parsed.max_output_tokens

			// Normalize service_tier
			if (parsed.service_tier !== undefined) {
				parsed.service_tier = normalizeCodexServiceTier(parsed.service_tier)
			}

			// Apply fastMode if set at provider level and not overridden
			if (options.fastMode && parsed.service_tier == null) {
				parsed.service_tier = CODEX_FAST_SERVICE_TIER
			}

			// Extract system messages from input and move to instructions field.
			// Codex requires instructions to be set, but upstream SDK puts system
			// messages in the input array.
			if (Array.isArray(parsed.input)) {
				const systemTexts: string[] = []
				const nonSystemInput: unknown[] = []

				for (const item of parsed.input) {
					const role = (item as { role?: string }).role
					if (role === 'system') {
						const content = (item as { content?: unknown }).content
						if (Array.isArray(content)) {
							for (const part of content) {
								if ((part as { type?: string }).type === 'input_text') {
									const text = (part as { text?: string }).text
									if (text) systemTexts.push(text)
								}
							}
						} else if (typeof content === 'string') {
							systemTexts.push(content)
						}
					} else {
						nonSystemInput.push(item)
					}
				}

				if (systemTexts.length > 0) {
					parsed.instructions = systemTexts.join('\n\n')
					parsed.input = nonSystemInput
				}
			}

			// Codex requires instructions - provide empty string as fallback
			if (parsed.instructions == null) {
				parsed.instructions = ''
			}

			// Strip id fields from input items (Codex rejects them when store=false)
			if (Array.isArray(parsed.input)) {
				for (const item of parsed.input) {
					if ('id' in item) {
						delete item.id
					}
				}
			}

			body = JSON.stringify(parsed)
		}

		// Rewrite URL to Codex endpoint
		const url = new URL(input.toString())
		const finalUrl = url.pathname.includes('/v1/responses') ? CODEX_API_ENDPOINT : url.toString()

		// Set up chunk timeout abort controller if enabled
		const chunkAbortCtl = chunkTimeout > 0 ? new AbortController() : undefined

		// Combine signals: caller's signal + chunk timeout signal
		const signals: AbortSignal[] = []
		if (init?.signal) signals.push(init.signal)
		if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)

		const combinedSignal =
			signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

		const res = await fetchFn(finalUrl, { ...init, headers, body, signal: combinedSignal })

		// Wrap SSE responses with per-chunk timeout watchdog
		if (!chunkAbortCtl) return res
		return wrapSSE(res, chunkTimeout, chunkAbortCtl)
	}

	const openai = createOpenAI({
		apiKey: 'codex-oauth-placeholder', // stripped by codexFetch
		fetch: codexFetch as typeof fetch,
	})

	return {
		specificationVersion: 'v3',

		languageModel(modelId: string) {
			return openai.responses(modelId)
		},

		embeddingModel(modelId: string) {
			throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' })
		},

		imageModel(modelId: string) {
			throw new NoSuchModelError({ modelId, modelType: 'imageModel' })
		},

		transcriptionModel(modelId: string) {
			throw new NoSuchModelError({ modelId, modelType: 'transcriptionModel' })
		},

		speechModel(modelId: string) {
			throw new NoSuchModelError({ modelId, modelType: 'speechModel' })
		},

		rerankingModel(modelId: string) {
			throw new NoSuchModelError({ modelId, modelType: 'rerankingModel' })
		},
	}
}
