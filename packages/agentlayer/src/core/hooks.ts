/**
 * Hook result types — branded objects with `type` discriminant.
 *
 * These are returned by pre-tool-use and post-tool-use hooks to signal
 * to the agent loop what action to take.
 */

import type { ModelMessage } from 'ai'
import type { z } from 'zod'

// ── Pre-tool-use result types ─────────────────────────────────────────────────

/** Options for ctx.next() when passing updated input. */
export interface NextOptions {
	/** When true, patch the tool-call input in the assistant message so the model sees the mutated values. Default: false. */
	updateContextWindow?: boolean
	/** When true, inject a system notification telling the model the inputs were modified. Default: false. */
	notifyModel?: boolean
}

/** Continue with tool execution, optionally with mutated input. */
export interface NextResult {
	readonly type: 'next'
	updatedInput?: Record<string, unknown>
	/** When true, patch the tool-call input in the assistant message. */
	updateContextWindow?: boolean
	/** When true, inject a system notification about the mutation. */
	notifyModel?: boolean
}

/** Block tool execution with an optional reason (model sees an error result). */
export interface DenyResult {
	readonly type: 'deny'
	reason?: string
}

/** Request human approval before execution. */
export interface AskResult {
	readonly type: 'ask'
	approval: ApprovalRequest
}

/** Short-circuit execution with a provided output (model sees this as the tool result). */
export interface ToolResultResult {
	readonly type: 'toolResult'
	output: string
}

/** Stop the agent loop. Controls whether this tool's result is appended and what happens to siblings. */
export interface HookStopResult {
	readonly type: 'stop'
	/** Whether to include this tool's result in the context window. Defaults to true. */
	include?: boolean
	/** Optional output string to use as the tool result when include is true. */
	output?: string
	/** If true, also drop all sibling tool results from the same parallel batch. */
	dropParallel?: boolean
	/** Human-readable reason for stopping. */
	reason?: string
}

// ── Post-tool-use result types ────────────────────────────────────────────────

/** Accept the tool result, optionally with a mutated output string. */
export interface DoneResult {
	readonly type: 'done'
	mutatedResult?: string
}

/** All possible outcomes of a postToolUse hook. */
export type PostToolUseResult = DoneResult

// ── Approval types ────────────────────────────────────────────────────────────

/** Identifies a pending approval request. */
export interface ApprovalRequest {
	id: string
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	metadata?: Record<string, unknown>
	message?: string
}

// ── Stop options (used by ctx.stop() on ToolContext) ─────────────────────────

export interface StopOptions {
	/** Whether to include this tool's result in the context window. Defaults to true. */
	include?: boolean
	/** Optional output string to use as the tool result when include is true. */
	output?: string
	/** If true, also drop all sibling tool results from the same parallel batch. */
	dropParallel?: boolean
	/** Human-readable reason for stopping. */
	reason?: string
}

// ── PendingToolCall — unified discriminated type for RunResult.pendingToolCalls ──

export type PendingToolCall = {
	toolCallId: string
	toolName: string
	input: Record<string, unknown>
} & (
	| { type: 'approval'; approval: ApprovalRequest }
	| { type: 'stopped'; reason?: string; suggestedResult?: string }
	| { type: 'subAgent'; agentId: string; subAgentType: string }
)

// ── Factory functions ─────────────────────────────────────────────────────────

