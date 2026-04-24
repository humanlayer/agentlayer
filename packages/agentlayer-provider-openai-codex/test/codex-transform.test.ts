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
						reasoningSummary: 'auto',
						reasoningEffort: 'medium',
						parallelToolCalls: false,
						conversation: 'conv_123',
						previousResponseId: 'resp_prev',
						maxToolCalls: 2,
						promptCacheKey: 'cache-key',
						promptCacheRetention: '24h',
						serviceTier: 'priority',
						truncation: 'auto',
						user: 'user_123',
						metadata: { source: 'test' },
						max_output_tokens: 123,
					},
				},
			},
			'gpt-5.4',
		)

		expect(body.instructions).toBe('Follow the repository rules.\n\nPrefer concise output.')
		expect(body.store).toBe(false)
		expect(body.stream).toBe(true)
		expect(body.include).toEqual(['reasoning.encrypted_content'])
		expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
		expect(body.parallel_tool_calls).toBe(false)
		expect(body.conversation).toBe('conv_123')
		expect(body.previous_response_id).toBe('resp_prev')
		expect(body.max_tool_calls).toBe(2)
		expect(body.prompt_cache_key).toBe('cache-key')
		expect(body.prompt_cache_retention).toBe('24h')
		expect(body.service_tier).toBe('priority')
		expect(body.truncation).toBe('auto')
		expect(body.user).toBe('user_123')
		expect(body.metadata).toEqual({ source: 'test' })
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

	test('serializes assistant reasoning with item ids and encrypted content', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [
							{
								type: 'reasoning',
								text: 'Think first',
								providerOptions: {
									openai: {
										itemId: 'rs_123',
										reasoningEncryptedContent: 'enc_123',
									},
								},
							},
						],
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.input).toEqual([
			{
				type: 'reasoning',
				id: 'rs_123',
				encrypted_content: 'enc_123',
				summary: [{ type: 'summary_text', text: 'Think first' }],
			},
		])
	})

	test('serializes assistant reasoning from provider metadata for persisted follow-up turns', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [
							{
								type: 'reasoning',
								text: 'Persisted thought',
								providerMetadata: {
									openai: {
										itemId: 'rs_persisted',
										reasoningEncryptedContent: 'enc_persisted',
									},
								},
							},
						],
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.input).toEqual([
			{
				type: 'reasoning',
				id: 'rs_persisted',
				encrypted_content: 'enc_persisted',
				summary: [{ type: 'summary_text', text: 'Persisted thought' }],
			},
		])
	})
})
