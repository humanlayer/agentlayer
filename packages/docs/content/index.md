---
title: Getting Started
description: AgentLayer is a model-agnostic toolkit for building LLM-powered coding agents with reusable control flow, tool interfaces, and serializable state.
---

# AgentLayer

AgentLayer is a toolkit for building LLM-powered coding agents. It wraps any AI SDK-compatible model in a stateful, resumable loop with hooks, streaming, and a tool system that separates interfaces from implementations.

## Installation

::: code-group

```bash [bun]
bun add @humanlayer/agentlayer-core
```

```bash [npm]
npm install @humanlayer/agentlayer-core
```

```bash [pnpm]
pnpm add @humanlayer/agentlayer-core
```

:::

You'll also need the AI SDK and a provider:

```bash
bun add ai @ai-sdk/anthropic
```

## Your First Agent

Here's a minimal working agent:

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { Agent, defineTool, startState, toolCompleted } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

// Define a simple tool that signals completion
const done = defineTool({
  name: 'done',
  description: 'Call this when you have completed the task.',
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Task completed: ${input.summary}`,
})

// Create the agent
const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  system: 'You are a helpful assistant. When you finish a task, call the done tool.',
  tools: { done },
  stopWhen: toolCompleted('done'),
})

// Run it
const run = agent.run({
  state: startState([{ role: 'user', content: 'Say hello and then call done.' }]),
})

const result = await run.result
console.log(result.finishReason) // 'stopCondition'
```

## Adding Real Tools

For a more useful agent, add filesystem tools from `@humanlayer/agentlayer-filesystem`:

```bash
bun add @humanlayer/agentlayer-filesystem
```

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { Agent, defineTool, startState, toolCompleted } from '@humanlayer/agentlayer-core'
import { createBashTool, createReadTool, createWriteTool } from '@humanlayer/agentlayer-filesystem/tools'
import { z } from 'zod'

const done = defineTool({
  name: 'done',
  description: 'Call when finished.',
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Done: ${input.summary}`,
})

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  system: 'You are a coding assistant with access to the filesystem.',
  tools: {
    bash: createBashTool({ cwd: process.cwd() }),
    read: createReadTool(),
    write: createWriteTool(),
    done,
  },
  stopWhen: toolCompleted('done'),
  maxSteps: 20,
})

const run = agent.run({
  state: startState([{ role: 'user', content: 'Read package.json and tell me the project name.' }]),
})

// Stream events as they happen
for await (const event of run) {
  if (event.type === 'message') {
    console.log(event.message)
  }
}

const result = await run.result
console.log('Finished:', result.finishReason)
```

## Streaming Events

`AgentRun` is an async iterable. You can consume events in real-time while also awaiting the final result:

```ts
const run = agent.run({ state, stream: true })

for await (const event of run) {
  switch (event.type) {
    case 'message':
      // A complete message was added to the conversation
      console.log(event.message)
      break
    case 'textDelta':
      // Streaming text from the model
      process.stdout.write(event.text)
      break
    case 'toolInputDelta':
      // Streaming tool input as the model generates it
      break
    case 'tokenUsage':
      // Token usage info after each model call
      console.log(`Tokens: ${event.usage.usage.inputTokens} in, ${event.usage.usage.outputTokens} out`)
      break
    case 'approvalRequested':
      // A tool needs approval before running
      console.log(`Approval needed for ${event.toolName}`)
      break
  }
}

// Get the final result
const result = await run.result
```

## Pause and Resume

Agent state is fully serializable. You can pause a run, save it, and resume later:

```ts
// Run until approval is needed
const run1 = agent.run({ state })
const result1 = await run1.result

if (result1.finishReason === 'approvalRequired') {
  // Save state to your database
  await db.save(JSON.stringify(result1.state))
}

// Later, after approval...
const savedState = JSON.parse(await db.load())
const pending = getAllPendingApprovals(savedState)

// Apply the approval decision
const resumedState = withApprovals(savedState, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

// Continue the run
const run2 = agent.run({ state: resumedState })
const result2 = await run2.result
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| [Tools](/concepts/tools) | Define what the model can do. Interfaces separate schema from execution. |
| [Hooks](/concepts/hooks) | Intercept tool calls for approval, mutation, or transformation. |
| [State](/concepts/state) | Serializable state enables pause/resume and distributed execution. |
| [Run API](/concepts/run-api) | Control the agent loop, handle streaming, and manage results. |
| [Subagents](/concepts/subagents) | Delegate tasks to specialized child agents. |

## Packages

| Package | Purpose |
|---------|---------|
| `@humanlayer/agentlayer-core` | Agent class, hooks, state, stop conditions, tool interfaces |
| `@humanlayer/agentlayer-filesystem` | Bun-native filesystem and shell tools |
| `@humanlayer/agentlayer-justbash` | Sandboxed tools via [just-bash](https://github.com/vercel-labs/just-bash) |

## Next Steps

- **[Motivation](/introduction/motivation)** — Why we built it this way
- **[Architecture](/introduction/architecture)** — How the agent loop works
- **[Tools](/concepts/tools)** — Deep dive into the tool system
- **[Hooks](/concepts/hooks)** — Add approval gates and transform behavior
