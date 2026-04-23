---
title: Output Streaming
description: The AgentRun async iterator — event types, ordering, and how sub-agent events compose into a single parent stream.
---

# Output Streaming

Every `agent.run()` returns an `AgentRun`, which is both:

- A handle to the final result (`run.result: Promise<RunResult>`)
- An `AsyncIterable<AgentEvent>` — consume with `for await`

Setting `stream: true` causes the run to surface live model and tool events on the iterator as they happen. The stream is observational: it never changes the final `RunResult`, and you are free to attach a consumer or ignore the iterator entirely.

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  // handle events
}

const result = await run.result
```

::: info Source Reference
[`AgentRun`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts) in `agent-run.ts`
:::

## Stream vs. No Stream

```ts
agent.run({ state })                  // stream: false (default)
agent.run({ state, stream: true })    // live model/tool deltas
```

The `stream` flag controls which events the iterator yields. The final `run.result` is identical either way.

| `stream` | `for await` yields |
|----------|--------------------|
| `false`  | `message`, `tokenUsage`, `approvalRequested` |
| `true`   | All of the above, plus `stepStart` / `stepFinish`, `textStart` / `textDelta` / `textEnd`, `toolInputStart` / `toolInputDelta` / `toolInputEnd`, `reasoningStart` / `reasoningDelta` / `reasoningEnd` |

Step boundaries and all delta events are streaming-only. If you just need message-level observability (complete assistant turns, tool results, token usage, approval prompts), leave `stream: false`.

`stream` is propagated to sub-agents automatically, so turning it on at the root turns it on for every child in the tree.

## Iterator Semantics

- **Events are buffered.** If you start iterating after the run has already produced events, the iterator replays them from the beginning — you won't miss anything by subscribing late.
- **Iterate and `await run.result` in parallel.** They're two views of the same run; `run.result` resolves at the same moment the iterator yields `{ done: true }`.
- **A single active iterator per run.** Drive one `for await` loop at a time. If you need to fan events out to multiple consumers, have one loop that dispatches to them.
- **No built-in backpressure.** Events queue up in memory until they're consumed. Consume as they arrive rather than accumulating into a large array if the run is long-lived.

```ts
const run = agent.run({ state, stream: true })

// Fire-and-forget: drive a UI while the loop runs.
void (async () => { for await (const e of run) render(e) })()

