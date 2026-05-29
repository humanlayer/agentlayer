import { createOpenAI } from '@ai-sdk/openai'
import { NoSuchModelError, type ProviderV3 } from '@ai-sdk/provider'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import type { CodexFetchLike } from '../../oauth'
import { buildCodexUserAgent, resolveCodexAuth } from '../../shared/auth'
import {
	CODEX_API_ENDPOINT,
	CODEX_DEFAULT_VERSION,
	CODEX_FAST_SERVICE_TIER,
	CODEX_HEADER_TIMEOUT_MS,
	DEFAULT_CHUNK_TIMEOUT_MS,
} from '../../shared/constants'
import { normalizeCodexServiceTier } from '../../shared/service-tier'
import { wrapSSE } from '../../shared/sse'
import type { CodexDiagnosticRecord, CodexDiagnosticsContext, CodexProviderOptions } from '../../shared/types'

export interface CodexResponsesProviderOptions extends CodexProviderOptions {
	/**
	 * Timeout in milliseconds between streamed SSE chunks. If no chunk arrives
	 * within this window, the request is aborted. Set to 0 or false to disable.
	 * @default 120000 (2 minutes)
	 */
	chunkTimeout?: number | false
	/**
	 * Timeout in milliseconds for receiving the initial response headers from
	 * the server. If headers are not received within this window, the request
	 * is aborted. Set to 0 or false to disable.
	 * @default 10000 (10 seconds)
	 */
	headerTimeout?: number | false
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
	const headerTimeout = options.headerTimeout === false ? 0 : (options.headerTimeout ?? CODEX_HEADER_TIMEOUT_MS)
	const diagnostics = options.diagnostics

	const emit = (
		event: string,
		severity: CodexDiagnosticRecord['severity'],
		metadata: Record<string, unknown>,
	) => {
		diagnostics?.onEvent({
			event,
			severity,
			transport: 'aisdk_responses',
			annotations: diagnostics.annotations,
			metadata,
		})
	}

	const codexFetch: CodexFetchLike = async (input, init): Promise<Response> => {
		let auth: Awaited<ReturnType<typeof resolveCodexAuth>>
		try {
			auth = await resolveCodexAuth(authStore, providerId, fetchFn, now)
		} catch (error) {
			emit('codex.provider.auth.failed', 'error', {
				terminal: true,
				error: error instanceof Error ? error.message : String(error),
			})
			throw error
		}

		const headers = new Headers(init?.headers)

		// Strip any dummy authorization header that @ai-sdk/openai may have added
		headers.delete('authorization')

		// Set real Codex auth
		const token = auth.kind === 'api' ? auth.apiKey : auth.accessToken
		headers.set('authorization', `Bearer ${token}`)
		headers.set('originator', 'opencode')
		headers.set('User-Agent', buildCodexUserAgent(version))

		if (options.sessionId) {
			headers.set('session-id', options.sessionId)
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

		// Set up header timeout abort controller if enabled
		const headerAbortCtl = headerTimeout > 0 ? new AbortController() : undefined
		let headerTimeoutId: ReturnType<typeof setTimeout> | undefined
		if (headerAbortCtl) {
			headerTimeoutId = setTimeout(() => {
				emit('codex.provider.fetch.header_timeout', 'error', {
					terminal: true,
					timeoutMs: headerTimeout,
					url: finalUrl,
				})
				headerAbortCtl.abort()
			}, headerTimeout)
		}

		// Combine signals: caller's signal + chunk timeout + header timeout
		const signals: AbortSignal[] = []
		if (init?.signal) signals.push(init.signal)
		if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
		if (headerAbortCtl) signals.push(headerAbortCtl.signal)

		const combinedSignal =
			signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

		let res: Response
		try {
			res = await fetchFn(finalUrl, { ...init, headers, body, signal: combinedSignal })
		} catch (error) {
			const isAbort = error instanceof DOMException && error.name === 'AbortError'
			emit('codex.provider.fetch.failed', 'error', {
				terminal: true,
				error: error instanceof Error ? error.message : String(error),
				isAbort,
				url: finalUrl,
			})
			throw error
		} finally {
			if (headerTimeoutId) clearTimeout(headerTimeoutId)
		}

		if (!res.ok) {
			emit('codex.provider.fetch.http_error', 'error', {
				terminal: false,
				status: res.status,
				statusText: res.statusText,
				url: finalUrl,
			})
		}

		// Wrap SSE responses with per-chunk timeout watchdog
		if (!chunkAbortCtl) return res
		return wrapSSE(res, chunkTimeout, chunkAbortCtl, () => {
			emit('codex.provider.fetch.chunk_timeout', 'error', {
				terminal: true,
				timeoutMs: chunkTimeout,
				url: finalUrl,
			})
		})
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
