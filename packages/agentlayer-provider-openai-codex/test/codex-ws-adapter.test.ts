import { describe, expect, test } from 'bun:test'
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider'
import { webSocketRoute } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'
import * as AuthModule from '@humanlayer/opencode-llm-vendor/route/auth'
import {
	type AdapterConfig,
	buildCodexModel,
	convertCallOptionsToLLMRequest,
	convertPromptMessages,
	convertTools,
	mapProviderOptions,
	strictifySchema,
} from '../src/shared/adapter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<AdapterConfig>): AdapterConfig {
	return {
		auth: AuthModule.bearer('test-token'),
		baseURL: 'https://chatgpt.com/backend-api/codex',
		route: webSocketRoute,
		...overrides,
	}
}

function makeOptions(overrides?: Partial<LanguageModelV3CallOptions>): LanguageModelV3CallOptions {
	return {
		prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// strictifySchema
// ---------------------------------------------------------------------------

describe('strictifySchema', () => {
	test('adds required, additionalProperties, and removes format', () => {
		const schema: Record<string, unknown> = {
			type: 'object',
			format: 'custom',
			properties: {
				name: { type: 'string', format: 'email' },
				age: { type: 'number' },
			},
		}
		strictifySchema(schema)

		expect(schema.format).toBeUndefined()
		expect(schema.required).toEqual(['name', 'age'])
		expect(schema.additionalProperties).toBe(false)
		// Nested format should also be removed
		const props = schema.properties as Record<string, Record<string, unknown>>
		expect(props.name!.format).toBeUndefined()
	})

	test('handles array items', () => {
		const schema: Record<string, unknown> = {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					value: { type: 'string' },
				},
			},
		}
		strictifySchema(schema)

		const items = schema.items as Record<string, unknown>
		expect(items.required).toEqual(['value'])
		expect(items.additionalProperties).toBe(false)
	})

	test('handles anyOf', () => {
		const schema: Record<string, unknown> = {
			anyOf: [
				{ type: 'object', properties: { a: { type: 'string' } } },
				{ type: 'object', properties: { b: { type: 'number' } } },
			],
		}
		strictifySchema(schema)

		const anyOf = schema.anyOf as Record<string, unknown>[]
		expect(anyOf[0]!.required).toEqual(['a'])
		expect(anyOf[1]!.required).toEqual(['b'])
	})

	test('handles oneOf', () => {
		const schema: Record<string, unknown> = {
			oneOf: [{ type: 'object', properties: { x: { type: 'boolean' } } }],
		}
		strictifySchema(schema)

		const oneOf = schema.oneOf as Record<string, unknown>[]
		expect(oneOf[0]!.required).toEqual(['x'])
		expect(oneOf[0]!.additionalProperties).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// convertPromptMessages
// ---------------------------------------------------------------------------

describe('convertPromptMessages', () => {
	test('extracts system messages into SystemPart[]', () => {
		const prompt: LanguageModelV3Prompt = [
			{ role: 'system', content: 'You are a helpful assistant.' },
			{ role: 'system', content: 'Follow the rules.' },
			{ role: 'user', content: [{ type: 'text', text: 'Hello' }] },
		]

		const { system, messages } = convertPromptMessages(prompt)

		expect(system).toHaveLength(2)
		expect(system[0]!.type).toBe('text')
		expect(system[0]!.text).toBe('You are a helpful assistant.')
		expect(system[1]!.text).toBe('Follow the rules.')
		expect(messages).toHaveLength(1)
		expect(messages[0]!.role).toBe('user')
	})

	test('converts user text content', () => {
		const prompt: LanguageModelV3Prompt = [{ role: 'user', content: [{ type: 'text', text: 'Write code' }] }]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(1)
		expect(messages[0]!.content).toHaveLength(1)
		expect(messages[0]!.content[0]!.type).toBe('text')
		expect((messages[0]!.content[0] as { type: 'text'; text: string }).text).toBe('Write code')
	})

	test('converts user image content with base64 data', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages[0]!.content).toHaveLength(2)
		const imagePart = messages[0]!.content[1]!
		expect(imagePart.type).toBe('media')
		expect((imagePart as { type: 'media'; data: string }).data).toBe('data:image/png;base64,iVBORw0KGgo=')
	})

	test('converts user image content with URL', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'user',
				content: [{ type: 'file', data: new URL('https://example.com/image.png'), mediaType: 'image/png' }],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		const imagePart = messages[0]!.content[0]!
		expect(imagePart.type).toBe('media')
		expect((imagePart as { type: 'media'; data: string }).data).toBe('https://example.com/image.png')
	})

	test('converts assistant text content', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Here is the answer.' }],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(1)
		expect(messages[0]!.role).toBe('assistant')
		expect(messages[0]!.content[0]!.type).toBe('text')
	})

	test('converts assistant tool calls', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call_123',
						toolName: 'search',
						input: { query: 'test' },
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(1)
		const part = messages[0]!.content[0]!
		expect(part.type).toBe('tool-call')
		expect((part as { type: 'tool-call'; id: string; name: string }).id).toBe('call_123')
		expect((part as { type: 'tool-call'; name: string }).name).toBe('search')
		expect((part as { type: 'tool-call'; input: unknown }).input).toBe(JSON.stringify({ query: 'test' }))
	})

	test('converts assistant reasoning with encrypted content', () => {
		const prompt: LanguageModelV3Prompt = [
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
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(1)
		const part = messages[0]!.content[0]!
		expect(part.type).toBe('reasoning')
		expect((part as unknown as { text: string }).text).toBe('Think first')
		const metadata = (part as unknown as { providerMetadata: Record<string, Record<string, unknown>> })
			.providerMetadata
		expect(metadata.openai!.itemId).toBe('rs_123')
		expect(metadata.openai!.reasoningEncryptedContent).toBe('enc_123')
	})

	test('drops reasoning parts without itemId', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'No item id here',
						providerOptions: {},
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		// Empty assistant message should be dropped
		expect(messages).toHaveLength(0)
	})

	test('drops reasoning parts without encrypted content (store=false rule)', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'assistant',
				content: [
					{
						type: 'reasoning',
						text: 'Has item id but no encrypted content',
						providerOptions: {
							openai: {
								itemId: 'rs_123',
								// no reasoningEncryptedContent
							},
						},
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(0)
	})

	test('converts tool result messages', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call_123',
						toolName: 'search',
						output: { type: 'text', value: 'Found results' },
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		expect(messages).toHaveLength(1)
		expect(messages[0]!.role).toBe('tool')
		const part = messages[0]!.content[0]!
		expect(part.type).toBe('tool-result')
		expect((part as { id: string }).id).toBe('call_123')
	})

	test('converts tool result with JSON output', () => {
		const prompt: LanguageModelV3Prompt = [
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call_456',
						toolName: 'fetch',
						output: { type: 'json', value: { status: 200, body: 'ok' } },
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		const part = messages[0]!.content[0] as { type: 'tool-result'; result: { type: string; value: unknown } }
		expect(part.result.type).toBe('json')
		expect(part.result.value).toEqual({ status: 200, body: 'ok' })
	})

	test('converts multimodal tool result content to vendor media parts', () => {
		const prompt: LanguageModelV3Prompt = [
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
							],
						},
					},
				],
			},
		]

		const { messages } = convertPromptMessages(prompt)

		const part = messages[0]!.content[0] as { type: 'tool-result'; result: { type: string; value: unknown } }
		expect(part.result).toEqual({
			type: 'content',
			value: [
				{ type: 'text', text: 'Read image.png' },
				{ type: 'media', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
			],
		})
	})
})

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

