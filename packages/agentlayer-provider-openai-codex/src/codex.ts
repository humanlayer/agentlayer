import os from 'node:os'
import {
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	type LanguageModelV3Content,
	type LanguageModelV3FinishReason,
	type LanguageModelV3GenerateResult,
	type LanguageModelV3Message,
	type LanguageModelV3Prompt,
	type LanguageModelV3StreamPart,
	type LanguageModelV3Usage,
	NoSuchModelError,
	type ProviderV3,
	type SharedV3ProviderMetadata,
} from '@ai-sdk/provider'
import type { AuthInfo, AuthStore, OAuthAuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { type CodexFetchLike, refreshAccessToken } from './codex-oauth'

export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_PROVIDER = 'openai.codex'
export const CODEX_PROVIDER_ID = 'codex'
export const CODEX_FAST_SERVICE_TIER = 'priority'
export const CODEX_FLEX_SERVICE_TIER = 'flex'

export interface CodexRequestOptions {
	/**
	 * Enable Codex fast mode. This sends `service_tier: "priority"`, matching
	 * the Codex CLI's fast-mode request behavior.
	 */
	fastMode?: boolean
	/**
	 * Explicit Codex service tier. The convenience value `"fast"` is normalized
	 * to the API value `"priority"`.
	 */
	serviceTier?: string | null
}

export interface CodexProviderOptions extends CodexRequestOptions {
	authStore?: AuthStore
	providerId?: string
	fetch?: CodexFetchLike
	version?: string
	sessionId?: string
	now?: () => number
}

export interface CodexRequestBody {
	model: string
	input: Array<Record<string, unknown>>
	conversation?: string | null
	include?: string[] | null
	instructions?: string
	max_tool_calls?: number | null
	metadata?: Record<string, unknown>
	parallel_tool_calls?: boolean | null
	previous_response_id?: string | null
	prompt_cache_key?: string | null
	prompt_cache_retention?: string | null
	reasoning?: {
		effort?: string | null
		summary?: string | null
	}
	service_tier?: string | null
	store: false
	stream: true
	truncation?: string | null
	user?: string | null
}

export interface CodexModelOptions extends CodexProviderOptions {
	modelId: string
}

interface CodexResponseCreatedEvent {
	type: 'response.created'
	response: {
		id: string
		created_at: number
		model: string
	}
}

interface CodexResponseTextDeltaEvent {
	type: 'response.output_text.delta'
	item_id: string
	delta: string
}

interface CodexResponseOutputItemAddedEvent {
	type: 'response.output_item.added'
	output_index: number
	item:
		| {
				type: 'message'
				id: string
				phase?: 'commentary' | 'final_answer' | null
		  }
		| {
				type: 'reasoning'
				id: string
				encrypted_content?: string | null
		  }
		| {
				type: 'function_call'
				id: string
				call_id?: string
				name?: string
				arguments?: string
		  }
}

interface CodexResponseOutputItemDoneEvent {
	type: 'response.output_item.done'
	output_index: number
	item:
		| {
				type: 'message'
				id: string
				phase?: 'commentary' | 'final_answer' | null
		  }
		| {
				type: 'reasoning'
				id: string
				encrypted_content?: string | null
		  }
		| {
				type: 'function_call'
				id: string
				call_id?: string
				name?: string
				arguments?: string
		  }
}

interface CodexResponseReasoningSummaryPartAddedEvent {
	type: 'response.reasoning_summary_part.added'
	item_id: string
	summary_index: number
}

interface CodexResponseReasoningSummaryTextDeltaEvent {
	type: 'response.reasoning_summary_text.delta'
	item_id: string
	summary_index: number
	delta: string
}

interface CodexResponseReasoningSummaryPartDoneEvent {
	type: 'response.reasoning_summary_part.done'
	item_id: string
	summary_index: number
}

interface CodexResponseFinishedEvent {
	type: 'response.completed' | 'response.incomplete' | 'response.failed'
	response: {
		incomplete_details?: { reason?: string } | null
		usage?: {
			input_tokens: number
			input_tokens_details?: { cached_tokens?: number | null } | null
			output_tokens: number
			output_tokens_details?: { reasoning_tokens?: number | null } | null
		} | null
		error?: { message: string } | null
	}
}

type CodexSseEvent =
	| CodexResponseCreatedEvent
	| CodexResponseTextDeltaEvent
	| CodexResponseOutputItemAddedEvent
	| CodexResponseOutputItemDoneEvent
	| CodexResponseReasoningSummaryPartAddedEvent
	| CodexResponseReasoningSummaryTextDeltaEvent
	| CodexResponseReasoningSummaryPartDoneEvent
	| CodexResponseFinishedEvent

export function createCodexProvider(options: CodexProviderOptions): ProviderV3 {
	return {
		specificationVersion: 'v3',
		languageModel(modelId: string) {
			return createCodexLanguageModel({ ...options, modelId })
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

export function createCodexLanguageModel(options: CodexModelOptions): LanguageModelV3 {
	const providerId = options.providerId ?? CODEX_PROVIDER_ID
	const authStore = options.authStore ?? createFileAuthStore()
	const fetchFn = options.fetch ?? globalThis.fetch
	const now = options.now ?? Date.now

	return {
		specificationVersion: 'v3',
		provider: CODEX_PROVIDER,
		modelId: options.modelId,
		supportedUrls: {},
		async doGenerate(callOptions) {
			const prepared = await prepareCodexRequest({
				callOptions,
				modelId: options.modelId,
				requestOptions: options,
				authStore,
				providerId,
				fetch: fetchFn,
				version: options.version,
				sessionId: options.sessionId,
				now,
			})

			const response = await fetchFn(CODEX_API_ENDPOINT, {
				method: 'POST',
				headers: prepared.headers,
				body: JSON.stringify(prepared.body),
				signal: callOptions.abortSignal,
			})

			if (!response.ok) {
				throw new Error(`Codex request failed: ${response.status}`)
			}

			const streamed = await parseCodexSseResponse(response)
			return streamPartsToGenerateResult(streamed.parts, prepared.body, response)
		},
		async doStream(callOptions) {
			const prepared = await prepareCodexRequest({
				callOptions,
				modelId: options.modelId,
				requestOptions: options,
				authStore,
				providerId,
				fetch: fetchFn,
				version: options.version,
				sessionId: options.sessionId,
				now,
			})

			const response = await fetchFn(CODEX_API_ENDPOINT, {
				method: 'POST',
				headers: prepared.headers,
				body: JSON.stringify(prepared.body),
				signal: callOptions.abortSignal,
			})

			if (!response.ok) {
				throw new Error(`Codex request failed: ${response.status}`)
			}

			return {
				stream: createCodexSseStream(response),
				request: { body: prepared.body },
				response: { headers: headersToRecord(response.headers) },
			}
		},
	}
}

export async function prepareCodexRequest(args: {
	callOptions: LanguageModelV3CallOptions
	modelId: string
	requestOptions?: CodexRequestOptions
	authStore: AuthStore
	providerId: string
	fetch: CodexFetchLike
	version?: string
	sessionId?: string
	now: () => number
}): Promise<{ headers: Record<string, string>; body: CodexRequestBody; auth: AuthInfo }> {
	const auth = await resolveCodexAuth(args.authStore, args.providerId, args.fetch, args.now)
	const body = buildCodexRequestBody(args.callOptions, args.modelId, args.requestOptions)
	const headers = buildCodexHeaders({
		auth,
		version: args.version,
		sessionId: args.sessionId,
		callerHeaders: args.callOptions.headers,
	})
	return { headers, body, auth }
}

export function buildCodexHeaders(args: {
	auth: AuthInfo
	version?: string
	sessionId?: string
	callerHeaders?: Record<string, string | undefined>
}): Record<string, string> {
	const headers = new Headers()

	for (const [key, value] of Object.entries(args.callerHeaders ?? {})) {
		if (value == null) continue
		if (key.toLowerCase() === 'authorization') continue
		headers.set(key, value)
	}

	headers.set('content-type', 'application/json')
	headers.set('authorization', `Bearer ${getAuthToken(args.auth)}`)
	headers.set('originator', 'opencode')
	headers.set('User-Agent', buildCodexUserAgent(args.version ?? '0.0.0'))

	if (args.sessionId) {
		headers.set('session_id', args.sessionId)
	}

	if (args.auth.kind === 'oauth' && args.auth.accountId) {
		headers.set('ChatGPT-Account-Id', args.auth.accountId)
	}

	return Object.fromEntries(headers.entries())
}

export function buildCodexUserAgent(version: string): string {
	return `opencode/${version} (${os.platform()} ${os.release()}; ${os.arch()})`
}

export function buildCodexRequestBody(
	options: LanguageModelV3CallOptions,
	modelId: string,
	requestOptions: CodexRequestOptions = {},
): CodexRequestBody {
	const transformed = transformCodexPrompt(options.prompt)
	const providerInstructions = getProviderInstructions(options)
	const instructions = joinInstructions(transformed.instructions, providerInstructions)

	return {
		model: modelId,
		input: transformed.input,
		...(instructions ? { instructions } : {}),
		...buildCodexRequestExtras(options, requestOptions),
		store: false,
		stream: true,
	}
}

export function transformCodexPrompt(prompt: LanguageModelV3Prompt): {
	input: Array<Record<string, unknown>>
	instructions?: string
} {
	const input: Array<Record<string, unknown>> = []
	const instructions: string[] = []

	for (const message of prompt) {
		if (message.role === 'system') {
			instructions.push(message.content)
			continue
		}

		if (message.role === 'user') {
			input.push({
				role: 'user',
				content: message.content
					.filter((part) => part.type === 'text')
					.map((part) => ({ type: 'input_text', text: part.text })),
			})
			continue
		}

		if (message.role === 'assistant') {
			for (const part of message.content) {
				if (part.type === 'reasoning') {
					const reasoningInput = buildReasoningInput(part)
					if (reasoningInput) {
						input.push(reasoningInput)
					}
					continue
				}

				const itemId = getStoredItemId(message, part)
				if (itemId) {
					input.push({ type: 'item_reference', id: itemId })
					continue
				}

				if (part.type === 'text') {
					input.push({
						role: 'assistant',
						content: [{ type: 'output_text', text: part.text }],
					})
					continue
				}

				if (part.type === 'tool-call') {
					input.push({
						type: 'function_call',
						call_id: part.toolCallId,
						name: part.toolName,
						arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
					})
				}
			}
			continue
		}

		if (message.role === 'tool') {
			for (const part of message.content) {
				const itemId = getStoredItemId(message, part)
				if (itemId) {
					input.push({ type: 'item_reference', id: itemId })
					continue
				}

				if (part.type === 'tool-result') {
					input.push({
						type: 'function_call_output',
						call_id: part.toolCallId,
						output: stringifyToolResult(part.output),
					})
				}
			}
		}
	}

	return {
		input,
		...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
	}
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

export async function parseCodexSseResponse(response: Response): Promise<{ parts: LanguageModelV3StreamPart[] }> {
	const stream = createCodexSseStream(response)
	const reader = stream.getReader()
	const parts: LanguageModelV3StreamPart[] = []

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		parts.push(value)
	}

	return { parts }
}

export function createCodexSseStream(response: Response): ReadableStream<LanguageModelV3StreamPart> {
	if (!response.body) {
		throw new Error('Missing Codex response body')
	}

	const decoder = new TextDecoder()

	return new ReadableStream<LanguageModelV3StreamPart>({
		async start(controller) {
			const reader = response.body?.getReader()
			if (!reader) {
				controller.error(new Error('Missing Codex response body'))
				return
			}

			let buffer = ''
			let finishSeen = false
			let hasFunctionCall = false
			const activeReasoning = new Map<
				number,
				{ canonicalId: string; encryptedContent?: string | null; summaryParts: Set<number> }
			>()
			let responseId: string | undefined
			controller.enqueue({ type: 'stream-start', warnings: [] })

			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })

					const parsed = parseCodexSseBuffer(buffer)
					buffer = parsed.remainder

					for (const event of parsed.events) {
						if (event.type === 'response.created') {
							responseId = event.response.id
						}
						if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
							hasFunctionCall = true
						}

						const streamParts = codexEventToStreamParts(event, hasFunctionCall, responseId, activeReasoning)
						for (const streamPart of streamParts) {
							controller.enqueue(streamPart)
							if (streamPart.type === 'finish') {
								finishSeen = true
							}
						}
					}
				}

				buffer += decoder.decode()
				const trailing = parseCodexSseBuffer(buffer)
				for (const event of trailing.events) {
					if (event.type === 'response.created') {
						responseId = event.response.id
					}
					if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
						hasFunctionCall = true
					}

					const streamParts = codexEventToStreamParts(event, hasFunctionCall, responseId, activeReasoning)
					for (const streamPart of streamParts) {
						controller.enqueue(streamPart)
						if (streamPart.type === 'finish') {
							finishSeen = true
						}
					}
				}

				if (!finishSeen) {
					controller.enqueue({
						type: 'finish',
						finishReason: { unified: 'stop', raw: undefined },
						usage: mapCodexUsage(),
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
}

export function streamPartsToGenerateResult(
	parts: LanguageModelV3StreamPart[],
	requestBody: CodexRequestBody,
	response: Response,
): LanguageModelV3GenerateResult {
	const textBuffers = new Map<string, string>()
	const reasoningBuffers = new Map<string, string>()
	const content: LanguageModelV3Content[] = []
	let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined }
	let usage: LanguageModelV3Usage = mapCodexUsage()
	let responseMetadata: { id?: string; timestamp?: Date; modelId?: string } = {}

	for (const part of parts) {
		if (part.type === 'text-start') {
			textBuffers.set(part.id, '')
			continue
		}

		if (part.type === 'reasoning-start') {
			reasoningBuffers.set(part.id, '')
			continue
		}

		if (part.type === 'text-delta') {
			textBuffers.set(part.id, `${textBuffers.get(part.id) ?? ''}${part.delta}`)
			continue
		}

		if (part.type === 'reasoning-delta') {
			reasoningBuffers.set(part.id, `${reasoningBuffers.get(part.id) ?? ''}${part.delta}`)
			continue
		}

		if (part.type === 'text-end') {
			content.push({
				type: 'text',
				text: textBuffers.get(part.id) ?? '',
				providerMetadata: part.providerMetadata,
			})
			continue
		}

		if (part.type === 'reasoning-end') {
			content.push({
				type: 'reasoning',
				text: reasoningBuffers.get(part.id) ?? '',
				providerMetadata: part.providerMetadata,
			})
			continue
		}

		if (part.type === 'response-metadata') {
			responseMetadata = {
				id: part.id,
				timestamp: part.timestamp,
				modelId: part.modelId,
			}
			continue
		}

		if (part.type === 'finish') {
			finishReason = part.finishReason
			usage = part.usage
		}
	}

	return {
		content,
		finishReason,
		usage,
		providerMetadata: responseMetadata?.id ? { openai: { responseId: responseMetadata.id } } : undefined,
		warnings: [],
		request: { body: requestBody },
		response: {
			...responseMetadata,
			headers: headersToRecord(response.headers),
		},
	}
}

function parseCodexSseBuffer(buffer: string): { events: CodexSseEvent[]; remainder: string } {
	const events: CodexSseEvent[] = []
	let remainder = buffer

	while (true) {
		const boundary = remainder.indexOf('\n\n')
		if (boundary === -1) {
			return { events, remainder }
		}

		const rawEvent = remainder.slice(0, boundary)
		remainder = remainder.slice(boundary + 2)
		const event = parseSseEvent(rawEvent)
		if (event) {
			events.push(event)
		}
	}
}

function codexEventToStreamParts(
	event: CodexSseEvent,
	hasFunctionCall: boolean,
	responseId: string | undefined,
	activeReasoning: Map<number, { canonicalId: string; encryptedContent?: string | null; summaryParts: Set<number> }>,
): LanguageModelV3StreamPart[] {
	if (event.type === 'response.created') {
		return [
			{
				type: 'response-metadata',
				id: event.response.id,
				timestamp: new Date(event.response.created_at * 1000),
				modelId: event.response.model,
			},
		]
	}

	if (event.type === 'response.output_item.added' && event.item.type === 'message') {
		return [
			{
				type: 'text-start',
				id: event.item.id,
				providerMetadata: buildItemProviderMetadata(event.item.id, event.item.phase, responseId),
			},
		]
	}

	if (event.type === 'response.output_item.added' && event.item.type === 'reasoning') {
		activeReasoning.set(event.output_index, {
			canonicalId: event.item.id,
			encryptedContent: event.item.encrypted_content,
			summaryParts: new Set([0]),
		})
		return [
			{
				type: 'reasoning-start',
				id: `${event.item.id}:0`,
				providerMetadata: buildReasoningProviderMetadata(
					event.item.id,
					event.item.encrypted_content,
					responseId,
				),
			},
		]
	}

	if (event.type === 'response.output_text.delta') {
		return [{ type: 'text-delta', id: event.item_id, delta: event.delta }]
	}

	if (event.type === 'response.reasoning_summary_part.added') {
		const reasoning = findActiveReasoningByCanonicalId(activeReasoning, event.item_id)
		if (!reasoning) {
			return []
		}
		reasoning.summaryParts.add(event.summary_index)
		if (event.summary_index === 0) {
			return []
		}
		return [
			{
				type: 'reasoning-start',
				id: `${event.item_id}:${event.summary_index}`,
				providerMetadata: buildReasoningProviderMetadata(event.item_id, reasoning.encryptedContent, responseId),
			},
		]
	}

	if (event.type === 'response.reasoning_summary_text.delta') {
		return [
			{
				type: 'reasoning-delta',
				id: `${event.item_id}:${event.summary_index}`,
				delta: event.delta,
				providerMetadata: buildReasoningProviderMetadata(event.item_id, undefined, responseId),
			},
		]
	}

	if (event.type === 'response.reasoning_summary_part.done') {
		const reasoning = findActiveReasoningByCanonicalId(activeReasoning, event.item_id)
		if (!reasoning || !reasoning.summaryParts.has(event.summary_index)) {
			return []
		}
		return []
	}

	if (event.type === 'response.output_item.done' && event.item.type === 'message') {
		return [
			{
				type: 'text-end',
				id: event.item.id,
				providerMetadata: buildItemProviderMetadata(event.item.id, event.item.phase, responseId),
			},
		]
	}

	if (event.type === 'response.output_item.done' && event.item.type === 'reasoning') {
		const reasoning = activeReasoning.get(event.output_index)
		if (!reasoning) {
			return []
		}
		const item = event.item
		const encryptedContent = item.encrypted_content ?? reasoning.encryptedContent
		activeReasoning.delete(event.output_index)
		return [...reasoning.summaryParts]
			.sort((left, right) => left - right)
			.map((summaryIndex) => ({
				type: 'reasoning-end' as const,
				id: `${reasoning.canonicalId}:${summaryIndex}`,
				providerMetadata: buildReasoningProviderMetadata(reasoning.canonicalId, encryptedContent, responseId),
			}))
	}

	if (
		event.type === 'response.completed' ||
		event.type === 'response.incomplete' ||
		event.type === 'response.failed'
	) {
		return [
			{
				type: 'finish',
				finishReason: mapCodexFinishReason(event.response.incomplete_details?.reason, hasFunctionCall),
				usage: mapCodexUsage(event.response.usage ?? undefined),
				providerMetadata: responseId !== undefined ? { openai: { responseId } } : undefined,
			},
		]
	}

	return []
}

function parseSseEvent(rawEvent: string): CodexSseEvent | undefined {
	const dataLines = rawEvent
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())

	if (dataLines.length === 0) return undefined
	const payload = dataLines.join('\n')
	if (!payload || payload === '[DONE]') return undefined

	const parsed = JSON.parse(payload) as { type?: unknown }
	if (typeof parsed.type !== 'string') return undefined

	switch (parsed.type) {
		case 'response.created':
			return isCreatedEvent(parsed) ? parsed : undefined
		case 'response.output_text.delta':
			return isTextDeltaEvent(parsed) ? parsed : undefined
		case 'response.output_item.added':
			return isOutputItemAddedEvent(parsed) ? parsed : undefined
		case 'response.output_item.done':
			return isOutputItemDoneEvent(parsed) ? parsed : undefined
		case 'response.reasoning_summary_part.added':
			return isReasoningSummaryPartAddedEvent(parsed) ? parsed : undefined
		case 'response.reasoning_summary_text.delta':
			return isReasoningSummaryTextDeltaEvent(parsed) ? parsed : undefined
		case 'response.reasoning_summary_part.done':
			return isReasoningSummaryPartDoneEvent(parsed) ? parsed : undefined
		case 'response.completed':
		case 'response.incomplete':
		case 'response.failed':
			return isFinishedEvent(parsed) ? parsed : undefined
		default:
			return undefined
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function isCreatedEvent(value: unknown): value is CodexResponseCreatedEvent {
	if (!isRecord(value) || !isRecord(value.response)) return false
	return (
		typeof value.response.id === 'string' &&
		typeof value.response.created_at === 'number' &&
		typeof value.response.model === 'string'
	)
}

function isTextDeltaEvent(value: unknown): value is CodexResponseTextDeltaEvent {
	if (!isRecord(value)) return false
	return typeof value.item_id === 'string' && typeof value.delta === 'string'
}

function isOutputItemAddedEvent(value: unknown): value is CodexResponseOutputItemAddedEvent {
	if (!isRecord(value) || !isRecord(value.item)) return false
	return typeof value.item.id === 'string' && typeof value.item.type === 'string'
}

function isOutputItemDoneEvent(value: unknown): value is CodexResponseOutputItemDoneEvent {
	if (!isRecord(value) || !isRecord(value.item)) return false
	return typeof value.item.id === 'string' && typeof value.item.type === 'string'
}

function isReasoningSummaryPartAddedEvent(value: unknown): value is CodexResponseReasoningSummaryPartAddedEvent {
	if (!isRecord(value)) return false
	return typeof value.item_id === 'string' && typeof value.summary_index === 'number'
}

function isReasoningSummaryTextDeltaEvent(value: unknown): value is CodexResponseReasoningSummaryTextDeltaEvent {
	if (!isRecord(value)) return false
	return (
		typeof value.item_id === 'string' && typeof value.summary_index === 'number' && typeof value.delta === 'string'
	)
}

function isReasoningSummaryPartDoneEvent(value: unknown): value is CodexResponseReasoningSummaryPartDoneEvent {
	if (!isRecord(value)) return false
	return typeof value.item_id === 'string' && typeof value.summary_index === 'number'
}

function isFinishedEvent(value: unknown): value is CodexResponseFinishedEvent {
	return isRecord(value) && isRecord(value.response)
}

function getProviderInstructions(options: LanguageModelV3CallOptions): string | undefined {
	const openai = getCodexProviderOptionRecord(options, 'openai')
	if (typeof openai?.instructions === 'string') {
		return openai.instructions
	}

	const codex = getCodexProviderOptionRecord(options, 'codex')
	if (typeof codex?.instructions === 'string') {
		return codex.instructions
	}
	return undefined
}

function getCodexProviderOptionRecord(
	options: LanguageModelV3CallOptions,
	providerName: 'openai' | 'codex',
): Record<string, unknown> | undefined {
	const providerOptions = options.providerOptions?.[providerName]
	return isRecord(providerOptions) ? providerOptions : undefined
}

function getNullableString(value: Record<string, unknown> | undefined, key: string): string | null | undefined {
	if (!value || !(key in value)) {
		return undefined
	}
	const candidate = value[key]
	return typeof candidate === 'string' || candidate === null ? candidate : undefined
}

function getNullableBoolean(value: Record<string, unknown> | undefined, key: string): boolean | null | undefined {
	if (!value || !(key in value)) {
		return undefined
	}
	const candidate = value[key]
	return typeof candidate === 'boolean' || candidate === null ? candidate : undefined
}

function getNullableNumber(value: Record<string, unknown> | undefined, key: string): number | null | undefined {
	if (!value || !(key in value)) {
		return undefined
	}
	const candidate = value[key]
	return typeof candidate === 'number' || candidate === null ? candidate : undefined
}

function getNullableStringArray(value: Record<string, unknown> | undefined, key: string): string[] | null | undefined {
	if (!value || !(key in value)) {
		return undefined
	}
	const candidate = value[key]
	if (candidate === null) {
		return null
	}
	if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) {
		return [...candidate]
	}
	return undefined
}

function getMetadataRecord(
	value: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	if (!value || !(key in value)) {
		return undefined
	}
	const candidate = value[key]
	return isRecord(candidate) ? candidate : undefined
}

function buildCodexReasoningOptions(options: LanguageModelV3CallOptions): CodexRequestBody['reasoning'] | undefined {
	const openai = getCodexProviderOptionRecord(options, 'openai')
	const codex = getCodexProviderOptionRecord(options, 'codex')
	const effort = getNullableString(openai, 'reasoningEffort') ?? getNullableString(codex, 'reasoningEffort')
	const summary = getNullableString(openai, 'reasoningSummary') ?? getNullableString(codex, 'reasoningSummary')

	if (effort == null && summary == null) {
		return undefined
	}

	return {
		...(effort != null ? { effort } : {}),
		...(summary != null ? { summary } : {}),
	}
}

function getNullableFastMode(value: Record<string, unknown> | undefined): boolean | null | undefined {
	if (!value || !('fastMode' in value)) {
		return undefined
	}
	const candidate = value.fastMode
	return typeof candidate === 'boolean' || candidate === null ? candidate : undefined
}

export function normalizeCodexServiceTier(serviceTier: string | null | undefined): string | null | undefined {
	if (serviceTier == null) {
		return serviceTier
	}
	return serviceTier === 'fast' ? CODEX_FAST_SERVICE_TIER : serviceTier
}

function buildCodexServiceTier(
	options: LanguageModelV3CallOptions,
	requestOptions: CodexRequestOptions,
): string | null | undefined {
	const openai = getCodexProviderOptionRecord(options, 'openai')
	const codex = getCodexProviderOptionRecord(options, 'codex')
	const serviceTier =
		getNullableString(openai, 'serviceTier') ??
		getNullableString(codex, 'serviceTier') ??
		requestOptions.serviceTier

	if (serviceTier !== undefined) {
		return normalizeCodexServiceTier(serviceTier)
	}

	const fastMode = getNullableFastMode(openai) ?? getNullableFastMode(codex) ?? requestOptions.fastMode
	if (fastMode === true) {
		return CODEX_FAST_SERVICE_TIER
	}
	if (fastMode === false || fastMode === null) {
		return undefined
	}

	return undefined
}

function buildCodexRequestExtras(
	options: LanguageModelV3CallOptions,
	requestOptions: CodexRequestOptions,
): Omit<CodexRequestBody, 'model' | 'input' | 'instructions' | 'store' | 'stream'> {
	const openai = getCodexProviderOptionRecord(options, 'openai')
	const codex = getCodexProviderOptionRecord(options, 'codex')
	const include = getNullableStringArray(openai, 'include') ?? getNullableStringArray(codex, 'include')
	const reasoning = buildCodexReasoningOptions(options)
	const conversation = getNullableString(openai, 'conversation') ?? getNullableString(codex, 'conversation')
	const maxToolCalls = getNullableNumber(openai, 'maxToolCalls') ?? getNullableNumber(codex, 'maxToolCalls')
	const metadata = getMetadataRecord(openai, 'metadata') ?? getMetadataRecord(codex, 'metadata')
	const parallelToolCalls =
		getNullableBoolean(openai, 'parallelToolCalls') ?? getNullableBoolean(codex, 'parallelToolCalls')
	const previousResponseId =
		getNullableString(openai, 'previousResponseId') ??
		getNullableString(codex, 'previousResponseId') ??
		findLatestResponseId(options.prompt)
	const promptCacheKey = getNullableString(openai, 'promptCacheKey') ?? getNullableString(codex, 'promptCacheKey')
	const promptCacheRetention =
		getNullableString(openai, 'promptCacheRetention') ?? getNullableString(codex, 'promptCacheRetention')
	const serviceTier = buildCodexServiceTier(options, requestOptions)
	const truncation = getNullableString(openai, 'truncation') ?? getNullableString(codex, 'truncation')
	const user = getNullableString(openai, 'user') ?? getNullableString(codex, 'user')

	return {
		...(conversation !== undefined ? { conversation } : {}),
		...(include !== undefined ? { include } : {}),
		...(maxToolCalls !== undefined ? { max_tool_calls: maxToolCalls } : {}),
		...(metadata ? { metadata } : {}),
		...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
		...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {}),
		...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
		...(promptCacheRetention !== undefined ? { prompt_cache_retention: promptCacheRetention } : {}),
		...(reasoning ? { reasoning } : {}),
		...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
		...(truncation !== undefined ? { truncation } : {}),
		...(user !== undefined ? { user } : {}),
	}
}

function findLatestResponseId(prompt: LanguageModelV3Prompt): string | undefined {
	for (let index = prompt.length - 1; index >= 0; index--) {
		const message = prompt[index]
		if (message?.role !== 'assistant') continue

		const messageOptions = isRecord(message.providerOptions?.openai)
			? (message.providerOptions?.openai as Record<string, unknown>)
			: undefined
		const messageCodexOptions = isRecord(message.providerOptions?.codex)
			? (message.providerOptions?.codex as Record<string, unknown>)
			: undefined

		const directResponseId =
			getNullableString(messageOptions, 'responseId') ?? getNullableString(messageCodexOptions, 'responseId')
		if (directResponseId) {
			return directResponseId
		}

		if (!Array.isArray(message.content)) continue

		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
			const part = message.content[partIndex]
			if (!part || typeof part !== 'object') continue
			const providerOptions =
				'providerOptions' in part && isRecord(part.providerOptions) ? part.providerOptions : undefined
			const providerMetadata =
				'providerMetadata' in part && isRecord(part.providerMetadata) ? part.providerMetadata : undefined
			const openai = isRecord(providerOptions?.openai)
				? (providerOptions.openai as Record<string, unknown>)
				: undefined
			const codex = isRecord(providerOptions?.codex)
				? (providerOptions.codex as Record<string, unknown>)
				: undefined
			const openaiMetadata = isRecord(providerMetadata?.openai)
				? (providerMetadata.openai as Record<string, unknown>)
				: undefined
			const codexMetadata = isRecord(providerMetadata?.codex)
				? (providerMetadata.codex as Record<string, unknown>)
				: undefined
			const responseId =
				getNullableString(openai, 'responseId') ??
				getNullableString(codex, 'responseId') ??
				getNullableString(openaiMetadata, 'responseId') ??
				getNullableString(codexMetadata, 'responseId')
			if (responseId) {
				return responseId
			}
		}
	}

	return undefined
}

function buildReasoningInput(part: {
	text: string
	providerOptions?: Record<string, unknown>
	providerMetadata?: Record<string, unknown>
}): Record<string, unknown> | undefined {
	const openai =
		readReasoningProviderOptions(part.providerOptions?.openai) ??
		readReasoningProviderOptions(part.providerMetadata?.openai)
	const codex =
		readReasoningProviderOptions(part.providerOptions?.codex) ??
		readReasoningProviderOptions(part.providerMetadata?.codex)
	const itemId = openai?.itemId ?? codex?.itemId
	const reasoningEncryptedContent = openai?.reasoningEncryptedContent ?? codex?.reasoningEncryptedContent
	const summary = part.text.length > 0 ? [{ type: 'summary_text', text: part.text }] : []

	if (itemId) {
		return {
			type: 'reasoning',
			id: itemId,
			...(reasoningEncryptedContent !== undefined ? { encrypted_content: reasoningEncryptedContent } : {}),
			summary,
		}
	}

	if (reasoningEncryptedContent !== undefined) {
		return {
			type: 'reasoning',
			encrypted_content: reasoningEncryptedContent,
			summary,
		}
	}

	return undefined
}

function readReasoningProviderOptions(
	value: unknown,
): { itemId?: string; reasoningEncryptedContent?: string | null } | undefined {
	if (!isRecord(value)) {
		return undefined
	}

	const itemId = typeof value.itemId === 'string' ? value.itemId : undefined
	const encrypted =
		typeof value.reasoningEncryptedContent === 'string' || value.reasoningEncryptedContent === null
			? value.reasoningEncryptedContent
			: undefined
	if (itemId === undefined && encrypted === undefined) {
		return undefined
	}

	return {
		...(itemId !== undefined ? { itemId } : {}),
		...(encrypted !== undefined ? { reasoningEncryptedContent: encrypted } : {}),
	}
}

function joinInstructions(...values: Array<string | undefined>): string | undefined {
	const parts = values.filter((value): value is string => Boolean(value?.trim()))
	return parts.length > 0 ? parts.join('\n\n') : undefined
}

function getStoredItemId(
	message: LanguageModelV3Message,
	part: { providerOptions?: Record<string, unknown> } | { providerMetadata?: Record<string, unknown> },
): string | undefined {
	const messageOptions = message.providerOptions as Record<string, unknown> | undefined
	const partOptions =
		'providerOptions' in part ? (part.providerOptions as Record<string, unknown> | undefined) : undefined
	const metadata =
		'providerMetadata' in part ? (part.providerMetadata as Record<string, unknown> | undefined) : undefined

	return (
		readItemId(partOptions?.openai) ||
		readItemId(partOptions?.codex) ||
		readItemId(messageOptions?.openai) ||
		readItemId(messageOptions?.codex) ||
		readItemId(metadata?.openai) ||
		readItemId(metadata?.codex)
	)
}

function readItemId(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	if ('itemId' in value && typeof value.itemId === 'string') return value.itemId
	return undefined
}

function _readResponseId(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	if ('responseId' in value && typeof value.responseId === 'string') return value.responseId
	return undefined
}

function stringifyToolResult(output: unknown): string {
	if (!output || typeof output !== 'object') {
		return JSON.stringify(output)
	}

	if ('type' in output && output.type === 'text' && 'value' in output && typeof output.value === 'string') {
		return output.value
	}

	if ('type' in output && output.type === 'json' && 'value' in output) {
		return JSON.stringify(output.value)
	}

	return JSON.stringify(output)
}

function getAuthToken(auth: AuthInfo): string {
	return auth.kind === 'api' ? auth.apiKey : auth.accessToken
}

function isExpired(auth: OAuthAuthInfo, now: number): boolean {
	return auth.expiresAt != null && auth.expiresAt <= now
}

function findActiveReasoningByCanonicalId(
	activeReasoning: Map<number, { canonicalId: string; encryptedContent?: string | null; summaryParts: Set<number> }>,
	itemId: string,
): { canonicalId: string; encryptedContent?: string | null; summaryParts: Set<number> } | undefined {
	for (const reasoning of activeReasoning.values()) {
		if (reasoning.canonicalId === itemId) {
			return reasoning
		}
	}
	return undefined
}

function buildItemProviderMetadata(
	itemId: string,
	phase?: 'commentary' | 'final_answer' | null,
	responseId?: string,
): SharedV3ProviderMetadata {
	return {
		openai: {
			itemId,
			...(phase != null ? { phase } : {}),
			...(responseId !== undefined ? { responseId } : {}),
		},
	}
}

function buildReasoningProviderMetadata(
	itemId: string,
	reasoningEncryptedContent?: string | null,
	responseId?: string,
): SharedV3ProviderMetadata {
	return {
		openai: {
			itemId,
			...(reasoningEncryptedContent !== undefined ? { reasoningEncryptedContent } : {}),
			...(responseId !== undefined ? { responseId } : {}),
		},
	}
}

function mapCodexFinishReason(reason?: string, hasFunctionCall = false): LanguageModelV3FinishReason {
	if (!reason) {
		return { unified: hasFunctionCall ? 'tool-calls' : 'stop', raw: undefined }
	}

	if (reason === 'max_output_tokens') {
		return { unified: 'length', raw: reason }
	}

	if (reason === 'content_filter') {
		return { unified: 'content-filter', raw: reason }
	}

	return { unified: hasFunctionCall ? 'tool-calls' : 'other', raw: reason }
}

function mapCodexUsage(usage?: CodexResponseFinishedEvent['response']['usage']): LanguageModelV3Usage {
	const inputTotal = usage?.input_tokens
	const cacheRead = usage?.input_tokens_details?.cached_tokens ?? undefined
	const outputTotal = usage?.output_tokens
	const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? undefined
	const text = outputTotal != null ? Math.max(outputTotal - (reasoning ?? 0), 0) : undefined

	return {
		inputTokens: {
			total: inputTotal,
			noCache: inputTotal != null ? Math.max(inputTotal - (cacheRead ?? 0), 0) : undefined,
			cacheRead,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: outputTotal,
			text,
			reasoning,
		},
	}
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries())
}
