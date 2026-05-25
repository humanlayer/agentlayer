import type { AgentState } from '@humanlayer/agentlayer-core'
import {
	type AgentLayerToolOutput,
	buildToolResultMessage,
	type HookStopResult,
	isToolResultOutput,
	type StopOptions,
	type ToolCallResult,
	type ToolSerializedOutput,
} from '@humanlayer/agentlayer-core'
import { Cause, Effect, Exit } from 'effect'
import { AgentStateService } from '../agent/services'
import { SpanName } from '../observability/span-names'
import {
	ToolExecutionError,
	type ToolInputZodError,
	ToolInterruptedError,
	type ToolNotFoundError,
	ToolOutputSerializationError,
} from './errors'
import { decodeToolInput } from './input-validation'
import { ToolRegistry } from './services'
import type { EffectToolContext, EffectToolContextFor, Tool, ToolCall } from './types'

export type RunToolCallError =
	| ToolNotFoundError
	| ToolInputZodError
	| ToolExecutionError
	| ToolInterruptedError
	| ToolOutputSerializationError

/**
 * A deferred context-window mutation requested by a tool during execution.
 * These are queued and then all run after tools finishe executing
 *
 */
type MessageUpdate = (messages: AgentState['messages']) => AgentState['messages']

/** 
 Mutable transaction draft used inside AgentStateService.modifyEffect while a single tool runs. 
*/
interface ToolTransaction<TState> {
	draft: AgentState
	pendingUpdates: MessageUpdate[]
	stateKey?: string
	stateValue?: TState
}

/**
 *  Identifies the stop sentinel returned by EffectToolContext.stop.
 */
function isHookStopResult(value: unknown): value is HookStopResult {
	return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'stop'
}

/**
 * Formats unknown failure causes into a stable, model-safe string.
 */
