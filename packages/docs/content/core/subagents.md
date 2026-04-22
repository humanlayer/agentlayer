---
title: Subagents
description: Understand how sub-agents are configured, how nested pause and resume works, how state is serialized, and how to build codelayer-style specialist agents.
---

# Subagents

Sub-agents let one agent delegate work to another agent through a normal tool call.

In AgentLayer, sub-agents are implemented as a tool rather than a separate orchestration subsystem.

If you are reading this because a nested child returned `approvalRequired` or because a delegated task paused and needs to resume, also see [`Run API`](/core/run-api) and [`Hooks`](/core/hooks).

That design keeps sub-agents inside the same core execution model as everything else:

- they are model-visible as a tool
- they serialize into `AgentState`
- they can pause for approval and resume later
- they can stream events back into the parent run
- they can nest to arbitrary depth

## The Core API

The main entrypoint is `createSubagentsTool(...)`.

```ts
import { Agent, createSubagentsTool } from '@humanlayer/agentlayer-core'

const researchAgent = new Agent({
  model,
  system: 'You do focused research.',
  tools: { read, grep },
})

const bashAgent = new Agent({
  model,
  system: 'You run shell-heavy tasks.',
  tools: { bash },
})

const subagent = createSubagentsTool({
  agents: [
    {
      name: 'researcher',
      description: 'Investigates code and explains findings.',
      agent: researchAgent,
    },
    {
      name: 'bash',
      description: 'Runs shell-heavy tasks.',
      agent: bashAgent,
    },
  ],
})
```

Each configured child has three required fields:

- `name` is the selector the parent model uses in `subagent_type`
- `description` is included in the tool description shown to the model
- `agent` is the concrete child `Agent` instance that actually runs

The tool input shape is:

```ts
{
  description: string
  prompt: string
  subagent_type: string
  task_id?: string
}
```

Field meanings:

- `description` is a short summary of the delegated task
- `prompt` is the actual instruction passed into the child as a user message
- `subagent_type` picks one child agent by name
- `task_id` is only for resumable children and means "continue an existing child session"

Relevant source on `main`:

- [`createSubagentsTool()` in `subagent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts)

## How A Subagent Call Works

When the parent model emits a `subagent` tool call, the subagent tool:

1. looks up the selected child config by `subagent_type`
2. builds or reloads the child `AgentState`
3. runs the child agent with that state
4. waits for completion or pause
5. returns the child's result to the parent as a tool result

When the child completes normally, the parent sees a normal tool result containing the child's final assistant text wrapped like this:

```text
<agent_result>
...last assistant text from the child...
</agent_result>
```

If the child is resumable, the tool also returns a `task_id` so the parent can continue that same child session later.

That is the key mental model: the parent never directly manipulates a child conversation. It uses the `subagent` tool, and the tool manages the child run and state.

## Ephemeral vs Resumable Subagents

There are two kinds of child configuration.

### Ephemeral Children

Ephemeral children are the default.

```ts
const subagent = createSubagentsTool({
  agents: [
    {
      name: 'researcher',
      description: 'Investigates code and reports back.',
      agent: researchAgent,
    },
  ],
})
```

Use them when the delegated task should start fresh each time.

Ephemeral children still resume correctly if they pause for approval in the middle of a run. That resume path is tied to the paused parent state, not to a user-supplied `task_id`.

### Resumable Children

Resumable children add `resumable: true`.

```ts
const subagent = createSubagentsTool({
  agents: [
    {
      name: 'planner',
      description: 'Maintains a longer-running planning thread.',
      agent: plannerAgent,
      resumable: true,
    },
  ],
})
```

Use resumable children when you want a named specialized thread that can be continued over time.

With a resumable child:

- finished child state is stored in the tool's KV state
- later calls can pass `task_id` to continue the same child conversation
- the new `prompt` is appended to the stored child state as another user message

## Serialization And State Layout

Sub-agent data lives in two different parts of state.

That split is the most important thing to understand if you are documenting or debugging pause and resume behavior.

### `AgentState.subAgents`

This is the recursive tree of active paused child runs.

Use this mental model:

- if a child paused because it needs approval, it lives under `subAgents`
- if that child also has a paused child, the grandchild lives inside the child's own `subAgents`
- this is what makes nested approval pause/resume work at arbitrary depth

### `AgentState.toolState.subagents`

This is the tool-owned KV state for resumable child sessions.

Use this mental model:

- if you want to continue a named child session later via `task_id`, it is stored in the `subagent` tool's state
- if you are only resuming a currently paused child because approval was granted, that paused state is in the recursive `subAgents` tree instead

The overall root state shape is still the same serializable `AgentState` used everywhere else.

```ts
interface AgentState {
  messages: ModelMessage[]
  pendingToolCalls?: PendingToolCall[]
  approvalHistory?: ApprovalHistoryEntry[]
  toolState?: Record<string, unknown>
  subAgents?: Record<string, AgentState>
}
```

Related docs:

- [`State`](/core/state)

Relevant source on `main`:

- [`AgentState` in `state.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`stateKey: 'subagents'` in `subagent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts)

## Pause And Resume

Sub-agents plug directly into the normal approval pause/resume system.

When a child hits approval:

1. the child run finishes with `approvalRequired`
2. the `subagent` tool returns a special pause sentinel instead of a normal result
3. the parent stores the child under `state.subAgents`
4. the parent itself finishes with `approvalRequired`

That means there is no final subagent tool result yet. The delegated call is still unresolved.

Later, the caller applies approvals to the serialized root state with `withApprovals(...)` and reruns the parent. On rerun, AgentLayer replays the original subagent tool call and the child resumes from saved state.

Example:

```ts
const result1 = await parentAgent.run({ state }).result

if (result1.finishReason === 'approvalRequired') {
  const pending = getAllPendingApprovals(result1.state)

  const approvedState = withApprovals(result1.state, [
    { toolCallId: pending[0]!.pending.toolCallId, approved: true },
  ])

  const result2 = await parentAgent.run({ state: approvedState }).result
}
```

The important thing here is that `getAllPendingApprovals(...)` walks the entire nested tree, so callers do not need a separate API for parent vs child vs grandchild approvals.

That same caller-side resume flow is documented from the run perspective in [`Run API`](/core/run-api). The hook-side `ask(...)` behavior that causes it is documented in [`Hooks`](/core/hooks).

## N-Depth Subagents

There is no special depth configuration.

Arbitrary depth comes from composition: any child `Agent` can itself have a `subagent` tool in its own `tools` map.

Example:

```ts
const grandchildTool = createSubagentsTool({
  agents: [
    {
      name: 'deep-worker',
      description: 'Handles deeply nested work.',
      agent: grandchildAgent,
    },
  ],
})

const childAgent = new Agent({
  model,
  tools: { subagent: grandchildTool },
})

const childTool = createSubagentsTool({
  agents: [
    {
      name: 'child-worker',
      description: 'Delegates to a deeper specialist.',
      agent: childAgent,
    },
  ],
})

const parentAgent = new Agent({
  model,
  tools: { subagent: childTool },
})
```

What that means in practice:

- you do not configure max depth on `createSubagentsTool(...)`
- you configure depth by deciding which child agents themselves have sub-agent access
- approvals keep working because both state traversal and approval application recurse through the full tree

This behavior is explicitly covered by tests where a grandchild is the agent that pauses for approval and that approval still bubbles all the way back to the root.

Relevant source on `main`:

- [`grandchild approval` test in `subagent-tool.test.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/test/subagent-tool.test.ts)

## Child Event Streaming

Sub-agent events can be forwarded into the parent run's event stream.

When that happens, child events carry:

- `agentId` so the caller can identify which child emitted the event
- `parentToolCallId` so the caller can connect the child event back to the exact parent subagent tool call

That is useful for UIs, logs, and orchestration layers that want a single merged stream without losing parent-child structure.

## Building A Codelayer-Style Specialist Tool

The best example in this repo is the coding-agent helper in `@humanlayer/agentlayer-filesystem`.

That helper creates several specialist children and wraps them inside one delegating subagent tool, including:

- a general-purpose coding agent
- a bash-focused agent
- a codebase locator
- a codebase analyzer
- a codebase pattern finder
- a web researcher

It also composes shared filesystem hooks for truncation, read-before-write enforcement, and context management before those child agents are built.

That is the right pattern to copy for a codelayer-style setup:

1. build specialists as normal `Agent` instances
2. give each specialist only the tools it truly needs
3. compose shared hooks once
4. expose them behind one `createSubagentsTool(...)`

Relevant source on `main`:

- [`createAgentFilesystemHooks()` in `coding-agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-filesystem/src/coding-agent.ts)
- [`createCodingAgentAuxToolset()` in `coding-agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-filesystem/src/coding-agent.ts)
- [`createCodingSubagentTool()` in `coding-agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-filesystem/src/coding-agent.ts)

## Recommended Design Pattern

If you are building your own specialist tree, the cleanest approach is usually:

1. create each specialist as a normal `Agent`
2. keep each specialist's tool surface narrow
3. reuse shared hooks where appropriate
4. decide explicitly which children should be resumable
5. compose them with one `createSubagentsTool(...)`

That keeps the system understandable and makes nested pause/resume behavior much easier to debug.

## Related APIs

- [`createSubagentsTool()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts)
- [`AgentState`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`withApprovals()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`getAllPendingApprovals()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/state.ts)
- [`ToolContext` sub-agent fields in `define-tool.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/define-tool.ts)