/** Continue with execution (and optionally mutate the input). */
export function hookNext(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult {
	return {
		type: 'next',
		...(updatedInput !== undefined ? { updatedInput } : {}),
		...(opts?.updateContextWindow ? { updateContextWindow: true } : {}),
		...(opts?.notifyModel ? { notifyModel: true } : {}),
	}
}

/** Deny execution with an optional reason. */
export function hookDeny(reason?: string): DenyResult {
	return { type: 'deny', ...(reason !== undefined ? { reason } : {}) }
}

/** Request approval before execution. */
export function hookAsk(approval: ApprovalRequest): AskResult {
	return { type: 'ask', approval }
}

/** Short-circuit with a provided tool result output. */
export function hookToolResult(output: string): ToolResultResult {
	return { type: 'toolResult', output }
}

/** Stop from a hook (same semantics as ctx.stop() on ToolContext). */
export function hookStop(options?: StopOptions): HookStopResult {
	return { type: 'stop', ...options }
}

/** Accept the result (optionally mutated). */
export function hookDone(mutatedResult?: string): DoneResult {
	return { type: 'done', ...(mutatedResult !== undefined ? { mutatedResult } : {}) }
}

// ── Shared hook base types ────────────────────────────────────────────────────

/**
 * Metadata about the tool being called.
 * Enables narrowing in multi-tool hooks.
 */
export interface ToolInfo<TInput = unknown, TOutput = unknown> {
	name: string
	inputSchema: z.ZodType<TInput>
	outputSchema?: z.ZodType<TOutput>
}

/**
 * Data required to create an approval request.
 * The hook system auto-populates toolName, toolCallId, and input.
 */
export interface ApprovalRequestData {
	/** Unique identifier for this approval request. If omitted, defaults to the toolCallId. */
	id?: string
	metadata?: Record<string, unknown>
	message?: string
}

// ── Approval hook types ───────────────────────────────────────────────────────

/**
 * Context passed to each approval hook.
 * Approval hooks gate tool execution — they can allow, deny, or request human approval.
 * Input mutation is NOT supported in approval hooks (use preToolUse hooks for that).
 */
export interface ApprovalHookContext {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	/** Metadata about the tool — enables input narrowing in typed hooks. */
	tool: ToolInfo
	/** Returns a frozen snapshot of the current context window. */
	getContextWindow: () => ReadonlyArray<ModelMessage>
	// Result builders — gating only (no input mutation)
	next(): NextResult
	deny(reason?: string): DenyResult
	ask(approval: ApprovalRequestData): AskResult
}

/** All possible outcomes of an approval hook. */
export type ApprovalHookResult = NextResult | DenyResult | AskResult

/**
 * An approval hook function.
 * Runs before preToolUse hooks. Handles gating (next, deny, ask) only.
 * Does NOT support input mutation — use preToolUse hooks for that.
 */
export type ApprovalHook = (ctx: ApprovalHookContext) => ApprovalHookResult | Promise<ApprovalHookResult>

// ── Approval hook chain runner ────────────────────────────────────────────────

interface ApprovalHookChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
}

/**
 * Run a sequence of approval hooks in order.
 *
 * - The first non-`next` result short-circuits the chain.
 * - Returns `{ type: 'next' }` if all hooks pass.
 * - Input mutation is not supported — next() takes no arguments.
 */
export async function runApprovalHooks(
	hooks: ApprovalHook[],
	baseCtx: ApprovalHookChainInput,
): Promise<ApprovalHookResult> {
	for (const hook of hooks) {
		const ctx: ApprovalHookContext = {
			toolName: baseCtx.toolName,
			toolCallId: baseCtx.toolCallId,
			input: baseCtx.input,
			tool: baseCtx.tool,
			getContextWindow: baseCtx.getContextWindow,
			next(): NextResult {
				return hookNext()
			},
			deny(reason?: string): DenyResult {
				return hookDeny(reason)
			},
			ask(data: ApprovalRequestData): AskResult {
				const approval: ApprovalRequest = {
					id: data.id ?? baseCtx.toolCallId,
					toolName: baseCtx.toolName,
					toolCallId: baseCtx.toolCallId,
					input: baseCtx.input,
					...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
					...(data.message !== undefined ? { message: data.message } : {}),
				}
				return hookAsk(approval)
			},
		}

		const result = await hook(ctx)

		if (result.type === 'next') {
			continue
		}

		// Any non-next result short-circuits the chain
		return result
	}

	// All hooks returned next — proceed
	return hookNext()
}

// ── Pre-tool-use hook types ───────────────────────────────────────────────────

/**
 * Context passed to each preToolUse hook.
 * PreToolUse hooks handle interception: input mutation, early-return, and stop.
 * They do NOT handle gating (deny/ask) — use approval hooks for that.
 */
export interface PreToolUseHookContext {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	/** Metadata about the tool — enables input narrowing in typed hooks. */
	tool: ToolInfo
	/** Returns a frozen snapshot of the current context window. */
	getContextWindow: () => ReadonlyArray<ModelMessage>
	// Result builders — interception only (no ask/deny)
	next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult
	toolResult(output: string): ToolResultResult
	stop(options?: StopOptions): HookStopResult
}

/** All possible outcomes of a preToolUse hook. */
export type PreToolUseResult = NextResult | ToolResultResult | HookStopResult

