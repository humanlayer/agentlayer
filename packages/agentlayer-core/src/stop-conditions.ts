import type { ToolSet, TypedToolCall } from 'ai'
import type { AgentLayerToolOutput } from './messages'

/**
 * The result of a single tool execution within a step.
 */
export interface StepToolResult {
	toolCallId: string
	toolName: string
	output: AgentLayerToolOutput
	isError: boolean
}

/**
 * A Step represents one iteration of the agent loop — one model call plus all
 * tool executions that resulted from it.
 *
 * Before execution, `toolResults` is empty. After execution, it contains one
 * entry per tool call with the output and error status.
 */
export interface Step {
	/** The tool calls the model generated during this step. */
	toolCalls: Array<TypedToolCall<ToolSet>>
	/** The results of executing each tool call. Empty before execution. */
	toolResults: StepToolResult[]
}

/**
 * When a stop condition should be evaluated in the agent loop.
 *
 * - `'beforeExecution'` — after the model generates tool calls, before they run.
 *   Useful for approval gates where you want to inspect intent without side effects.
 * - `'afterExecution'` — after tool calls have been executed and results recorded.
 *   This is the default for most conditions.
 */
export type StopTiming = 'beforeExecution' | 'afterExecution'

/**
 * A stop condition is an object that describes when and why the agent should stop.
 *
 * - `name` — identifies the condition (e.g. "maxSteps", "toolCalled:deploy")
 * - `check` — the predicate; receives the step history and returns true to stop
 * - `timing` — when to evaluate: before or after tool execution. Defaults to 'afterExecution'
 * - `message` — optional human-readable explanation shown when triggered (e.g. "Maximum steps (50) reached")
 * - `onTriggered` — optional callback fired when this condition triggers the stop
 */
export interface StopConditionDef {
	name: string
	check: (steps: Step[]) => boolean
	timing?: StopTiming
	message?: string
	onTriggered?: () => void
}

/** Accepts a single stop condition, or an array where any triggering will stop the loop. */
export type StopWhen = StopConditionDef | StopConditionDef[]

/**
 * Returned by `shouldStop` when a condition fires, so the caller knows which one.
 */
export interface StopResult {
	/** The name of the condition that triggered the stop. */
	name: string
	/** The human-readable message, if the condition provided one. */
	message?: string
}

/**
 * Stop after at most `n` completed steps.
 *
 * Evaluated after execution (default timing).
 */
export function maxSteps(n: number): StopConditionDef {
	return {
		name: 'maxSteps',
		message: `Maximum steps (${n}) reached`,
		check: (steps) => steps.length >= n,
	}
}

/**
 * Stop when a tool with the given name is called by the model, **before** the
 * tool is executed. Useful for approval gates — the tool call is visible in
 * the output messages but no side effects have occurred.
 *
 * @param toolName - The name of the tool to watch for.
 */
export function toolCalled(toolName: string): StopConditionDef {
	return {
		name: `toolCalled:${toolName}`,
		timing: 'beforeExecution',
		message: `Tool "${toolName}" was called`,
		check: (steps) => {
			if (steps.length === 0) return false
			const lastStep = steps[steps.length - 1]!
			return lastStep.toolCalls.some((tc) => tc.toolName === toolName)
		},
	}
}

/**
 * Stop when a tool with the given name has been called **and** executed
 * successfully (non-error result) in the most recent step.
 *
 * @param toolName - The name of the tool to watch for.
 */
export function toolCompleted(toolName: string): StopConditionDef {
	return {
		name: `toolCompleted:${toolName}`,
		message: `Tool "${toolName}" completed successfully`,
		check: (steps) => {
			if (steps.length === 0) return false
			const lastStep = steps[steps.length - 1]!
			return lastStep.toolResults.some((tr) => tr.toolName === toolName && !tr.isError)
		},
	}
}

