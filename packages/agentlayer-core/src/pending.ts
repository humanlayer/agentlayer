import type { ModelMessage } from 'ai'

/**
 * Scan a message array for tool-call parts that do not have a corresponding
 * tool-result message. Returns metadata for each unresolved tool call.
 *
 * This is a lower-level utility for inspecting raw message arrays. Most callers
 * should prefer `result.state.pendingToolCalls`, which is set by the agent loop
 * and carries structured `ApprovalRequest` metadata.
 *
 * The function searches the last assistant message that contains tool-call parts,
 * then checks all subsequent messages for matching tool-result parts.
 *
 * @example
 * ```ts
 * // Low-level: scan messages directly
 * const pending = getPendingToolCalls(result.state.messages)
 * // pending = [{ toolCallId, toolName, input }]
 *
 * // Preferred: use structured state (includes approval metadata)
 * const pending = result.state.pendingToolCalls
 * // pending = [{ type: 'approval', toolCallId, toolName, input, approval }]
 *
 * // Resume with approval decision
 * const result2 = await agent.run({
 *   state: withApprovals(result.state, [{ toolCallId, approved: true }]),
 * }).result
 * ```
 */
export function getPendingToolCalls(messages: ModelMessage[]): Array<{
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
}> {
	// Find the last assistant message with tool-call parts
	let lastAssistantIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
		if (msg.content.some((p) => p.type === 'tool-call')) {
			lastAssistantIndex = i
			break
		}
	}

	if (lastAssistantIndex === -1) return []

	const assistantMessage = messages[lastAssistantIndex]!
	const toolCallParts = Array.isArray(assistantMessage.content)
		? assistantMessage.content.filter((p) => p.type === 'tool-call')
		: []

	if (toolCallParts.length === 0) return []

	// Collect toolCallIds that have been resolved (have a tool-result message)
	const resolvedIds = new Set<string>()
	for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
		const msg = messages[i]!
		if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
		for (const part of msg.content) {
			if (part.type === 'tool-result') {
				resolvedIds.add(part.toolCallId)
			}
		}
	}

	// Return only unresolved tool calls
	const pending: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }> = []
	for (const part of toolCallParts) {
		if (part.type !== 'tool-call') continue
		if (resolvedIds.has(part.toolCallId)) continue
		const input = (typeof part.input === 'string' ? JSON.parse(part.input) : part.input) as Record<string, unknown>
		pending.push({ toolCallId: part.toolCallId, toolName: part.toolName, input })
	}

	return pending
}
