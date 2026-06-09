import type {
	AssistantModelMessage,
	ModelMessage,
	SystemModelMessage,
	ToolModelMessage,
	ToolResultPart,
	UserModelMessage,
} from 'ai'
import type { RunResult } from './agent'
import { sanitizeTextForModelState, sanitizeToolOutputForModelState } from './sanitize-text'

export type AgentLayerToolOutput = string | ToolResultPart['output']

const TOOL_RESULT_OUTPUT_TYPES = new Set(['text', 'json', 'execution-denied', 'error-text', 'error-json', 'content'])

export function isToolResultOutput(value: unknown): value is ToolResultPart['output'] {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof (value as { type: unknown }).type === 'string' &&
		TOOL_RESULT_OUTPUT_TYPES.has((value as { type: string }).type)
	)
}

type ToolCallInput = {
	toolCallId: string
	toolName: string
	input: unknown
}

type ToolResultInput = {
	toolCallId: string
	toolName: string
	output: string
	isError?: boolean
}

export function userMessage(content: UserModelMessage['content']): UserModelMessage {
	return { role: 'user', content }
}

export function systemMessage(content: SystemModelMessage['content']): SystemModelMessage {
	return { role: 'system', content }
}

export function assistantMessage(content: AssistantModelMessage['content']): AssistantModelMessage {
	return { role: 'assistant', content }
}

export function toolCall(input: ToolCallInput): AssistantModelMessage {
	return {
		role: 'assistant',
		content: [
			{
				type: 'tool-call',
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				input: input.input,
			},
		],
	}
}

export function toolResult(input: ToolResultInput): ToolModelMessage {
	return toolResultMessage(input.toolCallId, input.toolName, input.output, input.isError)
}

/**
 * Build a tool-result ModelMessage from execution output.
 * Internal helper used by the agent loop.
 */
export function buildToolResultMessage(
	toolCallId: string,
	toolName: string,
	output: AgentLayerToolOutput,
	isError: boolean,
): ModelMessage {
	const sanitizedOutput = sanitizeToolOutputForModelState(output)
	const resolvedOutput =
		typeof sanitizedOutput === 'string' ? { type: 'text' as const, value: sanitizedOutput } : sanitizedOutput

	return {
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId,
				toolName,
				output: resolvedOutput,
				...(isError ? { isError: true } : {}),
			},
		],
	}
}

/**
 * Build a tool-result message — public API for use in tests and approval flows.
 *
 * Use this to inject synthetic tool results when resuming a stopped run:
 * - After `toolCalled` stop condition: inject the outcome the agent would have produced
 * - After `approvalRequired`: inject the approved result or a denial message
 *
 * @example
 * ```ts
 * const toolCallId = extractToolCallId(result.messages, 'deploy')
 * const syntheticResult = toolResultMessage(toolCallId, 'deploy', 'Deployment approved.')
 * const result2 = await agent.run({ messages: [...result.messages, syntheticResult] }).result
 * ```
 */
export function toolResultMessage(
	toolCallId: string,
	toolName: string,
	output: string,
	isError?: boolean,
): ToolModelMessage {
	const sanitizedOutput = sanitizeTextForModelState(output)
	return {
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId,
				toolName,
				output: { type: 'text', value: sanitizedOutput },
				...(isError ? { isError: true } : {}),
			},
		],
	}
}

/**
 * Extract the last assistant text message from a run result.
 * Falls back to a summary of the finish reason if no text found.
 *
 * @example
 * ```ts
 * const result = await agent.run({ state: startState([userMessage('hello')]) }).result
 * const text = extractLastAssistantText(result)
 * console.log(text)
 * ```
 */
export function extractLastAssistantText(result: RunResult): string {
	for (let i = result.state.messages.length - 1; i >= 0; i--) {
		const msg = result.state.messages[i]!
		if (msg.role !== 'assistant') continue

		if (typeof msg.content === 'string') return msg.content

		if (Array.isArray(msg.content)) {
			const textParts = msg.content.filter((p) => p.type === 'text')
			if (textParts.length > 0) {
				return textParts.map((p) => p.text).join('\n')
			}
		}
	}

	return `Agent finished with reason: ${result.finishReason}`
}
