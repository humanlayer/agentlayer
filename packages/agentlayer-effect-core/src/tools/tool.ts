import type { ToolContext, ToolSerializedOutput } from '@humanlayer/agentlayer-core'
import type { Effect } from 'effect'
import type { z } from 'zod'
import type { ToolExecutionError } from './errors'

export type ToolInputSchema<T> = z.ZodType<T>

export interface Tool<TInput = any, TOutput = any> {
	readonly name: string
	readonly description: string
	readonly inputSchema: ToolInputSchema<TInput>
	readonly execute: (
		input: TInput,
		ctx: ToolContext,
	) => Effect.Effect<TOutput | ToolSerializedOutput, ToolExecutionError>
	readonly serialize?: (raw: TOutput, input: TInput) => ToolSerializedOutput
	readonly stateKey?: string
}
