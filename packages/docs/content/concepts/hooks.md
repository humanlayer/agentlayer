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

### Basic Example

```ts
import { type ApprovalHook } from '@humanlayer/agentlayer-core'

const approvalHook: ApprovalHook = (ctx) => {
  // Allow most tools
  if (ctx.toolName !== 'bash') {
    return ctx.next()
  }

  // Check for dangerous commands
  const command = ctx.input.command as string
  if (command.includes('rm -rf') || command.includes('git push --force')) {
    return ctx.ask({
      message: `Approve dangerous command: ${command}`,
      metadata: { command, severity: 'high' },
    })
  }

  return ctx.next()
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.next()` | Continue to next hook or execution |
| `ctx.deny(reason)` | Reject the tool call immediately |
| `ctx.ask(options)` | Pause run and request approval |

### Context Properties

```ts
interface ApprovalHookContext {
  toolName: string                                    // e.g., 'bash', 'read'
  toolCallId: string                                  // Unique ID for this call
  input: Record<string, unknown>                      // Parsed tool input
  tool: ToolInfo                                      // Tool metadata and schemas
  getContextWindow: () => ReadonlyArray<ModelMessage> // Access context window
}
```

### Typed Approval Hooks

Use `createApprovalHook()` for type-safe access to tool input:

```ts
import { createApprovalHook, BashTool } from '@humanlayer/agentlayer-core'

const bashApproval = createApprovalHook(BashTool, (ctx) => {
  // ctx.input.command is now typed as string
  if (ctx.input.command.includes('rm -rf')) {
    return ctx.ask({ message: `Approve: ${ctx.input.command}` })
  }
  return ctx.next()
})
```

::: info Source Reference
[`approval.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/approval.ts)
:::

## PreToolUse Hooks

PreToolUse hooks run after approval but before execution. They can mutate inputs, provide synthetic results, or stop the loop.

### Mutating Input

```ts
import { type PreToolUseHook } from '@humanlayer/agentlayer-core'

const normalizePathHook: PreToolUseHook = (ctx) => {
  if (ctx.toolName !== 'read') {
    return ctx.next()
  }

  const filePath = ctx.input.filePath as string
  return ctx.next(
    { ...ctx.input, filePath: filePath.trim() },
    { 
      updateContextWindow: true,  // Patch the assistant message
      notifyModel: true,          // Tell the model about the change
    }
  )
}
```

### Short-Circuit with Cached Result

```ts
const cacheHook: PreToolUseHook = (ctx) => {
  if (ctx.toolName !== 'read') return ctx.next()
  
  const cached = cache.get(ctx.input.filePath as string)
  if (cached) {
    return ctx.toolResult(cached)  // Skip execution
  }
  
  return ctx.next()
}
```

### Stopping the Loop

```ts
const stopOnCondition: PreToolUseHook = (ctx) => {
  if (ctx.toolName === 'deploy' && !isReadyToDeploy()) {
    return ctx.stop({
      include: true,
      reason: 'Not ready to deploy',
      output: 'Deployment blocked: prerequisites not met',
    })
  }
  return ctx.next()
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.next(updatedInput?, opts?)` | Continue with optional input mutation |
| `ctx.toolResult(output, opts?)` | Skip execution, return synthetic result |
| `ctx.stop(options?)` | Stop the loop after this call |

Options for `toolResult()`:

| Option | Type | Description |
|--------|------|-------------|
| `isError` | `boolean` | Treat result as error (won't trigger toolCompleted stop). Default: false |

### Hook State

`PreToolUseHookContext` extends `HookStateAccess` to provide state management:

```ts
interface HookStateAccess {
  getState<T>(key: string): T | undefined
  updateState<T>(key: string, updater: (current: T | undefined) => T): void
}
```

PreToolUse hooks can persist state across calls:

```ts
const countingHook: PreToolUseHook = (ctx) => {
  const count = ctx.getState<number>('bashCount') ?? 0
  ctx.updateState<number>('bashCount', (current) => (current ?? 0) + 1)
  
  if (count > 10) {
    return ctx.stop({ reason: 'Too many bash commands' })
  }
  return ctx.next()
}
```

State is stored in `AgentState.toolState` and survives pause/resume.

::: info Source Reference
[`pre-tool-use.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/pre-tool-use.ts)
:::

## PostToolUse Hooks

PostToolUse hooks transform output after execution.

### Transforming Output

```ts
import { type PostToolUseHook } from '@humanlayer/agentlayer-core'

const truncateOutput: PostToolUseHook = (ctx) => {
  if (ctx.output.length > 10000) {
    return ctx.done(ctx.output.slice(0, 10000) + '\n...[truncated]')
  }
  return ctx.done()
}
```

### Context Properties

`PostToolUseHookContext` extends `HookStateAccess` to provide state management:

```ts
interface HookStateAccess {
  getState<T>(key: string): T | undefined
  updateState<T>(key: string, updater: (current: T | undefined) => T): void
}

interface PostToolUseHookContext extends HookStateAccess {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  output: string                                      // Serialized output (model sees this)
  rawOutput: unknown                                  // Original executor return value
  tool: ToolInfo
  getContextWindow: () => ReadonlyArray<ModelMessage> // Access context window
}
```

### Control Methods

| Method | Effect |
|--------|--------|
| `ctx.done()` | Keep output unchanged |
| `ctx.done(newOutput)` | Replace output |

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

### Context Properties

```ts
interface PreRequestHookContext {
  messages: ReadonlyArray<ModelMessage>   // Current context window (read-only)
  contextWindowTokens: number             // Estimated token count (0 before first call)
  contextWindowLimit: number | undefined  // Model's limit (undefined if unknown)
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

## Typed Hook Builders

Use typed builders for type-safe input access:

```ts
import { 
  createApprovalHook,
  createPreToolUseHook,
  createPostToolUseHook,
  isToolCall,
  BashTool,
  ReadTool,
} from '@humanlayer/agentlayer-core'

// Scoped to one tool
const bashPreHook = createPreToolUseHook(BashTool, (ctx) => {
  // ctx.input.command is typed as string
  return ctx.next({
    ...ctx.input,
    command: ctx.input.command.trim(),
  })
})

// Generic hook with narrowing
const genericHook: PostToolUseHook = (ctx) => {
  if (isToolCall(ctx, ReadTool)) {
    // ctx.input.filePath is now typed
    return ctx.done(`Path: ${ctx.input.filePath}\n${ctx.output}`)
  }
  return ctx.done()
}
```

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
