import type { ModelMessage } from 'ai'
import type { ApprovalRequest, PendingToolCall } from './hooks'
import { buildToolResultMessage } from './messages'

// ── ApprovalDecision ─────────────────────────────────────────────────────────

/** A decision made for a pending approval request. */
export type ApprovalDecision =
	| { toolCallId: string; approved: true }
	| { toolCallId: string; approved: false; denialReason?: string }

// ── ApprovalHistoryEntry ─────────────────────────────────────────────────────

/** A record of a single approval request and the decision made for it. */
export interface ApprovalHistoryEntry {
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
	/** The structured approval request metadata (message, etc.) */
	approval: ApprovalRequest
	/** The decision that was applied */
	decision: ApprovalDecision
}

// ── AgentPath ─────────────────────────────────────────────────────────────────

/**
 * A path into the sub-agent tree, represented as an ordered array of agentId strings.
 *
 * An empty array refers to the root agent.
 * `['child-1']` refers to the direct sub-agent with id 'child-1'.
 * `['child-1', 'grandchild-a']` refers to the grandchild nested within child-1.
 */
export type AgentPath = string[]

// ── AgentState ────────────────────────────────────────────────────────────────

/**
 * Plain serializable state token for agent.run().
 *
 * Captures everything needed to resume a conversation: messages, pending tool
 * calls (both approval-gated and stopped), and accumulated approval history.
 *
 * Designed to survive JSON.stringify → store → JSON.parse → pass to agent.run().
 */
