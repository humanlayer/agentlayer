# Agent

The `Agent` class is the main entry point for running LLM-powered agents.

## Agent Class

```ts
import { Agent } from '@humanlayer/agentlayer-core'
import { anthropic } from '@ai-sdk/anthropic'

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: { read, write, bash },
  system: 'You are a helpful assistant.',
  hooks: { ... },
  stopWhen: [maxSteps(50)]
})
```

### Constructor Options

```ts
interface AgentConfig {
  // Required
  model: LanguageModel              // from 'ai' package
  tools: Record<string, Tool<any, any>>
  
  // Optional
  system?: string | string[]
  hooks?: {
    approval?: ApprovalHook[]
    preToolUse?: PreToolUseHook[]
    postToolUse?: PostToolUseHook[]
    preRequest?: PreRequestHook[]
  }
  toolChoice?: ToolChoice<TTools>
  maxSteps?: number
  stopWhen?: StopWhen               // StopConditionDef | StopConditionDef[]
  providerOptions?: ProviderOptions
  modelProvider?: ModelProvider
  contextWindowLimit?: number
  onError?: (error: AgentError, result: RunResult) => void | Promise<void>
  onStop?: (result: RunResult) => void | Promise<void>
  onApprovalRequested?: (approval: ApprovalRequest, toolCallId: string, toolName: string, input: Record<string, unknown>) => void | Promise<void>
}
```

| Option | Type | Description |
|--------|------|-------------|
| `model` | `LanguageModel` | Language model instance from the `ai` package (e.g., `anthropic('claude-sonnet-4-20250514')`) |
| `tools` | `Record<string, Tool<any, any>>` | Map of tool names to tool definitions |
| `system` | `string \| string[]` | System prompt(s) |
| `hooks` | `object` | Hook configuration for all phases |
| `toolChoice` | `ToolChoice<TTools>` | Tool selection strategy |
| `maxSteps` | `number` | Maximum number of agent loop steps |
| `stopWhen` | `StopWhen` | Conditions that stop the agent loop (single or array) |
| `providerOptions` | `ProviderOptions` | Provider-specific options (temperature, etc.) |
| `modelProvider` | `ModelProvider` | Custom model provider for pricing/limits |
| `contextWindowLimit` | `number` | Explicit context window limit override |
| `onError` | `function` | Callback when the run finishes with an error (observe-only) |
| `onStop` | `function` | Callback when the run finishes for any reason |
| `onApprovalRequested` | `function` | Callback when an approval is requested (observe-only) |

## Running the Agent

### `agent.run()`

Starts a new agent run and returns an `AgentRun` object (async iterator of events).

```ts
const run = agent.run({ state, signal?, stream? })

for await (const event of run) {
  // Handle events
}
```

### RunOptions

```ts
interface RunOptions {
  state: AgentState         // Required: agent state (messages, pending tool calls, etc.)
  signal?: AbortSignal      // Cancellation signal
  stream?: boolean          // Whether to emit streaming events
}
```

## AgentRun

The object returned by `agent.run()` provides additional methods:

```ts
const run = agent.run({ state: { messages: [{ role: 'user', content: 'Hello' }] } })

// Iterate events
for await (const event of run) { ... }

// Get final result (after iteration completes)
const result: RunResult = await run.result

// Check if still running
run.running // boolean

// Resolve an in-flight approval (hot path)
run.resolveApproval(toolCallId, 'approve') // or 'deny', reason?
```

## RunResult

```ts
interface RunResult {
  state: AgentState                 // Full agent state after this run
  newMessages: ModelMessage[]       // Messages added during this run
  finishReason: FinishReason
  stopCondition?: StopResult        // Present when finishReason is 'stopCondition'
  error?: AgentError                // Present when finishReason is 'error'
  tokenUsage: TokenUsage            // Per-model token usage aggregate for this run
}
```

## FinishReason

```ts
type FinishReason =
  | 'complete'           // Model finished naturally (no tool calls)
  | 'maxSteps'           // Hit maxSteps limit
  | 'stopCondition'      // A stop condition triggered
  | 'interrupted'        // AbortSignal triggered
  | 'approvalRequired'   // Waiting for approval
  | 'error'              // An error occurred
```

## Events

The agent emits events during execution:

```ts
type AgentEvent =
  | { type: 'message'; message: ModelMessage }
  | { type: 'approvalRequested'; approval: ApprovalRequest; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tokenUsage'; usage: TokenUsageEvent }
  | { type: 'stepStart'; stepIndex: number }
  | { type: 'textStart'; id: string; stepIndex: number }
  | { type: 'textDelta'; id: string; text: string; stepIndex: number }
  | { type: 'textEnd'; id: string; stepIndex: number }
  | { type: 'toolInputStart'; id: string; toolName: string; stepIndex: number }
  | { type: 'toolInputDelta'; id: string; delta: string; stepIndex: number }
  | { type: 'toolInputEnd'; id: string; stepIndex: number }
  | { type: 'reasoningStart'; id: string; stepIndex: number }
  | { type: 'reasoningDelta'; id: string; text: string; stepIndex: number }
  | { type: 'reasoningEnd'; id: string; stepIndex: number }
  | { type: 'stepFinish'; stepIndex: number; finishReason?: string }
```

All event types also include optional `agentId` and `parentToolCallId` metadata fields.

## Resuming

Resume from a paused state (e.g., after approval):

```ts
// First run pauses for approval
const run1 = agent.run({ state: { messages: [{ role: 'user', content: 'Delete the file' }] } })
for await (const event of run1) { ... }
const { state, finishReason } = await run1.result

if (finishReason === 'approvalRequired') {
  // User approves...
  const approvedState = withApprovals(state, approvals)
  
  // Resume
  const run2 = agent.run({ state: approvedState })
  for await (const event of run2) { ... }
}
```

## Error Handling

```ts
import { AgentError, InvalidMessagesError } from '@humanlayer/agentlayer-core'

try {
  for await (const event of agent.run({ state })) {
    // ...
  }
} catch (error) {
  if (error instanceof AgentError) {
    console.error(`Agent error (${error.type}):`, error.message)
  }
}
```

### AgentErrorType

```ts
type AgentErrorType =
  | 'invalid_messages_error'
  | 'unexpected_error'
```
