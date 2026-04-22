---
title: State
description: Understand AgentState, tool KV state, sub-agent state trees, serialization, and how runs are stored and resumed.
---

# State

`AgentState` is designed to be serializable.

It is the state token for `agent.run()` and contains what the loop needs in order to resume later.

Relevant source on `main`:

- [`AgentState` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`startState()` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`sanitizeStateForPersistence()` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`withApprovals()` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`getAgentState()` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`getAllPendingApprovals()` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)

## What Is In State

`AgentState` includes these fields:

```ts
interface AgentState {
  messages: ModelMessage[]
  pendingToolCalls?: PendingToolCall[]
  approvalHistory?: ApprovalHistoryEntry[]
  toolState?: Record<string, unknown>
  subAgents?: Record<string, AgentState>
  contextWindowTokens?: number
}
```

These are the same structures the loop reads and updates while a run is in progress.

More detail, in code form:

```ts
interface ApprovalHistoryEntry {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  approval: ApprovalRequest
  decision: ApprovalDecision
}

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

Practical interpretation:

- `pendingToolCalls` stores unresolved execution boundaries
- `approvalHistory` stores past approval decisions
- `toolState` stores per-tool KV state keyed by `stateKey`
- `subAgents` stores nested `AgentState` objects by child agent id

This recursive structure is what makes parent/child pause-and-resume workflows portable.

## Starting State

Use `startState()` to create an initial state object.

```ts
import { startState } from '@humanlayer/agentlayer-core'

const state = startState([
  { role: 'user', content: 'Read package.json and summarize it.' },
])
```

You can also seed tool KV state at startup:

```ts
const state = startState(
  [{ role: 'user', content: 'Continue the workflow.' }],
  { counter: 3 },
)
```

## Tool KV State

Stateful tools store their own state in `AgentState.toolState`, keyed by `stateKey`.

This gives tools a built-in KV-style persistence model that travels with the rest of the serialized run state.

Related source on `main`:

- [`toolState` on `AgentState`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`ToolStateAccessors` in `define-tool.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts)

## Sub-Agent State Trees

Sub-agents are serialized recursively into `AgentState.subAgents`.

That means child agent state is part of the same portable state graph.

Useful helper APIs:

```ts
type AgentPath = string[]

function getAgentState(state: AgentState, path: AgentPath): AgentState | undefined

function getAllPendingApprovals(
  state: AgentState,
): Array<{ path: AgentPath; pending: PendingToolCall }>
```

## Serialization

The core idea is simple: state is plain data.

```ts
const result = await agent.run({ state }).result
const json = JSON.stringify(result.state)
await db.save(json)
```

Then later:

```ts
const saved = await db.load()
const state = JSON.parse(saved)
const run = agent.run({ state })
```

This is the important property: the loop does not require a process-local session database in order to resume.

## Sanitizing Before Persistence

Some providers include provider-specific IDs in message metadata that should not be persisted across sessions.

Use `sanitizeStateForPersistence()` before saving:

```ts
const result = await agent.run({ state }).result
const sanitized = sanitizeStateForPersistence(result.state)
await db.save(JSON.stringify(sanitized))
```

This is especially relevant for providers that return session-scoped identifiers.

## Approval Resume Flow

When a run pauses for approval, resume by applying approval decisions with `withApprovals()`.

```ts
const result = await run.result

if (result.finishReason === 'approvalRequired') {
  await db.save(JSON.stringify(result.state))
}

// Later
const saved = JSON.parse(await db.load())

const resumed = withApprovals(saved, [
  { toolCallId: 'abc123', approved: true },
])

const nextRun = agent.run({ state: resumed })
```

`withApprovals()` updates pending tool calls, appends denial messages when needed, and preserves the rest of the state graph.

Useful related types on `main`:

- [`ApprovalDecision` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`ApprovalHistoryEntry` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`PendingToolCall` in `hooks/shared.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/hooks/shared.ts)

## Walking Nested State

If you need to inspect a child state tree directly, use `getAgentState()`.

```ts
const childState = getAgentState(rootState, ['worker-1'])
const grandchildState = getAgentState(rootState, ['worker-1', 'subworker-a'])
```

If you need to collect approval-gated work across the whole tree, use `getAllPendingApprovals()`.

```ts
const pending = getAllPendingApprovals(rootState)
for (const { path, pending: toolCall } of pending) {
  console.log(path, toolCall.toolCallId)
}
```

## Why Serializability Matters

Because state is plain data, you can:

- pause in one process and resume in another
- checkpoint long-running outer-loop agents
- persist approval-gated runs safely
- move work across machines or environments without a local session database
