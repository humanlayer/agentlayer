import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { ensureFileAuthStore, type AuthInfo, type AuthStore } from '@humanlayer/agentlayer-provider-auth'
import { createCopilotProvider } from '@humanlayer/agentlayer-provider-github-copilot'
import {
	createCodexSseVendorProvider,
	createCodexEffectProvider,
	type CodexDiagnosticsContext,
	CODEX_DEFAULT_VERSION,
} from '@humanlayer/agentlayer-provider-openai-codex'
import { fetchWithBedrockAuth, makeBedrockAuth, type BedrockAuth } from './codex/bedrock-auth'
import {
	parseResponsesURL,
	resolveCodexConnection,
	type CodexConnection,
} from './codex/connection'

export type CodexProviderMode = 'sse' | 'websockets'

export type ProviderType = 'anthropic' | 'openai' | 'codex' | 'copilot' | 'firepass'

/**
 * Opaque, host-supplied context threaded through model resolution. CodeLayer
 * forwards `codexDiagnostics` into the Codex provider factory unchanged; it does
 * not understand the sink internals (Sentry, files, loggers). Non-Codex
 * providers ignore it.
 */
export interface ResolveModelContext {
	codexDiagnostics?: CodexDiagnosticsContext
	codexProviderMode?: CodexProviderMode
	codexConnection?: CodexConnection
	codexHome?: string
	/** Override the default file store, primarily for embedded runtimes and tests. */
	authStore?: AuthStore
}

export type CodexResponsesAuth =
	| { type: 'static'; apiKey: string; header?: string }
	| { type: 'bedrock'; auth: BedrockAuth }

export interface CodexResponsesOverride {
	baseURL: string
	endpointURL: string
	auth?: CodexResponsesAuth
	/** @deprecated Use auth: { type: 'static', apiKey, header }. */
	apiKey?: string
	/** @deprecated Use auth.header. */
	apiKeyHeader?: string
	wireModelId?: string
}

type CodexResponsesFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

export interface RawCacheUsage {
	cacheWriteTokens?: number
}

function captureCacheUsage(value: unknown, usage: RawCacheUsage): void {
	if (typeof value !== 'object' || value === null) return
	const record = value as Record<string, unknown>
	const response = typeof record.response === 'object' && record.response !== null
		? record.response as Record<string, unknown>
		: record
	const rawUsage = response.usage
	if (typeof rawUsage !== 'object' || rawUsage === null) return
	const details = (rawUsage as Record<string, unknown>).input_tokens_details
	if (typeof details !== 'object' || details === null) return
	const cacheWriteTokens = (details as Record<string, unknown>).cache_write_tokens
	if (typeof cacheWriteTokens === 'number' && Number.isFinite(cacheWriteTokens) && cacheWriteTokens >= 0) {
		usage.cacheWriteTokens = cacheWriteTokens
	}
}

function captureSseBlock(block: string, usage: RawCacheUsage): void {
	const data = block.split(/\r\n|\r|\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trimStart())
		.join('\n')
	if (data.length === 0 || data === '[DONE]') return
	try {
		const value = JSON.parse(data) as { type?: unknown }
		if (value.type === 'response.completed' || value.type === 'response.incomplete' || value.type === 'response.failed') {
			captureCacheUsage(value, usage)
		}
	} catch {
		// The provider remains responsible for malformed event errors.
	}
}

export async function captureResponseUsage(response: Response, usage: RawCacheUsage): Promise<Response> {
	if (!response.body || !response.ok) return response
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) {
		// Read once and rebuild rather than clone(): the SDK (>= @ai-sdk/openai
		// 3.0.96) reads the body in a way that races the clone's tee under Bun,
		// surfacing as "JSON Parse error: Unexpected EOF" from a half-drained
		// stream. A rebuilt Response hands it a fresh, fully-buffered body.
		const text = await response.text()
		try {
			captureCacheUsage(JSON.parse(text), usage)
		} catch {
			// The SDK parses and reports malformed JSON itself.
		}
		return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
	}
	if (!contentType.includes('text/event-stream')) return response

	const decoder = new TextDecoder()
	let line = ''
	let eventLines: string[] = []
	let skipLineFeed = false
	const endLine = () => {
		if (line.length === 0) {
			if (eventLines.length > 0) captureSseBlock(eventLines.join('\n'), usage)
			eventLines = []
		} else {
			eventLines.push(line)
		}
		line = ''
	}
	const parse = (text: string) => {
		for (const char of text) {
			if (skipLineFeed) {
				skipLineFeed = false
				if (char === '\n') continue
			}
			if (char === '\r') {
				endLine()
				skipLineFeed = true
			} else if (char === '\n') {
				endLine()
			} else {
				line += char
			}
		}
	}
	const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			parse(decoder.decode(chunk, { stream: true }))
			controller.enqueue(chunk)
		},
		flush() {
			parse(decoder.decode())
			if (line.length > 0) eventLines.push(line)
			if (eventLines.length > 0) captureSseBlock(eventLines.join('\n'), usage)
		},
	}))
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	})
}

