import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, getAllPendingApprovals, startState, withApprovals } from '../src'
import { createSubagentsTool } from '../src/tools'
import {
	assistantText,
	assistantWithToolCall,
	extractToolCallId,
	getToolResults,
	mockResponse,
	mockStreamingModel,
	outputValue,
	userMessage,
} from './mocks'

const mockUsage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output, reasoning: 0 },
})

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo input',
	input: z.object({ text: z.string() }),
	execute: async (input) => input.text,
})

const dangerousTool = defineTool({
	name: 'dangerous',
	description: 'Needs approval',
	input: z.object({ value: z.string() }),
	execute: async (input) => `Approved: ${input.value}`,
})

function getSubagentResultTexts(messages: ModelMessage[]): string[] {
	return getToolResults(messages, { toolName: 'subagent' }).map(outputValue)
}

function createParentAgent({
	childResponses,
	parentResponses,
}: {
	childResponses: Parameters<typeof mockStreamingModel>[0]
	parentResponses: Parameters<typeof mockStreamingModel>[0]
}) {
	const childAgent = new Agent({
		model: mockStreamingModel(childResponses),
		tools: { echo: echoTool },
	})

	const subagentTool = createSubagentsTool({
		agents: [{ name: 'worker', description: 'A worker', agent: childAgent }],
	})

	return new Agent({
		model: mockStreamingModel(parentResponses),
		tools: { subagent: subagentTool },
	})
}

