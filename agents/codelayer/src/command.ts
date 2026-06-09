import { Command } from 'commander'
import { createOutputRenderer, extractLastAssistantText, renderFinish, startState } from '@humanlayer/agentlayer-core'
import { createSkillToolFromRepoDirs } from '@humanlayer/agentlayer-filesystem/tools'
import { createCodelayerAgent } from './agent'
import type { CodelayerProviderOptionOverrides } from './agent'
import { DEFAULT_MODELS, type ProviderType, resolveExaApiKey, resolveModel } from './providers'
import { createCliCodexDiagnostics } from './util/codex-diagnostics'
import { runInteractive } from './util/interactive'

export interface CodelayerCliOptions {
	provider: string
	model?: string
	prompt?: string
	thinking?: string
	subagentThinking?: string
	rlm?: boolean
	rpi?: boolean
	tars?: boolean
	stream?: boolean
	verbose?: boolean
	providerOption?: string[]
}

function coerceProviderOptionValue(value: string): string | number | boolean | null {
	if (value === 'true') return true
	if (value === 'false') return false
	if (value === 'null') return null
	const numberValue = Number(value)
	return value.trim() !== '' && Number.isFinite(numberValue) ? numberValue : value
}

export function parseProviderOptionOverrides(values: string[] = []): CodelayerProviderOptionOverrides {
	const overrides: CodelayerProviderOptionOverrides = {}
	for (const entry of values) {
		const [rawKey, ...rawValueParts] = entry.split('=')
		const valueText = rawValueParts.join('=')
		if (!rawKey || valueText === '') throw new Error(`Invalid provider option "${entry}". Use key=value.`)
		const parts = rawKey.split('.')
		const provider = parts.length === 2 ? parts[0] : undefined
		const key = parts.length === 2 ? parts[1] : parts[0]
		const value = coerceProviderOptionValue(valueText)

		if (provider === 'anthropic') {
			overrides.anthropic = { ...(overrides.anthropic ?? {}), [key!]: value }
		} else if (
			provider === 'codex' ||
			provider === 'openai' ||
			provider === 'firepass' ||
			key === 'fastMode' ||
			key === 'serviceTier'
		) {
			overrides.codex = { ...(overrides.codex ?? {}), [key!]: value }
		} else if (provider === 'copilot') {
			overrides.copilot = { ...(overrides.copilot ?? {}), [key!]: value }
		} else if (key === 'reasoningEffort' || key === 'reasoningSummary') {
			overrides.codex = { ...(overrides.codex ?? {}), [key]: value }
			overrides.copilot = { ...(overrides.copilot ?? {}), [key]: value }
		} else if (key === 'thinking' || key === 'budgetTokens' || key === 'effort') {
			overrides.anthropic = { ...(overrides.anthropic ?? {}), [key]: value }
		} else {
			throw new Error(`Unknown provider option "${rawKey}".`)
		}
	}
	return overrides
}

function assertThinkingValue(args: { provider: ProviderType; modelId: string; thinking: string }) {
	const modelId = args.modelId.toLowerCase()
	const supported = (values: string[]) => {
		if (!values.includes(args.thinking)) {
			throw new Error(
				`Unsupported --thinking value "${args.thinking}" for ${args.provider}/${args.modelId}. Supported values: ${values.join(', ')}.`,
			)
		}
	}

	if (args.provider === 'codex' && modelId.includes('gpt-5.5')) {
		supported(['low', 'medium', 'high', 'xhigh'])
		return
	}

	if (args.provider !== 'anthropic') return

	if (modelId.includes('fable-5')) {
		supported(['low', 'medium', 'high', 'xhigh', 'max'])
	} else if (modelId.includes('opus') && (modelId.includes('4-8') || modelId.includes('4.8'))) {
		supported(['low', 'medium', 'high', 'xhigh', 'max'])
	} else if (modelId.includes('opus') && (modelId.includes('4-7') || modelId.includes('4.7'))) {
		supported(['low', 'medium', 'high', 'xhigh', 'max'])
	} else if (modelId.includes('opus') && (modelId.includes('4-6') || modelId.includes('4.6'))) {
		supported(['low', 'medium', 'high', 'max'])
	} else if (modelId.includes('sonnet') && (modelId.includes('4-6') || modelId.includes('4.6'))) {
		supported(['low', 'medium', 'high'])
	}
}