describe('convertTools', () => {
	test('converts function tools with schema strictification', () => {
		const tools: LanguageModelV3CallOptions['tools'] = [
			{
				type: 'function',
				name: 'search',
				description: 'Search for files',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', format: 'custom' },
						limit: { type: 'number' },
					},
				},
			},
		]

		const result = convertTools(tools)

		expect(result).toHaveLength(1)
		expect(result[0]!.name).toBe('search')
		expect(result[0]!.description).toBe('Search for files')
		// strictifySchema should have set required and additionalProperties
		expect(result[0]!.inputSchema.required).toEqual(['query', 'limit'])
		expect(result[0]!.inputSchema.additionalProperties).toBe(false)
		// format should be removed from the query property
		const props = result[0]!.inputSchema.properties as Record<string, Record<string, unknown>>
		expect(props.query!.format).toBeUndefined()
	})

	test('returns empty array for undefined tools', () => {
		expect(convertTools(undefined)).toEqual([])
	})

	test('skips non-function tools', () => {
		const tools: LanguageModelV3CallOptions['tools'] = [
			{
				type: 'provider',
				id: 'openai.web_search',
				name: 'web_search',
				args: {},
			},
		]

		const result = convertTools(tools)

		expect(result).toHaveLength(0)
	})

	test('handles tools without description', () => {
		const tools: LanguageModelV3CallOptions['tools'] = [
			{
				type: 'function',
				name: 'noop',
				inputSchema: { type: 'object', properties: {} },
			},
		]

		const result = convertTools(tools)

		expect(result).toHaveLength(1)
		expect(result[0]!.description).toBe('')
	})
})

