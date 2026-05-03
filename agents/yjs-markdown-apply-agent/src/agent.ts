import { Agent, type AgentConfig } from '@humanlayer/agentlayer-core'
import type { LanguageModel } from 'ai'
import { APPLY_AGENT_SYSTEM_PROMPT } from './prompts'
import type { SecureApplyExecutor } from './secure-apply-tool'
import { createYjsMarkdownApplyTools } from './tools'

export type CreateYjsMarkdownApplyAgentOptions = {
	model: LanguageModel
	executor: SecureApplyExecutor
	system?: string
	maxSteps?: number
	providerOptions?: AgentConfig['providerOptions']
}

export function createYjsMarkdownApplyAgent(options: CreateYjsMarkdownApplyAgentOptions) {
	return new Agent({
		model: options.model,
		system: options.system ?? APPLY_AGENT_SYSTEM_PROMPT,
		tools: createYjsMarkdownApplyTools(options.executor),
		maxSteps: options.maxSteps,
		providerOptions: options.providerOptions,
	})
}
