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

Creates a hook that runs before tool execution for specific tools.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool` | [`ToolRef`](#what-is-a-toolref) `\| ToolRef[]` | Tool(s) to match. Use `as const` for arrays. |
| `hook` | `(ctx: TypedPreToolUseHookContext) => PreToolUseResult` | Hook callback with typed `ctx.input` |

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'

const logBashCalls = createPreToolUseHook(BashTool, async (ctx) => {
  console.log(`Running:`, ctx.input.command)
  return ctx.next()
})
```

### createPostToolUseHook()

Creates a hook that runs after tool execution for specific tools.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool` | [`ToolRef`](#what-is-a-toolref) `\| ToolRef[]` | Tool(s) to match |
| `hook` | `(ctx: TypedPostToolUseHookContext) => PostToolUseResult` | Hook callback. Must return `ctx.done()` |

```ts
import { createPostToolUseHook } from '@humanlayer/agentlayer-core/hooks'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'

const truncateLongResults = createPostToolUseHook(BashTool, async (ctx) => {
  if (ctx.output.length > 10000) {
    return ctx.done(ctx.output.slice(0, 10000) + '\n... truncated')
  }
  return ctx.done()
})
```

### createApprovalHook()

Creates a hook that controls approval for specific tools.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool` | [`ToolRef`](#what-is-a-toolref) `\| ToolRef[]` | Tool(s) to match |
| `hook` | `(ctx: TypedApprovalHookContext) => ApprovalHookResult` | Hook callback |

```ts
import { createApprovalHook } from '@humanlayer/agentlayer-core/hooks'
import { WriteTool } from '@humanlayer/agentlayer-core/interfaces'

const requireApprovalForWrites = createApprovalHook(WriteTool, async (ctx) => {
  return ctx.ask({
    message: `Allow writing to ${ctx.input.file_path}?`,
  })
})
```

### createPreRequestHook()

Creates a hook that runs before each LLM request. Unlike other hooks, this does **not** take a tool parameter.

| Parameter | Type | Description |
|-----------|------|-------------|
| `hook` | `(ctx: PreRequestHookContext) => PreRequestResult` | Hook callback |

```ts
import { createPreRequestHook } from '@humanlayer/agentlayer-core/hooks'

const addTimestamp = createPreRequestHook(async (ctx) => {
  const newMessages = [
    ...ctx.messages,
    { role: 'system', content: `Current time: ${new Date().toISOString()}` }
  ]
  return ctx.transform(newMessages)
})
```

## Typed Hooks

Create hooks that only run for specific tools. The `create*Hook` factories take a **`ToolRef`** as the first argument.

### What is a ToolRef?

A `ToolRef` is any object with `{ name: string, input: ZodSchema, output?: ZodSchema }`. This includes:

1. **A `ToolInterface`** (from `defineToolInterface`)
2. **A `Tool`** (from `defineTool` or `interface.define()`)
3. **An array of either** (use `as const` for best type inference)

```ts
interface ToolRef<TInput = any, TOutput = any> {
  name: string
  input: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
}
```

### Examples

```ts
import { createPreToolUseHook, createPostToolUseHook, createApprovalHook, isToolCall } from '@humanlayer/agentlayer-core/hooks'
import { BashTool, ReadTool, WriteTool } from '@humanlayer/agentlayer-core/interfaces'

// 1. Single ToolInterface - ctx.input is typed as BashInput
const bashOnlyHook = createPreToolUseHook(BashTool, async (ctx) => {
  console.log('Running:', ctx.input.command)
  return ctx.next()
})

// 2. Single Tool (from defineTool)
const greetTool = defineTool({
  name: 'greet',
  input: z.object({ name: z.string() }),
  execute: async (input) => `Hello, ${input.name}!`,
})

const logGreets = createPreToolUseHook(greetTool, (ctx) => {
  console.log('Greeting:', ctx.input.name)  // Typed as { name: string }
  return ctx.next()
})

// 3. Array of tools - ctx.input is union of inputs
// IMPORTANT: Use `as const` for proper type inference
const fileHook = createPreToolUseHook([ReadTool, WriteTool] as const, async (ctx) => {
  // ctx.input is ReadInput | WriteInput
  console.log('File operation:', ctx.toolName)
  return ctx.next()
})
```

### NOT supported: plain strings

```ts
// ❌ This does NOT work - strings are not accepted
createPreToolUseHook('read', (ctx) => { ... })

// ✅ Use the ToolInterface instead
createPreToolUseHook(ReadTool, (ctx) => { ... })
```

### Using isToolCall() for Type Narrowing

For generic hooks or when handling multiple tools, use `isToolCall()` to narrow types at runtime:

```ts
const genericHook: PreToolUseHook = (ctx) => {
  // ctx.input is Record<string, unknown> here
  
  if (isToolCall(ctx, ReadTool)) {
    // ctx.input is now ReadInput (narrowed)
    console.log('Reading:', ctx.input.file_path)
  }
  
  if (isToolCall(ctx, BashTool)) {
    // ctx.input is now BashInput (independently narrowed)
    console.log('Running:', ctx.input.command)
  }
  
  return ctx.next()
}
```

`isToolCall()` works with both `PreToolUseHookContext` and `PostToolUseHookContext`.

### Auto Pass-Through Behavior

When you create a typed hook, non-matching tools are automatically passed through:
- **preToolUse/approval**: Calls `ctx.next()` for non-matching tools
- **postToolUse**: Calls `ctx.done()` for non-matching tools

## Hook Results

### PreToolUse Results

```ts
// Use context methods
ctx.next()                              // Continue to next hook/execution
ctx.next(updatedInput)                  // Continue with modified input
ctx.next(updatedInput, { updateContextWindow: true })  // Also patch context
ctx.toolResult(output)                  // Skip execution, return this result
ctx.toolResult(output, { isError: true })  // Return as error (won't trigger stop)
ctx.stop({ reason: '...' })             // Stop the entire agent run

// Or use hook functions directly
hookNext()                    // Continue to next hook/execution
hookNext(updatedInput)        // Continue with modified input
hookToolResult(result)        // Skip execution, return this result
hookStop({ reason: '...' })   // Stop the entire agent run
```

### PostToolUse Results

```ts
// PostToolUse hooks can ONLY return DoneResult
ctx.done()                    // Continue with original result
ctx.done(mutatedResult)       // Replace the result with mutatedResult (string or structured)
// Or use hookDone() directly
hookDone()                    // Continue with original result
hookDone(mutatedResult)       // Replace the result
```

### Approval Results

```ts
// Use context methods (preferred)
ctx.next()                    // Auto-approve
ctx.deny(reason)              // Deny the tool call
ctx.ask({ message: '...' })   // Pause for user approval (takes ApprovalRequestData)

// Or use hook functions directly
hookNext()                    // Auto-approve
hookDeny(reason)              // Deny the tool call
hookAsk(approvalRequest)      // Pause for approval (takes full ApprovalRequest)
```

### PreRequest Results

```ts
// Use context methods or return result objects directly
ctx.next()                                   // Continue unchanged
ctx.transform(messages)                      // Replace messages
ctx.transform(messages, { persist: true })   // Replace and persist to context window

// Result types use 'preRequestNext' and 'preRequestTransform'
{ type: 'preRequestNext' }                              // Continue unchanged
{ type: 'preRequestTransform', messages: [], persist: false }  // Replace messages
```

## Hook Contexts

Each hook type has its own context interface. There is no generic `HookContext` interface.

### PreToolUseHookContext

```ts
interface PreToolUseHookContext extends HookStateAccess {
  toolName: string
  toolCallId: string               // Note: toolCallId, not toolUseId
  input: Record<string, unknown>
  tool: ToolInfo
  getContextWindow: () => ReadonlyArray<ModelMessage>
  next(updatedInput?: Record<string, unknown>, opts?: NextOptions): NextResult
  toolResult(output: AgentLayerToolOutput, opts?: ToolResultOptions): ToolResultResult
  stop(options?: StopOptions): HookStopResult
}
```

### PostToolUseHookContext

```ts
interface PostToolUseHookContext extends HookStateAccess {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  output: AgentLayerToolOutput  // string or structured multimodal content
  rawOutput: unknown
  tool: ToolInfo
  getContextWindow: () => ReadonlyArray<ModelMessage>
  done(mutatedResult?: AgentLayerToolOutput): DoneResult
}
```

### ApprovalHookContext

```ts
interface ApprovalHookContext {
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
  tool: ToolInfo
  getContextWindow: () => ReadonlyArray<ModelMessage>
  next(): NextResult
  deny(reason?: string): DenyResult
  ask(approval: ApprovalRequestData): AskResult
}
```

### PreRequestHookContext

```ts
interface PreRequestHookContext {
  messages: ReadonlyArray<ModelMessage>    // Note: ReadonlyArray
  contextWindowTokens: number
  contextWindowLimit: number | undefined
  next(): PreRequestNextResult
  transform(messages: ModelMessage[], opts?: PreRequestTransformOptions): PreRequestTransformResult
}
```

### HookStateAccess

PreToolUse and PostToolUse hooks extend `HookStateAccess`:

```ts
interface HookStateAccess {
  getState<T>(key: string): T | undefined
  updateState<T>(key: string, updater: (current: T | undefined) => T): void
}
```

## Built-in Hooks

### deduplicateReads()

Prevents reading the same file multiple times by tracking reads and returning cached content. **Phase:** `preRequest`

```ts
import { deduplicateReads } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preRequest: [deduplicateReads()]
}
```

### stripThinkingTokens()

Removes `<thinking>` blocks from responses. **Phase:** `preRequest`

```ts
import { stripThinkingTokens } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preRequest: [stripThinkingTokens()]
}
```

### truncateOldBashResults()

Truncates old bash output to save context. **Phase:** `preRequest`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keep` | `number` | `3` | Number of recent bash results to keep in full |
| `summaryLines` | `number` | `5` | Lines to keep for truncated results |
| `persist` | `boolean` | `false` | Whether to persist changes to context window |

```ts
import { truncateOldBashResults } from '@humanlayer/agentlayer-core/hooks'

const hooks = {
  preRequest: [truncateOldBashResults({ keep: 3, summaryLines: 5 })]
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
  AgentLayerToolOutput,
} from '@humanlayer/agentlayer-core/hooks'
```
