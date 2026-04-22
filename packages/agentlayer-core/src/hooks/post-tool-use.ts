import type { ModelMessage } from 'ai'
import { type DoneResult, hookDone, type PostToolUseResult } from './results'
import type { HookChainStateResult, HookStateAccess, ToolInfo } from './shared'

export interface PostToolUseHookContext extends HookStateAccess {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	output: string
	rawOutput: unknown
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
	done(mutatedResult?: string): DoneResult
}

export type PostToolUseHook = (ctx: PostToolUseHookContext) => PostToolUseResult | Promise<PostToolUseResult>

interface PostToolUseChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	output: string
	rawOutput: unknown
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
	state?: Record<string, unknown>
}

export async function runPostToolUseHooks(
	hooks: PostToolUseHook[],
	baseCtx: PostToolUseChainInput,
): Promise<HookChainStateResult<PostToolUseResult>> {
	let currentOutput = baseCtx.output
	const localState: Record<string, unknown> = { ...(baseCtx.state ?? {}) }
	const stateUpdates: Record<string, unknown> = {}

	for (const hook of hooks) {
		const ctx: PostToolUseHookContext = {
			toolName: baseCtx.toolName,
			toolCallId: baseCtx.toolCallId,
			input: baseCtx.input,
			output: currentOutput,
			rawOutput: baseCtx.rawOutput,
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
			done(mutatedResult?: string): DoneResult {
				return hookDone(mutatedResult)
			},
		}

		const result = await hook(ctx)
		if (result.mutatedResult !== undefined) {
			currentOutput = result.mutatedResult
		}
	}

	const hasUpdatedOutput = currentOutput !== baseCtx.output
	return {
		result: hookDone(hasUpdatedOutput ? currentOutput : undefined),
		stateUpdates,
	}
}
