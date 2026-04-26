import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import { createMemoryAuthStore } from '@humanlayer/agentlayer-provider-auth'
import {
	buildCopilotRequest,
	createCopilotLanguageModel,
	createCopilotProvider,
	listCopilotModels,
	SYNTHETIC_ATTACHMENT_PROMPT,
	shouldUseCopilotResponsesApi,
} from '../src'

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'agentlayer-copilot-'))
}

describe('copilot provider', () => {
	test('createCopilotProvider defaults to the disk-backed auth store', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		await fs.writeFile(
			filePath,
			JSON.stringify({
				copilot: {
					kind: 'oauth',
					accessToken: 'access-token',
					refreshToken: 'disk-copilot-token',
					expiresAt: 0,
				},
			}),
		)
		const previousAuthPath = process.env.AGENTLAYER_AUTH_PATH
		process.env.AGENTLAYER_AUTH_PATH = filePath
		const requests: Array<{ url: string; init?: RequestInit }> = []

		try {
			const model = createCopilotProvider({
				version: '1.2.3',
				fetch: (async (input, init) => {
					requests.push({ url: String(input), init })
					return Response.json({
						id: 'chatcmpl_disk',
						created: 1,
						model: 'gpt-4.1',
						object: 'chat.completion',
						choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})
				}) as FetchFunction,
			}).languageModel('gpt-4.1')

			const result = await model.doGenerate({
				prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
			})

			expect(result.content).toEqual([{ type: 'text', text: 'pong', providerMetadata: undefined }])
			expect(requests).toHaveLength(1)
			const headers = new Headers(requests[0]?.init?.headers)
			expect(headers.get('Authorization')).toBe('Bearer disk-copilot-token')
			expect(headers.get('User-Agent')).toBe('opencode/1.2.3')
		} finally {
			if (previousAuthPath === undefined) {
				delete process.env.AGENTLAYER_AUTH_PATH
			} else {
				process.env.AGENTLAYER_AUTH_PATH = previousAuthPath
			}
		}
	})

	test('listCopilotModels defaults to the disk-backed auth store', async () => {
		const dir = await makeTempDir()
		const filePath = path.join(dir, 'auth.json')
		await fs.writeFile(
			filePath,
			JSON.stringify({
				copilot: {
					kind: 'oauth',
					accessToken: 'access-token',
					refreshToken: 'disk-copilot-token',
					expiresAt: 0,
				},
			}),
		)
		const previousAuthPath = process.env.AGENTLAYER_AUTH_PATH
		process.env.AGENTLAYER_AUTH_PATH = filePath

		try {
			const models = await listCopilotModels({
				version: '1.2.3',
				fetch: (async (input, init) => {
					expect(String(input)).toBe('https://api.githubcopilot.com/models')
					const headers = new Headers(init?.headers)
					expect(headers.get('Authorization')).toBe('Bearer disk-copilot-token')
					expect(headers.get('User-Agent')).toBe('opencode/1.2.3')
					return Response.json({ data: [] })
				}) as FetchFunction,
			})

			expect(models).toEqual({})
		} finally {
			if (previousAuthPath === undefined) {
				delete process.env.AGENTLAYER_AUTH_PATH
			} else {
				process.env.AGENTLAYER_AUTH_PATH = previousAuthPath
			}
		}
	})

	test('creates chat and responses language models based on model id', () => {
		const authStore = createMemoryAuthStore()
		const provider = createCopilotProvider({ authStore })

		expect(provider.specificationVersion).toBe('v3')
		expect(provider.languageModel('gpt-4.1').provider).toBe('github-copilot.chat')
		expect(provider.languageModel('gpt-5').provider).toBe('github-copilot.responses')
		expect(createCopilotLanguageModel({ authStore, modelId: 'gpt-5-mini' }).provider).toBe('github-copilot.chat')
		expect(shouldUseCopilotResponsesApi('gpt-5')).toBe(true)
		expect(shouldUseCopilotResponsesApi('gpt-5-mini')).toBe(false)
	})

	test('injects Copilot auth headers and strips caller authorization headers', async () => {
		const authStore = createMemoryAuthStore({
			'github-copilot': {
				kind: 'oauth',
				accessToken: 'access-token',
				refreshToken: 'copilot-api-token',
				expiresAt: 0,
			},
		})

		const request = await buildCopilotRequest({
			input: '/chat/completions',
			init: {
				headers: {
					Authorization: 'Bearer caller-token',
					'x-api-key': 'caller-key',
					'x-extra': 'kept',
				},
				body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
			},
			authStore,
			providerId: 'github-copilot',
			version: '1.2.3',
		})

		const headers = new Headers(request.init.headers)
		expect(request.input).toBe('https://api.githubcopilot.com/chat/completions')
		expect(headers.get('Authorization')).toBe('Bearer copilot-api-token')
		expect(headers.get('x-api-key')).toBeNull()
		expect(headers.get('x-extra')).toBe('kept')
		expect(headers.get('Openai-Intent')).toBe('conversation-edits')
		expect(headers.get('x-initiator')).toBe('user')
		expect(headers.get('User-Agent')).toBe('opencode/1.2.3')
		expect(request.context).toMatchObject({
			baseURL: 'https://api.githubcopilot.com',
			intent: 'conversation-edits',
			initiator: 'user',
			isVision: false,
		})
	})

	test('supports enterprise base URL, agent initiator, and vision requests', async () => {
		const authStore = createMemoryAuthStore({
			'github-copilot': {
				kind: 'oauth',
				accessToken: 'enterprise-token',
				expiresAt: 0,
				enterpriseUrl: 'https://company.ghe.com',
			} as any,
		})

		const request = await buildCopilotRequest({
			input: '/responses',
			init: {
				body: JSON.stringify({
					input: [
						{
							role: 'user',
							content: [
								{ type: 'input_text', text: SYNTHETIC_ATTACHMENT_PROMPT },
								{ type: 'input_image', image_url: 'data:image/png;base64,AA==' },
							],
						},
					],
				}),
			},
			authStore,
			providerId: 'github-copilot',
		})

		const headers = new Headers(request.init.headers)
		expect(request.input).toBe('https://copilot-api.company.ghe.com/responses')
		expect(headers.get('Authorization')).toBe('Bearer enterprise-token')
		expect(headers.get('x-initiator')).toBe('agent')
		expect(headers.get('Copilot-Vision-Request')).toBe('true')
		expect(request.context).toMatchObject({
			baseURL: 'https://copilot-api.company.ghe.com',
			initiator: 'agent',
			isVision: true,
		})
	})

	test('passes authenticated requests through the SDK fetch wrapper', async () => {
		const authStore = createMemoryAuthStore({
			'github-copilot': {
				kind: 'oauth',
				accessToken: 'access-token',
				refreshToken: 'copilot-api-token',
				expiresAt: 0,
			},
		})
		const requests: Array<{ url: string; init?: RequestInit }> = []
		const model = createCopilotLanguageModel({
			authStore,
			modelId: 'gpt-4.1',
			version: '1.2.3',
			fetch: (async (input, init) => {
				requests.push({ url: String(input), init })
				return Response.json({
					id: 'chatcmpl_1',
					created: 1,
					model: 'gpt-4.1',
					object: 'chat.completion',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})
			}) as FetchFunction,
		})

		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
		})

		expect(result.content).toEqual([{ type: 'text', text: 'pong', providerMetadata: undefined }])
		expect(requests).toHaveLength(1)
		expect(requests[0]?.url).toBe('https://api.githubcopilot.com/chat/completions')
		const headers = new Headers(requests[0]?.init?.headers)
		expect(headers.get('Authorization')).toBe('Bearer copilot-api-token')
		expect(headers.get('Openai-Intent')).toBe('conversation-edits')
		expect(headers.get('x-initiator')).toBe('user')
	})

	test('lists models using auth from the shared store', async () => {
		const authStore = createMemoryAuthStore({
			'github-copilot': {
				kind: 'oauth',
				accessToken: 'access-token',
				refreshToken: 'copilot-api-token',
				expiresAt: 0,
			},
		})

		const models = await listCopilotModels({
			authStore,
			version: '1.2.3',
			fetch: (async (input, init) => {
				expect(String(input)).toBe('https://api.githubcopilot.com/models')
				const headers = new Headers(init?.headers)
				expect(headers.get('Authorization')).toBe('Bearer copilot-api-token')
				expect(headers.get('User-Agent')).toBe('opencode/1.2.3')
				return Response.json({
					data: [
						{
							model_picker_enabled: true,
							id: 'gpt-4.1',
							name: 'GPT-4.1',
							version: 'gpt-4.1-2025-04-14',
							policy: { state: 'enabled' },
							capabilities: {
								family: 'gpt-4.1',
								limits: {
									max_context_window_tokens: 128000,
									max_output_tokens: 4096,
									max_prompt_tokens: 127000,
								},
								supports: { streaming: true, tool_calls: true },
							},
						},
					],
				})
			}) as FetchFunction,
		})

		expect(models['gpt-4.1']?.api.url).toBe('https://api.githubcopilot.com')
		expect(models['gpt-4.1']?.providerID).toBe('github-copilot')
	})
})
