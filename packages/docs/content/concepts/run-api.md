---
title: Run API
description: Start agent runs, stream events, handle results, and resume after pause.
---

# Run API

The Run API controls how you start agents, consume events, and handle results.

## Starting a Run

```ts
const run = agent.run({
  state: startState([{ role: 'user', content: 'Hello' }]),
  signal: abortController.signal,  // Optional
  stream: true,                     // Optional
})
```

`agent.run()` returns immediately with an `AgentRun` object. The loop executes asynchronously.

### RunOptions

```ts
interface RunOptions {
  state: AgentState       // Required: starting state
  signal?: AbortSignal    // Optional: cancellation signal
  stream?: boolean        // Optional: enable streaming events
}
```

::: info Source Reference
[`RunOptions`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts#L79-L83) in `agent.ts`
:::

## AgentRun

`AgentRun` provides:

- `result: Promise<RunResult>` — The final result
- `running: boolean` — Whether the loop is still executing
- `[Symbol.asyncIterator]()` — Stream events via `for await`
- `resolveApproval(toolCallId, decision, reason?)` — Live approval resolution

### Streaming Events

`AgentRun` is an `AsyncIterable<AgentEvent>`. Iterate to consume live events from the loop:

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  switch (event.type) {
    case 'textDelta':
      process.stdout.write(event.text)
      break
    case 'approvalRequested':
      console.log(`Approval needed: ${event.toolName}`)
      break
    case 'stepFinish':
      console.log(`Step ${event.stepIndex} finished`)
      break
  }
}

const result = await run.result
```

There are 14 event types (message-level events, plus streaming deltas for text, tool input, and reasoning). Every event also carries optional `agentId` and `parentToolCallId` fields, which are set when the event comes from a sub-agent.

See [Output Streaming](/concepts/streaming) for the full event catalog, ordering guarantees, buffering semantics, and the rules for how sub-agent events are merged into the parent stream.

::: info Source Reference
[`AgentEvent`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts) in `agent-run.ts`
:::

## RunResult

The final result contains:

```ts
interface RunResult {
  state: AgentState              // Full state after run
  newMessages: ModelMessage[]    // Messages added during this run
  finishReason: FinishReason     // Why the loop stopped
  stopCondition?: StopResult     // Present when finishReason is 'stopCondition'
  error?: AgentError             // Present when finishReason is 'error'
  tokenUsage: TokenUsage         // Per-model token usage
}
```

### Finish Reasons

| Reason | Cause | State |
|--------|-------|-------|
| `complete` | Model returned without tool calls | Final |
| `maxSteps` | Step limit reached | Resumable |
| `stopCondition` | A stop condition fired | Resumable |
| `interrupted` | Abort signal triggered | Partial |
| `approvalRequired` | Tool needs approval | Resumable |
| `error` | An error occurred | May be partial |

::: info Source Reference
[`RunResult`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts#L66-L77) and [`FinishReason`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts#L64) in `agent.ts`
:::

## Handling Results

### Completed Run

```ts
const result = await run.result

if (result.finishReason === 'complete') {
  const lastMessage = result.newMessages.at(-1)
  console.log('Done:', lastMessage)
}
```

### Approval Required

```ts
if (result.finishReason === 'approvalRequired') {
  // Save state and wait for human
  await db.save(JSON.stringify(result.state))
  
  // Show pending approvals to user
  const pending = getAllPendingApprovals(result.state)
  for (const { path, pending: p } of pending) {
    console.log(`Pending: ${p.toolName} at path ${path.join('/')}`)
  }
}
```

### Stop Condition

```ts
if (result.finishReason === 'stopCondition') {
  console.log(`Stopped by: ${result.stopCondition?.name}`)
  console.log(`Reason: ${result.stopCondition?.message}`)
  
  // Resume later
  const nextRun = agent.run({ state: result.state })
}
```

### Error

```ts
if (result.finishReason === 'error') {
  console.error(`Error: ${result.error?.message}`)
  console.error(`Type: ${result.error?.type}`)
}
```

## Resuming Runs

### After Approval Required (Cold Resume)

The standard pattern for resuming after human approval:

```ts
// Save state when approval is needed
const result1 = await run.result
if (result1.finishReason === 'approvalRequired') {
  await db.save(JSON.stringify(result1.state))
}

// Later, after human approves
const savedState = JSON.parse(await db.load())
const pending = getAllPendingApprovals(savedState)

