# Hooks

Hooks let you intercept and modify agent behavior at four key points in the execution lifecycle.

## Hook Phases

| Phase | When it Runs | Can Do |
|-------|-------------|--------|
| `approval` | Before tool execution, when approval needed | Approve, deny, or ask for input |
| `preToolUse` | Before every tool execution | Skip, modify input, or stop |
| `postToolUse` | After tool execution | Modify result, stop agent |
| `preRequest` | Before each LLM request | Transform messages, add context |

## Creating Hooks

### createPreToolUseHook()

```ts
import { createPreToolUseHook, hookNext, hookDeny } from '@humanlayer/agentlayer-core/hooks'

const logToolCalls = createPreToolUseHook(async (ctx) => {
  console.log(`Tool: ${ctx.tool.name}, Input:`, ctx.input)
  return hookNext()  // Continue execution
})

const blockDangerousCommands = createPreToolUseHook(async (ctx) => {
  if (ctx.tool.name === 'Bash' && ctx.input.command.includes('rm -rf')) {
    return hookDeny('Dangerous command blocked')
  }
  return hookNext()
})
```

### createPostToolUseHook()

```ts
import { createPostToolUseHook, hookNext, hookToolResult } from '@humanlayer/agentlayer-core/hooks'

const truncateLongResults = createPostToolUseHook(async (ctx) => {
  if (ctx.result.length > 10000) {
    return hookToolResult(ctx.result.slice(0, 10000) + '\n... truncated')
  }
  return hookNext()
})
```

### createApprovalHook()

```ts
import { createApprovalHook, hookNext, hookDeny, hookAsk } from '@humanlayer/agentlayer-core/hooks'

const requireApprovalForWrites = createApprovalHook(async (ctx) => {
  if (ctx.tool.name === 'Write') {
    return hookAsk({
      message: `Allow writing to ${ctx.input.file_path}?`,
      toolUseId: ctx.toolUseId,
    })
  }
  return hookNext()  // Auto-approve other tools
})
```

### createPreRequestHook()

```ts
import { createPreRequestHook } from '@humanlayer/agentlayer-core/hooks'

const addTimestamp = createPreRequestHook(async (ctx) => {
  return {
    type: 'transform',
    systemAdditions: [`Current time: ${new Date().toISOString()}`]
  }
})
```

## Typed Hooks

Create hooks that only run for specific tools:

```ts
import { createPreToolUseHook, isToolCall } from '@humanlayer/agentlayer-core/hooks'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'

const bashOnlyHook = createPreToolUseHook(
  BashTool,  // Type filter
  async (ctx) => {
    // ctx.input is typed as BashInput
    console.log('Running:', ctx.input.command)
    return hookNext()
  }
)

// Or use isToolCall for runtime checks
const conditionalHook = createPreToolUseHook(async (ctx) => {
  if (isToolCall(ctx, BashTool)) {
    // ctx.input is narrowed to BashInput
  }
  return hookNext()
})
```

## Hook Results

### PreToolUse Results

```ts
hookNext()                    // Continue to next hook/execution
hookNext({ input: modified }) // Continue with modified input
hookDeny(reason)              // Block execution, return reason to model
hookStop(reason)              // Stop the entire agent run
hookToolResult(result)        // Skip execution, return this result
```

### PostToolUse Results

```ts
hookNext()                    // Continue with original result
hookToolResult(modified)      // Replace the result
hookStop(reason)              // Stop the agent run
hookDone(result)              // Stop and return final result
```

### Approval Results

```ts
hookNext()                    // Auto-approve
hookDeny(reason)              // Deny the tool call
hookAsk({ message, ... })     // Pause for user approval
```

### PreRequest Results

```ts
{ type: 'next' }                           // Continue unchanged
{ type: 'transform', systemAdditions: [] } // Add to system prompt
{ type: 'transform', messages: [] }        // Replace messages
```

## Hook Context

All hooks receive a context with:

```ts
interface HookContext {
  tool: Tool
  toolUseId: string
  input: unknown
  
  // State access
  getState: (key: string) => unknown
  setState: (key: string, value: unknown) => void
}
```

## Built-in Hooks

### deduplicateReads()

Prevents reading the same file multiple times.

```ts
import { deduplicateReads } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preToolUse: [deduplicateReads()]
}
```

### stripThinkingTokens()

Removes `<thinking>` blocks from responses.

```ts
import { stripThinkingTokens } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preRequest: [stripThinkingTokens()]
}
```

### truncateOldBashResults()

Truncates old bash output to save context.

```ts
import { truncateOldBashResults } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preRequest: [truncateOldBashResults({ maxLines: 50 })]
}
```

## Running Hooks

Low-level hook execution (usually handled by Agent):

```ts
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runApprovalHooks,
  runPreRequestHooks
} from '@humanlayer/agentlayer-core/hooks'

const result = await runPreToolUseHooks(hooks, context)
```

## Type Exports

```ts
import type {
  PreToolUseHook,
  PreToolUseHookContext,
  PreToolUseResult,
  PostToolUseHook,
  PostToolUseHookContext,
  PostToolUseResult,
  ApprovalHook,
  ApprovalHookContext,
  ApprovalHookResult,
  PreRequestHook,
  PreRequestHookContext,
  PreRequestResult,
  TypedPreToolUseHookContext,
  TypedPostToolUseHookContext,
  TypedApprovalHookContext,
  ToolInfo,
  ToolRef,
  ApprovalRequest,
  ApprovalRequestData,
  NextResult,
  DenyResult,
  AskResult,
  ToolResultResult,
  HookStopResult,
  DoneResult,
} from '@humanlayer/agentlayer-core/hooks'
```
