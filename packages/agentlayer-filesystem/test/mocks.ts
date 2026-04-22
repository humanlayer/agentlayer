import type {
	LanguageModelV3,
	LanguageModelV3Content,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
	LanguageModelV3Text,
	LanguageModelV3ToolCall,
} from '@ai-sdk/provider'
import type { ToolContext } from '@humanlayer/agentlayer-core'
import type { ModelMessage, ToolModelMessage, UserModelMessage } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'

type MockResponse = Pick<LanguageModelV3GenerateResult, 'content'> & {
	usage?: LanguageModelV3GenerateResult['usage']
}

const MOCK_USAGE: LanguageModelV3GenerateResult['usage'] = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
}

export function mockModel(responses: MockResponse[]): LanguageModelV3 {
	return mockStreamingModel(responses)
}

export function mockStreamingModel(responses: MockResponse[]): LanguageModelV3 {
	let index = 0
	return new MockLanguageModelV3({
		provider: 'mock',
		modelId: 'mock-model',
		supportedUrls: {},
		doStream: async (): Promise<LanguageModelV3StreamResult> => {
			if (index >= responses.length) {
				throw new Error(
					`mockStreamingModel: no more responses (called ${index + 1} times, only ${responses.length} responses)`,
				)
			}
			const response = responses[index++]!
			const hasToolCalls = response.content.some((c: LanguageModelV3Content) => c.type === 'tool-call')
			const usage = response.usage ?? MOCK_USAGE
			return {
				stream: simulateReadableStream<LanguageModelV3StreamPart>({
					chunks: [
						{ type: 'stream-start', warnings: [] },
						...response.content.flatMap((part) => toStreamParts(part)),
						{
							type: 'finish',
							finishReason: {
								unified: hasToolCalls ? 'tool-calls' : 'stop',
								raw: hasToolCalls ? 'tool_use' : 'stop',
							},
							usage,
						},
					],
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			}
		},
	})
}

function toStreamParts(part: LanguageModelV3Content): LanguageModelV3StreamPart[] {
	switch (part.type) {
		case 'text': {
			const id = crypto.randomUUID()
			return [
				{ type: 'text-start', id },
				{ type: 'text-delta', id, delta: part.text },
				{ type: 'text-end', id },
			]
		}
		case 'tool-call':
			return [part]
		default:
			return []
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

export function outputValue(part: { output: string | { type: string; value: string } }): string {
	return typeof part.output === 'string' ? part.output : part.output.value
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
