---
title: Hooks
description: Understand when each hook runs, what its context APIs do, how typed hook builders work, and how to write reusable hook factories.
---

# Hooks

Hooks are the main extension surface for changing agent behavior without rewriting the loop itself.

Use them when you want to:

- gate tool execution behind policy or approval
- rewrite tool inputs before execution
- synthesize a tool result without executing the tool
- normalize or truncate tool output
- reshape the context window before the next model request

Hooks explain how to make the loop behave differently. For what the caller sees after a hook returns `ask(...)` or `stop(...)`, see [`Run API`](/core/run-api). For how approvals and pause/resume work through nested child agents, see [`Subagents`](/core/subagents).

## Where Hooks Run

AgentLayer has four hook phases.

1. `approval` runs before a tool is allowed to execute
2. `preToolUse` runs after approval passes but before the tool executes
3. `postToolUse` runs after execution and before the model sees the tool result
4. `preRequest` runs before the next model call and can rewrite the message history sent to the model

Those phases answer different questions:

- `approval`: should this tool call be allowed at all?
- `preToolUse`: should it execute with different input, be replaced, or stop the loop?
- `postToolUse`: should the output be rewritten before the model sees it?
- `preRequest`: what should the model remember on the next turn?

Hooks are configured on `AgentConfig.hooks`.

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

## How Hook Chains Behave

Hook arrays are not just organization. Their order is part of the runtime behavior.

Approval hooks and pre-tool hooks short-circuit on the first hook that does something other than `next()`. In other words, once one approval hook calls `ask()` or `deny()`, later approval hooks do not run. The same is true when a pre-tool hook returns `toolResult()` or `stop()`.

Post-tool hooks and pre-request hooks are different. They always continue through the whole chain. Each hook sees the current output or message list produced by the previous hook.

That means:

- put broad policy hooks earlier
- put narrower cleanup hooks later
- treat hook ordering as part of the API of your agent configuration

## Approval Hooks

Approval hooks are for execution policy.

They run before the tool executes and let you either continue, deny the call, or pause the run and request approval from an external system or human.

### What The Context Gives You

Every approval hook gets basic information about the proposed tool call.

```ts
ctx.toolName
ctx.toolCallId
ctx.input
ctx.tool
```

`ctx.toolName` is the name from the agent's `tools` map, such as `bash`, `read`, or `write`. Most approval hooks branch on this first.

`ctx.toolCallId` is the unique id for this exact tool call. If the run pauses for approval, this is the id that later appears in pending approvals and is passed back into `withApprovals(...)`.

`ctx.input` is the parsed tool input. In raw hooks it is intentionally generic, so treat it as untrusted data and narrow it before reading properties.

`ctx.tool` gives you the tool metadata and schemas. That is mainly useful when you are writing generic infrastructure over many tools rather than a one-off hook for a single tool.

Approval hooks can also inspect the current transcript.

```ts
const messages = ctx.getContextWindow()
```

`getContextWindow()` returns a read-only snapshot of the current conversation. Use it when the approval decision depends on surrounding context, not just on the tool input itself.

### The Three Control Methods

Approval hooks have exactly three control paths.

Continue to the next hook or to execution:

```ts
return ctx.next()
```

Deny the tool call immediately:

```ts
return ctx.deny('Production writes are disabled')
```

Pause the run and request approval:

```ts
return ctx.ask({
  message: 'Approve this deployment?',
  metadata: { environment: 'prod' },
})
```

`ask()` takes a small payload that becomes the approval request stored in pending state.

```ts
{
  id?: string
  metadata?: Record<string, unknown>
  message?: string
}
```

Use `message` for the human-facing prompt and `metadata` for anything your own UI or backend needs, such as severity, environment, or a rendered command preview.

If you need the caller-side mechanics after `next()`, `deny()`, or `ask()`, see [`Run API`](/core/run-api). That page documents how `approvalRequired` is surfaced, how live approval resolution works with `AgentRun.resolveApproval(...)`, and how to resume from serialized state with `withApprovals(...)`.

