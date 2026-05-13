import type { LanguageModel } from 'ai'
import { Agent, createSubagentsTool, doomLoop, TodoWriteTool, type AgentConfig, type Tool } from '@humanlayer/agentlayer-core'
import { createWebFetchTool } from '@humanlayer/agentlayer-core'
import type { CodeSearchInput } from '@humanlayer/agentlayer-core/interfaces'
import { CodeSearchTool } from '@humanlayer/agentlayer-core/interfaces'
import type { SubAgentConfig } from '@humanlayer/agentlayer-core'
import {
	createAgentFilesystemHooks,
	createAgentSystemPrompt,
	createBashTool,
	createClaudeCodingAgentToolset,
	createCodexCodingAgentToolset,
	createGlobTool,
	createGrepTool,
	createListTool,
	createReadTool,
	detectModelFamily,
	type CreateAgentFilesystemHooksOptions,
	type CreateCodingAgentAuxToolsetOptions,
} from '@humanlayer/agentlayer-filesystem'
import { saneDefaultOutputTruncationHooks } from '@humanlayer/agentlayer-filesystem/hooks'
import { createWebSearchTool } from '@humanlayer/agentlayer-filesystem/tools'
import {
	createBashSpecialistAgent,
	createCodebaseAnalyzerAgent,
	createCodebaseLocatorAgent,
	createCodebasePatternFinderAgent,
	createImplementerAgent,
	createLibraryResearcherAgent,
	createOutlineImplementerAgent,
	createWebSearchResearcherAgent,
	OUTLINE_IMPLEMENTER_AGENT_DESCRIPTION,
	OUTLINE_IMPLEMENTER_AGENT_NAME,
} from './rpi-agents'

const DEFAULT_CODE_SEARCH_TIMEOUT_MS = 30_000
const EXA_CONTEXT_ENDPOINT = 'https://api.exa.ai/context'
const CONTEXT7_BASE_URL = 'https://context7.com'

export interface CreateCodingSubagentToolOptions
	extends CreateAgentFilesystemHooksOptions,
		CreateCodingAgentAuxToolsetOptions {
	model: LanguageModel
	system?: string | string[]
	systemPromptAdditions?: string[]
	includeEnvironment?: boolean
	date?: Date
	platform?: string
	hooks?: AgentConfig['hooks']
	stopWhen?: AgentConfig['stopWhen']
	providerOptions?: AgentConfig['providerOptions']
}

async function fetchExaCodeSearch(input: CodeSearchInput, apiKey: string, timeoutMs: number): Promise<string | null> {
	try {
		const query = `${input.query} -- for ${input.packageName} in ${input.language}`
		const response = await fetch(EXA_CONTEXT_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
			},
			body: JSON.stringify({ query, tokensNum: 5000 }),
			signal: AbortSignal.timeout(timeoutMs),
		})

		if (!response.ok) return null
		const data = (await response.json()) as { response?: string }
		return data.response ?? null
	} catch {
		return null
	}
}

async function fetchContext7CodeSearch(
	input: CodeSearchInput,
	apiKey: string,
	timeoutMs: number,
): Promise<string | null> {
	try {
		const searchUrl = new URL(`${CONTEXT7_BASE_URL}/api/v2/libs/search`)
		searchUrl.searchParams.set('query', input.query)
		searchUrl.searchParams.set('libraryName', input.packageName)

		const searchResponse = await fetch(searchUrl, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!searchResponse.ok) return null

		const searchData = (await searchResponse.json()) as {
			results?: Array<{ id: string; trustScore?: number }>
		}
		const libraries = searchData.results ?? []
		if (libraries.length === 0) return null

		const best = libraries.reduce((a, b) => ((b.trustScore ?? 0) > (a.trustScore ?? 0) ? b : a))

		const contextUrl = new URL(`${CONTEXT7_BASE_URL}/api/v2/context`)
		contextUrl.searchParams.set('query', input.query)
		contextUrl.searchParams.set('libraryId', best.id)

		const contextResponse = await fetch(contextUrl, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!contextResponse.ok) return null

		return await contextResponse.text()
	} catch {
		return null
	}
}

function createCodeSearchTool(opts: {
	exaApiKey?: string
	context7ApiKey?: string
	timeoutMs?: number
}): Tool<CodeSearchInput, string> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_CODE_SEARCH_TIMEOUT_MS

	return CodeSearchTool.define(
		async (input) => {
			const [exaResult, context7Result] = await Promise.all([
				opts.exaApiKey ? fetchExaCodeSearch(input, opts.exaApiKey, timeoutMs) : Promise.resolve(null),
				opts.context7ApiKey
					? fetchContext7CodeSearch(input, opts.context7ApiKey, timeoutMs)
					: Promise.resolve(null),
			])

			const parts: string[] = []
			if (context7Result) parts.push(`## Context7 Documentation\n\n${context7Result}`)
			if (exaResult) parts.push(`## Exa Search Results\n\n${exaResult}`)

			if (parts.length === 0) {
				return `No documentation found for "${input.packageName}" with query: ${input.query}`
			}

			return parts.join('\n\n---\n\n')
		},
		{ description: 'Search library documentation and code examples using Context7 and Exa when available.' },
	)
}