function formatUnknownErrorForModel(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/**
 * Returns the first typed failure in a Cause, if one exists. \
 */
function firstFailure(cause: Cause.Cause<unknown>): unknown {
	return Array.from(Cause.failures(cause))[0]
}

/**
 * Narrows a Cause failure to the tool execution error emitted by tool implementations.
 */
function isToolExecutionError(value: unknown): value is ToolExecutionError {
	return typeof value === 'object' && value !== null && (value as { _tag?: unknown })._tag === 'ToolExecutionError'
}

/**
 * Converts a raw tool return value into AgentLayer's model-visible tool output format.
 *
 * Tools can return either their declared `TOutput` or a pre-serialized `ToolSerializedOutput`.
 * Pre-serialized outputs (strings or structured ToolResultPart outputs) bypass the serializer.
 */
export function normalizeToolOutput<TInput, TOutput, TState>(
	tool: Tool<TInput, TOutput, TState>,
	raw: TOutput | ToolSerializedOutput,
	input: TInput,
): AgentLayerToolOutput {
	// Already-serialized structured output (multi-modal, json, error, etc.) - pass through
	if (isToolResultOutput(raw)) return raw
	// Already-serialized string output - pass through
	if (typeof raw === 'string') return raw
	// Raw TOutput with custom serializer
	if (tool.serialize) return tool.serialize(raw as TOutput, input)
	// Raw TOutput with default JSON serialization
	try {
		return JSON.stringify(raw) ?? String(raw)
	} catch {
		return String(raw)
	}
}

/**
 * Appends the tool result message and applies any deferred context-window mutations.
 */
function applyToolResultMessage(state: AgentState, result: ToolCallResult): AgentState {
	let messages: AgentState['messages'] = [...state.messages, result.message]
	for (const update of result.pendingUpdates) {
		messages = update(messages)
	}
	return { ...state, messages }
}

/**
 * Builds the canonical ToolCallResult shape from normalized output and execution metadata.
 */
function makeToolResult(args: {
	readonly toolCall: ToolCall
	readonly output: AgentLayerToolOutput
	readonly rawOutput: unknown
	readonly isError: boolean
	readonly pendingUpdates: ReadonlyArray<MessageUpdate>
	readonly stopRequested?: StopOptions
	readonly toolStateUpdate?: { key: string; value: unknown }
}): ToolCallResult {
	return {
		toolCallId: args.toolCall.toolCallId,
		toolName: args.toolCall.toolName,
		message: buildToolResultMessage(args.toolCall.toolCallId, args.toolCall.toolName, args.output, args.isError),
		output: args.output,
		rawOutput: args.rawOutput,
		isError: args.isError,
		pendingUpdates: [...args.pendingUpdates],
		...(args.stopRequested !== undefined ? { stopRequested: args.stopRequested } : {}),
		...(args.toolStateUpdate !== undefined ? { toolStateUpdate: args.toolStateUpdate } : {}),
	}
}

/**
 * Returns the tool-state update recorded by the transaction, if this tool is stateful.
 */
function toolStateUpdate<TState>(transaction: ToolTransaction<TState>): { key: string; value: unknown } | undefined {
	if (!transaction.stateKey) return undefined
	return { key: transaction.stateKey, value: transaction.stateValue }
}

/**
 * Builds the tool-facing context from the live transaction draft.
 * Reads see the current draft state, and state/context mutations update the draft before commit.
 */
function buildToolContext<TState>(
	toolCall: ToolCall,
	transaction: ToolTransaction<TState>,
): EffectToolContextFor<TState> {
	const context: EffectToolContext = {
		getContextWindow: () =>
			Object.freeze([...transaction.draft.messages]) as ReadonlyArray<AgentState['messages'][number]>,
		updateContextWindow: (update) => transaction.pendingUpdates.push(update),
		stop: (options?: StopOptions): HookStopResult => ({ type: 'stop', ...options }),
		getContextWindowTokens: () => transaction.draft.contextWindowTokens ?? 0,
		getContextWindowLimit: () => undefined,
		toolCallId: toolCall.toolCallId,
	}

	if (!transaction.stateKey) return context as EffectToolContextFor<TState>

	return {
		...context,
		getToolState: () => transaction.stateValue,
		updateToolState: (updater) => {
			transaction.stateValue = updater(transaction.stateValue)
			transaction.draft = {
				...transaction.draft,
				toolState: {
					...transaction.draft.toolState,
					[transaction.stateKey!]: transaction.stateValue,
				},
			}
		},
	} as EffectToolContextFor<TState>
}

/**
 * Executes an already-resolved tool inside an AgentStateService transaction.
 */
function runResolvedToolCall<TInput, TOutput, TState>(tool: Tool<TInput, TOutput, TState>, toolCall: ToolCall) {
	return Effect.gen(function* () {
		const input = yield* decodeToolInput(tool.inputSchema, toolCall.input, {
			toolName: toolCall.toolName,
			toolCallId: toolCall.toolCallId,
		})

		const state = yield* AgentStateService

		return yield* state.modifyEffect((currentState) =>
			Effect.gen(function* () {
				const transaction: ToolTransaction<TState> = {
					draft: currentState,
					pendingUpdates: [],
					...(tool.stateKey !== undefined
						? {
								stateKey: tool.stateKey,
								stateValue: currentState.toolState?.[tool.stateKey] as TState | undefined,
							}
						: {}),
				}

				const toolContext = buildToolContext(toolCall, transaction)

				yield* Effect.logInfo('tool execution started').pipe(
					Effect.annotateLogs({
						'tool.name': toolCall.toolName,
						'tool.callId': toolCall.toolCallId,
					}),
				)

				const toolExit = yield* Effect.exit(
					Effect.scoped(tool.execute(input, toolContext)).pipe(
						Effect.withSpan(SpanName.toolExecute(toolCall.toolName)),
					),
				)

				if (Exit.isFailure(toolExit)) {
					if (Cause.isInterruptedOnly(toolExit.cause)) {
						yield* Effect.logWarning('tool execution interrupted').pipe(
							Effect.annotateLogs({
								'tool.name': toolCall.toolName,
								'tool.callId': toolCall.toolCallId,
							}),
						)

						return yield* new ToolInterruptedError({
							toolName: toolCall.toolName,
							toolCallId: toolCall.toolCallId,
							cause: toolExit.cause,
						})
					}

					const failure = firstFailure(toolExit.cause)
					const error = isToolExecutionError(failure)
						? failure
						: new ToolExecutionError({
								toolName: toolCall.toolName,
								toolCallId: toolCall.toolCallId,
								cause: failure ?? Cause.squash(toolExit.cause),
							})

					yield* Effect.logError('tool execution failed').pipe(
						Effect.annotateLogs({
							'tool.name': toolCall.toolName,
							'tool.callId': toolCall.toolCallId,
							'tool.error._tag': error._tag,
						}),
					)

					return yield* error
				}

				if (isHookStopResult(toolExit.value)) {
					const output = toolExit.value.output ?? toolExit.value.reason ?? 'Tool requested stop'
					const result = makeToolResult({
						toolCall,
						output,
						rawOutput: toolExit.value,
						isError: false,
						pendingUpdates: transaction.pendingUpdates,
						stopRequested: {
							include: toolExit.value.include,
							output: toolExit.value.output,
							dropParallel: toolExit.value.dropParallel,
							reason: toolExit.value.reason,
						},
						toolStateUpdate: toolStateUpdate(transaction),
					})
					return [result, applyToolResultMessage(transaction.draft, result)] as const
				}

				const outputExit = yield* Effect.exit(
					Effect.sync(() => normalizeToolOutput(tool, toolExit.value, input)),
				)

				if (Exit.isFailure(outputExit)) {
					yield* Effect.logError('tool output serialization failed').pipe(
						Effect.annotateLogs({
							'tool.name': toolCall.toolName,
							'tool.callId': toolCall.toolCallId,
						}),
					)

					return yield* new ToolOutputSerializationError({
						toolName: toolCall.toolName,
						toolCallId: toolCall.toolCallId,
						reason: formatUnknownErrorForModel(Cause.squash(outputExit.cause)),
					})
				}

				const result = makeToolResult({
					toolCall,
					output: outputExit.value,
					rawOutput: toolExit.value,
					isError: false,
					pendingUpdates: transaction.pendingUpdates,
					toolStateUpdate: toolStateUpdate(transaction),
				})

				yield* Effect.logInfo('tool execution completed').pipe(
					Effect.annotateLogs({
						'tool.name': toolCall.toolName,
						'tool.callId': toolCall.toolCallId,
						'tool.isError': false,
					}),
				)

				return [result, applyToolResultMessage(transaction.draft, result)] as const
			}),
		)
	}).pipe(Effect.withSpan(SpanName.toolResolve(toolCall.toolName)))
}

/**
 * Resolves a tool call against the current ToolRegistry and executes it transactionally.
 * Tool execution failures fail this Effect so the agent loop can convert them to model-visible results.
 */
export function runToolCall(toolCall: ToolCall) {
	return Effect.gen(function* () {
		const registry = yield* ToolRegistry
		const tool = yield* registry.get(toolCall.toolName)

		return yield* runResolvedToolCall(tool, toolCall)
	}).pipe(Effect.withSpan(SpanName.toolResolve(toolCall.toolName)))
}
