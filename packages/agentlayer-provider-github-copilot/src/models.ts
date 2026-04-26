import type { FetchFunction } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import type { CopilotModelDefinition, CopilotModelMap } from './types'

export const copilotModelsResponseSchema = z.object({
	data: z.array(
		z.object({
			model_picker_enabled: z.boolean(),
			id: z.string(),
			name: z.string(),
			version: z.string(),
			supported_endpoints: z.array(z.string()).optional(),
			policy: z
				.object({
					state: z.string().optional(),
				})
				.optional(),
			capabilities: z.object({
				family: z.string(),
				limits: z.object({
					max_context_window_tokens: z.number(),
					max_output_tokens: z.number(),
					max_prompt_tokens: z.number(),
					vision: z
						.object({
							max_prompt_image_size: z.number(),
							max_prompt_images: z.number(),
							supported_media_types: z.array(z.string()),
						})
						.optional(),
				}),
				supports: z.object({
					adaptive_thinking: z.boolean().optional(),
					max_thinking_budget: z.number().optional(),
					min_thinking_budget: z.number().optional(),
					reasoning_effort: z.array(z.string()).optional(),
					streaming: z.boolean(),
					structured_outputs: z.boolean().optional(),
					tool_calls: z.boolean(),
					vision: z.boolean().optional(),
				}),
			}),
		}),
	),
})

type RemoteCopilotModel = z.infer<typeof copilotModelsResponseSchema>['data'][number]

function buildModel(
	key: string,
	remote: RemoteCopilotModel,
	url: string,
	prev?: CopilotModelDefinition,
): CopilotModelDefinition {
	const reasoning =
		Boolean(remote.capabilities.supports.adaptive_thinking) ||
		Boolean(remote.capabilities.supports.reasoning_effort?.length) ||
		remote.capabilities.supports.max_thinking_budget !== undefined ||
		remote.capabilities.supports.min_thinking_budget !== undefined
	const image =
		(remote.capabilities.supports.vision ?? false) ||
		(remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith('image/'))

	const isMessagesApi = remote.supported_endpoints?.includes('/v1/messages') ?? false

	return {
		id: key,
		providerID: 'github-copilot',
		api: {
			id: remote.id,
			url: isMessagesApi ? `${url}/v1` : url,
			npm: isMessagesApi ? '@ai-sdk/anthropic' : '@ai-sdk/github-copilot',
		},
		status: 'active',
		limit: {
			context: remote.capabilities.limits.max_context_window_tokens,
			input: remote.capabilities.limits.max_prompt_tokens,
			output: remote.capabilities.limits.max_output_tokens,
		},
		capabilities: {
			temperature: prev?.capabilities.temperature ?? true,
			reasoning: prev?.capabilities.reasoning ?? reasoning,
			attachment: prev?.capabilities.attachment ?? true,
			toolcall: remote.capabilities.supports.tool_calls,
			input: {
				text: true,
				audio: false,
				image,
				video: false,
				pdf: false,
			},
			output: {
				text: true,
				audio: false,
				image: false,
				video: false,
				pdf: false,
			},
			interleaved: false,
		},
		family: prev?.family ?? remote.capabilities.family,
		name: prev?.name ?? remote.name,
		cost: {
			input: 0,
			output: 0,
			cache: { read: 0, write: 0 },
		},
		options: prev?.options ?? {},
		headers: prev?.headers ?? {},
		release_date:
			prev?.release_date ??
			(remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
		variants: prev?.variants ?? {},
	}
}

export async function getCopilotModels(
	baseURL: string,
	headers: RequestInit['headers'] = {},
	existing: CopilotModelMap = {},
	fetchFn: FetchFunction = fetch,
): Promise<CopilotModelMap> {
	const data = await fetchFn(`${baseURL}/models`, {
		headers,
		signal: AbortSignal.timeout(5_000),
	}).then(async (response) => {
		if (!response.ok) {
			throw new Error(`Failed to fetch models: ${response.status}`)
		}
		return copilotModelsResponseSchema.parse(await response.json())
	})

	const result: CopilotModelMap = { ...existing }
	const remote = new Map(
		data.data
			.filter((model) => model.model_picker_enabled && model.policy?.state !== 'disabled')
			.map((model) => [model.id, model] as const),
	)

	for (const [key, model] of Object.entries(result)) {
		const remoteModel = remote.get(model.api.id)
		if (!remoteModel) {
			delete result[key]
			continue
		}
		result[key] = buildModel(key, remoteModel, baseURL, model)
	}

	for (const [id, model] of remote) {
		if (id in result) continue
		result[id] = buildModel(id, model, baseURL)
	}

	return result
}
