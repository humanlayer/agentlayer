import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { CODEX_CONTEXT_WINDOWS } from '../src/models'
import { assistantText, assistantWithToolCall, mockModel, mockStreamingModel, userMessage } from './mocks'

const mockUsage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output, reasoning: 0 },
})

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo',
	input: z.object({ text: z.string() }),
	execute: async (input) => input.text,
})

describe('token usage events', () => {
	test('emits resolved Codex contextWindowLimit when not configured', async () => {
		const agent = new Agent({
			model: {
				...mockModel([assistantText('Done.', { usage: mockUsage(1000, 500) })]),
				provider: 'codex',
				modelId: 'gpt-5.5',
			},
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		const tokenEvents: AgentEvent[] = []
		for await (const event of run) {
			if (event.type === 'tokenUsage') tokenEvents.push(event)
		}

		expect(tokenEvents).toHaveLength(1)
		expect(tokenEvents[0]!.type).toBe('tokenUsage')
		if (tokenEvents[0]!.type === 'tokenUsage') {
			expect(tokenEvents[0]!.usage.model).toBe('codex/gpt-5.5')
			expect(tokenEvents[0]!.usage.contextWindowLimit).toBe(CODEX_CONTEXT_WINDOWS['gpt-5.5'])
		}
	})

	test('emits tokenUsage event after each streamText call', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hi' }, { usage: mockUsage(1000, 500) }),
				assistantText('Done.', { usage: mockUsage(2000, 800) }),
			]),
			tools: { echo: echoTool },
			contextWindowLimit: 200_000,
		})

		const run = agent.run({ state: startState([userMessage('go')]) })
		const tokenEvents: AgentEvent[] = []
		for await (const event of run) {
			if (event.type === 'tokenUsage') tokenEvents.push(event)
		}

		expect(tokenEvents).toHaveLength(2)
		// First event from first streamText call
		expect(tokenEvents[0]!.type).toBe('tokenUsage')
		if (tokenEvents[0]!.type === 'tokenUsage') {
			expect(tokenEvents[0]!.usage.model).toBe('mock/mock-model')
			expect(tokenEvents[0]!.usage.usage.inputTokens).toBe(1000)
			expect(tokenEvents[0]!.usage.usage.outputTokens).toBe(500)
			expect(tokenEvents[0]!.usage.contextWindowTokens).toBe(1500)
			expect(tokenEvents[0]!.usage.contextWindowLimit).toBe(200_000)
		}

		expect(tokenEvents[1]!.type).toBe('tokenUsage')
		if (tokenEvents[1]!.type === 'tokenUsage') {
			expect(tokenEvents[1]!.usage.contextWindowTokens).toBe(2800)
			expect(tokenEvents[1]!.usage.contextWindowLimit).toBe(200_000)
		}
	})

	test('RunResult.tokenUsage accumulates across steps', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hi' }, { usage: mockUsage(1000, 500) }),
				assistantText('Done.', { usage: mockUsage(2000, 800) }),
			]),
			tools: { echo: echoTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.tokenUsage.totals.inputTokens).toBe(3000)
		expect(result.tokenUsage.totals.outputTokens).toBe(1300)
		expect(result.tokenUsage.byModel['mock/mock-model']).toBeDefined()
	})

	test('contextWindowTokens in state reflects last streamText call', async () => {
		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('echo', { text: 'hi' }, { usage: mockUsage(1000, 500) }),
				assistantText('Done.', { usage: mockUsage(2000, 800) }),
			]),
			tools: { echo: echoTool },
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		// contextWindowTokens = last call's inputTokens + outputTokens = 2000 + 800
		expect(result.state.contextWindowTokens).toBe(2800)
	})

	test('tokenUsage is present even with zero-usage mock', async () => {
		const agent = new Agent({
			model: mockModel([assistantText('Hi!')]),
			tools: {},
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		expect(result.tokenUsage).toBeDefined()
		expect(result.tokenUsage.totals.inputTokens).toBe(0)
	})

	test('streamText backend preserves token usage and final state when stream=false', async () => {
		const agent = new Agent({
			model: mockStreamingModel([
				assistantWithToolCall('echo', { text: 'hi' }, { usage: mockUsage(1000, 500) }),
				assistantText('Done.', { usage: mockUsage(2000, 800) }),
			]),
			tools: { echo: echoTool },
			contextWindowLimit: 200_000,
		})

		const run = agent.run({ state: startState([userMessage('go')]), stream: false })
		const tokenEvents: AgentEvent[] = []
		for await (const event of run) {
			if (event.type === 'tokenUsage') tokenEvents.push(event)
		}

		expect(tokenEvents).toHaveLength(2)
		const result = await run.result
		expect(result.tokenUsage.totals.inputTokens).toBe(3000)
		expect(result.tokenUsage.totals.outputTokens).toBe(1300)
		expect(result.state.contextWindowTokens).toBe(2800)
	})
})