// ---------------------------------------------------------------------------
// mapProviderOptions
// ---------------------------------------------------------------------------

describe('mapProviderOptions', () => {
	test('sets defaults: reasoningEffort medium, reasoningSummary detailed, store false, include reasoning.encrypted_content', () => {
		const config = makeConfig()
		const options = makeOptions()

		const result = mapProviderOptions(options, config)

		expect(result.openai).toBeDefined()
		expect(result.openai!.reasoningEffort).toBe('medium')
		expect(result.openai!.reasoningSummary).toBe('detailed')
		expect(result.openai!.store).toBe(false)
		expect(result.openai!.include).toEqual(['reasoning.encrypted_content'])
	})

	test('passes through explicit reasoningEffort from provider options', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { reasoningEffort: 'high' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.reasoningEffort).toBe('high')
	})

	test('passes through explicit reasoningSummary from provider options (overrides default)', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { reasoningSummary: 'auto' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.reasoningSummary).toBe('auto')
	})

	test('always forces store to false regardless of provider options', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { store: true } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.store).toBe(false)
	})

	test('passes through promptCacheKey from provider options', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { promptCacheKey: 'session-abc' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.promptCacheKey).toBe('session-abc')
	})

	test('normalizes service_tier "fast" to "priority"', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { serviceTier: 'fast' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('priority')
	})

	test('passes through explicit service_tier "flex" unchanged', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { serviceTier: 'flex' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('flex')
	})

	test('applies fastMode from config when no explicit serviceTier', () => {
		const config = makeConfig({ fastMode: true })
		const options = makeOptions()

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('priority')
	})

	test('applies fastMode from provider options over config', () => {
		const config = makeConfig({ fastMode: false })
		const options = makeOptions({
			providerOptions: { openai: { fastMode: true } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('priority')
	})

	test('explicit serviceTier takes precedence over fastMode', () => {
		const config = makeConfig({ fastMode: true })
		const options = makeOptions({
			providerOptions: { openai: { serviceTier: 'flex' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('flex')
	})

	test('config serviceTier takes precedence over config fastMode', () => {
		const config = makeConfig({ serviceTier: 'flex', fastMode: true })
		const options = makeOptions()

		const result = mapProviderOptions(options, config)

		expect(result.openai!.serviceTier).toBe('flex')
	})

	test('passes through instructions from provider options', () => {
		const config = makeConfig()
		const options = makeOptions({
			providerOptions: { openai: { instructions: 'Be concise' } },
		})

		const result = mapProviderOptions(options, config)

		expect(result.openai!.instructions).toBe('Be concise')
	})
})

// ---------------------------------------------------------------------------
// buildCodexModel
// ---------------------------------------------------------------------------

describe('buildCodexModel', () => {
	test('creates a Model with the correct modelId', () => {
		const auth = AuthModule.bearer('test-token')
		const model = buildCodexModel('gpt-5.4', auth, 'https://chatgpt.com/backend-api/codex', webSocketRoute)

		expect(String(model.id)).toBe('gpt-5.4')
		expect(String(model.provider)).toBe('openai')
	})

	test('creates a Model with a patched webSocketRoute', () => {
		const auth = AuthModule.bearer('test-token')
		const model = buildCodexModel('gpt-5.4', auth, 'https://chatgpt.com/backend-api/codex', webSocketRoute)

		// The route should be the WebSocket route (patched from the vendor)
		expect(model.route).toBeDefined()
		expect(model.route.id).toBe('openai-responses-websocket')
	})

	test('patches endpoint baseURL on the route', () => {
		const auth = AuthModule.bearer('test-token')
		const model = buildCodexModel('gpt-5.4', auth, 'https://custom.example.com/api', webSocketRoute)

		// The endpoint should have the custom base URL
		expect(model.route.endpoint.baseURL).toBe('https://custom.example.com/api')
	})
})

// ---------------------------------------------------------------------------
// convertCallOptionsToLLMRequest
// ---------------------------------------------------------------------------

describe('convertCallOptionsToLLMRequest', () => {
	test('produces a valid LLMRequest from basic options', () => {
		const config = makeConfig()
		const options = makeOptions({
			prompt: [
				{ role: 'system', content: 'Be helpful.' },
				{ role: 'user', content: [{ type: 'text', text: 'Hello' }] },
			],
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(String(request.model.id)).toBe('gpt-5.4')
		// System messages are merged into providerOptions.openai.instructions
		// so Codex receives them as top-level `instructions` rather than input items
		expect(request.system).toHaveLength(0)
		expect((request.providerOptions as any)?.openai?.instructions).toBe('Be helpful.')
		expect(request.messages).toHaveLength(1)
		expect(request.messages[0]!.role).toBe('user')
		expect(request.tools).toHaveLength(0)
	})

	test('includes tools and toolChoice', () => {
		const config = makeConfig()
		const options = makeOptions({
			tools: [
				{
					type: 'function',
					name: 'search',
					description: 'Search',
					inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
				},
			],
			toolChoice: { type: 'auto' },
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(request.tools).toHaveLength(1)
		expect(request.tools[0]!.name).toBe('search')
		expect(request.toolChoice).toBeDefined()
		expect(request.toolChoice!.type).toBe('auto')
	})

	test('maps tool choice "required"', () => {
		const config = makeConfig()
		const options = makeOptions({
			toolChoice: { type: 'required' },
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)
		expect(request.toolChoice!.type).toBe('required')
	})

	test('maps tool choice "none"', () => {
		const config = makeConfig()
		const options = makeOptions({
			toolChoice: { type: 'none' },
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)
		expect(request.toolChoice!.type).toBe('none')
	})

	test('maps tool choice "tool" with tool name', () => {
		const config = makeConfig()
		const options = makeOptions({
			toolChoice: { type: 'tool', toolName: 'search' },
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)
		expect(request.toolChoice!.type).toBe('tool')
		expect(request.toolChoice!.name).toBe('search')
	})

	test('maps generation options from call options', () => {
		const config = makeConfig()
		const options = makeOptions({
			temperature: 0.7,
			topP: 0.9,
			maxOutputTokens: 4096,
			seed: 42,
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(request.generation?.temperature).toBe(0.7)
		expect(request.generation?.topP).toBe(0.9)
		expect(request.generation?.maxTokens).toBe(4096)
		expect(request.generation?.seed).toBe(42)
	})

	test('sets providerOptions with defaults', () => {
		const config = makeConfig()
		const options = makeOptions()

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(request.providerOptions).toBeDefined()
		expect(request.providerOptions!.openai).toBeDefined()
		expect(request.providerOptions!.openai!.reasoningEffort).toBe('medium')
		expect(request.providerOptions!.openai!.reasoningSummary).toBe('detailed')
		expect(request.providerOptions!.openai!.store).toBe(false)
		expect(request.providerOptions!.openai!.include).toEqual(['reasoning.encrypted_content'])
	})

	test('handles fastMode in config by setting serviceTier to priority', () => {
		const config = makeConfig({ fastMode: true })
		const options = makeOptions()

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(request.providerOptions!.openai!.serviceTier).toBe('priority')
	})

	test('full round-trip: system + user + assistant + tool messages with tools', () => {
		const config = makeConfig()
		const options = makeOptions({
			prompt: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: [{ type: 'text', text: 'Search for X' }] },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool-call',
							toolCallId: 'call_1',
							toolName: 'search',
							input: { query: 'X' },
						},
					],
				},
				{
					role: 'tool',
					content: [
						{
							type: 'tool-result',
							toolCallId: 'call_1',
							toolName: 'search',
							output: { type: 'text', value: 'Found X' },
						},
					],
				},
			],
			tools: [
				{
					type: 'function',
					name: 'search',
					description: 'Search for things',
					inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
				},
			],
		})

		const request = convertCallOptionsToLLMRequest('gpt-5.4', options, config)

		expect(request.system).toHaveLength(0) // system merged into instructions
		expect(request.messages).toHaveLength(3) // user, assistant, tool
		expect(request.tools).toHaveLength(1)
		expect(request.messages[0]!.role).toBe('user')
		expect(request.messages[1]!.role).toBe('assistant')
		expect(request.messages[2]!.role).toBe('tool')
	})
})
