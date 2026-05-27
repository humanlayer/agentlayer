import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { ensureFileAuthStore, type AuthInfo } from '@humanlayer/agentlayer-provider-auth'
import { createCopilotProvider } from '@humanlayer/agentlayer-provider-github-copilot'
import {
	createCodexCustomResponsesProvider,
	createCodexEffectProvider,
	createCodexResponsesProvider,
	CODEX_DEFAULT_VERSION,
} from '@humanlayer/agentlayer-provider-openai-codex'

export type CodexProviderMode = 'websockets' | 'aisdk_responses' | 'custom_responses'

export type ProviderType = 'anthropic' | 'openai' | 'codex' | 'copilot' | 'firepass'

const FIREWORKS_MODEL_ID = 'accounts/fireworks/routers/kimi-k2p6-turbo'

export const DEFAULT_MODELS: Record<ProviderType, string> = {
	anthropic: 'claude-opus-4-5',
	openai: 'gpt-5.5',
	codex: 'gpt-5.5',
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

export async function resolveModel(provider: ProviderType, modelId: string): Promise<LanguageModel> {
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
			const authStore = await ensureFileAuthStore()
			const codexMode = (process.env.CODEX_PROVIDER ?? 'websockets') as CodexProviderMode
			const codexOpts = { authStore, version: CODEX_DEFAULT_VERSION, fastMode: true }
			console.error(`[codex-provider] using ${codexMode} transport for model ${modelId}`)
			switch (codexMode) {
				case 'aisdk_responses':
					return createCodexResponsesProvider(codexOpts).languageModel(modelId) as LanguageModel
				case 'custom_responses':
					return createCodexCustomResponsesProvider(codexOpts).languageModel(modelId) as LanguageModel
				case 'websockets':
				default:
					return createCodexEffectProvider(codexOpts).languageModel(modelId) as LanguageModel
			}
		}
		case 'copilot': {
			const authStore = await ensureFileAuthStore()
			return createCopilotProvider({ authStore, version: 'codelayer' }).languageModel(modelId) as LanguageModel
		}
	}
}
