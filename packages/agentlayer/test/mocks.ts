import type {
	LanguageModelV3,
	LanguageModelV3Content,
	LanguageModelV3GenerateResult,
	LanguageModelV3Text,
	LanguageModelV3ToolCall,
} from '@ai-sdk/provider'
import type { ModelMessage, ToolModelMessage, UserModelMessage } from 'ai'
import type { ToolContext } from '../src/core/define-tool'

type MockResponse = Pick<LanguageModelV3GenerateResult, 'content'> & {
	usage?: LanguageModelV3GenerateResult['usage']
}

const MOCK_USAGE: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

export function mockModel(responses: MockResponse[]): LanguageModelV3 {
	let index = 0
	return {
		specificationVersion: 'v3',
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		async doGenerate(): Promise<LanguageModelV3GenerateResult> {
			if (index >= responses.length) {
				throw new Error(
					`mockModel: no more responses (called ${index + 1} times, only ${responses.length} responses)`,
				)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c: LanguageModelV3Content) => c.type === 'tool-call')
			return {
				content: response.content,
				finishReason: {
					unified: hasToolCalls ? 'tool-calls' : 'stop',
					raw: hasToolCalls ? 'tool_use' : 'stop',
				},
				usage: response.usage ?? MOCK_USAGE,
				warnings: [],
			}
		},
		async doStream() {
			throw new Error('mockModel: streaming not supported')
		},
	}
}

export function assistantText(text: string, opts?: { usage?: MockResponse['usage'] }): MockResponse {
	const part: LanguageModelV3Text = { type: 'text', text }
	return { content: [part], ...(opts?.usage ? { usage: opts.usage } : {}) }
}

export function assistantWithToolCall(
	toolName: string,
	input: Record<string, unknown>,
	opts?: { usage?: MockResponse['usage'] },
): MockResponse {
	const part: LanguageModelV3ToolCall = {
		type: 'tool-call',
		toolCallId: crypto.randomUUID(),
		toolName,
		input: JSON.stringify(input),
	}
	return { content: [part], ...(opts?.usage ? { usage: opts.usage } : {}) }
}

export function assistantWithToolCalls(
	...calls: Array<{ toolName: string; input: Record<string, unknown> }>
): MockResponse {
	const parts: LanguageModelV3ToolCall[] = calls.map((call) => ({
		type: 'tool-call' as const,
		toolCallId: crypto.randomUUID(),
		toolName: call.toolName,
		input: JSON.stringify(call.input),
	}))
	return { content: parts }
}

export function userMessage(content: string): UserModelMessage {
	return { role: 'user', content }
}

export function toolResultMessage(toolCallId: string, toolName: string, output: string): ToolModelMessage {
	return {
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId,
				toolName,
				output: { type: 'text', value: output },
			},
		],
	}
}

/**
 * Extract all tool-result parts from an array of messages.
 * Optionally filter by toolName.
 */
export function getToolResults(
	messages: ModelMessage[],
	opts?: { toolName?: string },
): Array<{
	type: 'tool-result'
	toolCallId: string
	toolName: string
	output: { type: string; value: string }
	isError?: boolean
}> {
	const parts: Array<{
		type: 'tool-result'
		toolCallId: string
		toolName: string
		output: { type: string; value: string }
		isError?: boolean
	}> = []
	for (const msg of messages) {
		if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
		for (const part of msg.content) {
			if (part.type !== 'tool-result') continue
			if (opts?.toolName && (part as any).toolName !== opts.toolName) continue
			parts.push(part as any)
		}
	}
	return parts
}

/**
 * Get the string value from a tool result's polymorphic output.
 */
export function outputValue(part: { output: string | { type: string; value: string } }): string {
	return typeof part.output === 'string' ? part.output : part.output.value
}

export function extractToolCallId(messages: ModelMessage[], toolName: string): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
		for (const part of msg.content) {
			if (part.type === 'tool-call' && part.toolName === toolName) {
				return part.toolCallId
			}
		}
	}
	throw new Error(`extractToolCallId: no tool call found for "${toolName}"`)
}

export function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
	return {
		getContextWindow: () => [],
		updateContextWindow: () => {},
		signal: new AbortController().signal,
		progress: () => {},
		stop: (opts) => ({ type: 'stop', ...opts }),
		getContextWindowTokens: () => 0,
		getContextWindowLimit: () => undefined,
		...overrides,
	}
}
