import type { ModelMessage } from 'ai'

export interface PreRequestTransformOptions {
	/** When true, persist the transformed messages back to the actual context window. Default: false. */
	persist?: boolean
}

export interface PreRequestNextResult {
	readonly type: 'preRequestNext'
}

export interface PreRequestTransformResult {
	readonly type: 'preRequestTransform'
	messages: ModelMessage[]
	persist: boolean
}

export type PreRequestResult = PreRequestNextResult | PreRequestTransformResult

export interface PreRequestHookContext {
	messages: ReadonlyArray<ModelMessage>
	/** Estimated number of tokens in the context window. Updated after each streamText call. 0 before the first call. */
	contextWindowTokens: number
	/** Context window limit (from AgentConfig or models.dev). undefined if unknown. */
	contextWindowLimit: number | undefined
	next(): PreRequestNextResult
	transform(messages: ModelMessage[], opts?: PreRequestTransformOptions): PreRequestTransformResult
}

export type PreRequestHook = (ctx: PreRequestHookContext) => PreRequestResult | Promise<PreRequestResult>

export function createPreRequestHook(
	hook: (ctx: PreRequestHookContext) => PreRequestResult | Promise<PreRequestResult>,
): PreRequestHook {
	return hook
}

export interface PreRequestHookChainInput {
	messages: ModelMessage[]
	/** Estimated context window tokens. Defaults to 0 if omitted. */
	contextWindowTokens?: number
	/** Context window limit. Defaults to undefined if omitted. */
	contextWindowLimit?: number
}

export interface PreRequestHookChainResult {
	/** The (possibly transformed) messages to send to the model. */
	messages: ModelMessage[]
	/** Whether the transform should be persisted back to the actual context window. */
	persist: boolean
	/** Whether any transform was applied. */
	transformed: boolean
}

export async function runPreRequestHooks(
	hooks: PreRequestHook[],
	input: PreRequestHookChainInput,
): Promise<PreRequestHookChainResult> {
	let currentMessages = input.messages
	let persist = false
	let transformed = false

	for (const hook of hooks) {
		const ctx: PreRequestHookContext = {
			messages: Object.freeze([...currentMessages]),
			contextWindowTokens: input.contextWindowTokens ?? 0,
			contextWindowLimit: input.contextWindowLimit,
			next(): PreRequestNextResult {
				return { type: 'preRequestNext' }
			},
			transform(messages: ModelMessage[], opts?: PreRequestTransformOptions): PreRequestTransformResult {
				return {
					type: 'preRequestTransform',
					messages,
					persist: opts?.persist ?? false,
				}
			},
		}

		const result = await hook(ctx)
		if (result.type === 'preRequestTransform') {
			currentMessages = result.messages
			transformed = true
			if (result.persist) {
				persist = true
			}
		}
	}

	return { messages: currentMessages, persist, transformed }
}
