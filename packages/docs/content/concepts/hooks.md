---
title: Hooks
description: Intercept tool calls for approval, transform inputs and outputs, and reshape the context window.
---

# Hooks

Hooks let you change agent behavior without rewriting the loop. Use them to:

- Gate tool execution behind approval
- Rewrite tool inputs before execution
- Synthesize tool results without executing
- Transform tool output
- Reshape the context window before model calls

## Hook Types

AgentLayer has four hook phases:

| Phase | When | Purpose |
|-------|------|---------|
| `approval` | Before tool execution | Gate, deny, or request human approval |
| `preToolUse` | After approval, before execution | Mutate input, short-circuit, or stop |
| `postToolUse` | After execution | Transform output |
| `preRequest` | Before model call | Reshape context window |

Configure hooks on the agent:

```ts
const agent = new Agent({
  model,
  tools,
  hooks: {
    approval: [approvalHook1, approvalHook2],
    preToolUse: [preToolHook],
    postToolUse: [postToolHook],
    preRequest: [preRequestHook],
  },
})
```

## Approval Hooks

Approval hooks decide whether a tool can run.

### Type-Safe Builder (Recommended)

Use `createApprovalHook()` for type-safe access to tool input. The builder accepts:
- A **tool interface** (e.g., `ReadTool` from `@humanlayer/agentlayer-core/interfaces`)
- A **tool instance** (e.g., result of `createReadTool()`)
- An **array of either** for union types

**With a tool interface:**

```ts
import { createApprovalHook } from '@humanlayer/agentlayer-core'
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'

const readApproval = createApprovalHook(ReadTool, (ctx) => {
  // ctx.input.file_path is typed as string (inferred from ReadTool's Zod schema)
  if (ctx.input.file_path.includes('/etc/')) {
    return ctx.ask({ message: `Approve reading system file: ${ctx.input.file_path}` })
  }
  return ctx.next()
})
```

**With a tool instance:**

```ts
import { createApprovalHook } from '@humanlayer/agentlayer-core'
import { createBashTool } from '@humanlayer/agentlayer-filesystem'

const bashTool = createBashTool({ cwd: '/project' })

const bashApproval = createApprovalHook(bashTool, (ctx) => {
  // ctx.input.command is typed as string
  if (ctx.input.command.includes('rm -rf')) {
    return ctx.ask({ message: `Approve: ${ctx.input.command}` })
  }
  return ctx.next()
})
```

**With an array of tools (union types):**

```ts
import { createApprovalHook } from '@humanlayer/agentlayer-core'
import { ReadTool, WriteTool } from '@humanlayer/agentlayer-core/interfaces'

const fileOpsApproval = createApprovalHook(
  [ReadTool, WriteTool] as const,
  (ctx) => {
    // ctx.input is typed as ReadInput | WriteInput
    // Use ctx.toolName to narrow if needed
    return ctx.ask({ message: `Approve ${ctx.toolName}?` })
  }
)
```

The builder automatically passes through non-matching tools (calls `ctx.next()`), so you only write logic for the tools you care about.

### Context API

```ts
interface ApprovalHookContext {
  toolName: string                                    // e.g., 'bash', 'read'
  toolCallId: string                                  // Unique ID for this call
  input: Record<string, unknown>                      // Parsed tool input (typed when using builder)
  tool: ToolInfo                                      // Tool metadata and schemas
  getContextWindow: () => ReadonlyArray<ModelMessage> // Read-only snapshot of conversation
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.next()` | Continue to next hook or execution |
| `ctx.deny(reason)` | Reject the tool call immediately |
| `ctx.ask(options)` | Pause run and request approval |

**`ask()` options:**

```ts
ctx.ask({
  message: 'Human-readable approval request',
  metadata: { /* arbitrary data stored with approval */ },
  id: 'optional-custom-id',
})
```

### Untyped Alternative

For hooks that need to handle all tools dynamically:

