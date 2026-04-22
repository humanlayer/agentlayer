import { isAbsolute, resolve } from 'node:path'
import type { AgentEvent } from '@humanlayer/agentlayer-core'
import {
	Agent,
	type AgentConfig,
	createSubagentsTool,
	createWebFetchTool,
	doomLoop,
	type PostToolUseHook,
	type PreRequestHook,
	type PreToolUseHook,
	type SubAgentConfig,
	type Tool,
} from '@humanlayer/agentlayer-core'
import {
	type DeduplicateReadsOptions,
	deduplicateReads,
	type StripThinkingOptions,
	stripThinkingTokens,
	type TruncateOldBashResultsOptions,
	truncateOldBashResults,
} from '@humanlayer/agentlayer-core/hooks'
import type { Skill } from '@humanlayer/agentlayer-core/interfaces'
import type { LanguageModel } from 'ai'
import { createFileStateTrackingHook, createReadBeforeWriteHook, createWastedReadHook } from './hooks/file-state'
import {
	createBashOutputTruncationHook,
	createGlobOutputTruncationHook,
	createGrepOutputTruncationHook,
	createListOutputTruncationHook,
	createReadTruncationHook,
} from './hooks/output-truncation'
import { createAgentSystemPrompt, detectModelFamily } from './prompts/index'
import { createApplyPatchTool } from './tools/apply-patch'
import { createBashTool } from './tools/bash'
import { createEditTool } from './tools/edit'
import { createGlobTool } from './tools/glob'
import { createGrepTool } from './tools/grep'
import { createListTool } from './tools/list'
import { createReadTool } from './tools/read'
import { createSkillToolFromDirs, createSkillToolFromRepoDirs, type SkillDirEntry } from './tools/skill'
import { createWebSearchTool } from './tools/web-search'
import { createWriteTool } from './tools/write'

const CODEBASE_LOCATOR_PROMPT = `You locate files, directories, and code areas relevant to a task.
Use glob, grep, and list to identify where code lives without doing deep implementation analysis.`

const CODEBASE_ANALYZER_PROMPT = `You analyze how code works today.
Read the relevant files and explain behavior with precise file references.`

const CODEBASE_PATTERN_FINDER_PROMPT = `You find similar implementations and usage examples in the codebase.
Prioritize concrete patterns that can be followed directly.`

const WEB_SEARCH_RESEARCHER_PROMPT = `You research up-to-date technical information from the web.
Prioritize concise answers grounded in official documentation and relevant examples.`

const BASH_AGENT_PROMPT = `You are a specialized bash execution agent.
Focus on terminal operations, command execution, builds, tests, git, and scripts.`

export interface AgentOutputTruncationOptions {
	maxLines?: number
	maxBytes?: number
	maxLineWidth?: number
}

export interface CreateAgentFilesystemHooksOptions {
	cwd: string
	outputTruncation?: AgentOutputTruncationOptions
	stripThinking?: StripThinkingOptions
	deduplicateReads?: DeduplicateReadsOptions
	truncateOldBashResults?: TruncateOldBashResultsOptions
}

