import type { ModelMessage } from 'ai'
import {
	type HookStopResult,
	hookNext,
	hookStop,
	hookToolResult,
	type NextOptions,
	type NextResult,
	type ToolResultOptions,
	type ToolResultResult,
} from './results'
import type { HookChainStateResult, HookStateAccess, StopOptions, ToolInfo } from './shared'

export interface PreToolUseHookContext extends HookStateAccess {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
	next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult
	toolResult(output: string, opts?: ToolResultOptions): ToolResultResult
	stop(options?: StopOptions): HookStopResult
}

export type PreToolUseResult = NextResult | ToolResultResult | HookStopResult

export type PreToolUseHook = (ctx: PreToolUseHookContext) => PreToolUseResult | Promise<PreToolUseResult>

interface PreToolUseChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
	state?: Record<string, unknown>
}

export async function runPreToolUseHooks(
	hooks: PreToolUseHook[],
	baseCtx: PreToolUseChainInput,
): Promise<HookChainStateResult<PreToolUseResult>> {
	let currentInput = baseCtx.input
	let aggregatedUpdateContextWindow = false
	let aggregatedNotifyModel = false
	const localState: Record<string, unknown> = { ...(baseCtx.state ?? {}) }
	const stateUpdates: Record<string, unknown> = {}

	for (const hook of hooks) {
		const ctx: PreToolUseHookContext = {
			toolName: baseCtx.toolName,
			toolCallId: baseCtx.toolCallId,
			input: currentInput,
			tool: baseCtx.tool,
			getContextWindow: baseCtx.getContextWindow,
			getState<T>(key: string): T | undefined {
				return localState[key] as T | undefined
			},
			updateState<T>(key: string, updater: (current: T | undefined) => T): void {
				const nextValue = updater(localState[key] as T | undefined)
				localState[key] = nextValue
				stateUpdates[key] = nextValue
			},
			next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult {
				return hookNext(updatedInput, opts)
			},
			toolResult(output: string, opts?: ToolResultOptions): ToolResultResult {
				return hookToolResult(output, opts)
			},
			stop(options?: StopOptions): HookStopResult {
				return hookStop(options)
			},
		}

		const result = await hook(ctx)
		if (result.type === 'next') {
			if (result.updatedInput !== undefined) {
				currentInput = result.updatedInput
			}
			if (result.updateContextWindow) aggregatedUpdateContextWindow = true
			if (result.notifyModel) aggregatedNotifyModel = true
			continue
		}

		return {
			result,
			stateUpdates,
		}
	}

	const hasUpdatedInput = currentInput !== baseCtx.input
	const opts: NextOptions | undefined =
		aggregatedUpdateContextWindow || aggregatedNotifyModel
			? {
					...(aggregatedUpdateContextWindow ? { updateContextWindow: true } : {}),
					...(aggregatedNotifyModel ? { notifyModel: true } : {}),
				}
			: undefined

	return {
		result: hookNext(hasUpdatedInput ? currentInput : undefined, opts),
		stateUpdates,
	}
}
