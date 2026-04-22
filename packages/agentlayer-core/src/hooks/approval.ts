import type { ModelMessage } from 'ai'
import { type AskResult, type DenyResult, hookAsk, hookDeny, hookNext, type NextResult } from './results'
import type { ApprovalRequest, ApprovalRequestData, ToolInfo } from './shared'

export interface ApprovalHookContext {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
	next(): NextResult
	deny(reason?: string): DenyResult
	ask(approval: ApprovalRequestData): AskResult
}

export type ApprovalHookResult = NextResult | DenyResult | AskResult

export type ApprovalHook = (ctx: ApprovalHookContext) => ApprovalHookResult | Promise<ApprovalHookResult>

interface ApprovalHookChainInput {
	toolName: string
	toolCallId: string
	input: Record<string, unknown>
	tool: ToolInfo
	getContextWindow: () => ReadonlyArray<ModelMessage>
}

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

		return result
	}

	return hookNext()
}
