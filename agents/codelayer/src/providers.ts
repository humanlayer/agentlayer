import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { ensureFileAuthStore, type AuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { createCopilotProvider } from '@humanlayer/agentlayer-provider-github-copilot'
import {
	createCodexSseVendorProvider,
	createCodexEffectProvider,
	createCodexResponsesProvider,
	type CodexDiagnosticsContext,
	CODEX_DEFAULT_VERSION,
} from '@humanlayer/agentlayer-provider-openai-codex'

export type CodexProviderMode = 'sse' | 'aisdk_responses' | 'websockets'

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
	const requestFetch = override.apiKeyHeader === undefined
		? options.fetch
		: async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			headers.delete('authorization')
			headers.set(override.apiKeyHeader!, override.apiKey)
			return (options.fetch ?? globalThis.fetch)(input, { ...init, headers })
		}
	const deploymentModel = createOpenAI({
		name: 'custom-openai-responses',
		baseURL: override.baseURL,
		apiKey: override.apiKey,
		fetch: requestFetch as typeof globalThis.fetch | undefined,
	}).responses(override.wireModelId ?? selectedModelId)

	return {
		specificationVersion: deploymentModel.specificationVersion,
		provider: 'custom-openai-responses',
		modelId: selectedModelId,
		supportedUrls: deploymentModel.supportedUrls,
		doGenerate: async (request) => {
			try {
				return await deploymentModel.doGenerate(request)
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
			try {
				const result = await deploymentModel.doStream(request)
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
							controller.enqueue(part)
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
			const codexMode = context?.codexProviderMode
				?? (process.env.CODEX_PROVIDER as CodexProviderMode | undefined)
				?? 'sse'
			const codexOpts = {
				authStore,
				version: CODEX_DEFAULT_VERSION,
				fastMode: true,
				sessionId: context?.codexDiagnostics?.annotations.sessionId as string | undefined,
				diagnostics: context?.codexDiagnostics,
			}
			console.error(`[codex-provider] using ${codexMode} transport for model ${modelId}`)
			switch (codexMode) {
				case 'aisdk_responses':
					return createCodexResponsesProvider(codexOpts).languageModel(modelId) as LanguageModel
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
