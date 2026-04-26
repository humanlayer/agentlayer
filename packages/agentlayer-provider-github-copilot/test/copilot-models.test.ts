import { describe, expect, test } from 'bun:test'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { CopilotModelMap } from '../src'
import { getCopilotModels } from '../src'

describe('copilot model discovery', () => {
	test('shapes remote models into the local neutral type', async () => {
		const existing: CopilotModelMap = {
			'gpt-5': {
				id: 'gpt-5',
				providerID: 'github-copilot',
				api: {
					id: 'gpt-5',
					url: 'https://old.example.com',
					npm: '@ai-sdk/github-copilot',
				},
				status: 'active',
				limit: { context: 1, input: 1, output: 1 },
				capabilities: {
					temperature: false,
					reasoning: false,
					attachment: false,
					toolcall: false,
					input: { text: true, audio: false, image: false, video: false, pdf: false },
					output: { text: true, audio: false, image: false, video: false, pdf: false },
					interleaved: false,
				},
				family: 'existing-family',
				name: 'Existing GPT-5',
				cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
				options: { existing: true },
				headers: { 'x-existing': '1' },
				release_date: '2025-01-01',
				variants: { preview: true },
			},
			removed: {
				id: 'removed',
				providerID: 'github-copilot',
				api: {
					id: 'no-longer-remote',
					url: 'https://old.example.com',
					npm: '@ai-sdk/github-copilot',
				},
				status: 'active',
				limit: { context: 1, input: 1, output: 1 },
				capabilities: {
					temperature: true,
					reasoning: false,
					attachment: true,
					toolcall: false,
					input: { text: true, audio: false, image: false, video: false, pdf: false },
					output: { text: true, audio: false, image: false, video: false, pdf: false },
					interleaved: false,
				},
				family: 'removed-family',
				name: 'Removed',
				cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
				options: {},
				headers: {},
				release_date: '2025-01-01',
				variants: {},
			},
		}

		const models = await getCopilotModels(
			'https://api.githubcopilot.com',
			{ Authorization: 'Bearer token' },
			existing,
			(async (input, init) => {
				expect(String(input)).toBe('https://api.githubcopilot.com/models')
				expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token')
				return Response.json({
					data: [
						{
							model_picker_enabled: true,
							id: 'gpt-5',
							name: 'GPT-5',
							version: 'gpt-5-2026-01-15',
							supported_endpoints: ['/responses'],
							policy: { state: 'enabled' },
							capabilities: {
								family: 'gpt-5',
								limits: {
									max_context_window_tokens: 1000,
									max_output_tokens: 200,
									max_prompt_tokens: 800,
									vision: {
										max_prompt_image_size: 1,
										max_prompt_images: 3,
										supported_media_types: ['image/png'],
									},
								},
								supports: {
									adaptive_thinking: true,
									streaming: true,
									structured_outputs: true,
									tool_calls: true,
									vision: true,
								},
							},
						},
						{
							model_picker_enabled: true,
							id: 'claude-sonnet-4',
							name: 'Claude Sonnet 4',
							version: 'claude-sonnet-4-2026-02-01',
							supported_endpoints: ['/v1/messages'],
							policy: { state: 'enabled' },
							capabilities: {
								family: 'claude',
								limits: {
									max_context_window_tokens: 500,
									max_output_tokens: 100,
									max_prompt_tokens: 400,
								},
								supports: {
									streaming: true,
									tool_calls: true,
								},
							},
						},
						{
							model_picker_enabled: false,
							id: 'hidden-model',
							name: 'Hidden Model',
							version: 'hidden-model-2026-01-01',
							capabilities: {
								family: 'hidden',
								limits: {
									max_context_window_tokens: 1,
									max_output_tokens: 1,
									max_prompt_tokens: 1,
								},
								supports: {
									streaming: true,
									tool_calls: false,
								},
							},
						},
					],
				})
			}) as FetchFunction,
		)

		expect(Object.keys(models).sort()).toEqual(['claude-sonnet-4', 'gpt-5'])
		expect(models['gpt-5']).toEqual({
			id: 'gpt-5',
			providerID: 'github-copilot',
			api: {
				id: 'gpt-5',
				url: 'https://api.githubcopilot.com',
				npm: '@ai-sdk/github-copilot',
			},
			status: 'active',
			limit: { context: 1000, input: 800, output: 200 },
			capabilities: {
				temperature: false,
				reasoning: false,
				attachment: false,
				toolcall: true,
				input: { text: true, audio: false, image: true, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
				interleaved: false,
			},
			family: 'existing-family',
			name: 'Existing GPT-5',
			cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
			options: { existing: true },
			headers: { 'x-existing': '1' },
			release_date: '2025-01-01',
			variants: { preview: true },
		})
		expect(models['claude-sonnet-4']).toEqual({
			id: 'claude-sonnet-4',
			providerID: 'github-copilot',
			api: {
				id: 'claude-sonnet-4',
				url: 'https://api.githubcopilot.com/v1',
				npm: '@ai-sdk/anthropic',
			},
			status: 'active',
			limit: { context: 500, input: 400, output: 100 },
			capabilities: {
				temperature: true,
				reasoning: false,
				attachment: true,
				toolcall: true,
				input: { text: true, audio: false, image: false, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
				interleaved: false,
			},
			family: 'claude',
			name: 'Claude Sonnet 4',
			cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
			options: {},
			headers: {},
			release_date: '2026-02-01',
			variants: {},
		})
	})
})