// ─── Anthropic integration tests ──────────────────────────────────────────────

describe.skipIf(!process.env.ANTHROPIC_API_KEY || !!process.env.CI)('token usage — anthropic provider (haiku)', () => {
	const TIMEOUT = 30_000

	async function getModel() {
		const { anthropic } = await import('@ai-sdk/anthropic')
		return anthropic('claude-haiku-4-5-20251001')
	}

	test(
		'emits tokenUsage events with real token counts',
		async () => {
			const model = await getModel()
			const agent = new Agent({
				model,
				system: 'Reply with exactly one short sentence.',
				tools: {},
			})

			const run = agent.run({
				state: startState([{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }]),
			})
			const tokenEvents: AgentEvent[] = []
			for await (const event of run) {
				if (event.type === 'tokenUsage') tokenEvents.push(event)
			}

			expect(tokenEvents).toHaveLength(1)
			const evt = tokenEvents[0]!
			expect(evt.type).toBe('tokenUsage')
			if (evt.type === 'tokenUsage') {
				expect(evt.usage.model).toContain('anthropic')
				expect(evt.usage.usage.inputTokens).toBeGreaterThan(0)
				expect(evt.usage.usage.outputTokens).toBeGreaterThan(0)
				expect(evt.usage.contextWindowTokens).toBeGreaterThan(0)
			}
		},
		TIMEOUT,
	)

	test(
		'RunResult.tokenUsage has non-zero totals from real model',
		async () => {
			const model = await getModel()
			const agent = new Agent({
				model,
				system: 'Reply with exactly one short sentence.',
				tools: {},
			})

			const result = await agent.run({
				state: startState([{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }]),
			}).result
			expect(result.tokenUsage.totals.inputTokens).toBeGreaterThan(0)
			expect(result.tokenUsage.totals.outputTokens).toBeGreaterThan(0)
			expect(Object.keys(result.tokenUsage.byModel).length).toBe(1)

			const modelKey = Object.keys(result.tokenUsage.byModel)[0]!
			expect(modelKey).toContain('anthropic')
		},
		TIMEOUT,
	)

	test(
		'contextWindowTokens reflects real token count in state',
		async () => {
			const model = await getModel()
			const agent = new Agent({
				model,
				system: 'Reply with exactly one short sentence.',
				tools: {},
			})

			const result = await agent.run({
				state: startState([{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }]),
			}).result
			expect(result.state.contextWindowTokens).toBeGreaterThan(0)
		},
		TIMEOUT,
	)

	test(
		'accumulates across tool call + final response',
		async () => {
			const model = await getModel()
			const agent = new Agent({
				model,
				system: 'Use the echo tool then summarize.',
				tools: { echo: echoTool },
				maxSteps: 5,
			})

			const run = agent.run({
				state: startState([
					{ role: 'user', content: [{ type: 'text', text: 'Echo "test" and then say done' }] },
				]),
			})
			const tokenEvents: AgentEvent[] = []
			for await (const event of run) {
				if (event.type === 'tokenUsage') tokenEvents.push(event)
			}

			// Should have at least 2 events: one for tool call step, one for final response
			expect(tokenEvents.length).toBeGreaterThanOrEqual(2)

			const result = await run.result
			// Totals should be sum of all steps
			expect(result.tokenUsage.totals.inputTokens).toBeGreaterThan(0)
			expect(result.tokenUsage.totals.outputTokens).toBeGreaterThan(0)
			// Context window tokens should reflect the last call (which sees more tokens since conversation grew)
			expect(result.state.contextWindowTokens).toBeGreaterThan(0)
		},
		TIMEOUT,
	)
})