### Example: Guard Dangerous Bash Commands

This is the most common approval pattern: inspect a risky tool, decide whether it needs escalation, and only pause for the risky subset.

```ts
const approvalHook: ApprovalHook = (ctx) => {
  if (ctx.toolName !== 'bash') {
    return ctx.next()
  }

  const command = typeof ctx.input.command === 'string' ? ctx.input.command : ''

  if (command.includes('rm ') || command.includes('git push')) {
    return ctx.ask({
      message: `Approve bash command: ${command}`,
      metadata: { command, severity: 'high' },
    })
  }

  return ctx.next()
}
```

This example is worth copying because it shows the right structure for most raw approval hooks:

- ignore unrelated tools early
- narrow generic input before reading fields
- reserve `ask()` for the truly risky subset

### Resuming After `ask()`

When an approval hook returns `ask()`, the run finishes with `finishReason: 'approvalRequired'`.

The normal cold-resume pattern is:

```ts
const run = agent.run({ state })
const result = await run.result

if (result.finishReason === 'approvalRequired') {
  const pending = getAllPendingApprovals(result.state)

  const resumedState = withApprovals(result.state, [
    { toolCallId: pending[0]!.pending.toolCallId, approved: true },
  ])

  const nextRun = agent.run({ state: resumedState })
  const nextResult = await nextRun.result
}
```

That is the safest general-purpose pattern because it works whether the approval belongs to the root agent or to a nested sub-agent.

If you are keeping the run alive in memory, you can also try live approval resolution:

```ts
const delivered = run.resolveApproval('tool-call-123', 'approve')

if (!delivered) {
  const resumedState = withApprovals(savedState, [
    { toolCallId: 'tool-call-123', approved: true },
  ])
  const nextRun = agent.run({ state: resumedState })
}
```

For the full run-lifecycle details, see [`Run API`](/core/run-api).

## Pre-Tool Hooks

Pre-tool hooks run after approval passes and before the tool executor runs.

This is the most flexible hook phase. It can rewrite inputs, synthesize outputs, stop the loop, and keep state across calls.

### Reading Tool Call Information

Like approval hooks, pre-tool hooks receive the current tool call metadata.

```ts
ctx.toolName
ctx.toolCallId
ctx.input
ctx.tool
```

Those fields mean the same things they do in approval hooks. The important difference is that pre-tool hooks are allowed to change what will actually execute.

### Reading Conversation Context

Pre-tool hooks can inspect the current transcript before deciding what to do.

```ts
const messages = ctx.getContextWindow()
```

This is useful when input rewriting depends on recent history, such as inferring a working directory from the conversation or detecting stale file state.

### Hook State

Pre-tool hooks can keep persistent state.

```ts
const count = ctx.getState<number>('bashMutations')

ctx.updateState<number>('bashMutations', (current) => (current ?? 0) + 1)
```

This state is not just local to the current callback. AgentLayer merges it back into the run's serialized state, so it survives pause/resume and later hook executions.

That makes it appropriate for things like:

- counters
- deduplication caches
- read-before-write tracking
- workflow flags

### Continue With Or Without Mutating Input

The normal path is `next()`.

```ts
return ctx.next()
```

If you want to change what the tool actually receives, pass a replacement input.

```ts
return ctx.next({
  ...ctx.input,
  command: normalizedCommand,
})
```

That replacement input is what the actual tool executor receives.

`next()` also accepts options.

```ts
return ctx.next(updatedInput, {
  updateContextWindow: true,
  notifyModel: true,
})
```

These flags matter because there are two separate questions after a mutation:

First, should the assistant's original tool-call message be patched so future context reflects the updated input? That is what `updateContextWindow: true` does.

Second, should the model be explicitly told that the input was changed by a hook? That is what `notifyModel: true` does. AgentLayer prepends a system note to the tool result so the model can see both the original and rewritten inputs.

