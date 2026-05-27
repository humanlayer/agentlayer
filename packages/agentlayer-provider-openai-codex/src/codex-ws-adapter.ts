/**
 * Adapter layer that converts AI SDK `LanguageModelV3CallOptions` into the
 * vendor's `LLMRequest` type, allowing the Codex provider to use the vendored
 * `LLMClient.stream()` pipeline instead of hand-rolled HTTP fetch + SSE
 * parsing.
 *
 * This implements DQ2 Option A from the design discussion: replicate the
 * conversion chain from OpenCode's native-request.ts pattern to produce an
 * `LLMRequest` that flows through the vendor's full compile -> stream -> parse
 * pipeline.
 */
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider'
import { webSocketRoute } from '@humanlayer/opencode-llm-vendor/protocols/openai-responses'
import type { Auth } from '@humanlayer/opencode-llm-vendor/route/auth'
import {
	type ContentPart,
	GenerationOptions,
	LLMRequest,
	Message,
	Model,
	SystemPart,
	ToolChoice,
	ToolDefinition,
	type ToolResultPart,
} from '@humanlayer/opencode-llm-vendor/schema'
import { CODEX_FAST_SERVICE_TIER, normalizeCodexServiceTier } from './codex'

// ---------------------------------------------------------------------------
// strictifySchema — reused from the existing codex-effect.ts
// ---------------------------------------------------------------------------

export function strictifySchema(schema: Record<string, unknown>): void {
	delete schema.format
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (props) {
		schema.required = Object.keys(props)
		schema.additionalProperties = false
		for (const prop of Object.values(props)) {
			strictifySchema(prop)
		}
	}
	const items = schema.items as Record<string, unknown> | undefined
	if (items) strictifySchema(items)
	const anyOf = schema.anyOf as Record<string, unknown>[] | undefined
	if (anyOf) for (const s of anyOf) strictifySchema(s)
	const oneOf = schema.oneOf as Record<string, unknown>[] | undefined
	if (oneOf) for (const s of oneOf) strictifySchema(s)
}

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

export interface AdapterConfig {
	auth: Auth
	baseURL: string
	fastMode?: boolean
	serviceTier?: string
}

// ---------------------------------------------------------------------------
// buildCodexModel
// ---------------------------------------------------------------------------

/**
 * Construct a vendor `Model` object using the `webSocketRoute` patched with
 * Codex endpoint and auth.
 *
 * The `webSocketRoute` comes from the vendor's openai-responses module with
 * `Auth.none` and the default OpenAI endpoint. We override both via
 * `.with()` to point at the Codex endpoint and inject bearer auth.
 */
export function buildCodexModel(modelId: string, auth: Auth, baseURL: string): Model {
	const codexRoute = webSocketRoute.with({
		auth,
		endpoint: { baseURL },
	})

	return Model.make({
		id: modelId,
		provider: 'openai',
		route: codexRoute,
	})
}

// ---------------------------------------------------------------------------
// convertPromptMessages
// ---------------------------------------------------------------------------

/**
 * Convert AI SDK `LanguageModelV3Prompt` messages into vendor `Message[]`
 * plus `SystemPart[]`. System messages are extracted to the `system` array;
 * all other roles become vendor `Message` instances.
 *
 * This replicates the same transformations as `convertPromptToBody()` in
 * codex-effect.ts but targets the vendor's schema types.
 */
