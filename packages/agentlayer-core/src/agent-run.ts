import type { ModelMessage } from 'ai'
import type { RunResult } from './agent'
import type { ApprovalRequest } from './hooks'
import type { ApprovalDecision } from './state'
import type { TokenUsageEvent } from './token-usage'

// ── AgentEvent — discriminated union for the async iterator ──────────────────

type AgentEventMeta = {
	agentId?: string
	parentToolCallId?: string
}

export type AgentEvent =
	| ({
			type: 'message'
			message: ModelMessage
	  } & AgentEventMeta)
	| ({
			type: 'approvalRequested'
			approval: ApprovalRequest
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
	  } & AgentEventMeta)
	| ({
			type: 'tokenUsage'
			usage: TokenUsageEvent
	  } & AgentEventMeta)
	| ({
			type: 'stepStart'
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'textStart'
			id: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'textDelta'
			id: string
			text: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'textEnd'
			id: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'toolInputStart'
			id: string
			toolName: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'toolInputDelta'
			id: string
			delta: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'toolInputEnd'
			id: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'reasoningDelta'
			id: string
			text: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'reasoningStart'
			id: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'reasoningEnd'
			id: string
			stepIndex: number
	  } & AgentEventMeta)
	| ({
			type: 'stepFinish'
			stepIndex: number
			finishReason?: string
	  } & AgentEventMeta)

export class AgentRun implements AsyncIterable<AgentEvent> {
	private state: { type: 'pending' } | { type: 'resolved'; value: RunResult } = { type: 'pending' }

	private promise: Promise<RunResult> | undefined
	private resolve: ((value: RunResult) => void) | undefined

	// Buffer for events + iterator notification
	private events: AgentEvent[] = []
	private iteratorResolve: ((value: IteratorResult<AgentEvent>) => void) | undefined
	private done = false

	// Lifecycle state — set by executeLoop, not the constructor
	private _running = true

	/** Whether this run should surface live model streaming events. */
	stream = false

	/** Optional callback fired on every pushEvent — used by executeLoop to process forwarded child events. */
	onEvent?: (event: AgentEvent) => void

	// ── Live approval resolution state ──────────────────────────────────────

	/** Per-approval promise resolvers, keyed by toolCallId. Populated by the ask branch in executeLoop. */
	readonly pendingResolvers = new Map<string, (decision: ApprovalDecision) => void>()

	/** Currently-running child AgentRuns (transient, never serialized). */
	readonly activeChildren = new Set<AgentRun>()

	get running(): boolean {
		return this._running
	}

	get result(): Promise<RunResult> {
		if (this.promise) return this.promise

		this.promise = new Promise<RunResult>((resolve) => {
			if (this.state.type === 'resolved') {
				resolve(this.state.value)
			}
			this.resolve = resolve
		})

		return this.promise
	}

	/**
	 * Inject an approval decision into a live run.
	 *
	 * Checks own `pendingResolvers` first, then delegates recursively to `activeChildren`.
	 * Returns `true` if the decision was delivered, `false` if no matching resolver was found
	 * (caller should fall back to the cold path: `withApprovals()` + `agent.run()`).
	 */
	resolveApproval(toolCallId: string, decision: 'approve' | 'deny', reason?: string): boolean {
		// Check own resolvers
		const resolver = this.pendingResolvers.get(toolCallId)
		if (resolver) {
			const approvalDecision: ApprovalDecision =
				decision === 'approve'
					? { toolCallId, approved: true }
					: { toolCallId, approved: false, denialReason: reason }
			resolver(approvalDecision)
			this.pendingResolvers.delete(toolCallId)
			return true
		}

		// Delegate to active children
		for (const child of this.activeChildren) {
			if (child.resolveApproval(toolCallId, decision, reason)) {
				return true
			}
		}

		return false
	}

	// Called by the loop to push a message (wraps in AgentEvent envelope)
	push(msg: ModelMessage): void {
		this.pushEvent({ type: 'message', message: msg })
	}

	// Push an arbitrary AgentEvent to the stream
	pushEvent(event: AgentEvent): void {
		this.onEvent?.(event)
		this.events.push(event)
		if (this.iteratorResolve) {
			const resolve = this.iteratorResolve
			this.iteratorResolve = undefined
			resolve({ value: event, done: false })
		}
	}

	// Called by the loop when it finishes (including error finishes)
	finish(value: RunResult): void {
		this.state = { type: 'resolved', value }
		this._running = false
		this.done = true
		// Clear resolvers — hot path no longer available after run ends
		this.pendingResolvers.clear()
		this.resolve?.(value)
		// Wake up any waiting iterator
		if (this.iteratorResolve) {
			const resolve = this.iteratorResolve
			this.iteratorResolve = undefined
			resolve({ value: undefined as unknown as AgentEvent, done: true })
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
		let index = 0
		while (true) {
			// Yield any buffered events first
			while (index < this.events.length) {
				yield this.events[index]!
				index++
			}

			// If we're done, stop
			if (this.done) {
				return
			}

			// Wait for the next event or completion
			await new Promise<IteratorResult<AgentEvent>>((resolve) => {
				this.iteratorResolve = resolve
			})
		}
	}
}
