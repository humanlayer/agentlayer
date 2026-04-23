# agentlayer-justbash

The justbash package provides tool implementations using Vercel's [just-bash](https://github.com/vercel-labs/just-bash) library for sandboxed shell execution.

## Installation

```bash
bun add @humanlayer/agentlayer-justbash just-bash
```

## When to Use

Use `agentlayer-justbash` instead of `agentlayer-filesystem` when you need:

- **Sandboxed execution**: just-bash runs commands in isolated environments
- **Browser/edge compatibility**: Works in environments without Node.js fs
- **Virtual filesystem**: Operate on in-memory file systems

## Quick Example

```ts
import { Bash } from 'just-bash'
import {
  createJustBashTool,
  createJustBashReadTool,
  createWriteTool,
  createAgentSystemPrompt
} from '@humanlayer/agentlayer-justbash'
import { Agent } from '@humanlayer/agentlayer-core'

const bash = new Bash()

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [
    createJustBashTool(bash),
    createJustBashReadTool(bash),
    createWriteTool(bash)
  ],
  system: await createAgentSystemPrompt({
    bash,
    cwd: '/workspace',
    model: 'claude'
  })
})
```

## Entry Points

```ts
// Main - everything
import { ... } from '@humanlayer/agentlayer-justbash'

// Tools only
import { ... } from '@humanlayer/agentlayer-justbash/tools'

// Prompts only
import { ... } from '@humanlayer/agentlayer-justbash/prompts'
```

## What's Included

| Category | Description |
|----------|-------------|
| [Tools](./tools) | Tool factories for all filesystem and web operations |
| [Prompts](./prompts) | System prompt generation for just-bash environments |

## Comparison with agentlayer-filesystem

| Feature | agentlayer-filesystem | agentlayer-justbash |
|---------|----------------------|---------------------|
| Runtime | Node.js only | Browser/Edge/Node.js |
| Filesystem | Real filesystem | Virtual (just-bash) |
| Sandboxing | None | Full isolation |
| Dependencies | Node.js fs, child_process | just-bash |