export function convertPromptMessages(prompt: LanguageModelV3Prompt): {
	system: SystemPart[]
	messages: Message[]
} {
	const systemParts: SystemPart[] = []
	const messages: Message[] = []

	for (const message of prompt) {
		switch (message.role) {
			case 'system': {
				systemParts.push(SystemPart.make(message.content))
				break
			}

			case 'user': {
				const content: ContentPart[] = []
				for (const part of message.content) {
					if (part.type === 'text') {
						content.push({ type: 'text', text: part.text })
					} else if (part.type === 'file' && part.mediaType.startsWith('image/')) {
						if (part.data instanceof URL) {
							content.push({
								type: 'media',
								mediaType: part.mediaType,
								data: part.data.toString(),
							})
						} else if (typeof part.data === 'string') {
							content.push({
								type: 'media',
								mediaType: part.mediaType,
								data: `data:${part.mediaType};base64,${part.data}`,
							})
						}
					}
				}
				messages.push(Message.make({ role: 'user', content }))
				break
			}

			case 'assistant': {
				const content: ContentPart[] = []
				for (const part of message.content) {
					switch (part.type) {
						case 'text':
							content.push({ type: 'text', text: part.text })
							break
						case 'reasoning': {
							const openai = part.providerOptions?.openai as Record<string, unknown> | undefined
							const itemId = openai?.itemId as string | undefined
							if (!itemId) break
							const encryptedContent = openai?.reasoningEncryptedContent as string | null | undefined
							// store is always false for codex — drop items without encrypted_content
							if (typeof encryptedContent !== 'string') break
							content.push({
								type: 'reasoning',
								text: part.text ?? '',
								providerMetadata: {
									openai: {
										itemId,
										reasoningEncryptedContent:
											typeof encryptedContent === 'string'
												? encryptedContent
												: encryptedContent === null
													? null
													: undefined,
									},
								},
							})
							break
						}
						case 'tool-call':
							content.push({
								type: 'tool-call',
								id: part.toolCallId,
								name: part.toolName,
								input: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
							})
							break
					}
				}
				if (content.length > 0) {
					messages.push(Message.make({ role: 'assistant', content }))
				}
				break
			}

			case 'tool': {
				const content: ContentPart[] = []
				for (const part of message.content) {
					if (part.type === 'tool-result') {
						const result = convertToolResultValue(part.output)
						content.push({
							type: 'tool-result',
							id: part.toolCallId,
							name: part.toolName ?? '',
							result,
						} as ToolResultPart)
					}
				}
				if (content.length > 0) {
					messages.push(Message.make({ role: 'tool', content }))
				}
				break
			}
		}
	}

	return { system: systemParts, messages }
}

/**
 * Convert an AI SDK tool result output to the vendor's ToolResultValue format.
 */
function convertToolResultValue(output: unknown): { type: 'text' | 'json'; value: unknown } {
	if (output && typeof output === 'object' && 'type' in output) {
		const typed = output as { type: string; value: unknown }
		if (typed.type === 'text') {
			return { type: 'text', value: String(typed.value) }
		}
		if (typed.type === 'json') {
			return { type: 'json', value: typed.value }
		}
	}
	// fallback: encode as JSON text
	return { type: 'text', value: JSON.stringify(output) }
}

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

/**
 * Convert AI SDK tool definitions to vendor `ToolDefinition[]` with schema
 * strictification.
 */
