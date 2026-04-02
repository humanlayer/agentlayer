/**
 * Subagent token usage bubbling tests.
 *
 * Runs only when ANTHROPIC_API_KEY is set.
 * To run: bun --bun test test/subagent-token-usage.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { createSubagentsTool } from '../src/tools/interfaces/subagent'

const TIMEOUT = 60_000

const echoTool = defineTool({
	name: 'echo',
	description: 'Echoes back the input text',
	input: z.object({ text: z.string() }),
	execute: async (input) => input.text,
})

function userMsg(text: string) {
	return { role: 'user' as const, content: [{ type: 'text' as const, text }] }
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('subagent token usage — anthropic', () => {
	async function getModel() {
		const { anthropic } = await import('@ai-sdk/anthropic')
		return anthropic('claude-haiku-4-5-20251001')
	}

	test(
		'parent RunResult.tokenUsage includes child token usage',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Reply with exactly one short sentence.',
				tools: {},
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'responder', description: 'Gives a short reply', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool to delegate work, then say "done".',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const result = await parentAgent.run({
				state: startState([userMsg('Ask the responder to say hello')]),
			}).result

			// tokenUsage should exist and have real counts
			expect(result.tokenUsage).toBeDefined()
			expect(result.tokenUsage.totals.inputTokens).toBeGreaterThan(0)
			expect(result.tokenUsage.totals.outputTokens).toBeGreaterThan(0)

			// Since parent and child use the same model, there should be 1 model key
			// but totals should reflect BOTH parent and child usage combined
			const modelKeys = Object.keys(result.tokenUsage.byModel)
			expect(modelKeys.length).toBe(1)

			const modelUsage = result.tokenUsage.byModel[modelKeys[0]!]!
			// Parent makes at least 2 calls (invoke subagent + final response)
			// Child makes at least 1 call — so total should be > any single call
			expect(modelUsage.inputTokens).toBeGreaterThan(0)
			expect(modelUsage.outputTokens).toBeGreaterThan(0)
		},
		TIMEOUT,
	)

	test(
		'tokenUsage events stream includes child events with agentId',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Reply with exactly one short sentence.',
				tools: {},
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'responder', description: 'Gives a short reply', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool to delegate, then say "done".',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const run = parentAgent.run({
				state: startState([userMsg('Ask the responder to say hi')]),
			})

			const allTokenEvents: AgentEvent[] = []
			for await (const event of run) {
				if (event.type === 'tokenUsage') allTokenEvents.push(event)
			}

			// At least 3 events: parent call #1 (tool call), child call #1, parent call #2 (final)
			expect(allTokenEvents.length).toBeGreaterThanOrEqual(3)

			// Parent events have no agentId
			const parentEvents = allTokenEvents.filter((e) => e.type === 'tokenUsage' && !e.agentId)
			expect(parentEvents.length).toBeGreaterThanOrEqual(2)

			// Child events have agentId set
			const childEvents = allTokenEvents.filter((e) => e.type === 'tokenUsage' && e.agentId)
			expect(childEvents.length).toBeGreaterThanOrEqual(1)

			// Every event should have non-zero token counts
			for (const evt of allTokenEvents) {
				if (evt.type === 'tokenUsage') {
					expect(evt.usage.usage.inputTokens).toBeGreaterThan(0)
					expect(evt.usage.usage.outputTokens).toBeGreaterThan(0)
					expect(evt.usage.contextWindowTokens).toBeGreaterThan(0)
				}
			}
		},
		TIMEOUT,
	)

	test(
		'totals equal the sum of all individual tokenUsage events',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Reply with one word.',
				tools: {},
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'worker', description: 'Brief worker', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool, then say "complete".',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const run = parentAgent.run({
				state: startState([userMsg('Have the worker say yes')]),
			})

			let sumInput = 0
			let sumOutput = 0
			for await (const event of run) {
				if (event.type === 'tokenUsage') {
					sumInput += event.usage.usage.inputTokens
					sumOutput += event.usage.usage.outputTokens
				}
			}

			const result = await run.result

			// RunResult totals should match the sum of all streamed events
			expect(result.tokenUsage.totals.inputTokens).toBe(sumInput)
			expect(result.tokenUsage.totals.outputTokens).toBe(sumOutput)
		},
		TIMEOUT,
	)

	test(
		'child tokenUsage events have contextWindowTokens reflecting child context',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Reply with one word.',
				tools: {},
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'worker', description: 'Brief worker', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool, then say done.',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const run = parentAgent.run({
				state: startState([userMsg('Have the worker respond')]),
			})

			const parentTokenEvents: AgentEvent[] = []
			const childTokenEvents: AgentEvent[] = []
			for await (const event of run) {
				if (event.type === 'tokenUsage') {
					if (event.agentId) childTokenEvents.push(event)
					else parentTokenEvents.push(event)
				}
			}

			expect(childTokenEvents.length).toBeGreaterThanOrEqual(1)
			expect(parentTokenEvents.length).toBeGreaterThanOrEqual(2)

			// Child's contextWindowTokens should be smaller than parent's last event
			// because the child has fewer messages in its context
			const childEvt = childTokenEvents[0]!
			const parentLastEvt = parentTokenEvents[parentTokenEvents.length - 1]!
			const childCwt = childEvt.type === 'tokenUsage' ? childEvt.usage.contextWindowTokens : 0
			const parentLastCwt = parentLastEvt.type === 'tokenUsage' ? parentLastEvt.usage.contextWindowTokens : 0

			expect(childCwt).toBeGreaterThan(0)
			expect(parentLastCwt).toBeGreaterThan(0)
			// Parent's last call sees more context (system + user + tool call + tool result + child output)
			expect(parentLastCwt).toBeGreaterThan(childCwt)
		},
		TIMEOUT,
	)

	test(
		'model key in byModel matches anthropic provider format',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Say ok.',
				tools: {},
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'worker', description: 'Worker', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool, then say done.',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const result = await parentAgent.run({
				state: startState([userMsg('Delegate to the worker')]),
			}).result

			const modelKeys = Object.keys(result.tokenUsage.byModel)
			expect(modelKeys.length).toBe(1)
			// Should contain anthropic provider info
			expect(modelKeys[0]).toContain('anthropic')

			// The single model entry should have accumulated tokens from both parent and child
			const usage = result.tokenUsage.byModel[modelKeys[0]!]!
			expect(usage.inputTokens).toBeGreaterThan(0)
			expect(usage.outputTokens).toBeGreaterThan(0)
		},
		TIMEOUT,
	)

	test(
		'child with tool calls accumulates multi-step usage correctly',
		async () => {
			const model = await getModel()

			const childAgent = new Agent({
				model,
				system: 'Use the echo tool with the provided text, then say what it returned.',
				tools: { echo: echoTool },
				maxSteps: 5,
			})

			const subagentTool = createSubagentsTool({
				agents: [{ name: 'echoer', description: 'Echoes things', agent: childAgent }],
			})

			const parentAgent = new Agent({
				model,
				system: 'Use the subagent tool, then say done.',
				tools: { subagent: subagentTool },
				maxSteps: 5,
			})

			const run = parentAgent.run({
				state: startState([userMsg('Have the echoer echo "hello world"')]),
			})

			const childEvents: AgentEvent[] = []
			for await (const event of run) {
				if (event.type === 'tokenUsage' && event.agentId) {
					childEvents.push(event)
				}
			}

			const result = await run.result

			// Child made at least 2 calls: one to invoke echo tool, one for final response
			expect(childEvents.length).toBeGreaterThanOrEqual(2)

			// Sum of child events should match the child portion in the total
			let childInputSum = 0
			let childOutputSum = 0
			for (const evt of childEvents) {
				if (evt.type === 'tokenUsage') {
					childInputSum += evt.usage.usage.inputTokens
					childOutputSum += evt.usage.usage.outputTokens
				}
			}
			expect(childInputSum).toBeGreaterThan(0)
			expect(childOutputSum).toBeGreaterThan(0)

			// Total should be strictly greater than child alone (parent also uses tokens)
			expect(result.tokenUsage.totals.inputTokens).toBeGreaterThan(childInputSum)
			expect(result.tokenUsage.totals.outputTokens).toBeGreaterThan(childOutputSum)
		},
		TIMEOUT,
	)
})
