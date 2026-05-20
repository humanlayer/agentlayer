import { describe, expect, test } from 'bun:test'
import { buildCodexRequestBody, normalizeCodexServiceTier } from '../src/codex'

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
		expect(body.previous_response_id).toBeUndefined()
		expect(body.max_tool_calls).toBe(2)
		expect(body.prompt_cache_key).toBe('cache-key')
		expect(body.prompt_cache_retention).toBe('24h')
		expect(body.service_tier).toBe('priority')
		expect(body.truncation).toBe('auto')
		expect(body.user).toBe('user_123')
		expect(body.metadata).toEqual({ source: 'test' })
		expect(body).not.toHaveProperty('max_output_tokens')
	})

	test('ignores store overrides because the Codex endpoint requires store false', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Think then answer.' }] }],
				providerOptions: {
					openai: {
						store: true,
					},
				},
			},
			'gpt-5.4',
		)

		expect(body.store).toBe(false)
	})

	test('enables Codex fast mode from provider options', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use fast mode' }] }],
				providerOptions: {
					codex: {
						fastMode: true,
					},
				},
			},
			'gpt-5.4',
		)

		expect(body.service_tier).toBe('priority')
	})

	test('enables Codex fast mode from provider defaults', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use fast mode' }] }],
			},
			'gpt-5.4',
			{ fastMode: true },
		)

		expect(body.service_tier).toBe('priority')
	})

	test('normalizes fast service tier alias to Codex priority service tier', () => {
		expect(normalizeCodexServiceTier('fast')).toBe('priority')
		expect(normalizeCodexServiceTier('priority')).toBe('priority')
		expect(normalizeCodexServiceTier('flex')).toBe('flex')
		expect(normalizeCodexServiceTier(null)).toBeNull()
		expect(normalizeCodexServiceTier(undefined)).toBeUndefined()
	})

	test('explicit service tier takes precedence over fast mode', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use flex' }] }],
				providerOptions: {
					openai: {
						fastMode: true,
						serviceTier: 'flex',
					},
				},
			},
			'gpt-5.4',
			{ fastMode: true },
		)

		expect(body.service_tier).toBe('flex')
	})

	test('serializes function tools for Codex requests', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'Patch a file.' }] }],
				tools: [
					{
						type: 'function',
						name: 'apply_patch',
						description: 'Apply a patch to files.',
						inputSchema: {
							type: 'object',
							properties: { patch_text: { type: 'string' } },
							required: ['patch_text'],
						},
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.tools).toEqual([
			{
				type: 'function',
				name: 'apply_patch',
				description: 'Apply a patch to files.',
				parameters: {
					type: 'object',
					properties: { patch_text: { type: 'string' } },
					required: ['patch_text'],
				},
			},
		])
	})

	test('replays assistant text with its Codex item id instead of using item references', () => {
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

		expect(body.input).toEqual([
			{ role: 'assistant', content: [{ type: 'output_text', text: 'Stored content' }], id: 'msg_123' },
		])
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

	test('serializes multimodal tool outputs for Codex requests', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'tool',
						content: [
							{
								type: 'tool-result',
								toolCallId: 'call_image',
								toolName: 'read',
								output: {
									type: 'content',
									value: [
										{ type: 'text', text: 'Read image.png' },
										{ type: 'image-data', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
										{
											type: 'file-data',
											data: 'JVBERi0=',
											mediaType: 'application/pdf',
											filename: 'doc.pdf',
										},
									],
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
				type: 'function_call_output',
				call_id: 'call_image',
				output: [
					{ type: 'input_text', text: 'Read image.png' },
					{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
					{ type: 'input_file', filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
				],
			},
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
								providerOptions: {
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
				encrypted_content: 'enc_persisted',
				summary: [{ type: 'summary_text', text: 'Persisted thought' }],
			},
		])
	})

	test('replays assistant text with its item id', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: 'Earlier answer',
								providerOptions: {
									openai: {
										itemId: 'msg_from_history',
									},
								},
							},
						],
					},
					{
						role: 'user',
						content: [{ type: 'text', text: 'Follow up' }],
					},
				],
			},
			'gpt-5.4',
		)

		expect(body.input).toEqual([
			{ role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }], id: 'msg_from_history' },
			{ role: 'user', content: [{ type: 'input_text', text: 'Follow up' }] },
		])
	})

	test('does not send explicit previousResponseId to the Codex endpoint', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [{ type: 'text', text: 'Earlier answer' }],
						providerOptions: {
							openai: {
								responseId: 'resp_from_history',
							},
						},
					},
				],
				providerOptions: {
					openai: {
						previousResponseId: 'resp_explicit',
					},
				},
			},
			'gpt-5.4',
		)

		expect(body.previous_response_id).toBeUndefined()
	})

	test('replays function calls with their item id', () => {
		const body = buildCodexRequestBody(
			{
				prompt: [
					{
						role: 'assistant',
						content: [
							{
								type: 'tool-call',
								toolCallId: 'call_123',
								toolName: 'search',
								input: { query: 'test' },
								providerOptions: {
									openai: {
										itemId: 'fc_123',
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
				type: 'function_call',
				call_id: 'call_123',
				name: 'search',
				arguments: JSON.stringify({ query: 'test' }),
				id: 'fc_123',
			},
		])
	})
})
