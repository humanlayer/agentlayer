import { describe, expect, test } from 'bun:test'
import { assistantMessage, systemMessage, toolCall, toolResult, userMessage } from '../src/messages'

describe('message helpers', () => {
	test('builds common text messages', () => {
		expect(userMessage('hello')).toEqual({ role: 'user', content: 'hello' })
		expect(systemMessage('rules')).toEqual({ role: 'system', content: 'rules' })
		expect(assistantMessage('ok')).toEqual({ role: 'assistant', content: 'ok' })
	})

	test('builds tool call and result messages', () => {
		expect(toolCall({ toolCallId: 'call-1', toolName: 'read', input: { filePath: 'README.md' } })).toEqual({
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'read',
					input: { filePath: 'README.md' },
				},
			],
		})

		expect(toolResult({ toolCallId: 'call-1', toolName: 'read', output: 'contents' })).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'read',
					output: { type: 'text', value: 'contents' },
				},
			],
		})
	})
})
