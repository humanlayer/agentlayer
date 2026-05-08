#!/usr/bin/env bun
import readline from 'node:readline/promises'
import { YjsProvider } from '@durable-streams/y-durable-streams'
import { createOutputRenderer, extractLastAssistantText, renderFinish, startState } from '@humanlayer/agentlayer-core'
import type { Agent, AgentState } from '@humanlayer/agentlayer-core'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { RichMarkdownArtifactStore } from '../artifact-store'
import {
	createRichMarkdownCliAgent,
	createRichMarkdownCliAgentState,
	defaultRichMarkdownCliModel,
} from '../agents'

const DEFAULT_BASE_URL = 'https://localhost:4437/v1/yjs/rich-markdown'
const DEFAULT_DOC_ID = 'rich-artifacts-learning'

async function main() {
	const options = parseArgs(Bun.argv.slice(2))
	const prompt = options.prompt ?? options.positionals.join(' ').trim()
	if (!prompt && !options.interactive) {
		throw new Error('Usage: bun run rich-agent -- "your instruction" [--base-url URL] [--doc-id DOC_ID]')
	}

	const doc = new Y.Doc()
	const awareness = new Awareness(doc)
	const provider = new YjsProvider({
		doc,
		awareness,
		docId: options.docId ?? process.env.YJS_RICH_MARKDOWN_DOC_ID ?? DEFAULT_DOC_ID,
		baseUrl: options.baseUrl ?? process.env.YJS_RICH_MARKDOWN_BASE_URL ?? DEFAULT_BASE_URL,
		liveMode: 'long-poll',
		connect: false,
	})

	await provider.connect()
	await waitForSync(provider)

	const artifactStore = new RichMarkdownArtifactStore(doc)
	const agent = createRichMarkdownCliAgent({
		model: defaultRichMarkdownCliModel(),
		artifactStore,
	})
	const renderer = createOutputRenderer({
		output: process.stdout,
		includeTokenUsage: options.verbose,
		includeToolResults: options.verbose,
		streamToolArgs: options.streamToolArgs,
	})

	if (options.interactive) {
		await runInteractive(agent, prompt ? createRichMarkdownCliAgentState(prompt) : startState([]), renderer, {
			runInitialPrompt: !!prompt,
		})
		return
	}

	const run = agent.run({ state: createRichMarkdownCliAgentState(prompt), stream: true })
	for await (const event of run) {
		renderer.onEvent(event)
	}
	const result = await run.result
	renderer.flush()
	if (result.finishReason === 'error') {
		throw result.error ?? new Error('Rich markdown CLI agent failed')
	}
	const finalText = extractLastAssistantText(result).trim()
	if (finalText) console.log(`__RICH_MARKDOWN_AGENT_FINAL_MESSAGE_START__${finalText}__RICH_MARKDOWN_AGENT_FINAL_MESSAGE_END__`)
	renderFinish(result)
}

type CliOptions = {
	baseUrl?: string
	docId?: string
	prompt?: string
	interactive?: boolean
	streamToolArgs?: boolean
	verbose?: boolean
	positionals: string[]
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = { positionals: [] }
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === '--base-url') options.baseUrl = requiredValue(args, ++index, arg)
		else if (arg === '--doc-id') options.docId = requiredValue(args, ++index, arg)
		else if (arg === '--prompt') options.prompt = requiredValue(args, ++index, arg)
		else if (arg === '--interactive') options.interactive = true
		else if (arg === '--stream') options.streamToolArgs = true
		else if (arg === '--verbose') options.verbose = true
		else if (arg) options.positionals.push(arg)
	}
	return options
}

async function runInteractive(
	agent: Agent,
	initialState: AgentState,
	renderer: ReturnType<typeof createOutputRenderer>,
	options: { runInitialPrompt?: boolean } = {},
) {
	let state = initialState
	let currentAbortController: AbortController | null = null
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

	rl.on('SIGINT', () => {
		if (currentAbortController) {
			currentAbortController.abort()
			return
		}
		rl.close()
		process.exit(0)
	})

	try {
		if (options.runInitialPrompt) {
			const result = await runAgentTurn(agent, state, renderer)
			state = result.state
		}

		while (true) {
			const line = await rl.question('rich-markdown> ')
			const text = line.trim()
			if (!text) continue
			if (text === 'exit' || text === '/exit') return

			state.messages.push({ role: 'user', content: text })
			currentAbortController = new AbortController()
			const result = await runAgentTurn(agent, state, renderer, currentAbortController.signal)
			currentAbortController = null
			state = result.state
		}
	} finally {
		rl.close()
	}
}

async function runAgentTurn(
	agent: Agent,
	state: AgentState,
	renderer: ReturnType<typeof createOutputRenderer>,
	signal?: AbortSignal,
) {
	const run = agent.run({ state, signal, stream: true })
	for await (const event of run) renderer.onEvent(event)
	const result = await run.result
	renderer.flush()
	renderFinish(result)
	return result
}

function requiredValue(args: string[], index: number, flag: string) {
	const value = args[index]
	if (!value) throw new Error(`Missing value for ${flag}`)
	return value
}

async function waitForSync(provider: YjsProvider, timeoutMs = 10_000) {
	if (provider.synced) return
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			provider.off('synced', handleSynced)
			reject(new Error(`Timed out waiting for Yjs provider sync after ${timeoutMs}ms`))
		}, timeoutMs)

		const handleSynced = (synced: boolean) => {
			if (!synced) return
			clearTimeout(timeout)
			provider.off('synced', handleSynced)
			resolve()
		}

		provider.on('synced', handleSynced)
	})
}

await main()
