import { describe, expect, test } from 'bun:test'
import type { LanguageModelV3Reasoning } from '@ai-sdk/provider'
import { z } from 'zod'
import { Agent, type AgentEvent, defineTool, startState } from '../src'
import { assistantText, assistantWithToolCalls, mockResponse, mockStreamingModel, userMessage } from './mocks'

const echoTool = defineTool({
	name: 'echo',
	description: 'Echo input',
	input: z.object({ text: z.string() }),
	execute: async (input) => input.text,
})

describe('streaming events', () => {
	test('stream=true emits root text events in order and preserves final transcript parity', async () => {
		const responses = [assistantWithToolCalls({ toolName: 'echo', input: { text: 'hi' } }), assistantText('Done.')]
		const streamingAgent = new Agent({
			model: mockStreamingModel(responses),
			tools: { echo: echoTool },
		})
		const nonStreamingAgent = new Agent({
			model: mockStreamingModel(responses),
			tools: { echo: echoTool },
		})

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

		const eventTypes = events.map((event) => event.type)
		expect(eventTypes).toEqual([
			'stepStart',
			'stepFinish',
			'message',
			'tokenUsage',
			'message',
			'stepStart',
			'textStart',
			'textDelta',
			'textEnd',
			'stepFinish',
			'message',
			'tokenUsage',
		])

		const firstStepStartIndex = eventTypes.indexOf('stepStart')
		const firstStepFinishIndex = eventTypes.indexOf('stepFinish')
		const secondStepStartIndex = eventTypes.lastIndexOf('stepStart')
		const secondStepFinishIndex = eventTypes.lastIndexOf('stepFinish')
		expect(firstStepStartIndex).toBeLessThan(firstStepFinishIndex)
		expect(firstStepFinishIndex).toBeLessThan(eventTypes.indexOf('message'))
		expect(secondStepStartIndex).toBeLessThan(eventTypes.indexOf('textStart'))
		expect(eventTypes.indexOf('textStart')).toBeLessThan(eventTypes.indexOf('textDelta'))
		expect(eventTypes.indexOf('textDelta')).toBeLessThan(eventTypes.indexOf('textEnd'))
		expect(eventTypes.indexOf('textEnd')).toBeLessThan(secondStepFinishIndex)

		const textDelta = events.find(
			(event): event is Extract<AgentEvent, { type: 'textDelta' }> => event.type === 'textDelta',
		)
		expect(textDelta?.stepIndex).toBe(1)
		expect(textDelta?.text).toBe('Done.')
		expect(streamingResult.state.messages).toEqual(nonStreamingResult.state.messages)
		expect(streamingResult.newMessages).toEqual(nonStreamingResult.newMessages)
		expect(streamingResult.finishReason).toBe(nonStreamingResult.finishReason)
	})

	test('stream=true emits reasoning deltas and only persists the finalized assistant message', async () => {
		const reasoningPart: LanguageModelV3Reasoning = {
			type: 'reasoning',
			text: 'Thinking...',
			providerMetadata: undefined,
		}
		const agent = new Agent({
			model: mockStreamingModel([mockResponse([reasoningPart])]),
			tools: {},
		})

		const run = agent.run({ state: startState([userMessage('think')]), stream: true })
		const events: AgentEvent[] = []
		for await (const event of run) {
			events.push(event)
		}

		expect(events.map((event) => event.type)).toEqual([
			'stepStart',
			'reasoningStart',
			'reasoningDelta',
			'reasoningEnd',
			'stepFinish',
			'message',
			'tokenUsage',
		])

		const reasoningEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: 'reasoningDelta' }> => event.type === 'reasoningDelta',
		)
		expect(reasoningEvents).toHaveLength(1)
		expect(reasoningEvents[0]).toMatchObject({ type: 'reasoningDelta', text: 'Thinking...', stepIndex: 0 })
		expect(events.some((event) => event.type === 'textDelta')).toBe(false)

		const result = await run.result
		expect(result.newMessages).toHaveLength(1)
		expect(result.newMessages[0]).toMatchObject({
			role: 'assistant',
			content: [{ type: 'reasoning', text: 'Thinking...' }],
		})
		expect(result.state.messages).toEqual([userMessage('think'), result.newMessages[0]!])
	})
})