/**
 * A preToolUse hook function.
 * Receives context for the about-to-execute tool call and returns a typed result.
 * Runs after approval hooks pass. Handles input mutation, caching, and stop.
 */
export type PreToolUseHook = (ctx: PreToolUseHookContext) => PreToolUseResult | Promise<PreToolUseResult>

// ── Pre-tool-use chain runner ─────────────────────────────────────────────────

interface PreToolUseChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
}

/**
 * Run a sequence of preToolUse hooks in order.
 *
 * - Each hook receives the (potentially mutated) input from the previous `next(updatedInput)`.
 * - The first non-`next` result short-circuits the chain.
 * - Returns `{ type: 'next' }` (with the final input) if all hooks pass.
 */
export async function runPreToolUseHooks(
	hooks: PreToolUseHook[],
	baseCtx: PreToolUseChainInput,
): Promise<PreToolUseResult> {
	let currentInput = baseCtx.input
	// Aggregate options across the chain — if ANY hook sets a flag, it stays set
	let aggregatedUpdateContextWindow = false
	let aggregatedNotifyModel = false

	for (const hook of hooks) {
		const ctx: PreToolUseHookContext = {
			toolName: baseCtx.toolName,
			toolCallId: baseCtx.toolCallId,
			input: currentInput,
			tool: baseCtx.tool,
			getContextWindow: baseCtx.getContextWindow,
			next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult {
				return hookNext(updatedInput, opts)
			},
			toolResult(output: string): ToolResultResult {
				return hookToolResult(output)
			},
			stop(options?: StopOptions): HookStopResult {
				return hookStop(options)
			},
		}

		const result = await hook(ctx)

		if (result.type === 'next') {
			// Thread the (possibly updated) input forward
			if (result.updatedInput !== undefined) {
				currentInput = result.updatedInput
			}
			// OR-aggregate options across the chain
			if (result.updateContextWindow) aggregatedUpdateContextWindow = true
			if (result.notifyModel) aggregatedNotifyModel = true
			continue
		}

		// Any non-next result short-circuits the chain
		return result
	}

	// All hooks returned next — proceed with (possibly mutated) input
	const hasUpdatedInput = currentInput !== baseCtx.input
	const opts: NextOptions | undefined =
		aggregatedUpdateContextWindow || aggregatedNotifyModel
			? {
					...(aggregatedUpdateContextWindow ? { updateContextWindow: true } : {}),
					...(aggregatedNotifyModel ? { notifyModel: true } : {}),
				}
			: undefined
	return hookNext(hasUpdatedInput ? currentInput : undefined, opts)
}

// ── Post-tool-use hook types ──────────────────────────────────────────────────

/**
 * Context passed to each postToolUse hook.
 * PostToolUse hooks run after tool execution succeeds. They can inspect the
 * output and either accept it (optionally mutated) or request a retry.
 */
export interface PostToolUseHookContext {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	/** The serialized string output produced by the tool. */
	output: string
	/** The raw (pre-serialization) value returned by the tool's execute function. */
	rawOutput: unknown
	/** Metadata about the tool — enables input narrowing in typed hooks. */
	tool: ToolInfo
	/** Returns a frozen snapshot of the current context window. */
	getContextWindow: () => ReadonlyArray<ModelMessage>
	// Result builders
	done(mutatedResult?: string): DoneResult
}

/**
 * A postToolUse hook function.
 * Runs after a tool executes successfully. Can mutate the output or request a retry.
 * Does NOT run for tools that errored, were denied, or were short-circuited by a preToolUse hook.
 */
export type PostToolUseHook = (ctx: PostToolUseHookContext) => PostToolUseResult | Promise<PostToolUseResult>

// ── Post-tool-use chain runner ────────────────────────────────────────────────

interface PostToolUseChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	output: string
	rawOutput: unknown
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
}

/**
 * Run a sequence of postToolUse hooks in order.
 *
 * - Each hook receives the (potentially mutated) output from the previous `done(mutatedResult)`.
 * - The first `retry` result short-circuits the chain.
 * - Returns `{ type: 'done' }` (with the final output) if all hooks pass.
 */