function patchCacheUsage<T extends { usage: { inputTokens: { total?: number; cacheRead?: number; cacheWrite?: number; noCache?: number } } }>(
	result: T,
	rawUsage: RawCacheUsage,
): T {
	if (rawUsage.cacheWriteTokens === undefined) return result
	const input = result.usage.inputTokens
	const total = input.total ?? 0
	const cacheRead = Math.min(Math.max(0, input.cacheRead ?? 0), total)
	const cacheWrite = Math.min(Math.max(0, rawUsage.cacheWriteTokens), total - cacheRead)
	return {
		...result,
		usage: {
			...result.usage,
			inputTokens: {
				...input,
				cacheWrite,
				cacheRead,
				noCache: total - cacheRead - cacheWrite,
			},
		},
	}
}

const CODEX_OVERRIDE_ENV = {
	baseURL: 'CODELAYER_CODEX_BASE_URL',
	apiKey: 'CODELAYER_CODEX_API_KEY',
	apiKeyHeader: 'CODELAYER_CODEX_API_KEY_HEADER',
	wireModelId: 'CODELAYER_CODEX_MODEL',
} as const

function optionalEnvironmentValue(value: string | undefined): string | undefined {
	return value === undefined || value.length === 0 ? undefined : value
}

function parseCodexResponsesURL(rawValue: string): Pick<CodexResponsesOverride, 'baseURL' | 'endpointURL'> {
	return parseResponsesURL(rawValue, CODEX_OVERRIDE_ENV.baseURL)
}

function validateHeaderName(headerName: string): void {
	try {
		new Headers({ [headerName]: 'value' })
	} catch {
		throw new Error(`${CODEX_OVERRIDE_ENV.apiKeyHeader} must be a valid HTTP header name.`)
	}
}

export function readCodexResponsesOverride(
	env: NodeJS.ProcessEnv = process.env,
): CodexResponsesOverride | undefined {
	const rawBaseURL = optionalEnvironmentValue(env[CODEX_OVERRIDE_ENV.baseURL])
	const apiKey = optionalEnvironmentValue(env[CODEX_OVERRIDE_ENV.apiKey])
	const apiKeyHeader = optionalEnvironmentValue(env[CODEX_OVERRIDE_ENV.apiKeyHeader])
	const wireModelId = optionalEnvironmentValue(env[CODEX_OVERRIDE_ENV.wireModelId])
	const hasAnyOverrideSetting = [rawBaseURL, apiKey, apiKeyHeader, wireModelId].some(
		(value) => value !== undefined,
	)

	if (!hasAnyOverrideSetting) return undefined
	if (rawBaseURL === undefined) {
		throw new Error(
			`Custom Codex endpoint configuration is incomplete: ${CODEX_OVERRIDE_ENV.baseURL} is required when any CODELAYER_CODEX_* override is set.`,
		)
	}
	if (apiKey === undefined) {
		throw new Error(
			`Custom Codex endpoint configuration is incomplete: ${CODEX_OVERRIDE_ENV.apiKey} is required when any CODELAYER_CODEX_* override is set.`,
		)
	}

	if (apiKeyHeader !== undefined) validateHeaderName(apiKeyHeader)

	return {
		...parseCodexResponsesURL(rawBaseURL),
		auth: { type: 'static', apiKey, header: apiKeyHeader },
		apiKey,
		apiKeyHeader,
		wireModelId,
	}
}

