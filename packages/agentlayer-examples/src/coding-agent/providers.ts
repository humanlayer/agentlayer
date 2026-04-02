import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'

export type ProviderType = 'anthropic' | 'openai'

export const DEFAULT_MODELS: Record<ProviderType, string> = {
	anthropic: 'claude-sonnet-4-20250514',
	openai: 'gpt-4o',
}

export function resolveModel(provider: ProviderType, modelId: string): LanguageModel {
	switch (provider) {
		case 'anthropic': {
			const apiKey = process.env.ANTHROPIC_API_KEY
			if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is required')
			const anthropic = createAnthropic({ apiKey })
			return anthropic(modelId)
		}
		case 'openai': {
			const apiKey = process.env.OPENAI_API_KEY
			if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required')
			const openai = createOpenAI({ apiKey })
			return openai(modelId)
		}
	}
}

// Adaptive thinking for Claude 4.6, manual thinking for 4.5
export function resolveAnthropicThinking(modelId: string): Record<string, unknown> {
	if (modelId.includes('4-6') || modelId.includes('4.6')) {
		return { thinking: { type: 'adaptive' } }
	}
	if (modelId.includes('4-5') || modelId.includes('4.5')) {
		return { thinking: { type: 'enabled', budgetTokens: 10000 } }
	}
	return {}
}

export function resolveProviderOptions(provider: ProviderType, modelId: string): Record<string, Record<string, unknown>> | undefined {
	if (provider === 'anthropic') {
		return {
			anthropic: {
				...resolveAnthropicThinking(modelId),
				cacheControl: { type: 'ephemeral' },
			},
		}
	}
	return undefined
}