export async function runPostToolUseHooks(
	hooks: PostToolUseHook[],
	baseCtx: PostToolUseChainInput,
): Promise<PostToolUseResult> {
	let currentOutput = baseCtx.output

	for (const hook of hooks) {
		const ctx: PostToolUseHookContext = {
			toolName: baseCtx.toolName,
			toolCallId: baseCtx.toolCallId,
			input: baseCtx.input,
			output: currentOutput,
			rawOutput: baseCtx.rawOutput,
			tool: baseCtx.tool,
			getContextWindow: baseCtx.getContextWindow,
			done(mutatedResult?: string): DoneResult {
				return hookDone(mutatedResult)
			},
		}

		const result = await hook(ctx)

		if (result.mutatedResult !== undefined) {
			currentOutput = result.mutatedResult
		}
	}

	// All hooks returned done — return final (possibly mutated) output
	const hasUpdatedOutput = currentOutput !== baseCtx.output
	return hookDone(hasUpdatedOutput ? currentOutput : undefined)
}

// ── Type-safe hook contexts ───────────────────────────────────────────────────

/**
 * An approval hook context with typed `input` for a specific tool.
 * Created by `createApprovalHook` — the consumer gets autocomplete on `ctx.input`.
 */
export interface TypedApprovalHookContext<TInput> extends Omit<ApprovalHookContext, 'input'> {
	input: TInput
}

/**
 * A pre-tool-use hook context with typed `input` and `next()` for a specific tool.
 * Created by `createPreToolUseHook` — the consumer gets autocomplete on `ctx.input`
 * and type-checked `ctx.next(updatedInput)`.
 */
export interface TypedPreToolUseHookContext<TInput> extends Omit<PreToolUseHookContext, 'input' | 'next'> {
	input: TInput
	next(updatedInput?: TInput, opts?: NextOptions): NextResult
}

/**
 * A post-tool-use hook context with typed `input` for a specific tool.
 * Created by `createPostToolUseHook` — the consumer gets autocomplete on `ctx.input`.
 */
export interface TypedPostToolUseHookContext<TInput> extends Omit<PostToolUseHookContext, 'input'> {
	input: TInput
}

// ── ToolRef — structural type accepted by hook factories ──────────────────────

/**
 * Minimal shape shared by `Tool` and `ToolInterface`.
 * Hook factories accept this so you can pass either a `defineTool(...)` result
 * or a `defineToolInterface(...)` result (or `interface.define(...)` result).
 */
export interface ToolRef<TInput = any, TOutput = any> {
	name: string
	input: z.ZodType<TInput>
	output?: z.ZodType<TOutput>
}

// ── Type utility: extract input type from a ToolRef ───────────────────────────

type ExtractToolInput<T> = T extends ToolRef<infer I, any> ? I : never

/** Union of input types from an array of ToolRef-compatible objects. */
type ToolInputUnion<T extends ReadonlyArray<ToolRef>> = ExtractToolInput<T[number]>

// ── createPreToolUseHook — type-safe factory ──────────────────────────────────

/**
 * Create a type-safe preToolUse hook scoped to a specific tool.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `next()`.
 * `ctx.input` is typed as the tool's input type, providing autocomplete and compile-time safety.
 *
 * Accepts both `defineTool(...)` and `defineToolInterface(...)` results.
 *
 * @example
 * ```ts
 * // With a ToolInterface:
 * const sandboxBash = createPreToolUseHook(BashInterface, async (ctx) => {
 *   if (ctx.input.command.includes('rm -rf')) return ctx.deny('Dangerous command')
 *   return ctx.next()
 * })
 *
 * // With a Tool (from defineTool):
 * const echoTool = defineTool({ name: 'echo', input: z.object({ text: z.string() }), ... })
 * const logEcho = createPreToolUseHook(echoTool, async (ctx) => {
 *   console.log(`Echo: ${ctx.input.text}`)  // ctx.input.text is typed!
 *   return ctx.next()
 * })
 * ```
 */
export function createPreToolUseHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedPreToolUseHookContext<TInput>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook

/**
 * Create a type-safe preToolUse hook scoped to multiple tools.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `next()`.
 * `ctx.input` is a union of all matching tool input types.
 *
 * @example
 * ```ts
 * const auditDangerous = createPreToolUseHook([BashInterface, deployTool], async (ctx) => {
 *   console.log(`Dangerous tool called: ${ctx.toolName}`, ctx.input)
 *   return ctx.ask({ message: 'Approve?' })
 * })
 * ```
 */