/**
 * Stop when total (cumulative) tool execution failures reach `threshold`.
 * Failures do not need to be consecutive — they are counted across all steps.
 *
 * @param threshold - Number of total failures that triggers the stop.
 * @param toolName - Optional tool name to filter. When omitted, counts failures across all tools.
 */
export function totalToolFailures(threshold: number, toolName?: string): StopConditionDef {
	return {
		name: toolName ? `totalToolFailures:${toolName}` : 'totalToolFailures',
		message: toolName
			? `Tool "${toolName}" failed ${threshold} time(s) total`
			: `${threshold} total tool failure(s) reached`,
		check: (steps) => {
			let count = 0
			for (const step of steps) {
				for (const tr of step.toolResults) {
					if (tr.isError && (toolName === undefined || tr.toolName === toolName)) {
						count++
						if (count >= threshold) return true
					}
				}
			}
			return false
		},
	}
}

/**
 * Stop when `threshold` tool failures occur in a row (consecutive steps).
 * A successful tool execution resets the streak.
 *
 * @param threshold - Number of consecutive failures that triggers the stop.
 * @param toolName - Optional tool name to filter. When omitted, counts consecutive failures across all tools.
 */
export function consecutiveToolFailures(threshold: number, toolName?: string): StopConditionDef {
	return {
		name: toolName ? `consecutiveToolFailures:${toolName}` : 'consecutiveToolFailures',
		message: `${threshold} consecutive tool failure(s)`,
		check: (steps) => {
			let streak = 0
			for (const step of steps) {
				const relevant =
					toolName === undefined
						? step.toolResults
						: step.toolResults.filter((tr) => tr.toolName === toolName)
				if (relevant.length === 0) continue
				if (relevant.every((tr) => tr.isError)) {
					streak += relevant.length
				} else {
					streak = 0
				}
				if (streak >= threshold) return true
			}
			return false
		},
	}
}

/**
 * Stop when the same tool is called with identical input `threshold` consecutive
 * times. Detects agents stuck in a retry loop.
 *
 * @param threshold - Number of identical consecutive calls before stopping. Defaults to 3.
 */
export function doomLoop(threshold = 3): StopConditionDef {
	return {
		name: 'doomLoop',
		message: `Same tool called with identical input ${threshold} times in a row`,
		check: (steps) => {
			if (steps.length < threshold) return false
			const recent = steps.slice(-threshold)
			if (recent.some((s) => s.toolCalls.length !== 1)) return false
			const first = recent[0]!.toolCalls[0]!
			return recent.every((s) => {
				const tc = s.toolCalls[0]!
				return tc.toolName === first.toolName && JSON.stringify(tc.input) === JSON.stringify(first.input)
			})
		},
	}
}

/**
 * Stop when the `structured_output` tool is called, **before** execution.
 *
 * This is a convenience wrapper around `toolCalled('structured_output')` for use
 * with the StructuredOutput tool. The agent loop stops immediately when the model
 * calls `structured_output`, and the structured data can be extracted from the
 * pending tool call in the run result.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   tools: { structured_output: createStructuredOutputTool(mySchema) },
 *   stopWhen: structuredOutputCalled(),
 * })
 * ```
 */
export function structuredOutputCalled(): StopConditionDef {
	return toolCalled('structured_output')
}

/**
 * Evaluate stop conditions against the current steps, filtered by timing phase.
 * Returns the `StopResult` of the first triggered condition, or `null` if none fired.
 *
 * @param stopWhen - The stop condition(s) to evaluate.
 * @param steps - The completed steps so far.
 * @param timing - Which phase we're in. Conditions without a `timing` property default to `'afterExecution'`.
 */
export function shouldStop(
	stopWhen: StopWhen,
	steps: Step[],
	timing: StopTiming = 'afterExecution',
): StopResult | null {
	const defs = Array.isArray(stopWhen) ? stopWhen : [stopWhen]
	for (const def of defs) {
		if ((def.timing ?? 'afterExecution') === timing && def.check(steps)) {
			def.onTriggered?.()
			return { name: def.name, message: def.message }
		}
	}
	return null
}
