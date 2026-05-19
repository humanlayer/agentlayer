import type { ApprovalRequest, StopOptions } from './shared'
import type { AgentLayerToolOutput } from '../messages'

export interface NextOptions {
	/** When true, patch the tool-call input in the assistant message so the model sees the mutated values. Default: false. */
	updateContextWindow?: boolean
	/** When true, inject a system notification telling the model the inputs were modified. Default: false. */
	notifyModel?: boolean
}

export interface NextResult {
	readonly type: 'next'
	updatedInput?: Record<string, unknown>
	/** When true, patch the tool-call input in the assistant message. */
	updateContextWindow?: boolean
	/** When true, inject a system notification about the mutation. */
	notifyModel?: boolean
}

export interface DenyResult {
	readonly type: 'deny'
	reason?: string
}

export interface AskResult {
	readonly type: 'ask'
	approval: ApprovalRequest
}

export interface ToolResultOptions {
	/** When true, the result is treated as an error and won't trigger toolCompleted() stop conditions. Default: false. */
	isError?: boolean
}

export interface ToolResultResult {
	readonly type: 'toolResult'
	output: AgentLayerToolOutput
	/** When true, the result is treated as an error (won't trigger toolCompleted()). */
	isError: boolean
}

export interface HookStopResult {
	readonly type: 'stop'
	/** Whether to include this tool's result in the context window. Defaults to true. */
	include?: boolean
	/** Optional output to use as the tool result when include is true. */
	output?: AgentLayerToolOutput
	/** If true, also drop all sibling tool results from the same parallel batch. */
	dropParallel?: boolean
	/** Human-readable reason for stopping. */
	reason?: string
}

export interface DoneResult {
	readonly type: 'done'
	mutatedResult?: AgentLayerToolOutput
}

export type PostToolUseResult = DoneResult

export function hookNext(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult {
	return {
		type: 'next',
		...(updatedInput !== undefined ? { updatedInput } : {}),
		...(opts?.updateContextWindow ? { updateContextWindow: true } : {}),
		...(opts?.notifyModel ? { notifyModel: true } : {}),
	}
}

export function hookDeny(reason?: string): DenyResult {
	return { type: 'deny', ...(reason !== undefined ? { reason } : {}) }
}

export function hookAsk(approval: ApprovalRequest): AskResult {
	return { type: 'ask', approval }
}

export function hookToolResult(output: AgentLayerToolOutput, opts?: ToolResultOptions): ToolResultResult {
	return { type: 'toolResult', output, isError: opts?.isError ?? false }
}

export function hookStop(options?: StopOptions): HookStopResult {
	return { type: 'stop', ...options }
}

export function hookDone(mutatedResult?: AgentLayerToolOutput): DoneResult {
	return { type: 'done', ...(mutatedResult !== undefined ? { mutatedResult } : {}) }
}
