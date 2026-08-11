import type { ModelMessage, ToolResultPart } from 'ai'
import { z } from 'zod'
import type { Agent } from './agent'
import type { HookStopResult, StopOptions } from './hooks'
import type { AgentState, TerminalChildRecord } from './state'

/**
 * Context provided to every tool during execution.
 *
 * Tools receive a fresh `ToolContext` on each invocation. The context gives
 * tools read access to the conversation so far, a way to queue deferred
 * mutations to that conversation, cooperative cancellation via `signal`,
 * and the ability to stop the loop.
 */
export interface ToolContext {
	/**
	 * Returns a **frozen, read-only snapshot** of the conversation messages at
	 * the time of the call. This does NOT include the tool's own result — that
	 * hasn't been produced yet.
	 *
	 * This is a function rather than a static property so that concurrent tool
	 * calls always get a fresh snapshot — if another tool in a parallel batch
	 * commits its result first, subsequent calls to `getContextWindow()` will
	 * reflect that update.
	 *
	 * Use this to inspect prior messages (e.g. count tokens, look up earlier
	 * tool results, etc.) without risk of mutating the agent loop's state.
	 */
	getContextWindow(): ReadonlyArray<ModelMessage>

	/**
	 * Queue a deferred mutation to the conversation's message array.
	 *
	 * The callback is **not** applied immediately — it runs after the tool's
	 * result message has been committed to the conversation. This means the
	 * `messages` array your callback receives already contains this tool's
	 * result. The callback must return a new array (typically spread + append).
	 *
	 * Common use case: injecting a follow-up `{ role: 'user' }` message that
	 * the model will see on its next turn.
	 *
	 * Multiple calls queue multiple transforms, applied in order.
	 *
	 * @example
	 * ctx.updateContextWindow((messages) => [
	 *   ...messages,
	 *   { role: 'user', content: 'Additional instruction from tool' },
	 * ])
	 */
	updateContextWindow(cb: (messages: ModelMessage[]) => ModelMessage[]): void

	/**
	 * An `AbortSignal` tied to the agent run's lifecycle.
	 *
	 * The signal is **not** checked mid-tool — tools always run to completion.
	 * After a tool finishes, the agent loop checks `signal.aborted` before
	 * starting the next iteration and will finish with `finishReason: 'interrupted'`.
	 *
	 * Tools can pass this signal to fetch calls, child processes, or other
	 * async work that supports cooperative cancellation.
	 */
	signal: AbortSignal

	/**
	 * Whether the current run should surface live model streaming events.
	 *
	 * Sub-agent tools can propagate this flag to nested `agent.run(...)` calls so
	 * child model deltas appear on the same iterator surface as the parent run.
	 */
	stream?: boolean

	/**
	 * Request the agent loop to stop after this tool call completes.
	 *
	 * Returns a `HookStopResult` that the tool should `return` to signal the stop.
	 * The loop checks `stopRequested` on `ToolCallResult` before appending:
	 *   - `include: false` → tool result NOT appended to context window
	 *   - `include: true` (default) → tool result IS appended
	 *   - `dropParallel: true` → sibling results from the same batch are also dropped
	 *
	 * @example
	 * execute: async (input, ctx) => {
	 *   if (input.shouldStop) return ctx.stop({ reason: 'User requested stop' })
	 *   return 'normal output'
	 * }
	 */
	stop(options?: StopOptions): HookStopResult

	/** Returns the estimated token count in the current context window. Updated after each streamText call. */
	getContextWindowTokens(): number

	/**
	 * Returns the context window token limit for the current model.
	 *
	 * Auto-resolved from models.dev at agent construction time, or set
	 * explicitly via `AgentConfig.contextWindowLimit`. Returns `undefined`
	 * if the limit is unknown.
	 */
	getContextWindowLimit(): number | undefined

	// ── Sub-agent integration (only wired up by executeToolCall when running inside an agent) ──

	/**
	 * The ID of this tool call. Exposed for sub-agent tools that need to pass it
	 * as `parentToolCallId` for event grouping.
	 */
	toolCallId?: string

	/** Stable prompt cache scope for this agent run. */
	promptCacheKey?: string

	/**
	 * Signal that this tool is pausing because a child agent needs approval.
	 * Returns a sentinel that the tool should `return` — the loop will detect it
	 * and park the tool call as a `type: 'subAgent'` pending entry.
	 * Only available when the agent has sub-agent support configured.
	 */
	pauseForSubAgent?: (agentId: string, childState: AgentState) => SubAgentPauseResult

