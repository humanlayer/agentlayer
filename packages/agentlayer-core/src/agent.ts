import type { FinishReason as AiSdkFinishReason, LanguageModel, ModelMessage, TextStreamPart, ToolChoice } from 'ai'
import { streamText, tool as toAiSdkTool } from 'ai'

type ProviderOptions = Parameters<typeof streamText>[0]['providerOptions']
type StreamPart = TextStreamPart<any>

import { type AgentEvent, AgentRun } from './agent-run'
import type { Tool, ToolProgressData } from './define-tool'
import { AgentError, InvalidMessagesError } from './errors'
import { type ExecuteToolCallContext, executeToolCall, type ToolCallResult } from './execute-tool-call'
import {
	type ApprovalHook,
	type ApprovalRequest,
	type PendingToolCall,
	type PostToolUseHook,
	type PreRequestHook,
	type PreToolUseHook,
	runApprovalHooks,
	runPostToolUseHooks,
	runPreRequestHooks,
	runPreToolUseHooks,
	type StopOptions,
	type ToolInfo,
} from './hooks'
import { buildToolResultMessage } from './messages'
import { type ModelKey, ModelProvider } from './models'
import type { AgentState, ApprovalDecision, ApprovalHistoryEntry } from './state'
import type { Step, StepToolResult, StopResult, StopTiming, StopWhen } from './stop-conditions'
import { shouldStop } from './stop-conditions'
import { extractUsage, getModelKey, type TokenUsage, TokenUsageAccumulator } from './token-usage'

export interface AgentConfig<TTools extends Record<string, Tool<any, any>> = Record<string, Tool<any, any>>> {
	model: LanguageModel
	system?: string | string[]
	tools: TTools
	toolChoice?: ToolChoice<TTools>
	providerOptions?: ProviderOptions
	maxSteps?: number
	stopWhen?: StopWhen

	modelProvider?: ModelProvider
	onToolProgress?: (toolCallId: string, toolName: string, data: ToolProgressData) => void
	/** Called when the agent run finishes with an error. Observe-only — cannot prevent the error. */
	onError?: (error: AgentError, result: RunResult) => void | Promise<void>
	/** Called when the agent run finishes for any reason. Always fires, including on errors. */
	onStop?: (result: RunResult) => void | Promise<void>
	/** Explicit context window limit override. When not set, resolved from models.dev if available. */
	contextWindowLimit?: number
	/** Called when an approval is requested. Fires before the event is pushed to the iterator. Observe-only, errors swallowed. */
	onApprovalRequested?: (
		approval: ApprovalRequest,
		toolCallId: string,
		toolName: string,
		input: Record<string, unknown>,
	) => void | Promise<void>
	hooks?: {
		approval?: ApprovalHook[]
		preToolUse?: PreToolUseHook[]
		postToolUse?: PostToolUseHook[]
		preRequest?: PreRequestHook[]
	}
}

export type FinishReason = 'complete' | 'maxSteps' | 'stopCondition' | 'interrupted' | 'approvalRequired' | 'error'

export interface RunResult {
	/** The full agent state after this run (messages + any pending tool calls + approval history). */
	state: AgentState
	newMessages: ModelMessage[]
	finishReason: FinishReason
	/** Present when finishReason is 'stopCondition'. Identifies which condition fired. */
	stopCondition?: StopResult
	/** Present when finishReason is 'error'. */
	error?: AgentError
	/** Per-model token usage aggregate for this run (ephemeral — not persisted in state). */
	tokenUsage: TokenUsage
}

export interface RunOptions {
	state: AgentState
	signal?: AbortSignal
	stream?: boolean
}

function convertTools(tools: Record<string, Tool<any, any>>) {
	return Object.fromEntries(
		Object.entries(tools).map(([name, t]) => [
			name,
			toAiSdkTool({ description: t.description, inputSchema: t.input }),
		]),
	)
}

// Outcome type for each tool call after hooks + execution
type ToolOutcome =
	| {
			kind: 'executed'
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
			/** When a preToolUse hook mutated the input, this holds the new value. */
			mutatedInput?: Record<string, unknown>
			/** When true, patch the tool-call input in the assistant message. */
			updateContextWindow?: boolean
			/** When true, inject a system notification about the mutation into the tool result. */
			notifyModel?: boolean
			message: ModelMessage
			output: string
			isError: boolean
			pendingUpdates: Array<(messages: ModelMessage[]) => ModelMessage[]>
			stopRequested?: StopOptions
			toolStateUpdate?: { key: string; value: unknown }
			hookStateUpdate?: Record<string, unknown>
			subAgentPause?: { agentId: string; childState: AgentState }
	  }
	| {
			kind: 'denied'
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
			message: ModelMessage
			output: string
	  }
	| {
			kind: 'toolResult'
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
			message: ModelMessage
			output: string
			isError: boolean
			hookStateUpdate?: Record<string, unknown>
	  }
	| {
			kind: 'ask'
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
			approval: ApprovalRequest
	  }
	| {
			kind: 'hookStop'
			toolCallId: string
			toolName: string
			input: Record<string, unknown>
			stopOptions: StopOptions
			hookStateUpdate?: Record<string, unknown>
	  }

// ── MessageSink: eliminates triple-push pattern ──────────────────────────────

class MessageSink {
	constructor(
		private allMessages: ModelMessage[],
		private newMessages: ModelMessage[],
		private agentRun: AgentRun,
	) {}

	append(msg: ModelMessage): void {
		this.allMessages.push(msg)
		this.newMessages.push(msg)
		this.agentRun.push(msg)
	}

	drain(pendingUpdates: Array<(messages: ModelMessage[]) => ModelMessage[]>): void {
		for (const cb of pendingUpdates) {
			const before = this.allMessages.length
			const updated = cb([...this.allMessages])
			this.allMessages.length = 0
			this.allMessages.push(...updated)
			for (let i = before; i < updated.length; i++) {
				this.newMessages.push(updated[i]!)
				this.agentRun.push(updated[i]!)
			}
		}
	}
}

// ── classifyOutcomes: separate outcome routing from processing ───────────────

interface ClassifiedOutcomes {
	asks: Array<ToolOutcome & { kind: 'ask' }>
	subAgentPauses: Array<
		ToolOutcome & { kind: 'executed'; subAgentPause: { agentId: string; childState: AgentState } }
	>
	hookStop?: ToolOutcome & { kind: 'hookStop' }
	execStop?: ToolOutcome & { kind: 'executed' }
}

