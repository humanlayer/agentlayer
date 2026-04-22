import readline from 'node:readline'
import type { Agent, AgentState, OutputRenderer } from '@humanlayer/agentlayer-core'
import { createOutputRenderer, renderFinish, startState } from '@humanlayer/agentlayer-core'

export interface InteractiveOptions {
	prompt?: string
	state?: AgentState
	input?: NodeJS.ReadableStream
	output?: NodeJS.WritableStream
	exit?: (code: number) => void
}

export function runInteractive(
	agent: Agent,
	options?: InteractiveOptions,
	renderer: OutputRenderer = createOutputRenderer({
		writeLine: (line) => (options?.output ?? process.stdout).write(`${line}\n`),
	}),
): Promise<void> {
	const prompt = options?.prompt ?? '> '
	const input = options?.input ?? process.stdin
	const output = options?.output ?? process.stdout
	const exit = options?.exit ?? ((code: number) => process.exit(code))
	let state: AgentState = options?.state ?? startState([])
	let currentAbortController: AbortController | null = null
	let shouldExit = false
	const rl = readline.createInterface({ input, output })

	rl.on('SIGINT', () => {
		if (currentAbortController) {
			currentAbortController.abort()
		} else {
			rl.close()
			exit(0)
		}
	})

	output.write(prompt)

	const loop = async () => {
		try {
			for await (const line of rl) {
			if (shouldExit) {
				break
			}

			const text = line.trim()
			if (!text) {
				output.write(prompt)
				continue
			}
			if (text === 'exit' || text === '/exit') {
				shouldExit = true
				rl.close()
				exit(0)
				break
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
			output.write(prompt)
			}
		} finally {
			rl.close()
		}
	}

	return loop()
}
