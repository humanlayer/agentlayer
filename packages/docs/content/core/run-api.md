---
title: Run API
description: Understand agent.run(), AgentRun, streaming events, final results, abort signals, stop behavior, and resumable execution.
---

# Run API

`agent.run()` starts a configured agent loop and returns an `AgentRun` immediately.

Relevant source on `main`:

- [`AgentConfig`, `RunOptions`, and `RunResult` in `agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts)
- [`AgentRun` and `AgentEvent` in `agent-run.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts)

## `run()`

```ts
const run = agent.run({
  state,
  signal,
  stream: true,
})
```

## Run Options

`RunOptions` includes:

- `state: AgentState` -- required serialized state token
- `signal?: AbortSignal` -- optional cancellation signal
- `stream?: boolean` -- optional flag for live streaming behavior

## What `agent.run()` Returns

`agent.run()` returns an `AgentRun`.

`AgentRun` provides:

- `result: Promise<RunResult>`
- `running: boolean`
- async iteration via `for await`
- `resolveApproval(toolCallId, decision, reason?)` for live approval resolution

Relevant source on `main`:

- [`AgentRun` class in `agent-run.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts)
- [`AgentEvent` in `agent-run.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts)

## Streaming Events

`AgentRun` implements `AsyncIterable<AgentEvent>`.

The event surface includes:

- `message`
- `approvalRequested`
- `tokenUsage`
- `stepStart`
- `stepFinish`
- `textStart`, `textDelta`, `textEnd`
- `toolInputStart`, `toolInputDelta`, `toolInputEnd`
- `reasoningStart`, `reasoningDelta`, `reasoningEnd`

At a practical level, this means the same `AgentRun` object can serve as both:

- a streaming event source for UI or logs
- a future for the final `RunResult`

```ts
for await (const event of run) {
  switch (event.type) {
    case 'message':
      console.log(event.message)
      break
    case 'approvalRequested':
      console.log(event.toolName, event.input)
      break
    case 'tokenUsage':
      console.log(event.usage)
      break
  }
}
```

## Final Result

`run.result` resolves to a `RunResult`.

Fields on `RunResult`:

- `state: AgentState`
- `newMessages: ModelMessage[]`
- `finishReason: FinishReason`
- `stopCondition?: StopResult`
- `error?: AgentError`
- `tokenUsage: TokenUsage`

Recursive detail, to a practical depth:

- `state` is the full checkpointable state snapshot after the run
- `newMessages` are only the messages produced during this run
- `finishReason` tells you why the loop stopped
- `stopCondition` is present only when the loop halted because of a stop condition
- `error` is present only when the run finished in error
- `tokenUsage` is the per-model usage aggregate for this run

Example:

```ts
const result = await run.result

console.log(result.finishReason)
console.log(result.state)
console.log(result.newMessages)
```

Source on `main`:

- [`RunResult` in `agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts)
- [`FinishReason` in `agent.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts)

## Finish Reasons

Possible finish reasons are:

- `complete`
- `maxSteps`
- `stopCondition`
- `interrupted`
- `approvalRequired`
- `error`

These correspond to distinct loop outcomes, not just generic success or failure.

The most important distinction operationally is:

- `approvalRequired` means persist and resume later
- `stopCondition` means the loop halted intentionally according to policy or tool/hook behavior
- `interrupted` means the run was externally cancelled

## Abort And Stopping

An `AbortSignal` can interrupt the loop between tool executions.

Tools and hooks can also request a stop via `ctx.stop()`.

### Abort is not stop

These are different mechanisms.

- **Abort** means the run is being cancelled from the outside via `AbortSignal`
- **Stop** means a tool or hook is intentionally telling the loop to halt in an orderly way

`ctx.stop()` does not mean “interrupt right this second.”

It means “finish this tool call, mark the run as stopped, and return control with a state snapshot that can be persisted and resumed later.”

That makes stop useful for long-running outer-loop agents that need to checkpoint between phases.

### `ctx.stop()` and resumable workflows

The common pattern is:

1. a tool reaches a workflow boundary
2. it returns `ctx.stop({ reason: '...' })`
3. the loop finishes with a stop condition
4. the caller persists `result.state`
5. the caller resumes later by passing that state back into `agent.run()`

## State And Streaming Together

You can stream the run and still await the final result.

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  handleEvent(event)
}

const result = await run.result
await saveState(result.state)
```

Streaming does not replace persistence. The final result still carries the full updated state.

## Live Approval Resolution

`AgentRun.resolveApproval(toolCallId, decision, reason?)` lets you inject an approval decision into a live run.

If the approval is still active, the run can continue without a full cold resume. If not, the caller should fall back to the persisted-state path with `withApprovals()` and a new `agent.run()`.

Example:

```ts
const delivered = run.resolveApproval('tool-call-123', 'approve')

if (!delivered) {
  const resumed = withApprovals(savedState, [{ toolCallId: 'tool-call-123', approved: true }])
  const nextRun = agent.run({ state: resumed })
}
```

Source on `main`:

- [`resolveApproval()` in `agent-run.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts)