export function convertTools(tools: LanguageModelV3CallOptions['tools']): ToolDefinition[] {
	if (!tools) return []
	const result: ToolDefinition[] = []
	for (const tool of tools) {
		if (tool.type === 'function') {
			const schema = structuredClone(tool.inputSchema) as Record<string, unknown>
			strictifySchema(schema)
			result.push(
				new ToolDefinition({
					name: tool.name,
					description: tool.description ?? '',
					inputSchema: schema,
				}),
			)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// mapProviderOptions
// ---------------------------------------------------------------------------

/**
 * Build the `providerOptions.openai` namespace from AI SDK call options
 * and adapter config. Sets defaults matching the current Codex behavior:
 * - `reasoningEffort: 'medium'`
 * - `reasoningSummary: 'auto'`
 * - `store: false`
 * - `includeEncryptedReasoning: true`
 *
 * Handles `service_tier`/`fastMode` normalization (DQ4).
 */
export function mapProviderOptions(
	options: LanguageModelV3CallOptions,
	config: AdapterConfig,
): Record<string, Record<string, unknown>> {
	const providerOptions = options.providerOptions?.openai as Record<string, unknown> | undefined

	const reasoningEffort = (providerOptions?.reasoningEffort as string | undefined) ?? 'medium'
	const reasoningSummary = (providerOptions?.reasoningSummary as string | undefined) ?? 'auto'
	const store = false // Codex always uses store: false
	const includeEncryptedReasoning = (providerOptions?.includeEncryptedReasoning as boolean | undefined) ?? true
	const promptCacheKey = providerOptions?.promptCacheKey as string | undefined

	// service_tier normalization (DQ4)
	let serviceTier: string | undefined
	const providerServiceTier = providerOptions?.serviceTier as string | null | undefined
	if (providerServiceTier !== undefined && providerServiceTier !== null) {
		serviceTier = normalizeCodexServiceTier(providerServiceTier) ?? undefined
	} else if (config.serviceTier !== undefined) {
		serviceTier = normalizeCodexServiceTier(config.serviceTier) ?? undefined
	} else {
		const fastMode = (providerOptions?.fastMode as boolean | undefined) ?? config.fastMode
		if (fastMode) {
			serviceTier = CODEX_FAST_SERVICE_TIER
		}
	}

	// Build the instructions from system parts and provider options.
	// OpenAIOptions.instructions reads from providerOptions.openai.instructions.
	const instructions = providerOptions?.instructions as string | undefined

	return {
		openai: {
			reasoningEffort,
			reasoningSummary,
			store,
			includeEncryptedReasoning,
			...(promptCacheKey ? { promptCacheKey } : {}),
			...(serviceTier !== undefined ? { serviceTier } : {}),
			...(instructions ? { instructions } : {}),
		},
	}
}

// ---------------------------------------------------------------------------
// convertToolChoice
// ---------------------------------------------------------------------------

function convertToolChoice(toolChoice: LanguageModelV3CallOptions['toolChoice']): ToolChoice | undefined {
	if (!toolChoice) return undefined
	switch (toolChoice.type) {
		case 'auto':
			return new ToolChoice({ type: 'auto' })
		case 'none':
			return new ToolChoice({ type: 'none' })
		case 'required':
			return new ToolChoice({ type: 'required' })
		case 'tool':
			return ToolChoice.named(toolChoice.toolName)
		default:
			return undefined
	}
}

// ---------------------------------------------------------------------------
// convertCallOptionsToLLMRequest
// ---------------------------------------------------------------------------

/**
 * Main adapter function: convert AI SDK `LanguageModelV3CallOptions` into
 * the vendor's `LLMRequest`. This produces an LLMRequest that can be passed
 * directly to `LLMClient.stream()`.
 *
 * The vendor's pipeline (`fromRequest` -> `lowerOptions` -> `lowerMessages`)
 * then handles converting the LLMRequest into the wire format body, applying
 * the transport (WebSocket framing), and running the protocol state machine
 * to parse streamed events.
 */
export function convertCallOptionsToLLMRequest(
	modelId: string,
	options: LanguageModelV3CallOptions,
	config: AdapterConfig,
): LLMRequest {
	const model = buildCodexModel(modelId, config.auth, config.baseURL)
	const { system, messages } = convertPromptMessages(options.prompt)
	const tools = convertTools(options.tools)
	const toolChoice = convertToolChoice(options.toolChoice)
	const providerOptions = mapProviderOptions(options, config)

	// Codex requires system messages as top-level `instructions`, not as
	// input items with role:'system'. Merge system parts into
	// providerOptions.openai.instructions so the vendor's lowerOptions()
	// places them correctly on the wire body.
	if (system.length > 0) {
		const systemText = system.map((s) => s.text).join('\n\n')
		const existing = providerOptions.openai?.instructions as string | undefined
		providerOptions.openai = {
			...providerOptions.openai,
			instructions: existing ? `${existing}\n\n${systemText}` : systemText,
		}
	}

	const generation = new GenerationOptions({
		maxTokens: options.maxOutputTokens,
		temperature: options.temperature,
		topP: options.topP,
		seed: options.seed,
	})

	return new LLMRequest({
		model,
		system: [], // system messages go via instructions, not input items
		messages,
		tools,
		toolChoice,
		generation,
		providerOptions,
	})
}
