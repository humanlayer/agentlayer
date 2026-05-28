/**
 * Hand-rolled fetch/SSE Codex provider using the vendored openai-responses
 * protocol parser. This is the "custom_responses" path — it does its own
 * HTTP fetch, SSE frame parsing, and protocol state machine stepping,
 * producing AI SDK LanguageModelV3StreamPart values directly.
 *
 * Compared to the published v0.0.35 codex-effect.ts this is based on, the
 * following fixes have been applied:
 * - Terminal SSE events (response.completed/incomplete/failed) break the
 *   outer reader loop and cancel the underlying reader (DQ3 Option A)
 * - provider-error LLM events map to AI SDK { type: 'error' } parts (DQ5)
 */
import {
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	type LanguageModelV3Content,
	type LanguageModelV3FinishReason,
	type LanguageModelV3StreamPart,
	type LanguageModelV3Usage,
	NoSuchModelError,
	type ProviderV3,
} from '@ai-sdk/provider'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { protocol } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'
import { Effect, Schema } from 'effect'
import { buildCodexUserAgent } from '../../shared/auth'
import { CODEX_API_ENDPOINT, CODEX_DEFAULT_VERSION, DEFAULT_CHUNK_TIMEOUT_MS } from '../../shared/constants'
import { type AnyLLMEvent, emptyUsage, llmEventToStreamParts } from '../../shared/events'
import { createCodexFetch } from '../../shared/fetch'
import { parseSseEvents, wrapSSE } from '../../shared/sse'
import type { CodexProviderOptions } from '../../shared/types'
import type { CodexFetchLike } from '../../oauth'
import { convertPromptToBody } from './body'

export interface CodexCustomResponsesProviderOptions extends CodexProviderOptions {
	chunkTimeout?: number | false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const decodeEvent = Schema.decodeUnknownSync(protocol.stream.event as any)

const TERMINAL_TYPES = new Set(['response.completed', 'response.incomplete', 'response.failed'])

function createCustomResponsesCodexModel(
	modelId: string,
	codexFetch: CodexFetchLike,
	chunkTimeout: number,
): LanguageModelV3 {
	return {
		specificationVersion: 'v3',
		provider: 'codex-custom-responses',
		modelId,
		supportedUrls: {},

		async doGenerate(options) {
			const streamResult = await this.doStream(options)
			const parts: LanguageModelV3StreamPart[] = []
			const reader = streamResult.stream.getReader()
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				parts.push(value)
			}

			const content: LanguageModelV3Content[] = []
			let usage: LanguageModelV3Usage = emptyUsage
			let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined }
			let text = ''

			for (const part of parts) {
				if (part.type === 'text-delta') text += part.delta
				if (part.type === 'tool-call') {
					content.push({
						type: 'tool-call',
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						input: part.input,
					})
				}
				if (part.type === 'finish') {
					usage = part.usage
					finishReason = part.finishReason
				}
			}

			if (text) {
				content.push({ type: 'text', text })
			}

			return {
				content,
				finishReason,
				usage,
				warnings: [],
				request: streamResult.request,
				response: streamResult.response,
			}
		},

		async doStream(options) {
			const body = convertPromptToBody(modelId, options)
			const bodyStr = JSON.stringify(body)

			const chunkAbortCtl = chunkTimeout > 0 ? new AbortController() : undefined
			const signals: AbortSignal[] = []
			if (options.abortSignal) signals.push(options.abortSignal)
			if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
			const combinedSignal =
				signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

			let rawRes = await codexFetch(CODEX_API_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: bodyStr,
				signal: combinedSignal,
			})

			if (!rawRes.ok) {
				const text = await rawRes.text()
				throw new Error(`Codex API error ${rawRes.status}: ${text}`)
			}

			if (chunkAbortCtl && chunkTimeout > 0) {
				rawRes = wrapSSE(rawRes, chunkTimeout, chunkAbortCtl)
			}

			const responseHeaders: Record<string, string> = {}
			rawRes.headers.forEach((value, key) => {
				responseHeaders[key] = value
			})

			const responseBody = rawRes.body