```ts
import { type ApprovalHook } from '@humanlayer/agentlayer-core'

const approvalHook: ApprovalHook = (ctx) => {
  if (ctx.toolName !== 'bash') return ctx.next()
  
  const command = ctx.input.command as string  // Manual type assertion
  if (command.includes('rm -rf')) {
    return ctx.ask({ message: `Approve: ${command}` })
  }
  return ctx.next()
}
```

::: info Source Reference
[`approval.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/approval.ts)
:::

## PreToolUse Hooks

PreToolUse hooks run after approval but before execution. They can mutate inputs, provide synthetic results, or stop the loop.

### Type-Safe Builder (Recommended)

The builder accepts a tool interface, tool instance, or array of either.

**With a tool interface:**

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'

const normalizePathHook = createPreToolUseHook(ReadTool, (ctx) => {
  // ctx.input.file_path is typed as string
  return ctx.next(
    { ...ctx.input, file_path: ctx.input.file_path.trim() },
    { updateContextWindow: true, notifyModel: true }
  )
})
```

**With a tool instance:**

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { createReadTool } from '@humanlayer/agentlayer-filesystem'

const readTool = createReadTool({ cwd: '/project' })

const cacheHook = createPreToolUseHook(readTool, (ctx) => {
  const cached = cache.get(ctx.input.file_path)
  if (cached) return ctx.toolResult(cached)
  return ctx.next()
})
```

**With an array of tools:**

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, GlobTool } from '@humanlayer/agentlayer-core/interfaces'

const logFileAccess = createPreToolUseHook(
  [ReadTool, GlobTool] as const,
  (ctx) => {
    // ctx.input is ReadInput | GlobInput
    console.log(`File access: ${ctx.toolName}`)
    return ctx.next()
  }
)
```

The builder automatically passes through non-matching tools.

### Context API

```ts
interface PreToolUseHookContext extends HookStateAccess {
  toolName: string                                    // e.g., 'bash', 'read'
  toolCallId: string                                  // Unique ID for this call
  input: Record<string, unknown>                      // Parsed tool input (typed when using builder)
  tool: ToolInfo                                      // Tool metadata and schemas
  getContextWindow: () => ReadonlyArray<ModelMessage> // Read-only snapshot of conversation
  getState<T>(key: string): T | undefined             // Read hook state
  updateState<T>(key: string, updater: (current: T | undefined) => T): void  // Write hook state
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.next(updatedInput?, opts?)` | Continue with optional input mutation |
| `ctx.toolResult(output, opts?)` | Skip execution, return synthetic result |
| `ctx.stop(options?)` | Stop the loop after this call |

**`next()` options:**

```ts
ctx.next(mutatedInput, {
  updateContextWindow: true,  // Patch the assistant message with new input
  notifyModel: true,          // Tell the model input was modified
})
```

**`toolResult()` options:**

| Option | Type | Description |
|--------|------|-------------|
| `isError` | `boolean` | Treat result as error (won't trigger toolCompleted stop). Default: false |

**`stop()` options:**

```ts
ctx.stop({
  include: true,       // Include tool result in context window (default: true)
  output: 'message',   // Custom output message
  dropParallel: true,  // Drop sibling tool results from same batch
  reason: 'why',       // Reason for stopping (for debugging)
})
```

### Hook State

State persists across all tool calls in a run and survives pause/resume:

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'

const limitBashCalls = createPreToolUseHook(BashTool, (ctx) => {
  const count = ctx.getState<number>('bashCount') ?? 0
  ctx.updateState<number>('bashCount', (c) => (c ?? 0) + 1)
  
  if (count > 10) {
    return ctx.stop({ reason: 'Too many bash commands' })
  }
  return ctx.next()
})
```

State is stored in `AgentState.toolState`.

### Untyped Alternative

```ts
import { type PreToolUseHook } from '@humanlayer/agentlayer-core'

const stopOnCondition: PreToolUseHook = (ctx) => {
  if (ctx.toolName === 'deploy' && !isReadyToDeploy()) {
    return ctx.stop({ reason: 'Not ready to deploy' })
  }
  return ctx.next()
}
```

::: info Source Reference
[`pre-tool-use.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-tool-use.ts)
:::

## PostToolUse Hooks

PostToolUse hooks transform output after execution.

### Type-Safe Builder (Recommended)

The builder accepts a tool interface, tool instance, or array of either.

**With a tool interface:**

```ts
import { createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'

const addPathHeader = createPostToolUseHook(ReadTool, (ctx) => {
  // ctx.input.file_path is typed as string
  return ctx.done(`// File: ${ctx.input.file_path}\n${ctx.output}`)
})
```

**With a tool instance:**

```ts
import { createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { createBashTool } from '@humanlayer/agentlayer-filesystem'

const bashTool = createBashTool({ cwd: '/project' })

const truncateBash = createPostToolUseHook(bashTool, (ctx) => {
  if (ctx.output.length > 10000) {
    return ctx.done(ctx.output.slice(0, 10000) + '\n...[truncated]')
  }
  return ctx.done()
})
```

**With an array of tools:**

```ts
import { createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, GrepTool } from '@humanlayer/agentlayer-core/interfaces'

const logOutputSize = createPostToolUseHook(
  [ReadTool, GrepTool] as const,
  (ctx) => {
    console.log(`${ctx.toolName} output: ${ctx.output.length} chars`)
    return ctx.done()
  }
)
```

The builder automatically passes through non-matching tools (calls `ctx.done()`).

### Context API

```ts
interface PostToolUseHookContext extends HookStateAccess {
  toolName: string                                    // e.g., 'bash', 'read'
  toolCallId: string                                  // Unique ID for this call
  input: Record<string, unknown>                      // Parsed tool input (typed when using builder)
  output: string                                      // Serialized output (what model sees)
  rawOutput: unknown                                  // Original executor return value (before serialize)
  tool: ToolInfo                                      // Tool metadata and schemas
  getContextWindow: () => ReadonlyArray<ModelMessage> // Read-only snapshot of conversation
  getState<T>(key: string): T | undefined             // Read hook state
  updateState<T>(key: string, updater: (current: T | undefined) => T): void  // Write hook state
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.done()` | Keep output unchanged |
| `ctx.done(newOutput)` | Replace output with new string |

### Untyped Alternative

```ts
import { type PostToolUseHook } from '@humanlayer/agentlayer-core'

const truncateAll: PostToolUseHook = (ctx) => {
  if (ctx.output.length > 10000) {
    return ctx.done(ctx.output.slice(0, 10000) + '\n...[truncated]')
  }
  return ctx.done()
}
```

::: info Source Reference
[`post-tool-use.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/post-tool-use.ts)
:::

## PreRequest Hooks

PreRequest hooks run before each model call and can reshape the context window.

### Compacting Context

```ts
import { createPreRequestHook } from '@humanlayer/agentlayer-core'

const compactHook = createPreRequestHook((ctx) => {
  const limit = ctx.contextWindowLimit
  if (!limit || ctx.contextWindowTokens < limit * 0.8) {
    return ctx.next()
  }

  // Keep system message + last 20 messages
  const system = ctx.messages.find(m => m.role === 'system')
  const recent = ctx.messages.slice(-20)
  
  return ctx.transform(
    system ? [system, ...recent] : recent,
    { persist: true }  // Write back to state
  )
})
```

### Context API

```ts
interface PreRequestHookContext {
  messages: ReadonlyArray<ModelMessage>   // Current context window (read-only)
  contextWindowTokens: number             // Estimated token count (0 before first call)
  contextWindowLimit: number | undefined  // Model's limit (undefined if unknown)
  next(): PreRequestNextResult            // Continue without changes
  transform(messages: ModelMessage[], opts?: { persist?: boolean }): PreRequestTransformResult
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.next()` | No changes |
| `ctx.transform(messages, options?)` | Replace context window |

Options for `transform()`:

| Option | Type | Description |
|--------|------|-------------|
| `persist` | `boolean` | Write changes back to state (default: false) |

::: info Source Reference
[`pre-request.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-request.ts)
:::

## Hook Chain Behavior

Hooks run in array order with these semantics:

| Hook Type | Short-Circuit? | Threading |
|-----------|----------------|-----------|
| `approval` | Yes, on first non-`next()` | — |
| `preToolUse` | Yes, on `toolResult()` or `stop()` | Input mutations carried forward |
| `postToolUse` | No | Output mutations carried forward |
| `preRequest` | No | Message transforms carried forward |

This means:
- Put broad policy hooks early in approval/preToolUse
- Put cleanup hooks late
- Hook order is part of your agent's API

## Runtime Type Narrowing

Use `isToolCall()` when you need to handle multiple tools in one untyped hook:

```ts
import { 
  type PostToolUseHook,
  isToolCall,
  ReadTool,
  BashTool,
} from '@humanlayer/agentlayer-core'

const logHook: PostToolUseHook = (ctx) => {
  if (isToolCall(ctx, ReadTool)) {
    // ctx.input.file_path is now typed as string
    console.log(`Read: ${ctx.input.file_path}`)
  } else if (isToolCall(ctx, BashTool)) {
    // ctx.input.command is now typed as string
    console.log(`Bash: ${ctx.input.command}`)
  }
  return ctx.done()
}
```

This is useful when you want a single hook to handle all tools but still want type safety for specific ones.

::: info Source Reference
[`typed.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/typed.ts)
:::

## Hook Factories

Write reusable hook factories:

```ts
function createDangerousCommandApproval(patterns: string[]) {
  return createApprovalHook(BashTool, (ctx) => {
    const isDangerous = patterns.some(p => ctx.input.command.includes(p))
    if (isDangerous) {
      return ctx.ask({
        message: `Approve: ${ctx.input.command}`,
        metadata: { patterns },
      })
    }
    return ctx.next()
  })
}

function createContextLimit(maxMessages: number) {
  return createPreRequestHook((ctx) => {
    if (ctx.messages.length <= maxMessages) {
      return ctx.next()
    }
    return ctx.transform(ctx.messages.slice(-maxMessages), { persist: true })
  })
}

// Use them
const agent = new Agent({
  hooks: {
    approval: [createDangerousCommandApproval(['rm -rf', 'drop table'])],
    preRequest: [createContextLimit(50)],
  },
})
```

## Built-in Hook Factories

AgentLayer includes several pre-built hooks:

| Hook | Purpose |
|------|---------|
| [`deduplicateReads()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/deduplicate-reads.ts) | Remove stale repeated read results |
| [`stripThinkingTokens()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/strip-thinking-tokens.ts) | Strip provider-specific reasoning text |
| [`truncateOldBashResults()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/truncate-bash-results.ts) | Compact old shell output |

## Resuming After `ask()` or `stop()`

When an approval hook returns `ask()`, the run finishes with `finishReason: 'approvalRequired'`. Resume with:

```ts
const result = await run.result
if (result.finishReason === 'approvalRequired') {
  await db.save(result.state)
}

// Later
const state = JSON.parse(await db.load())
const pending = getAllPendingApprovals(state)

const resumed = withApprovals(state, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

const nextRun = agent.run({ state: resumed })
```

When `stop()` is called, the run finishes with `finishReason: 'stopCondition'`. Resume by passing the state back:

```ts
const result = await run.result
if (result.finishReason === 'stopCondition') {
  const nextRun = agent.run({ state: result.state })
}
```

## Next Steps

- **[Run API](/concepts/run-api)** — How to handle results and resume after hooks pause
- **[State](/concepts/state)** — How hook state persists
- **[Tools](/concepts/tools)** — What hooks intercept
