import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart, LanguageModelV3Usage } from '@ai-sdk/provider'

export function convertUsage(event: Record<string, unknown>): LanguageModelV3Usage {
	const u = event.usage as Record<string, number | undefined> | undefined
	return {
		inputTokens: {
			total: u?.inputTokens ?? 0,
			noCache: u?.nonCachedInputTokens ?? undefined,
			cacheRead: u?.cacheReadInputTokens ?? undefined,
			cacheWrite: u?.cacheWriteInputTokens ?? undefined,
		},
		outputTokens: {
			total: u?.outputTokens ?? 0,
			reasoning: u?.reasoningTokens ?? undefined,
			text: u ? Math.max(0, (u.outputTokens ?? 0) - (u.reasoningTokens ?? 0)) : undefined,
		},
	}
}

export function convertFinishReason(reason: string): LanguageModelV3FinishReason {
	const map: Record<string, 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'> = {
		stop: 'stop',
		length: 'length',
		'content-filter': 'content-filter',
		'tool-calls': 'tool-calls',
		error: 'error',
	}
	return { unified: map[reason] ?? 'other', raw: reason }
}

export const emptyUsage: LanguageModelV3Usage = {
	inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 0, text: undefined, reasoning: undefined },
}

// The LLMEvent type is a tagged union from Effect Schema. We access fields via record indexing.
export type AnyLLMEvent = Record<string, unknown> & { type: string }

export function llmEventToStreamParts(event: AnyLLMEvent): LanguageModelV3StreamPart[] {
	switch (event.type) {
		case 'text-start':
			return [
				{ type: 'text-start', id: event.id as string, providerMetadata: event.providerMetadata as undefined },
			]
		case 'text-delta':
			return [{ type: 'text-delta', id: event.id as string, delta: event.text as string }]
		case 'text-end':
			return [
				{
					type: 'text-end',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'reasoning-start':
			return [
				{
					type: 'reasoning-start',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'reasoning-delta':
			return [{ type: 'reasoning-delta', id: event.id as string, delta: event.text as string }]
		case 'reasoning-end':
			return [
				{
					type: 'reasoning-end',
					id: event.id as string,
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		case 'tool-input-start':
			return [{ type: 'tool-input-start', id: event.id as string, toolName: event.name as string }]
		case 'tool-input-delta':
			return [{ type: 'tool-input-delta', id: event.id as string, delta: event.text as string }]
		case 'tool-input-end':
			return [{ type: 'tool-input-end', id: event.id as string }]
		case 'tool-call':
			return [
				{
					type: 'tool-call',
					toolCallId: event.id as string,
					toolName: event.name as string,
					input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input),
				},
			]
		case 'finish':
			return [
				{
					type: 'finish',
					finishReason: convertFinishReason(event.reason as string),
					usage: convertUsage(event),
					providerMetadata: event.providerMetadata as undefined,
				},
			]
		// DQ5: Map provider-error to AI SDK error part
		case 'provider-error':
			return [{ type: 'error', error: new Error(event.message as string) }]
		default:
			return []
	}
}
