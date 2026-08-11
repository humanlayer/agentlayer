import type { ModelMessage } from 'ai'
import type { CompactionTrigger } from '../compaction'

export interface CompactionHookContext {
	toolState: Readonly<Record<string, unknown>>
	replacedMessages: ReadonlyArray<ModelMessage>
	retainedMessages: ReadonlyArray<ModelMessage>
	trigger: CompactionTrigger
}

export type CompactionHook = (
	context: CompactionHookContext,
) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>

/** Run compaction hooks in order, passing each hook the previous hook's tool-state result. */
export async function runCompactionHooks(
	hooks: ReadonlyArray<CompactionHook>,
	context: CompactionHookContext,
): Promise<Record<string, unknown>> {
	let toolState = { ...context.toolState }
	for (const hook of hooks) {
		const next = await hook({ ...context, toolState })
		if (next !== undefined) toolState = next
	}
	return toolState
}
