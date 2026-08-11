import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, getAllPendingApprovals, startState, withApprovals } from '../src'
import { createForkingSubagentsTool, createSubagentsTool } from '../src/tools'
import {
	assistantText,
	assistantWithToolCall,
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

		expect(events.some((event) => event.type === 'toolInputDelta' && event.agentId !== undefined)).toBe(true)
		expect(events.some((event) => event.type === 'textDelta' && event.agentId !== undefined)).toBe(true)

		expect(streamingResult.state.messages).toEqual(nonStreamingResult.state.messages)
		expect(streamingResult.newMessages).toEqual(nonStreamingResult.newMessages)
		expect(streamingResult.finishReason).toBe(nonStreamingResult.finishReason)
		expect(streamingResult.state.contextWindowTokens).toBe(nonStreamingResult.state.contextWindowTokens)
		expect(streamingResult.tokenUsage.totals).toEqual(nonStreamingResult.tokenUsage.totals)
		expect(streamingResult.tokenUsage.byModel).toEqual(nonStreamingResult.tokenUsage.byModel)
	})

	test('grandchild streaming events reach the parent iterator with nested tagging intact', async () => {
		const grandchildAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'grandchild-echo-call',
							toolName: 'echo',
							input: JSON.stringify({ text: 'deep payload' }),
						},
					],
					{ usage: mockUsage(15, 5) },
				),
				assistantText('Grandchild complete.', { usage: mockUsage(18, 7) }),
			]),
			tools: { echo: echoTool },
		})

		const grandchildTool = createSubagentsTool({
			agents: [{ name: 'grandchild-worker', description: 'A grandchild worker', agent: grandchildAgent }],
		})

		const childAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'child-subagent-call',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'delegate deeper',
								prompt: 'do deep work',
								subagent_type: 'grandchild-worker',
							}),
						},
					],
					{ usage: mockUsage(40, 12) },
				),
				assistantText('Child complete after grandchild.', { usage: mockUsage(30, 9) }),
			]),
			tools: { subagent: grandchildTool },
		})

		const childTool = createSubagentsTool({
			agents: [{ name: 'child-worker', description: 'A child worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'parent-subagent-call',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'delegate work',
								prompt: 'do nested work',
								subagent_type: 'child-worker',
							}),
						},
					],
					{ usage: mockUsage(60, 14) },
				),
				assistantText('Parent complete.', { usage: mockUsage(50, 11) }),
			]),
			tools: { subagent: childTool },
		})

		const run = parentAgent.run({ state: startState([userMessage('go nested')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('complete')

		const childTextDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.parentToolCallId === 'parent-subagent-call',
		)
		const grandchildTextDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.parentToolCallId === 'child-subagent-call',
		)
		const grandchildToolInputDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'toolInputDelta' }> =>
				event.type === 'toolInputDelta' && event.parentToolCallId === 'child-subagent-call',
		)

		expect(childTextDelta).toMatchObject({ text: 'Child complete after grandchild.' })
		expect(grandchildTextDelta).toMatchObject({ text: 'Grandchild complete.' })
		expect(grandchildToolInputDelta?.delta).toContain('deep payload')
		expect(childTextDelta?.agentId).toBeDefined()
		expect(grandchildTextDelta?.agentId).toBeDefined()
		expect(grandchildTextDelta?.agentId).not.toBe(childTextDelta?.agentId)

		const nestedGrandchildEvents = events.filter((event) => event.agentId === grandchildTextDelta?.agentId)
		expect(new Set(nestedGrandchildEvents.map((event) => event.parentToolCallId))).toEqual(
			new Set(['child-subagent-call']),
		)

		const rootFinalTextStartIndex = events.findIndex(
			(event) => event.type === 'textStart' && event.agentId === undefined,
		)
		const lastNestedEventIndex = events.reduce(
			(lastIndex, event, index) => (event.agentId !== undefined ? index : lastIndex),
			-1,
		)
		expect(lastNestedEventIndex).toBeLessThan(rootFinalTextStartIndex)

		const subagentResults = getSubagentResultTexts(result.state.messages)
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Child complete after grandchild.')
		expect(JSON.stringify(result.state.messages)).not.toContain('Grandchild complete.')
	})

	test('parallel streaming child runs preserve separate child scopes on the parent iterator', async () => {
		const childA = new Agent({
			model: mockStreamingModel([assistantText('Worker A complete.', { usage: mockUsage(20, 6) })]),
			tools: {},
		})
		const childB = new Agent({
			model: mockStreamingModel([assistantText('Worker B complete.', { usage: mockUsage(22, 7) })]),
			tools: {},
		})

		const childTool = createSubagentsTool({
			agents: [
				{ name: 'worker-a', description: 'Worker A', agent: childA },
				{ name: 'worker-b', description: 'Worker B', agent: childB },
			],
		})

		const parentAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'parent-subagent-call-a',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'run worker a',
								prompt: 'finish A',
								subagent_type: 'worker-a',
							}),
						},
						{
							type: 'tool-call',
							toolCallId: 'parent-subagent-call-b',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'run worker b',
								prompt: 'finish B',
								subagent_type: 'worker-b',
							}),
						},
					],
					{ usage: mockUsage(70, 18) },
				),
				assistantText('Parent done after both workers.', { usage: mockUsage(45, 10) }),
			]),
			tools: { subagent: childTool },
		})

		const run = parentAgent.run({ state: startState([userMessage('fan out')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		const result = await run.result
		expect(result.finishReason).toBe('complete')

		const childTextDeltas = events.filter(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.agentId !== undefined,
		)
		expect(childTextDeltas.map((event) => event.text).sort()).toEqual(['Worker A complete.', 'Worker B complete.'])
		expect(new Set(childTextDeltas.map((event) => event.agentId)).size).toBe(2)
		expect(new Set(childTextDeltas.map((event) => event.parentToolCallId))).toEqual(
			new Set(['parent-subagent-call-a', 'parent-subagent-call-b']),
		)

		const lastChildEventIndex = events.reduce(
			(lastIndex, event, index) => (event.agentId !== undefined ? index : lastIndex),
			-1,
		)
		const rootFinalTextStartIndex = events.findIndex(
			(event) => event.type === 'textStart' && event.agentId === undefined,
		)
		expect(lastChildEventIndex).toBeLessThan(rootFinalTextStartIndex)

		const subagentResults = getSubagentResultTexts(result.state.messages)
		expect(subagentResults).toHaveLength(2)
		expect(subagentResults.some((resultText) => resultText.includes('Worker A complete.'))).toBe(true)
		expect(subagentResults.some((resultText) => resultText.includes('Worker B complete.'))).toBe(true)
	})

	test('nested approvals stream through the parent iterator and resume cleanly after approval', async () => {
		const grandchildAgent = new Agent({
			model: mockStreamingModel([
				assistantWithToolCall('dangerous', { value: 'deep payload' }, { usage: mockUsage(12, 4) }),
				assistantText('Grandchild approved.', { usage: mockUsage(16, 6) }),
			]),
			tools: { dangerous: dangerousTool },
			hooks: {
				approval: [
					(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve deep work?' }) : ctx.next()),
				],
			},
		})

		const grandchildTool = createSubagentsTool({
			agents: [{ name: 'grandchild-worker', description: 'A grandchild worker', agent: grandchildAgent }],
		})

		const childAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'child-subagent-call',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'delegate deeper',
								prompt: 'ask grandchild to do the risky work',
								subagent_type: 'grandchild-worker',
							}),
						},
					],
					{ usage: mockUsage(24, 8) },
				),
				assistantText('Child done after approval.', { usage: mockUsage(20, 7) }),
			]),
			tools: { subagent: grandchildTool },
		})

		const childTool = createSubagentsTool({
			agents: [{ name: 'child-worker', description: 'A child worker', agent: childAgent }],
		})

		const parentAgent = new Agent({
			model: mockStreamingModel([
				mockResponse(
					[
						{
							type: 'tool-call',
							toolCallId: 'parent-subagent-call',
							toolName: 'subagent',
							input: JSON.stringify({
								description: 'delegate child work',
								prompt: 'do nested risky work',
								subagent_type: 'child-worker',
							}),
						},
					],
					{ usage: mockUsage(32, 9) },
				),
				assistantText('Parent done.', { usage: mockUsage(22, 6) }),
			]),
			tools: { subagent: childTool },
		})

		const firstRun = parentAgent.run({ state: startState([userMessage('start nested approval')]), stream: true })
		const firstEvents: AgentEvent[] = []
		for await (const event of firstRun) {
			firstEvents.push(event)
		}

		const firstResult = await firstRun.result
		expect(firstResult.finishReason).toBe('approvalRequired')
		expect(getSubagentResultTexts(firstResult.state.messages)).toHaveLength(0)

		const approvalEvent = firstEvents.find(
			(event): event is Extract<AgentEvent, { type: 'approvalRequested' }> => event.type === 'approvalRequested',
		)
		expect(approvalEvent).toMatchObject({
			toolName: 'dangerous',
			parentToolCallId: 'child-subagent-call',
		})
		expect(approvalEvent?.agentId).toBeDefined()

		const approvalEventIndex = firstEvents.indexOf(approvalEvent as AgentEvent)
		const grandchildStepFinishIndex = firstEvents.findIndex(
			(event) => event.type === 'stepFinish' && event.agentId === approvalEvent?.agentId,
		)
		expect(grandchildStepFinishIndex).toBeGreaterThan(-1)
		expect(grandchildStepFinishIndex).toBeLessThan(approvalEventIndex)

		const pendingApprovals = getAllPendingApprovals(firstResult.state)
		expect(pendingApprovals).toHaveLength(1)
		expect(pendingApprovals[0]?.path).toHaveLength(2)

		const approvedState = withApprovals(firstResult.state, [
			{ toolCallId: pendingApprovals[0]!.pending.toolCallId, approved: true },
		])

		const resumedRun = parentAgent.run({ state: approvedState, stream: true })
		const resumedEvents: AgentEvent[] = []
		for await (const event of resumedRun) {
			resumedEvents.push(event)
		}

		const resumedResult = await resumedRun.result
		expect(resumedResult.finishReason).toBe('complete')
		expect(resumedEvents.some((event) => event.type === 'approvalRequested')).toBe(false)

		const resumedGrandchildText = resumedEvents.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.parentToolCallId === 'child-subagent-call',
		)
		const resumedChildText = resumedEvents.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> =>
				event.type === 'textDelta' && event.parentToolCallId === 'parent-subagent-call',
		)
		expect(resumedGrandchildText).toMatchObject({ text: 'Grandchild approved.' })
		expect(resumedChildText).toMatchObject({ text: 'Child done after approval.' })
		expect(new Set(getAllPendingApprovals(resumedResult.state))).toEqual(new Set())
		expect(resumedResult.state.subAgents).toBeUndefined()

		const subagentResults = getSubagentResultTexts(resumedResult.state.messages)
		expect(subagentResults).toHaveLength(1)
		expect(subagentResults[0]).toContain('Child done after approval.')
		expect(JSON.stringify(resumedResult.state.messages)).not.toContain('Grandchild approved.')
	})

	test('tags child compaction events and aggregates summary usage exactly once', async () => {
		const child = new Agent({
			model: mockStreamingModel([
				assistantWithToolCall('dangerous', { value: 'compact' }, { usage: mockUsage(20, 5) }),
				assistantText('child summary', { usage: mockUsage(7, 2) }),
				assistantText('child complete', { usage: mockUsage(8, 3) }),
			]),
			tools: { dangerous: dangerousTool },
			contextWindowLimit: 100,
			autoCompact: { thresholdTokens: 10, keepRecentTokens: 1 },
			hooks: {
				approval: [(ctx) => (ctx.toolName === 'dangerous' ? ctx.ask({ message: 'Approve?' }) : ctx.next())],
			},
		})
		const subagent = createSubagentsTool({
			agents: [{ name: 'worker', description: 'Worker', agent: child }],
		})
		const parent = new Agent({
			model: mockStreamingModel([
				assistantWithToolCall(
					'subagent',
					{ description: 'delegate', prompt: 'approved work', subagent_type: 'worker' },
					{ usage: mockUsage(100, 20) },
				),
				assistantText('parent complete', { usage: mockUsage(200, 30) }),
			]),
			tools: { subagent },
		})
		const paused = await parent.run({ state: startState([userMessage('go')]), stream: true }).result
		const pending = getAllPendingApprovals(paused.state)
		const approved = withApprovals(paused.state, [{ toolCallId: pending[0]!.pending.toolCallId, approved: true }])
		const resumedRun = parent.run({ state: approved, stream: true })
		const events: AgentEvent[] = []
		for await (const event of resumedRun) events.push(event)
		const result = await resumedRun.result
		const compactions = events.filter(
			(event): event is Extract<AgentEvent, { type: 'compaction' }> => event.type === 'compaction',
		)

		expect(compactions).toHaveLength(1)
		expect(compactions[0]).toMatchObject({
			trigger: 'threshold',
			parentToolCallId: expect.any(String),
			agentId: expect.any(String),
			summaryUsage: { usage: { inputTokens: 7, outputTokens: 2 } },
		})
		expect(result.tokenUsage.totals.inputTokens).toBe(215)
		expect(result.tokenUsage.totals.outputTokens).toBe(35)
	})

	test('aggregates failed child summarizer usage once without committing a checkpoint', async () => {
		const model = mockStreamingModel([
			assistantWithToolCall('subagent', { prompt: '/compact' }, { usage: mockUsage(100, 20) }),
			assistantText('   ', { usage: mockUsage(7, 2) }),
			assistantText('parent complete', { usage: mockUsage(200, 30) }),
		])
		const subagent = createForkingSubagentsTool({ agents: [] })
		const parent = new Agent({ model, tools: { subagent }, autoCompact: { keepRecentTokens: 2 } })
		const run = parent.run({
			state: startState([
				userMessage('old context'),
				{ role: 'assistant', content: 'settled answer' },
				userMessage('delegate compaction'),
			]),
			stream: true,
		})
		const events: AgentEvent[] = []
		for await (const event of run) events.push(event)
		const result = await run.result

		expect(result.finishReason).toBe('complete')
		expect(result.state.compaction).toBeUndefined()
		expect(result.tokenUsage.totals.inputTokens).toBe(307)
		expect(result.tokenUsage.totals.outputTokens).toBe(52)
		expect(events.filter((event) => event.type === 'compaction')).toHaveLength(0)
		expect(getSubagentResultTexts(result.state.messages)[0]).toContain(
			'Compaction summarizer returned an empty summary',
		)
	})

	test('aggregates both split-turn child summaries exactly once', async () => {
		const childId = 'split-child'
		const child = new Agent({
			model: mockStreamingModel([
				assistantText('child history summary', { usage: mockUsage(7, 2) }),
				assistantText('child turn prefix summary', { usage: mockUsage(8, 3) }),
				assistantText('child complete', { usage: mockUsage(9, 4) }),
			]),
			tools: {},
			autoCompact: { keepRecentTokens: 2 },
		})
		const subagent = createForkingSubagentsTool({
			agents: [{ name: 'worker', description: 'Worker', agent: child, resumable: true }],
		})
		const parent = new Agent({
			model: mockStreamingModel([
				assistantWithToolCall(
					'subagent',
					{ prompt: '/compact focus on child history', agent_id: childId },
					{ usage: mockUsage(100, 20) },
				),
				assistantText('parent complete', { usage: mockUsage(200, 30) }),
			]),
			tools: { subagent },
		})
		const run = parent.run({
			state: {
				messages: [userMessage('resume child')],
				terminalChildren: {
					[childId]: {
						state: startState([
							userMessage('older child request'),
							{ role: 'assistant', content: 'older child answer' },
							userMessage('oversized child turn'),
							{ role: 'assistant', content: 'early child work' },
							{
								role: 'assistant',
								content: [{ type: 'tool-call', toolCallId: 'child-read', toolName: 'read', input: {} }],
							},
							{
								role: 'tool',
								content: [
									{
										type: 'tool-result',
										toolCallId: 'child-read',
										toolName: 'read',
										output: { type: 'text', value: 'x'.repeat(400) },
									},
								],
							},
							{ role: 'assistant', content: 'ok' },
						]),
						lastOutcome: 'complete',
						completedTurns: 1,
						runtime: { type: 'specialist', subagentType: 'worker' },
					},
				},
			},
			stream: true,
		})
		const events: AgentEvent[] = []
		for await (const event of run) events.push(event)
		const result = await run.result
		const compaction = events.find(
			(event): event is Extract<AgentEvent, { type: 'compaction' }> => event.type === 'compaction',
		)

		expect(compaction).toMatchObject({
			agentId: childId,
			summaryUsage: { usage: { inputTokens: 15, outputTokens: 5 } },
		})
		expect(result.tokenUsage.totals.inputTokens).toBe(324)
		expect(result.tokenUsage.totals.outputTokens).toBe(59)
		expect(result.state.terminalChildren?.[childId]?.state.compaction?.summary).toContain(
			'child turn prefix summary',
		)
	})
})