describe('sub-agent streaming events', () => {
	test('parent stream composes child step events under one tagged sub-agent scope', async () => {
		const childResponses = [
			mockResponse(
				[
					{
						type: 'tool-call',
						toolCallId: 'child-echo-call',
						toolName: 'echo',
						input: JSON.stringify({ text: 'child payload' }),
					},
				],
				{ usage: mockUsage(40, 15) },
			),
			assistantText('Child complete.', { usage: mockUsage(30, 12) }),
		]
		const parentResponses = [
			mockResponse(
				[
					{
						type: 'tool-call',
						toolCallId: 'parent-subagent-call',
						toolName: 'subagent',
						input: JSON.stringify({
							description: 'delegate work',
							prompt: 'say hello',
							subagent_type: 'worker',
						}),
					},
				],
				{ usage: mockUsage(100, 20) },
			),
			assistantText('Parent complete.', { usage: mockUsage(200, 30) }),
		]

		const parentAgent = createParentAgent({ childResponses, parentResponses })
		const run = parentAgent.run({ state: startState([userMessage('go')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('complete')

		const rootEvents = events.filter((event) => event.agentId === undefined)
		const childEvents = events.filter((event) => event.agentId !== undefined)
		expect(rootEvents.length).toBeGreaterThan(0)
		expect(childEvents.length).toBeGreaterThan(0)

		const childAgentIds = new Set(childEvents.map((event) => event.agentId))
		const childParentToolCallIds = new Set(childEvents.map((event) => event.parentToolCallId))
		expect(childAgentIds.size).toBe(1)
		expect(childParentToolCallIds.size).toBe(1)

		const childStepStarts = events.filter(
			(event): event is Extract<AgentEvent, { type: 'stepStart' }> =>
				event.type === 'stepStart' && event.agentId !== undefined,
		)
		expect(childStepStarts.map((event) => event.stepIndex)).toEqual([0, 1])

		const childToolInputDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'toolInputDelta' }> =>
				event.type === 'toolInputDelta' && event.agentId !== undefined,
		)
		expect(childToolInputDelta?.delta).toContain('child payload')
		expect(childToolInputDelta?.parentToolCallId).toBeDefined()

		const childTextDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.agentId !== undefined,
		)
		expect(childTextDelta).toMatchObject({ text: 'Child complete.' })

		const rootTextDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.agentId === undefined,
		)
		expect(rootTextDelta).toMatchObject({ text: 'Parent complete.' })
		expect(rootTextDelta?.parentToolCallId).toBeUndefined()

		const rootFirstTokenUsageIndex = events.findIndex(
			(event) => event.type === 'tokenUsage' && event.agentId === undefined,
		)
		const firstChildStepStartIndex = events.findIndex(
			(event) => event.type === 'stepStart' && event.agentId !== undefined,
		)
		const lastChildEventIndex = events.reduce(
			(lastIndex, event, index) => (event.agentId !== undefined ? index : lastIndex),
			-1,
		)
		const rootToolResultMessageIndex = events.findIndex(
			(event) => event.type === 'message' && event.agentId === undefined && event.message.role === 'tool',
		)
		const rootFinalTextStartIndex = events.findIndex(
			(event) => event.type === 'textStart' && event.agentId === undefined,
		)

		expect(rootFirstTokenUsageIndex).toBeGreaterThan(-1)
		expect(firstChildStepStartIndex).toBeGreaterThan(-1)
		expect(lastChildEventIndex).toBeGreaterThan(-1)
		expect(rootToolResultMessageIndex).toBeGreaterThan(-1)
		expect(rootFinalTextStartIndex).toBeGreaterThan(-1)
		expect(rootFirstTokenUsageIndex).toBeLessThan(firstChildStepStartIndex)
		expect(firstChildStepStartIndex).toBeLessThan(rootToolResultMessageIndex)
		expect(lastChildEventIndex).toBeLessThan(rootToolResultMessageIndex)
		expect(rootToolResultMessageIndex).toBeLessThan(rootFinalTextStartIndex)

		const subagentResults = getToolResults(result.state.messages, { toolName: 'subagent' })
		expect(subagentResults).toHaveLength(1)
		expect(outputValue(subagentResults[0]!)).toContain('Child complete.')

		expect(result.tokenUsage.totals.inputTokens).toBe(370)
		expect(result.tokenUsage.totals.outputTokens).toBe(77)
		expect(result.state.messages).toHaveLength(4)

		const assistantTextMessages = result.state.messages.filter(
			(message) =>
				message.role === 'assistant' &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === 'text'),
		)
		expect(assistantTextMessages).toHaveLength(1)
		expect(assistantTextMessages[0]!.content).toEqual([{ type: 'text', text: 'Parent complete.' }])
	})

	test('streaming nested runs preserve finalized-state parity with stream=false', async () => {
		const childResponses = [
			mockResponse(
				[
					{
						type: 'tool-call',
						toolCallId: 'child-echo-call',
						toolName: 'echo',
						input: JSON.stringify({ text: 'child payload' }),
					},
				],
				{ usage: mockUsage(40, 15) },
			),
			assistantText('Child complete.', { usage: mockUsage(30, 12) }),
		]
		const parentResponses = [
			mockResponse(
				[
					{
						type: 'tool-call',
						toolCallId: 'parent-subagent-call',
						toolName: 'subagent',
						input: JSON.stringify({
							description: 'delegate work',
							prompt: 'say hello',
							subagent_type: 'worker',
						}),
					},
				],
				{ usage: mockUsage(100, 20) },
			),
			assistantText('Parent complete.', { usage: mockUsage(200, 30) }),
		]

		const streamingAgent = createParentAgent({ childResponses, parentResponses })
		const nonStreamingAgent = createParentAgent({ childResponses, parentResponses })

		const run = streamingAgent.run({ state: startState([userMessage('go')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const streamingResult = await run.result
		const nonStreamingResult = await nonStreamingAgent.run({
			state: startState([userMessage('go')]),
			stream: false,
		}).result

		expect(
			events.some((event) => event.type === 'toolInputDelta' && event.agentId !== undefined),
		).toBe(true)
		expect(
			events.some((event) => event.type === 'textDelta' && event.agentId !== undefined),
		).toBe(true)

		expect(streamingResult.state.messages).toEqual(nonStreamingResult.state.messages)
		expect(streamingResult.newMessages).toEqual(nonStreamingResult.newMessages)
		expect(streamingResult.finishReason).toBe(nonStreamingResult.finishReason)
		expect(streamingResult.state.contextWindowTokens).toBe(nonStreamingResult.state.contextWindowTokens)
		expect(streamingResult.tokenUsage.totals).toEqual(nonStreamingResult.tokenUsage.totals)
		expect(streamingResult.tokenUsage.byModel).toEqual(nonStreamingResult.tokenUsage.byModel)
	})
})