			const stream = new ReadableStream<LanguageModelV3StreamPart>({
				async start(controller) {
					if (!responseBody) {
						controller.error(new Error('Missing response body'))
						return
					}

					const reader = responseBody.getReader()
					const decoder = new TextDecoder()
					let buffer = ''
					let parserState = protocol.stream.initial()
					let finishSeen = false
					let providerErrorSeen = false
					// DQ3: Track terminal SSE events to break the outer reader loop
					let terminalSeen = false

					controller.enqueue({ type: 'stream-start', warnings: [] })

					try {
						// DQ3: terminalSeen breaks the outer loop, not just the inner one
						while (!terminalSeen) {
							const { done, value } = await reader.read()
							if (done) break
							buffer += decoder.decode(value, { stream: true })

							const parsed = parseSseEvents(buffer)
							buffer = parsed.remainder

							for (const eventJson of parsed.events) {
								let decodedEvent: unknown
								try {
									decodedEvent = decodeEvent(eventJson)
								} catch {
									continue
								}

								const result = Effect.runSync(protocol.stream.step(parserState, decodedEvent as never))
								const [nextState, events] = result as unknown as [typeof parserState, AnyLLMEvent[]]
								parserState = nextState

								for (const llmEvent of events) {
									for (const part of llmEventToStreamParts(llmEvent)) {
										controller.enqueue(part)
										if (part.type === 'finish') finishSeen = true
										if (part.type === 'error') providerErrorSeen = true
									}
								}

								// DQ3: Terminal event sets flag to break outer loop
								if (TERMINAL_TYPES.has((decodedEvent as AnyLLMEvent).type)) {
									terminalSeen = true
									break
								}
							}
						}

						// DQ3: Cancel the reader if we stopped due to a terminal event
						if (terminalSeen) {
							await reader.cancel('terminal SSE event received')
						}

						// Only process trailing buffer if we exited via EOF (not terminal)
						if (!terminalSeen) {
							buffer += decoder.decode()
							if (buffer.trim()) {
								const trailing = parseSseEvents(buffer)
								for (const eventJson of trailing.events) {
									let decodedEvent: unknown
									try {
										decodedEvent = decodeEvent(eventJson)
									} catch {
										continue
									}
									const result = Effect.runSync(
										protocol.stream.step(parserState, decodedEvent as never),
									)
									const [nextState, events] = result as unknown as [typeof parserState, AnyLLMEvent[]]
									parserState = nextState
									for (const llmEvent of events) {
										for (const part of llmEventToStreamParts(llmEvent)) {
											controller.enqueue(part)
											if (part.type === 'finish') finishSeen = true
											if (part.type === 'error') providerErrorSeen = true
										}
									}
								}
							}
						}

						// Emit a fallback finish if we never saw one and no error was emitted
						if (!finishSeen && !providerErrorSeen) {
							controller.enqueue({
								type: 'finish',
								finishReason: { unified: 'stop', raw: undefined },
								usage: emptyUsage,
							})
						}

						controller.close()
					} catch (error) {
						controller.error(error)
					} finally {
						reader.releaseLock()
					}
				},
			})

			return {
				stream,
				request: { body },
				response: { headers: responseHeaders },
			}
		},
	}
}

export function createCodexCustomResponsesProvider(options: CodexCustomResponsesProviderOptions = {}): ProviderV3 {
	const authStore = options.authStore ?? createFileAuthStore()
	const providerId = options.providerId ?? 'codex'
	const version = options.version ?? CODEX_DEFAULT_VERSION
	const fetchFn: CodexFetchLike = options.fetch ?? globalThis.fetch
	const now = options.now ?? Date.now
	const chunkTimeout = options.chunkTimeout === false ? 0 : (options.chunkTimeout ?? DEFAULT_CHUNK_TIMEOUT_MS)

	const codexFetch = createCodexFetch({
		authStore,
		providerId,
		fetchFn,
		now,
		version,
		userAgent: buildCodexUserAgent(version),
		sessionId: options.sessionId,
		fastMode: options.fastMode,
	})

	return {
		specificationVersion: 'v3',

		languageModel(modelId: string) {
			return createCustomResponsesCodexModel(modelId, codexFetch, chunkTimeout)
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
