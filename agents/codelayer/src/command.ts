import { Command } from 'commander'
import { createOutputRenderer, extractLastAssistantText, renderFinish, startState } from '@humanlayer/agentlayer-core'
import { createSkillToolFromRepoDirs } from '@humanlayer/agentlayer-filesystem/tools'
import { createCodelayerAgent } from './agent'
import { DEFAULT_MODELS, type ProviderType, resolveExaApiKey, resolveModel } from './providers'
import { runInteractive } from './util/interactive'

export interface CodelayerCliOptions {
	provider: string
	model?: string
	prompt?: string
	rlm?: boolean
	verbose?: boolean
}

export function createCodelayerCommand(): Command {
	return new Command('codelayer')
		.description('Multi-provider coding agent')
		.option('-p, --provider <provider>', 'Provider: anthropic, openai, codex', 'anthropic')
		.option('-m, --model <model>', 'Model ID (defaults per provider)')
		.option('--rlm', 'Run in RLM mode with subagent orchestration')
		.option('--prompt <prompt>', 'Run non-interactively with this prompt')
		.option('--verbose', 'Show full tool results in CLI output')
		.action(async (opts: CodelayerCliOptions) => {
			const renderer = createOutputRenderer({
				writeLine: (line) => console.log(line),
				includeTokenUsage: opts.verbose,
			})
			const provider = opts.provider as ProviderType
			const modelId = opts.model ?? DEFAULT_MODELS[provider]
			const model = await resolveModel(provider, modelId)
			const exaApiKey = resolveExaApiKey()
			const skillTool = await createSkillToolFromRepoDirs({ cwd: process.cwd(), allowMissing: true })
			const agent = await createCodelayerAgent({
				model,
				cwd: process.cwd(),
				rlm: opts.rlm,
				exaApiKey,
				skillTool,
				onToolProgress: renderer.onToolProgress,
			})

			console.log(`codelayer - provider: ${provider}, model: ${modelId}${opts.rlm ? ' (RLM mode)' : ''}`)
			console.log()

			if (opts.prompt) {
				const run = agent.run({ state: startState([{ role: 'user', content: opts.prompt }]) })
				for await (const event of run) {
					renderer.onEvent(event)
				}
				const result = await run.result
				renderer.flush()
				const finalText = extractLastAssistantText(result).trim()
				console.log(`__CODELAYER_FINAL_MESSAGE_START__${finalText}__CODELAYER_FINAL_MESSAGE_END__`)
				renderFinish(result)
				process.exit(result.finishReason === 'error' ? 1 : 0)
			}

			void runInteractive(agent, undefined, renderer)
		})
}
