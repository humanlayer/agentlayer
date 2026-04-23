---
title: State
description: AgentState structure, serialization, persistence, and resume patterns.
---

# State

`AgentState` is the serializable state token for agent runs. It contains everything needed to pause, persist, and resume a conversation.

## AgentState Structure

```ts
interface AgentState {
  messages: ModelMessage[]              // Conversation history
  pendingToolCalls?: PendingToolCall[]  // Awaiting approval or stopped
  approvalHistory?: ApprovalHistoryEntry[]  // Past decisions
  toolState?: Record<string, unknown>   // Per-tool and hook KV state
  subAgents?: Record<string, AgentState>  // Nested child states
  contextWindowTokens?: number          // Estimated tokens
}
```

| Field | Purpose |
|-------|---------|
| `messages` | The full conversation: system, user, assistant, and tool messages |
| `pendingToolCalls` | Tool calls that need approval or were stopped |
| `approvalHistory` | Record of past approval decisions |
| `toolState` | Persistent KV state for tools and hooks |
| `subAgents` | Recursive states for active sub-agents |
| `contextWindowTokens` | Token estimate from last model call |

::: info Source Reference
[`AgentState`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L56-L71) in `state.ts`
:::

## Creating Initial State

Use `startState()` to create a fresh state:

```ts
import { startState } from '@humanlayer/agentlayer-core'

// Simple case
const state = startState([
  { role: 'user', content: 'Hello, help me with my code.' },
])

// With initial tool state
const state = startState(
  [{ role: 'user', content: 'Continue from checkpoint.' }],
  { checkpointNumber: 5, visitedFiles: [] }
)
```

::: info Source Reference
[`startState()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L83-L88) in `state.ts`
:::

## Serialization

State is plain JSON. Serialize with `JSON.stringify()`:

```ts
const result = await agent.run({ state }).result

// Save anywhere
const json = JSON.stringify(result.state)
await db.save(sessionId, json)

// Load and resume
const loaded = JSON.parse(await db.load(sessionId))
const nextRun = agent.run({ state: loaded })
```

### Sanitizing for Persistence

Some providers include session-scoped IDs that shouldn't be persisted. Use `sanitizeStateForPersistence()` before saving:

```ts
import { sanitizeStateForPersistence } from '@humanlayer/agentlayer-core'

const result = await agent.run({ state }).result
const sanitized = sanitizeStateForPersistence(result.state)
await db.save(JSON.stringify(sanitized))
```

This prevents errors like "Item with id 'xxx' not found" when resuming with providers that use session-scoped identifiers.

::: info Source Reference
[`sanitizeStateForPersistence()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L178-L192) in `state.ts`
:::

## Pending Tool Calls

When a run pauses (approval needed or stopped), pending calls are stored:

```ts
type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
} & (
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'stopped'; reason?: string; suggestedResult?: string }
  | { type: 'subAgent'; agentId: string; subAgentType: string }
)
```

| Type | Cause | Resume |
|------|-------|--------|
| `approval` | Approval hook returned `ask()` | Use `withApprovals()` |
| `stopped` | Tool/hook called `ctx.stop()` | Just pass state to `run()` |
| `subAgent` | Sub-agent paused | Use `withApprovals()` for nested approval |

## Approval History

Past approval decisions are recorded:

```ts
interface ApprovalHistoryEntry {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  approval: ApprovalRequest
  decision: ApprovalDecision
}

type ApprovalDecision =
  | { toolCallId: string; approved: true }
  | { toolCallId: string; approved: false; denialReason?: string }
```

This history is informational — it tracks what was approved/denied but doesn't affect future runs.

## Tool and Hook State

Both stateful tools and hooks store their state in `toolState`. They share the same KV namespace but use different keys.

### Tool State

Tools with `stateKey` and `stateSchema` get typed state accessors:

```ts
const counterTool = defineTool({
  name: 'increment',
  input: z.object({}),
  stateKey: 'counter',  // Key in toolState
  stateSchema: z.number(),
  execute: async (_, ctx) => {
    const current = ctx.getToolState() ?? 0
    ctx.updateToolState(() => current + 1)
    return `Counter: ${current + 1}`
  },
})
```

### Hook State

PreToolUse and PostToolUse hooks use `getState()` and `updateState()`:

```ts
const countingHook: PreToolUseHook = (ctx) => {
  const count = ctx.getState<number>('bashCount') ?? 0
  ctx.updateState<number>('bashCount', () => count + 1)
  return ctx.next()
}
```

After running:

```ts
result.state.toolState
// { counter: 3, bashCount: 5 }
```

All state persists across runs and survives pause/resume.

## Sub-Agent State

Sub-agent states nest recursively in `subAgents`:

```ts
{
  messages: [...],
  subAgents: {
    'worker-1': {
      messages: [...],
      pendingToolCalls: [...],
      subAgents: {
        'deep-worker': {
          messages: [...],
        }
      }
    }
  }
}
```

This structure enables:
- Pause at any depth
- Resume from any paused sub-agent
- Walk the entire tree to find pending approvals

## State Utilities

### `getAgentState(state, path)`

Navigate to a nested sub-agent state:

```ts
import { getAgentState, type AgentPath } from '@humanlayer/agentlayer-core'

// Root state
const root = getAgentState(state, [])

// Direct child
const child = getAgentState(state, ['worker-1'])

// Grandchild
const grandchild = getAgentState(state, ['worker-1', 'deep-worker'])
```

Returns `undefined` if the path doesn't exist.

::: info Source Reference
[`getAgentState()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L207-L213) in `state.ts`
:::

### `getAllPendingApprovals(state)`

Find all pending approvals across the entire tree:

```ts
import { getAllPendingApprovals } from '@humanlayer/agentlayer-core'

const pending = getAllPendingApprovals(state)
for (const { path, pending: p } of pending) {
  console.log(`Path: ${path.join('/')}`)
  console.log(`Tool: ${p.toolName}`)
  console.log(`ID: ${p.toolCallId}`)
}
```

Returns an array of `{ path: AgentPath, pending: PendingToolCall }`.

::: info Source Reference
[`getAllPendingApprovals()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L232-L250) in `state.ts`
:::

### `withApprovals(state, decisions)`

Apply approval decisions and return a new state:

```ts
import { withApprovals, type ApprovalDecision } from '@humanlayer/agentlayer-core'

const decisions: ApprovalDecision[] = [
  { toolCallId: 'abc123', approved: true },
  { toolCallId: 'def456', approved: false, denialReason: 'Not safe' },
]

const resumedState = withApprovals(state, decisions)
const nextRun = agent.run({ state: resumedState })
```

This function:
- Removes approved entries from `pendingToolCalls`
- Injects denial messages for denied entries
- Records decisions in `approvalHistory`
- Recursively applies to nested sub-agents

::: info Source Reference
[`withApprovals()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts#L276-L363) in `state.ts`
:::

## Resume Patterns

### Basic Resume After Approval

```ts
// 1. Run until approval needed
const result1 = await agent.run({ state }).result

if (result1.finishReason === 'approvalRequired') {
  // 2. Save state
  await db.save(JSON.stringify(result1.state))
}

// 3. Later, load and apply decision
const saved = JSON.parse(await db.load())
const pending = getAllPendingApprovals(saved)

const resumed = withApprovals(saved, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

// 4. Continue
const result2 = await agent.run({ state: resumed }).result
```

### Partial Approval

You can approve some pending calls and leave others:

```ts
const pending = getAllPendingApprovals(state)

// Only approve the first one
const partialResume = withApprovals(state, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

// Run will continue but may pause again on remaining approvals
const result = await agent.run({ state: partialResume }).result
```

### Resume After Stop

When a tool calls `ctx.stop()`, state is already valid for resume:

```ts
const result = await agent.run({ state }).result

if (result.finishReason === 'stopCondition') {
  // No withApprovals needed — just pass state back
  const nextRun = agent.run({ state: result.state })
}
```

## State Portability

Because state is plain JSON:

- **Run in one process, resume in another** — No shared memory needed
- **Pause for hours or days** — State survives process restarts
- **Store anywhere** — Postgres, Redis, S3, local filesystem
- **Fork conversations** — Copy state to branch the conversation

```ts
// Fork a conversation at a specific point
const fork = JSON.parse(JSON.stringify(originalState))
fork.messages.push({ role: 'user', content: 'Try a different approach.' })
const forkRun = agent.run({ state: fork })
```

## Next Steps

- **[Run API](/concepts/run-api)** — How runs produce and consume state
- **[Hooks](/concepts/hooks)** — How hooks use and modify state
- **[Subagents](/concepts/subagents)** — Nested state management