Use both when transparency matters. Use only `updateContextWindow` when you want the transcript to be accurate but do not need a separate explanation message.

### Short-Circuit With A Synthetic Tool Result

Sometimes the right behavior is to skip execution entirely and provide a result directly.

```ts
return ctx.toolResult('{"mode":"demo"}')
```

This is useful for:

- virtual resources
- cache hits
- policy-based replacements
- testing or simulation layers

The tool never executes when you return `toolResult()`.

### Stop The Loop Cleanly

Pre-tool hooks can also stop the outer loop after the current resolution boundary.

```ts
return ctx.stop({
  include: true,
  reason: 'Waiting for the next orchestrator phase',
})
```

`stop()` does not force-abort execution in the middle of the callback. It tells the loop to finish this tool-resolution path cleanly, record the stop condition, and return control to the caller.

That makes it a workflow-control primitive, not a kill switch.

The stop options are:

```ts
{
  include?: boolean
  output?: string
  dropParallel?: boolean
  reason?: string
}
```

Use `include` to control whether this tool result is appended before stopping. Use `output` when you want to replace the tool result text. Use `dropParallel` when sibling results from the same parallel batch should also be discarded. Use `reason` to leave a meaningful explanation for the caller.

If you want the caller-side behavior after `stop()`, see [`Run API`](/core/run-api). That page documents `finishReason`, stop conditions, and how to resume a stopped workflow by rerunning the agent with the returned state.

### Example: Normalize Bash Input Before Execution

```ts
const normalizeBashHook: PreToolUseHook = (ctx) => {
  if (ctx.toolName !== 'bash') {
    return ctx.next()
  }

  const command = typeof ctx.input.command === 'string' ? ctx.input.command.trim() : ''
  const workdir = typeof ctx.input.workdir === 'string' ? ctx.input.workdir : undefined

  ctx.updateState<number>('bashMutations', (count) => (count ?? 0) + 1)

  return ctx.next(
    {
      ...ctx.input,
      command,
      ...(workdir ? { workdir } : {}),
    },
    {
      updateContextWindow: true,
      notifyModel: true,
    },
  )
}
```

This example shows the full pre-tool story:

- inspect the incoming tool call
- update hook-owned persistent state
- rewrite the execution input
- keep the transcript accurate
- tell the model that a mutation happened

### Resuming After `stop()`

When a pre-tool hook returns `stop()`, the loop finishes intentionally and the caller receives a normal `RunResult` with updated state.

The usual pattern is to persist that state and later rerun the same agent with it.

```ts
const result1 = await agent.run({ state }).result

if (result1.finishReason === 'stopCondition') {
  await saveState(result1.state)
}

// Later
const savedState = await loadState()
const result2 = await agent.run({ state: savedState }).result
```

This works because `ctx.stop()` is designed as a checkpoint boundary, not as an error or abort path.

For more detail on stop conditions and resumable runs, see [`Run API`](/core/run-api).

### Example: Replace A Tool Call Without Executing It

```ts
const fakeReadHook: PreToolUseHook = (ctx) => {
  if (ctx.toolName !== 'read') {
    return ctx.next()
  }

  const filePath = typeof ctx.input.filePath === 'string' ? ctx.input.filePath : ''

  if (filePath === '/virtual/config.json') {
    return ctx.toolResult('{"mode":"demo"}')
  }

  return ctx.next()
}
```

## Post-Tool Hooks

Post-tool hooks run after the tool executes.

They are for rewriting what the model sees, not for changing what the tool already did.

### `output` vs `rawOutput`

Post-tool hooks receive both the serialized and raw forms of the result.

```ts
ctx.output
ctx.rawOutput
```

`ctx.output` is the current string that the model would see if you made no changes.

`ctx.rawOutput` is the original executor result before serialization. Use it when you need structured data that would otherwise be flattened into a string.

