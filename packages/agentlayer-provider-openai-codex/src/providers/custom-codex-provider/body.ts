import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { strictifySchema } from '../../shared/schema'

export function convertPromptToBody(modelId: string, options: LanguageModelV3CallOptions): Record<string, unknown> {
	const input: Record<string, unknown>[] = []
	const systemTexts: string[] = []

	for (const message of options.prompt) {
		switch (message.role) {
			case 'system': {
				systemTexts.push(message.content)
				break
			}
			case 'user': {
				const content: Record<string, unknown>[] = []
				for (const part of message.content) {
					if (part.type === 'text') {
						content.push({ type: 'input_text', text: part.text })
					} else if (part.type === 'file' && part.mediaType.startsWith('image/')) {
						if (part.data instanceof URL) {
							content.push({ type: 'input_image', image_url: part.data.toString() })
						} else if (typeof part.data === 'string') {
							content.push({
								type: 'input_image',
								image_url: `data:${part.mediaType};base64,${part.data}`,
							})
						}
					}
				}
				input.push({ role: 'user', content })
				break
			}
			case 'assistant': {
				const content: Record<string, unknown>[] = []
				const toolCalls: Record<string, unknown>[] = []
				for (const part of message.content) {
					switch (part.type) {
						case 'text':
							content.push({ type: 'output_text', text: part.text })
							break
						case 'reasoning': {
							const openai = part.providerOptions?.openai as Record<string, unknown> | undefined
							const itemId = openai?.itemId as string | undefined
							if (!itemId) break
							const encryptedContent = openai?.reasoningEncryptedContent as string | null | undefined
							// store is always false for codex — drop items without encrypted_content
							if (typeof encryptedContent !== 'string') break
							input.push({
								type: 'reasoning',
								id: itemId,
								summary: part.text ? [{ type: 'summary_text', text: part.text }] : [],
								encrypted_content:
									typeof encryptedContent === 'string'
										? encryptedContent
										: encryptedContent === null
											? null
											: undefined,
							})
							break
						}
						case 'tool-call':
							toolCalls.push({
								type: 'function_call',
								name: part.toolName,
								call_id: part.toolCallId,
								arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
							})
							break
					}
				}
				if (content.length > 0) input.push({ role: 'assistant', content })
				for (const tc of toolCalls) input.push(tc)
				break
			}
			case 'tool': {
				for (const part of message.content) {
					if (part.type === 'tool-result') {
						const output =
							part.output.type === 'text'
								? part.output.value
								: part.output.type === 'json'
									? JSON.stringify(part.output.value)
									: JSON.stringify(part.output)
						input.push({
							type: 'function_call_output',
							call_id: part.toolCallId,
							output,
						})
					}
				}
				break
			}
		}
	}

	const tools: Record<string, unknown>[] = []
	if (options.tools) {
		for (const tool of options.tools) {
			if (tool.type === 'function') {
				const schema = structuredClone(tool.inputSchema) as Record<string, unknown>
				strictifySchema(schema)
				tools.push({
					type: 'function',
					name: tool.name,
					description: tool.description,
					parameters: schema,
					strict: true,
				})
			}
		}
	}

	const body: Record<string, unknown> = {
		model: modelId,
		input,
		stream: true,
		store: false,
		instructions: systemTexts.join('\n\n') || '',
	}

	if (tools.length > 0) body.tools = tools

	if (options.toolChoice) {
		switch (options.toolChoice.type) {
			case 'auto':
				body.tool_choice = 'auto'
				break
			case 'none':
				body.tool_choice = 'none'
				break
			case 'required':
				body.tool_choice = 'required'
				break
			case 'tool':
				body.tool_choice = { type: 'function', name: options.toolChoice.toolName }
				break
		}
	}

	if (options.temperature !== undefined) body.temperature = options.temperature
	if (options.topP !== undefined) body.top_p = options.topP
	if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens
	if (options.seed !== undefined) body.seed = options.seed

	const providerOptions = options.providerOptions?.openai as Record<string, unknown> | undefined
	const reasoningEffort = providerOptions?.reasoningEffort as string | undefined
	const reasoningSummary = providerOptions?.reasoningSummary as string | undefined
	const promptCacheKey = providerOptions?.promptCacheKey as string | undefined
	const serviceTier = providerOptions?.serviceTier as string | null | undefined
	const fastMode = providerOptions?.fastMode as boolean | undefined
	const include = providerOptions?.include as string[] | undefined

	body.reasoning = {
		effort: reasoningEffort ?? 'medium',
		summary: reasoningSummary ?? 'auto',
	}

	if (promptCacheKey) body.prompt_cache_key = promptCacheKey
	if (serviceTier !== undefined) body.service_tier = serviceTier
	else if (fastMode) body.service_tier = 'priority'
	if (include) body.include = include

	return body
}
