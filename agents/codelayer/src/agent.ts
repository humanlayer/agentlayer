import type { LanguageModel, JSONValue } from 'ai'
import { Agent, doomLoop, tarsPersona, type AgentConfig, type ProviderOptionsFactory, type Tool } from '@humanlayer/agentlayer-core'
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
import { createReadMultimodalTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createWriteTool } from '@humanlayer/agentlayer-filesystem/tools'
import { createCodingSubagentTool } from './coding-subagent-tool'

const CODELAYER_READ_TOOL_MODALITIES = ['text', 'image', 'pdf'] as const

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
	subagentThinking?: string
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

export type ReasoningEffort = string
export type ReasoningSummary = 'auto' | 'concise' | 'detailed'

export interface CodelayerProviderOptionOverrides {
	anthropic?: {
		thinking?: 'off' | 'adaptive' | 'enabled'
		budgetTokens?: number
		effort?: string
	}
	codex?: {
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
		fastMode?: boolean
		serviceTier?: string | null
		promptCacheKey?: string
	}
	copilot?: {
		reasoningEffort?: ReasoningEffort
		reasoningSummary?: ReasoningSummary
	}
}

export interface CodelayerProviderOptions extends Record<string, Record<string, JSONValue>> {
	anthropic: {
		thinking?: { type: 'adaptive'; display?: 'summarized' } | { type: 'enabled'; budgetTokens: number }
		effort?: string
		cacheControl: { type: 'ephemeral' }
	}
	openai: {
		store: false
		include?: string[]
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

function resolveAnthropicThinking(model: LanguageModel, effort?: string): Record<string, unknown> {
	const modelId = ((model as { modelId?: string }).modelId ?? '').toLowerCase()
	const resolvedEffort = effort ?? 'medium'
	if (modelId.includes('fable-5')) {
		return {
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: resolvedEffort,
		}
	}
	if (modelId.includes('opus') && (modelId.includes('4-8') || modelId.includes('4.8'))) {
		return {
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: resolvedEffort,
		}
	}
	if (modelId.includes('opus') && (modelId.includes('4-7') || modelId.includes('4.7'))) {
		return {
			thinking: { type: 'adaptive', display: 'summarized' },
			effort: resolvedEffort,
		}
	}
	if (modelId.includes('4-6') || modelId.includes('4.6')) {
		return {
			thinking: { type: 'adaptive' },
			effort: resolvedEffort,
		}
	}
	if (modelId.includes('4-5') || modelId.includes('4.5')) {
		return { thinking: { type: 'enabled', budgetTokens: 10000 } }
	}
	if (effort) return { effort }
	return {}
}

function resolveCodexThinking(model: LanguageModel): Record<string, unknown> {
	const modelId = ((model as { modelId?: string }).modelId ?? '').toLowerCase()
	if (modelId.includes('kimi')) {
		return { reasoningEffort: 'medium' }
	}
	if (modelId.includes('gpt-5.5')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'medium' }
	}
	if (modelId.includes('gpt-5') && !modelId.includes('gpt-5-pro')) {
		return { reasoningSummary: 'detailed', reasoningEffort: 'medium' }
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
				? {
						thinking: { type: 'adaptive' as const },
						...(overrides.anthropic.effort ? { effort: overrides.anthropic.effort } : {}),
					}
				: overrides.anthropic?.thinking === 'enabled'
					? {
							thinking: { type: 'enabled' as const, budgetTokens: overrides.anthropic.budgetTokens ?? 10000 },
							...(overrides.anthropic.effort ? { effort: overrides.anthropic.effort } : {}),
						}
					: resolveAnthropicThinking(model, overrides.anthropic?.effort)
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
			include: ['reasoning.encrypted_content'],
			...codexOptions,
		},
		copilot: {
			...copilotOptions,
		},
	}
}

function withRunScopedPromptCacheKey(
	overrides: CodelayerProviderOptionOverrides | undefined,
): CodelayerProviderOptionOverrides {
	const baseKey = overrides?.codex?.promptCacheKey
	const promptCacheKey = baseKey ? `${baseKey}-${crypto.randomUUID()}` : crypto.randomUUID()

	return {
		...(overrides ?? {}),
		codex: {
			...(overrides?.codex ?? {}),
			promptCacheKey,
		},
	}
}

