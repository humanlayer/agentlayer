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
  execute: async ({ input, context }) => {
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
| `execute` | `(ctx) => Promise<string>` | Execution function |
| `state` | `object` | Optional state accessors |

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

// Later, create an implementation
const readTool = ReadTool.implement({
  execute: async ({ input }) => {
    return await fs.readFile(input.path, 'utf-8')
  }
})
```

### Why Separate Interface from Implementation?

1. **Reusability**: Share interfaces across different runtimes (Node.js, browser, serverless)
2. **Testing**: Mock implementations for testing
3. **Documentation**: Generate docs from interfaces without runtime dependencies

## Tool Context

The `execute` function receives a context object:

```ts
interface ToolContext<TInput, TState> {
  input: TInput                    // Validated input
  toolUseId: string               // Unique ID for this call
  
  // State accessors (if configured)
  getState: () => TState
  setState: (state: TState) => void
  updateState: (partial: Partial<TState>) => void
  
  // Subagent support
  runSubagent: (config) => SubAgentRunHandle
}
```

## Stateful Tools

Tools can maintain state across calls using state accessors:

```ts
interface FileTrackingState {
  filesRead: Set<string>
}

const trackingReadTool = defineTool({
  name: 'read',
  description: 'Read a file',
  input: z.object({ path: z.string() }),
  state: {
    key: 'file-tracking',
    initial: (): FileTrackingState => ({ filesRead: new Set() })
  },
  execute: async ({ input, getState, updateState }) => {
    const state = getState()
    state.filesRead.add(input.path)
    updateState(state)
    
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

Low-level function to execute a tool call manually:

```ts
import { executeToolCall } from '@humanlayer/agentlayer-core'

const result = await executeToolCall({
  tool,
  toolUseId: 'toolu_123',
  input: { path: '/tmp/file.txt' },
  toolState: {},
  subagentState: {},
})
```
