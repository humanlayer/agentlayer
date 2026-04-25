import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { ensureFileAuthStore } from '@humanlayer/agentlayer-provider-auth'
import { createCopilotProvider } from '@humanlayer/agentlayer-provider-github-copilot'
import { createCodexProvider } from '@humanlayer/agentlayer-provider-openai-codex'

export type ProviderType = 'anthropic' | 'openai' | 'codex' | 'copilot'

export const DEFAULT_MODELS: Record<ProviderType, string> = {
	anthropic: 'claude-opus-4-5',
	openai: 'gpt-5.5',
	codex: 'gpt-5.5',
	copilot: 'gpt-5.4',
}

function requireEnv(name: string): string {
	const value = process.env[name]
	if (!value) {
		throw new Error(`Missing ${name}. Set it in your environment before running codelayer.`)
	}
	return value
}

export function resolveExaApiKey(): string | undefined {
	return process.env.EXA_API_KEY
}

export async function resolveModel(provider: ProviderType, modelId: string): Promise<LanguageModel> {
	switch (provider) {
		case 'anthropic': {
			const anthropic = createAnthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') })
			return anthropic(modelId)
		}
		case 'openai': {
			const openai = createOpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
			return openai(modelId)
		}
		case 'codex': {
			const authStore = await ensureFileAuthStore()
			return createCodexProvider({ authStore, version: 'codelayer', fastMode: true }).languageModel(modelId) as LanguageModel
		}
		case 'copilot': {
			const authStore = await ensureFileAuthStore()
			return createCopilotProvider({ authStore, version: 'codelayer' }).languageModel(modelId) as LanguageModel
		}
	}
}
