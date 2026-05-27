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
import {
	buildCodexUserAgent,
	CODEX_API_ENDPOINT,
	CODEX_DEFAULT_VERSION,
	CODEX_FAST_SERVICE_TIER,
	type CodexProviderOptions,
	normalizeCodexServiceTier,
	resolveCodexAuth,
} from './codex'
import type { CodexFetchLike } from './codex-oauth'

const DEFAULT_CHUNK_TIMEOUT_MS = 120_000

export interface CodexCustomResponsesProviderOptions extends CodexProviderOptions {
	chunkTimeout?: number | false
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function parseSseEvents(buffer: string): { events: string[]; remainder: string } {
	const events: string[] = []
	let pos = 0
	while (true) {
		const boundary = buffer.indexOf('\n\n', pos)
		if (boundary === -1) break
		const block = buffer.slice(pos, boundary)
		pos = boundary + 2
		const dataLines: string[] = []
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
		}
		const data = dataLines.join('\n')
		if (data && data !== '[DONE]') events.push(data)
	}
	return { events, remainder: buffer.slice(pos) }
}

// ---------------------------------------------------------------------------
// AI SDK prompt → OpenAI Responses body
// ---------------------------------------------------------------------------

function strictifySchema(schema: Record<string, unknown>) {
	delete schema.format
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (props) {
		schema.required = Object.keys(props)
		schema.additionalProperties = false
		for (const prop of Object.values(props)) {
			strictifySchema(prop)
		}
	}
	const items = schema.items as Record<string, unknown> | undefined
	if (items) strictifySchema(items)
	const anyOf = schema.anyOf as Record<string, unknown>[] | undefined
	if (anyOf) for (const s of anyOf) strictifySchema(s)
	const oneOf = schema.oneOf as Record<string, unknown>[] | undefined
	if (oneOf) for (const s of oneOf) strictifySchema(s)
}

