---
title: Tools
description: Define tool interfaces, implement them for different backends, and use the tool context API.
---

# Tools

Tools are what agents can do. AgentLayer separates tool **interfaces** (what the model sees) from **implementations** (what actually runs).

## Quick Start

### Simple Tools with `defineTool()`

Use `defineTool()` when the schema and executor belong together:

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const greet = defineTool({
  name: 'greet',
  description: 'Greet someone by name.',
  input: z.object({ name: z.string() }),
  execute: async (input) => `Hello, ${input.name}!`,
})
```

### Reusable Interfaces with `defineToolInterface()`

Use `defineToolInterface()` when you want one model-facing interface with multiple implementations:

```ts
import { defineToolInterface } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const ReadTool = defineToolInterface({
  name: 'read',
  description: 'Read a file and return its contents.',
  input: z.object({ 
    filePath: z.string().describe('Absolute path to the file'),
  }),
  output: z.string(),
})

// Local filesystem implementation
const localRead = ReadTool.define(async (input) => {
  return await Bun.file(input.filePath).text()
})

// S3 implementation
const s3Read = ReadTool.define(async (input) => {
  const obj = await s3.getObject({ Key: input.filePath })
  return await obj.Body!.transformToString()
})
```

## API Reference

### `defineTool(config)`

Creates a complete tool with schema and executor.

```ts
function defineTool<TInput, TOutput = string>(config: {
  name: string
  description: string
  input: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput | HookStopResult>
  serialize?: (raw: TOutput, input: TInput) => string
}): Tool<TInput, TOutput>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Tool name shown to the model |
| `description` | `string` | What the tool does (shown to model) |
| `input` | `z.ZodType<TInput>` | Zod schema for input validation |
| `output` | `z.ZodType<TOutput>` | Optional output schema (defaults to string) |
| `execute` | `(input, ctx) => Promise<TOutput>` | The function that runs |
| `serialize` | `(raw, input) => string` | Custom serialization (default: JSON.stringify) |

