import type { ModelMessage } from 'ai'
import type { ResolvedCompactionPolicy } from './policy'
import { resolveCompactionThreshold } from './policy'

export const SERIALIZED_TOOL_RESULT_MAX_CHARS = 2_000
const FILE_PART_ESTIMATE_CHARS = 4_800

type MessagePart = Record<string, unknown> & { type: string }

export interface CompactCommand {
	messageIndex: number
	additionalInstructions?: string
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

function contentParts(content: unknown): MessagePart[] {
	if (typeof content === 'string') return [{ type: 'text', text: content }]
	if (!Array.isArray(content)) return []
	return content.filter(
		(part): part is MessagePart => typeof part === 'object' && part !== null && typeof part.type === 'string',
	)
}

function textContent(content: unknown): string | undefined {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return undefined
	const parts = contentParts(content)
	if (parts.some((part) => part.type !== 'text')) return undefined
	return parts.map(partText).join('')
}

/** Parse the final user message when it begins with a standalone `/compact` command. */
export function parseCompactCommand(messages: ReadonlyArray<ModelMessage>): CompactCommand | undefined {
	const messageIndex = messages.length - 1
	const message = messages[messageIndex]
	if (!message || message.role !== 'user') return undefined
	const text = textContent(message.content)
	if (text === undefined) return undefined
	const match = /^\s*\/compact(?:\s+([\s\S]*?))?\s*$/.exec(text)
	if (!match) return undefined
	const additionalInstructions = match[1]?.trim()
	return {
		messageIndex,
		...(additionalInstructions ? { additionalInstructions } : {}),
	}
}

/** Only a positive estimate recorded after the latest checkpoint can trigger proactive compaction. */
export function shouldCompactForThreshold(input: {
	contextWindowTokens?: number
	policy: ResolvedCompactionPolicy
	contextWindowLimit?: number
}): boolean {
	if (!input.policy.enabled || input.contextWindowTokens === undefined || input.contextWindowTokens <= 0) return false
	const threshold = resolveCompactionThreshold(input.policy, input.contextWindowLimit)
	return threshold !== undefined && input.contextWindowTokens >= threshold
}

function partText(part: MessagePart): string {
	if (typeof part.text === 'string') return part.text
	if (typeof part.value === 'string') return part.value
	return safeStringify(part)
}

function toolOutput(part: MessagePart): unknown {
	const output = part.output
	if (typeof output === 'object' && output !== null && 'value' in output) {
		return (output as { value: unknown }).value
	}
	return output
}

function serializeValue(value: unknown): string {
	return typeof value === 'string' ? value : safeStringify(value)
}

/** Estimate a provider-neutral message footprint with Fold's chars/4 heuristic. */
export function estimateMessageTokens(message: ModelMessage): number {
	const chars = contentParts(message.content).reduce((total, part) => {
		switch (part.type) {
			case 'text':
			case 'reasoning':
				return total + partText(part).length
			case 'file':
			case 'image':
				return total + FILE_PART_ESTIMATE_CHARS
			case 'tool-call':
				return total + String(part.toolName ?? '').length + safeStringify(part.input).length
			case 'tool-result':
				return total + serializeValue(toolOutput(part)).length
			default:
				return total + safeStringify(part).length
		}
	}, 0)
	return Math.max(1, Math.ceil(chars / 4))
}

function toolCallIds(message: ModelMessage): string[] {
	if (message.role !== 'assistant') return []
	return contentParts(message.content)
		.filter((part) => part.type === 'tool-call' && typeof part.toolCallId === 'string')
		.map((part) => part.toolCallId as string)
}

function toolResultIds(message: ModelMessage): string[] {
	if (message.role !== 'tool') return []
	return contentParts(message.content)
		.filter((part) => part.type === 'tool-result' && typeof part.toolCallId === 'string')
		.map((part) => part.toolCallId as string)
}

/** Ensure every retained tool result has its retained assistant tool call. */
export function hasValidToolCallResultPairs(messages: ReadonlyArray<ModelMessage>): boolean {
	const calls = new Set(messages.flatMap(toolCallIds))
	return messages.flatMap(toolResultIds).every((id) => calls.has(id))
}

function containsRequiredToolCalls(
	messages: ReadonlyArray<ModelMessage>,
	requiredToolCallIds: ReadonlySet<string>,
): boolean {
	if (requiredToolCallIds.size === 0) return true
	const calls = new Set(messages.flatMap(toolCallIds))
	return [...requiredToolCallIds].every((id) => calls.has(id))
}

function isValidCutRole(message: ModelMessage): boolean {
	return message.role === 'user' || message.role === 'assistant'
}

export interface FindCompactionCutOptions {
	keepRecentTokens: number
	requiredToolCallIds?: ReadonlySet<string>
}

/**
 * Return the first retained message index. The cut keeps complete tool-call/result groups and any
 * assistant calls referenced by pending state.
 */
export function findCompactionCut(messages: ReadonlyArray<ModelMessage>, options: FindCompactionCutOptions): number {
	if (messages.length < 2) return 0

	let accumulated = 0
	let boundary = -1
	for (let index = messages.length - 1; index >= 0; index--) {
		accumulated += estimateMessageTokens(messages[index]!)
		if (accumulated >= Math.max(1, options.keepRecentTokens)) {
			boundary = index
			break
		}
	}

	if (boundary <= 0) return 0
	const required = options.requiredToolCallIds ?? new Set<string>()
	const candidates: number[] = []
	for (let index = boundary; index < messages.length; index++) candidates.push(index)
	for (let index = boundary - 1; index > 0; index--) candidates.push(index)

	for (const index of candidates) {
		if (!isValidCutRole(messages[index]!)) continue
		const retained = messages.slice(index)
		if (hasValidToolCallResultPairs(retained) && containsRequiredToolCalls(retained, required)) return index
	}
	return 0
}

function truncateToolResult(serialized: string): string {
	if (serialized.length <= SERIALIZED_TOOL_RESULT_MAX_CHARS) return serialized
	return `${serialized.slice(0, SERIALIZED_TOOL_RESULT_MAX_CHARS)}[... ${serialized.length - SERIALIZED_TOOL_RESULT_MAX_CHARS} more characters truncated]`
}

function serializeUserContent(content: unknown): string {
	return contentParts(content)
		.map((part) => {
			if (part.type === 'text') return partText(part)
			if (part.type === 'file' || part.type === 'image') return '[attached file]'
			return safeStringify(part)
		})
		.join('\n')
}

/** Flatten replaced native messages into a provider-neutral bounded transcript. */
export function serializeConversation(messages: ReadonlyArray<ModelMessage>): string {
	const lines: string[] = []
	for (const message of messages) {
		if (message.role === 'user') {
			lines.push(`[User]: ${serializeUserContent(message.content)}`)
			continue
		}
		if (message.role === 'system') {
			lines.push(`[System note]: ${serializeUserContent(message.content)}`)
			continue
		}
		if (message.role === 'assistant') {
			const parts = contentParts(message.content)
			for (const part of parts.filter((candidate) => candidate.type === 'reasoning')) {
				lines.push(`[Assistant thinking]: ${partText(part)}`)
			}
			const text = parts.filter((candidate) => candidate.type === 'text').map(partText)
			if (text.length > 0) lines.push(`[Assistant]: ${text.join('\n')}`)
			const calls = parts.filter((candidate) => candidate.type === 'tool-call')
			if (calls.length > 0) {
				lines.push(
					`[Assistant tool calls]: ${calls
						.map((part) => `${String(part.toolName ?? 'tool')}(${safeStringify(part.input)})`)
						.join('; ')}`,
				)
			}
			continue
		}
		if (message.role === 'tool') {
			for (const part of contentParts(message.content)) {
				if (part.type !== 'tool-result') continue
				lines.push(`[Tool result]: ${truncateToolResult(serializeValue(toolOutput(part)))}`)
			}
		}
	}
	return lines.join('\n')
}

export interface CompactionPlan {
	cutIndex: number
	/** Older completed history summarized with the normal initial/update prompt. */
	historyMessages: ModelMessage[]
	/** Discarded prefix of a current oversized turn, summarized separately. */
	turnPrefixMessages: ModelMessage[]
	isSplitTurn: boolean
	replacedMessages: ModelMessage[]
	retainedMessages: ModelMessage[]
	conversationText: string
	turnPrefixConversationText?: string
}

function findTurnStart(messages: ReadonlyArray<ModelMessage>, cutIndex: number): number {
	for (let index = cutIndex; index >= 0; index--) {
		if (messages[index]?.role === 'user') return index
	}
	return -1
}

/** Build a pure summary-prefix/native-tail plan, or return null when no coherent prefix exists. */
export function planCompaction(
	messages: ReadonlyArray<ModelMessage>,
	options: FindCompactionCutOptions,
): CompactionPlan | null {
	const cutIndex = findCompactionCut(messages, options)
	if (cutIndex <= 0) return null
	const turnStartIndex = messages[cutIndex]?.role === 'user' ? -1 : findTurnStart(messages, cutIndex)
	const isSplitTurn = turnStartIndex >= 0 && turnStartIndex < cutIndex
	const historyMessages = messages.slice(0, isSplitTurn ? turnStartIndex : cutIndex)
	const turnPrefixMessages = isSplitTurn ? messages.slice(turnStartIndex, cutIndex) : []
	const replacedMessages = messages.slice(0, cutIndex)
	const retainedMessages = messages.slice(cutIndex)
	return {
		cutIndex,
		historyMessages,
		turnPrefixMessages,
		isSplitTurn,
		replacedMessages,
		retainedMessages,
		conversationText: serializeConversation(historyMessages),
		...(isSplitTurn ? { turnPrefixConversationText: serializeConversation(turnPrefixMessages) } : {}),
	}
}

/**
 * Whether a complete, valid conversation already fits in its configured native tail.
 *
 * This is distinct from a missing compaction plan caused by malformed tool traffic or
 * insufficient conversation structure. Manual compaction commands can safely become a
 * no-op only in this case.
 */
export function fitsCompactionTail(messages: ReadonlyArray<ModelMessage>, options: FindCompactionCutOptions): boolean {
	if (messages.length < 2 || findCompactionCut(messages, options) !== 0) return false
	if (!hasValidToolCallResultPairs(messages)) return false
	if (!containsRequiredToolCalls(messages, options.requiredToolCallIds ?? new Set<string>())) return false
	const totalTokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
	return totalTokens <= Math.max(1, options.keepRecentTokens)
}

export const CONTEXT_OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [
	/context[_ ]length[_ ]exceeded/i,
	/model_context_window_exceeded/i,
	/prompt is too long/i,
	/input is too long/i,
	/exceeds the context window/i,
	/maximum context length/i,
	/maximum prompt length/i,
	/context window exceeds/i,
	/exceeds the available context/i,
	/reduce the length of the messages/i,
	/request entity too large/i,
	/too large for model/i,
]

const NON_OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [/rate.?limit/i, /too many requests/i, /quota/i]

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	return safeStringify(error)
}

/** Recognize provider context overflow while excluding rate-limit and quota failures. */
export function isContextOverflowError(error: unknown): boolean {
	const message = errorText(error)
	return (
		!NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message)) &&
		CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
	)
}