In practice, most post-tool hooks work with `ctx.output`. Reach for `rawOutput` when the tool returns a structured object and your hook needs information that is not preserved in the serialized text.

### Finishing A Post-Tool Hook

Post-tool hooks always end with `done()`.

Leave the output unchanged:

```ts
return ctx.done()
```

Replace the output for later hooks and for the model:

```ts
return ctx.done(`[normalized]\n${ctx.output}`)
```

Because post-tool hooks thread through the whole chain, later post-tool hooks see the output produced by earlier ones.

### Post-Tool Hook State

Like pre-tool hooks, post-tool hooks can keep persistent state through `getState()` and `updateState()`.

That is useful for tracking things like how often truncation occurred or whether a certain cleanup strategy has already been applied.

### Example: Annotate Bash Output

```ts
const annotateBashOutput: PostToolUseHook = (ctx) => {
  if (ctx.toolName !== 'bash') {
    return ctx.done()
  }

  ctx.updateState<number>('bashAnnotations', (count) => (count ?? 0) + 1)

  return ctx.done(`[bash output]\n${ctx.output}`)
}
```

This is the same pattern used by output truncation hooks: inspect the current model-visible text, decide whether to rewrite it, and return the rewritten string.

## Pre-Request Hooks

Pre-request hooks run before the next model call.

This is where you control memory rather than execution.

### The Core Inputs

Pre-request hooks work with the actual message list that would be sent to the model next.

```ts
ctx.messages
ctx.contextWindowTokens
ctx.contextWindowLimit
```

`ctx.messages` is the candidate context window.

`ctx.contextWindowTokens` is the most recent estimated token count for the context window.

`ctx.contextWindowLimit` is the configured or auto-resolved limit for the current model. It can be `undefined`, so hooks should handle that case.

### Continue Without Changes

```ts
return ctx.next()
```

Use this when the hook decides the context is already fine.

### Transform The Next Request

```ts
return ctx.transform(trimmedMessages)
```

This changes the message list sent to the next model request.

The transform API also accepts a persistence flag.

```ts
return ctx.transform(trimmedMessages, { persist: true })
```

`persist: false` means the transformation only affects the next request. The underlying stored conversation stays unchanged.

`persist: true` means the transformed messages are also written back into the actual context window stored in state. Use this when you want compaction to become the new long-term conversation history.

### Example: Compact The Context Window

```ts
const compactContext = createPreRequestHook((ctx) => {
  if (ctx.contextWindowLimit === undefined) {
    return ctx.next()
  }

  if (ctx.contextWindowTokens < ctx.contextWindowLimit * 0.8) {
    return ctx.next()
  }

  return ctx.transform([...ctx.messages.slice(-20)], {
    persist: true,
  })
})
```

This is the canonical pre-request pattern: inspect the current window, decide whether compaction is necessary, and transform the message list only when the window is getting full.

## Typed Hook Builders

Raw hook contexts expose generic inputs such as `Record<string, unknown>` on purpose. That makes the low-level hook system flexible, but it is awkward for application code because every property access needs a cast or a type guard.

Typed hook builders solve that by scoping a hook to one tool or a small set of tools and replacing the generic input type with the real tool input type.

The main builders are:

```ts
createApprovalHook(...)
createPreToolUseHook(...)
createPostToolUseHook(...)
createPreRequestHook(...)
isToolCall(...)
```

### Why They Matter

The benefit is not cosmetic. It changes how safe and maintainable hook code is.

With a typed builder:

- `ctx.input` has the real schema-derived type
- `ctx.next(updatedInput)` is type-safe in pre-tool hooks
- refactors stay honest when tool schemas change
- you can scope hooks to one tool without hand-writing `toolName` guards everywhere

### Example: Typed Approval Hook

```ts
const bashApprovalHook = createApprovalHook(BashTool, (ctx) => {
  if (ctx.input.command.includes('rm ')) {
    return ctx.ask({ message: `Approve bash command: ${ctx.input.command}` })
  }

  return ctx.next()
})
```

