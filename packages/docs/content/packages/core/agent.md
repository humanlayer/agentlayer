# Agent

The `Agent` class is the main entry point for running LLM-powered agents.

## Agent Class

```ts
import { Agent } from '@humanlayer/agentlayer-core'

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [...],
  system: 'You are a helpful assistant.',
  hooks: { ... },
  stopWhen: [maxSteps(50)]
})
```

### Constructor Options

```ts
interface AgentConfig {
  // Required
  model: string
  tools: Tool[]
  
  // Optional
  system?: string | string[]
  hooks?: {
    approval?: ApprovalHook[]
    preToolUse?: PreToolUseHook[]
    postToolUse?: PostToolUseHook[]
    preRequest?: PreRequestHook[]
  }
  stopWhen?: StopConditionDef[]
  providerOptions?: ProviderOptions
}
```

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `tools` | `Tool[]` | Array of tools available to the agent |
| `system` | `string \| string[]` | System prompt(s) |
| `hooks` | `object` | Hook configuration for all phases |
| `stopWhen` | `StopConditionDef[]` | Conditions that stop the agent loop |
| `providerOptions` | `ProviderOptions` | Provider-specific options (temperature, etc.) |

## Running the Agent

### `agent.run()`

Starts a new agent run and returns an async iterator of events.

```ts
const run = agent.run(prompt, options?)

for await (const event of run) {
  // Handle events
}
```

### RunOptions

```ts
interface RunOptions {
  state?: AgentState        // Resume from existing state
  signal?: AbortSignal      // Cancellation signal
  maxTokens?: number        // Max tokens per response
}
```

## AgentRun

The object returned by `agent.run()` provides additional methods:

```ts
const run = agent.run('Hello')

// Iterate events
for await (const event of run) { ... }

// Get final result (after iteration completes)
const result: RunResult = await run.result
```

## RunResult

```ts
interface RunResult {
  state: AgentState
  finishReason: FinishReason
  output?: string           // Last assistant text
  usage?: TokenUsage
}
```

## FinishReason

```ts
type FinishReason =
  | 'end_turn'           // Model finished naturally
  | 'stop_condition'     // A stop condition triggered
  | 'max_tokens'         // Hit token limit
  | 'approval_required'  // Waiting for approval
  | 'cancelled'          // AbortSignal triggered
  | 'error'              // An error occurred
```

## Events

The agent emits events during execution:

```ts
type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolName: string; input: unknown; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; result: string }
  | { type: 'thinking'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
  | { type: 'error'; error: Error }
```

## Resuming

Resume from a paused state (e.g., after approval):

```ts
// First run pauses for approval
const run1 = agent.run('Delete the file')
for await (const event of run1) { ... }
const { state, finishReason } = await run1.result

if (finishReason === 'approval_required') {
  // User approves...
  const approvedState = withApprovals(state, approvals)
  
  // Resume
  const run2 = agent.run('', { state: approvedState })
  for await (const event of run2) { ... }
}
```

## Error Handling

```ts
import { AgentError, InvalidMessagesError } from '@humanlayer/agentlayer-core'

try {
  for await (const event of agent.run('...')) {
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
  | 'tool_not_found'
  | 'tool_execution_error'
  | 'invalid_state'
  | 'provider_error'
```