type StreamTextResult = ReturnType<typeof streamText>

interface ExecutedModelStep {
	response: Awaited<StreamTextResult['response']>
	toolCalls: Awaited<StreamTextResult['toolCalls']>
	usage: Awaited<StreamTextResult['usage']>
}

function classifyOutcomes(outcomes: ToolOutcome[]): ClassifiedOutcomes {
	return {
		asks: outcomes.filter((o): o is ToolOutcome & { kind: 'ask' } => o.kind === 'ask'),
		subAgentPauses: outcomes.filter(
			(o): o is ToolOutcome & { kind: 'executed'; subAgentPause: { agentId: string; childState: AgentState } } =>
				o.kind === 'executed' && o.subAgentPause !== undefined,
		),
		hookStop: outcomes.find((o): o is ToolOutcome & { kind: 'hookStop' } => o.kind === 'hookStop'),
		execStop: outcomes.find(
			(o): o is ToolOutcome & { kind: 'executed' } =>
				o.kind === 'executed' && o.stopRequested !== undefined && o.subAgentPause === undefined,
		),
	}
}

export class Agent<TTools extends Record<string, Tool<any, any>> = Record<string, Tool<any, any>>> {
	private model: LanguageModel
	private system: string | undefined
	private tools: Record<string, Tool<any, any>>
	private maxStepsLimit: number | undefined
	private stopWhen: StopWhen | undefined
	private aiSdkTools: ReturnType<typeof convertTools>
	private onToolProgress: AgentConfig['onToolProgress']
	private toolChoice: ToolChoice<Record<string, unknown>> | undefined
	private providerOptions: ProviderOptions | undefined
	private hooks: AgentConfig['hooks']
	private onError: AgentConfig['onError']
	private onStop: AgentConfig['onStop']
	private onApprovalRequested: AgentConfig['onApprovalRequested']
	private contextWindowLimit: number | undefined

	private modelProvider: ModelProvider

	constructor(config: AgentConfig<TTools>) {
		this.model = config.model
		this.system = Array.isArray(config.system) ? config.system.join('\n\n') : config.system
		this.tools = config.tools
		this.toolChoice = config.toolChoice
		this.providerOptions = config.providerOptions
		this.maxStepsLimit = config.maxSteps
		this.stopWhen = config.stopWhen
		this.aiSdkTools = convertTools(config.tools)
		this.onToolProgress = config.onToolProgress
		this.onError = config.onError
		this.onStop = config.onStop
		this.onApprovalRequested = config.onApprovalRequested
		this.contextWindowLimit = config.contextWindowLimit
		this.hooks = config.hooks
		this.modelProvider = config.modelProvider ?? new ModelProvider()
	}

	run(options: RunOptions): AgentRun {
		const agentRun = new AgentRun()
		this.executeLoop(options, agentRun)
		return agentRun
	}

