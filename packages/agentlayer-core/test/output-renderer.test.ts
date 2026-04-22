import { describe, expect, test } from 'bun:test'
import { type AgentEvent, createOutputRenderer } from '../src'

describe('output renderer', () => {
	test('streams thinking and text line-by-line without duplicating finalized assistant text', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({
			writeLine: (line) => lines.push(line),
		})

		const events: AgentEvent[] = [
			{ type: 'stepStart', stepIndex: 0 },
			{ type: 'reasoningDelta', id: 'r1', stepIndex: 0, text: 'first line\nsecond' },
			{ type: 'textStart', id: 't1', stepIndex: 0 },
			{ type: 'textDelta', id: 't1', stepIndex: 0, text: 'hello\nworld' },
			{ type: 'textEnd', id: 't1', stepIndex: 0 },
			{
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{ type: 'reasoning', text: 'first line\nsecond' },
						{ type: 'text', text: 'hello\nworld' },
					],
				},
			},
		]

		for (const event of events) {
			renderer.onEvent(event)
		}
		renderer.flush()

		expect(lines).toEqual(['thinking: first line', 'thinking: second', 'hello', 'world'])
	})

	test('renders tool progress output by line and suppresses duplicate tool result text', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({
			writeLine: (line) => lines.push(line),
		})

		renderer.onEvent({
			type: 'message',
			message: {
				role: 'assistant',
				content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', input: '{}' }],
			},
		})
		renderer.onToolProgress('call-1', 'bash', { type: 'status', message: 'running command' })
		renderer.onToolProgress('call-1', 'bash', { type: 'output', content: 'line 1\nline 2' })
		renderer.onEvent({
			type: 'message',
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-1',
						toolName: 'bash',
						output: { type: 'text', value: 'line 1\nline 2' },
					},
				],
			},
		})
		renderer.flush()

		expect(lines).toEqual(['tool bash', 'tool bash: running command', 'tool bash: line 1', 'tool bash: line 2'])
	})

	test('falls back to finalized tool results and approvals when no live progress exists', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({
			writeLine: (line) => lines.push(line),
			includeTokenUsage: true,
		})

		renderer.onEvent({
			type: 'approvalRequested',
			approval: {
				id: 'call-2',
				toolName: 'deploy',
				toolCallId: 'call-2',
				input: { target: 'prod' },
				message: 'Approve deploy?',
			},
			toolCallId: 'call-2',
			toolName: 'deploy',
			input: { target: 'prod' },
		})
		renderer.onEvent({
			type: 'message',
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-2',
						toolName: 'deploy',
						output: { type: 'text', value: 'deployment queued\nwatch logs' },
					},
				],
			},
		})
		renderer.onEvent({
			type: 'tokenUsage',
			usage: {
				model: 'mock/model',
				usage: {
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
				},
				contextWindowTokens: 18,
			},
		})

		expect(lines).toEqual([
			'approval needed for deploy: Approve deploy?',
			'tool deploy: deployment queued',
			'tool deploy: watch logs',
			'tokens mock/model: in=11 out=7',
		])
	})

	test('renders plain finalized assistant strings when there was no live streaming', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({
			writeLine: (line) => lines.push(line),
		})

		renderer.onEvent({
			type: 'message',
			message: {
				role: 'assistant',
				content: 'final answer\nnext line',
			},
		})

		expect(lines).toEqual(['final answer', 'next line'])
	})
})