export function createPreToolUseHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedPreToolUseHookContext<ToolInputUnion<TTools>>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook

export function createPreToolUseHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedPreToolUseHookContext<any>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((t: ToolRef) => t.name)

	return (ctx: PreToolUseHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.next()
		}
		return hook(ctx as TypedPreToolUseHookContext<any>)
	}
}

// ── createApprovalHook — type-safe factory ────────────────────────────────────

/**
 * Create a type-safe approval hook scoped to a specific tool.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `next()`.
 * `ctx.input` is typed as the tool's input type, providing autocomplete and compile-time safety.
 *
 * Approval hooks handle gating only: `next()`, `deny()`, `ask()`.
 * For input mutation, use `createPreToolUseHook`.
 *
 * @example
 * ```ts
 * const requireDeployApproval = createApprovalHook(deployTool, async (ctx) => {
 *   return ctx.ask({ message: `Approve deployment to ${ctx.input.env}?` })
 * })
 * ```
 */
export function createApprovalHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedApprovalHookContext<TInput>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook

/**
 * Create a type-safe approval hook scoped to multiple tools.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `next()`.
 * `ctx.input` is a union of all matching tool input types.
 *
 * @example
 * ```ts
 * const requireApproval = createApprovalHook([deployTool, deleteTool], async (ctx) => {
 *   return ctx.ask({ message: `Approve ${ctx.toolName}?` })
 * })
 * ```
 */
export function createApprovalHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedApprovalHookContext<ToolInputUnion<TTools>>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook

export function createApprovalHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedApprovalHookContext<any>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((t: ToolRef) => t.name)

	return (ctx: ApprovalHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.next()
		}
		return hook(ctx as TypedApprovalHookContext<any>)
	}
}

// ── createPostToolUseHook — type-safe factory ─────────────────────────────────

/**
 * Create a type-safe postToolUse hook scoped to a specific tool.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `done()`.
 * `ctx.input` is typed as the tool's input type, providing autocomplete and compile-time safety.
 *
 * @example
 * ```ts
 * const truncateBash = createPostToolUseHook(BashTool, async (ctx) => {
 *   if (ctx.output.length > 50000) return ctx.done(ctx.output.slice(0, 50000) + '\n[truncated]')
 *   return ctx.done()
 * })
 * ```
 */
export function createPostToolUseHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedPostToolUseHookContext<TInput>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook

/**
 * Create a type-safe postToolUse hook scoped to multiple tools.
 *
 * The hook only fires for matching tool calls — non-matching calls pass through via `done()`.
 * `ctx.input` is a union of all matching tool input types.
 *
 * @example
 * ```ts
 * const logOutputs = createPostToolUseHook([bashTool, grepTool], async (ctx) => {
 *   console.log(`${ctx.toolName} produced ${ctx.output.length} chars`)
 *   return ctx.done()
 * })
 * ```
 */
export function createPostToolUseHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedPostToolUseHookContext<ToolInputUnion<TTools>>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook

export function createPostToolUseHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedPostToolUseHookContext<any>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((t: ToolRef) => t.name)

	return (ctx: PostToolUseHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.done()
		}
		return hook(ctx as TypedPostToolUseHookContext<any>)
	}
}

// ── isToolCall — type guard for narrowing in generic hooks ────────────────────

/**
 * Type guard that narrows `ctx.input` and `ctx.tool` for a specific tool within a generic hook.
 *
 * Accepts both `defineTool(...)` and `defineToolInterface(...)` results.
 * Works with both PreToolUseHookContext and PostToolUseHookContext.
 *
 * @example
 * ```ts
 * const auditLog: PreToolUseHook = async (ctx) => {
 *   if (isToolCall(ctx, bashTool)) {
 *     // ctx.input is now typed as { command: string }
 *     console.log(`Running command: ${ctx.input.command}`)
 *   }
 *   return ctx.next()
 * }
 * ```
 */
export function isToolCall<TInput, TOutput>(
	ctx: PreToolUseHookContext | PostToolUseHookContext,
	tool: ToolRef<TInput, TOutput>,
): ctx is typeof ctx & { input: TInput; tool: ToolInfo<TInput, TOutput> } {
	return ctx.toolName === tool.name
}

// ── Pre-request hook types ────────────────────────────────────────────────────