Here `ctx.input.command` is strongly typed because the hook is scoped to `BashTool`.

### Example: Typed Pre-Tool Mutation

```ts
const normalizeReadHook = createPreToolUseHook(ReadTool, (ctx) => {
  return ctx.next(
    {
      ...ctx.input,
      filePath: ctx.input.filePath.trim(),
    },
    { updateContextWindow: true },
  )
})
```

This is the best example of why the typed builders matter. Without them, the rewritten input would be easy to get wrong because the raw hook API only knows `Record<string, unknown>`.

### Example: Keep A Generic Hook But Narrow Locally

Sometimes you want one generic hook over many tools. In that case, use `isToolCall(...)`.

```ts
const genericHook: PostToolUseHook = (ctx) => {
  if (isToolCall(ctx, ReadTool)) {
    return ctx.done(`Path: ${ctx.input.filePath}\n${ctx.output}`)
  }

  return ctx.done()
}
```

Inside the `isToolCall(...)` branch, the context narrows to the selected tool's input type.

## Writing Reusable Hook Factories

Once you have more than one agent, avoid scattering large inline anonymous hooks everywhere.

Instead, write small hook factories that capture your policy and return a hook.

### Example: Approval Hook Factory

```ts
function createDangerousBashApprovalHook(opts: { blockedPatterns: string[] }) {
  return createApprovalHook(BashTool, (ctx) => {
    const blocked = opts.blockedPatterns.some((pattern) =>
      ctx.input.command.includes(pattern),
    )

    if (!blocked) {
      return ctx.next()
    }

    return ctx.ask({
      message: `Approve bash command: ${ctx.input.command}`,
      metadata: { blockedPatterns: opts.blockedPatterns },
    })
  })
}
```

This pattern is worth using because it produces hooks that are:

- reusable across many agents
- easy to test in isolation
- easy to compose with other hooks

### Example: Pre-Request Hook Factory

```ts
function createKeepLastMessagesHook(count: number) {
  return createPreRequestHook((ctx) => {
    if (ctx.messages.length <= count) {
      return ctx.next()
    }

    return ctx.transform([...ctx.messages.slice(-count)], {
      persist: true,
    })
  })
}
```

This is the right shape for most hook factories: small inputs, clear behavior, and no dependency on the outer agent constructor.

## Hook State And Persistence

Pre-tool and post-tool hooks share a small state API.

```ts
ctx.getState<T>(key)
ctx.updateState<T>(key, updater)
```

That state is accumulated across the hook chain and merged back into the run state after execution. It ultimately lives inside `AgentState.toolState`.

That is why hook state survives:

- later tool calls in the same run
- resumed runs after approval
- serialization and persistence between processes

If you use hook state heavily, choose stable key names and document ownership clearly so unrelated hooks do not overwrite each other.

## Built-In Hook Factories

AgentLayer already includes several reusable pre-request hook factories that are worth reading even if you do not use them directly.

- [`deduplicateReads(...)`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/deduplicate-reads.ts) removes stale repeated read results
- [`stripThinkingTokens(...)`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/strip-thinking-tokens.ts) strips provider-specific reasoning text
- [`truncateOldBashResults(...)`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/truncate-bash-results.ts) compacts older shell output

These built-ins are good examples of how to structure your own context-management hooks because they follow the intended `createPreRequestHook(...)` pattern.

## Related Docs

- [`Tools`](/core/tools)
- [`State`](/core/state)
- [`Run API`](/core/run-api)
- [`Subagents`](/core/subagents)

## Relevant Source On `main`

- [`approval.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/approval.ts)
- [`pre-tool-use.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-tool-use.ts)
- [`post-tool-use.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/post-tool-use.ts)
- [`pre-request.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-request.ts)
- [`typed.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/typed.ts)
- [`results.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/results.ts)
- [`shared.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/shared.ts)
