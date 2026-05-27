import {
	type LanguageModelV3,
	type LanguageModelV3Content,
	type LanguageModelV3FinishReason,
	type LanguageModelV3StreamPart,
	type LanguageModelV3Usage,
	NoSuchModelError,
	type ProviderV3,
} from '@ai-sdk/provider'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { Auth } from '@humanlayer/opencode-llm-vendor/route/auth'
import { LLMClient } from '@humanlayer/opencode-llm-vendor/route/client'
import { RequestExecutor } from '@humanlayer/opencode-llm-vendor/route/executor'
import { WebSocketExecutor } from '@humanlayer/opencode-llm-vendor/route/transport/websocket'
import { Effect, Fiber, Layer, Stream } from 'effect'
import {
	buildCodexUserAgent,
	CODEX_API_ENDPOINT,
	CODEX_DEFAULT_VERSION,
	type CodexProviderOptions,
	resolveCodexAuth,
} from './codex'
import { convertCallOptionsToLLMRequest } from './codex-ws-adapter'

export interface CodexEffectProviderOptions extends CodexProviderOptions {
	/**
	 * Optional Effect layer that provides the LLMClient.Service. When set,
	 * replaces the default `LLMClient.layer + RequestExecutor.defaultLayer +
	 * WebSocketExecutor.layer` composition. Intended for testing: supply a
	 * layer backed by a mock WebSocketExecutor to avoid real network calls.
	 *
	 * @internal
	 */
	_testLayers?: Layer.Layer<any>
}