export function createCodelayerProviderOptionsFactory(
	model: LanguageModel,
	overrides: CodelayerProviderOptionOverrides = {},
): ProviderOptionsFactory {
	return () => buildProviderOptions(model, withRunScopedPromptCacheKey(overrides))
}

export const LOW_ANTHROPIC_BUDGET = 2048

const EFFORT_RANK: Record<string, number> = {
	low: 0,
	medium: 1,
	high: 2,
	xhigh: 3,
}

/**
 * Derive a throttled override set for sub-agents from the parent's model + base
 * overrides + a thinking level (default `low`). Branches by model family using
 * the same lowercased-`modelId` idiom as {@link resolveAnthropicThinking}:
 *
 * - codex / firepass / copilot → `reasoningEffort = level`
 * - anthropic `4-5`/`4.5` (extended thinking, no adaptive support) →
 *   `{ thinking: 'enabled', budgetTokens: LOW_ANTHROPIC_BUDGET }`
 * - anthropic adaptive (`4.6`+/`4.7`/`4.8`, and any other model) →
 *   `effort = level`
 *
 * Guards (respect an explicitly-throttled parent — sub-agents never think
 * harder than the parent): if `base.anthropic.thinking === 'off'` it stays off,
 * and if `base.codex.reasoningEffort` already ranks at/below `level` the
 * parent's value is preserved rather than raised.
 */
export function subagentThinkingOverrides(
	model: LanguageModel,
	base: CodelayerProviderOptionOverrides = {},
	level: string = 'low',
): CodelayerProviderOptionOverrides {
	const modelId = ((model as { modelId?: string }).modelId ?? '').toLowerCase()

	// codex / firepass: reasoningEffort is a clean, uniform knob. Respect a
	// parent already throttled at or below `level` (rank low<medium<high<xhigh);
	// an unrecognized custom effort string falls through to applying `level`.
	const baseCodexEffort = base.codex?.reasoningEffort
	const baseRank = baseCodexEffort !== undefined ? EFFORT_RANK[baseCodexEffort] : undefined
	const levelRank = EFFORT_RANK[level]
	const keepParentCodex =
		baseRank !== undefined && levelRank !== undefined && baseRank <= levelRank
	const codex = {
		...(base.codex ?? {}),
		reasoningEffort: keepParentCodex ? baseCodexEffort : (level as ReasoningEffort),
	}

	// anthropic: `effort` only applies to ADAPTIVE thinking (Opus 4.6+). Opus 4.5
	// uses extended thinking (type: 'enabled' + budgetTokens) and does NOT support
	// adaptive thinking, so on 4.5 we throttle via budgetTokens. Respect an
	// explicit parent `thinking: 'off'`.
	let anthropic = { ...(base.anthropic ?? {}) }
	if (anthropic.thinking === 'off') {
		// leave it off
	} else if (modelId.includes('4-5') || modelId.includes('4.5')) {
		anthropic = { ...anthropic, thinking: 'enabled', budgetTokens: LOW_ANTHROPIC_BUDGET }
	} else {
		anthropic = { ...anthropic, effort: level }
	}

	const copilot = {
		...(base.copilot ?? {}),
		reasoningEffort: level as ReasoningEffort,
	}

	return { ...base, anthropic, codex, copilot }
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
		subagentThinking = 'low',
		environment,
	} = opts
	const modelFamily = detectModelFamily(model)
	const providerOptions = createCodelayerProviderOptionsFactory(model, providerOptionOverrides)
	const subagentProviderOptions = createCodelayerProviderOptionsFactory(
		model,
		subagentThinkingOverrides(model, providerOptionOverrides, subagentThinking),
	)
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
			providerOptions: subagentProviderOptions,
			outlineImplementerProviderOptions: providerOptions,
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
								read: createReadMultimodalTool({ cwd, readToolModalities: CODELAYER_READ_TOOL_MODALITIES }),
								apply_patch: createApplyPatchTool({ cwd }),
							},
							toolOpts,
						),
						...aux,
					}
				: {
						...withToolSuiteOptions(
							{
								read: createReadMultimodalTool({ cwd, readToolModalities: CODELAYER_READ_TOOL_MODALITIES }),
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
						readToolModalities: CODELAYER_READ_TOOL_MODALITIES,
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
						readToolModalities: CODELAYER_READ_TOOL_MODALITIES,
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
