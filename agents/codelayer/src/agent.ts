import type { LanguageModel } from 'ai'
import { Agent, doomLoop, tarsPersona, type AgentConfig, type Tool } from '@humanlayer/agentlayer-core'
import {
	createAgentFilesystemHooks,
	createAgentSystemPrompt,
	createClaudeAgentFilesystemToolset,
	createClaudeCodingAgentToolset,
	createCodingAgentAuxToolset,
	createCodingSubagentTool,
	createCodexAgentFilesystemToolset,
	createCodexCodingAgentToolset,
	detectModelFamily,
	getSystemPromptForModel,
} from '@humanlayer/agentlayer-filesystem'
import { createApplyPatchTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createEditTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createReadTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createWriteTool } from '@humanlayer/agentlayer-filesystem/tools'

const ORCHESTRATOR_PROMPT = `# Sub-Agent Orchestration

You are operating in orchestration mode.
Delegate substantial work to subagents when appropriate and keep the top-level agent focused on routing, coordination, and synthesis.`

export interface CodelayerAgentOptions {
	model: LanguageModel
	cwd: string
	hooks?: AgentConfig['hooks']
	systemPromptAdditions?: string[]
	rlm?: boolean
	rpi?: boolean
	tars?: boolean
	exaApiKey?: string
	context7ApiKey?: string
	skillTool?: Tool<any, any>
	additionalTools?: Record<string, Tool<any, any>>
	subagentTool?: Tool<any, any>
}

export type ModelFamily = ReturnType<typeof detectModelFamily>

function resolveAnthropicThinking(model: LanguageModel): Record<string, unknown> {
	const modelId = ((model as { modelId?: string }).modelId ?? '').toLowerCase()
	if (modelId.includes('4-6') || modelId.includes('4.6')) {
		return { thinking: { type: 'adaptive' } }
	}
	if (modelId.includes('4-5') || modelId.includes('4.5')) {
		return { thinking: { type: 'enabled', budgetTokens: 10000 } }
	}
	return {}
}

function resolveCodexThinking(model: LanguageModel): Record<string, unknown> {
	const modelId = ((model as { modelId?: string }).modelId ?? '').toLowerCase()
	if (modelId.includes('gpt-5.4') || modelId.includes('gpt-5.3') || modelId.includes('gpt-5.2')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'high' }
	}
	if (modelId.includes('gpt-5.1-codex-max')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'xhigh' }
	}
	return {}
}

export function buildProviderOptions(model: LanguageModel) {
	return {
		anthropic: {
			...resolveAnthropicThinking(model),
			cacheControl: { type: 'ephemeral' as const },
		},
		openai: {
			store: false as const,
			...resolveCodexThinking(model),
		},
	}
}

function mergeHooks(base: ReturnType<typeof createAgentFilesystemHooks>, hooks?: AgentConfig['hooks']): AgentConfig['hooks'] {
	return {
		approval: hooks?.approval,
		preToolUse: [...base.preToolUse, ...(hooks?.preToolUse ?? [])],
		postToolUse: [...base.postToolUse, ...(hooks?.postToolUse ?? [])],
		preRequest: [...base.preRequest, ...(hooks?.preRequest ?? [])],
	}
}

export async function createCodelayerAgent(opts: CodelayerAgentOptions): Promise<Agent> {
	const {
		model,
		cwd,
		hooks,
		systemPromptAdditions = [],
		rlm = false,
		rpi = false,
		tars = false,
		exaApiKey,
		context7ApiKey,
		skillTool,
		additionalTools = {},
		subagentTool,
	} = opts
	const modelFamily = detectModelFamily(model)
	const providerOptions = buildProviderOptions(model)
	const personaPromptAdditions = [
		...(tars ? [tarsPersona(35)] : []),
		...systemPromptAdditions,
	]
	const filesystemHooks = createAgentFilesystemHooks({ cwd })
	const mergedHooks = mergeHooks(filesystemHooks, hooks)
	const agentTool =
		subagentTool ??
		(await createCodingSubagentTool({
			cwd,
			model,
			exaApiKey,
			context7ApiKey,
			skillTool,
			additionalTools,
			hooks,
			providerOptions,
			systemPromptAdditions: personaPromptAdditions,
		}))

	if (rlm) {
		const system = await createAgentSystemPrompt({
			cwd,
			model,
			systemPromptAdditions: [ORCHESTRATOR_PROMPT, ...(rpi ? ['RPI specialist subagents are enabled. Prefer delegating specialized research and codebase analysis tasks to subagents when appropriate.'] : []), ...personaPromptAdditions],
		})
		const aux = await createCodingAgentAuxToolset({
			cwd,
			agentTool,
			skillTool,
			exaApiKey,
			additionalTools,
		})
		const tools =
			modelFamily === 'codex'
				? {
					read: createReadTool({ cwd }),
					apply_patch: createApplyPatchTool({ cwd }),
					...aux,
				}
				: {
					read: createReadTool({ cwd }),
					write: createWriteTool({ cwd }),
					edit: createEditTool({ cwd }),
					...aux,
				}

		return new Agent({
			model,
			tools,
			system,
			hooks: mergedHooks,
			stopWhen: [doomLoop(3)],
			providerOptions,
		})
	}

	const tools =
		modelFamily === 'codex'
			? await createCodexCodingAgentToolset({
					cwd,
					agentTool,
					skillTool,
					exaApiKey,
					additionalTools,
				})
			: await createClaudeCodingAgentToolset({
					cwd,
					agentTool,
					skillTool,
					exaApiKey,
					additionalTools,
				})

	const system = await createAgentSystemPrompt({
		cwd,
		model,
		systemPromptAdditions: [
			...(rpi ? ['RPI specialist subagents are enabled. Prefer delegating specialized research and codebase analysis tasks to subagents when appropriate.'] : []),
			...personaPromptAdditions,
		],
	})

	return new Agent({
		model,
		tools,
		system,
		hooks: mergedHooks,
		stopWhen: [doomLoop(3)],
		providerOptions,
	})
}

export { detectModelFamily, getSystemPromptForModel }