function mergeHooks(
	base: ReturnType<typeof createAgentFilesystemHooks>,
	hooks?: AgentConfig['hooks'],
): AgentConfig['hooks'] {
	const fileStatePostHooks = base.postToolUse.filter((hook) => !saneDefaultOutputTruncationHooks.includes(hook))

	return {
		approval: hooks?.approval,
		preToolUse: [...base.preToolUse, ...(hooks?.preToolUse ?? [])],
		postToolUse: [...saneDefaultOutputTruncationHooks, ...fileStatePostHooks, ...(hooks?.postToolUse ?? [])],
		preRequest: [...base.preRequest, ...(hooks?.preRequest ?? [])],
	}
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
						includeEnvironment: opts.includeEnvironment,
						date: opts.date,
						platform: opts.platform,
						systemPromptAdditions: opts.systemPromptAdditions,
					})

	const skillTool = opts.skillTool
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

	const bashAgent = createBashSpecialistAgent({
		model: opts.model,
		tools: { bash: createBashTool({ cwd: opts.cwd }) },
		system: baseSystem,
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const implementerTools: Record<string, Tool<any, any>> = family === 'codex'
		? {
				...(await createCodexCodingAgentToolset({
					cwd: opts.cwd,
					skillTool,
					exaApiKey: opts.exaApiKey,
					additionalTools: opts.additionalTools,
					allowMissingSkills: opts.allowMissingSkills,
				})),
				todo_write: TodoWriteTool,
			}
		: {
				...(await createClaudeCodingAgentToolset({
					cwd: opts.cwd,
					skillTool,
					exaApiKey: opts.exaApiKey,
					additionalTools: opts.additionalTools,
					allowMissingSkills: opts.allowMissingSkills,
				})),
				todo_write: TodoWriteTool,
			}

	const implementerAgent = createImplementerAgent({
		model: opts.model,
		tools: implementerTools,
		system: baseSystem,
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})
	const outlineImplementerAgent = createOutlineImplementerAgent({
		model: opts.model,
		tools: implementerTools,
		system: baseSystem,
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
	if (opts.exaApiKey) webResearcherTools.web_search = createWebSearchTool({ exaApiKey: opts.exaApiKey })
	const webResearcherAgent = createWebSearchResearcherAgent({
		model: opts.model,
		tools: webResearcherTools,
		system: baseSystem,
		hooks,
		stopWhen,
		providerOptions: opts.providerOptions,
	})

	const libraryResearcherTools: Record<string, Tool<any, any>> = {
		web_fetch: createWebFetchTool(),
	}
	if (opts.exaApiKey || opts.context7ApiKey) {
		libraryResearcherTools.codesearch = createCodeSearchTool({
			exaApiKey: opts.exaApiKey,
			context7ApiKey: opts.context7ApiKey,
		})
	}
	if (opts.exaApiKey) libraryResearcherTools.web_search = createWebSearchTool({ exaApiKey: opts.exaApiKey })
	const libraryResearcherAgent =
		opts.exaApiKey || opts.context7ApiKey
			? createLibraryResearcherAgent({
					model: opts.model,
					tools: libraryResearcherTools,
					system: baseSystem,
					hooks,
					stopWhen,
					providerOptions: opts.providerOptions,
				})
			: undefined

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
			name: 'implementer-agent',
			description:
				'Implements approved plans phase by phase with code changes, verification, and todo tracking. Use when an RPI skill asks for an implementer agent.',
			agent: implementerAgent,
		},
		{
			name: OUTLINE_IMPLEMENTER_AGENT_NAME,
			description: OUTLINE_IMPLEMENTER_AGENT_DESCRIPTION,
			agent: outlineImplementerAgent,
		},
		{
			name: 'codebase-locator',
			description: 'Locates files, directories, and components relevant to a task.',
			agent: createCodebaseLocatorAgent({
				model: opts.model,
				tools: {
					glob: createGlobTool({ cwd: opts.cwd }),
					grep: createGrepTool({ cwd: opts.cwd }),
					list: createListTool({ cwd: opts.cwd }),
				},
				system: baseSystem,
				hooks,
				stopWhen,
				providerOptions: opts.providerOptions,
			}),
		},
		{
			name: 'codebase-analyzer',
			description: 'Explains how code works with concrete file references.',
			agent: createCodebaseAnalyzerAgent({
				model: opts.model,
				tools: {
					read: createReadTool({ cwd: opts.cwd }),
					glob: createGlobTool({ cwd: opts.cwd }),
					grep: createGrepTool({ cwd: opts.cwd }),
					list: createListTool({ cwd: opts.cwd }),
				},
				system: baseSystem,
				hooks,
				stopWhen,
				providerOptions: opts.providerOptions,
			}),
		},
		{
			name: 'codebase-pattern-finder',
			description: 'Finds similar implementations and reusable patterns in the codebase.',
			agent: createCodebasePatternFinderAgent({
				model: opts.model,
				tools: {
					read: createReadTool({ cwd: opts.cwd }),
					glob: createGlobTool({ cwd: opts.cwd }),
					grep: createGrepTool({ cwd: opts.cwd }),
					list: createListTool({ cwd: opts.cwd }),
				},
				system: baseSystem,
				hooks,
				stopWhen,
				providerOptions: opts.providerOptions,
			}),
		},
		{
			name: 'web-search-researcher',
			description: 'Researches web sources for up-to-date technical information.',
			agent: webResearcherAgent,
		},
	]

	if (libraryResearcherAgent) {
		agents.push({
			name: 'library-researcher',
			description: 'Researches library and package documentation with code and docs search.',
			agent: libraryResearcherAgent,
		})
	}

	const tool = createSubagentsTool({ agents, onChildEvent: opts.onChildEvent })
	return Object.assign(tool, { subagents: agents })
}
