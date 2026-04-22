---
title: Overview
description: AgentLayer is a model-agnostic toolkit for building LLM-powered coding agents with reusable control flow, tool interfaces, and serializable state.
---

# Overview

`AgentLayer` is a model-agnostic toolkit for building LLM-powered coding agents. It wraps any AI SDK compatible model in a stateful, resumable loop with a three-tier hook system, async-iterable streaming, and a tool system that separates tool interfaces from backend implementations.

## Philosophy

### Model Agnostic

Works with any language model provider supported by the AI SDK. Swap models with a single line change.

### Interface / Implementation Separation

Tool interfaces -- what the model sees -- are decoupled from execution backends -- what actually runs. Define an interface once, implement it for local disk, sandboxed bash, a database-backed filesystem, or a remote service. The model does not know the difference.

### Two-Tier Tool Architecture

The tool system separates concerns into two tiers:

1. **Interfaces** (`@humanlayer/agentlayer-core/interfaces`) -- pure schemas, serialization functions, and transforms. No I/O, no side effects, no runtime dependency.
2. **Implementations** -- concrete executors that fulfill those interfaces:
   - **Filesystem tools** (`@humanlayer/agentlayer-filesystem/tools`) -- Bun-native implementations using real filesystem and subprocess access
   - **Just-bash tools** (`@humanlayer/agentlayer-justbash/tools`) -- sandboxed implementations via `just-bash`
   - **Your own** -- implement any interface with `.define()` backed by S3, Postgres, a Docker container, or anything else

### Resumable State

`AgentState` captures everything needed to pause and resume an agent: messages, pending tool calls, approval history, tool-specific state, and sub-agent trees. Serialize to JSON, store anywhere, resume later.

### Cooperative Hooks

The hook system intercepts tool calls at multiple stages:

- **Approval hooks** -- gate execution, deny, or escalate to a human
- **PreToolUse hooks** -- mutate input, short-circuit with synthetic results, or stop the loop
- **PostToolUse hooks** -- transform output after execution
- **PreRequest hooks** -- transform the context window before the next model call

### Streaming First

`AgentRun` implements `AsyncIterable<AgentEvent>`. Consume events as they happen -- messages, tool calls, approval requests -- or just `await run.result` for the final output.

## Package Layout

The toolkit is organized into focused packages:

| Package | Purpose |
|---|---|
| `@humanlayer/agentlayer-core` | Agent class, hooks, state, stop conditions, tool interfaces, prompts, token usage, and sub-agents |
| `@humanlayer/agentlayer-filesystem` | Bun-native filesystem and shell-backed tool implementations |
| `@humanlayer/agentlayer-justbash` | Sandbox-backed tool implementations via `just-bash` |
| `@humanlayer/yjs-fs` | Y.js CRDT-based collaborative filesystem layer |

## Quick Example

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { Agent, defineTool, maxSteps, toolCompleted, startState } from '@humanlayer/agentlayer-core'
import { createBashTool, createReadTool } from '@humanlayer/agentlayer-filesystem/tools'
import { z } from 'zod'

const done = defineTool({
  name: 'done',
  description: 'Call when finished.',
  input: z.object({ summary: z.string() }),
  execute: async (input) => `Done: ${input.summary}`,
})

const agent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  system: 'You are a helpful coding assistant.',
  tools: {
    bash: createBashTool({ cwd: '/my/project' }),
    read: createReadTool(),
    done,
  },
  stopWhen: [maxSteps(10), toolCompleted('done')],
})

const run = agent.run({
  state: startState([{ role: 'user', content: 'Read package.json and summarize it.' }]),
})

for await (const event of run) {
  console.log(event.type, event)
}

const result = await run.result
console.log(result.finishReason)
```

## Read This Next

- **[Motivation](/introduction/motivation)** -- why the toolkit is built this way
- **[Architecture](/introduction/architecture)** -- loop lifecycle, tool resolution, and state model
