import readline from 'node:readline/promises'
import type { Agent, AgentState, OutputRenderer } from '@humanlayer/agentlayer-core'
import { createOutputRenderer, renderFinish, startState } from '@humanlayer/agentlayer-core'

export interface InteractiveOptions {
	prompt?: string
	state?: AgentState
	input?: NodeJS.ReadableStream
	output?: NodeJS.WritableStream
	exit?: (code: number) => void
}

export async function runInteractive(
	agent: Agent,
	options?: InteractiveOptions,
	renderer: OutputRenderer = createOutputRenderer({
		output: options?.output ?? process.stdout,
	}),
): Promise<void> {
	const prompt = options?.prompt ?? '> '
	const input = options?.input ?? process.stdin
	const output = options?.output ?? process.stdout
	const exit = options?.exit ?? ((code: number) => process.exit(code))
	let state: AgentState = options?.state ?? startState([])
	let currentAbortController: AbortController | null = null
	const rl = readline.createInterface({ input, output })

	rl.on('SIGINT', () => {
		if (currentAbortController) {
			currentAbortController.abort()
			return
		}
		rl.close()
		exit(0)
	})

	try {
		while (true) {
			const line = await rl.question(prompt)
			const text = line.trim()
			if (!text) continue
			if (text === 'exit' || text === '/exit') {
				rl.close()
				exit(0)
				return
			}

			state.messages.push({ role: 'user', content: text })
			currentAbortController = new AbortController()
			const run = agent.run({ state, signal: currentAbortController.signal, stream: true })

			for await (const event of run) {
				renderer.onEvent(event)
			}

			const result = await run.result
			currentAbortController = null
			state = result.state
			renderer.flush()
			renderFinish(result)
		}
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') return
		throw error
	} finally {
		rl.close()
	}
}
