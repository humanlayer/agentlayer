---
title: Tools
description: Understand tool interfaces, implementations, tool context APIs, and patterns for swapping execution backends.
---

# Tools

Tool interfaces and tool implementations are intentionally separate.

The model should see a stable interface. The runtime should decide how the work actually happens.

Separate the brain from the hands.

## `defineTool()` vs `defineToolInterface()`

There are two ways to define tools.

### `defineTool()`

Use `defineTool()` when the schema and the executor belong together.

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const done = defineTool({
  name: 'done',
  description: 'Call when finished.',
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Done: ${input.summary}`,
})
```

This is useful for one-off tools or tools whose execution model is not meant to vary.

### `defineToolInterface()`

Use `defineToolInterface()` when you want one model-facing interface with multiple possible implementations.

```ts
import { defineToolInterface } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const ReadTool = defineToolInterface({
  name: 'read',
  description: 'Read a file',
  input: z.object({ filePath: z.string() }),
  output: z.string(),
})
```

Then define concrete implementations separately:

```ts
// Local disk
const localRead = ReadTool.define(async (input) => {
  return await Bun.file(input.filePath).text()
})

// S3
const s3Read = ReadTool.define(async (input) => {
  return await s3.getObject({ Key: input.filePath }).then((r) => r.Body!.transformToString())
})
```

That is the key pattern in this toolkit.

## Built-In Tool Interfaces

The toolkit already ships with a substantial library of reusable tool interfaces in `@humanlayer/agentlayer-core/interfaces`.

These are not just placeholder schemas. Many of them already carry useful serialization and model-facing behavior, so you get more than a raw Zod object by using the built-in interfaces.

Notable examples:

- [`ReadTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/read.ts) -- includes line-numbered serialization and continuation hints for partial reads
- [`ApplyPatchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/apply-patch.ts) -- model-facing patch interface for unified diff application
- [`BashTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/bash.ts) -- stable shell execution interface that can be backed by different runtimes
- [`EditTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/edit.ts) -- structured file edit interface
- [`WriteTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/write.ts) -- structured whole-file write interface
- [`MultiEditTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/multiedit.ts) -- batch edit interface for multiple file mutations
- [`GlobTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/glob.ts) -- file pattern lookup interface
- [`GrepTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/grep.ts) -- content search interface
- [`ListTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/list.ts) -- directory listing interface
- [`SkillTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/skill.ts) -- activate named skills through a stable tool surface
- [`CodeSearchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/code-search.ts) -- code-focused search interface
- [`WebFetchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/web-fetch.ts) -- fetch and serialize web content
- [`WebSearchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/web-search.ts) -- search-oriented web interface
- [`CreateFileTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/create-file.ts) -- explicit file creation interface
- [`DeleteFileTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/delete-file.ts) -- explicit file deletion interface
- [`CommentTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/comment.ts) -- structured comment interface
- [`StructuredOutputTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/structured-output.ts) -- built-in structured-output tool surface
- [`SubagentTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts) -- built-in sub-agent dispatch surface

If you want the complete export surface, see [`packages/agentlayer-core/src/interfaces/index.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/index.ts).

## Why The Built-In Interfaces Matter

The built-in interfaces are worth using because they already encode model-facing conventions.

For example, `ReadTool` does not just define a file path schema. It also serializes file contents with numbered lines and continuation hints, which means every backend implementation inherits the same model-visible behavior.

That is the important distinction: the interface owns the model contract, while the implementation owns the runtime behavior.

## Tool Context APIs

Every tool gets a `ToolContext`.

The core API shape is effectively:

```ts
interface ToolContext {
  // Returns a read-only snapshot of messages at call time
  getContextWindow(): ReadonlyArray<ModelMessage>

  // Queues a deferred context mutation after this tool result is committed
  updateContextWindow(cb: (messages: ModelMessage[]) => ModelMessage[]): void

  // Cooperative cancellation only; does not force-kill the tool mid-execution
  signal: AbortSignal

  // Stops the loop after this tool call resolves
  stop(options?: StopOptions): HookStopResult

  // Estimated context token count after recent model calls
  getContextWindowTokens(): number

  // Context window limit resolved from config or models.dev
  getContextWindowLimit(): number | undefined
}

interface ToolStateAccessors<TState> {
  // Read this tool's persisted KV-style state
  getToolState(): TState | undefined

  // Update this tool's persisted KV-style state
  updateToolState(updater: (current: TState | undefined) => TState): void
}
```

When a tool declares both `stateKey` and `stateSchema`, its executor receives:

```ts
type StatefulToolContext<TState> = ToolContext & ToolStateAccessors<TState>
```

Relevant source on `main`:

- [`ToolContext` in `define-tool.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts)
- [`ToolStateAccessors` in `define-tool.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts)
- [`stateKey` / `stateSchema` on `Tool` in `define-tool.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts)
- [`AgentState.toolState` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)

### `getContextWindow()`

```ts
getContextWindow(): ReadonlyArray<ModelMessage>
```

Returns a frozen, read-only snapshot of the conversation messages at the point in time the function is called.

That distinction matters when multiple async tools are running at once.

The snapshot is **not** fixed at the moment the tool executor starts. If another tool in the same parallel batch finishes first and commits its result, a later call to `getContextWindow()` from this tool can observe the updated message history.

Use it when you need the freshest available context during execution.

### `updateContextWindow(cb)`

```ts
updateContextWindow(cb: (messages: ModelMessage[]) => ModelMessage[]): void
```

Queues a deferred mutation to the conversation history.

The callback receives the message array **after** this tool's result has been committed. It must return a new message array.

This is the main tool-level API for mutating future model context.

### `signal`

```ts
signal: AbortSignal
```

An `AbortSignal` tied to the run lifecycle.

This is for cooperative cancellation in tool internals such as `fetch()` calls or child processes. It does **not** mean the tool will be force-killed by the loop mid-execution.

### `stop(options?)`

```ts
stop(options?: StopOptions): HookStopResult

interface StopOptions {
  include?: boolean
  output?: string
  dropParallel?: boolean
  reason?: string
}
```

Requests that the agent loop stop **after** this tool call completes.

This is not the same thing as aborting execution right this second.

It is a loop-control primitive: the tool returns a stop result, the loop records the outcome, and the caller can then freeze state, persist it, and resume later if needed. That makes it especially useful for long-running outer-loop agents and workflow-driven agents that deliberately pause between phases.

Field meanings:

- `include` controls whether this tool result is appended before the loop stops
- `output` lets you override the tool result text that gets appended when `include` is true
- `dropParallel` also drops sibling results from the same parallel batch
- `reason` records a human-readable explanation for the stop

### `getContextWindowTokens()`

```ts
getContextWindowTokens(): number
```

Returns the current estimated token count for the context window.

### `getContextWindowLimit()`

```ts
getContextWindowLimit(): number | undefined
```

Returns the configured or auto-resolved context window limit for the current model.

## Context Mutation From Tools

Tools can change what the model sees next by queueing deferred context updates.

```ts
execute: async (input, ctx) => {
  ctx.updateContextWindow((messages) => [
    ...messages,
    { role: 'user', content: 'Additional context from the tool' },
  ])
  return 'tool output'
}
```

This runs after the tool result is committed.

Because `getContextWindow()` is evaluated at call time and `updateContextWindow()` is applied after the tool result is committed, tools can both inspect fresh context and deliberately shape what the next model call sees.

For a concrete built-in example, see the [`SkillTool` implementation on `main`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/skill.ts), which uses context mutation patterns to add skill content into the active agent context.

## Approvals

Approvals are part of the tool execution pipeline.

Approval hooks can:

- allow execution
- deny execution
- ask for human approval

That makes approvals composable across any tool surface.

See [`Approval Hooks`](/core/hooks.html#approval-hooks) for the hook API, wiring, and codebase examples.

## Filesystem Abstraction

The filesystem package provides local implementations for common interfaces such as read, write, list, grep, glob, edit, and bash.

Those tools are Bun-native and operate against the host filesystem.

The important point is that the model-facing shape can stay the same even if the backend changes.

## Sandboxed Bash

The just-bash package provides sandboxed implementations that preserve the tool interface while changing the execution environment.

For example, a bash-like tool can execute in a sandbox without changing what the model is told.

## Branching In The Tool

You can also branch inside an implementation.

For example, you might route reads differently based on a magic directory prefix:

```ts
const ReadTool = defineToolInterface({
  name: 'read',
  description: 'Read a file',
  input: z.object({ filePath: z.string() }),
  output: z.string(),
})

const branchingRead = ReadTool.define(async (input) => {
  if (input.filePath.startsWith('/virtual/')) {
    return await db.lookup(input.filePath)
  }
  return await Bun.file(input.filePath).text()
})
```

## Tool KV State

Tools can persist their own state through `stateKey` and `stateSchema`.

That state is stored under `AgentState.toolState` and travels with the serialized run state.

This makes it possible to implement tools backed by persistent KV-like state without reaching outside the agent state model.

This same pattern also shows up in the filesystem hook layer. The read-before-write tracking hooks use persisted file-state tracking to remember what was read, what was verified, and whether a write is operating on stale context.

Codebase examples on `main`:

- [`file-state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-filesystem/src/hooks/file-state.ts)

Those hooks are built around the existing file-oriented interfaces:

- [`ReadTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/read.ts)
- [`WriteTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/write.ts)
- [`EditTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/edit.ts)
- [`ApplyPatchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/apply-patch.ts)

That is a useful example because it shows the same general idea applied at the workflow level: keep enough structured state around to enforce read-before-write discipline across multiple tool calls.

## Stateful Tool Example

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const counterTool = defineTool({
  name: 'increment_counter',
  description: 'Increment and return a persistent counter.',
  input: z.object({}),
  stateKey: 'counter',
  stateSchema: z.number(),
  execute: async (_input, ctx) => {
    const current = ctx.getToolState() ?? 0
    ctx.updateToolState(() => current + 1)
    return `Counter: ${current + 1}`
  },
})
```

This pattern is useful when a tool needs lightweight persistent state that should be checkpointed along with the rest of the agent.

For the exact stateful-tool typing and overload shape, see [`defineTool()` on `main`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts).

When a tool declares both `stateKey` and `stateSchema`, its executor also receives:

- `getToolState(): TState | undefined`
- `updateToolState(updater: (current: TState | undefined) => TState): void`

That gives you a structured way to build stateful tools without depending on external mutable process state.
