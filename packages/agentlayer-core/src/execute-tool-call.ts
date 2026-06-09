import type { ModelMessage } from 'ai'
import type { AgentRun } from './agent-run'
import type { SubAgentPauseResult, SubAgentResult, SubAgentRunHandle, Tool, ToolContext } from './define-tool'
import type { HookStopResult, StopOptions } from './hooks'
import { type AgentLayerToolOutput, buildToolResultMessage, isToolResultOutput } from './messages'
import { sanitizeTextForModelState, sanitizeToolOutputForModelState } from './sanitize-text'
import type { AgentState } from './state'

export interface ToolCallRef {
	toolCallId: string
	toolName: string
	input: unknown
}

export interface ExecuteToolCallContext {
	tools: Record<string, Tool<any, any>>
	messages: ReadonlyArray<ModelMessage>
	signal: AbortSignal
	/** Current tool state map, keyed by each stateful tool's stateKey. */
	toolState?: Record<string, unknown>
	/** Parent's sub-agent states — used by getSubAgentState on ToolContext. */
	subAgents?: Record<string, AgentState>
	/** The parent AgentRun — used for wiring awaitSubAgent (event forwarding + activeChildren). */
	agentRun?: AgentRun
	/** Returns the current estimated context window tokens. */
	getContextWindowTokens?: () => number
	/** Returns the context window token limit for the current model. */
	getContextWindowLimit?: () => number | undefined
}

export interface ToolCallResult {
	toolCallId: string
	toolName: string
	message: ModelMessage
	output: AgentLayerToolOutput
	/** The raw, unserialised TOutput value returned by the tool. */
	rawOutput: unknown
	isError: boolean
	pendingUpdates: Array<(messages: ModelMessage[]) => ModelMessage[]>
	/** Set when the tool called ctx.stop() — controls loop stop behaviour. */
	stopRequested?: StopOptions
	/** Set when a stateful tool called ctx.updateToolState() during execution. */
	toolStateUpdate?: { key: string; value: unknown }
	/** Set when the tool returned a SubAgentPauseResult — the child agent needs approval. */
	subAgentPause?: { agentId: string; childState: AgentState }
}

/**
 * Serialize a raw tool output value to a string for the model.
 * Uses the tool's `serialize` function if provided; otherwise:
 *   - if the raw value is already a valid ToolResultPart['output'], pass it through
 *   - strings are passed through as-is
 *   - everything else is JSON.stringify'd
 *
 * IMPORTANT: tool.serialize takes priority over isToolResultOutput to avoid
 * type confusion between tool-specific output types (e.g., ReadMultimodalOutput
 * with { type: 'text', content: string }) and ToolResultPart['output'] which
 * expects { type: 'text', value: string }.
 */
