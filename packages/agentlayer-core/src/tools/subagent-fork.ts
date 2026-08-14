import type { ModelMessage } from 'ai'
import { isCompactionSummaryMessage } from '../compaction'
import type { AgentState, ApprovalHistoryEntry } from '../state'

export type ForkTurns = 'all' | 'none' | number

function clone<T>(value: T): T {
	return structuredClone(value)
}

function invokesToolCall(message: ModelMessage, toolCallId: string): boolean {
	return (
		message.role === 'assistant' &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === 'tool-call' && part.toolCallId === toolCallId)
	)
}

function isInjectedSkillMessage(message: ModelMessage): boolean {
	if (message.role !== 'user' || typeof message.content !== 'string') return false
	const content = message.content.trim()
	return /^<skill(?:\s|>)/.test(content) && content.endsWith('</skill>')
}

function isUserTurnBoundary(message: ModelMessage): boolean {
	return message.role === 'user' && !isInjectedSkillMessage(message)
}

function removeInvokingTurn(messages: ReadonlyArray<ModelMessage>, toolCallId: string): ModelMessage[] {
	const invokingAssistantIndex = messages.findIndex((message) => invokesToolCall(message, toolCallId))
	if (invokingAssistantIndex < 0) return [...messages]

	let triggeringUserIndex = -1
	for (let index = invokingAssistantIndex - 1; index >= 0; index--) {
		const message = messages[index]
		if (message && isUserTurnBoundary(message)) {
			triggeringUserIndex = index
			break
		}
	}

	const turnStart = triggeringUserIndex >= 0 ? triggeringUserIndex : invokingAssistantIndex
	return [...messages.slice(0, turnStart), ...messages.slice(invokingAssistantIndex + 1)]
}

function isSettledAssistantText(message: ModelMessage): boolean {
	if (message.role !== 'assistant') return false
	if (typeof message.content === 'string') return message.content.trim().length > 0
	if (!Array.isArray(message.content) || message.content.length === 0) return false
	return message.content.every((part) => part.type === 'text')
}

function isEligibleForkMessage(message: ModelMessage): boolean {
	return message.role === 'user' || isSettledAssistantText(message)
}

function selectRecentTurns(messages: ModelMessage[], turns: number): ModelMessage[] {
	let userTurns = 0
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (!message || !isUserTurnBoundary(message)) continue
		userTurns += 1
		if (userTurns === turns) return messages.slice(index)
	}
	return messages
}

export function projectForkMessages(
	messages: ReadonlyArray<ModelMessage>,
	turns: ForkTurns,
	invokingToolCallId: string,
): ModelMessage[] {
	if (turns === 'none') return []

	const withoutInvokingTurn = removeInvokingTurn(messages, invokingToolCallId)
	const selected = typeof turns === 'number' ? selectRecentTurns(withoutInvokingTurn, turns) : withoutInvokingTurn
	return clone(selected.filter(isEligibleForkMessage))
}

export function createForkState(
	callerState: AgentState,
	turns: ForkTurns,
	invokingToolCallId: string,
	prompt: string,
): AgentState {
	const messages = projectForkMessages(callerState.messages, turns, invokingToolCallId)
	const approvalHistory = callerState.approvalHistory
		? clone<ApprovalHistoryEntry[]>(callerState.approvalHistory)
		: undefined
	const compaction =
		callerState.compaction &&
		messages.some((message) => isCompactionSummaryMessage(message, callerState.compaction!.summary))
			? clone(callerState.compaction)
			: undefined

	return {
		messages: [...messages, { role: 'user', content: prompt }],
		...(approvalHistory?.length ? { approvalHistory } : {}),
		...(compaction ? { compaction } : {}),
	}
}