function convertPromptToBody(modelId: string, options: LanguageModelV3CallOptions): Record<string, unknown> {
	const input: Record<string, unknown>[] = []
	const systemTexts: string[] = []

	for (const message of options.prompt) {
		switch (message.role) {
			case 'system': {
				systemTexts.push(message.content)
				break
			}
			case 'user': {
				const content: Record<string, unknown>[] = []
				for (const part of message.content) {
					if (part.type === 'text') {
						content.push({ type: 'input_text', text: part.text })
					} else if (part.type === 'file' && part.mediaType.startsWith('image/')) {
						if (part.data instanceof URL) {
							content.push({ type: 'input_image', image_url: part.data.toString() })
						} else if (typeof part.data === 'string') {
							content.push({
								type: 'input_image',
								image_url: `data:${part.mediaType};base64,${part.data}`,
							})
						}
					}
				}
				input.push({ role: 'user', content })
				break
			}
			case 'assistant': {
				const content: Record<string, unknown>[] = []
				const toolCalls: Record<string, unknown>[] = []
				for (const part of message.content) {
					switch (part.type) {
						case 'text':
							content.push({ type: 'output_text', text: part.text })
							break
						case 'reasoning': {
							const openai = part.providerOptions?.openai as Record<string, unknown> | undefined
							const itemId = openai?.itemId as string | undefined
							if (!itemId) break
							const encryptedContent = openai?.reasoningEncryptedContent as string | null | undefined
							// store is always false for codex — drop items without encrypted_content
							if (typeof encryptedContent !== 'string') break
							input.push({
								type: 'reasoning',
								id: itemId,
								summary: part.text ? [{ type: 'summary_text', text: part.text }] : [],
								encrypted_content:
									typeof encryptedContent === 'string'
										? encryptedContent
										: encryptedContent === null
											? null
											: undefined,
							})
							break
						}
						case 'tool-call':
							toolCalls.push({
								type: 'function_call',
								name: part.toolName,
								call_id: part.toolCallId,
								arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
							})
							break
					}
				}
				if (content.length > 0) input.push({ role: 'assistant', content })
				for (const tc of toolCalls) input.push(tc)
				break
			}
			case 'tool': {
				for (const part of message.content) {
					if (part.type === 'tool-result') {
						const output =
							part.output.type === 'text'
								? part.output.value
								: part.output.type === 'json'
									? JSON.stringify(part.output.value)
									: JSON.stringify(part.output)
						input.push({
							type: 'function_call_output',
							call_id: part.toolCallId,
							output,
						})
					}
				}
				break
			}
		}
	}

	const tools: Record<string, unknown>[] = []
	if (options.tools) {
		for (const tool of options.tools) {
			if (tool.type === 'function') {
				const schema = structuredClone(tool.inputSchema) as Record<string, unknown>
				strictifySchema(schema)
				tools.push({
					type: 'function',
					name: tool.name,
					description: tool.description,
					parameters: schema,
					strict: true,
				})
			}
		}
	}

	const body: Record<string, unknown> = {
		model: modelId,
		input,
		stream: true,
		store: false,
		instructions: systemTexts.join('\n\n') || '',
	}

	if (tools.length > 0) body.tools = tools

	if (options.toolChoice) {
		switch (options.toolChoice.type) {
			case 'auto':
				body.tool_choice = 'auto'
				break
			case 'none':
				body.tool_choice = 'none'
				break
			case 'required':
				body.tool_choice = 'required'
				break
			case 'tool':
				body.tool_choice = { type: 'function', name: options.toolChoice.toolName }
				break
		}
	}

	if (options.temperature !== undefined) body.temperature = options.temperature
	if (options.topP !== undefined) body.top_p = options.topP
	if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens
	if (options.seed !== undefined) body.seed = options.seed

	const providerOptions = options.providerOptions?.openai as Record<string, unknown> | undefined
	const reasoningEffort = providerOptions?.reasoningEffort as string | undefined
	const reasoningSummary = providerOptions?.reasoningSummary as string | undefined
	const promptCacheKey = providerOptions?.promptCacheKey as string | undefined
	const serviceTier = providerOptions?.serviceTier as string | null | undefined
	const fastMode = providerOptions?.fastMode as boolean | undefined
	const include = providerOptions?.include as string[] | undefined

	body.reasoning = {
		effort: reasoningEffort ?? 'medium',
		summary: reasoningSummary ?? 'auto',
	}

	if (promptCacheKey) body.prompt_cache_key = promptCacheKey
	if (serviceTier !== undefined) body.service_tier = serviceTier
	else if (fastMode) body.service_tier = 'priority'
	if (include) body.include = include

	return body
}

// ---------------------------------------------------------------------------
// LLMEvent → LanguageModelV3StreamPart
// ---------------------------------------------------------------------------

function convertUsage(event: Record<string, unknown>): LanguageModelV3Usage {
	const u = event.usage as Record<string, number | undefined> | undefined
	return {
		inputTokens: {
			total: u?.inputTokens ?? 0,
			noCache: u?.nonCachedInputTokens ?? undefined,
			cacheRead: u?.cacheReadInputTokens ?? undefined,
			cacheWrite: u?.cacheWriteInputTokens ?? undefined,
		},
		outputTokens: {
			total: u?.outputTokens ?? 0,
			reasoning: u?.reasoningTokens ?? undefined,
			text: u ? Math.max(0, (u.outputTokens ?? 0) - (u.reasoningTokens ?? 0)) : undefined,
		},
	}
}

function convertFinishReason(reason: string): LanguageModelV3FinishReason {
	const map: Record<string, 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'> = {
		stop: 'stop',
		length: 'length',
		'content-filter': 'content-filter',
		'tool-calls': 'tool-calls',
		error: 'error',
	}
	return { unified: map[reason] ?? 'other', raw: reason }
}

const emptyUsage: LanguageModelV3Usage = {
	inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 0, text: undefined, reasoning: undefined },
}

// The LLMEvent type is a tagged union from Effect Schema. We access fields via record indexing.
type AnyLLMEvent = Record<string, unknown> & { type: string }

