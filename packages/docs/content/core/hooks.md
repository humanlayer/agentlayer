---
title: Hooks
description: Understand how hooks are wired into AgentConfig, what each hook context receives, and how approval, pre-tool, post-tool, and pre-request hooks differ.
---

# Hooks

Hooks let you intercept the tool pipeline at multiple stages.

## How Hooks Are Wired Into An Agent

Hooks are configured on the `Agent` itself through `AgentConfig.hooks`.

```ts
const agent = new Agent({
  model,
  tools,
  hooks: {
    approval: [approvalHook],
    preToolUse: [preToolHook],
    postToolUse: [postToolHook],
    preRequest: [preRequestHook],
  },
})
```

Relevant source on `main`:

- [`AgentConfig.hooks` in `agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts)
- [`runApprovalHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/approval.ts)
- [`runPreToolUseHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-tool-use.ts)
- [`runPostToolUseHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/post-tool-use.ts)
- [`runPreRequestHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-request.ts)

At a high level, tool calls flow through:

1. approval hooks
2. pre-tool hooks
3. tool execution
4. post-tool hooks

Pre-request hooks are different: they run before the next model call and can rewrite the context window the model will see.

## Approval Hooks

Approval hooks gate execution.

Context fields:

- `toolName: string`
- `toolCallId: string`
- `input: Record<string, unknown>`
- `tool: ToolInfo`
- `getContextWindow(): ReadonlyArray<ModelMessage>`
- `next(): NextResult`
- `deny(reason?: string): DenyResult`
- `ask(approval: ApprovalRequestData): AskResult`

Use approval hooks when the question is: should this tool call be allowed to run at all?

Source on `main`:

- [`ApprovalHookContext` and `runApprovalHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/approval.ts)

## PreToolUse Hooks

PreToolUse hooks run after approval passes and before the tool executes.

Context fields:

- `toolName: string`
- `toolCallId: string`
- `input: Record<string, unknown>`
- `tool: ToolInfo`
- `getContextWindow(): ReadonlyArray<ModelMessage>`
- `getState<T>(key: string): T | undefined`
- `updateState<T>(key: string, updater: (current: T | undefined) => T): void`
- `next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult`
- `toolResult(output: string, opts?: ToolResultOptions): ToolResultResult`
- `stop(options?: StopOptions): HookStopResult`

Use pre-tool hooks when the question is: should this tool run with modified input, be short-circuited, or deliberately stop the loop?

Source on `main`:

- [`PreToolUseHookContext` and `runPreToolUseHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-tool-use.ts)
- [`StopOptions` in `shared.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/shared.ts)

## PostToolUse Hooks

PostToolUse hooks run after the tool executes.

Context fields:

- `toolName: string`
- `toolCallId: string`
- `input: Record<string, unknown>`
- `output: string`
- `rawOutput: unknown`
- `tool: ToolInfo`
- `getContextWindow(): ReadonlyArray<ModelMessage>`
- `getState<T>(key: string): T | undefined`
- `updateState<T>(key: string, updater: (current: T | undefined) => T): void`
- `done(mutatedResult?: string): DoneResult`

Use post-tool hooks when the question is: should the output be transformed before the model sees it?

Source on `main`:

- [`PostToolUseHookContext` and `runPostToolUseHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/post-tool-use.ts)

## PreRequest Hooks

PreRequest hooks run before the next model call and can transform the context window.

This is the most important hook type for deliberate context mutation.

Context fields:

- `messages: ReadonlyArray<ModelMessage>`
- `contextWindowTokens: number`
- `contextWindowLimit: number | undefined`
- `next(): PreRequestNextResult`
- `transform(messages: ModelMessage[], opts?: { persist?: boolean }): PreRequestTransformResult`

Use pre-request hooks when the question is: what should the model remember on the next turn?

This is where you can:

- compact context
- strip stale content
- deduplicate reads
- enforce context window policies

Source on `main`:

- [`PreRequestHookContext` and `runPreRequestHooks()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-request.ts)
- built-in examples:
  - [`deduplicateReads`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/deduplicate-reads.ts)
  - [`stripThinkingTokens`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/strip-thinking-tokens.ts)
  - [`truncateBashResults`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/truncate-bash-results.ts)

## How The Hook Types Differ

- **Approval hooks** decide whether execution is allowed.
- **PreToolUse hooks** can rewrite input, synthesize output, or stop the loop before execution.
- **PostToolUse hooks** rewrite or normalize output after execution.
- **PreRequest hooks** rewrite the context window before the next model call.

If tools and post-tool hooks control what happened, pre-request hooks control what the model remembers.

## Hook State

Pre-tool and post-tool hooks also get hook-local state access through:

- `getState<T>(key: string): T | undefined`
- `updateState<T>(key: string, updater: (current: T | undefined) => T): void`

That state is threaded through the hook chain and merged after execution.

Source on `main`:

- [`HookStateAccess` in `shared.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/shared.ts)

## Stop Is Loop Control, Not Immediate Abort

The `stop(options?)` helper on pre-tool hooks requests that the agent loop halt **after** the current tool resolution path completes.

It does not mean “interrupt right now.” It means the loop should stop in an orderly way so the caller can persist state and resume later if needed.

Supported `StopOptions` fields are:

- `include?: boolean` -- whether to include this tool result in the context window
- `output?: string` -- optional replacement output string to use if included
- `dropParallel?: boolean` -- whether sibling tool results from the same parallel batch should also be dropped
- `reason?: string` -- human-readable stop reason

Source on `main`:

- [`StopOptions` in `shared.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/shared.ts)