export function createAgentFilesystemHooks(opts: CreateAgentFilesystemHooksOptions): {
	preToolUse: readonly PreToolUseHook[]
	postToolUse: readonly PostToolUseHook[]
	preRequest: readonly PreRequestHook[]
} {
	const sharedOutputTruncation = opts.outputTruncation
		? {
				...(opts.outputTruncation.maxLines !== undefined ? { maxLines: opts.outputTruncation.maxLines } : {}),
				...(opts.outputTruncation.maxBytes !== undefined ? { maxBytes: opts.outputTruncation.maxBytes } : {}),
			}
		: undefined
	const readOutputTruncation = opts.outputTruncation
		? {
				...(opts.outputTruncation.maxLines !== undefined ? { maxLines: opts.outputTruncation.maxLines } : {}),
				...(opts.outputTruncation.maxBytes !== undefined ? { maxBytes: opts.outputTruncation.maxBytes } : {}),
				...(opts.outputTruncation.maxLineWidth !== undefined
					? { maxLineWidth: opts.outputTruncation.maxLineWidth }
					: {}),
			}
		: undefined

	return {
		preToolUse: [createWastedReadHook({ cwd: opts.cwd }), createReadBeforeWriteHook({ cwd: opts.cwd })],
		postToolUse: [
			createReadTruncationHook(readOutputTruncation),
			createBashOutputTruncationHook(sharedOutputTruncation),
			createGlobOutputTruncationHook(sharedOutputTruncation),
			createGrepOutputTruncationHook(sharedOutputTruncation),
			createListOutputTruncationHook(sharedOutputTruncation),
			createFileStateTrackingHook({ cwd: opts.cwd }),
		],
		preRequest: [
			stripThinkingTokens(opts.stripThinking),
			deduplicateReads(opts.deduplicateReads),
			truncateOldBashResults(opts.truncateOldBashResults),
		],
	} as const
}

export interface CreateAgentFilesystemToolsetOptions {
	cwd: string
}

export function createClaudeAgentFilesystemToolset(opts: CreateAgentFilesystemToolsetOptions) {
	return {
		bash: createBashTool({ cwd: opts.cwd }),
		read: createReadTool({ cwd: opts.cwd }),
		write: createWriteTool({ cwd: opts.cwd }),
		edit: createEditTool({ cwd: opts.cwd }),
		glob: createGlobTool({ cwd: opts.cwd }),
		grep: createGrepTool({ cwd: opts.cwd }),
		list: createListTool({ cwd: opts.cwd }),
	} as const
}

export function createCodexAgentFilesystemToolset(opts: CreateAgentFilesystemToolsetOptions) {
	return {
		bash: createBashTool({ cwd: opts.cwd }),
		read: createReadTool({ cwd: opts.cwd }),
		apply_patch: createApplyPatchTool({ cwd: opts.cwd }),
		glob: createGlobTool({ cwd: opts.cwd }),
		grep: createGrepTool({ cwd: opts.cwd }),
		list: createListTool({ cwd: opts.cwd }),
	} as const
}

export interface CreateCodingAgentAuxToolsetOptions {
	cwd: string
	agentTool?: Tool<any, any>
	subagents?: SubAgentConfig[]
	skillTool?: Tool<any, any>
	skillDirs?: string | string[] | SkillDirEntry[]
	skills?: Skill[]
	allowMissingSkills?: boolean
	exaApiKey?: string
	webSearchTool?: Tool<any, any>
	webFetchTool?: Tool<any, any>
	additionalTools?: Record<string, Tool<any, any>>
	onChildEvent?: (event: AgentEvent) => void
}

function resolveSkillDirPath(path: string, cwd: string): string {
	if (path === '~' || path.startsWith('~/') || isAbsolute(path)) {
		return path
	}
	return resolve(cwd, path)
}

function resolveSkillDirsInput(dirs: string | string[] | SkillDirEntry[], cwd: string): SkillDirEntry[] {
	const entries = Array.isArray(dirs) ? dirs : [dirs]
	return entries.map((entry) =>
		typeof entry === 'string'
			? { path: resolveSkillDirPath(entry, cwd) }
			: { ...entry, path: resolveSkillDirPath(entry.path, cwd) },
	)
}

async function resolveSkillTool(opts: CreateCodingAgentAuxToolsetOptions): Promise<Tool<any, any>> {
	if (opts.skillTool) {
		return opts.skillTool
	}

	if (opts.skillDirs) {
		return createSkillToolFromDirs({
			dirs: resolveSkillDirsInput(opts.skillDirs, opts.cwd),
			skills: opts.skills,
		})
	}

	return createSkillToolFromRepoDirs({
		cwd: opts.cwd,
		skills: opts.skills,
		allowMissing: opts.allowMissingSkills ?? true,
	})
}