	/**
	 * Retrieve the saved state for a previously-paused sub-agent (for resumption).
	 * Returns `undefined` if no state exists for the given agentId.
	 * Only available when the agent has sub-agent support configured.
	 */
	getSubAgentState?: (agentId: string) => AgentState | undefined

	/** Retrieve a terminal child continuation record by stable ID. */
	getTerminalChild?: (agentId: string) => TerminalChildRecord | undefined
	/** Persist a terminal child continuation record under its stable ID. */
	setTerminalChild?: (agentId: string, record: TerminalChildRecord) => void

	/**
	 * Capture an isolated snapshot of the calling agent and create a child with
	 * the same runtime configuration. The snapshot is taken once per call and
	 * contains no mutable references to the caller.
	 */
	createSubAgentFork?: () => { agent: Agent; state: AgentState }
	/** Create an equivalent fork runtime without capturing or projecting caller state. */
	createSubAgentForkAgent?: () => Agent

	/**
	 * Await a child agent run, handling event forwarding and activeChildren registration.
	 * Returns the child's RunResult. The `childRun` parameter accepts any AsyncIterable<AgentEvent>
	 * with a `result` promise (i.e. an AgentRun).
	 * Only available when the agent has sub-agent support configured.
	 */
	awaitSubAgent?: (childRun: SubAgentRunHandle, agentId: string, parentToolCallId: string) => Promise<SubAgentResult>
}

/** Minimal interface for a child agent run — avoids circular import with AgentRun. */
export interface SubAgentRunHandle extends AsyncIterable<import('./agent-run').AgentEvent> {
	result: Promise<SubAgentResult>
	running: boolean
}

/** Minimal result interface for sub-agent runs — avoids circular import with RunResult. */
export interface SubAgentResult {
	state: AgentState
	finishReason: string
	newMessages: ModelMessage[]
}

/** Sentinel returned by `ctx.pauseForSubAgent()` — detected by executeToolCall. */
export interface SubAgentPauseResult {
	readonly type: 'subAgentPause'
	agentId: string
	childState: AgentState
}

/**
 * State accessors provided to stateful tools during execution.
 * Only available when a tool declares `stateKey` and `stateSchema`.
 */
export interface ToolStateAccessors<TState> {
	/** Returns the current tool state, or undefined if no state has been set yet. */
	getToolState(): TState | undefined
	/** Update the tool's state. The updater receives the current state and must return the new state. */
	updateToolState(updater: (current: TState | undefined) => TState): void
}

/**
 * Helper type: resolves to `ToolContext` for stateless tools (`TState = never`),
 * or `ToolContext & ToolStateAccessors<TState>` for stateful tools.
 */
export type ToolContextFor<TState> = [TState] extends [never] ? ToolContext : ToolContext & ToolStateAccessors<TState>

export type ToolSerializedOutput = string | ToolResultPart['output']

export interface Tool<TInput = any, TOutput = string> {
	name: string
	description: string
	input: z.ZodType<TInput>
	/** Zod schema for the raw output type. Defaults to z.string() when not provided. */
	output?: z.ZodType<TOutput>
	execute: (input: TInput, ctx: ToolContext) => Promise<TOutput | HookStopResult>
	/**
	 * Serialize raw TOutput to a string for the model.
	 * Defaults to: string passed as-is, everything else JSON.stringify'd.
	 * Note: uses `unknown` parameter type for variance compatibility when storing in Record<string, Tool>.
	 */
	serialize?: (raw: any, input: any) => ToolSerializedOutput
	/** Runtime marker: key under which this tool's state is stored in AgentState.toolState. */
	stateKey?: string
	/** Runtime marker: Zod schema for the tool's state slice. */
	stateSchema?: z.ZodType<unknown>
}

// Overload 1: stateful tool (both stateKey AND stateSchema required) — must be first for correct resolution
export function defineTool<TInput, TOutput = string, TState = never>(config: {
	name: string
	description: string
	input: z.ZodType<TInput>
	output?: z.ZodType<TOutput>
	stateKey: string
	stateSchema: z.ZodType<TState>
	execute: (input: TInput, ctx: ToolContext & ToolStateAccessors<TState>) => Promise<TOutput | HookStopResult>
	serialize?: (raw: any, input: any) => ToolSerializedOutput
}): Tool<TInput, TOutput>

