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
import { Effect, Layer, Stream } from 'effect'
import { buildCodexUserAgent, resolveCodexAuth } from '../../shared/auth'
import { CODEX_API_ENDPOINT, CODEX_DEFAULT_VERSION } from '../../shared/constants'
import { type AnyLLMEvent, emptyUsage, llmEventToStreamParts } from '../../shared/events'
import type { CodexProviderOptions } from '../../shared/types'
import { convertCallOptionsToLLMRequest } from './adapter'
import { effectStreamToReadableStream } from './bridge'

// Debug logging gated behind DEBUG_CODEX_WS=1
const DEBUG = process.env.DEBUG_CODEX_WS === '1'
const dbg = (...args: unknown[]) => {
	if (DEBUG) console.error('[codex-ws]', ...args)
}

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
// Build LLMClient layer
// ---------------------------------------------------------------------------

const llmClientLayer = LLMClient.layer.pipe(
	Layer.provide(RequestExecutor.defaultLayer),
	Layer.provide(WebSocketExecutor.layer),
)

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
			dbg('doStream called, abortSignal:', !!options.abortSignal)
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