	private async executeLoop(options: RunOptions, agentRun: AgentRun): Promise<void> {
		// Hoist mutable state above try/catch so the error path can capture progress
		const allMessages: ModelMessage[] = [...options.state.messages]
		const newMessages: ModelMessage[] = []
		const completedSteps: Step[] = []
		// Accumulated approval history carried forward from prior runs
		const inputApprovalHistory = options.state.approvalHistory
		// Mutable tool state map — updated after each tool execution
		const toolState: Record<string, unknown> = { ...(options.state.toolState ?? {}) }
		// Mutable sub-agent state map — updated when sub-agents pause/resume
		const subAgents: Record<string, AgentState> = { ...(options.state.subAgents ?? {}) }
		const sink = new MessageSink(allMessages, newMessages, agentRun)

		// Token usage tracking — ephemeral to this run
		// Initialize models.dev cache — await so contextWindowLimit can resolve
		// Auto-resolve contextWindowLimit from models.dev if not explicitly set
		if (this.contextWindowLimit === undefined) {
			const modelKey = getModelKey(this.model)
			const limits = this.modelProvider.getModelLimits(modelKey as ModelKey)
			if (limits) {
				this.contextWindowLimit = limits.context
			}
		}
		const accumulator = new TokenUsageAccumulator((p) => {
			return this.modelProvider.getModelPricing(p)
		})
		let contextWindowTokens: number = options.state.contextWindowTokens ?? 0

		// Process forwarded child tokenUsage events through the parent accumulator
		agentRun.onEvent = (event) => {
			if (event.type === 'tokenUsage' && event.agentId) {
				accumulator.add(event.usage.model, event.usage.usage)
			}
		}

		// Helper to build a state snapshot from current messages + optional pending + carried history
		const buildState = (
			pendingToolCalls?: PendingToolCall[],
			extraHistory?: ApprovalHistoryEntry[],
			subAgentsOverride?: Record<string, AgentState>,
		): AgentState => {
			const mergedHistory = [...(inputApprovalHistory ?? []), ...(extraHistory ?? [])]
			const effectiveSubAgents = subAgentsOverride ?? subAgents
			return {
				messages: allMessages,
				...(pendingToolCalls && pendingToolCalls.length > 0 ? { pendingToolCalls } : {}),
				...(mergedHistory.length > 0 ? { approvalHistory: mergedHistory } : {}),
				...(Object.keys(toolState).length > 0 ? { toolState } : {}),
				...(Object.keys(effectiveSubAgents).length > 0 ? { subAgents: effectiveSubAgents } : {}),
				...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
			}
		}

		try {
			// Abort signal — use caller's or create internal one
			const signal = options.signal ?? new AbortController().signal

			const toolCtx: ExecuteToolCallContext = {
				tools: this.tools,
				messages: allMessages,
				signal,
				onToolProgress: this.onToolProgress,
				toolState,
				subAgents,
				agentRun,
				getContextWindowTokens: () => contextWindowTokens,
				getContextWindowLimit: () => this.contextWindowLimit,
			}

			// ── preamble: handle incoming message state ──────────────────────────
			const preambleStop = await this.executeDanglingToolCalls(
				allMessages,
				newMessages,
				toolCtx,
				agentRun,
				sink,
				options,
				buildState,
				subAgents,
				toolState,
				accumulator,
			)
			if (preambleStop !== null) return

			// ── main loop ───────────────────────────────────────────────────────
			const maxStepsLimit = this.maxStepsLimit
			const hasMaxStepsLimit = maxStepsLimit !== undefined
			for (let stepIndex = 0; !hasMaxStepsLimit || stepIndex < maxStepsLimit; stepIndex++) {
				// Check abort at the top of each iteration
				if (signal.aborted) {
					this.finishRun(agentRun, {
						state: buildState(),
						newMessages,
						finishReason: 'interrupted',
						tokenUsage: accumulator.snapshot(),
					})
					return
				}

				// ── pre-request hooks: transform messages before sending to model ──
				let requestMessages: ModelMessage[] = allMessages
				if (this.hooks?.preRequest?.length) {
					const hookResult = await runPreRequestHooks(this.hooks.preRequest, {
						messages: allMessages,
						contextWindowTokens,
						contextWindowLimit: this.contextWindowLimit,
					})
					if (hookResult.transformed) {
						requestMessages = hookResult.messages
						if (hookResult.persist) {
							allMessages.length = 0
							allMessages.push(...hookResult.messages)
						}
					}
				}

				const result = await this.executeModelStep(requestMessages, signal, options.stream, stepIndex, agentRun)

				// Only push non-tool messages from the AI SDK response.
				// The agent manages tool result creation itself; the AI SDK may
				// auto-generate tool-result messages for invalid tool calls (e.g.
				// schema validation failures), which would duplicate the results
				// the agent produces via executeToolCall.
				for (const msg of result.response.messages) {
					if (msg.role === 'tool') continue
					sink.append(msg)
				}

				// ── Token usage tracking ──────────────────────────────────────────
				const modelKey = getModelKey(this.model)
				const stepUsage = extractUsage(result.usage)
				accumulator.add(modelKey, stepUsage)
				contextWindowTokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)

				agentRun.pushEvent({
					type: 'tokenUsage',
					usage: {
						model: modelKey,
						usage: stepUsage,
						contextWindowTokens,
						contextWindowLimit: this.contextWindowLimit,
					},
				})

				if (result.toolCalls.length === 0) {
					this.finishRun(agentRun, {
						state: buildState(),
						newMessages,
						finishReason: 'complete',
						tokenUsage: accumulator.snapshot(),
					})
					return
				}

				const step: Step = { toolCalls: result.toolCalls, toolResults: [] as StepToolResult[] }
				completedSteps.push(step)

				const earlyStop = this.checkStopConditions(
					completedSteps,
					'beforeExecution',
					buildState,
					newMessages,
					accumulator,
				)
				if (earlyStop) {
					this.finishRun(agentRun, earlyStop)
					return
				}

				// ── Run preToolUse hooks + execute tools ──────────────────────────
				// Pass current snapshot of messages to each tool call
				const currentToolCtx: ExecuteToolCallContext = {
					...toolCtx,
					messages: allMessages,
				}

				const outcomes = await Promise.all(
					result.toolCalls.map(
						(tc): Promise<ToolOutcome> => this.resolveToolCall(tc, currentToolCtx, allMessages),
					),
				)

				// ── Apply hook mutation effects (context window patching + model notification) ──
				this.applyHookMutationEffects(allMessages, outcomes)

				// ── Merge hook + tool state updates from all outcomes ─────────────
				this.mergeHookStateUpdates(outcomes, toolState)
				this.mergeToolStateUpdates(outcomes, toolState)

				// ── Classify outcomes and route to appropriate branch ─────────────
				const {
					asks,
					subAgentPauses,
					hookStop: hookStopOutcome,
					execStop: execStopOutcome,
				} = classifyOutcomes(outcomes)

				if (asks.length > 0 || subAgentPauses.length > 0) {
					// Allowed tools already resolved above (executed, denied, toolResult).
					// Append their results first, then create approval promises.
					const pendingToolCalls: PendingToolCall[] = []
					const approvalPromises: Array<{ toolCallId: string; promise: Promise<ApprovalDecision> }> = []

					for (const outcome of outcomes) {
						if (outcome.kind === 'executed' && outcome.subAgentPause) {
							// Sub-agent paused for approval — create pending entry, store child state, do NOT append tool result
							const { agentId, childState } = outcome.subAgentPause
							subAgents[agentId] = childState
							pendingToolCalls.push({
								type: 'subAgent',
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								input: outcome.input,
								agentId,
								subAgentType: outcome.toolName,
							})
						} else if (outcome.kind === 'executed') {
							step.toolResults.push({
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								output: outcome.output,
								isError: outcome.isError,
							})
							sink.append(outcome.message)
							sink.drain(outcome.pendingUpdates)
						} else if (outcome.kind === 'denied' || outcome.kind === 'toolResult') {
							step.toolResults.push({
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								output: outcome.output,
								isError: outcome.kind === 'toolResult' ? outcome.isError : false,
							})
							sink.append(outcome.message)
						} else if (outcome.kind === 'ask') {
							// Create a promise for this approval — can be resolved in-flight via run.resolveApproval()
							const approvalPromise = new Promise<ApprovalDecision>((resolve) => {
								agentRun.pendingResolvers.set(outcome.toolCallId, resolve)
							})
							approvalPromises.push({ toolCallId: outcome.toolCallId, promise: approvalPromise })

							pendingToolCalls.push({
								type: 'approval',
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								input: outcome.input,
								approval: outcome.approval,
							})

							// Fire onApprovalRequested callback (config — observe-only, errors swallowed)
							if (this.onApprovalRequested) {
								try {
									const maybePromise = this.onApprovalRequested(
										outcome.approval,
										outcome.toolCallId,
										outcome.toolName,
										outcome.input,
									)
									if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
										;(maybePromise as Promise<void>).catch(() => {})
									}
								} catch {
									// swallow — observe-only callback
								}
							}

							// Push approvalRequested event to the stream (after callback)
							agentRun.pushEvent({
								type: 'approvalRequested',
								approval: outcome.approval,
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								input: outcome.input,
							})
						} else if (outcome.kind === 'hookStop') {
							// A stop signal alongside ask — treat as pending stopped
							pendingToolCalls.push({
								type: 'stopped',
								toolCallId: outcome.toolCallId,
								toolName: outcome.toolName,
								input: outcome.input,
								reason: outcome.stopOptions.reason,
							})
						}
					}

					// Check for sub-agent pauses (these always require stopping — no live resolution path)
					const hasSubAgentPauses = pendingToolCalls.some((p) => p.type === 'subAgent')
					if (hasSubAgentPauses && approvalPromises.length === 0) {
						// Only sub-agent pauses, no approval promises — exit immediately
						this.finishRun(agentRun, {
							state: buildState(pendingToolCalls),
							newMessages,
							finishReason: 'approvalRequired',
							tokenUsage: accumulator.snapshot(),
						})
						return
					}

					// Give in-flight resolvers a chance to fire (macrotask yield lets iterator consumers respond)
					if (approvalPromises.length > 0) {
						await new Promise((r) => setTimeout(r, 0))
					}

					// Check if any approvals were resolved in-flight
					const stillPendingApprovals = approvalPromises.filter(({ toolCallId }) =>
						agentRun.pendingResolvers.has(toolCallId),
					)

					if (stillPendingApprovals.length > 0 || hasSubAgentPauses) {
						// Some approvals/sub-agents remain unresolved — exit with approvalRequired
						// Clean up resolvers for unresolved approvals (they become cold-path PendingToolCalls)
						for (const { toolCallId } of stillPendingApprovals) {
							agentRun.pendingResolvers.delete(toolCallId)
						}
						this.finishRun(agentRun, {
							state: buildState(pendingToolCalls),
							newMessages,
							finishReason: 'approvalRequired',
							tokenUsage: accumulator.snapshot(),
						})
						return
					}

					// All approvals resolved in-flight! Process the decisions and continue the loop.
					for (const { toolCallId, promise } of approvalPromises) {
						const decision = await promise
						const askOutcome = asks.find((a) => a.toolCallId === toolCallId)!
						if (decision.approved) {
							// Re-execute the approved tool call (skipApproval=true)
							const reOutcome = await this.resolveToolCall(
								{ toolCallId, toolName: askOutcome.toolName, input: askOutcome.input },
								{ ...toolCtx, messages: allMessages },
								allMessages,
								true,
							)
							if (reOutcome.kind === 'executed') {
								step.toolResults.push({
									toolCallId: reOutcome.toolCallId,
									toolName: reOutcome.toolName,
									output: reOutcome.output,
									isError: reOutcome.isError,
								})
								sink.append(reOutcome.message)
								sink.drain(reOutcome.pendingUpdates)
								this.mergeHookStateUpdates([reOutcome], toolState)
								this.mergeToolStateUpdates([reOutcome], toolState)
							}
						} else {
							// Denied in-flight
							const denialMessage = decision.denialReason
								? `The user denied this tool call with the following message: ${decision.denialReason}`
								: 'The user denied this tool call.'
							const message = buildToolResultMessage(
								toolCallId,
								askOutcome.toolName,
								denialMessage,
								false,
							)
							step.toolResults.push({
								toolCallId,
								toolName: askOutcome.toolName,
								output: denialMessage,
								isError: false,
							})
							sink.append(message)
						}
					}

					// All resolved — continue the main loop normally
				}

				// ── Check for stop outcomes (hookStop or ctx.stop() from execution) ──
				const anyStop = hookStopOutcome ?? execStopOutcome

				if (anyStop) {
					const stopOptions = anyStop.kind === 'hookStop' ? anyStop.stopOptions : anyStop.stopRequested!
					const dropParallel = stopOptions.dropParallel === true
					const pendingToolCalls: PendingToolCall[] = []

					for (const outcome of outcomes) {
						if (outcome.kind === 'executed') {
							const isStoppedTool = outcome.stopRequested !== undefined
							const shouldAppend = isStoppedTool
								? outcome.stopRequested!.include !== false
								: !dropParallel

							if (shouldAppend) {
								step.toolResults.push({
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									output: outcome.output,
									isError: outcome.isError,
								})
								sink.append(outcome.message)
							} else {
								pendingToolCalls.push({
									type: 'stopped',
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									input: outcome.input,
									reason: isStoppedTool ? outcome.stopRequested!.reason : undefined,
								})
							}
						} else if (outcome.kind === 'hookStop') {
							// Hook returned stop — decide based on include + dropParallel
							const shouldAppend = outcome.stopOptions.include !== false && !dropParallel
							if (shouldAppend) {
								const stopOutput =
									outcome.stopOptions.output ?? outcome.stopOptions.reason ?? 'Tool execution stopped'
								const message = buildToolResultMessage(
									outcome.toolCallId,
									outcome.toolName,
									stopOutput,
									false,
								)
								step.toolResults.push({
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									output: stopOutput,
									isError: false,
								})
								sink.append(message)
							} else {
								pendingToolCalls.push({
									type: 'stopped',
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									input: outcome.input,
									reason: outcome.stopOptions.reason,
								})
							}
						} else if (outcome.kind === 'denied' || outcome.kind === 'toolResult') {
							// Denied/toolResult tools: append unless dropParallel
							if (!dropParallel) {
								step.toolResults.push({
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									output: outcome.output,
									isError: false,
								})
								sink.append(outcome.message)
							} else {
								pendingToolCalls.push({
									type: 'stopped',
									toolCallId: outcome.toolCallId,
									toolName: outcome.toolName,
									input: outcome.input,
									reason: undefined,
								})
							}
						}
					}

					// Drain pending context window updates for executed+appended outcomes
					for (const outcome of outcomes) {
						if (outcome.kind === 'executed' && outcome.pendingUpdates.length > 0) {
							const isStoppedTool = outcome.stopRequested !== undefined
							const shouldAppend = isStoppedTool
								? outcome.stopRequested!.include !== false
								: !dropParallel
							if (shouldAppend) {
								sink.drain(outcome.pendingUpdates)
							}
						}
					}

					this.finishRun(agentRun, {
						state: buildState(pendingToolCalls.length > 0 ? pendingToolCalls : undefined),
						newMessages,
						finishReason: 'stopCondition',
						stopCondition: { name: 'ctx.stop', message: stopOptions.reason },
						tokenUsage: accumulator.snapshot(),
					})
					return
				}

				// ── Normal path: no stop or ask ───────────────────────────────────
				for (const outcome of outcomes) {
					if (outcome.kind === 'executed') {
						step.toolResults.push({
							toolCallId: outcome.toolCallId,
							toolName: outcome.toolName,
							output: outcome.output,
							isError: outcome.isError,
						})
						sink.append(outcome.message)
					} else if (outcome.kind === 'denied' || outcome.kind === 'toolResult') {
						step.toolResults.push({
							toolCallId: outcome.toolCallId,
							toolName: outcome.toolName,
							output: outcome.output,
							isError: outcome.kind === 'toolResult' ? outcome.isError : false,
						})
						sink.append(outcome.message)
					}
				}

				// Drain pending context window updates from all executed tool results
				for (const outcome of outcomes) {
					if (outcome.kind === 'executed') {
						sink.drain(outcome.pendingUpdates)
					}
				}

				const lateStop = this.checkStopConditions(
					completedSteps,
					'afterExecution',
					buildState,
					newMessages,
					accumulator,
				)
				if (lateStop) {
					this.finishRun(agentRun, lateStop)
					return
				}
			}