::: info Source Reference
[`defineTool()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts#L189-L211) in `define-tool.ts`
:::

### `defineToolInterface(config)`

Creates a reusable tool interface that can have multiple implementations.

```ts
function defineToolInterface<TInput, TOutput = string>(config: {
  name: string
  description: string
  input: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  beforeExecutionTransform?: (input: TInput, ctx: ToolContext) => TInput
  serialize?: (raw: TOutput, input: TInput, ctx: ToolContext) => string
}): ToolInterface<TInput, TOutput>
```

The returned interface has a `.define(executor)` method:

```ts
interface ToolInterface<TInput, TOutput> {
  define(
    executor: (input: TInput, ctx: ToolContext) => Promise<TOutput>,
    overrides?: { description?: string }
  ): Tool<TInput, TOutput>
}
```

::: info Source Reference
[`defineToolInterface()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts#L252-L313) in `define-tool.ts`
:::

## Tool Context

Every tool executor receives a `ToolContext` with these methods:

### `getContextWindow()`

Returns a frozen, read-only snapshot of the conversation at call time.

```ts
execute: async (input, ctx) => {
  const messages = ctx.getContextWindow()
  const lastUserMessage = messages.findLast(m => m.role === 'user')
  // ...
}
```

::: tip
This is a function, not a property. Each call returns a fresh snapshot — useful when parallel tools need the latest state.
:::

### `updateContextWindow(callback)`

Queues a deferred mutation to the conversation. The callback runs **after** this tool's result is committed.

```ts
execute: async (input, ctx) => {
  ctx.updateContextWindow((messages) => [
    ...messages,
    { role: 'user', content: 'Additional context for the model' },
  ])
  return 'tool output'
}
```

### `stop(options?)`

Tells the loop to stop after this tool call completes. Returns a value the tool should return.

```ts
execute: async (input, ctx) => {
  if (input.shouldStop) {
    return ctx.stop({ reason: 'User requested stop' })
  }
  return 'normal output'
}
```

Options:

| Option | Type | Description |
|--------|------|-------------|
| `include` | `boolean` | Include this tool result in context (default: true) |
| `output` | `string` | Override the tool result text |
| `dropParallel` | `boolean` | Drop sibling results from same batch |
| `reason` | `string` | Human-readable explanation |

### `signal`

An `AbortSignal` for cooperative cancellation. Pass it to `fetch()` or child processes.

```ts
execute: async (input, ctx) => {
  const response = await fetch(input.url, { signal: ctx.signal })
  return await response.text()
}
```

### `getContextWindowTokens()` / `getContextWindowLimit()`

Get the current token count and configured limit:

```ts
execute: async (input, ctx) => {
  const tokens = ctx.getContextWindowTokens()
  const limit = ctx.getContextWindowLimit()
  if (limit && tokens > limit * 0.9) {
    // Context is getting full
  }
  return 'output'
}
```

::: info Source Reference
[`ToolContext`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts#L14-L99) in `define-tool.ts`
:::

## Stateful Tools

Tools can persist state across calls using `stateKey` and `stateSchema`:

```ts
const counterTool = defineTool({
  name: 'increment',
  description: 'Increment and return a counter.',
  input: z.object({}),
  stateKey: 'counter',
  stateSchema: z.number(),
  execute: async (_input, ctx) => {
    const current = ctx.getToolState() ?? 0
    const next = current + 1
    ctx.updateToolState(() => next)
    return `Counter: ${next}`
  },
})
```

When a tool declares both `stateKey` and `stateSchema`, its context includes:

- `getToolState(): TState | undefined` — Read current state
- `updateToolState(updater: (current: TState | undefined) => TState): void` — Update state

State is stored in `AgentState.toolState` and persists across runs.

::: info Source Reference
[`ToolStateAccessors`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts#L156-L161) in `define-tool.ts`
:::

## Built-in Tool Interfaces

AgentLayer ships reusable interfaces in `@humanlayer/agentlayer-core/interfaces`:

| Interface | Description |
|-----------|-------------|
| [`ReadTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/read.ts) | Read files with line-numbered output |
| [`WriteTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/write.ts) | Write/overwrite files |
| [`EditTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/edit.ts) | Structured string replacement edits |
| [`BashTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/bash.ts) | Shell command execution |
| [`GlobTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/glob.ts) | File pattern matching |
| [`GrepTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/grep.ts) | Content search |
| [`ListTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/list.ts) | Directory listing |
| [`ApplyPatchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/apply-patch.ts) | Unified diff application |
| [`MultiEditTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/multiedit.ts) | Batch file edits |
| [`CreateFileTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/create-file.ts) | Create new files |
| [`DeleteFileTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/delete-file.ts) | Delete files |
| [`WebFetchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/web-fetch.ts) | Fetch web content |
| [`WebSearchTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/web-search.ts) | Web search |
| [`SkillTool`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/interfaces/skill.ts) | Activate named skills |

These interfaces encode model-facing conventions. For example, `ReadTool` serializes file contents with line numbers:

```
1	const x = 1
2	const y = 2
3	console.log(x + y)
```

Every implementation inherits the same serialization.

## Pre-built Implementations

### Filesystem Tools

`@humanlayer/agentlayer-filesystem` provides Bun-native implementations:

```ts
import { 
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
} from '@humanlayer/agentlayer-filesystem/tools'

const agent = new Agent({
  tools: {
    bash: createBashTool({ cwd: process.cwd() }),
    read: createReadTool(),
    write: createWriteTool(),
    edit: createEditTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
  },
})
```

### Sandboxed Tools

`@humanlayer/agentlayer-justbash` provides sandboxed implementations via [just-bash](https://github.com/vercel-labs/just-bash):

```ts
import { createJustBashTools } from '@humanlayer/agentlayer-justbash'

const sandboxedTools = createJustBashTools({ cwd: '/sandbox' })
```

## Patterns

### Branching in Implementations

Route to different backends based on input:

```ts
const read = ReadTool.define(async (input) => {
  if (input.filePath.startsWith('/virtual/')) {
    return await db.lookup(input.filePath)
  }
  return await Bun.file(input.filePath).text()
})
```

### Custom Serialization

Override how output is formatted for the model:

```ts
const searchTool = defineToolInterface({
  name: 'search',
  description: 'Search the codebase',
  input: z.object({ query: z.string() }),
  output: z.array(z.object({ file: z.string(), line: z.number(), content: z.string() })),
  serialize: (results, input) => {
    if (results.length === 0) {
      return `No results found for "${input.query}"`
    }
    return results
      .map(r => `${r.file}:${r.line}\n${r.content}`)
      .join('\n\n')
  },
})
```

### Input Transformation

Transform inputs before execution:

```ts
const readTool = defineToolInterface({
  name: 'read',
  description: 'Read a file',
  input: z.object({ filePath: z.string() }),
  output: z.string(),
  beforeExecutionTransform: (input, ctx) => ({
    ...input,
    filePath: path.resolve(process.cwd(), input.filePath),
  }),
})
```

## Next Steps

- **[Hooks](/concepts/hooks)** — Intercept tool calls for approval, mutation, or transformation
- **[State](/concepts/state)** — How tool state persists across runs
- **[Subagents](/concepts/subagents)** — Give different tools to specialized child agents
