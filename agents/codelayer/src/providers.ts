import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { ensureFileAuthStore, type AuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { createCopilotProvider } from '@humanlayer/agentlayer-provider-github-copilot'
import {
	createCodexSseVendorProvider,
	createCodexEffectProvider,
	type CodexDiagnosticsContext,
	CODEX_DEFAULT_VERSION,
} from '@humanlayer/agentlayer-provider-openai-codex'

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
}

export interface CodexResponsesOverride {
	baseURL: string
	endpointURL: string
	apiKey: string
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
		try {
			captureCacheUsage(await response.clone().json(), usage)
		} catch {
			// The SDK parses and reports malformed JSON from the original response.
		}
		return response
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

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase()
	if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]') return true
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
	return match !== null && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255)
}

function parseCodexResponsesURL(rawValue: string): Pick<CodexResponsesOverride, 'baseURL' | 'endpointURL'> {
	let url: URL
	try {
		url = new URL(rawValue)
	} catch {
		throw new Error(`${CODEX_OVERRIDE_ENV.baseURL} must be an absolute HTTP or HTTPS URL.`)
	}

	if (url.username || url.password) {
		throw new Error(`${CODEX_OVERRIDE_ENV.baseURL} must not contain a username or password.`)
	}
	if (url.search || url.hash) {
		throw new Error(`${CODEX_OVERRIDE_ENV.baseURL} must not contain a query string or fragment.`)
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
		throw new Error(`${CODEX_OVERRIDE_ENV.baseURL} must use HTTPS unless it points to a loopback host.`)
	}

	const normalizedPath = url.pathname.replace(/\/+$/, '')
	const isFullEndpoint = normalizedPath.endsWith('/responses')
	const basePath = isFullEndpoint ? normalizedPath.slice(0, -'/responses'.length) : normalizedPath
	const endpointPath = `${basePath}/responses` || '/responses'

	url.pathname = basePath || '/'
	const baseURL = url.toString().replace(/\/$/, '')
	url.pathname = endpointPath

	return {
		baseURL,
		endpointURL: url.toString(),
	}
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
}): void {
	if (!options.diagnostics) return

	const error = options.error instanceof Error ? options.error : new Error(String(options.error))
	const safeMessage = options.apiKey ? error.message.replaceAll(options.apiKey, '[REDACTED]') : error.message
	const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined
	try {
		options.diagnostics.onEvent({
			event: 'codex.provider.custom_responses.failed',
			severity: 'error',
			transport: 'aisdk_responses',
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
	const createDeploymentModel = (rawUsage: RawCacheUsage) => {
		const requestFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			if (override.apiKeyHeader !== undefined) {
				headers.delete('authorization')
				headers.set(override.apiKeyHeader, override.apiKey)
			}
			const response = await (options.fetch ?? globalThis.fetch)(input, { ...init, headers })
			return await captureResponseUsage(response, rawUsage)
		}
		return createOpenAI({
		name: 'custom-openai-responses',
		baseURL: override.baseURL,
		apiKey: override.apiKey,
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
					apiKey: override.apiKey,
					diagnostics: options.diagnostics,
					error,
					operation: 'generate',
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
									apiKey: override.apiKey,
									diagnostics: options.diagnostics,
									error: part.error,
									operation: 'stream',
								})
							}
							controller.enqueue(part.type === 'finish' ? patchCacheUsage(part, rawUsage) : part)
						},
					})),
				}
			} catch (error) {
				reportCustomResponsesError({
					apiKey: override.apiKey,
					diagnostics: options.diagnostics,
					error,
					operation: 'stream',
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
			let override: CodexResponsesOverride | undefined
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
			if (override !== undefined) {
				return createCustomCodexResponsesModel({
					override,
					selectedModelId: modelId,
					diagnostics: context?.codexDiagnostics,
				})
			}

			const authStore = await ensureFileAuthStore()
			const requestedMode = context?.codexProviderMode ?? (process.env.CODEX_PROVIDER as string | undefined)
			// 'aisdk_responses' was removed (it delegated SSE parsing to upstream
			// @ai-sdk/openai, which drops cache_write_tokens); unknown or retired
			// values fall back to the default transport instead of crashing a
			// daemon that still carries the env var.
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