			if (hasMaxStepsLimit) {
				this.finishRun(agentRun, {
					state: buildState(),
					newMessages,
					finishReason: 'maxSteps',
					tokenUsage: accumulator.snapshot(),
				})
			}
		} catch (err) {
			// When the caller's signal is aborted and the model step throws an AbortError,
			// treat it as an intentional interruption rather than an unexpected error.
			if (options.signal?.aborted && err instanceof Error && err.name === 'AbortError') {
				this.finishRun(agentRun, {
					state: buildState(),
					newMessages,
					finishReason: 'interrupted',
					tokenUsage: accumulator.snapshot(),
				})
				return
			}
			const agentError =
				err instanceof AgentError
					? err
					: new AgentError('unexpected_error', err instanceof Error ? err.message : String(err))
			const errorResult: RunResult = {
				state: buildState(),
				newMessages,
				finishReason: 'error',
				error: agentError,
				tokenUsage: accumulator.snapshot(),
			}
			this.finishRun(agentRun, errorResult)
		}
	}

	private async executeModelStep(
		requestMessages: ModelMessage[],
		signal: AbortSignal,
		stream: boolean | undefined,
		stepIndex: number,
		agentRun: AgentRun,
	): Promise<ExecutedModelStep> {
		const result = streamText({
			model: this.model,
			tools: this.aiSdkTools,
			toolChoice: this.toolChoice,
			providerOptions: this.providerOptions,
			messages: requestMessages,
			system: this.system,
			abortSignal: signal,
		})

		if (stream) {
			for await (const part of result.fullStream) {
				const event = this.translateStreamPart(part, stepIndex)
				if (event) {
					agentRun.pushEvent(event)
				}
			}
		} else {
			await result.consumeStream()
		}

		const [response, toolCalls, usage] = await Promise.all([result.response, result.toolCalls, result.usage])

		return {
			response,
			toolCalls,
			usage,
		}
	}

	private translateStreamPart(part: StreamPart, stepIndex: number): AgentEvent | undefined {
			switch (part.type) {
				case 'start-step':
					return { type: 'stepStart', stepIndex }
				case 'text-start':
					return { type: 'textStart', id: part.id, stepIndex }
				case 'text-delta':
					return { type: 'textDelta', id: part.id, text: part.text, stepIndex }
				case 'text-end':
					return { type: 'textEnd', id: part.id, stepIndex }
				case 'tool-input-start':
					return { type: 'toolInputStart', id: part.id, toolName: part.toolName, stepIndex }
				case 'tool-input-delta':
					return { type: 'toolInputDelta', id: part.id, delta: part.delta, stepIndex }
				case 'tool-input-end':
					return { type: 'toolInputEnd', id: part.id, stepIndex }
				case 'reasoning-start':
					return { type: 'reasoningStart', id: part.id, stepIndex }
				case 'reasoning-delta':
					return { type: 'reasoningDelta', id: part.id, text: part.text, stepIndex }
			case 'reasoning-end':
				return { type: 'reasoningEnd', id: part.id, stepIndex }
			case 'finish-step':
				return {
					type: 'stepFinish',
					stepIndex,
					finishReason: this.mapFinishReason(part.finishReason),
				}
			default:
				return undefined
		}
	}

	private mapFinishReason(finishReason: AiSdkFinishReason | undefined): string | undefined {
		return finishReason
	}

	/** Finish the run and invoke onError/onStop callbacks. */
	private finishRun(agentRun: AgentRun, result: RunResult): void {
		agentRun.finish(result)

		// Fire callbacks asynchronously — observe-only, errors are swallowed
		if (result.finishReason === 'error' && result.error && this.onError) {
			try {
				const maybePromise = this.onError(result.error, result)
				if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
					;(maybePromise as Promise<void>).catch(() => {})
				}
			} catch {
				// swallow — observe-only callback
			}
		}

		if (this.onStop) {
			try {
				const maybePromise = this.onStop(result)
				if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
					;(maybePromise as Promise<void>).catch(() => {})
				}
			} catch {
				// swallow — observe-only callback
			}
		}
	}

	/**
	 * Run approval hooks (if configured and not skipped), then preToolUse hooks, then execute the tool call.
	 * Returns a typed outcome describing what happened.
	 *
	 * @param skipApproval - When true, skip the approval hook chain (used when resuming with an approved decision).
	 *   PreToolUse hooks still run regardless of this flag.
	 */
	private async resolveToolCall(
		tc: { toolCallId: string; toolName: string; input: unknown },
		currentToolCtx: ExecuteToolCallContext,
		allMessages: ModelMessage[],
		skipApproval = false,
	): Promise<ToolOutcome> {
		const tcInput = (typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input) as Record<string, unknown>

		const tool = this.tools[tc.toolName]
		const toolInfo = {
			name: tc.toolName,
			inputSchema: (tool?.input ?? {}) as any,
			outputSchema: tool?.output,
		}
		const getContextWindow = () => Object.freeze([...allMessages]) as ReadonlyArray<ModelMessage>

		// ── Step 1: Run approval hooks (unless skipped for resumed approvals) ──
		const approvalHooks = this.hooks?.approval
		if (!skipApproval && approvalHooks && approvalHooks.length > 0) {
			const approvalResult = await runApprovalHooks(approvalHooks, {
				toolName: tc.toolName,
				toolCallId: tc.toolCallId,
				input: tcInput,
				tool: toolInfo,
				getContextWindow,
			})

			if (approvalResult.type === 'deny') {
				const reason = approvalResult.reason ?? 'Tool execution denied'
				const output = `The user denied this tool call with the following message: ${reason}`
				const message = buildToolResultMessage(tc.toolCallId, tc.toolName, output, false)
				return {
					kind: 'denied',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tcInput,
					message,
					output,
				}
			}

			if (approvalResult.type === 'ask') {
				return {
					kind: 'ask',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tcInput,
					approval: approvalResult.approval,
				}
			}

			// approvalResult.type === 'next' — proceed to preToolUse hooks
		}

		// ── Step 2: Run preToolUse hooks ──────────────────────────────────────
		const preToolUseHooks = this.hooks?.preToolUse
		if (preToolUseHooks && preToolUseHooks.length > 0) {
			const hookChainResult = await runPreToolUseHooks(preToolUseHooks, {
				toolName: tc.toolName,
				toolCallId: tc.toolCallId,
				input: tcInput,
				tool: toolInfo,
				getContextWindow,
				state: currentToolCtx.toolState,
			})
			const hookResult = hookChainResult.result

			if (hookResult.type === 'toolResult') {
				const message = buildToolResultMessage(
					tc.toolCallId,
					tc.toolName,
					hookResult.output,
					hookResult.isError,
				)
				return {
					kind: 'toolResult',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tcInput,
					message,
					output: hookResult.output,
					isError: hookResult.isError,
					...(Object.keys(hookChainResult.stateUpdates).length > 0
						? { hookStateUpdate: hookChainResult.stateUpdates }
						: {}),
				}
			}

			if (hookResult.type === 'stop') {
				const stopOptions: StopOptions = {
					include: hookResult.include,
					output: hookResult.output,
					dropParallel: hookResult.dropParallel,
					reason: hookResult.reason,
				}
				return {
					kind: 'hookStop',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tcInput,
					stopOptions,
					...(Object.keys(hookChainResult.stateUpdates).length > 0
						? { hookStateUpdate: hookChainResult.stateUpdates }
						: {}),
				}
			}

			// hookResult.type === 'next' — execute with possibly mutated input
			const hasMutatedInput = hookResult.updatedInput !== undefined
			const mutatedTc = hasMutatedInput ? { ...tc, input: hookResult.updatedInput } : tc
			const execResult = await this.executeWithPostHooks(
				mutatedTc,
				currentToolCtx,
				toolInfo,
				allMessages,
				hookChainResult.stateUpdates,
			)
			return {
				kind: 'executed',
				toolCallId: execResult.toolCallId,
				toolName: execResult.toolName,
				input: tcInput,
				...(hasMutatedInput ? { mutatedInput: hookResult.updatedInput } : {}),
				...(hookResult.updateContextWindow ? { updateContextWindow: true } : {}),
				...(hookResult.notifyModel ? { notifyModel: true } : {}),
				message: execResult.message,
				output: execResult.output,
				isError: execResult.isError,
				pendingUpdates: execResult.pendingUpdates,
				...(execResult.stopRequested !== undefined ? { stopRequested: execResult.stopRequested } : {}),
				...(execResult.toolStateUpdate !== undefined ? { toolStateUpdate: execResult.toolStateUpdate } : {}),
				...(Object.keys(execResult.hookStateUpdates).length > 0
					? { hookStateUpdate: execResult.hookStateUpdates }
					: {}),
				...(execResult.subAgentPause !== undefined ? { subAgentPause: execResult.subAgentPause } : {}),
			}
		}

		// No hooks (or all approved/passed through) — execute normally
		const execResult = await this.executeWithPostHooks(tc, currentToolCtx, toolInfo, allMessages)
		return {
			kind: 'executed',
			toolCallId: execResult.toolCallId,
			toolName: execResult.toolName,
			input: tcInput,
			message: execResult.message,
			output: execResult.output,
			isError: execResult.isError,
			pendingUpdates: execResult.pendingUpdates,
			...(execResult.stopRequested !== undefined ? { stopRequested: execResult.stopRequested } : {}),
			...(execResult.toolStateUpdate !== undefined ? { toolStateUpdate: execResult.toolStateUpdate } : {}),
			...(Object.keys(execResult.hookStateUpdates).length > 0
				? { hookStateUpdate: execResult.hookStateUpdates }
				: {}),
			...(execResult.subAgentPause !== undefined ? { subAgentPause: execResult.subAgentPause } : {}),
		}
	}

	/**
	 * Execute a tool call and run postToolUse hooks on the result.
	 */
	private async executeWithPostHooks(
		tc: { toolCallId: string; toolName: string; input: unknown },
		toolCtx: ExecuteToolCallContext,
		toolInfo: ToolInfo,
		allMessages: ModelMessage[],
		initialHookStateUpdates?: Record<string, unknown>,
	): Promise<ToolCallResult & { hookStateUpdates: Record<string, unknown> }> {
		const postToolUseHooks = this.hooks?.postToolUse

		let execResult = await executeToolCall(tc, toolCtx)
		let hookStateUpdates: Record<string, unknown> = { ...(initialHookStateUpdates ?? {}) }

		if (!postToolUseHooks || postToolUseHooks.length === 0 || execResult.isError) {
			return {
				...execResult,
				hookStateUpdates,
			}
		}

		const tcInput = (typeof tc.input === 'string' ? JSON.parse(tc.input as string) : tc.input) as Record<
			string,
			unknown
		>
		const getContextWindow = () => Object.freeze([...allMessages]) as ReadonlyArray<ModelMessage>

		const hookChainResult = await runPostToolUseHooks(postToolUseHooks, {
			toolName: tc.toolName,
			toolCallId: tc.toolCallId,
			input: tcInput,
			output: execResult.output,
			rawOutput: execResult.rawOutput,
			tool: toolInfo,
			getContextWindow,
			state: {
				...toolCtx.toolState,
				...hookStateUpdates,
			},
		})
		hookStateUpdates = {
			...hookStateUpdates,
			...hookChainResult.stateUpdates,
		}

		if (hookChainResult.result.mutatedResult !== undefined) {
			execResult = {
				...execResult,
				output: hookChainResult.result.mutatedResult,
				message: buildToolResultMessage(
					tc.toolCallId,
					tc.toolName,
					hookChainResult.result.mutatedResult,
					false,
				),
			}
		}

		return {
			...execResult,
			hookStateUpdates,
		}
	}

	/** Merge hook state updates from outcomes into the running toolState map. */
	private mergeHookStateUpdates(outcomes: ToolOutcome[], toolState: Record<string, unknown>): void {
		for (const outcome of outcomes) {
			if ('hookStateUpdate' in outcome && outcome.hookStateUpdate) {
				Object.assign(toolState, outcome.hookStateUpdate)
			}
		}
	}

	/** Merge tool state updates from executed outcomes into the running toolState map. */
	private mergeToolStateUpdates(outcomes: ToolOutcome[], toolState: Record<string, unknown>): void {
		for (const outcome of outcomes) {
			if (outcome.kind === 'executed' && outcome.toolStateUpdate) {
				toolState[outcome.toolStateUpdate.key] = outcome.toolStateUpdate.value
			}
		}
	}

	/**
	 * When preToolUse hooks mutate tool-call inputs via `ctx.next(updatedInput)` and
	 * set `updateContextWindow: true`, patch the corresponding tool-call entries in
	 * the assistant message so the model sees the mutated values.
	 *
	 * When `notifyModel: true`, prepend a system notification to the tool result output
	 * so the model knows the inputs were modified by a hook.
	 */
	private applyHookMutationEffects(allMessages: ModelMessage[], outcomes: ToolOutcome[]): void {
		const mutationsToApply = outcomes.filter(
			(o): o is ToolOutcome & { kind: 'executed'; mutatedInput: Record<string, unknown> } =>
				o.kind === 'executed' && o.mutatedInput !== undefined && o.updateContextWindow === true,
		)

		if (mutationsToApply.length > 0) {
			// Find the last assistant message (contains the tool-calls for this step)
			for (let i = allMessages.length - 1; i >= 0; i--) {
				const msg = allMessages[i]!
				if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

				for (const part of msg.content) {
					if (part.type !== 'tool-call') continue
					const mutation = mutationsToApply.find((m) => m.toolCallId === part.toolCallId)
					if (mutation) {
						;(part as { input: unknown }).input = mutation.mutatedInput
					}
				}
				break
			}
		}

		// Inject system notification into tool result messages for notifyModel outcomes
		for (const outcome of outcomes) {
			if (outcome.kind !== 'executed' || !outcome.notifyModel || !outcome.mutatedInput) continue
			const toolMsg = outcome.message
			if (toolMsg.role !== 'tool' || !Array.isArray(toolMsg.content)) continue

			for (const part of toolMsg.content) {
				if (part.type !== 'tool-result' || part.toolCallId !== outcome.toolCallId) continue
				const notification = `<system_information>Your inputs to this tool call were modified by a PreToolUse Hook. You specified ${JSON.stringify(outcome.input)} but they were modified to be ${JSON.stringify(outcome.mutatedInput)}</system_information>\n`
				const currentOutput = part.output as unknown
				if (typeof currentOutput === 'string') {
					;(part as unknown as { output: string }).output = notification + currentOutput
				} else if (
					currentOutput !== null &&
					typeof currentOutput === 'object' &&
					'type' in (currentOutput as Record<string, unknown>) &&
					(currentOutput as { type: string }).type === 'text'
				) {
					;(currentOutput as { value: string }).value =
						notification + (currentOutput as { value: string }).value
				}
			}
		}
	}

	/**
	 * When the last message is an assistant message with pending tool calls,
	 * execute them and append results. This handles resuming from an
	 * interrupted run where tool calls were never executed.
	 *
	 * Behavior is determined by `state.pendingToolCalls`:
	 * - If a dangling tool call has a matching `type: 'approval'` entry in `state.pendingToolCalls`,
	 *   it is skipped (parked — caller must use `withApprovals()` to resolve it).
	 * - If a dangling tool call has a matching `type: 'stopped'` entry, it is also skipped.
	 * - If no match is found, the tool call auto-executes (handles `maxSteps` resume and
	 *   cases where `withApprovals()` has already removed the entry).
	 *
	 * Returns a RunResult if the preamble itself causes a stop (remaining pending approvals),
	 * or null if the loop should continue normally.
	 *
	 * This does NOT count as a loop step — stop conditions do not fire.
	 */
	private async executeDanglingToolCalls(
		allMessages: ModelMessage[],
		newMessages: ModelMessage[],
		toolCtx: ExecuteToolCallContext,
		agentRun: AgentRun,
		sink: MessageSink,
		options: RunOptions,
		buildState: (
			pendingToolCalls?: PendingToolCall[],
			extraHistory?: ApprovalHistoryEntry[],
			subAgents?: Record<string, AgentState>,
		) => AgentState,
		subAgents: Record<string, AgentState>,
		toolState: Record<string, unknown>,
		accumulator: TokenUsageAccumulator,
	): Promise<RunResult | null> {
		// Find the last assistant message (may not be the very last message if caller added tool results)
		let lastAssistantIndex = -1
		for (let i = allMessages.length - 1; i >= 0; i--) {
			if (allMessages[i]!.role === 'assistant') {
				lastAssistantIndex = i
				break
			}
		}

		if (lastAssistantIndex === -1) return null

		const lastAssistantMessage = allMessages[lastAssistantIndex]!
		const toolCallParts = Array.isArray(lastAssistantMessage.content)
			? lastAssistantMessage.content.filter((p) => p.type === 'tool-call')
			: []

		if (toolCallParts.length === 0) {
			// Last assistant message is text-only — invalid state if it's the very last message
			if (lastAssistantIndex === allMessages.length - 1) {
				throw new InvalidMessagesError(
					'Cannot resume: last message is assistant text with no tool calls. ' +
						'Append a user message or tool result to continue.',
				)
			}
			return null
		}

		// Collect toolCallIds that already have tool-result messages (caller provided synthetic results)
		const resolvedToolCallIds = new Set<string>()
		for (let i = lastAssistantIndex + 1; i < allMessages.length; i++) {
			const msg = allMessages[i]!
			if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
			for (const part of msg.content) {
				if (part.type === 'tool-result') {
					resolvedToolCallIds.add(part.toolCallId)
				}
			}
		}

		// Determine which tool calls still need handling
		const unresolvedToolCalls = toolCallParts.filter(
			(p) => p.type === 'tool-call' && !resolvedToolCallIds.has(p.toolCallId),
		)

		if (unresolvedToolCalls.length === 0) return null

		// Build a lookup map from state.pendingToolCalls (by toolCallId)
		const statePendingByToolCallId = new Map((options.state.pendingToolCalls ?? []).map((p) => [p.toolCallId, p]))

		// If there are no pendingToolCalls in state, auto-execute all dangling tool calls
		if (statePendingByToolCallId.size === 0) {
			for (const tc of unresolvedToolCalls) {
				if (tc.type !== 'tool-call') continue
				const { message, pendingUpdates } = await executeToolCall(tc, toolCtx)
				sink.append(message)
				sink.drain(pendingUpdates)
			}
			return null
		}

		// State has pending entries — process each unresolved tool call:
		// - Matched in state.pendingToolCalls → park it (carry forward)
		// - Not matched → auto-execute (e.g. withApprovals() removed the entry, meaning it's approved)
		const remainingPending: PendingToolCall[] = []

		for (const tc of unresolvedToolCalls) {
			if (tc.type !== 'tool-call') continue

			const stateEntry = statePendingByToolCallId.get(tc.toolCallId)

			if (stateEntry !== undefined) {
				if (stateEntry.type === 'subAgent') {
					// Sub-agent pending entry — re-execute the tool so it can resume the child
					const currentToolCtx: ExecuteToolCallContext = { ...toolCtx, messages: allMessages }
					const outcome = await this.resolveToolCall(
						tc,
						currentToolCtx,
						allMessages,
						/* skipApproval= */ true,
					)

					if (outcome.kind === 'executed' && outcome.subAgentPause) {
						// Child re-paused — update subAgents state and keep pending
						const { agentId, childState } = outcome.subAgentPause
						subAgents[agentId] = childState
						remainingPending.push({
							type: 'subAgent',
							toolCallId: tc.toolCallId,
							toolName: tc.toolName,
							input: stateEntry.input,
							agentId,
							subAgentType: stateEntry.subAgentType,
						})
					} else if (outcome.kind === 'executed') {
						// Child completed — append tool result, remove from subAgents
						delete subAgents[stateEntry.agentId]
						sink.append(outcome.message)
						sink.drain(outcome.pendingUpdates)
						this.mergeHookStateUpdates([outcome], toolState)
						this.mergeToolStateUpdates([outcome], toolState)
					}
					continue
				}

				// approval/stopped entries are explicitly parked — skip them
				remainingPending.push(stateEntry)
				continue
			}

			// No match in state.pendingToolCalls → auto-execute
			// Skip the approval hook chain since this tool call was previously approved
			// (its entry was removed from pendingToolCalls by withApprovals)
			const tcInput = (typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input) as Record<string, unknown>
			const currentToolCtx: ExecuteToolCallContext = { ...toolCtx, messages: allMessages }
			const outcome = await this.resolveToolCall(tc, currentToolCtx, allMessages, /* skipApproval= */ true)

			if (outcome.kind === 'hookStop') {
				this.mergeHookStateUpdates([outcome], toolState)
				// preToolUse hook requested stop
				const stopOpts = outcome.stopOptions
				if (stopOpts.include !== false) {
					const stopOutput = stopOpts.output ?? stopOpts.reason ?? 'Tool execution stopped'
					const message = buildToolResultMessage(tc.toolCallId, tc.toolName, stopOutput, false)
					sink.append(message)
				}
				const pending: PendingToolCall[] = [
					...remainingPending,
					{
						type: 'stopped',
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tcInput,
						reason: stopOpts.reason,
					} satisfies PendingToolCall,
				]
				const result: RunResult = {
					state: buildState(pending.length > 0 ? pending : undefined),
					newMessages,
					finishReason: 'stopCondition',
					stopCondition: { name: 'ctx.stop', message: stopOpts.reason },
					tokenUsage: accumulator.snapshot(),
				}
				this.finishRun(agentRun, result)
				return result
			}

			if (outcome.kind === 'executed' && outcome.stopRequested !== undefined) {
				// Tool itself requested stop
				const stopOpts = outcome.stopRequested
				if (stopOpts.include !== false) {
					sink.append(outcome.message)
				}
				const pending: PendingToolCall[] = [
					...remainingPending,
					{
						type: 'stopped',
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tcInput,
						reason: stopOpts.reason,
					} satisfies PendingToolCall,
				]
				const result: RunResult = {
					state: buildState(pending.length > 0 ? pending : undefined),
					newMessages,
					finishReason: 'stopCondition',
					stopCondition: { name: 'ctx.stop', message: stopOpts.reason },
					tokenUsage: accumulator.snapshot(),
				}
				this.finishRun(agentRun, result)
				return result
			}

			if (outcome.kind === 'toolResult') {
				this.mergeHookStateUpdates([outcome], toolState)
				// preToolUse hook provided a cached/early result
				sink.append(outcome.message)
				continue
			}

			if (outcome.kind === 'executed' && outcome.subAgentPause) {
				// Tool returned a sub-agent pause during auto-execute
				const { agentId, childState } = outcome.subAgentPause
				subAgents[agentId] = childState
				remainingPending.push({
					type: 'subAgent',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					input: tcInput,
					agentId,
					subAgentType: tc.toolName,
				})
				continue
			}

			if (outcome.kind === 'executed') {
				sink.append(outcome.message)
				sink.drain(outcome.pendingUpdates)
				continue
			}

			// outcome.kind === 'denied' should not happen since skipApproval=true, but handle gracefully
			if (outcome.kind === 'denied') {
				sink.append(outcome.message)
			}
		}

		// If any tool calls remain pending, stop with approvalRequired
		if (remainingPending.length > 0) {
			const result: RunResult = {
				state: buildState(remainingPending),
				newMessages,
				finishReason: 'approvalRequired',
				tokenUsage: accumulator.snapshot(),
			}
			this.finishRun(agentRun, result)
			return result
		}

		return null
	}

	/**
	 * Evaluate stop conditions for the given timing phase.
	 * Returns a RunResult if a condition fired, null otherwise.
	 */
	private checkStopConditions(
		completedSteps: Step[],
		timing: StopTiming,
		buildState: () => AgentState,
		newMessages: ModelMessage[],
		accumulator: TokenUsageAccumulator,
	): RunResult | null {
		if (!this.stopWhen) return null
		const stopResult = shouldStop(this.stopWhen, completedSteps, timing)
		if (!stopResult) return null
		return {
			state: buildState(),
			newMessages,
			finishReason: 'stopCondition',
			stopCondition: stopResult,
			tokenUsage: accumulator.snapshot(),
		}
	}
}
