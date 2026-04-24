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
import { type CodexFetchLike, refreshAccessToken } from './codex-oauth'

export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_PROVIDER = 'openai.codex'
export const CODEX_PROVIDER_ID = 'codex'

export interface CodexProviderOptions {
	authStore: AuthStore
	providerId?: string
	fetch?: CodexFetchLike
	version?: string
	sessionId?: string
	now?: () => number
}

export interface CodexRequestBody {
	model: string
	input: Array<Record<string, unknown>>
	instructions?: string
	store: false
	stream: true
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
	item: {
		type: string
		id: string
		phase?: 'commentary' | 'final_answer' | null
	}
}

interface CodexResponseOutputItemDoneEvent {
	type: 'response.output_item.done'
	output_index: number
	item: {
		type: string
		id: string
		phase?: 'commentary' | 'final_answer' | null
	}
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
				authStore: options.authStore,
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
				authStore: options.authStore,
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
	authStore: AuthStore
	providerId: string
	fetch: CodexFetchLike
	version?: string
	sessionId?: string
	now: () => number
}): Promise<{ headers: Record<string, string>; body: CodexRequestBody; auth: AuthInfo }> {
	const auth = await resolveCodexAuth(args.authStore, args.providerId, args.fetch, args.now)
	const body = buildCodexRequestBody(args.callOptions, args.modelId)
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

export function buildCodexRequestBody(options: LanguageModelV3CallOptions, modelId: string): CodexRequestBody {
	const transformed = transformCodexPrompt(options.prompt)
	const providerInstructions = getProviderInstructions(options)
	const instructions = joinInstructions(transformed.instructions, providerInstructions)

	return {
		model: modelId,
		input: transformed.input,
		...(instructions ? { instructions } : {}),
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
			controller.enqueue({ type: 'stream-start', warnings: [] })

			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })

					const parsed = parseCodexSseBuffer(buffer)
					buffer = parsed.remainder

					for (const event of parsed.events) {
						if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
							hasFunctionCall = true
						}

						const streamPart = codexEventToStreamPart(event, hasFunctionCall)
						if (!streamPart) continue
						controller.enqueue(streamPart)
						if (streamPart.type === 'finish') {
							finishSeen = true
						}
					}
				}

				buffer += decoder.decode()
				const trailing = parseCodexSseBuffer(buffer)
				for (const event of trailing.events) {
					if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
						hasFunctionCall = true
					}

					const streamPart = codexEventToStreamPart(event, hasFunctionCall)
					if (!streamPart) continue
					controller.enqueue(streamPart)
					if (streamPart.type === 'finish') {
						finishSeen = true
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
	const content: LanguageModelV3Content[] = []
	let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined }
	let usage: LanguageModelV3Usage = mapCodexUsage()
	let responseMetadata: { id?: string; timestamp?: Date; modelId?: string } = {}

	for (const part of parts) {
		if (part.type === 'text-start') {
			textBuffers.set(part.id, '')
			continue
		}

		if (part.type === 'text-delta') {
			textBuffers.set(part.id, `${textBuffers.get(part.id) ?? ''}${part.delta}`)
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

function codexEventToStreamPart(
	event: CodexSseEvent,
	hasFunctionCall: boolean,
): LanguageModelV3StreamPart | undefined {
	if (event.type === 'response.created') {
		return {
			type: 'response-metadata',
			id: event.response.id,
			timestamp: new Date(event.response.created_at * 1000),
			modelId: event.response.model,
		}
	}

	if (event.type === 'response.output_item.added' && event.item.type === 'message') {
		return {
			type: 'text-start',
			id: event.item.id,
			providerMetadata: buildItemProviderMetadata(event.item.id, event.item.phase),
		}
	}

	if (event.type === 'response.output_text.delta') {
		return { type: 'text-delta', id: event.item_id, delta: event.delta }
	}

	if (event.type === 'response.output_item.done' && event.item.type === 'message') {
		return {
			type: 'text-end',
			id: event.item.id,
			providerMetadata: buildItemProviderMetadata(event.item.id, event.item.phase),
		}
	}

	if (
		event.type === 'response.completed' ||
		event.type === 'response.incomplete' ||
		event.type === 'response.failed'
	) {
		return {
			type: 'finish',
			finishReason: mapCodexFinishReason(event.response.incomplete_details?.reason, hasFunctionCall),
			usage: mapCodexUsage(event.response.usage ?? undefined),
		}
	}

	return undefined
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

function isFinishedEvent(value: unknown): value is CodexResponseFinishedEvent {
	return isRecord(value) && isRecord(value.response)
}

function getProviderInstructions(options: LanguageModelV3CallOptions): string | undefined {
	const providerOptions = options.providerOptions
	const openai = providerOptions?.openai
	if (openai && typeof openai === 'object' && 'instructions' in openai) {
		const instructions = openai.instructions
		return typeof instructions === 'string' ? instructions : undefined
	}
	const codex = providerOptions?.codex
	if (codex && typeof codex === 'object' && 'instructions' in codex) {
		const instructions = codex.instructions
		return typeof instructions === 'string' ? instructions : undefined
	}
	return undefined
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

function buildItemProviderMetadata(
	itemId: string,
	phase?: 'commentary' | 'final_answer' | null,
): SharedV3ProviderMetadata {
	return {
		openai: {
			itemId,
			...(phase != null ? { phase } : {}),
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