function llmEventToStreamParts(event: AnyLLMEvent): LanguageModelV3StreamPart[] {
	switch (event.type) {
		case 'text-start':
			return [
				{ type: 'text-start', id: event.id as string, providerMetadata: event.providerMetadata as undefined },
			]
		case 'text-delta':
			return [{ type: 'text-delta', id: event.id as string, delta: event.text as string }]
		case 'text-end':
			return [{ type: 'text-end', id: event.id as string }]
		case 'reasoning-start':
			return [{ type: 'reasoning-start', id: event.id as string }]
		case 'reasoning-delta':
			return [{ type: 'reasoning-delta', id: event.id as string, delta: event.text as string }]
		case 'reasoning-end':
			return [{ type: 'reasoning-end', id: event.id as string }]
		case 'tool-input-start':
			return [{ type: 'tool-input-start', id: event.id as string, toolName: event.name as string }]
		case 'tool-input-delta':
			return [{ type: 'tool-input-delta', id: event.id as string, delta: event.text as string }]
		case 'tool-input-end':
			return [{ type: 'tool-input-end', id: event.id as string }]
		case 'tool-call':
			return [
				{
					type: 'tool-call',
					toolCallId: event.id as string,
					toolName: event.name as string,
					input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input),
				},
			]
		case 'finish':
			return [
				{
					type: 'finish',
					finishReason: convertFinishReason(event.reason as string),
					usage: convertUsage(event),
				},
			]
		// DQ5: Map provider-error to AI SDK error part
		case 'provider-error':
			return [{ type: 'error', error: new Error(event.message as string) }]
		default:
			return []
	}
}

// ---------------------------------------------------------------------------
// wrapSSE
// ---------------------------------------------------------------------------

function wrapSSE(res: Response, timeoutMs: number, abortCtl: AbortController): Response {
	if (typeof timeoutMs !== 'number' || timeoutMs <= 0) return res
	if (!res.body) return res
	if (!res.headers.get('content-type')?.includes('text/event-stream')) return res

	const reader = res.body.getReader()
	const body = new ReadableStream<Uint8Array>({
		async pull(ctrl) {
			const part = await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
				const id = setTimeout(() => {
					const err = new Error(`SSE stream read timed out after ${timeoutMs}ms - no data received`)
					abortCtl.abort(err)
					void reader.cancel(err)
					reject(err)
				}, timeoutMs)
				reader.read().then(
					(result) => {
						clearTimeout(id)
						resolve(result)
					},
					(err) => {
						clearTimeout(id)
						reject(err)
					},
				)
			})
			if (part.done) {
				ctrl.close()
				return
			}
			ctrl.enqueue(part.value)
		},
		async cancel(reason) {
			abortCtl.abort(reason)
			await reader.cancel(reason)
		},
	})

	return new Response(body, {
		headers: new Headers(res.headers),
		status: res.status,
		statusText: res.statusText,
	})
}

// ---------------------------------------------------------------------------
// LanguageModelV3 implementation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCodexCustomResponsesProvider(options: CodexCustomResponsesProviderOptions = {}): ProviderV3 {
	const authStore = options.authStore ?? createFileAuthStore()
	const providerId = options.providerId ?? 'codex'
	const version = options.version ?? CODEX_DEFAULT_VERSION
	const fetchFn: CodexFetchLike = options.fetch ?? globalThis.fetch
	const now = options.now ?? Date.now
	const chunkTimeout = options.chunkTimeout === false ? 0 : (options.chunkTimeout ?? DEFAULT_CHUNK_TIMEOUT_MS)

	const codexFetch: CodexFetchLike = async (input, init): Promise<Response> => {
		const auth = await resolveCodexAuth(authStore, providerId, fetchFn, now)

		const headers = new Headers(init?.headers)
		headers.delete('authorization')

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

			if (options.fastMode && parsed.service_tier == null) {
				parsed.service_tier = CODEX_FAST_SERVICE_TIER
			}

			body = JSON.stringify(parsed)
		}

		return fetchFn(input, { ...init, headers, body })
	}

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
