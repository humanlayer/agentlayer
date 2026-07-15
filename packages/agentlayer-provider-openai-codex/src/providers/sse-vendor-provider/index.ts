import {
	type LanguageModelV3,
	type LanguageModelV3Content,
	type LanguageModelV3FinishReason,
	type LanguageModelV3StreamPart,
	type LanguageModelV3Usage,
	NoSuchModelError,
	type ProviderV3,
	type SharedV3ProviderMetadata,
} from '@ai-sdk/provider'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { route as httpSseRoute } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'
import { Auth } from '@humanlayer/opencode-llm-vendor/route/auth'
import { LLMClient } from '@humanlayer/opencode-llm-vendor/route/client'
import { LLMDiagnostics } from '@humanlayer/opencode-llm-vendor/route/diagnostics'
import { RequestExecutor } from '@humanlayer/opencode-llm-vendor/route/executor'
import { Layer, Stream } from 'effect'
import { convertCallOptionsToLLMRequest } from '../../shared/adapter'
import { buildCodexUserAgent, resolveCodexAuth } from '../../shared/auth'
import { effectStreamToReadableStream } from '../../shared/bridge'
import { CODEX_API_ENDPOINT, CODEX_DEFAULT_VERSION } from '../../shared/constants'
import { makeCodexDiagnosticsLayer } from '../../shared/diagnostics'
import { type AnyLLMEvent, emptyUsage, llmEventToStreamParts } from '../../shared/events'
import {
	isResponsesLiteModel,
	resolveResponsesLiteSessionId,
	responsesLiteHeaderRecord,
} from '../../shared/responses-lite'
import type { CodexDiagnosticsContext, CodexProviderOptions } from '../../shared/types'

// Debug logging gated behind DEBUG_CODEX_SSE=1
const DEBUG = process.env.DEBUG_CODEX_SSE === '1'
const dbg = (...args: unknown[]) => {
	if (DEBUG) console.error('[codex-sse]', ...args)
}

export interface CodexSseVendorProviderOptions extends CodexProviderOptions {
	/**
	 * Optional Effect layer that provides the LLMClient.Service. When set,
	 * replaces the default `LLMClient.layer + RequestExecutor.defaultLayer`
	 * composition. Intended for testing: supply a layer backed by a mock
	 * RequestExecutor to avoid real network calls.
	 *
	 * @internal
	 */
	_testLayers?: Layer.Layer<any>
}

// ---------------------------------------------------------------------------
// Build LLMClient layer
// ---------------------------------------------------------------------------

const llmClientLayer = LLMClient.layer.pipe(
	Layer.provide(RequestExecutor.defaultLayer),
	// No WebSocketExecutor needed -- HTTP SSE transport uses RequestExecutor only
)

// Resolve the diagnostics layer satisfied alongside `llmClientLayer`. When the
// host supplies a diagnostics context the provider installs the concrete sink;
// otherwise it falls back to the vendor noop so the optional service is always
// satisfiable before `bridge.ts` runs the stream.
function diagnosticsLayerFor(diagnostics: CodexDiagnosticsContext | undefined) {
	return diagnostics ? makeCodexDiagnosticsLayer(diagnostics, { transport: 'sse' }) : LLMDiagnostics.noopLayer
}

// ---------------------------------------------------------------------------
// LanguageModelV3 implementation
// ---------------------------------------------------------------------------