export interface AgentState {
	messages: ModelMessage[]
	/** Tool calls that are pending (awaiting approval or stopped by ctx.stop()). */
	pendingToolCalls?: PendingToolCall[]
	/** Approval history accumulated across runs. */
	approvalHistory?: ApprovalHistoryEntry[]
	/** Persistent state for stateful tools, keyed by each tool's stateKey. */
	toolState?: Record<string, unknown>
	/**
	 * States for active sub-agents, keyed by agentId.
	 * Each value is a nested AgentState capturing the sub-agent's conversation.
	 */
	subAgents?: Record<string, AgentState>
	/** Estimated tokens in context window after the most recent generateText call (input + output). */
	contextWindowTokens?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create an initial AgentState from a message array.
 *
 * @example
 * ```ts
 * const result = await agent.run({ state: startState([userMessage('do stuff')]) }).result
 * ```
 */
export function startState(messages: ModelMessage[], toolState?: Record<string, unknown>): AgentState {
	return {
		messages,
		...(toolState ? { toolState } : {}),
	}
}

/**
 * Traverse the sub-agent tree to find the AgentState at the given path.
 *
 * - Empty path (`[]`) returns the root state itself.
 * - Each element of path is an agentId key in `state.subAgents`.
 * - Returns `undefined` if any segment is missing.
 *
 * @example
 * ```ts
 * const child = getAgentState(rootState, ['worker-1'])
 * const grandchild = getAgentState(rootState, ['worker-1', 'subworker-a'])
 * ```
 */
export function getAgentState(state: AgentState, path: AgentPath): AgentState | undefined {
	if (path.length === 0) return state
	const [head, ...rest] = path
	const child = state.subAgents?.[head!]
	if (child === undefined) return undefined
	return getAgentState(child, rest)
}

/**
 * Collect all pending approval entries across the entire sub-agent tree, annotated with their path.
 *
 * Returns an array of `{ path, pending }` pairs where:
 * - `path` is the AgentPath to the agent that has this pending entry
 * - `pending` is the PendingToolCall (only `type: 'approval'` entries — stopped/subAgent are excluded)
 *
 * Traverses depth-first: root pending entries first, then sub-agent entries.
 *
 * @example
 * ```ts
 * const allPending = getAllPendingApprovals(rootState)
 * for (const { path, pending } of allPending) {
 *   console.log(path, pending.toolCallId)
 * }
 * ```
 */
export function getAllPendingApprovals(state: AgentState): Array<{ path: AgentPath; pending: PendingToolCall }> {
	const results: Array<{ path: AgentPath; pending: PendingToolCall }> = []

	function collect(current: AgentState, currentPath: AgentPath): void {
		// Collect approval entries at this level (skip stopped and subAgent entries)
		for (const pending of current.pendingToolCalls ?? []) {
			if (pending.type === 'approval') {
				results.push({ path: currentPath, pending })
			}
		}
		// Recurse into sub-agents
		for (const [agentId, childState] of Object.entries(current.subAgents ?? {})) {
			collect(childState, [...currentPath, agentId])
		}
	}

	collect(state, [])
	return results
}

/**
 * Apply approval decisions to pending tool calls in state. Supports partial
 * decisions — you can approve/deny 1 of 3 pending, and the other 2 stay in
 * `pendingToolCalls`.
 *
 * Behavior per pending tool call:
 * - Matched + approved: entry removed from `pendingToolCalls`, recorded in `approvalHistory`
 *   (the loop will auto-execute the tool call on resume)
 * - Matched + denied: denial tool-result message injected into `messages`, entry
 *   removed from `pendingToolCalls`, recorded in `approvalHistory`
 * - Unmatched (no decision): stays in `pendingToolCalls`
 * - `type: 'stopped'` entries: untouched — not approval-gated
 * - `type: 'subAgent'` entries: unmatched decisions are passed down recursively
 *   into each `subAgents` entry
 *
 * Returns a new AgentState (immutable).
 *
 * @example
 * ```ts
 * const result2 = await agent.run({
 *   state: withApprovals(result1.state, [{ toolCallId: id, approved: true }]),
 * }).result
 * ```
 */
export function withApprovals(state: AgentState, decisions: ApprovalDecision[]): AgentState {
	const pending = state.pendingToolCalls ?? []
	if (decisions.length === 0) {
		// No decisions — still need to preserve subAgents structure
		return { ...state }
	}

	const decisionsByToolCallId = new Map(decisions.map((d) => [d.toolCallId, d]))

	const remainingPending: PendingToolCall[] = []
	const newHistoryEntries: ApprovalHistoryEntry[] = []
	const injectedMessages: ModelMessage[] = []
	// Track which decisions were consumed at this level so we can pass the rest down
	const consumedToolCallIds = new Set<string>()

	for (const entry of pending) {
		// 'stopped' entries are not approval-gated — leave them alone
		if (entry.type === 'stopped') {
			remainingPending.push(entry)
			continue
		}

		// 'subAgent' entries are not directly resolvable at this level — leave them alone
		if (entry.type === 'subAgent') {
			remainingPending.push(entry)
			continue
		}

		// 'approval' entry — look for a matching decision
		const decision = decisionsByToolCallId.get(entry.toolCallId)

		if (decision === undefined) {
			// No decision provided — keep it pending
			remainingPending.push(entry)
			continue
		}

		consumedToolCallIds.add(entry.toolCallId)

		// Record in history regardless of approval/denial
		newHistoryEntries.push({
			toolCallId: entry.toolCallId,
			toolName: entry.toolName,
			input: entry.input,
			approval: entry.approval,
			decision,
		})

		if (!decision.approved) {
			// Denied — inject a denial tool-result message into messages
			const denialMessage =
				decision.denialReason !== undefined
					? `The user denied this tool call with the following message: ${decision.denialReason}`
					: 'The user denied this tool call.'
			injectedMessages.push(buildToolResultMessage(entry.toolCallId, entry.toolName, denialMessage, false))
		}
		// Approved — entry removed from pendingToolCalls, auto-executed on resume
	}

	const newMessages = [...state.messages, ...injectedMessages]
	const newHistory = [...(state.approvalHistory ?? []), ...newHistoryEntries]

	// Pass remaining (unconsumed) decisions down to each subAgent recursively
	const remainingDecisions = decisions.filter((d) => !consumedToolCallIds.has(d.toolCallId))
	let newSubAgents: Record<string, AgentState> | undefined
	if (state.subAgents !== undefined && Object.keys(state.subAgents).length > 0) {
		if (remainingDecisions.length > 0) {
			// Recursively apply remaining decisions to each sub-agent
			newSubAgents = Object.fromEntries(
				Object.entries(state.subAgents).map(([agentId, childState]) => [
					agentId,
					withApprovals(childState, remainingDecisions),
				]),
			)
		} else {
			// No decisions to pass down — preserve subAgents as-is
			newSubAgents = state.subAgents
		}
	}

	return {
		messages: newMessages,
		...(remainingPending.length > 0 ? { pendingToolCalls: remainingPending } : {}),
		...(newHistory.length > 0 ? { approvalHistory: newHistory } : {}),
		...(state.toolState !== undefined ? { toolState: state.toolState } : {}),
		...(newSubAgents !== undefined ? { subAgents: newSubAgents } : {}),
	}
}
