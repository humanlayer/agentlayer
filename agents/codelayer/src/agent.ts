import type { LanguageModel, JSONValue } from 'ai'
import { Agent, doomLoop, tarsPersona, type AgentConfig, type Tool } from '@humanlayer/agentlayer-core'
import {
	createAgentFilesystemHooks,
	createAgentSystemPrompt,
	createClaudeAgentFilesystemToolset,
	createClaudeCodingAgentToolset,
	createCodingAgentAuxToolset,
	createCodexAgentFilesystemToolset,
	createCodexCodingAgentToolset,
	detectModelFamily,
	getSystemPromptForModel,
} from '@humanlayer/agentlayer-filesystem'
import { saneDefaultOutputTruncationHooks } from '@humanlayer/agentlayer-filesystem/hooks'
import { createApplyPatchTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createEditTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createReadTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createWriteTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createCodingSubagentTool } from './coding-subagent-tool'

const ORCHESTRATOR_PROMPT = `# Sub-Agent Orchestration

You are operating in orchestration mode.
Delegate substantial work to subagents when appropriate and keep the top-level agent focused on routing, coordination, and synthesis.`

export interface CodelayerAgentOptions {
	model: LanguageModel
	cwd: string
	hooks?: AgentConfig['hooks']
	tools?: CodelayerToolSuiteOptions
	systemPromptAdditions?: string[]
	rlm?: boolean
	rpi?: boolean
	tars?: boolean
	exaApiKey?: string
	context7ApiKey?: string
	skillTool?: Tool<any, any>
	additionalTools?: Record<string, Tool<any, any>>
	subagentTool?: Tool<any, any>
	providerOptionOverrides?: CodelayerProviderOptionOverrides
	environment?: CodelayerEnvironmentOptions
}

export interface CodelayerEnvironmentOptions {
	include?: boolean
	date?: Date
	platform?: string
}

export type ModelFamily = ReturnType<typeof detectModelFamily>

export interface CodelayerToolSuiteOptions {
	bash?: boolean
	read?: boolean
	write?: boolean
	edit?: boolean
	applyPatch?: boolean
	list?: boolean
	grep?: boolean
	glob?: boolean
	webFetch?: boolean
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ReasoningSummary = 'auto' | 'concise' | 'detailed'

export interface CodelayerProviderOptionOverrides {
	anthropic?: {
		thinking?: 'off' | 'adaptive' | 'enabled'
		budgetTokens?: number
	}
	codex?: {
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
		fastMode?: boolean
		serviceTier?: string | null
	}
	copilot?: {
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
	}
}

export interface CodelayerProviderOptions extends Record<string, Record<string, JSONValue>> {
	anthropic: {
		thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number }
		cacheControl: { type: 'ephemeral' }
	}
	openai: {
		store: false
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
		fastMode?: boolean
		serviceTier?: string | null
	}
	copilot: {
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
	}
}

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
	if (modelId.includes('gpt-5.5')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'low' }
	}
	if (modelId.includes('gpt-5.4') || modelId.includes('gpt-5.3') || modelId.includes('gpt-5.2')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'high' }
	}
	if (modelId.includes('gpt-5.1-codex-max')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'xhigh' }
	}
	return {}
}

function withToolSuiteOptions<T extends Record<string, Tool<any, any>>>(
	tools: T,
	options: CodelayerToolSuiteOptions | undefined,
): Partial<T> {
	if (!options) return tools
	const enabledByToolName: Record<string, boolean | undefined> = {
		bash: options.bash,
		read: options.read,
		write: options.write,
		edit: options.edit,
		apply_patch: options.applyPatch,
		list: options.list,
		grep: options.grep,
		glob: options.glob,
		web_fetch: options.webFetch,
	}

	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => enabledByToolName[name] !== false),
	) as Partial<T>
}

export function buildProviderOptions(
	model: LanguageModel,
	overrides: CodelayerProviderOptionOverrides = {},
): CodelayerProviderOptions {
	const anthropicThinking =
		overrides.anthropic?.thinking === 'off'
			? {}
			: overrides.anthropic?.thinking === 'adaptive'
				? { thinking: { type: 'adaptive' as const } }
				: overrides.anthropic?.thinking === 'enabled'
					? { thinking: { type: 'enabled' as const, budgetTokens: overrides.anthropic.budgetTokens ?? 10000 } }
					: resolveAnthropicThinking(model)
	const codexOptions = {
		...resolveCodexThinking(model),
		fastMode: overrides.codex?.fastMode ?? false,
		...overrides.codex,
	}
	const copilotOptions = overrides.copilot ?? {}

	return {
		anthropic: {
			...anthropicThinking,
			cacheControl: { type: 'ephemeral' as const },
		},
		openai: {
			store: false as const,
			...codexOptions,
		},
		copilot: {
			...copilotOptions,
		},
	}
}

function mergeHooks(base: ReturnType<typeof createAgentFilesystemHooks>, hooks?: AgentConfig['hooks']): AgentConfig['hooks'] {
	const fileStatePostHooks = base.postToolUse.filter((hook) => !saneDefaultOutputTruncationHooks.includes(hook))

	return {
		approval: hooks?.approval,
		preToolUse: [...base.preToolUse, ...(hooks?.preToolUse ?? [])],
		postToolUse: [...saneDefaultOutputTruncationHooks, ...fileStatePostHooks, ...(hooks?.postToolUse ?? [])],
		preRequest: [...base.preRequest, ...(hooks?.preRequest ?? [])],
	}
}

export async function createCodelayerAgent(opts: CodelayerAgentOptions): Promise<Agent> {
	const {
		model,
		cwd,
		hooks,
		tools: toolOpts,
		systemPromptAdditions = [],
		rlm = false,
		rpi = false,
		tars = false,
		exaApiKey,
		context7ApiKey,
		skillTool,
		additionalTools = {},
		subagentTool,
		providerOptionOverrides,
		environment,
	} = opts
	const modelFamily = detectModelFamily(model)
	const providerOptions = buildProviderOptions(model, providerOptionOverrides)
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
			includeEnvironment: environment?.include,
			date: environment?.date,
			platform: environment?.platform,
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
			includeEnvironment: environment?.include,
			date: environment?.date,
			platform: environment?.platform,
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
						...withToolSuiteOptions(
							{
								read: createReadTool({ cwd }),
								apply_patch: createApplyPatchTool({ cwd }),
							},
							toolOpts,
						),
						...aux,
					}
				: {
						...withToolSuiteOptions(
							{
								read: createReadTool({ cwd }),
								write: createWriteTool({ cwd }),
								edit: createEditTool({ cwd }),
							},
							toolOpts,
						),
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
			? withToolSuiteOptions(
					await createCodexCodingAgentToolset({
						cwd,
						agentTool,
						skillTool,
						exaApiKey,
						additionalTools,
					}),
					toolOpts,
				)
			: withToolSuiteOptions(
					await createClaudeCodingAgentToolset({
						cwd,
						agentTool,
						skillTool,
						exaApiKey,
						additionalTools,
					}),
					toolOpts,
				)

	const system = await createAgentSystemPrompt({
		cwd,
		model,
		includeEnvironment: environment?.include,
		date: environment?.date,
		platform: environment?.platform,
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
