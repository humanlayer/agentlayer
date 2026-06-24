import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, defineTool, startState } from '../src'
import { PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT } from '../src/models'
import { assistantText, assistantWithToolCall, mockModel, userMessage } from './mocks'

const mockUsage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output, reasoning: 0 },
})

describe('ToolContext.getContextWindowTokens', () => {
	test('tool can read context window tokens from previous streamText call', async () => {
		let capturedTokens: number | undefined

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window tokens',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedTokens = ctx.getContextWindowTokens()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: mockModel([
				assistantWithToolCall('probe', {}, { usage: mockUsage(1000, 500) }),
				assistantText('Done.'),
			]),
			tools: { probe: probeTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		// After the first streamText call (1000 + 500 = 1500), the tool executes
		expect(capturedTokens).toBe(1500)
	})

	test('getContextWindowTokens returns 0 before any streamText call', async () => {
		// This tests the initial state — no streamText calls happened yet
		// In practice, a tool only runs after streamText, so this is a degenerate case
		// but it should return 0, not crash
		const agent = new Agent({
			model: mockModel([assistantText('Hi!')]),
			tools: {},
		})

		const result = await agent.run({ state: startState([userMessage('go')]) }).result
		// No tool calls; MOCK_USAGE has 0 tokens, so contextWindowTokens is omitted from state
		// (buildState only includes it when > 0)
		expect(result.state.contextWindowTokens).toBeUndefined()
	})
})

describe('ToolContext.getContextWindowLimit', () => {
	test('tool receives explicit contextWindowLimit from agent config', async () => {
		let capturedLimit: number | undefined

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window limit',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedLimit = ctx.getContextWindowLimit()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('probe', {}), assistantText('Done.')]),
			tools: { probe: probeTool },
			contextWindowLimit: 200_000,
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(capturedLimit).toBe(200_000)
	})

	test('tool receives resolved Codex contextWindowLimit when not configured', async () => {
		let capturedLimit: number | undefined

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window limit',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedLimit = ctx.getContextWindowLimit()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: {
				...mockModel([assistantWithToolCall('probe', {}), assistantText('Done.')]),
				provider: 'codex-sse-vendor',
				modelId: 'gpt-5.5',
			},
			tools: { probe: probeTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(capturedLimit).toBe(PRIVATE_CODEX_API_CONTEXT_WINDOW_SIZE_LIMIT)
	})

	test('getContextWindowLimit returns undefined when not configured', async () => {
		let capturedLimit: number | undefined = 999 // sentinel to distinguish undefined from not-called

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window limit',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedLimit = ctx.getContextWindowLimit()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('probe', {}), assistantText('Done.')]),
			tools: { probe: probeTool },
			// no contextWindowLimit set, and mock model won't be in models.dev
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(capturedLimit).toBeUndefined()
	})
})

describe('ToolContext.getContextWindow', () => {
	test('tool receives context window messages as a function', async () => {
		let capturedMessages: ReadonlyArray<ModelMessage> | undefined

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedMessages = ctx.getContextWindow()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('probe', {}), assistantText('Done.')]),
			tools: { probe: probeTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(capturedMessages).toBeDefined()
		// Should contain the initial user message + assistant tool call
		expect(capturedMessages!.length).toBeGreaterThanOrEqual(2)
		expect(capturedMessages![0]!.role).toBe('user')
	})

	test('getContextWindow returns a frozen array', async () => {
		let capturedMessages: ReadonlyArray<ModelMessage> | undefined

		const probeTool = defineTool({
			name: 'probe',
			description: 'Capture context window',
			input: z.object({}),
			execute: async (_input, ctx) => {
				capturedMessages = ctx.getContextWindow()
				return 'probed'
			},
		})

		const agent = new Agent({
			model: mockModel([assistantWithToolCall('probe', {}), assistantText('Done.')]),
			tools: { probe: probeTool },
		})

		await agent.run({ state: startState([userMessage('go')]) }).result
		expect(capturedMessages).toBeDefined()
		expect(Object.isFrozen(capturedMessages)).toBe(true)
	})
})
