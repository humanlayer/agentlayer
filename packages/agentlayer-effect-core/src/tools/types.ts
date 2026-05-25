import type { HookStopResult, StopOptions, ToolSerializedOutput } from '@humanlayer/agentlayer-core'
import type { ModelMessage } from 'ai'
import type { Effect } from 'effect'
import type { z } from 'zod'
import type { ToolExecutionError } from './errors'

/**
 * Type for tool input schema (zod)
 */
export type ToolInputSchema<T> = z.ZodType<T>

/**
 * Defines the information defining a tool call
 */
export interface ToolCall<TInput = unknown> {
	readonly toolCallId: string
	readonly toolName: string
	readonly input: TInput
}

/**
 * This describes the Context that tool executor effects receive
 */
export interface EffectToolContext {
	readonly getContextWindow: () => ReadonlyArray<ModelMessage>
	readonly updateContextWindow: (cb: (messages: ModelMessage[]) => ModelMessage[]) => void
	readonly stop: (options?: StopOptions) => HookStopResult
	readonly getContextWindowTokens: () => number
	readonly getContextWindowLimit: () => number | undefined
	readonly toolCallId: string
}

/**
 * Tool state accessors available to tools that declare a state key.
 */
export interface EffectToolStateAccess<TState = unknown> {
	readonly getToolState: () => TState | undefined
	readonly updateToolState: (updater: (current: TState | undefined) => TState) => void
}

export type EffectToolContextFor<TState = never> = [TState] extends [never]
	? EffectToolContext
	: EffectToolContext & EffectToolStateAccess<TState>

/**
 * the interface that tools must satisfy
 */
export interface Tool<TInput = any, TOutput = any, TState = never> {
	readonly name: string
	readonly description: string
	readonly inputSchema: ToolInputSchema<TInput>
	readonly execute: (
		input: TInput,
		ctx: EffectToolContextFor<TState>,
	) => Effect.Effect<TOutput | ToolSerializedOutput, ToolExecutionError>
	readonly serialize?: (raw: TOutput, input: TInput) => ToolSerializedOutput
	readonly stateKey?: string
}