function createSseCodexModel(
	modelId: string,
	resolveAuth: () => Promise<{ token: string; accountId?: string }>,
	providerOptions: {
		version: string
		sessionId?: string
		fastMode?: boolean
		serviceTier?: string
		baseURL: string
		diagnostics?: CodexDiagnosticsContext
		_testLayers?: Layer.Layer<any>
	},
): LanguageModelV3 {
	const responsesLite = isResponsesLiteModel(modelId)
	const sessionId = responsesLite
		? resolveResponsesLiteSessionId(providerOptions.sessionId)
		: providerOptions.sessionId

	return {
		specificationVersion: 'v3',
		provider: 'codex-sse-vendor',
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
			const reasoningBlocks = new Map<string, { text: string; providerMetadata?: SharedV3ProviderMetadata }>()

			for (const part of parts) {
				if (part.type === 'text-delta') text += part.delta
				if (part.type === 'reasoning-start') {
					reasoningBlocks.set(part.id, { text: '', providerMetadata: part.providerMetadata })
				}
				if (part.type === 'reasoning-delta') {
					const block = reasoningBlocks.get(part.id) ?? { text: '', providerMetadata: part.providerMetadata }
					block.text += part.delta
					if (part.providerMetadata) block.providerMetadata = part.providerMetadata
					reasoningBlocks.set(part.id, block)
				}
				if (part.type === 'reasoning-end') {
					const block = reasoningBlocks.get(part.id)
					if (block?.text) {
						content.push({
							type: 'reasoning',
							text: block.text,
							providerMetadata: part.providerMetadata ?? block.providerMetadata,
						})
						reasoningBlocks.delete(part.id)
					}
				}
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
			for (const block of reasoningBlocks.values()) {
				if (block.text) {
					content.push({ type: 'reasoning', text: block.text, providerMetadata: block.providerMetadata })
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
			dbg('doStream called, abortSignal:', !!options.abortSignal)
			// 1. Resolve auth
			const { token, accountId } = await resolveAuth()

			// 2. Build vendor Auth with bearer token + custom headers
			const customHeaders: Record<string, string> = {
				originator: 'opencode',
				'User-Agent': buildCodexUserAgent(providerOptions.version),
				...(responsesLite && sessionId ? responsesLiteHeaderRecord(sessionId) : {}),
			}
			if (!responsesLite && sessionId) {
				customHeaders['session-id'] = sessionId
			}
			if (accountId) {
				customHeaders['ChatGPT-Account-Id'] = accountId
			}

			const auth = Auth.bearer(token).andThen(Auth.headers(customHeaders))

			// 3. Build LLMRequest via shared adapter with HTTP SSE route
			const request = convertCallOptionsToLLMRequest(modelId, options, {
				auth,
				baseURL: providerOptions.baseURL,
				route: httpSseRoute,
				fastMode: providerOptions.fastMode,
				serviceTier: providerOptions.serviceTier,
				sessionId,
			})

			// 4. Build the streaming Effect pipeline:
			//    LLMClient.stream(request) -> Stream<LLMEvent> -> flatMap to StreamPart[]
			//    The vendor's @ts-nocheck means LLMEvent comes through as unknown,
			//    so we cast to AnyLLMEvent for our mapping function.
			const llmStream = Stream.flatMap(
				LLMClient.stream(request) as Stream.Stream<AnyLLMEvent, unknown>,
				(event) => {
					if (event.type === 'provider-error') {
						providerOptions.diagnostics?.onEvent({
							event: 'codex.provider.protocol.provider_error',
							severity: 'error',
							transport: 'sse',
							annotations: providerOptions.diagnostics.annotations,
							metadata: {
								terminal: true,
								message: event.message as string,
								code: event.code as string | undefined,
							},
						})
					}
					return Stream.fromIterable(llmEventToStreamParts(event))
				},
			)

			// 5. Provide LLMClient layers so the stream's service requirements are satisfied
			//    SSE transport only needs RequestExecutor, no WebSocketExecutor.
			//    The diagnostics layer is piped on so the optional service is
			//    satisfied before `bridge.ts` runs the stream.
			const baseLayers = providerOptions._testLayers ?? llmClientLayer
			const layers = Layer.provideMerge(baseLayers, diagnosticsLayerFor(providerOptions.diagnostics))
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
			dbg('doStream returning ReadableStream')

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

export function createCodexSseVendorProvider(options: CodexSseVendorProviderOptions = {}): ProviderV3 {
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
			return createSseCodexModel(modelId, resolveAuth, {
				version,
				sessionId: options.sessionId,
				fastMode: options.fastMode,
				serviceTier: options.serviceTier ?? undefined,
				baseURL: CODEX_API_ENDPOINT.replace(/\/responses$/, ''),
				diagnostics: options.diagnostics,
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