export function applyCliThinkingOverride(args: {
	provider: ProviderType
	modelId: string
	thinking: string | undefined
	overrides: CodelayerProviderOptionOverrides
}): CodelayerProviderOptionOverrides {
	if (args.provider !== 'anthropic' && args.provider !== 'codex' && args.provider !== 'firepass') {
		return args.overrides
	}

	const thinking = args.thinking ?? 'medium'
	assertThinkingValue({ provider: args.provider, modelId: args.modelId, thinking })

	if (args.provider === 'anthropic') {
		return {
			...args.overrides,
			anthropic: {
				...(args.overrides.anthropic ?? {}),
				...(args.overrides.anthropic?.effort ? {} : { effort: thinking }),
			},
		}
	}

	return {
		...args.overrides,
		codex: {
			...(args.overrides.codex ?? {}),
			...(args.overrides.codex?.reasoningEffort ? {} : { reasoningEffort: thinking }),
		},
	}
}

export function createCodelayerCommand(): Command {
	return new Command('codelayer')
		.description('Multi-provider coding agent')
		.addHelpText(
			'after',
			`
Auth:
  Codex and Copilot use AgentLayer file auth with Agent SDK compatibility import.
  Existing credentials from ~/.humanlayer/agent-sdk/auth.json are imported into the new auth file when it does not exist yet.

Provider options:
  --thinking medium
  --thinking high
  --subagent-thinking low
  --provider-option reasoningEffort=high
  --provider-option reasoningSummary=detailed
  --provider-option fastMode=true
  --provider-option serviceTier=priority
  --provider-option codex.reasoningEffort=xhigh
  --provider-option anthropic.thinking=enabled
  --provider-option anthropic.effort=max
  --provider-option anthropic.budgetTokens=10000`,
		)
		.option('-p, --provider <provider>', 'Provider: anthropic, openai, codex, copilot, firepass', 'anthropic')
		.option('-m, --model <model>', 'Model ID (defaults per provider)')
		.option('--thinking <value>', 'Reasoning/thinking effort for supported providers (default: medium)')
		.option('--subagent-thinking <value>', 'Reasoning/thinking effort for delegated sub-agents (default: low)', 'low')
		.option('--rlm', 'Run in RLM mode with subagent orchestration')
		.option('--rpi', 'Enable RPI-style specialist subagents')
		.option('--tars', 'Add the TARS persona prompt to the agent')
		.option('--stream', 'Stream raw tool arg chunks live instead of buffered compact args')
		.option('--prompt <prompt>', 'Run non-interactively with this prompt')
		.option('--provider-option <key=value>', 'Provider option override; repeatable', (value, previous: string[] = []) => [...previous, value], [])
		.option('--verbose', 'Show full tool results in CLI output')
		.action(async (opts: CodelayerCliOptions) => {
			const renderer = createOutputRenderer({
				output: process.stdout,
				includeTokenUsage: opts.verbose,
				streamToolArgs: opts.stream,
			})
			const provider = opts.provider as ProviderType
			const modelId = opts.model ?? DEFAULT_MODELS[provider]
			const model = await resolveModel(
				provider,
				modelId,
				provider === 'codex'
					? { codexDiagnostics: createCliCodexDiagnostics({ model: modelId, verbose: opts.verbose }) }
					: undefined,
			)
			const providerOptionOverrides = applyCliThinkingOverride({
				provider,
				modelId,
				thinking: opts.thinking,
				overrides: parseProviderOptionOverrides(opts.providerOption),
			})
			const subagentThinking = opts.subagentThinking ?? 'low'
			assertThinkingValue({ provider, modelId, thinking: subagentThinking })
			const exaApiKey = resolveExaApiKey()
			const skillTool = await createSkillToolFromRepoDirs({ cwd: process.cwd(), allowMissing: true })
			const agent = await createCodelayerAgent({
				model,
				cwd: process.cwd(),
				rlm: opts.rlm,
				rpi: opts.rpi,
				tars: opts.tars,
				exaApiKey,
				skillTool,
				providerOptionOverrides,
				subagentThinking,
			})

			console.log(`codelayer - provider: ${provider}, model: ${modelId}${opts.rlm ? ' (RLM mode)' : ''}${opts.rpi ? ' +rpi' : ''}${opts.tars ? ' +tars' : ''}`)
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

			await runInteractive(agent, undefined, renderer)
		})
}
