import readline from 'node:readline'
import type { Agent, AgentState } from '@humanlayer/agentlayer-core'
import { Renderer, renderFinish, startState } from '@humanlayer/agentlayer-core'

export interface InteractiveOptions {
	prompt?: string
	state?: AgentState
}

export function runInteractive(agent: Agent, options?: InteractiveOptions, renderer: Renderer = new Renderer({ showResponse: false, toolLabelStyle: 'compact' })): void {
	const prompt = options?.prompt ?? '> '
	let state: AgentState = options?.state ?? startState([])
	let currentAbortController: AbortController | null = null
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

	rl.on('SIGINT', () => {
		if (currentAbortController) {
			currentAbortController.abort()
		} else {
			rl.close()
			process.exit(0)
		}
	})

	process.stdout.write(prompt)

	const loop = async () => {
		for await (const line of rl) {
			const text = line.trim()
			if (!text) {
				process.stdout.write(prompt)
				continue
			}
			if (text === 'exit' || text === '/exit') {
				rl.close()
				process.exit(0)
			}

			state.messages.push({ role: 'user', content: text })
			currentAbortController = new AbortController()
			const run = agent.run({ state, signal: currentAbortController.signal })

			for await (const event of run) {
				renderer.handleEvent(event)
			}

			const result = await run.result
			currentAbortController = null
			state = result.state
			renderFinish(result)
			process.stdout.write(prompt)
		}
	}

	void loop()
}