function reportCustomResponsesError(options: {
	apiKey?: string
	diagnostics?: CodexDiagnosticsContext
	error: unknown
	operation: 'generate' | 'resolve' | 'stream'
	redactErrorMessage?: boolean
}): void {
	if (!options.diagnostics) return

	const error = options.error instanceof Error ? options.error : new Error(String(options.error))
	const safeMessage = options.redactErrorMessage
		? 'Amazon Bedrock Responses request failed.'
		: options.apiKey ? error.message.replaceAll(options.apiKey, '[REDACTED]') : error.message
	const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined
	try {
		options.diagnostics.onEvent({
			event: 'codex.provider.custom_responses.failed',
			severity: 'error',
			transport: 'custom_responses',
			annotations: options.diagnostics.annotations,
			metadata: {
				error: safeMessage,
				errorName: error.name,
				operation: options.operation,
				provider: 'custom-openai-responses',
				statusCode,
			},
		})
	} catch {
		// Diagnostics must never replace the provider error.
	}
}

export function createCustomCodexResponsesModel(options: {
	override: CodexResponsesOverride
	selectedModelId: string
	fetch?: CodexResponsesFetch
	diagnostics?: CodexDiagnosticsContext
}): LanguageModel {
	const { override, selectedModelId } = options
	const auth = override.auth ?? (override.apiKey === undefined
		? undefined
		: { type: 'static' as const, apiKey: override.apiKey, header: override.apiKeyHeader })
	if (!auth) throw new Error('Custom Codex Responses authentication is required.')
	const staticApiKey = auth.type === 'static' ? auth.apiKey : undefined
	const redactErrorMessage = auth.type === 'bedrock'
	const createDeploymentModel = (rawUsage: RawCacheUsage) => {
		const requestFetch = async (input: string | URL | Request, init?: RequestInit) => {
			let response: Response
			if (auth.type === 'bedrock') {
				response = await fetchWithBedrockAuth(auth.auth, options.fetch ?? globalThis.fetch, input, init)
			} else {
				const headers = new Headers(init?.headers)
				if (auth.header !== undefined) {
					headers.delete('authorization')
					headers.set(auth.header, auth.apiKey)
				}
				response = await (options.fetch ?? globalThis.fetch)(input, { ...init, headers })
			}
			return await captureResponseUsage(response, rawUsage)
		}
		return createOpenAI({
		name: 'custom-openai-responses',
		baseURL: override.baseURL,
			apiKey: staticApiKey ?? 'bedrock-auth-placeholder',
		fetch: requestFetch as typeof globalThis.fetch,
	}).responses(override.wireModelId ?? selectedModelId)
	}
	const modelMetadata = createDeploymentModel({})

	return {
		specificationVersion: modelMetadata.specificationVersion,
		provider: 'custom-openai-responses',
		modelId: selectedModelId,
		supportedUrls: modelMetadata.supportedUrls,
		doGenerate: async (request) => {
			const rawUsage: RawCacheUsage = {}
			try {
				return patchCacheUsage(await createDeploymentModel(rawUsage).doGenerate(request), rawUsage)
			} catch (error) {
				reportCustomResponsesError({
					apiKey: staticApiKey,
					diagnostics: options.diagnostics,
					error,
					operation: 'generate',
					redactErrorMessage,
				})
				throw error
			}
		},
		doStream: async (request) => {
			const rawUsage: RawCacheUsage = {}
			try {
				const result = await createDeploymentModel(rawUsage).doStream(request)
				return {
					...result,
					stream: result.stream.pipeThrough(new TransformStream({
						transform(part, controller) {
							if (part.type === 'error') {
								reportCustomResponsesError({
									apiKey: staticApiKey,
									diagnostics: options.diagnostics,
									error: part.error,
									operation: 'stream',
									redactErrorMessage,
								})
							}
							controller.enqueue(part.type === 'finish' ? patchCacheUsage(part, rawUsage) : part)
						},
					})),
				}
			} catch (error) {
				reportCustomResponsesError({
					apiKey: staticApiKey,
					diagnostics: options.diagnostics,
					error,
					operation: 'stream',
					redactErrorMessage,
				})
				throw error
			}
		},
	}
}

const FIREWORKS_MODEL_ID = 'accounts/fireworks/routers/kimi-k2p6-turbo'

export const DEFAULT_MODELS: Record<ProviderType, string> = {
	anthropic: 'claude-opus-4-5',
	openai: 'gpt-5.5',
	codex: 'gpt-5.6-sol',
	copilot: 'gpt-5.4',
	firepass: FIREWORKS_MODEL_ID,
}

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`Missing ${name}. Set it in your environment before running codelayer.`)
	}
	return value
}