export async function createCodingAgentAuxToolset(opts: CreateCodingAgentAuxToolsetOptions) {
	const skillTool = await resolveSkillTool(opts)
	const agentTool =
		opts.agentTool ??
		(opts.subagents ? createSubagentsTool({ agents: opts.subagents, onChildEvent: opts.onChildEvent }) : undefined)
	const webSearchTool =
		opts.webSearchTool ?? (opts.exaApiKey ? createWebSearchTool({ exaApiKey: opts.exaApiKey }) : undefined)

	return {
		...(agentTool ? { agent: agentTool } : {}),
		skill: skillTool,
		web_fetch: opts.webFetchTool ?? createWebFetchTool(),
		...(webSearchTool ? { web_search: webSearchTool } : {}),
		...(opts.additionalTools ?? {}),
	} as const
}

export interface CreateCodingAgentToolsetOptions extends CreateCodingAgentAuxToolsetOptions {}

export async function createClaudeCodingAgentToolset(opts: CreateCodingAgentToolsetOptions) {
	return {
		...createClaudeAgentFilesystemToolset({ cwd: opts.cwd }),
		...(await createCodingAgentAuxToolset(opts)),
	} as const
}

export async function createCodexCodingAgentToolset(opts: CreateCodingAgentToolsetOptions) {
	return {
		...createCodexAgentFilesystemToolset({ cwd: opts.cwd }),
		...(await createCodingAgentAuxToolset(opts)),
	} as const
}

export interface CreateCodingSubagentToolOptions
	extends CreateAgentFilesystemHooksOptions,
		CreateCodingAgentAuxToolsetOptions {
	model: LanguageModel
	system?: string | string[]
	systemPromptAdditions?: string[]
	hooks?: AgentConfig['hooks']
	stopWhen?: AgentConfig['stopWhen']
	providerOptions?: AgentConfig['providerOptions']
}

function mergeHooks(
	base: ReturnType<typeof createAgentFilesystemHooks>,
	hooks?: AgentConfig['hooks'],
): AgentConfig['hooks'] {
	return {
		approval: hooks?.approval,
		preToolUse: [...base.preToolUse, ...(hooks?.preToolUse ?? [])],
		postToolUse: [...base.postToolUse, ...(hooks?.postToolUse ?? [])],
		preRequest: [...base.preRequest, ...(hooks?.preRequest ?? [])],
	}
}

function buildSystem(baseSystem: string[], agentPrompt?: string): string[] {
	return [...(agentPrompt ? [agentPrompt] : []), ...baseSystem]
}

function createChildAgent(opts: {
	model: LanguageModel
	tools: Record<string, Tool<any, any>>
	system: string[]
	hooks: AgentConfig['hooks']
	stopWhen: AgentConfig['stopWhen']
	providerOptions?: AgentConfig['providerOptions']
}): Agent {
	return new Agent({
		model: opts.model,
		tools: opts.tools,
		system: opts.system,
		hooks: opts.hooks,
		stopWhen: opts.stopWhen,
		providerOptions: opts.providerOptions,
	})
}

