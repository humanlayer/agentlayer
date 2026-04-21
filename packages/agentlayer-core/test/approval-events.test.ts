import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCall, assistantWithToolCalls, mockModel, userMessage } from './mocks'

const dangerousTool = defineTool({
	name: 'dangerous',
	description: 'A dangerous tool that requires approval',
	input: z.object({ target: z.string() }),
	execute: async (input) => `Executed on ${input.target}`,
})

const safeTool = defineTool({
	name: 'safe',
	description: 'A safe tool',
	input: z.object({ value: z.string() }),
	execute: async (input) => `Safe: ${input.value}`,
})

function createAgentWithApproval(responses: Parameters<typeof mockModel>[0]) {
	return new Agent({
		model: mockModel(responses),
		tools: { dangerous: dangerousTool, safe: safeTool },
		hooks: {
			approval: [
				(ctx) => {
					if (ctx.toolName === 'dangerous') {
						return ctx.ask({ message: `Approve ${ctx.toolName}?` })
					}
					return ctx.next()
				},
			],
		},
	})
}

describe('approvalRequested events', () => {
	test('approvalRequested event is emitted when a tool needs approval', async () => {
		const agent = createAgentWithApproval([assistantWithToolCall('dangerous', { target: 'prod' })])

		const run = agent.run({ state: startState([userMessage('do it')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('approvalRequired')

		// Should have at least one approvalRequested event
		const approvalEvents = events.filter((e) => e.type === 'approvalRequested')
		expect(approvalEvents).toHaveLength(1)

		const approvalEvent = approvalEvents[0]!
		expect(approvalEvent.type).toBe('approvalRequested')
		if (approvalEvent.type !== 'approvalRequested') throw new Error('unreachable')
		expect(approvalEvent.toolName).toBe('dangerous')
		expect(approvalEvent.input).toEqual({ target: 'prod' })
		expect(approvalEvent.approval.message).toBe('Approve dangerous?')
		expect(approvalEvent.toolCallId).toBeDefined()
		// Root agent — no agentId or parentToolCallId
		expect(approvalEvent.agentId).toBeUndefined()
		expect(approvalEvent.parentToolCallId).toBeUndefined()
	})

	test('approvalRequested events emitted before run finishes', async () => {
		const agent = createAgentWithApproval([assistantWithToolCall('dangerous', { target: 'staging' })])

		const run = agent.run({ state: startState([userMessage('deploy')]) })

		// Collect events via iteration — approvalRequested must appear before the iterator ends
		const approvalEvents: AgentEvent[] = []
		for await (const event of run) {
			if (event.type === 'approvalRequested') {
				approvalEvents.push(event)
			}
		}

		expect(approvalEvents).toHaveLength(1)
		// Run should be finished now
		expect(run.running).toBe(false)
	})

	test('multiple approval requests produce multiple events', async () => {
		const agent = createAgentWithApproval([
			assistantWithToolCalls(
				{ toolName: 'dangerous', input: { target: 'a' } },
				{ toolName: 'dangerous', input: { target: 'b' } },
			),
		])

		const run = agent.run({ state: startState([userMessage('do both')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('approvalRequired')

		const approvalEvents = events.filter((e) => e.type === 'approvalRequested')
		expect(approvalEvents).toHaveLength(2)
	})

	test('safe tools do not produce approvalRequested events', async () => {
		const agent = createAgentWithApproval([
			assistantWithToolCall('safe', { value: 'hello' }),
			assistantText('Done.'),
		])

		const run = agent.run({ state: startState([userMessage('do safe thing')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const approvalEvents = events.filter((e) => e.type === 'approvalRequested')
		expect(approvalEvents).toHaveLength(0)

		const result = await run.result
		expect(result.finishReason).toBe('complete')
	})

	test('mixed parallel: approvalRequested for dangerous, message for safe', async () => {
		const agent = createAgentWithApproval([
			assistantWithToolCalls(
				{ toolName: 'safe', input: { value: 'ok' } },
				{ toolName: 'dangerous', input: { target: 'prod' } },
			),
		])

		const run = agent.run({ state: startState([userMessage('do both')]) })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('approvalRequired')

		const approvalEvents = events.filter((e) => e.type === 'approvalRequested')
		expect(approvalEvents).toHaveLength(1)

		// The safe tool's result message should also be streamed
		const messageEvents = events.filter((e) => e.type === 'message')
		expect(messageEvents.length).toBeGreaterThan(0)
	})

	test('approvalRequested event toolCallId matches pending tool call', async () => {
		const agent = createAgentWithApproval([assistantWithToolCall('dangerous', { target: 'db' })])

		const run = agent.run({ state: startState([userMessage('drop')]) })
		const approvalEvents: (AgentEvent & { type: 'approvalRequested' })[] = []
		for await (const event of run) {
			if (event.type === 'approvalRequested') {
				approvalEvents.push(event)
			}
		}

		const result = await run.result
		expect(result.state.pendingToolCalls).toHaveLength(1)
		const pendingTc = result.state.pendingToolCalls![0]!
		expect(pendingTc.type).toBe('approval')
		expect(approvalEvents[0]!.toolCallId).toBe(pendingTc.toolCallId)
	})
})