function apiKeyFromAuth(auth: AuthInfo | undefined): string | undefined {
	return auth?.kind === 'api' ? auth.apiKey : undefined
}

async function resolveApiKey(envName: string, authKey: string): Promise<string> {
	const envValue = process.env[envName]
	if (envValue) return envValue

	const authStore = await ensureFileAuthStore()
	const authValue = apiKeyFromAuth(await authStore.get(authKey))
	if (authValue) return authValue

	throw new Error(`Missing ${envName} or auth for provider: ${authKey}. Set it before running codelayer.`)
}

export function resolveExaApiKey(): string | undefined {
	return process.env.EXA_API_KEY
}

export async function resolveModel(
	provider: ProviderType,
	modelId: string,
	context?: ResolveModelContext,
): Promise<LanguageModel> {
	switch (provider) {
		case 'anthropic': {
			const anthropic = createAnthropic({ apiKey: await resolveApiKey('ANTHROPIC_API_KEY', 'anthropic') })
			return anthropic(modelId)
		}
		case 'openai': {
			const openai = createOpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
			return openai(modelId)
		}
		case 'firepass': {
			const fireworks = createOpenAI({
				apiKey: await resolveApiKey('FIREWORKS_API_KEY', 'fireworks'),
				baseURL: 'https://api.fireworks.ai/inference/v1',
			})
			return fireworks.chat(modelId)
		}
		case 'codex': {
			const authStore = context?.authStore ?? await ensureFileAuthStore()
			const hasLegacyOverride = Object.values(CODEX_OVERRIDE_ENV).some((name) =>
				optionalEnvironmentValue(process.env[name]) !== undefined)
			const connection = await resolveCodexConnection({
				explicitConnection: context?.codexConnection,
				authStore,
				selectedModelId: modelId,
				codexHome: context?.codexHome,
				hasLegacyOverride,
			})
			if (connection.type === 'bedrock') {
				return createCustomCodexResponsesModel({
					override: {
						baseURL: connection.baseURL,
						endpointURL: connection.endpointURL,
						auth: {
							type: 'bedrock',
							auth: makeBedrockAuth({ profile: connection.profile, region: connection.region }),
						},
						wireModelId: connection.model,
					},
					selectedModelId: modelId,
					diagnostics: context?.codexDiagnostics,
				})
			}

			let override: CodexResponsesOverride | undefined
			if (connection.type === 'custom-responses') {
				try {
					override = readCodexResponsesOverride()
				} catch (error) {
					reportCustomResponsesError({
						apiKey: process.env[CODEX_OVERRIDE_ENV.apiKey],
						diagnostics: context?.codexDiagnostics,
						error,
						operation: 'resolve',
					})
					throw error
				}
			}
			if (override) {
				return createCustomCodexResponsesModel({
					override,
					selectedModelId: modelId,
					diagnostics: context?.codexDiagnostics,
				})
			}

			const requestedRaw = context?.codexProviderMode ?? (process.env.CODEX_PROVIDER as string | undefined)
			// An empty env value (CODEX_PROVIDER= from a template) means unset, not unknown.
			const requestedMode = requestedRaw === '' ? undefined : requestedRaw
			// Unknown or retired CODEX_PROVIDER values fall back to the default
			// transport instead of crashing a daemon that still carries the env var.
			const codexMode: CodexProviderMode =
				requestedMode === 'sse' || requestedMode === 'websockets' ? requestedMode : 'sse'
			if (requestedMode !== undefined && requestedMode !== codexMode) {
				console.error(`[codex-provider] unknown transport '${requestedMode}', falling back to 'sse'`)
			}
			const codexOpts = {
				authStore,
				version: CODEX_DEFAULT_VERSION,
				fastMode: true,
				sessionId: context?.codexDiagnostics?.annotations.sessionId as string | undefined,
				diagnostics: context?.codexDiagnostics,
			}
			console.error(`[codex-provider] using ${codexMode} transport for model ${modelId}`)
			switch (codexMode) {
				case 'websockets':
					return createCodexEffectProvider(codexOpts).languageModel(modelId) as LanguageModel
				case 'sse':
				default:
					return createCodexSseVendorProvider(codexOpts).languageModel(modelId) as LanguageModel
			}
		}
		case 'copilot': {
			const authStore = await ensureFileAuthStore()
			return createCopilotProvider({ authStore, version: 'codelayer' }).languageModel(modelId) as LanguageModel
		}
	}
}
