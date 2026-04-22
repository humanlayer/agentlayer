import type { ApprovalHook, ApprovalHookContext, ApprovalHookResult } from './approval'
import type { PostToolUseHook, PostToolUseHookContext } from './post-tool-use'
import type { PreToolUseHook, PreToolUseHookContext, PreToolUseResult } from './pre-tool-use'
import type { NextOptions, NextResult, PostToolUseResult } from './results'
import type { ToolInfo, ToolInputUnion, ToolRef } from './shared'

export interface TypedApprovalHookContext<TInput> extends Omit<ApprovalHookContext, 'input'> {
	input: TInput
}

export interface TypedPreToolUseHookContext<TInput> extends Omit<PreToolUseHookContext, 'input' | 'next'> {
	input: TInput
	next(updatedInput?: TInput, opts?: NextOptions): NextResult
}

export interface TypedPostToolUseHookContext<TInput> extends Omit<PostToolUseHookContext, 'input'> {
	input: TInput
}

export function createPreToolUseHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedPreToolUseHookContext<TInput>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook

export function createPreToolUseHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedPreToolUseHookContext<ToolInputUnion<TTools>>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook

export function createPreToolUseHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedPreToolUseHookContext<any>) => PreToolUseResult | Promise<PreToolUseResult>,
): PreToolUseHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((tool: ToolRef) => tool.name)

	return (ctx: PreToolUseHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.next()
		}
		return hook(ctx as TypedPreToolUseHookContext<any>)
	}
}

export function createApprovalHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedApprovalHookContext<TInput>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook

export function createApprovalHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedApprovalHookContext<ToolInputUnion<TTools>>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook

export function createApprovalHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedApprovalHookContext<any>) => ApprovalHookResult | Promise<ApprovalHookResult>,
): ApprovalHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((tool: ToolRef) => tool.name)

	return (ctx: ApprovalHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.next()
		}
		return hook(ctx as TypedApprovalHookContext<any>)
	}
}

export function createPostToolUseHook<TInput, TOutput>(
	tool: ToolRef<TInput, TOutput>,
	hook: (ctx: TypedPostToolUseHookContext<TInput>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook

export function createPostToolUseHook<TTools extends ReadonlyArray<ToolRef>>(
	tools: TTools,
	hook: (ctx: TypedPostToolUseHookContext<ToolInputUnion<TTools>>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook

export function createPostToolUseHook(
	toolOrTools: ToolRef | ReadonlyArray<ToolRef>,
	hook: (ctx: TypedPostToolUseHookContext<any>) => PostToolUseResult | Promise<PostToolUseResult>,
): PostToolUseHook {
	const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools]
	const toolNames = tools.map((tool: ToolRef) => tool.name)

	return (ctx: PostToolUseHookContext) => {
		if (!toolNames.includes(ctx.toolName)) {
			return ctx.done()
		}
		return hook(ctx as TypedPostToolUseHookContext<any>)
	}
}

export function isToolCall<TInput, TOutput>(
	ctx: PreToolUseHookContext | PostToolUseHookContext,
	tool: ToolRef<TInput, TOutput>,
): ctx is typeof ctx & { input: TInput; tool: ToolInfo<TInput, TOutput> } {
	return ctx.toolName === tool.name
}
