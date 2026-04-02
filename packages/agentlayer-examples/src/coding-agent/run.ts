#!/usr/bin/env bun
import { startState, userMessage } from '@humanlayer/agentlayer'
import { renderFinish } from '@humanlayer/agentlayer/render'
import { Command } from 'commander'
import { type CodingAgentConfig, createCodingAgent } from './agent'
import { runInteractive } from './interactive'
import { DEFAULT_MODELS, type ProviderType } from './providers'
import { CodingRenderer } from './renderer'

const renderer = new CodingRenderer({ showResponse: false, toolLabelStyle: 'compact' })

const program = new Command()
	.name('coding-agent')
	.description('Multi-provider coding agent example')
	.option('-p, --provider <provider>', 'Provider: anthropic, openai', 'anthropic')
	.option('-m, --model <model>', 'Model ID (defaults per provider)')
	.option('--no-repo-instructions', 'Skip repository instructions discovered from current working directory')
	.option('--repo-instructions-file <path>', 'Include repository instructions from an explicit file path')
	.option('--prompt <prompt>', 'Run non-interactively with this prompt')
	.action(
		async (opts: {
			provider: string
			model?: string
			prompt?: string
			repoInstructions?: boolean
			repoInstructionsFile?: string
		}) => {
			const provider = opts.provider as ProviderType
			const config: CodingAgentConfig = {
				provider,
				model: opts.model,
				repoInstructions: opts.repoInstructions,
				repoInstructionsFile: opts.repoInstructionsFile,
			}
			const modelId = opts.model ?? DEFAULT_MODELS[provider]

			const agent = await createCodingAgent(config)

			console.log(`coding-agent — provider: ${provider}, model: ${modelId}`)
			console.log()

			if (opts.prompt) {
				const run = agent.run({ state: startState([userMessage(opts.prompt)]) })
				for await (const event of run) {
					renderer.handleEvent(event)
				}
				const result = await run.result
				renderFinish(result)
				process.exit(result.finishReason === 'error' ? 1 : 0)
			} else {
				runInteractive(agent, undefined, renderer)
			}
		},
	)

program.parse()