/** Options for ctx.transform() in pre-request hooks. */
export interface PreRequestTransformOptions {
	/** When true, persist the transformed messages back to the actual context window. Default: false. */
	persist?: boolean
}

/** Continue without transforming. */
export interface PreRequestNextResult {
	readonly type: 'preRequestNext'
}

/** Transform the messages for this model call (and optionally persist). */
export interface PreRequestTransformResult {
	readonly type: 'preRequestTransform'
	messages: ModelMessage[]
	persist: boolean
}

/** All possible outcomes of a pre-request hook. */
export type PreRequestResult = PreRequestNextResult | PreRequestTransformResult

/**
 * Context passed to each pre-request hook.
 * Pre-request hooks run before each generateText() call and can transform
 * the messages the model sees without mutating the actual context window.
 */
export interface PreRequestHookContext {
	/** Frozen snapshot of the messages about to be sent to the model. */
	messages: ReadonlyArray<ModelMessage>
	/** Estimated number of tokens in the context window. Updated after each generateText call. 0 before the first call. */
	contextWindowTokens: number
	/** Context window limit (from AgentConfig or models.dev). undefined if unknown. */
	contextWindowLimit: number | undefined
	/** Pass through without changes. */
	next(): PreRequestNextResult
	/** Transform messages for this model call. Use `{ persist: true }` to also update the actual context window. */
	transform(messages: ModelMessage[], opts?: PreRequestTransformOptions): PreRequestTransformResult
}

/**
 * A pre-request hook function.
 * Runs before each generateText() call. Can transform the messages the model
 * sees without mutating the actual context window (unless persist is set).
 */
export type PreRequestHook = (ctx: PreRequestHookContext) => PreRequestResult | Promise<PreRequestResult>

// ── createPreRequestHook — type-safe factory ──────────────────────────────────

/**
 * Create a pre-request hook with a clean function signature.
 *
 * Pre-request hooks run before each generateText() call and can inspect or transform
 * the messages the model sees. Unlike tool-scoped hooks, pre-request hooks always fire.
 *
 * @example
 * ```ts
 * const limitContext = createPreRequestHook(async (ctx) => {
 *   if (ctx.messages.length > 100) {
 *     return ctx.transform(ctx.messages.slice(-50), { persist: true })
 *   }
 *   return ctx.next()
 * })
 * ```
 */
export function createPreRequestHook(
	hook: (ctx: PreRequestHookContext) => PreRequestResult | Promise<PreRequestResult>,
): PreRequestHook {
	return hook
}

// ── Pre-request hook chain runner ─────────────────────────────────────────────

export interface PreRequestHookChainInput {
	messages: ModelMessage[]
	/** Estimated context window tokens. Defaults to 0 if omitted. */
	contextWindowTokens?: number
	/** Context window limit. Defaults to undefined if omitted. */
	contextWindowLimit?: number
}

export interface PreRequestHookChainResult {
	/** The (possibly transformed) messages to send to the model. */
	messages: ModelMessage[]
	/** Whether the transform should be persisted back to the actual context window. */
	persist: boolean
	/** Whether any transform was applied. */
	transformed: boolean
}

/**
 * Run a sequence of pre-request hooks in order.
 *
 * Each hook sees the result of the previous hook's transform (if any).
 * If multiple hooks call transform(), they compose — the last persist flag wins
 * (any hook setting persist=true makes the final result persistent).
 */
export async function runPreRequestHooks(
	hooks: PreRequestHook[],
	input: PreRequestHookChainInput,
): Promise<PreRequestHookChainResult> {
	let currentMessages = input.messages
	let persist = false
	let transformed = false

	for (const hook of hooks) {
		const ctx: PreRequestHookContext = {
			messages: Object.freeze([...currentMessages]),
			contextWindowTokens: input.contextWindowTokens ?? 0,
			contextWindowLimit: input.contextWindowLimit,
			next(): PreRequestNextResult {
				return { type: 'preRequestNext' }
			},
			transform(messages: ModelMessage[], opts?: PreRequestTransformOptions): PreRequestTransformResult {
				return {
					type: 'preRequestTransform',
					messages,
					persist: opts?.persist ?? false,
				}
			},
		}

		const result = await hook(ctx)

		if (result.type === 'preRequestTransform') {
			currentMessages = result.messages
			transformed = true
			if (result.persist) {
				persist = true
			}
		}
	}

	return { messages: currentMessages, persist, transformed }
}
