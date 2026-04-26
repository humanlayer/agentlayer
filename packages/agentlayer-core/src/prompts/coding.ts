import type { LanguageModel } from 'ai'
import { claudePrompt, codexPrompt, defaultPrompt, geminiPrompt, openaiPrompt } from './providers'

export const systemPrompts = {
	default: defaultPrompt,
	claude: claudePrompt,
	codex: codexPrompt,
	gemini: geminiPrompt,
	openai: openaiPrompt,
} as const

export type CodingPromptKey = keyof typeof systemPrompts
export type CodingModelFamily = Exclude<CodingPromptKey, 'default'>

function getModelMetadata(model: LanguageModel | string) {
	if (typeof model === 'string') {
		return {
			provider: '',
			modelId: model.toLowerCase(),
		}
	}

	return {
		provider: ((model as { provider?: string }).provider ?? '').toLowerCase(),
		modelId: ((model as { modelId?: string }).modelId ?? '').toLowerCase(),
	}
}

function resolveAnthropicThinking(modelId: string): Record<string, unknown> {
	if (modelId.includes('4-6') || modelId.includes('4.6')) {
		return { thinking: { type: 'adaptive' as const } }
	}

	if (modelId.includes('4-5') || modelId.includes('4.5')) {
		return { thinking: { type: 'enabled' as const, budgetTokens: 10000 } }
	}

	return {}
}

export function detectModelFamily(model: LanguageModel | string): CodingModelFamily {
	const { provider, modelId } = getModelMetadata(model)

	if (modelId.includes('gemini') || provider.includes('google')) {
		return 'gemini'
	}

	if (modelId.includes('gpt') || modelId.includes('codex') || provider.includes('codex')) {
		return 'codex'
	}

	if (provider.includes('openai')) {
		return 'openai'
	}

	if (
		modelId.startsWith('o1') ||
		modelId.startsWith('o3') ||
		modelId.startsWith('o4') ||
		modelId.includes('openai')
	) {
		return 'openai'
	}

	return 'claude'
}

export function getSystemPromptForModel(family: CodingPromptKey): string {
	return systemPrompts[family]
}

export function resolveCodingModelPrompt(model: LanguageModel | string | CodingPromptKey): string {
	if (typeof model === 'string' && model in systemPrompts) {
		return systemPrompts[model as CodingPromptKey]
	}

	return getSystemPromptForModel(detectModelFamily(model as LanguageModel | string))
}

export function buildCodingProviderOptions(model: LanguageModel | string) {
	const { modelId } = getModelMetadata(model)

	return {
		anthropic: {
			...resolveAnthropicThinking(modelId),
			cacheControl: { type: 'ephemeral' as const },
		},
		openai: {
			store: false as const,
			reasoningEffort: 'medium' as const,
			reasoningSummary: 'auto' as const,
			include: ['reasoning.encrypted_content'],
		},
	}
}

export interface CreateAgentSystemPromptOptions {
	model: LanguageModel | string | CodingPromptKey
	repoInstructions?: string
	environment?: string
	systemPromptAdditions?: string[]
}

export function createAgentSystemPrompt(opts: CreateAgentSystemPromptOptions): string[] {
	return [
		resolveCodingModelPrompt(opts.model),
		...(opts.repoInstructions ? [opts.repoInstructions] : []),
		...(opts.environment ? [opts.environment] : []),
		...(opts.systemPromptAdditions ?? []),
	]
}
