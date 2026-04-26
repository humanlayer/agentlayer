import {
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	NoSuchModelError,
	type ProviderV3,
} from '@ai-sdk/provider'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { AuthStore, OAuthAuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { createFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { COPILOT_PROVIDER_ID, getCopilotApiBaseUrl, startDeviceOAuth } from './copilot-oauth'
import { getCopilotModels } from './models'
import {
	createOpenaiCompatible,
	type OpenaiCompatibleProvider,
	type OpenaiCompatibleProviderSettings,
} from './sdk/copilot'
import type { CopilotModelMap } from './types'

export const COPILOT_PROVIDER = 'github-copilot'
export const SYNTHETIC_ATTACHMENT_PROMPT = 'Attached image(s) from tool result:'

export interface CopilotAuthInfo extends OAuthAuthInfo {
	enterpriseUrl?: string
}

export interface CopilotProviderOptions {
	authStore?: AuthStore
	providerId?: string
	fetch?: FetchFunction
	version?: string
	initiator?: string
}

export interface CopilotLanguageModelOptions extends CopilotProviderOptions {
	modelId: string
}

export interface CopilotHeadersResult {
	headers: Record<string, string>
	baseURL: string
	intent: 'conversation-edits'
	initiator: string
	isVision: boolean
}

export function createCopilotProvider(options: CopilotProviderOptions): ProviderV3 {
	return {
		specificationVersion: 'v3',
		languageModel(modelId: string) {
			return createCopilotLanguageModel({ ...options, modelId })
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

export function createCopilotLanguageModel(options: CopilotLanguageModelOptions): LanguageModelV3 {
	const sdk = createCopilotSdk(options)
	return shouldUseCopilotResponsesApi(options.modelId) ? sdk.responses(options.modelId) : sdk.chat(options.modelId)
}

export function createCopilotSdk(options: CopilotProviderOptions): OpenaiCompatibleProvider {
	const settings = createCopilotSdkSettings(options)
	return createOpenaiCompatible(settings)
}

export function createCopilotSdkSettings(options: CopilotProviderOptions): OpenaiCompatibleProviderSettings {
	const fetchFn = options.fetch ?? globalThis.fetch
	const authStore = options.authStore ?? createFileAuthStore()
	return {
		name: COPILOT_PROVIDER,
		baseURL: getCopilotApiBaseUrl(),
		fetch: (async (input, init) => {
			const request = await buildCopilotRequest({
				input,
				init,
				authStore,
				providerId: options.providerId ?? COPILOT_PROVIDER_ID,
				version: options.version,
				initiator: options.initiator,
			})
			return fetchFn(request.input, request.init)
		}) as FetchFunction,
	}
}

export async function buildCopilotRequest(args: {
	input: string | URL | Request
	init?: RequestInit
	authStore: AuthStore
	providerId: string
	version?: string
	initiator?: string | ((callOptions: LanguageModelV3CallOptions) => string)
}): Promise<{ input: string | URL | Request; init: RequestInit; context: CopilotHeadersResult }> {
	const auth = await resolveCopilotAuth(args.authStore, args.providerId)
	const baseURL = getCopilotApiBaseUrl(auth.enterpriseUrl)
	const url = resolveRequestUrl(args.input, baseURL)
	const headersContext = buildCopilotHeaders({
		auth,
		callerHeaders: args.init?.headers,
		body: args.init?.body,
		version: args.version,
		initiator: args.initiator,
	})
	return {
		input: url,
		init: {
			...args.init,
			headers: headersContext.headers,
		},
		context: headersContext,
	}
}

export function shouldUseCopilotResponsesApi(modelId: string): boolean {
	const match = /^gpt-(\d+)/.exec(modelId)
	if (!match) return false
	return Number(match[1]) >= 5 && !modelId.startsWith('gpt-5-mini')
}

export async function resolveCopilotAuth(store: AuthStore, providerId: string): Promise<CopilotAuthInfo> {
	const auth = await store.get(providerId)
	if (!auth || auth.kind !== 'oauth') {
		throw new Error(`Missing oauth auth for provider: ${providerId}`)
	}
	return auth as CopilotAuthInfo
}

export function buildCopilotHeaders(args: {
	auth: CopilotAuthInfo
	callerHeaders?: RequestInit['headers']
	body?: RequestInit['body']
	version?: string
	initiator?: string | ((callOptions: LanguageModelV3CallOptions) => string)
}): CopilotHeadersResult {
	const parsed = parseCopilotRequestBody(args.body)
	const isVision = detectVisionRequest(parsed)
	const defaultInitiator = detectAgentRequest(parsed) ? 'agent' : 'user'
	const initiator = typeof args.initiator === 'string' ? args.initiator : defaultInitiator
	const headers = new Headers(args.callerHeaders)
	const userAgent = `opencode/${args.version ?? '0.0.0'}`

	headers.set('Authorization', `Bearer ${getCopilotBearerToken(args.auth)}`)
	headers.set('User-Agent', userAgent)
	headers.set('Openai-Intent', 'conversation-edits')
	headers.set('x-initiator', initiator)
	if (isVision) {
		headers.set('Copilot-Vision-Request', 'true')
	}

	deleteHeader(headers, 'x-api-key')
	deleteHeader(headers, 'authorization')
	headers.set('Authorization', `Bearer ${getCopilotBearerToken(args.auth)}`)

	return {
		headers: Object.fromEntries(headers.entries()),
		baseURL: getCopilotApiBaseUrl(args.auth.enterpriseUrl),
		intent: 'conversation-edits',
		initiator,
		isVision,
	}
}

export async function listCopilotModels(
	args: {
		authStore?: AuthStore
		providerId?: string
		fetch?: FetchFunction
		existing?: CopilotModelMap
		version?: string
	} = {},
): Promise<CopilotModelMap> {
	const providerId = args.providerId ?? COPILOT_PROVIDER_ID
	const authStore = args.authStore ?? createFileAuthStore()
	const auth = await resolveCopilotAuth(authStore, providerId)
	return getCopilotModels(
		getCopilotApiBaseUrl(auth.enterpriseUrl),
		{
			Authorization: `Bearer ${getCopilotBearerToken(auth)}`,
			'User-Agent': `opencode/${args.version ?? '0.0.0'}`,
		},
		args.existing,
		args.fetch,
	)
}

export { startDeviceOAuth }

function resolveRequestUrl(input: string | URL | Request, baseURL: string): string {
	const defaultCopilotBaseURL = getCopilotApiBaseUrl()

	if (input instanceof URL) {
		return rewriteAbsoluteRequestUrl(input.toString(), baseURL, defaultCopilotBaseURL)
	}
	if (typeof input === 'string') {
		return input.startsWith('http://') || input.startsWith('https://')
			? rewriteAbsoluteRequestUrl(input, baseURL, defaultCopilotBaseURL)
			: `${baseURL}${input}`
	}
	const request = input as Request
	return request.url.startsWith('http://') || request.url.startsWith('https://')
		? rewriteAbsoluteRequestUrl(request.url, baseURL, defaultCopilotBaseURL)
		: `${baseURL}${request.url}`
}

function rewriteAbsoluteRequestUrl(url: string, baseURL: string, defaultCopilotBaseURL: string): string {
	if (url.startsWith(defaultCopilotBaseURL)) return `${baseURL}${url.slice(defaultCopilotBaseURL.length)}`
	if (url.startsWith('https://api.openai.com/v1')) return `${baseURL}${url.slice('https://api.openai.com/v1'.length)}`
	return url
}

function parseCopilotRequestBody(body: RequestInit['body']): any {
	if (typeof body !== 'string') return undefined
	try {
		return JSON.parse(body)
	} catch {
		return undefined
	}
}

function detectVisionRequest(body: any): boolean {
	if (body?.messages && Array.isArray(body.messages)) {
		return body.messages.some(
			(message: any) =>
				Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'image_url'),
		)
	}

	if (body?.input && Array.isArray(body.input)) {
		return body.input.some(
			(item: any) =>
				Array.isArray(item?.content) && item.content.some((part: any) => part?.type === 'input_image'),
		)
	}

	return false
}

function detectAgentRequest(body: any): boolean {
	if (body?.messages && Array.isArray(body.messages)) {
		const last = body.messages[body.messages.length - 1]
		if (!last) return false
		if (last.role !== 'user') return true
		return isSyntheticAttachmentMessage(last)
	}

	if (body?.input && Array.isArray(body.input)) {
		const last = body.input[body.input.length - 1]
		if (!last) return false
		if (last.role !== 'user') return true
		return isSyntheticAttachmentMessage(last)
	}

	return false
}

function isSyntheticAttachmentMessage(message: any): boolean {
	if (message?.role !== 'user') return false
	const content = message.content
	if (typeof content === 'string') return content === SYNTHETIC_ATTACHMENT_PROMPT
	if (!Array.isArray(content)) return false
	return content.some(
		(part: any) =>
			(part?.type === 'text' || part?.type === 'input_text') && part.text === SYNTHETIC_ATTACHMENT_PROMPT,
	)
}

function getCopilotBearerToken(auth: CopilotAuthInfo): string {
	return auth.refreshToken || auth.accessToken
}

function deleteHeader(headers: Headers, key: string) {
	headers.delete(key)
	headers.delete(key.toLowerCase())
	headers.delete(key.toUpperCase())
}