// ---------------------------------------------------------------------------
// LLMEvent -> LanguageModelV3StreamPart
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
			return [
				{
					type: 'text-end',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'reasoning-start':
			return [
				{
					type: 'reasoning-start',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'reasoning-delta':
			return [{ type: 'reasoning-delta', id: event.id as string, delta: event.text as string }]
		case 'reasoning-end':
			return [
				{
					type: 'reasoning-end',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
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
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'provider-error':
			return [{ type: 'error', error: new Error(event.message as string) }]
		default:
			return []
	}
}

// ---------------------------------------------------------------------------
// Build LLMClient layer
// ---------------------------------------------------------------------------

const llmClientLayer = LLMClient.layer.pipe(
	Layer.provide(RequestExecutor.defaultLayer),
	Layer.provide(WebSocketExecutor.layer),
)

// ---------------------------------------------------------------------------
// Effect Stream -> ReadableStream bridge with abort signal support
// ---------------------------------------------------------------------------

/**
 * Convert an Effect Stream into a ReadableStream, with optional AbortSignal
 * support. When the abort signal fires, the Effect fiber is interrupted which
 * propagates through the vendor's acquireRelease to close the WebSocket.
 */
function effectStreamToReadableStream(
	effectStream: Stream.Stream<LanguageModelV3StreamPart, unknown>,
	abortSignal?: AbortSignal,
): ReadableStream<LanguageModelV3StreamPart> {
	let cancelled = false
	let fiberRef: ReturnType<typeof Effect.runFork> | undefined

	return new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			// Run the Effect stream, pushing each element into the ReadableStream controller
			const program = Stream.runForEach(effectStream, (part) =>
				Effect.sync(() => {
					if (!cancelled) {
						controller.enqueue(part)
					}
				}),
			).pipe(Effect.scoped)

			const fiber = Effect.runFork(program)
			fiberRef = fiber

			// When the fiber completes, close or error the controller
			Fiber.join(fiber)
				.pipe(Effect.runPromise)
				.then(() => {
					if (!cancelled) controller.close()
				})
				.catch((err) => {
					if (!cancelled) {
						try {
							controller.error(err)
						} catch {
							// controller may already be closed
						}
					}
				})

			// Wire abort signal to fiber interruption (DQ6 pattern)
			if (abortSignal) {
				if (abortSignal.aborted) {
					cancelled = true
					Fiber.interrupt(fiber)
						.pipe(Effect.runPromise)
						.catch(() => {})
					controller.close()
				} else {
					const onAbort = () => {
						cancelled = true
						Fiber.interrupt(fiber)
							.pipe(Effect.runPromise)
							.catch(() => {})
						try {
							controller.close()
						} catch {
							// controller may already be closed
						}
					}
					abortSignal.addEventListener('abort', onAbort, { once: true })
				}
			}
		},
		cancel() {
			cancelled = true
			if (fiberRef) {
				Fiber.interrupt(fiberRef)
					.pipe(Effect.runPromise)
					.catch(() => {})
			}
		},
	})
}

// ---------------------------------------------------------------------------
// LanguageModelV3 implementation
// ---------------------------------------------------------------------------

function createEffectCodexModel(
	modelId: string,
	resolveAuth: () => Promise<{ token: string; accountId?: string }>,
	providerOptions: {
		version: string
		sessionId?: string
		fastMode?: boolean
		serviceTier?: string
		baseURL: string
		_testLayers?: Layer.Layer<any>
	},
): LanguageModelV3 {
	return {
		specificationVersion: 'v3',
		provider: 'codex-effect',
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
			// 1. Resolve auth
			const { token, accountId } = await resolveAuth()

			// 2. Build vendor Auth with bearer token + custom headers
			const customHeaders: Record<string, string> = {
				originator: 'opencode',
				'User-Agent': buildCodexUserAgent(providerOptions.version),
			}
			if (providerOptions.sessionId) {
				customHeaders.session_id = providerOptions.sessionId
			}
			if (accountId) {
				customHeaders['ChatGPT-Account-Id'] = accountId
			}

			const auth = Auth.bearer(token).andThen(Auth.headers(customHeaders))

			// 3. Build LLMRequest via adapter
			const request = convertCallOptionsToLLMRequest(modelId, options, {
				auth,
				baseURL: providerOptions.baseURL,
				fastMode: providerOptions.fastMode,
				serviceTier: providerOptions.serviceTier,
			})

			// 4. Build the streaming Effect pipeline:
			//    LLMClient.stream(request) -> Stream<LLMEvent> -> flatMap to StreamPart[]
			//    The vendor's @ts-nocheck means LLMEvent comes through as unknown,
			//    so we cast to AnyLLMEvent for our mapping function.
			const llmStream = Stream.flatMap(
				LLMClient.stream(request) as Stream.Stream<AnyLLMEvent, unknown>,
				(event) => Stream.fromIterable(llmEventToStreamParts(event)),
			)

			// 5. Provide LLMClient layers so the stream's service requirements are satisfied
			const layers = providerOptions._testLayers ?? llmClientLayer
			const providedStream = Stream.provide(llmStream, layers) as Stream.Stream<
				LanguageModelV3StreamPart,
				unknown
			>

			// 6. Prepend stream-start event
			const streamStart: LanguageModelV3StreamPart = { type: 'stream-start', warnings: [] }
			const fullStream: Stream.Stream<LanguageModelV3StreamPart, unknown> = Stream.concat(
				Stream.make(streamStart),
				providedStream,
			)

			// 7. Convert Effect Stream to ReadableStream with abort signal support
			const stream = effectStreamToReadableStream(fullStream, options.abortSignal)

			return {
				stream,
				request: { body: {} },
				response: { headers: {} },
			}
		},
	}
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCodexEffectProvider(options: CodexEffectProviderOptions = {}): ProviderV3 {
	const authStore = options.authStore ?? createFileAuthStore()
	const providerId = options.providerId ?? 'codex'
	const version = options.version ?? CODEX_DEFAULT_VERSION
	const fetchFn = options.fetch ?? globalThis.fetch
	const now = options.now ?? Date.now

	const resolveAuth = async () => {
		const auth = await resolveCodexAuth(authStore, providerId, fetchFn, now)
		const token = auth.kind === 'api' ? auth.apiKey : auth.accessToken
		const accountId = auth.kind === 'oauth' ? (auth.accountId ?? undefined) : undefined
		return { token, accountId }
	}

	return {
		specificationVersion: 'v3',

		languageModel(modelId: string) {
			return createEffectCodexModel(modelId, resolveAuth, {
				version,
				sessionId: options.sessionId,
				fastMode: options.fastMode,
				serviceTier: options.serviceTier ?? undefined,
				baseURL: CODEX_API_ENDPOINT.replace(/\/responses$/, ''),
				_testLayers: options._testLayers,
			})
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