export async function createCodingSubagentTool(opts: CreateCodingSubagentToolOptions) {
	const baseHooks = createAgentFilesystemHooks({
		cwd: opts.cwd,
		outputTruncation: opts.outputTruncation,
		stripThinking: opts.stripThinking,
		deduplicateReads: opts.deduplicateReads,
		truncateOldBashResults: opts.truncateOldBashResults,
	})
	const hooks = mergeHooks(baseHooks, opts.hooks)
	const stopWhen = opts.stopWhen ?? [doomLoop(3)]
	const family = detectModelFamily(opts.model)
	const baseSystem =
		typeof opts.system === 'string'
			? [opts.system, ...(opts.systemPromptAdditions ?? [])]
			: opts.system
				? [...opts.system, ...(opts.systemPromptAdditions ?? [])]
				: await createAgentSystemPrompt({
						cwd: opts.cwd,
						model: opts.model,
						systemPromptAdditions: opts.systemPromptAdditions,
					})

	const skillTool = await resolveSkillTool(opts)
	const generalPurposeTools =
		family === 'codex'
			? await createCodexCodingAgentToolset({
					cwd: opts.cwd,
					skillTool,
					exaApiKey: opts.exaApiKey,
					additionalTools: opts.additionalTools,
					allowMissingSkills: opts.allowMissingSkills,
				})
			: await createClaudeCodingAgentToolset({
					cwd: opts.cwd,
					skillTool,
					exaApiKey: opts.exaApiKey,
					additionalTools: opts.additionalTools,
					allowMissingSkills: opts.allowMissingSkills,
				})

	const generalPurposeAgent = createChildAgent({
		model: opts.model,
		tools: generalPurposeTools,
		system: baseSystem,
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const bashAgent = createChildAgent({
		model: opts.model,
		tools: { bash: createBashTool({ cwd: opts.cwd }) },
		system: buildSystem(baseSystem, BASH_AGENT_PROMPT),
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const locatorAgent = createChildAgent({
		model: opts.model,
		tools: {
			glob: createGlobTool({ cwd: opts.cwd }),
			grep: createGrepTool({ cwd: opts.cwd }),
			list: createListTool({ cwd: opts.cwd }),
		},
		system: buildSystem(baseSystem, CODEBASE_LOCATOR_PROMPT),
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const analyzerAgent = createChildAgent({
		model: opts.model,
		tools: {
			read: createReadTool({ cwd: opts.cwd }),
			glob: createGlobTool({ cwd: opts.cwd }),
			grep: createGrepTool({ cwd: opts.cwd }),
			list: createListTool({ cwd: opts.cwd }),
		},
		system: buildSystem(baseSystem, CODEBASE_ANALYZER_PROMPT),
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const patternFinderAgent = createChildAgent({
		model: opts.model,
		tools: {
			read: createReadTool({ cwd: opts.cwd }),
			glob: createGlobTool({ cwd: opts.cwd }),
			grep: createGrepTool({ cwd: opts.cwd }),
			list: createListTool({ cwd: opts.cwd }),
		},
		system: buildSystem(baseSystem, CODEBASE_PATTERN_FINDER_PROMPT),
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const webResearcherTools: Record<string, Tool<any, any>> = {
		web_fetch: createWebFetchTool(),
		read: createReadTool({ cwd: opts.cwd }),
		glob: createGlobTool({ cwd: opts.cwd }),
		grep: createGrepTool({ cwd: opts.cwd }),
	}
	if (opts.exaApiKey) {
		webResearcherTools.web_search = createWebSearchTool({ exaApiKey: opts.exaApiKey })
	}
	const webResearcherAgent = createChildAgent({
		model: opts.model,
		tools: webResearcherTools,
		system: buildSystem(baseSystem, WEB_SEARCH_RESEARCHER_PROMPT),
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const agents: SubAgentConfig[] = [
		{
			name: 'general-purpose',
			description:
				'A general-purpose coding agent with broad capabilities that can handle most tasks, including coding, debugging, and research.',
			agent: generalPurposeAgent,
		},
		{
			name: 'bash',
			description: 'A specialized sub-agent for bash command execution. Delegate shell-heavy tasks here.',
			agent: bashAgent,
		},
		{
			name: 'codebase-locator',
			description: 'Locates files, directories, and components relevant to a task.',
			agent: locatorAgent,
		},
		{
			name: 'codebase-analyzer',
			description: 'Explains how code works with concrete file references.',
			agent: analyzerAgent,
		},
		{
			name: 'codebase-pattern-finder',
			description: 'Finds similar implementations and reusable patterns in the codebase.',
			agent: patternFinderAgent,
		},
		{
			name: 'web-search-researcher',
			description: 'Researches web sources for up-to-date technical information.',
			agent: webResearcherAgent,
		},
	]

	return createSubagentsTool({ agents, onChildEvent: opts.onChildEvent })
}