function serializeOutput<TOutput>(tool: Tool<any, TOutput>, raw: TOutput, input: unknown): AgentLayerToolOutput {
	// Check tool.serialize FIRST - tools with custom serializers should always use them
	if (tool.serialize) {
		return tool.serialize(raw, input as any)
	}
	// Only pass through raw values that are already valid ToolResultPart outputs
	// when no serialize function is provided
	if (isToolResultOutput(raw)) {
		return raw
	}
	return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

/**
 * Execute a single tool call and return the result message.
 *
 * Tools are resolved from the provided context, making it easy to
 * swap or filter the available tool set per-call.
 */
export async function executeToolCall(tc: ToolCallRef, ctx: ExecuteToolCallContext): Promise<ToolCallResult> {
	const tool = ctx.tools[tc.toolName]
	if (!tool) throw new Error(`Unknown tool: ${tc.toolName}`)

	const pendingUpdates: Array<(messages: ModelMessage[]) => ModelMessage[]> = []
	let stopRequestedOptions: StopOptions | undefined

	const toolCtx: ToolContext = {
		getContextWindow: () => Object.freeze([...ctx.messages]) as ReadonlyArray<ModelMessage>,
		updateContextWindow: (cb) => pendingUpdates.push(cb),
		signal: ctx.signal,
		stream: ctx.agentRun?.stream,
		stop: (options?: StopOptions): HookStopResult => {
			stopRequestedOptions = options ?? {}
			return { type: 'stop', ...options }
		},
		getContextWindowTokens: ctx.getContextWindowTokens ?? (() => 0),
		getContextWindowLimit: ctx.getContextWindowLimit ?? (() => undefined),
		// Sub-agent integration
		toolCallId: tc.toolCallId,
		pauseForSubAgent: (agentId: string, childState: AgentState): SubAgentPauseResult => {
			return { type: 'subAgentPause', agentId, childState }
		},
		getSubAgentState: (agentId: string): AgentState | undefined => {
			return ctx.subAgents?.[agentId]
		},
	}

	// Wire awaitSubAgent if we have a parent AgentRun
	if (ctx.agentRun) {
		const parentRun = ctx.agentRun
		toolCtx.awaitSubAgent = async (
			childRun: SubAgentRunHandle,
			agentId: string,
			parentToolCallId: string,
		): Promise<SubAgentResult> => {
			// Register child in parent's activeChildren
			parentRun.activeChildren.add(childRun as AgentRun)

			// Forward child events to parent stream with agentId + parentToolCallId
			const forwardingPromise = (async () => {
				for await (const childEvent of childRun) {
					parentRun.pushEvent({
						...childEvent,
						agentId: childEvent.agentId ?? agentId,
						parentToolCallId: childEvent.parentToolCallId ?? parentToolCallId,
					})
				}
			})()

			// Wait for the child result
			const result = await childRun.result

			// Wait for forwarding to finish
			await forwardingPromise

			// Unregister child
			parentRun.activeChildren.delete(childRun as AgentRun)

			return result
		}
	}

	// Wire state accessors for stateful tools (those with a stateKey)
	let toolStateUpdate: { key: string; value: unknown } | undefined
	if (tool.stateKey) {
		let toolStateValue = ctx.toolState?.[tool.stateKey]
		;(toolCtx as any).getToolState = () => toolStateValue
		;(toolCtx as any).updateToolState = (updater: (current: unknown) => unknown) => {
			toolStateValue = updater(toolStateValue)
			toolStateUpdate = { key: tool.stateKey!, value: toolStateValue }
		}
	}

	let output: AgentLayerToolOutput
	let rawOutput: unknown
	let isError = false
	let subAgentPause: { agentId: string; childState: AgentState } | undefined

	try {
		const raw = await tool.execute(tc.input as Record<string, unknown>, toolCtx)

		// Check if the tool returned a SubAgentPauseResult
		if (raw !== null && typeof raw === 'object' && (raw as SubAgentPauseResult).type === 'subAgentPause') {
			const pauseResult = raw as SubAgentPauseResult
			subAgentPause = { agentId: pauseResult.agentId, childState: pauseResult.childState }
			output = `Sub-agent ${pauseResult.agentId} paused for approval`
			rawOutput = pauseResult
		}
		// Check if the tool returned a StopResult via ctx.stop()
		else if (raw !== null && typeof raw === 'object' && (raw as HookStopResult).type === 'stop') {
			const stopResult = raw as HookStopResult
			const stopResultOutput =
				stopResult.output === undefined ? undefined : sanitizeToolOutputForModelState(stopResult.output)
			const stopOutput = stopResultOutput ?? sanitizeTextForModelState(stopResult.reason ?? 'Tool requested stop')
			output = stopOutput
			rawOutput = stopResult
			stopRequestedOptions = {
				include: stopResult.include,
				output: stopResultOutput,
				dropParallel: stopResult.dropParallel,
				reason: stopResult.reason ? sanitizeTextForModelState(stopResult.reason) : undefined,
			}
		} else {
			rawOutput = raw
			output = sanitizeToolOutputForModelState(serializeOutput(tool, raw as any, tc.input))
		}
	} catch (err) {
		output = sanitizeTextForModelState(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`)
		rawOutput = err
		isError = true
	}

	return {
		toolCallId: tc.toolCallId,
		toolName: tc.toolName,
		rawOutput,
		output,
		isError,
		message: buildToolResultMessage(tc.toolCallId, tc.toolName, output, isError),
		pendingUpdates,
		...(stopRequestedOptions !== undefined ? { stopRequested: stopRequestedOptions } : {}),
		...(toolStateUpdate !== undefined ? { toolStateUpdate } : {}),
		...(subAgentPause !== undefined ? { subAgentPause } : {}),
	}
}
