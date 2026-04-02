import { Agent, createPreRequestHook, doomLoop } from '@humanlayer/agentlayer'
import { saneDefaultOutputTruncationHooks } from '@humanlayer/agentlayer/hooks'
import { claudePrompt, environmentPrompt, openaiPrompt, repoInstructionsPrompt } from '@humanlayer/agentlayer/prompts'
import {
	createBashTool,
	createEditTool,
	createGlobTool,
	createGrepTool,
	createListTool,
	createReadTool,
	createWebFetchTool,
	createWriteTool,
} from '@humanlayer/agentlayer/tools/server'
import { DEFAULT_MODELS, type ProviderType, resolveModel, resolveProviderOptions } from './providers'

export interface CodingAgentConfig {
	provider: ProviderType
	model?: string
	repoInstructions?: boolean
	repoInstructionsFile?: string
}

function resolvePrompt(provider: ProviderType): string {
	if (provider === 'openai') return openaiPrompt
	return claudePrompt
}

async function resolveRepoInstructionsBlock(config: CodingAgentConfig, cwd: string): Promise<string | undefined> {
	if (config.repoInstructions === false) return undefined

	return repoInstructionsPrompt({
		cwd,
		filePath: config.repoInstructionsFile,
		allowMissing: true,
	})
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`
}

function createTokenLoggingHook() {
	return createPreRequestHook((ctx) => {
		const payload = JSON.stringify(ctx.messages)
		const payloadBytes = new TextEncoder().encode(payload).length
		const usage =
			ctx.contextWindowLimit == null || ctx.contextWindowLimit === 0
				? `${ctx.contextWindowTokens}/unknown`
				: `${ctx.contextWindowTokens}/${ctx.contextWindowLimit} (${((ctx.contextWindowTokens / ctx.contextWindowLimit) * 100).toFixed(1)}%)`

		console.log(`\x1b[35m[coding-agent:tokens] context=${usage} messages=${ctx.messages.length} payload=${formatBytes(payloadBytes)}\x1b[0m`)

		return ctx.next()
	})
}

export async function createCodingAgent(config: CodingAgentConfig): Promise<Agent> {
	const cwd = process.cwd()
	const modelId = config.model ?? DEFAULT_MODELS[config.provider]
	const model = resolveModel(config.provider, modelId)
	const systemPrompt = resolvePrompt(config.provider)
	const repoInstructionsBlock = await resolveRepoInstructionsBlock(config, cwd)

	const tools = {
		bash: createBashTool({ cwd }),
		read: createReadTool(),
		write: createWriteTool(),
		edit: createEditTool(),
		list: createListTool({ cwd }),
		grep: createGrepTool({ cwd }),
		glob: createGlobTool({ cwd }),
		web_fetch: createWebFetchTool(),
	}

	return new Agent({
		model,
		tools,
		system: [
			systemPrompt,
			...(repoInstructionsBlock ? [repoInstructionsBlock] : []),
			environmentPrompt({ cwd }),
		],
		hooks: {
			preRequest: [createTokenLoggingHook()],
			postToolUse: saneDefaultOutputTruncationHooks,
		},
		providerOptions: resolveProviderOptions(config.provider, modelId) as any,
		stopWhen: [doomLoop(3)],
	})
}