// Overload 2: stateless tool (no stateKey/stateSchema — same as before)
export function defineTool<TInput, TOutput = string>(config: {
	name: string
	description: string
	input: z.ZodType<TInput>
	output?: z.ZodType<TOutput>
	execute: (input: TInput, ctx: ToolContext) => Promise<TOutput | HookStopResult>
	serialize?: (raw: any, input: any) => ToolSerializedOutput
}): Tool<TInput, TOutput>

// Implementation
export function defineTool(config: any): Tool {
	return config
}

/**
 * Separate tool shape from execution. Returns an object with `.define(executor)` method.
 * Optional `beforeExecutionTransform` preprocesses input; `serialize` post-processes raw output to string.
 */
export interface ToolInterfaceConfig<TInput, TOutput = string> {
	name: string
	description: string
	input: z.ZodType<TInput>
	/** Zod schema for the raw output type. When omitted, defaults to z.string(). */
	output?: z.ZodType<TOutput>
	/** Transform input before passing to executor. */
	beforeExecutionTransform?: (input: TInput, ctx: ToolContext) => TInput
	/**
	 * Serialize raw TOutput to a string for the model.
	 * Replaces the old `afterExecutionTransform`. The ctx parameter is available
	 * for tools that need to inspect the context window during serialization.
	 * Defaults to: string passed as-is, everything else JSON.stringify'd.
	 */
	serialize?: (raw: TOutput, input: TInput, ctx: ToolContext) => ToolSerializedOutput
}

export interface ToolInterface<TInput, TOutput = string, TState = never> {
	name: string
	description: string
	input: z.ZodType<TInput>
	output?: z.ZodType<TOutput>
	stateKey?: string
	stateSchema?: z.ZodType<unknown>
	beforeExecutionTransform?: (input: TInput, ctx: ToolContext) => TInput
	serialize?: (raw: TOutput, input: TInput, ctx: ToolContext) => ToolSerializedOutput
	define(
		executor: (input: TInput, ctx: ToolContextFor<TState>) => Promise<TOutput>,
		overrides?: { description?: string },
	): Tool<TInput, TOutput>
}

// Overload 1: stateless interface (same as before)
export function defineToolInterface<TInput, TOutput = string>(
	config: ToolInterfaceConfig<TInput, TOutput>,
): ToolInterface<TInput, TOutput>

// Overload 2: stateful interface (both stateKey and stateSchema required)
export function defineToolInterface<TInput, TOutput = string, TState = never>(
	config: ToolInterfaceConfig<TInput, TOutput> & {
		stateKey: string
		stateSchema: z.ZodType<TState>
	},
): ToolInterface<TInput, TOutput, TState>

// Implementation
export function defineToolInterface<TInput, TOutput = string>(
	config: ToolInterfaceConfig<TInput, TOutput> & {
		stateKey?: string
		stateSchema?: z.ZodType<unknown>
	},
): ToolInterface<TInput, TOutput, any> {
	// Default output schema: z.string() when no output schema provided
	const outputSchema = (config.output ?? z.string()) as z.ZodType<TOutput>

	return {
		...config,
		output: outputSchema,
		define(
			executor: (input: TInput, ctx: any) => Promise<TOutput>,
			overrides?: { description?: string },
		): Tool<TInput, TOutput> {
			return defineTool({
				name: config.name,
				description: overrides?.description ?? config.description,
				input: config.input,
				output: outputSchema,
				// Carry through state markers so executeToolCall can detect stateful tools
				...(config.stateKey ? { stateKey: config.stateKey, stateSchema: config.stateSchema } : {}),
				// Wire serialize: Tool.serialize is (raw, input) => string.
				// We close over the interface's serialize which takes ctx too,
				// but for Tool.serialize we don't have ctx available at call time.
				// Interface-level serialize gets an empty ctx stub for compat.
				serialize: config.serialize
					? (raw: TOutput, input: TInput) =>
							config.serialize!(raw, input, {
								getContextWindow: () => [],
								updateContextWindow: () => {},
								signal: new AbortController().signal,
								stop: (opts) => ({ type: 'stop', ...opts }),
								getContextWindowTokens: () => 0,
								getContextWindowLimit: () => undefined,
							} as ToolContext)
					: undefined,
				execute: async (input: TInput, ctx: ToolContext) => {
					const transformedInput = config.beforeExecutionTransform
						? config.beforeExecutionTransform(input, ctx)
						: input
					const raw = await executor(transformedInput, ctx)
					return raw
				},
			} as any)
		},
	}
}