// Block on the final state.
const result = await run.result
```

## Event Types

```ts
type AgentEvent =
  | { type: 'message';            message: ModelMessage }
  | { type: 'approvalRequested';  approval: ApprovalRequest; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tokenUsage';         usage: TokenUsageEvent }
  | { type: 'stepStart';          stepIndex: number }
  | { type: 'stepFinish';         stepIndex: number; finishReason?: string }
  | { type: 'textStart';          id: string; stepIndex: number }
  | { type: 'textDelta';          id: string; text: string; stepIndex: number }
  | { type: 'textEnd';            id: string; stepIndex: number }
  | { type: 'toolInputStart';     id: string; toolName: string; stepIndex: number }
  | { type: 'toolInputDelta';     id: string; delta: string; stepIndex: number }
  | { type: 'toolInputEnd';       id: string; stepIndex: number }
  | { type: 'reasoningStart';     id: string; stepIndex: number }
  | { type: 'reasoningDelta';     id: string; text: string; stepIndex: number }
  | { type: 'reasoningEnd';       id: string; stepIndex: number }

// Every event additionally carries:
//   agentId?: string            — set on events forwarded from a sub-agent
//   parentToolCallId?: string   — the tool call that spawned the sub-agent
```

### Message-level Events

Emitted regardless of `stream`.

| Event | Meaning |
|-------|---------|
| `message` | A complete `ModelMessage` was appended to state (assistant turn, tool result, etc.). |
| `tokenUsage` | Emitted once per model call with usage and context-window information. |
| `approvalRequested` | A tool invocation is waiting on an `ask()` decision. Resolve with [`run.resolveApproval()`](/concepts/run-api#live-approval-resolution). |

### Streaming-only Events (`stream: true`)

| Event | Meaning |
|-------|---------|
| `stepStart` / `stepFinish` | Step boundaries in the agent loop. `stepFinish` carries a `finishReason` (e.g. `stop`, `tool-calls`, `length`). |
| `textStart` / `textDelta` / `textEnd` | Incremental assistant text. `id` correlates the deltas to the same text block. |
| `toolInputStart` / `toolInputDelta` / `toolInputEnd` | The model is emitting tool call arguments. `delta` is a JSON chunk; `toolName` is on `toolInputStart`. |
| `reasoningStart` / `reasoningDelta` / `reasoningEnd` | Extended-thinking output (providers that support it). |

::: info Source Reference
[`AgentEvent`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts) in `agent-run.ts`
:::

## Ordering and Correlation

Within a single agent, one step of the loop produces events in this order (with `stream: true`):

1. `stepStart` for the step
2. Any number of streaming delta blocks: `text*`, `toolInput*`, `reasoning*`, in whatever order the model emits them. Each block has `start` → `delta`(s) → `end` with a common `id`.
3. `stepFinish` for the step
4. One `message` event for the assistant turn produced by this step
5. One `tokenUsage` event for the model call
6. For each tool call on this step, in execution order:
   - An `approvalRequested` event if the tool is pending approval
   - A `message` event carrying the tool result (after the tool executes or the approval resolves)
7. The next `stepStart`, or end of stream

With `stream: false`, the sequence reduces to just the message-level events (4–6) — `stepStart`, `stepFinish`, and all delta events are omitted.

The final `message` events and the delta stream describe the same content at different granularities. If you render `textDelta` live, don't re-render the `message` event for the same turn.

### Correlation fields

- **`id`** — Groups `start` / `delta` / `end` for the same text, reasoning, or tool-input block. Use it as a map key when buffering partial content.
- **`stepIndex`** — The step that produced the event. The first step is `0`. `stepIndex` is scoped to the agent that emitted it, not the whole tree.
- **`toolName`** — Set on `toolInputStart` so you can label a tool-input block before any `delta` arrives.

## Composing Streams With Sub-Agents

When a tool spawns a child agent (typically via [`createSubagentsTool()`](/concepts/subagents)), the child's entire event stream is merged into the parent's. There is one stream at the root, regardless of nesting depth. Consumers see a single, interleaved timeline of events from the root and all descendants.

### Tagging

Two fields on every event identify its origin:

- **`agentId`** — identifies the agent that emitted the event. Root-agent events have `agentId === undefined`. Sub-agent events carry a stable identifier unique to that child for the duration of the run.
- **`parentToolCallId`** — the `toolCallId` on the *immediate* parent agent that invoked this sub-agent.

```ts
event.agentId            // who produced this event (undefined = root)
event.parentToolCallId   // which subagent call produced the producer
```

Tags are preserved through nesting. A grandchild's events reach the root with the grandchild's own `agentId` and a `parentToolCallId` that points at the child's tool call (not the root's). You can reconstruct the full call tree from the flat stream using the pair `(agentId, parentToolCallId)`.

### Filtering a merged stream

```ts
const run = parentAgent.run({ state, stream: true })

for await (const event of run) {
  if (event.agentId === undefined) {
    renderRoot(event)
  } else {
    renderChild(event.parentToolCallId!, event.agentId, event)
  }
}
```

A common pattern: key nested renderers by `(agentId, parentToolCallId)`. This gives each sub-agent call its own scope in a UI while keeping multiple calls to the same sub-agent type visually separated.

### Multi-level nesting

If a root calls `child-a`, which calls `grandchild`, every event on the root stream carries the tags of whichever agent produced it. Sketching the high-level interleaving:

```
agentId: undefined          parentToolCallId: —                   // root runs, decides to call child-a
agentId: child-a-id         parentToolCallId: tc-root-1           // child-a runs, decides to call grandchild
agentId: grandchild-id      parentToolCallId: tc-child-a-1        // grandchild runs to completion
agentId: child-a-id         parentToolCallId: tc-root-1           // child-a resumes with grandchild's result, finishes
agentId: undefined          parentToolCallId: —                   // root resumes with child-a's result, finishes
```

Within each band you see that agent's full event sequence (`stepStart` → deltas → `stepFinish` → `message` → `tokenUsage` → tool results). A grandchild's `parentToolCallId` points at the *child's* tool call, not the root's.

`stepIndex` restarts at `0` in every agent. Use `(agentId, stepIndex)` if you need a unique step identifier across the tree.

### Token usage

`tokenUsage` events from sub-agents pass through the parent's stream, and the root's `result.tokenUsage` already includes every descendant. You do **not** need to sum them yourself — `run.result` gives you the final, aggregated totals and per-model breakdown. If you need a per-agent breakdown live, filter stream events by `agentId`. See [Token Usage](/packages/core/token-usage).

### Approvals from nested agents

`approvalRequested` events from sub-agents are forwarded to the root stream tagged with `agentId` and `parentToolCallId`. Resolving them works at the root, regardless of depth:

```ts
for await (const event of run) {
  if (event.type === 'approvalRequested') {
    // Resolves the approval at whatever depth it came from.
    run.resolveApproval(event.toolCallId, 'approve')
  }
}
```

A single `run.resolveApproval()` call at the root handles approvals from the root agent, any direct child, or any descendant. See [Live Approval Resolution](/concepts/run-api#live-approval-resolution) for the cold-resume fallback when the run has already ended.

::: info Source Reference
Sub-agent composition: [`createSubagentsTool()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts) in `tools/subagent.ts`.
:::

## Patterns

### Live terminal output

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  switch (event.type) {
    case 'textDelta':
      process.stdout.write(event.text)
      break
    case 'stepFinish':
      process.stdout.write('\n')
      break
    case 'approvalRequested':
      console.log(`\n[approval needed: ${event.toolName}]`)
      break
  }
}
```

### Buffered text per block

```ts
const textBuffers = new Map<string, string>()

for await (const event of run) {
  if (event.type === 'textStart') textBuffers.set(event.id, '')
  else if (event.type === 'textDelta') textBuffers.set(event.id, textBuffers.get(event.id)! + event.text)
  else if (event.type === 'textEnd') {
    const full = textBuffers.get(event.id)!
    textBuffers.delete(event.id)
    display(full)
  }
}
```

### Nested UI panes

```ts
const scope = (e: AgentEvent) => `${e.agentId ?? 'root'}/${e.parentToolCallId ?? 'root'}`
const panes = new Map<string, Pane>()

for await (const event of run) {
  const key = scope(event)
  const pane = panes.get(key) ?? panes.set(key, createPane()).get(key)!
  pane.onEvent(event)
}
```

For a complete reference renderer that handles nested scopes, see [`output-renderer.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/output-renderer.ts) in core.

## Next Steps

- **[Run API](/concepts/run-api)** — The full `AgentRun` / `RunResult` surface and resume patterns.
- **[Subagents](/concepts/subagents)** — Composition rules, pause/resume semantics, and tool-side configuration.
- **[Token Usage](/packages/core/token-usage)** — How usage events aggregate across the tree.
