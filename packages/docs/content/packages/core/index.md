# agentlayer-core

The core package provides the foundational primitives for building LLM-powered agents: the agent loop, tool system, hooks, state management, and prompts.

## Installation

```bash
bun add @humanlayer/agentlayer-core
```

## Entry Points

The package provides multiple entry points for granular imports:

```ts
// Main entry - everything
import { Agent, defineTool, ... } from '@humanlayer/agentlayer-core'

// Tool interfaces only
import { BashTool, ReadTool, ... } from '@humanlayer/agentlayer-core/interfaces'

// Hooks only
import { createPreToolUseHook, ... } from '@humanlayer/agentlayer-core/hooks'

// Prompts only
import { BASH_DESCRIPTION, ... } from '@humanlayer/agentlayer-core/prompts'

// Tools (factories & built-ins)
import { createSubagentsTool, ... } from '@humanlayer/agentlayer-core/tools'

// Utilities
import { truncate, ... } from '@humanlayer/agentlayer-core/utils'
```

## Quick Example

```ts
import { Agent, defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const greet = defineTool({
  name: 'greet',
  description: 'Greet a person',
  input: z.object({ name: z.string() }),
  execute: async ({ input }) => `Hello, ${input.name}!`
})

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [greet],
  system: 'You are a friendly assistant.'
})

for await (const event of agent.run('Say hello to Alice')) {
  console.log(event)
}
```

## What's in this Package

| Category | Description |
|----------|-------------|
| [Agent](./agent) | The `Agent` class, run options, and result types |
| [Tool Definition](./tool-definition) | `defineTool()`, `defineToolInterface()`, and tool context |
| [Tool Interfaces](./tool-interfaces) | 15+ built-in tool interfaces (Bash, Read, Write, etc.) |
| [Hooks](./hooks) | Hook types and factory functions for all phases |
| [Prompts](./prompts) | Tool descriptions and model-specific system prompts |
| [Stop Conditions](./stop-conditions) | Built-in stop conditions for the agent loop |
| [Token Usage](./token-usage) | Token counting and cost tracking |
