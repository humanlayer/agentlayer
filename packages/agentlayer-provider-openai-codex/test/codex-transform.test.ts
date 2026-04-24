import { describe, expect, test } from 'bun:test'
import { buildCodexRequestBody } from '../src/codex'

describe('buildCodexRequestBody', () => {
	test('moves system and developer instructions into top-level instructions', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{ role: 'system', content: 'Follow the repository rules.' },
					{
						role: 'user',
						content: [{ type: 'text', text: 'Write a function.' }],
					},
				],
				providerOptions: {
					openai: {
						instructions: 'Prefer concise output.',
						include: ['reasoning.encrypted_content'],
						max_output_tokens: 123,
					},
				},
			},
			'gpt-5.4',
		)

		expect(body.instructions).toBe('Follow the repository rules.\n\nPrefer concise output.')
		expect(body.store).toBe(false)
		expect(body.stream).toBe(true)
		expect(body).not.toHaveProperty('include')
		expect(body).not.toHaveProperty('max_output_tokens')
	})

	test('preserves item_reference ids from provider metadata', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: 'Stored content',
								providerOptions: { openai: { itemId: 'msg_123' } },
							},
						],
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.input).toEqual([{ type: 'item_reference', id: 'msg_123' }])
	})

	test('serializes tool call outputs for tool messages', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'tool',
						content: [
							{
								type: 'tool-result',
								toolCallId: 'call_123',
								toolName: 'search',
								output: { type: 'json', value: { ok: true } },
							},
						],
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.input).toEqual([
			{ type: 'function_call_output', call_id: 'call_123', output: JSON.stringify({ ok: true }) },
		])
	})
})
