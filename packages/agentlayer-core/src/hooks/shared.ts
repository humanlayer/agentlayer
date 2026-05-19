import type { z } from 'zod'
import type { AgentLayerToolOutput } from '../messages'

export interface HookStateAccess {
	getState<T>(key: string): T | undefined
	updateState<T>(key: string, updater: (current: T | undefined) => T): void
}

export interface HookStateOperation {
	key: string
	apply: (current: unknown) => unknown
}

export interface HookChainStateResult<T> {
	result: T
	stateUpdates: HookStateOperation[]
}

export interface ToolInfo<TInput = unknown, TOutput = unknown> {
	name: string
	inputSchema: z.ZodType<TInput>
	outputSchema?: z.ZodType<TOutput>
}

export interface ApprovalRequest {
	id: string
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	metadata?: Record<string, unknown>
	message?: string
}

export interface ApprovalRequestData {
	/** Unique identifier for this approval request. If omitted, defaults to the toolCallId. */
	id?: string
	metadata?: Record<string, unknown>
	message?: string
}

export interface StopOptions {
	/** Whether to include this tool's result in the context window. Defaults to true. */
	include?: boolean
	/** Optional output to use as the tool result when include is true. */
	output?: AgentLayerToolOutput
	/** If true, also drop all sibling tool results from the same parallel batch. */
	dropParallel?: boolean
	/** Human-readable reason for stopping. */
	reason?: string
}

export type PendingToolCall = {
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
} & (
	| { type: 'approval'; approval: ApprovalRequest }
	| { type: 'stopped'; reason?: string; suggestedResult?: string }
	| { type: 'subAgent'; agentId: string; subAgentType: string }
)

export interface ToolRef<TInput = any, TOutput = any> {
	name: string
	input: z.ZodType<TInput>
	output?: z.ZodType<TOutput>
}

export type ExtractToolInput<T> = T extends ToolRef<infer TInput, any> ? TInput : never

export type ToolInputUnion<T extends ReadonlyArray<ToolRef>> = ExtractToolInput<T[number]>
