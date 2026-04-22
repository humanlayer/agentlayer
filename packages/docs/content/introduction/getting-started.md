---
title: Getting Started
description: Create your first AgentLayer agent from zero to a working agent that can read files and run shell commands.
---

# Getting Started

This guide walks you through creating your first agent with AgentLayer -- from zero to a working agent that can read files and run shell commands.

## Prerequisites

- **Node.js 18+ or Bun**
- **TypeScript 5+**
- A model provider API key or authentication setup

If you are working within the monorepo, the packages are available via workspace resolution.

## Creating Your First Agent

An `Agent` is a configured, reusable loop runner. You give it a model, tools, and optional configuration. Then you call `agent.run()` to start a conversation.

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { Agent } from '@humanlayer/agentlayer-core'

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  system: 'You are a helpful assistant.',
  tools: {},
})
```

The `AgentConfig` type accepts these core fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `LanguageModel` | Yes | Any AI SDK compatible model |
| `system` | `string \| string[]` | No | System prompt |
| `tools` | `Record<string, Tool>` | Yes | Named tools the model can call |
| `maxSteps` | `number` | No | Hard limit on loop iterations |
| `stopWhen` | `StopWhen` | No | Stop conditions |
| `hooks` | `{ approval?, preToolUse?, postToolUse?, preRequest? }` | No | Hook arrays for intercepting tool calls |

## Adding Tools

Tools are what give the agent capabilities.

The toolkit ships with production-ready implementations for local filesystem access and sandboxed execution.

```ts
import {
  createBashTool,
  createReadTool,
  createGlobTool,
  createGrepTool,
  createListTool,
} from '@humanlayer/agentlayer-filesystem/tools'

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  system: 'You are a coding assistant. Use tools to explore and understand code.',
  tools: {
    bash: createBashTool({ cwd: '/path/to/project' }),
    read: createReadTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
    list: createListTool(),
  },
})
```

The just-bash package provides the same kind of model-facing tools, but backed by a sandboxed runtime:

```ts
import { createJustBashTool, createJustBashReadTool } from '@humanlayer/agentlayer-justbash/tools'
```

## Adding Stop Conditions

Stop conditions tell the agent loop when to finish. Without them, the agent stops when the model generates no more tool calls, or when `maxSteps` is reached.

```ts
import { defineTool, maxSteps, startState, toolCompleted } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const done = defineTool({
  name: 'done',
  description: 'Call when finished.',
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Done: ${input.summary}`,
})

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: { done },
  stopWhen: [maxSteps(20), toolCompleted('done')],
})
```

### Available stop conditions

| Factory | Timing | Description |
|---|---|---|
| `maxSteps(n)` | afterExecution | Stop after `n` completed steps |
| `toolCompleted(name)` | afterExecution | Stop when a tool executes successfully |
| `toolCalled(name)` | beforeExecution | Stop when a tool is called before it runs |
| `totalToolFailures(n, name?)` | afterExecution | Stop after `n` cumulative tool errors |
| `consecutiveToolFailures(n, name?)` | afterExecution | Stop after `n` errors in a row |
| `doomLoop(n?)` | beforeExecution | Stop when the same tool is called with identical input repeatedly |
| `structuredOutputCalled()` | beforeExecution | Convenience wrapper for `toolCalled('structured_output')` |

## Running the Agent

Call `agent.run()` with a `RunOptions` object containing the initial state. The method returns an `AgentRun` immediately.

```ts
import { startState } from '@humanlayer/agentlayer-core'

const run = agent.run({
  state: startState([{ role: 'user', content: 'List all TypeScript files in src/' }]),
})
```

### Consuming results

You can either await the final result:

```ts
const result = await run.result
console.log(result.finishReason)
console.log(result.state.messages.length)
console.log(result.newMessages.length)
```

Or stream events as they happen:

```ts
for await (const event of run) {
  switch (event.type) {
    case 'message':
      console.log(event.message.role, event.message)
      break
    case 'approvalRequested':
      console.log(`Approval needed for ${event.toolName}:`, event.input)
      break
    case 'tokenUsage':
      console.log(`${event.usage.model}: ${event.usage.contextWindowTokens} context tokens`)
      break
  }
}

const result = await run.result
```

## Next Steps

- **[Architecture](/introduction/architecture)** -- understand the agent loop lifecycle and tool resolution pipeline
- **[Motivation](/introduction/motivation)** -- why the toolkit is built this way
