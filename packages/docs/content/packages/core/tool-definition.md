# Tool Definition

AgentLayer provides two functions for defining tools: `defineTool()` for complete tools and `defineToolInterface()` for separating interface from implementation.

## defineTool()

Creates a complete tool with schema and execution logic.

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const readFile = defineTool({
  name: 'read',
  description: 'Read a file from disk',
  input: z.object({
    path: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Line to start from'),
    limit: z.number().optional().describe('Number of lines to read')
  }),
  execute: async (input, ctx) => {
    const content = await fs.readFile(input.path, 'utf-8')
    return content
  }
})
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Tool name (used in model calls) |
| `description` | `string` | Description shown to the model |
| `input` | `ZodSchema` | Zod schema for input validation |
| `output` | `ZodSchema` | Optional Zod schema for output validation (defaults to `z.string()`) |
| `execute` | `(input: TInput, ctx: ToolContext) => Promise<TOutput>` | Execution function |
| `serialize` | `(raw: TOutput, input: TInput) => string` | Optional custom serialization for output |
| `stateKey` | `string` | Optional key for stateful tools |
| `stateSchema` | `ZodSchema` | Optional Zod schema for tool state (required with `stateKey`) |

## defineToolInterface()

Creates a tool interface without implementation - useful for separating schema from executor.

```ts
import { defineToolInterface } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

// Define the interface (can be shared across implementations)
export const ReadTool = defineToolInterface({
  name: 'Read',
  description: 'Read file contents',
  input: z.object({
    path: z.string(),
  })
})

// Later, create an implementation using .define()
const readTool = ReadTool.define(async (input, ctx) => {
  return await fs.readFile(input.path, 'utf-8')
})
```

### Why Separate Interface from Implementation?

1. **Reusability**: Share interfaces across different runtimes (Node.js, browser, serverless)
2. **Testing**: Mock implementations for testing
3. **Documentation**: Generate docs from interfaces without runtime dependencies

## Tool Context

The `execute` function receives the validated input as the first argument and a context object as the second:

```ts
interface ToolContext {
  // Context window access
  getContextWindow(): ReadonlyArray<ModelMessage>
  updateContextWindow(cb: (messages: ModelMessage[]) => ModelMessage[]): void
  
  // Token information
  getContextWindowTokens(): number
  getContextWindowLimit(): number | undefined
  
  // Cancellation & control
  signal: AbortSignal
  stop(options?: StopOptions): HookStopResult
  
  // Streaming flag (for sub-agent propagation)
  stream?: boolean
  
  // Sub-agent integration (only available in agent context)
  toolCallId?: string
  pauseForSubAgent?: (agentId: string, childState: AgentState) => SubAgentPauseResult
  getSubAgentState?: (agentId: string) => AgentState | undefined
  awaitSubAgent?: (childRun: SubAgentRunHandle, agentId: string, parentToolCallId: string) => Promise<SubAgentResult>
}
```

## Stateful Tools

Tools can maintain state across calls by declaring `stateKey` and `stateSchema`. The execute function receives `ToolStateAccessors<TState>` merged into the context:

```ts
interface ToolStateAccessors<TState> {
  getToolState(): TState | undefined
  updateToolState(updater: (current: TState | undefined) => TState): void
}
```

Example:

```ts
interface FileTrackingState {
  filesRead: string[]
}

const trackingReadTool = defineTool({
  name: 'read',
  description: 'Read a file',
  input: z.object({ path: z.string() }),
  stateKey: 'file-tracking',
  stateSchema: z.object({ filesRead: z.array(z.string()) }),
  execute: async (input, ctx) => {
    const state = ctx.getToolState() ?? { filesRead: [] }
    ctx.updateToolState(() => ({
      filesRead: [...state.filesRead, input.path]
    }))
    
    return await fs.readFile(input.path, 'utf-8')
  }
})
```

## Type Exports

```ts
import type {
  Tool,
  ToolInterface,
  ToolInterfaceConfig,
  ToolContext,
  ToolContextFor,
  ToolStateAccessors,
  ToolCallRef,
  ToolCallResult,
  ExecuteToolCallContext,
} from '@humanlayer/agentlayer-core'
```

## executeToolCall()

Low-level function to execute a tool call manually. Takes two arguments: a `ToolCallRef` and an `ExecuteToolCallContext`.

```ts
import { executeToolCall } from '@humanlayer/agentlayer-core'

interface ToolCallRef {
  toolCallId: string
  toolName: string
  input: unknown
}

interface ExecuteToolCallContext {
  tools: Record<string, Tool<any, any>>
  messages: ReadonlyArray<ModelMessage>
  signal: AbortSignal
  toolState?: Record<string, unknown>
  subAgents?: Record<string, AgentState>
  agentRun?: AgentRun
  getContextWindowTokens?: () => number
  getContextWindowLimit?: () => number | undefined
}

const result = await executeToolCall(
  {
    toolCallId: 'toolu_123',
    toolName: 'read',
    input: { path: '/tmp/file.txt' },
  },
  {
    tools: { read: readTool },
    messages: [],
    signal: new AbortController().signal,
  }
)
```
