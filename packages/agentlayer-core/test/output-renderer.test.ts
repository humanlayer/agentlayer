import { describe, expect, test } from 'bun:test'
import { createOutputRenderer } from '../src'

describe('output renderer tool arguments', () => {
	test('renders interleaved parallel calls once and correlates each result by API call ID', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({ writeLine: (line) => lines.push(line) })

		renderer.onEvent({ type: 'toolInputStart', id: 'call_api_1', toolName: 'agent', stepIndex: 0 })
		renderer.onEvent({ type: 'toolInputStart', id: 'call_api_2', toolName: 'agent', stepIndex: 0 })
		renderer.onEvent({ type: 'toolInputDelta', id: 'call_api_1', delta: '{"prompt":"first"}', stepIndex: 0 })
		renderer.onEvent({ type: 'toolInputDelta', id: 'call_api_2', delta: '{"prompt":"second"}', stepIndex: 0 })
		renderer.onEvent({ type: 'toolInputEnd', id: 'call_api_1', stepIndex: 0 })
		renderer.onEvent({ type: 'toolInputEnd', id: 'call_api_2', stepIndex: 0 })
		renderer.onEvent({
			type: 'message',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool-call', toolCallId: 'call_api_1', toolName: 'agent', input: { prompt: 'first' } },
					{ type: 'tool-call', toolCallId: 'call_api_2', toolName: 'agent', input: { prompt: 'second' } },
				],
			},
		})
		for (const [toolCallId, value] of [
			['call_api_1', 'first result'],
			['call_api_2', 'second result'],
		] as const) {
			renderer.onEvent({
				type: 'message',
				message: {
					role: 'tool',
					content: [
						{
							type: 'tool-result',
							toolCallId,
							toolName: 'agent',
							output: { type: 'text', value },
						},
					],
				},
			})
		}

		const output = lines.join('\n')
		expect(output.match(/\[Tool\] agent/g)).toHaveLength(2)
		expect(output.match(/\[Tool Result\] agent/g)).toHaveLength(2)
		for (const toolCallId of ['call_api_1', 'call_api_2']) {
			expect(
				output.match(new RegExp(`\\[Tool\\] agent call_id=${toolCallId} agent=root depth=0`, 'g')),
			).toHaveLength(1)
			expect(output).toContain(`[Tool Result] agent call_id=${toolCallId} agent=root depth=0 status=ok`)
		}
	})

	test('labels nested tool calls with stable child identity, depth, and immediate parent call', () => {
		const lines: string[] = []
		const renderer = createOutputRenderer({ writeLine: (line) => lines.push(line) })
		const childMeta = { agentId: 'child-call', agentDepth: 1, parentToolCallId: 'root-call' } as const
		const grandchildMeta = {
			agentId: 'grandchild-call',
			agentDepth: 2,
			parentToolCallId: 'child-agent-call',
		} as const

		for (const [id, meta] of [
			['child-tool', childMeta],
			['grandchild-tool', grandchildMeta],
		] as const) {
			renderer.onEvent({ type: 'toolInputStart', id, toolName: 'agent', stepIndex: 0, ...meta })
			renderer.onEvent({ type: 'toolInputDelta', id, delta: '{"prompt":"work"}', stepIndex: 0, ...meta })
			renderer.onEvent({ type: 'toolInputEnd', id, stepIndex: 0, ...meta })
			renderer.onEvent({
				type: 'message',
				...meta,
				message: {
					role: 'tool',
					content: [
						{
							type: 'tool-result',
							toolCallId: id,
							toolName: 'agent',
							output: { type: 'text', value: 'ok' },
						},
					],
				},
			})
		}

		const output = lines.join('\n')
		expect(output).toContain('[Tool] agent call_id=child-tool agent=child:child-call depth=1 parent_call=root-call')
		expect(output).toContain(
			'[Tool Result] agent call_id=grandchild-tool agent=child:grandchild-call depth=2 parent_call=child-agent-call status=ok',
		)
	})
})