const resumedState = withApprovals(savedState, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

const run2 = agent.run({ state: resumedState })
const result2 = await run2.result
```

### Denying a Tool Call

```ts
const resumedState = withApprovals(savedState, [
  { 
    toolCallId: pending[0].pending.toolCallId, 
    approved: false,
    denialReason: 'Not approved for production',
  },
])
```

### Live Approval Resolution

If the run is still in memory, you can resolve approvals without a full cold resume:

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  if (event.type === 'approvalRequested') {
    // Resolve immediately (e.g., from user input)
    const delivered = run.resolveApproval(event.toolCallId, 'approve')
    
    if (!delivered) {
      // Run already finished — fall back to cold resume
      const result = await run.result
      const resumed = withApprovals(result.state, [
        { toolCallId: event.toolCallId, approved: true },
      ])
      agent.run({ state: resumed })
    }
  }
}
```

`resolveApproval()` returns `true` if the approval was delivered to the running loop, `false` if the run already finished.

::: info Source Reference
[`resolveApproval()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent-run.ts) in `agent-run.ts`
:::

### After Stop Condition

When a tool or hook calls `ctx.stop()`, the run finishes intentionally:

```ts
const result = await run.result
if (result.finishReason === 'stopCondition') {
  // State is valid — just resume
  const nextRun = agent.run({ state: result.state })
}
```

## Abort and Stop

These are different mechanisms:

| Mechanism | Trigger | Result |
|-----------|---------|--------|
| **Abort** | `AbortSignal` from caller | `finishReason: 'interrupted'` |
| **Stop** | `ctx.stop()` in tool/hook | `finishReason: 'stopCondition'` |

### Aborting a Run

```ts
const controller = new AbortController()

const run = agent.run({ 
  state,
  signal: controller.signal,
})

// Cancel from outside
controller.abort()

const result = await run.result
// result.finishReason === 'interrupted'
```

### Stopping from Inside

```ts
execute: async (input, ctx) => {
  if (input.shouldCheckpoint) {
    return ctx.stop({
      reason: 'Checkpoint reached',
      include: true,  // Include this result
    })
  }
  return 'normal output'
}
```

Stop is a workflow-control primitive, not a kill switch. The tool finishes cleanly, the result is recorded, and the state can be resumed later.

## Stop vs Approval

Both are resumable, but they mean different things:

| | `approvalRequired` | `stopCondition` |
|-|-------|-------|
| **Cause** | `ctx.ask()` in approval hook | `ctx.stop()` in tool/hook, or stop condition fired |
| **State** | Pending approval stored | Ready to resume immediately |
| **Resume** | Apply approval with `withApprovals()` | Just pass state back to `run()` |
| **Use when** | Need yes/no decision from human | Intentional pause at workflow boundary |

## Stop Conditions

Stop conditions are checked at specific points in the loop:

```ts
import { maxSteps, toolCompleted, toolCalled, doomLoop } from '@humanlayer/agentlayer-core'

const agent = new Agent({
  stopWhen: [
    maxSteps(50),                    // After 50 steps
    toolCompleted('done'),           // When 'done' tool succeeds
    toolCalled('dangerous_action'),  // Before 'dangerous_action' runs
    doomLoop(3),                     // 3 identical tool calls in a row
  ],
})
```

### Built-in Stop Conditions

| Condition | Timing | Description |
|-----------|--------|-------------|
| `maxSteps(n)` | after | Stop after n completed steps |
| `toolCompleted(name)` | after | Stop when tool succeeds |
| `toolCalled(name)` | before | Stop before tool runs |
| `totalToolFailures(n, tool?)` | after | Stop after n total failures |
| `consecutiveToolFailures(n, tool?)` | after | Stop after n failures in a row |
| `doomLoop(n)` | after | Stop after n identical calls |
| `structuredOutputCalled()` | before | Stop when structured_output is called |

::: info Source Reference
[`stop-conditions.ts`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/stop-conditions.ts)
:::

## Agent Configuration

The full `AgentConfig` interface:

```ts
interface AgentConfig<TTools> {
  model: LanguageModel                    // AI SDK model
  system?: string | string[]              // System prompt(s)
  tools: TTools                           // Tool map
  toolChoice?: ToolChoice<TTools>         // Force tool selection
  providerOptions?: ProviderOptions       // Provider-specific options
  maxSteps?: number                       // Hard step limit
  stopWhen?: StopWhen                     // Stop conditions
  modelProvider?: ModelProvider           // Custom model provider
  contextWindowLimit?: number             // Override auto-detected limit
  hooks?: {
    approval?: ApprovalHook[]
    preToolUse?: PreToolUseHook[]
    postToolUse?: PostToolUseHook[]
    preRequest?: PreRequestHook[]
  }
  // Callbacks — all can be sync or async (return void | Promise<void>)
  onError?: (error: AgentError, result: RunResult) => void | Promise<void>
  onStop?: (result: RunResult) => void | Promise<void>
  onApprovalRequested?: (
    approval: ApprovalRequest,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => void | Promise<void>
}
```

::: info Source Reference
[`AgentConfig`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/agent.ts#L33-L62) in `agent.ts`
:::

## Next Steps

- **[Output Streaming](/concepts/streaming)** — Event types, ordering, and sub-agent composition
- **[State](/concepts/state)** — State structure and persistence
- **[Hooks](/concepts/hooks)** — How hooks trigger approval and stop
- **[Subagents](/concepts/subagents)** — Nested pause/resume behavior
