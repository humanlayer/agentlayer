import type { LanguageModel } from 'ai'
import { Agent, doomLoop, type AgentConfig, type Tool } from '@humanlayer/agentlayer-core'

export interface SpecialistAgentOptions {
	model: LanguageModel
	tools: Record<string, Tool<any, any>>
	system: string[]
	hooks?: AgentConfig['hooks']
	stopWhen?: AgentConfig['stopWhen']
	providerOptions?: AgentConfig['providerOptions']
}

export function createSpecialistAgent(agentPrompt: string, opts: SpecialistAgentOptions): Agent {
	return new Agent({
		model: opts.model,
		tools: opts.tools,
		system: [agentPrompt, ...opts.system],
		hooks: opts.hooks,
		stopWhen: opts.stopWhen ?? [doomLoop(3)],
		providerOptions: opts.providerOptions,
	})
}
